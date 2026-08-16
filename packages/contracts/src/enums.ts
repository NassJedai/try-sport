/**
 * The shared vocabulary of the product. Every one of these is persisted as a
 * Postgres enum and re-exported to mobile and web, so a value added here must be
 * added by migration too — that coupling is intentional: it prevents a client
 * inventing a status the backend has never heard of.
 */

export const RESERVATION_STATUSES = [
  'PENDING',
  'PAYMENT_PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'COMPLETED',
  'CANCELLED_USER',
  'CANCELLED_BUSINESS',
  'NO_SHOW',
  'REFUNDED',
  'EXPIRED',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const OFFER_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'ACTIVE',
  'PAUSED',
  'REJECTED',
  'ARCHIVED',
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const VENUE_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'ACTIVE',
  'PAUSED',
  'REJECTED',
  'SUSPENDED',
  'ARCHIVED',
] as const;
export type VenueStatus = (typeof VENUE_STATUSES)[number];

export const BUSINESS_STATUSES = [
  'PENDING_APPROVAL',
  'ACTIVE',
  'SUSPENDED',
  'ARCHIVED',
] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

export const USER_ROLES = ['USER', 'BUSINESS_MEMBER', 'ADMIN', 'SUPER_ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const BUSINESS_ROLES = ['OWNER', 'MANAGER', 'STAFF'] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

/**
 * How often a given user may claim a discovery trial. Default is per venue:
 * per-business is too strict for chains (Basic-Fit has 100 venues) and per-offer
 * is too loose (a venue could publish ten near-identical "first session" offers).
 */
export const TRIAL_RULES = [
  'ONE_TRIAL_PER_BUSINESS',
  'ONE_TRIAL_PER_VENUE',
  'ONE_TRIAL_PER_OFFER',
  'NO_RESTRICTION',
] as const;
export type TrialRule = (typeof TRIAL_RULES)[number];

export const DEFAULT_TRIAL_RULE: TrialRule = 'ONE_TRIAL_PER_VENUE';

export const EXPERIENCE_TYPES = [
  'FREE_TRIAL',
  'DISCOVERY_PRICE',
  'DISCOVERY_PACK',
  'INITIATION',
  'DAY_PASS',
  'BEGINNER_CLASS',
  'PREMIUM_EXPERIENCE',
] as const;
export type ExperienceType = (typeof EXPERIENCE_TYPES)[number];

export const SKILL_LEVELS = ['ALL_LEVELS', 'BEGINNER', 'INTERMEDIATE', 'ADVANCED'] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];

export const LEAD_STATUSES = [
  'NEW',
  'ATTENDED',
  'INTERESTED',
  'CONTACTED',
  'CONVERTED',
  'LOST',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const CONTINUATION_ANSWERS = ['YES', 'MAYBE', 'NO'] as const;
export type ContinuationAnswer = (typeof CONTINUATION_ANSWERS)[number];

export const PAYMENT_STATUSES = [
  'REQUIRES_PAYMENT',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * The payment status *of a booking*, as exposed to clients.
 *
 * Deliberately a superset of `PAYMENT_STATUSES`, never a second independent
 * vocabulary: every state a payment row can be in must be representable on the
 * booking that carries it, otherwise a refunded booking cannot be rendered at
 * all. The single extra value covers the one case where no payment row exists —
 * a free trial, where nothing was ever charged.
 *
 * `REQUIRES_CONFIRMATION`, which the booking view used to invent for itself, is
 * `REQUIRES_PAYMENT` under another name and has been folded back into it.
 *
 * See `bookingPaymentStatus()` in `booking-payment-status.ts` for the mapping.
 */
export const BOOKING_PAYMENT_STATUSES = ['NOT_REQUIRED', ...PAYMENT_STATUSES] as const;
export type BookingPaymentStatus = (typeof BOOKING_PAYMENT_STATUSES)[number];

export const BILLING_MODELS = [
  'FREE',
  'COMMISSION',
  'PAY_PER_ATTENDEE',
  'PAY_PER_CONVERSION',
  'SUBSCRIPTION',
] as const;
export type BillingModel = (typeof BILLING_MODELS)[number];

export const SLOT_STATUSES = ['OPEN', 'FULL', 'CANCELLED', 'CLOSED'] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

export const ATTRIBUTION_SOURCES = [
  'organic',
  'meta',
  'google',
  'tiktok',
  'referral',
  'business_qr',
  'influencer',
] as const;
export type AttributionSource = (typeof ATTRIBUTION_SOURCES)[number];

export const SUPPORTED_LOCALES = ['fr', 'en', 'nl'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'fr';
export const FALLBACK_LOCALE: Locale = 'en';
