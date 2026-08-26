import { z } from 'zod';
import { EXPERIENCE_TYPES, SKILL_LEVELS } from '../enums.js';
import {
  boundingBoxSchema,
  coordinatesSchema,
  cursorPageSchema,
  cursorPaginationSchema,
  imageVariantsSchema,
  isoDateTimeSchema,
  moneySchema,
  uuidSchema,
} from './common.js';

export const offerBadgeSchema = z.enum(['FREE', 'NEW', 'POPULAR', 'DISCOVERY_PRICE']);
export type OfferBadge = z.infer<typeof offerBadgeSchema>;

/**
 * The card payload. Everything the offer card renders is here and nothing more:
 * the list endpoint must not overfetch a full offer just to draw a tile.
 */
export const offerCardSchema = z.object({
  id: uuidSchema,
  title: z.string(),
  experienceType: z.enum(EXPERIENCE_TYPES),
  image: imageVariantsSchema.nullable(),
  price: moneySchema,
  /** Regular price, when it exists and is higher — drives the "28 € → 10 €" treatment. */
  referencePrice: moneySchema.nullable(),
  discountPercent: z.int().min(0).max(100),
  badges: z.array(offerBadgeSchema),
  durationMinutes: z.int().positive(),
  venue: z.object({
    id: uuidSchema,
    name: z.string(),
    districtName: z.string().nullable(),
    /**
     * IANA. `nextSlotAt` est un instant UTC : sans le fuseau du lieu, la carte
     * ne peut pas écrire « Prochain créneau · 19:00 » juste. L'app mobile
     * codait `Europe/Brussels` en dur faute de l'avoir dans le contrat.
     */
    timeZone: z.string(),
    coordinates: coordinatesSchema,
  }),
  /** Null when the user has not shared a location. */
  distanceMeters: z.number().nonnegative().nullable(),
  averageRating: z.number().min(0).max(5).nullable(),
  reviewCount: z.int().nonnegative(),
  nextSlotAt: isoDateTimeSchema.nullable(),
});
export type OfferCardDto = z.infer<typeof offerCardSchema>;

export const offerCardPageSchema = cursorPageSchema(offerCardSchema);
export type OfferCardPageDto = z.infer<typeof offerCardPageSchema>;

export const discoverySectionKeySchema = z.enum([
  'NEARBY',
  'AVAILABLE_TODAY',
  'FREE_TRIALS',
  'UNDER_10',
  'NEW',
  'POPULAR_THIS_WEEK',
  'FOR_YOU',
]);
export type DiscoverySectionKey = z.infer<typeof discoverySectionKeySchema>;

export const discoverySectionSchema = z.object({
  key: discoverySectionKeySchema,
  title: z.string(),
  subtitle: z.string().nullable(),
  offers: z.array(offerCardSchema),
  /** Present when the section has more than the preview returns. */
  seeAllFilter: z.record(z.string(), z.string()).nullable(),
});
export type DiscoverySectionDto = z.infer<typeof discoverySectionSchema>;

/**
 * One aggregating call powers the whole home screen. Eight round trips before
 * first paint is the difference between "instant" and "loading spinner".
 */
export const discoveryHomeSchema = z.object({
  cityName: z.string(),
  cityId: uuidSchema,
  sections: z.array(discoverySectionSchema),
  categories: z.array(
    z.object({
      id: uuidSchema,
      slug: z.string(),
      name: z.string(),
      icon: z.string(),
      offerCount: z.int().nonnegative(),
    }),
  ),
  generatedAt: isoDateTimeSchema,
});
export type DiscoveryHomeDto = z.infer<typeof discoveryHomeSchema>;

export const discoveryHomeQuerySchema = z.object({
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  /** Falls back to the city centroid when the user declined location access. */
  cityId: uuidSchema.optional(),
  radiusMeters: z.coerce.number().int().min(500).max(50_000).default(5_000),
});
export type DiscoveryHomeQueryDto = z.infer<typeof discoveryHomeQuerySchema>;

export const sortOptionSchema = z.enum(['RELEVANCE', 'DISTANCE', 'PRICE_ASC', 'RATING', 'SOONEST']);
export type SortOption = z.infer<typeof sortOptionSchema>;

/** Filters are flat and URL-encodable so web can share a search and mobile can deep-link it. */
export const searchOffersQuerySchema = cursorPaginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  categoryIds: z
    .union([z.array(uuidSchema), uuidSchema.transform((id) => [id])])
    .optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  radiusMeters: z.coerce.number().int().min(500).max(50_000).optional(),
  cityId: uuidSchema.optional(),
  districtIds: z
    .union([z.array(uuidSchema), uuidSchema.transform((id) => [id])])
    .optional(),
  maxPrice: z.coerce.number().int().nonnegative().optional(),
  freeOnly: z.coerce.boolean().optional(),
  availableFrom: isoDateTimeSchema.optional(),
  availableTo: isoDateTimeSchema.optional(),
  experienceTypes: z
    .union([z.array(z.enum(EXPERIENCE_TYPES)), z.enum(EXPERIENCE_TYPES).transform((v) => [v])])
    .optional(),
  skillLevels: z
    .union([z.array(z.enum(SKILL_LEVELS)), z.enum(SKILL_LEVELS).transform((v) => [v])])
    .optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  sort: sortOptionSchema.default('RELEVANCE'),
});
export type SearchOffersQueryDto = z.infer<typeof searchOffersQuerySchema>;

/**
 * Map queries are viewport-driven. The client debounces and sends a bounding box;
 * the server caps how many pins it will return so a zoomed-out view cannot ask
 * for every offer in the country.
 */
export const mapOffersQuerySchema = z.object({
  bounds: boundingBoxSchema,
  categoryIds: z.array(uuidSchema).optional(),
  maxPrice: z.coerce.number().int().nonnegative().optional(),
  freeOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(120),
});
export type MapOffersQueryDto = z.infer<typeof mapOffersQuerySchema>;

export const mapPinSchema = z.object({
  offerId: uuidSchema,
  venueId: uuidSchema,
  coordinates: coordinatesSchema,
  price: moneySchema,
  isFree: z.boolean(),
  categorySlug: z.string(),
});
export type MapPinDto = z.infer<typeof mapPinSchema>;

export const mapOffersResponseSchema = z.object({
  pins: z.array(mapPinSchema),
  /** True when results were capped, so the UI can prompt "zoom in for more". */
  truncated: z.boolean(),
});
export type MapOffersResponseDto = z.infer<typeof mapOffersResponseSchema>;
