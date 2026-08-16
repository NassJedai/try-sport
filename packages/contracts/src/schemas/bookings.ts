import { z } from 'zod';
import {
  BOOKING_PAYMENT_STATUSES,
  CONTINUATION_ANSWERS,
  RESERVATION_STATUSES,
} from '../enums.js';
import {
  cursorPageSchema,
  cursorPaginationSchema,
  imageVariantsSchema,
  isoDateTimeSchema,
  moneySchema,
  uuidSchema,
} from './common.js';

/**
 * Booking creation. The client sends *what* it wants, never *what it costs*:
 * price, currency, eligibility and capacity are all resolved server-side from
 * the offer and slot ids.
 */
export const createBookingSchema = z.object({
  slotId: uuidSchema,
  /** Echoed back for attribution; has no effect on pricing. */
  attribution: z
    .object({
      source: z.string().max(40).optional(),
      medium: z.string().max(40).optional(),
      campaign: z.string().max(80).optional(),
      referralCode: z.string().max(40).optional(),
    })
    .optional(),
});
export type CreateBookingDto = z.infer<typeof createBookingSchema>;

export const bookingPaymentSchema = z.object({
  /**
   * The payment vocabulary, not a booking-specific one. A refunded payment must
   * be representable here, otherwise the server has to lie about it.
   */
  status: z.enum(BOOKING_PAYMENT_STATUSES),
  amount: moneySchema,
  /**
   * Only ever a *client* secret. Server-side Stripe keys, customer ids and raw
   * card data never cross this boundary.
   */
  clientSecret: z.string().nullable(),
  provider: z.enum(['STRIPE', 'NONE']),
});
export type BookingPaymentDto = z.infer<typeof bookingPaymentSchema>;

export const bookingSchema = z.object({
  id: uuidSchema,
  status: z.enum(RESERVATION_STATUSES),
  createdAt: isoDateTimeSchema,

  offer: z.object({
    id: uuidSchema,
    title: z.string(),
    image: imageVariantsSchema.nullable(),
    durationMinutes: z.int().positive(),
    categoryName: z.string(),
  }),
  venue: z.object({
    id: uuidSchema,
    name: z.string(),
    addressLine: z.string(),
    districtName: z.string().nullable(),
    cityName: z.string(),
    timeZone: z.string(),
    latitude: z.number(),
    longitude: z.number(),
    phone: z.string().nullable(),
  }),
  slot: z.object({
    id: uuidSchema,
    startAt: isoDateTimeSchema,
    endAt: isoDateTimeSchema,
  }),

  price: moneySchema,
  payment: bookingPaymentSchema,

  cancellation: z.object({
    canCancel: z.boolean(),
    refundable: z.boolean(),
    freeUntil: isoDateTimeSchema,
    policyLabel: z.string(),
  }),

  /** Present only while the booking can still be used to enter the venue. */
  checkIn: z
    .object({
      shortCode: z.string(),
      /** Signed payload rendered as a QR; opaque to the client. */
      qrToken: z.string(),
      opensAt: isoDateTimeSchema,
      expiresAt: isoDateTimeSchema,
      checkedInAt: isoDateTimeSchema.nullable(),
    })
    .nullable(),

  review: z
    .object({
      submitted: z.boolean(),
      canReview: z.boolean(),
    })
    .nullable(),
});
export type BookingDto = z.infer<typeof bookingSchema>;

export const bookingPageSchema = cursorPageSchema(bookingSchema);
export type BookingPageDto = z.infer<typeof bookingPageSchema>;

export const listBookingsQuerySchema = cursorPaginationSchema.extend({
  scope: z.enum(['UPCOMING', 'PAST', 'ALL']).default('UPCOMING'),
});
export type ListBookingsQueryDto = z.infer<typeof listBookingsQuerySchema>;

export const cancelBookingSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type CancelBookingDto = z.infer<typeof cancelBookingSchema>;

/* ---------------------------------------------------------------------------
 * Check-in (business side)
 * ------------------------------------------------------------------------ */

export const checkInSchema = z
  .object({
    venueId: uuidSchema,
    qrToken: z.string().max(1024).optional(),
    shortCode: z.string().max(20).optional(),
    /**
     * Managers may override the time window (a user arriving very late still
     * attended). Every override is written to the audit log.
     */
    override: z.boolean().default(false),
    overrideReason: z.string().max(300).optional(),
  })
  .refine((input) => Boolean(input.qrToken ?? input.shortCode), {
    message: 'Either qrToken or shortCode is required',
  });
export type CheckInDto = z.infer<typeof checkInSchema>;

export const checkInResultSchema = z.object({
  reservationId: uuidSchema,
  status: z.enum(RESERVATION_STATUSES),
  checkedInAt: isoDateTimeSchema,
  attendee: z.object({
    firstName: z.string(),
    isFirstVisit: z.boolean(),
  }),
  offer: z.object({ id: uuidSchema, title: z.string() }),
  slot: z.object({ startAt: isoDateTimeSchema, endAt: isoDateTimeSchema }),
});
export type CheckInResultDto = z.infer<typeof checkInResultSchema>;

/* ---------------------------------------------------------------------------
 * Post-experience: review + the conversion question that funds the business
 * ------------------------------------------------------------------------ */

export const submitReviewSchema = z.object({
  rating: z.int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
  /** "Tu aimerais continuer ?" — this is what creates a qualified lead. */
  continuation: z.enum(CONTINUATION_ANSWERS).optional(),
  /** Explicit consent before a first name and answer reach the venue's CRM. */
  shareWithVenue: z.boolean().default(true),
});
export type SubmitReviewDto = z.infer<typeof submitReviewSchema>;
