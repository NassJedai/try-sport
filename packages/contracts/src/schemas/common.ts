import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '@try/utils';
import { SUPPORTED_LOCALES } from '../enums.js';

export const uuidSchema = z.uuid();
export const isoDateTimeSchema = z.iso.datetime();

export const localeSchema = z.enum(SUPPORTED_LOCALES);
export const currencySchema = z.enum(SUPPORTED_CURRENCIES);

/** Money crosses the wire as minor units + currency; never as a formatted string. */
export const moneySchema = z.object({
  amount: z.int(),
  currency: currencySchema,
});
export type MoneyDto = z.infer<typeof moneySchema>;

export const coordinatesSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type CoordinatesDto = z.infer<typeof coordinatesSchema>;

export const boundingBoxSchema = z
  .object({
    minLatitude: z.number().min(-90).max(90),
    minLongitude: z.number().min(-180).max(180),
    maxLatitude: z.number().min(-90).max(90),
    maxLongitude: z.number().min(-180).max(180),
  })
  .refine((box) => box.minLatitude < box.maxLatitude, {
    message: 'minLatitude must be smaller than maxLatitude',
  })
  .refine((box) => box.minLongitude < box.maxLongitude, {
    message: 'minLongitude must be smaller than maxLongitude',
  });
export type BoundingBoxDto = z.infer<typeof boundingBoxSchema>;

export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;

/** Every list endpoint is bounded — an unbounded list is an outage waiting to happen. */
export const cursorPaginationSchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type CursorPaginationDto = z.infer<typeof cursorPaginationSchema>;

export function cursorPageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export const imageVariantsSchema = z.object({
  /** Feed cards. Never load the large variant into a list. */
  thumbnail: z.url(),
  medium: z.url(),
  large: z.url(),
  blurhash: z.string().nullable(),
  width: z.int().positive(),
  height: z.int().positive(),
});
export type ImageVariantsDto = z.infer<typeof imageVariantsSchema>;
