import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { assertTransition } from '@try/contracts';
import type { CheckInDto, CheckInResultDto } from '@try/contracts';
import { normalizeCheckInCode } from '@try/utils';
import type { Clock } from '@try/utils';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { CryptoService } from '../../common/crypto.service.js';
import { DomainEvents } from '../events/domain-events.js';
import { AuditService } from '../admin/audit.service.js';
import { BookingService } from '../bookings/booking.service.js';
import { hasBusinessRole, type AuthenticatedUser } from '../../common/auth/current-user.js';

@Injectable()
export class CheckInService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly crypto: CryptoService,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
  ) {}

  /**
   * Validates a QR token or short code at the door.
   *
   * Four things are checked, in this order, because each is a distinct failure the
   * staff member needs distinguished: is the code real, is it for *this* venue, is
   * it within the session window, and has it already been used. A single generic
   * "invalid" would leave staff unable to tell a wrong-venue booking from a forgery.
   */
  async checkIn(input: {
    actor: AuthenticatedUser;
    dto: CheckInDto;
  }): Promise<CheckInResultDto> {
    const now = this.clock.now();
    const { dto, actor } = input;

    const reservationId = dto.qrToken
      ? this.verifyQrToken(dto.qrToken)
      : await this.resolveByShortCode(dto.venueId, dto.shortCode ?? '');

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          reservation: schema.reservations,
          offerTitle: schema.offers.title,
          firstName: schema.profiles.firstName,
        })
        .from(schema.reservations)
        .innerJoin(schema.offers, eq(schema.offers.id, schema.reservations.offerId))
        .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.reservations.userId))
        .where(eq(schema.reservations.id, reservationId))
        .for('update')
        .limit(1);

      if (!row) throw new ApiException('CHECKIN_CODE_INVALID');
      const reservation = row.reservation;

      // Staff of business A must never be able to check in business B's booking.
      if (reservation.venueId !== dto.venueId) {
        throw new ApiException('CHECKIN_WRONG_VENUE');
      }
      if (!hasBusinessRole(actor, reservation.businessId, 'STAFF')) {
        throw ApiException.forbidden('not a member of this business');
      }

      if (reservation.status === 'CHECKED_IN' || reservation.status === 'COMPLETED') {
        throw new ApiException('CHECKIN_ALREADY_DONE');
      }

      const window = BookingService.checkInWindow(
        reservation.slotStartAt,
        reservation.slotEndAt,
      );
      const outsideWindow =
        now.getTime() < window.opensAt.getTime() || now.getTime() > window.expiresAt.getTime();

      if (outsideWindow && !dto.override) {
        throw new ApiException('CHECKIN_OUTSIDE_WINDOW');
      }
      // Overriding the window is a manager decision, and it is audited.
      if (outsideWindow && !hasBusinessRole(actor, reservation.businessId, 'MANAGER')) {
        throw ApiException.forbidden('override requires MANAGER');
      }

      assertTransition(reservation.status, 'CHECKED_IN', 'BUSINESS');

      await tx
        .update(schema.reservations)
        .set({ status: 'CHECKED_IN', checkedInAt: now, updatedAt: now })
        .where(eq(schema.reservations.id, reservation.id));

      await tx.insert(schema.checkIns).values({
        reservationId: reservation.id,
        venueId: reservation.venueId,
        performedByUserId: actor.id,
        method: dto.qrToken ? 'qr' : 'code',
        wasOverride: outsideWindow,
        overrideReason: outsideWindow ? (dto.overrideReason ?? 'window override') : null,
      });

      await tx
        .update(schema.trialHistory)
        .set({ status: 'CHECKED_IN', checkedInAt: now, updatedAt: now })
        .where(eq(schema.trialHistory.reservationId, reservation.id));

      /**
       * The lead is created here, not after the review: the venue needs the
       * attendee in its pipeline the moment they walk in, whether or not they
       * later answer the continuation question.
       */
      await tx
        .insert(schema.leads)
        .values({
          businessId: reservation.businessId,
          venueId: reservation.venueId,
          userId: reservation.userId,
          reservationId: reservation.id,
          offerId: reservation.offerId,
          status: 'ATTENDED',
          visitedAt: now,
        })
        .onConflictDoNothing();

      if (outsideWindow) {
        await this.audit.record(tx, {
          actorId: actor.id,
          actorType: 'BUSINESS_MEMBER',
          action: 'checkin.override',
          entityType: 'reservation',
          entityId: reservation.id,
          metadata: { reason: dto.overrideReason ?? null, slotStartAt: reservation.slotStartAt },
        });
      }

      const isFirstVisit = await this.isFirstVisit(tx, reservation.userId, reservation.venueId);

      this.events.emit('CheckInCompleted', {
        reservationId: reservation.id,
        userId: reservation.userId,
        businessId: reservation.businessId,
        venueId: reservation.venueId,
        method: dto.qrToken ? 'qr' : 'code',
      });

      return {
        reservationId: reservation.id,
        status: 'CHECKED_IN',
        checkedInAt: now.toISOString(),
        attendee: {
          firstName: row.firstName ?? 'Invité',
          isFirstVisit,
        },
        offer: { id: reservation.offerId, title: row.offerTitle },
        slot: {
          startAt: reservation.slotStartAt.toISOString(),
          endAt: reservation.slotEndAt.toISOString(),
        },
      };
    });
  }

  /**
   * Verifies the signature before trusting any part of the payload. The signature
   * is what makes the QR unforgeable — a bare reservation UUID would let anyone
   * who saw one check somebody in.
   */
  private verifyQrToken(token: string): string {
    const parts = token.split('.');
    if (parts.length !== 3) throw new ApiException('CHECKIN_CODE_INVALID');

    const [reservationId, code, signature] = parts as [string, string, string];
    if (!this.crypto.verifyCheckInPayload(`${reservationId}.${code}`, signature)) {
      throw new ApiException('CHECKIN_CODE_INVALID');
    }
    return reservationId;
  }

  /** Short codes are scoped to the venue, so they only need to be locally unique. */
  private async resolveByShortCode(venueId: string, rawCode: string): Promise<string> {
    const normalized = normalizeCheckInCode(rawCode);
    if (normalized.length !== 8) throw new ApiException('CHECKIN_CODE_INVALID');

    const formatted = `${normalized.slice(0, 4)}-${normalized.slice(4)}`;

    const [row] = await this.db
      .select({ id: schema.reservations.id })
      .from(schema.reservations)
      .where(
        and(
          eq(schema.reservations.checkInCode, formatted),
          eq(schema.reservations.venueId, venueId),
        ),
      )
      .limit(1);

    if (!row) throw new ApiException('CHECKIN_CODE_INVALID');
    return row.id;
  }

  private async isFirstVisit(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    userId: string,
    venueId: string,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(schema.checkIns)
      .innerJoin(schema.reservations, eq(schema.reservations.id, schema.checkIns.reservationId))
      .where(
        and(eq(schema.reservations.userId, userId), eq(schema.reservations.venueId, venueId)),
      );
    return (row?.count ?? 0) <= 1;
  }
}
