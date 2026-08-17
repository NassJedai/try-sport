import { z } from 'zod';
import { CANCELLATION_POLICIES } from '../cancellation-policy.js';
import { EXPERIENCE_TYPES, OFFER_STATUSES, SKILL_LEVELS, SUPPORTED_LOCALES, TRIAL_RULES } from '../enums.js';
import {
  coordinatesSchema,
  currencySchema,
  imageVariantsSchema,
  isoDateTimeSchema,
  moneySchema,
  partialUpdateOf,
  uuidSchema,
} from './common.js';
import { offerBadgeSchema } from './discovery.js';

export const venueSummarySchema = z.object({
  id: uuidSchema,
  slug: z.string(),
  name: z.string(),
  coordinates: coordinatesSchema,
  addressLine: z.string(),
  districtName: z.string().nullable(),
  cityName: z.string(),
  timeZone: z.string(),
  logo: imageVariantsSchema.nullable(),
  averageRating: z.number().min(0).max(5).nullable(),
  reviewCount: z.int().nonnegative(),
});
export type VenueSummaryDto = z.infer<typeof venueSummarySchema>;

export const openingHoursSchema = z.array(
  z.object({
    /** 0 = Sunday, matching JS getDay(). */
    dayOfWeek: z.int().min(0).max(6),
    opensAt: z.string().regex(/^\d{2}:\d{2}$/),
    closesAt: z.string().regex(/^\d{2}:\d{2}$/),
  }),
);

export const venueDetailSchema = venueSummarySchema.extend({
  description: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.url().nullable(),
  instagram: z.string().nullable(),
  cover: imageVariantsSchema.nullable(),
  gallery: z.array(imageVariantsSchema),
  amenities: z.array(z.string()),
  languages: z.array(z.enum(SUPPORTED_LOCALES)),
  openingHours: openingHoursSchema,
  categories: z.array(z.object({ id: uuidSchema, slug: z.string(), name: z.string() })),
});
export type VenueDetailDto = z.infer<typeof venueDetailSchema>;

export const reviewSummarySchema = z.object({
  averageRating: z.number().min(0).max(5).nullable(),
  reviewCount: z.int().nonnegative(),
  distribution: z.record(z.string(), z.int().nonnegative()),
  latest: z.array(
    z.object({
      id: uuidSchema,
      rating: z.int().min(1).max(5),
      comment: z.string().nullable(),
      authorFirstName: z.string(),
      createdAt: isoDateTimeSchema,
    }),
  ),
});
export type ReviewSummaryDto = z.infer<typeof reviewSummarySchema>;

export const offerDetailSchema = z.object({
  id: uuidSchema,
  status: z.enum(OFFER_STATUSES),
  title: z.string(),
  description: z.string(),
  experienceType: z.enum(EXPERIENCE_TYPES),
  skillLevel: z.enum(SKILL_LEVELS),
  category: z.object({ id: uuidSchema, slug: z.string(), name: z.string(), icon: z.string() }),

  price: moneySchema,
  referencePrice: moneySchema.nullable(),
  discountPercent: z.int().min(0).max(100),
  badges: z.array(offerBadgeSchema),

  durationMinutes: z.int().positive(),
  capacity: z.int().positive(),
  languages: z.array(z.enum(SUPPORTED_LOCALES)),

  gallery: z.array(imageVariantsSchema),
  amenities: z.array(z.string()),
  whatToBring: z.array(z.string()),
  conditions: z.string().nullable(),

  cancellationPolicy: z.enum(CANCELLATION_POLICIES),
  cancellationPolicyLabel: z.string(),
  trialRule: z.enum(TRIAL_RULES),

  venue: venueDetailSchema,
  distanceMeters: z.number().nonnegative().nullable(),
  reviews: reviewSummarySchema,

  /**
   * Resolved for the authenticated user. Null for anonymous callers, who see the
   * offer but are asked to sign in at booking time.
   */
  viewerEligibility: z
    .object({
      eligible: z.boolean(),
      reason: z.string().nullable(),
      message: z.string().nullable(),
    })
    .nullable(),
  isFavorite: z.boolean(),
  publishedAt: isoDateTimeSchema.nullable(),
});
export type OfferDetailDto = z.infer<typeof offerDetailSchema>;

/** A bookable slot as the client sees it. `remainingCapacity` is advisory only. */
export const slotSchema = z.object({
  id: uuidSchema,
  startAt: isoDateTimeSchema,
  endAt: isoDateTimeSchema,
  capacity: z.int().positive(),
  remainingCapacity: z.int().nonnegative(),
  isBookable: z.boolean(),
});
export type SlotDto = z.infer<typeof slotSchema>;

export const availabilityDaySchema = z.object({
  /** Venue-local calendar day, "2026-03-14". */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slots: z.array(slotSchema),
});
export type AvailabilityDayDto = z.infer<typeof availabilityDaySchema>;

export const availabilityResponseSchema = z.object({
  offerId: uuidSchema,
  timeZone: z.string(),
  days: z.array(availabilityDaySchema),
});
export type AvailabilityResponseDto = z.infer<typeof availabilityResponseSchema>;

export const availabilityQuerySchema = z.object({
  from: isoDateTimeSchema.optional(),
  /** Capped server-side; a client cannot ask for a year of slots in one call. */
  days: z.coerce.number().int().min(1).max(30).default(14),
});
export type AvailabilityQueryDto = z.infer<typeof availabilityQuerySchema>;

/* ---------------------------------------------------------------------------
 * Business-side offer management
 * ------------------------------------------------------------------------ */

export const createOfferSchema = z.object({
  venueId: uuidSchema,
  categoryId: uuidSchema,
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(20).max(4000),
  experienceType: z.enum(EXPERIENCE_TYPES),
  skillLevel: z.enum(SKILL_LEVELS).default('ALL_LEVELS'),
  /**
   * Prices are minor units. The server re-derives the discount and never trusts a
   * client-supplied discount percentage.
   */
  priceAmount: z.int().nonnegative(),
  referencePriceAmount: z.int().nonnegative().nullable().default(null),
  currency: currencySchema.default('EUR'),
  durationMinutes: z.int().min(10).max(480),
  capacity: z.int().min(1).max(500),
  languages: z.array(z.enum(SUPPORTED_LOCALES)).min(1).default(['fr']),
  amenities: z.array(z.string().max(60)).max(20).default([]),
  whatToBring: z.array(z.string().max(60)).max(20).default([]),
  conditions: z.string().max(2000).nullable().default(null),
  cancellationPolicy: z.enum(CANCELLATION_POLICIES).default('STANDARD'),
  trialRule: z.enum(TRIAL_RULES).default('ONE_TRIAL_PER_VENUE'),
});
export type CreateOfferDto = z.infer<typeof createOfferSchema>;

/**
 * Mise à jour partielle d'une offre — une clé absente veut dire « ne change rien ».
 *
 * `venueId` est retiré : une offre ne se déplace pas d'un lieu à l'autre. Elle
 * porte les statistiques de conversion de ce lieu, ses créneaux et ses
 * réservations ; la déplacer réécrirait l'histoire. Créer une offre sur l'autre
 * lieu et archiver celle-ci est la seule voie.
 *
 * `partialUpdateOf` et non `.partial()` : vérifié, `.partial()` laisse les
 * `.default()` actifs, donc corriger le seul titre arrivait au service avec
 * `referencePriceAmount: null`, `skillLevel: 'ALL_LEVELS'`,
 * `cancellationPolicy: 'STANDARD'`, `trialRule: 'ONE_TRIAL_PER_VENUE'`,
 * `currency: 'EUR'`, `conditions: null` et trois tableaux vides comme valeurs
 * *présentes*. Le prix barré et la politique d'annulation disparaissaient sur
 * une correction de faute de frappe. Voir `partialUpdateOf` dans `common.ts`.
 *
 * `referencePriceAmount: null` et `conditions: null` restent exprimables — ce
 * sont des remises à zéro légitimes —, donc le service doit distinguer absent de
 * `null` : `key in dto ? dto.key : existing.key`, jamais `??`. Les montants
 * restent en unités mineures entières, ici comme partout.
 *
 * Ce que ce schéma ne dit pas : *quel* champ est modifiable *dans quel statut*.
 * C'est `editable-fields.ts` — et le prix y est un champ modéré.
 */
export const updateOfferSchema = partialUpdateOf(createOfferSchema.omit({ venueId: true }));
export type UpdateOfferDto = z.infer<typeof updateOfferSchema>;
