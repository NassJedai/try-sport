import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '@try/utils';
import { SUPPORTED_LOCALES } from '../enums.js';

export const uuidSchema = z.uuid();
export const isoDateTimeSchema = z.iso.datetime();

/**
 * Une heure murale du jour : `HH:mm`, de `00:00` à `23:59`.
 *
 * Règle métier, en une phrase : **un horaire est une heure du jour, jamais un
 * nombre d'heures.**
 *
 * Le format seul (`/^\d{2}:\d{2}$/`) ne suffisait pas et le défaut était
 * silencieux : `startTime: '29:59'` traversait le contrat, puis le service — qui
 * ne vérifiait que `Number.isInteger(29)` — puis `Date.UTC(..., 29, 59)`, qui
 * *normalise* 29 h en 05:59 le lendemain. Résultat mesuré : un `POST
 * /v1/schedules` à `29:59` rendait `201` et sept créneaux au mauvais jour, sans
 * une seule erreur. Un horaire hors bornes doit être refusé au premier mètre,
 * avec le nom du champ, pas absorbé par l'arithmétique du calendrier.
 *
 * `24:00` est délibérément refusé, y compris comme heure de fermeture : minuit
 * s'écrit `00:00` et une salle ouverte jusqu'à 2 h ferme à `02:00`. Vérifié :
 * aucune donnée du dépôt n'utilise `24:00`.
 *
 * La contrainte SQL `schedules_start_time_format` est plus stricte que l'ancien
 * contrat (`^[0-2][0-9]:[0-5][0-9]$`) mais accepte encore `29:59` : elle doit
 * suivre ce schéma, faute de quoi les deux se contredisent — et une valeur que
 * le contrat accepte alors que la base la refuse rend un 500 là où le gérant
 * attend un 400 nommant le champ.
 */
export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const timeOfDaySchema = z
  .string()
  .regex(TIME_OF_DAY_PATTERN, 'Heure invalide : attendu HH:mm entre 00:00 et 23:59.');

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

/**
 * Construit un schéma de mise à jour partielle à partir d'un schéma de création.
 *
 * `.partial()` seul ne suffit pas, et c'est un piège coûteux : en Zod 4, rendre
 * une clé optionnelle **ne désactive pas son `.default()`**. Vérifié —
 * `createVenueSchema.partial().parse({ name: 'Studio' })` rend
 * `{ name: 'Studio', timeZone: 'Europe/Brussels', amenities: [], languages:
 * ['fr'], openingHours: [] }`, et `.parse({})` rend les quatre derniers à lui
 * seul. Un service qui écrit ce qu'il reçoit effacerait donc les équipements et
 * les horaires d'un lieu à chaque renommage et remettrait son fuseau à
 * Bruxelles ; côté offre, `referencePriceAmount` retomberait à `null`, donc le
 * prix barré disparaîtrait sur une simple correction de titre.
 *
 * Ici les valeurs par défaut sont retirées **avant** de rendre les clés
 * optionnelles : une clé absente reste absente, et « absent » veut dire « ne
 * change rien ». Les validations internes sont conservées — sur le schéma
 * résultant, `categoryIds: []` reste refusé par son `.min(1)`, donc « vider les
 * catégories » demeure inexprimable, exactement comme à la création.
 */
type WithoutDefault<T> = T extends z.ZodDefault<infer TInner> ? TInner : T;

export function partialUpdateOf<TShape extends z.ZodRawShape>(
  schema: z.ZodObject<TShape>,
): z.ZodObject<{ [K in keyof TShape]: z.ZodOptional<WithoutDefault<TShape[K]>> }> {
  const shape: Record<string, z.ZodType> = {};

  for (const [key, field] of Object.entries(schema.shape) as [string, z.ZodType][]) {
    const withoutDefault = field instanceof z.ZodDefault ? (field.def.innerType as z.ZodType) : field;
    shape[key] = withoutDefault.optional();
  }

  return z.object(shape) as unknown as z.ZodObject<{
    [K in keyof TShape]: z.ZodOptional<WithoutDefault<TShape[K]>>;
  }>;
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
