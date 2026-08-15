import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, lt, or, isNull, sql } from 'drizzle-orm';
import { addMinutes, zonedDayKey, zonedTimeToUtc } from '@try/utils';
import type { Clock } from '@try/utils';
import { schema } from '@try/database';
import type { Database, Transaction } from '@try/database';
import type { Logger } from '@try/logger';
import type { RecurringScheduleDto } from '@try/contracts';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { LOGGER } from '../../common/logger.module.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { hasBusinessRole, type AuthenticatedUser } from '../../common/auth/current-user.js';

/** How far ahead recurring rules are materialised. Matches the booking horizon. */
const EXPANSION_HORIZON_DAYS = 30;

@Injectable()
export class ScheduleService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Creates a recurring rule and immediately materialises it.
   *
   * Expanding on write rather than waiting for the nightly job means a business
   * that just published a schedule can see bookable slots straight away — waiting
   * hours for their own classes to appear reads as a broken product.
   */
  async createRecurring(input: {
    actor: AuthenticatedUser;
    dto: RecurringScheduleDto;
  }): Promise<{ scheduleId: string; slotsCreated: number }> {
    const [offer] = await this.db
      .select({
        id: schema.offers.id,
        businessId: schema.offers.businessId,
        venueId: schema.offers.venueId,
        durationMinutes: schema.offers.durationMinutes,
        timeZone: schema.venues.timeZone,
      })
      .from(schema.offers)
      .innerJoin(schema.venues, eq(schema.venues.id, schema.offers.venueId))
      .where(eq(schema.offers.id, input.dto.offerId))
      .limit(1);

    if (!offer) throw ApiException.notFound('offer', input.dto.offerId);
    if (!hasBusinessRole(input.actor, offer.businessId, 'MANAGER')) {
      throw ApiException.forbidden('requires MANAGER');
    }

    return this.db.transaction(async (tx) => {
      const [schedule] = await tx
        .insert(schema.schedules)
        .values({
          offerId: offer.id,
          venueId: offer.venueId,
          daysOfWeek: input.dto.daysOfWeek,
          startTime: input.dto.startTime,
          capacity: input.dto.capacity,
          validFrom: input.dto.validFrom,
          validUntil: input.dto.validUntil,
          isActive: true,
        })
        .returning({ id: schema.schedules.id });

      if (!schedule) throw new ApiException('INTERNAL_ERROR');

      const slotsCreated = await this.expandSchedule(tx, {
        scheduleId: schedule.id,
        offerId: offer.id,
        venueId: offer.venueId,
        daysOfWeek: input.dto.daysOfWeek,
        startTime: input.dto.startTime,
        capacity: input.dto.capacity,
        validFrom: input.dto.validFrom,
        validUntil: input.dto.validUntil,
        durationMinutes: offer.durationMinutes,
        timeZone: offer.timeZone,
      });

      return { scheduleId: schedule.id, slotsCreated };
    });
  }

  /**
   * Materialises one recurring rule into concrete slots.
   *
   * Two things make this correct rather than merely plausible:
   *
   *   - The start time is a *venue-local wall clock*. A 19:00 class stays at
   *     19:00 across a DST change, which naive UTC arithmetic would silently
   *     shift by an hour twice a year.
   *   - Inserts are `onConflictDoNothing` against the unique (offer, start_at)
   *     index, so re-running the expander is idempotent. It never duplicates a
   *     slot, and — critically — never resets `reserved_count` on a slot that
   *     already has bookings.
   */
  async expandSchedule(
    tx: Transaction,
    rule: {
      scheduleId: string;
      offerId: string;
      venueId: string;
      daysOfWeek: number[];
      startTime: string;
      capacity: number;
      validFrom: string;
      validUntil: string | null;
      durationMinutes: number;
      timeZone: string;
    },
  ): Promise<number> {
    const now = this.clock.now();
    const horizon = new Date(now.getTime() + EXPANSION_HORIZON_DAYS * 86_400_000);

    const [hourPart, minutePart] = rule.startTime.split(':');
    const hour = Number(hourPart);
    const minute = Number(minutePart);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
      throw new ApiException('VALIDATION_FAILED', `Invalid start time: ${rule.startTime}`);
    }

    // Venue-local closures; a slot must not be generated on a blocked day.
    const blocked = await tx
      .select({ blockedOn: schema.venueBlockedDates.blockedOn })
      .from(schema.venueBlockedDates)
      .where(eq(schema.venueBlockedDates.venueId, rule.venueId));
    const blockedDays = new Set(blocked.map((row) => row.blockedOn));

    const validFrom = new Date(`${rule.validFrom}T00:00:00Z`);
    const validUntil = rule.validUntil ? new Date(`${rule.validUntil}T23:59:59Z`) : null;

    const values: (typeof schema.slots.$inferInsert)[] = [];

    for (let offset = 0; offset < EXPANSION_HORIZON_DAYS; offset += 1) {
      const day = new Date(now.getTime() + offset * 86_400_000);
      if (!rule.daysOfWeek.includes(day.getUTCDay())) continue;

      const startAt = zonedTimeToUtc(
        {
          year: day.getUTCFullYear(),
          month: day.getUTCMonth() + 1,
          day: day.getUTCDate(),
          hour,
          minute,
        },
        rule.timeZone,
      );

      if (startAt <= now || startAt > horizon) continue;
      if (startAt < validFrom) continue;
      if (validUntil && startAt > validUntil) continue;
      if (blockedDays.has(zonedDayKey(startAt, rule.timeZone))) continue;

      values.push({
        offerId: rule.offerId,
        venueId: rule.venueId,
        scheduleId: rule.scheduleId,
        startAt,
        endAt: addMinutes(startAt, rule.durationMinutes),
        capacity: rule.capacity,
        reservedCount: 0,
        status: 'OPEN',
      });
    }

    if (values.length === 0) return 0;

    const inserted = await tx
      .insert(schema.slots)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: schema.slots.id });

    await tx
      .update(schema.schedules)
      .set({ expandedUntil: horizon, updatedAt: now })
      .where(eq(schema.schedules.id, rule.scheduleId));

    return inserted.length;
  }

  /**
   * Rolls every active rule forward.
   *
   * Called nightly. Without it the booking horizon would shrink by a day every
   * day until venues silently ran out of availability — the kind of failure that
   * looks like "demand dropped" rather than like a bug.
   */
  async expandDueSchedules(): Promise<number> {
    const now = this.clock.now();
    const dueBefore = new Date(now.getTime() + (EXPANSION_HORIZON_DAYS - 7) * 86_400_000);

    const rules = await this.db
      .select({
        scheduleId: schema.schedules.id,
        offerId: schema.schedules.offerId,
        venueId: schema.schedules.venueId,
        daysOfWeek: schema.schedules.daysOfWeek,
        startTime: schema.schedules.startTime,
        capacity: schema.schedules.capacity,
        validFrom: schema.schedules.validFrom,
        validUntil: schema.schedules.validUntil,
        durationMinutes: schema.offers.durationMinutes,
        timeZone: schema.venues.timeZone,
      })
      .from(schema.schedules)
      .innerJoin(schema.offers, eq(schema.offers.id, schema.schedules.offerId))
      .innerJoin(schema.venues, eq(schema.venues.id, schema.schedules.venueId))
      .where(
        and(
          eq(schema.schedules.isActive, true),
          eq(schema.offers.status, 'ACTIVE'),
          eq(schema.venues.status, 'ACTIVE'),
          or(
            isNull(schema.schedules.expandedUntil),
            lt(schema.schedules.expandedUntil, dueBefore),
          ),
        ),
      )
      .limit(500);

    let created = 0;
    for (const rule of rules) {
      // Per-rule transaction: one malformed schedule must not block every other
      // venue's availability from being extended.
      try {
        created += await this.db.transaction((tx) => this.expandSchedule(tx, rule));
      } catch (error) {
        this.logger.error(
          { err: error, scheduleId: rule.scheduleId },
          'failed to expand schedule',
        );
      }
    }

    if (created > 0) {
      this.logger.info({ rules: rules.length, slots: created }, 'expanded recurring schedules');
    }
    return created;
  }

  /** Cancels a slot and releases anyone booked into it. */
  async cancelSlot(input: {
    actor: AuthenticatedUser;
    slotId: string;
    reason: string;
  }): Promise<{ affectedReservations: number }> {
    const now = this.clock.now();

    return this.db.transaction(async (tx) => {
      const [slot] = await tx
        .select({
          id: schema.slots.id,
          venueId: schema.slots.venueId,
          businessId: schema.offers.businessId,
        })
        .from(schema.slots)
        .innerJoin(schema.offers, eq(schema.offers.id, schema.slots.offerId))
        .where(eq(schema.slots.id, input.slotId))
        // Only the slot is mutated; locking the joined offer row as well would
        // serialise unrelated bookings on that offer for no benefit.
        .for('update', { of: schema.slots })
        .limit(1);

      if (!slot) throw ApiException.notFound('slot', input.slotId);
      if (!hasBusinessRole(input.actor, slot.businessId, 'MANAGER')) {
        throw ApiException.forbidden('requires MANAGER');
      }

      await tx
        .update(schema.slots)
        .set({ status: 'CANCELLED', cancelledReason: input.reason, updatedAt: now })
        .where(eq(schema.slots.id, input.slotId));

      // The venue cancelled, so this is never the user's fault: their trial
      // allowance is returned and any payment is refundable.
      const affected = await tx
        .update(schema.reservations)
        .set({
          status: 'CANCELLED_BUSINESS',
          cancelledAt: now,
          cancellationReason: input.reason,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.reservations.slotId, input.slotId),
            sql`${schema.reservations.status} IN ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED')`,
          ),
        )
        .returning({ id: schema.reservations.id });

      if (affected.length > 0) {
        await tx
          .update(schema.trialHistory)
          .set({ status: 'CANCELLED_BUSINESS', updatedAt: now })
          .where(
            // `inArray`, jamais « = ANY(tableau interpolé) » : le template sql de Drizzle
            // déplie un tableau JS en tuple « ($1, $2) », que Postgres refuse de
            // caster en tableau. Découvert quand la première annulation réelle
            // d'un créneau a rendu une 500 au gérant.
            inArray(
              schema.trialHistory.reservationId,
              affected.map((row) => row.id),
            ),
          );
      }

      return { affectedReservations: affected.length };
    });
  }
}
