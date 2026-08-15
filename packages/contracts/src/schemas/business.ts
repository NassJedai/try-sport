import { z } from 'zod';
import { BUSINESS_ROLES, LEAD_STATUSES, OFFER_STATUSES, RESERVATION_STATUSES, SLOT_STATUSES, SUPPORTED_LOCALES } from '../enums.js';
import {
  cursorPageSchema,
  cursorPaginationSchema,
  isoDateTimeSchema,
  moneySchema,
  uuidSchema,
} from './common.js';
import { openingHoursSchema } from './offers.js';

export const createBusinessSchema = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(160).optional(),
  /** Belgian VAT (BE0123456789) validated loosely here, strictly on approval. */
  vatNumber: z.string().trim().max(30).optional(),
  contactEmail: z.email(),
  contactPhone: z.string().trim().max(30).optional(),
  countryCode: z.string().length(2).default('BE'),
});
export type CreateBusinessDto = z.infer<typeof createBusinessSchema>;

export const createVenueSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(4000).optional(),
  addressLine: z.string().trim().min(4).max(200),
  postalCode: z.string().trim().min(2).max(12),
  cityId: uuidSchema,
  districtId: uuidSchema.optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timeZone: z.string().max(64).default('Europe/Brussels'),
  phone: z.string().trim().max(30).optional(),
  website: z.url().optional(),
  instagram: z.string().trim().max(60).optional(),
  amenities: z.array(z.string().max(60)).max(30).default([]),
  languages: z.array(z.enum(SUPPORTED_LOCALES)).min(1).default(['fr']),
  openingHours: openingHoursSchema.default([]),
  categoryIds: z.array(uuidSchema).min(1).max(10),
});
export type CreateVenueDto = z.infer<typeof createVenueSchema>;

export const updateVenueSchema = createVenueSchema.partial();
export type UpdateVenueDto = z.infer<typeof updateVenueSchema>;

/* ---------------------------------------------------------------------------
 * Schedules — recurring rules plus exceptions, expanded into slots server-side
 * ------------------------------------------------------------------------ */

export const recurringScheduleSchema = z.object({
  offerId: uuidSchema,
  /** 0 = Sunday. A rule may cover several days with the same start time. */
  daysOfWeek: z.array(z.int().min(0).max(6)).min(1).max(7),
  /** Venue-local wall clock. Stored as-is and resolved to UTC per occurrence. */
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  capacity: z.int().min(1).max(500),
  validFrom: z.iso.date(),
  validUntil: z.iso.date().nullable().default(null),
});
export type RecurringScheduleDto = z.infer<typeof recurringScheduleSchema>;

export const createSlotSchema = z.object({
  offerId: uuidSchema,
  startAt: isoDateTimeSchema,
  capacity: z.int().min(1).max(500),
});
export type CreateSlotDto = z.infer<typeof createSlotSchema>;

export const blockDatesSchema = z.object({
  venueId: uuidSchema,
  /** Venue-local calendar dates to close (holidays, maintenance). */
  dates: z.array(z.iso.date()).min(1).max(60),
  reason: z.string().max(200).optional(),
});
export type BlockDatesDto = z.infer<typeof blockDatesSchema>;

/* ---------------------------------------------------------------------------
 * Business dashboard: the trial -> conversion loop
 * ------------------------------------------------------------------------ */

export const businessMetricsQuerySchema = z.object({
  venueId: uuidSchema.optional(),
  from: z.iso.date(),
  to: z.iso.date(),
});
export type BusinessMetricsQueryDto = z.infer<typeof businessMetricsQuerySchema>;

export const businessMetricsSchema = z.object({
  trials: z.int().nonnegative(),
  checkIns: z.int().nonnegative(),
  noShows: z.int().nonnegative(),
  conversions: z.int().nonnegative(),
  /** checkIns / trials — how many booked trials actually showed up. */
  attendanceRate: z.number().min(0).max(1),
  /** conversions / checkIns — the number the venue is actually buying. */
  conversionRate: z.number().min(0).max(1),
  attributedRevenue: moneySchema,
  previousPeriod: z
    .object({
      trials: z.int().nonnegative(),
      checkIns: z.int().nonnegative(),
      conversions: z.int().nonnegative(),
      conversionRate: z.number().min(0).max(1),
    })
    .nullable(),
});
export type BusinessMetricsDto = z.infer<typeof businessMetricsSchema>;

export const leadSchema = z.object({
  id: uuidSchema,
  status: z.enum(LEAD_STATUSES),
  /** Only the first name is exposed: the venue needs to greet them, not profile them. */
  firstName: z.string(),
  offerTitle: z.string(),
  categoryName: z.string(),
  visitedAt: isoDateTimeSchema.nullable(),
  continuation: z.enum(['YES', 'MAYBE', 'NO']).nullable(),
  rating: z.int().min(1).max(5).nullable(),
  /** Present only after the user consented to be contacted. */
  contactEmail: z.email().nullable(),
  contactPhone: z.string().nullable(),
  notes: z.string().nullable(),
  convertedAt: isoDateTimeSchema.nullable(),
  attributedRevenue: moneySchema.nullable(),
  updatedAt: isoDateTimeSchema,
});
export type LeadDto = z.infer<typeof leadSchema>;

export const leadPageSchema = cursorPageSchema(leadSchema);

export const listLeadsQuerySchema = cursorPaginationSchema.extend({
  venueId: uuidSchema.optional(),
  status: z.enum(LEAD_STATUSES).optional(),
});
export type ListLeadsQueryDto = z.infer<typeof listLeadsQuerySchema>;

export const updateLeadSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  notes: z.string().max(2000).nullable().optional(),
  /** Set when marking CONVERTED: what the customer is worth, in minor units. */
  attributedRevenueAmount: z.int().nonnegative().nullable().optional(),
});
export type UpdateLeadDto = z.infer<typeof updateLeadSchema>;

export const businessBookingSchema = z.object({
  id: uuidSchema,
  status: z.enum(RESERVATION_STATUSES),
  /** Needed by the front desk: check-in is always scoped to a specific venue. */
  venueId: uuidSchema,
  venueName: z.string(),
  attendeeFirstName: z.string(),
  isFirstVisit: z.boolean(),
  offerTitle: z.string(),
  slotStartAt: isoDateTimeSchema,
  slotEndAt: isoDateTimeSchema,
  shortCode: z.string(),
  price: moneySchema,
  checkedInAt: isoDateTimeSchema.nullable(),
});
export type BusinessBookingDto = z.infer<typeof businessBookingSchema>;

export const businessBookingPageSchema = cursorPageSchema(businessBookingSchema);

export const listBusinessBookingsQuerySchema = cursorPaginationSchema.extend({
  venueId: uuidSchema.optional(),
  /** Venue-local day; defaults to today at the venue, not at the server. */
  date: z.iso.date().optional(),
  status: z.enum(RESERVATION_STATUSES).optional(),
});
export type ListBusinessBookingsQueryDto = z.infer<typeof listBusinessBookingsQuerySchema>;

export const inviteMemberSchema = z.object({
  email: z.email(),
  role: z.enum(BUSINESS_ROLES),
});
export type InviteMemberDto = z.infer<typeof inviteMemberSchema>;

/**
 * Une offre vue par son propriétaire.
 *
 * Ce n'est pas la carte publique : le gérant voit aussi ce que le client ne
 * doit pas voir — le statut de modération, le motif de refus, la pause.
 */
export const businessOfferSchema = z.object({
  id: uuidSchema,
  title: z.string(),
  status: z.enum(OFFER_STATUSES),
  venueName: z.string(),
  priceAmount: z.int().nonnegative(),
  durationMinutes: z.int().positive(),
  capacity: z.int().positive(),
  rejectedReason: z.string().nullable(),
  /** Prochains créneaux ouverts — le chiffre qui dit si l'offre vit. */
  upcomingSlots: z.int().nonnegative(),
});
export type BusinessOfferDto = z.infer<typeof businessOfferSchema>;

/** Un créneau du planning, avec son remplissage. */
export const businessSlotSchema = z.object({
  id: uuidSchema,
  offerId: uuidSchema,
  offerTitle: z.string(),
  venueName: z.string(),
  startAt: isoDateTimeSchema,
  endAt: isoDateTimeSchema,
  capacity: z.int().positive(),
  reservedCount: z.int().nonnegative(),
  status: z.enum(SLOT_STATUSES),
});
export type BusinessSlotDto = z.infer<typeof businessSlotSchema>;
