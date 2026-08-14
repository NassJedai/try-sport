import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import {
  CANCELLATION_POLICY_DEFINITIONS,
  assessCancellation,
  isLiveReservationStatus,
} from '@try/contracts';
import type { BookingDto, BookingPageDto, ListBookingsQueryDto } from '@try/contracts';
import { formatDateInZone, formatTimeInZone, money } from '@try/utils';
import type { Clock, CurrencyCode } from '@try/utils';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { AppConfig } from '@try/config';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { CONFIG } from '../../common/config.module.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { CryptoService } from '../../common/crypto.service.js';
import { BookingService } from './booking.service.js';

/** Flattened join result shared by the list and detail queries. */
interface BookingRow {
  reservation: typeof schema.reservations.$inferSelect;
  offer: {
    id: string;
    title: string;
    durationMinutes: number;
    cancellationPolicy: keyof typeof CANCELLATION_POLICY_DEFINITIONS;
  };
  category: { name: string | null };
  venue: {
    id: string;
    name: string;
    addressLine: string;
    timeZone: string;
    latitude: number;
    longitude: number;
    phone: string | null;
  };
  // LEFT JOINs yield a null object, not an object with null fields.
  district: { name: string } | null;
  city: { name: string } | null;
  slot: { id: string; startAt: Date; endAt: Date };
  payment: { status: string; amount: number } | null;
  review: { id: string } | null;
}

@Injectable()
export class BookingQueryService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly crypto: CryptoService,
  ) {}

  async listForUser(userId: string, query: ListBookingsQueryDto): Promise<BookingPageDto> {
    const now = this.clock.now();

    const scopeCondition =
      query.scope === 'UPCOMING'
        ? and(
            gte(schema.reservations.slotStartAt, now),
            sql`${schema.reservations.status} IN ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'CHECKED_IN')`,
          )
        : query.scope === 'PAST'
          ? lt(schema.reservations.slotStartAt, now)
          : undefined;

    const rows = await this.db
      .select(this.selection())
      .from(schema.reservations)
      .innerJoin(schema.offers, eq(schema.offers.id, schema.reservations.offerId))
      .innerJoin(schema.venues, eq(schema.venues.id, schema.reservations.venueId))
      .innerJoin(schema.slots, eq(schema.slots.id, schema.reservations.slotId))
      .innerJoin(schema.categories, eq(schema.categories.id, schema.offers.categoryId))
      .innerJoin(schema.cities, eq(schema.cities.id, schema.venues.cityId))
      .leftJoin(schema.districts, eq(schema.districts.id, schema.venues.districtId))
      .leftJoin(schema.payments, eq(schema.payments.reservationId, schema.reservations.id))
      .leftJoin(schema.reviews, eq(schema.reviews.reservationId, schema.reservations.id))
      .where(and(eq(schema.reservations.userId, userId), scopeCondition))
      .orderBy(
        query.scope === 'PAST'
          ? desc(schema.reservations.slotStartAt)
          : schema.reservations.slotStartAt,
      )
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    return {
      items: page.map((row) => this.toDto(row, now, false)),
      nextCursor: null,
    };
  }

  /**
   * Booking detail. The QR token is only materialised here, for the owner, and
   * only while the booking can still be used — a past booking's token is dead
   * weight and an unnecessary credential to leave lying around.
   */
  async findForUser(userId: string, reservationId: string): Promise<BookingDto> {
    const now = this.clock.now();

    const [row] = await this.db
      .select(this.selection())
      .from(schema.reservations)
      .innerJoin(schema.offers, eq(schema.offers.id, schema.reservations.offerId))
      .innerJoin(schema.venues, eq(schema.venues.id, schema.reservations.venueId))
      .innerJoin(schema.slots, eq(schema.slots.id, schema.reservations.slotId))
      .innerJoin(schema.categories, eq(schema.categories.id, schema.offers.categoryId))
      .innerJoin(schema.cities, eq(schema.cities.id, schema.venues.cityId))
      .leftJoin(schema.districts, eq(schema.districts.id, schema.venues.districtId))
      .leftJoin(schema.payments, eq(schema.payments.reservationId, schema.reservations.id))
      .leftJoin(schema.reviews, eq(schema.reviews.reservationId, schema.reservations.id))
      .where(eq(schema.reservations.id, reservationId))
      .limit(1);

    if (!row) throw ApiException.notFound('reservation', reservationId);
    if (row.reservation.userId !== userId) {
      // Deliberately 404, not 403: confirming that someone else's booking exists
      // is itself a leak.
      throw ApiException.notFound('reservation', reservationId);
    }

    return this.toDto(row, now, true);
  }

  private selection() {
    return {
      reservation: schema.reservations,
      offer: {
        id: schema.offers.id,
        title: schema.offers.title,
        durationMinutes: schema.offers.durationMinutes,
        cancellationPolicy: schema.offers.cancellationPolicy,
      },
      category: { name: schema.categories.name },
      venue: {
        id: schema.venues.id,
        name: schema.venues.name,
        addressLine: schema.venues.addressLine,
        timeZone: schema.venues.timeZone,
        latitude: schema.venues.latitude,
        longitude: schema.venues.longitude,
        phone: schema.venues.phone,
      },
      district: { name: schema.districts.name },
      city: { name: schema.cities.name },
      slot: {
        id: schema.slots.id,
        startAt: schema.slots.startAt,
        endAt: schema.slots.endAt,
      },
      payment: {
        status: schema.payments.status,
        amount: schema.payments.amount,
      },
      review: { id: schema.reviews.id },
    };
  }

  private toDto(row: BookingRow, now: Date, includeCheckInToken: boolean): BookingDto {
    const reservation = row.reservation;
    const currency = reservation.currency as CurrencyCode;

    const assessment = assessCancellation({
      policy: row.offer.cancellationPolicy,
      slotStartAt: reservation.slotStartAt,
      now,
    });

    const window = BookingService.checkInWindow(reservation.slotStartAt, reservation.slotEndAt);
    const isLive = isLiveReservationStatus(reservation.status);

    return {
      id: reservation.id,
      status: reservation.status,
      createdAt: reservation.createdAt.toISOString(),
      offer: {
        id: row.offer.id,
        title: row.offer.title,
        image: null,
        durationMinutes: row.offer.durationMinutes,
        categoryName: row.category?.name ?? '',
      },
      venue: {
        id: row.venue.id,
        name: row.venue.name,
        addressLine: row.venue.addressLine,
        districtName: row.district?.name ?? null,
        cityName: row.city?.name ?? '',
        timeZone: row.venue.timeZone,
        latitude: row.venue.latitude,
        longitude: row.venue.longitude,
        phone: row.venue.phone,
      },
      slot: {
        id: row.slot.id,
        startAt: reservation.slotStartAt.toISOString(),
        endAt: reservation.slotEndAt.toISOString(),
      },
      price: money(reservation.priceAmount, currency),
      payment: {
        status:
          reservation.priceAmount === 0
            ? 'NOT_REQUIRED'
            : row.payment?.status === 'SUCCEEDED'
              ? 'SUCCEEDED'
              : row.payment?.status === 'FAILED'
                ? 'FAILED'
                : reservation.status === 'PAYMENT_PENDING'
                  ? 'REQUIRES_CONFIRMATION'
                  : 'PROCESSING',
        amount: money(reservation.priceAmount, currency),
        // The client secret is returned at creation time only; re-issuing it on
        // every read would spread a payment credential across the app's caches.
        clientSecret: null,
        provider: reservation.priceAmount === 0 ? 'NONE' : 'STRIPE',
      },
      cancellation: {
        canCancel: assessment.canCancel && isLive,
        refundable: assessment.refundable,
        freeUntil: assessment.freeUntil.toISOString(),
        policyLabel: CANCELLATION_POLICY_DEFINITIONS[row.offer.cancellationPolicy].labelFr,
      },
      checkIn:
        includeCheckInToken && isLive && reservation.checkInCode
          ? {
              shortCode: reservation.checkInCode,
              qrToken: this.buildQrToken(reservation.id, reservation.checkInCode),
              opensAt: window.opensAt.toISOString(),
              expiresAt: window.expiresAt.toISOString(),
              checkedInAt: reservation.checkedInAt?.toISOString() ?? null,
            }
          : null,
      review: {
        submitted: row.review !== null,
        // Reviewing requires having actually attended.
        canReview:
          row.review === null &&
          (reservation.status === 'CHECKED_IN' || reservation.status === 'COMPLETED'),
      },
    };
  }

  /**
   * The QR payload is `reservationId.code.signature`.
   *
   * Signed rather than random-and-stored so a venue's scanner can reject a forged
   * code without a database round trip, and so the reservation UUID alone is never
   * sufficient to check somebody in.
   */
  private buildQrToken(reservationId: string, code: string): string {
    const payload = `${reservationId}.${code}`;
    return `${payload}.${this.crypto.signCheckInPayload(payload)}`;
  }

  formatWhen(startAt: Date, timeZone: string): string {
    return `${formatDateInZone(startAt, timeZone)} à ${formatTimeInZone(startAt, timeZone)}`;
  }

  publicUrl(): string {
    return this.config.API_PUBLIC_URL;
  }
}
