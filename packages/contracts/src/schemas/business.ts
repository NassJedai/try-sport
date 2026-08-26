import { z } from 'zod';
import {
  BUSINESS_ROLES,
  CONTINUATION_ANSWERS,
  LEAD_STATUSES,
  OFFER_STATUSES,
  RESERVATION_STATUSES,
  SLOT_STATUSES,
  SUPPORTED_LOCALES,
  VENUE_STATUSES,
} from '../enums.js';
import { validateVatNumber, VAT_NUMBER_MAX_INPUT_LENGTH } from '../vat-number.js';
import {
  VENUE_DESCRIPTION_MIN_LENGTH,
  VENUE_SUBMISSION_REQUIREMENTS,
} from '../venue-submission.js';
import {
  cursorPageSchema,
  cursorPaginationSchema,
  isoDateTimeSchema,
  moneySchema,
  partialUpdateOf,
  timeOfDaySchema,
  uuidSchema,
} from './common.js';
import { openingHoursSchema } from './offers.js';

/**
 * Le numéro de TVA, quand il est fourni : normalisé et vérifié pour de bon.
 *
 * Il reste **facultatif à la création** — un gérant s'inscrit en cinq minutes et
 * complète ensuite — mais il est exigé pour soumettre le lieu à modération
 * (`venue-submission.ts`). D'où la répartition : schéma de création permissif,
 * porte de soumission stricte.
 *
 * En revanche, dès qu'une valeur est saisie elle est validée structure *et* clé
 * de contrôle, pour les trois pays supportés (BE, FR, ES). L'ancien commentaire
 * de ce champ annonçait « validated loosely here, strictly on approval » : la
 * validation stricte n'existait nulle part, et un numéro inventé pouvait
 * traverser jusqu'à la facture.
 *
 * Le préfixe du numéro fait foi sur le pays, pas `countryCode` : celui-ci vaut
 * 'BE' par défaut et l'assistant d'inscription ne l'envoie pas, donc valider la
 * TVA contre lui refuserait un numéro français légitime. Un défaut n'est pas une
 * déclaration. Voir `vatCountryOf()` — côté API, `countryCode` doit se déduire
 * du numéro, jamais du corps de la requête.
 */
const vatNumberInputSchema = z
  .string()
  .trim()
  .max(VAT_NUMBER_MAX_INPUT_LENGTH)
  .transform((raw, ctx): string | undefined => {
    // Champ laissé vide : « pas encore renseigné », pas « invalide ». Un
    // formulaire qui affiche « obligatoire » sur un champ qu'on vient
    // délibérément de rendre facultatif est la friction qu'on cherche à retirer.
    if (raw.trim().length === 0) return undefined;

    const result = validateVatNumber(raw);
    if (!result.ok) {
      // Le message part tel quel dans `details.vatNumber` de la réponse d'erreur.
      ctx.addIssue({ code: 'custom', message: result.message });
      return z.NEVER;
    }
    return result.value;
  });

export const createBusinessSchema = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: z.string().trim().min(2).max(160).optional(),
  vatNumber: vatNumberInputSchema.optional(),
  contactEmail: z.email(),
  contactPhone: z.string().trim().max(30).optional(),
  countryCode: z.string().length(2).default('BE'),
});
export type CreateBusinessDto = z.infer<typeof createBusinessSchema>;

export const createVenueSchema = z.object({
  name: z.string().trim().min(2).max(120),
  /**
   * Facultative ici, exigée pour soumettre à modération — même logique que la
   * TVA. Le plancher de longueur est celui de `venue-submission.ts` : une
   * description enregistrable mais trop courte pour la soumission serait
   * incompréhensible pour le gérant qui l'a écrite.
   */
  description: z.string().trim().min(VENUE_DESCRIPTION_MIN_LENGTH).max(4000).optional(),
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

/**
 * Mise à jour partielle d'un lieu — une clé absente veut dire « ne change rien ».
 *
 * Trois choses que l'implémenteur doit savoir avant d'écrire le service :
 *
 * 1. **`partialUpdateOf` et non `.partial()`.** Voir le commentaire de
 *    `partialUpdateOf` dans `common.ts` : `.partial()` laisse les `.default()`
 *    actifs, donc un simple renommage arrivait au service avec `amenities: []`,
 *    `openingHours: []`, `languages: ['fr']` et `timeZone: 'Europe/Brussels'`
 *    comme valeurs *présentes*. Un `set({ ...dto })` effaçait les équipements et
 *    les horaires de la salle. Ici, absent reste absent.
 *
 * 2. **`categoryIds: []` est refusé par le schéma**, pas laissé au service : le
 *    `.min(1)` de la création survit à la mise à jour partielle. Un lieu a donc
 *    toujours au moins une catégorie et « tout vider » n'est pas exprimable —
 *    même règle qu'à la création. Idem `languages: []`.
 *
 * 3. **Le service doit tout de même distinguer absent de vide** pour les champs
 *    qui acceptent le vide : `amenities: []` et `openingHours: []` sont des
 *    demandes légitimes de remise à zéro, `undefined` ne l'est pas. La règle est
 *    donc `key in dto ? dto.key : existing.key`, jamais `dto.key ?? existing.key`
 *    — ce dernier confondrait « efface » et « ne touche pas » sur les champs
 *    nullables.
 *
 * Ce que ce schéma ne dit pas : *qui* peut changer *quoi* et *dans quel statut*.
 * C'est `editable-fields.ts`, et le service doit poser les deux questions.
 */
export const updateVenueSchema = partialUpdateOf(createVenueSchema);
export type UpdateVenueDto = z.infer<typeof updateVenueSchema>;

/* ---------------------------------------------------------------------------
 * Schedules — recurring rules plus exceptions, expanded into slots server-side
 * ------------------------------------------------------------------------ */

export const recurringScheduleSchema = z.object({
  offerId: uuidSchema,
  /** 0 = Sunday. A rule may cover several days with the same start time. */
  daysOfWeek: z.array(z.int().min(0).max(6)).min(1).max(7),
  /**
   * Heure murale du lieu, stockée telle quelle et résolue en UTC à chaque
   * occurrence. Bornée à 00:00–23:59 par `timeOfDaySchema` : le format seul
   * laissait passer `29:59`, que `Date.UTC` transformait en 05:59 le lendemain.
   */
  startTime: timeOfDaySchema,
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
  /**
   * `CONTINUATION_ANSWERS` et non une recopie manuelle : l'enum était réécrit
   * ici alors que `submitReviewSchema` l'importait déjà. Mesuré — ajouter un
   * membre cassait `lead-pipeline.ts` mais pas ce schéma, donc le serveur
   * pouvait écrire une réponse que sa propre sortie de contrat déclarait
   * impossible, et le tableau de bord du gérant l'aurait rejetée à la lecture.
   */
  continuation: z.enum(CONTINUATION_ANSWERS).nullable(),
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
  /**
   * IANA, celui du lieu. Même motif que `businessSlotSchema` : la liste des
   * arrivées du jour affichait ses heures dans un fuseau codé en dur.
   */
  venueTimeZone: z.string(),
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
  venueId: uuidSchema,
  venueName: z.string(),
  priceAmount: z.int().nonnegative(),
  durationMinutes: z.int().positive(),
  capacity: z.int().positive(),
  rejectedReason: z.string().nullable(),
  /** Prochains créneaux ouverts — le chiffre qui dit si l'offre vit. */
  upcomingSlots: z.int().nonnegative(),
});
export type BusinessOfferDto = z.infer<typeof businessOfferSchema>;

/**
 * Un lieu vu par son propriétaire.
 *
 * Réponse de `GET /v1/businesses/:businessId/venues`, l'endpoint qui manque
 * aujourd'hui. Sans lui, un lieu `DRAFT` sans offre est **irrécupérable** : la
 * liste des offres est la seule vue existante et un lieu sans offre n'y produit
 * aucune ligne. Le gérant qui ferme l'onglet au milieu de l'assistant ne
 * retrouve donc jamais son lieu, et en recrée un.
 *
 * Trois blocs, trois raisons :
 *
 * - **l'état du dossier** — `status`, `rejectedReason`, `missingRequirements`,
 *   `offerCount`, `imageCount` : de quoi dire au gérant pourquoi il ne peut pas
 *   soumettre *avant* qu'il clique, et à l'admin ce qui manque à une salle
 *   inscrite mais incomplète ;
 * - **l'identité** — nom, adresse, catégories : ce que la modération a examiné ;
 * - **le reste des champs modifiables** — description, coordonnées, contact,
 *   équipements, horaires. Ce bloc n'est pas du confort : l'écran de correction
 *   après refus et l'écran de complétion font des mises à jour *partielles*, et
 *   un formulaire qui ne connaît pas la valeur actuelle d'un champ est un chemin
 *   d'effacement de données. Tout ce qui est éditable est donc lisible.
 *
 * Ce n'est pas la fiche publique (`venueDetailSchema`) : ni slug, ni note, ni
 * URL d'image — et à l'inverse le motif de refus, que le client ne voit jamais.
 */
export const businessVenueSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  status: z.enum(VENUE_STATUSES),
  /** Transmis tel quel au gérant : c'est ce qu'il doit corriger. */
  rejectedReason: z.string().nullable(),

  addressLine: z.string(),
  postalCode: z.string(),
  cityId: uuidSchema,
  districtId: uuidSchema.nullable(),
  categoryIds: z.array(uuidSchema),

  /** `submitVenue` refuse un lieu sans offre : autant le dire avant le clic. */
  offerCount: z.int().nonnegative(),
  /** Le récapitulatif doit pouvoir afficher « aucune photo ». */
  imageCount: z.int().nonnegative(),
  /**
   * Ce qui manque pour soumettre, résolu par le serveur.
   *
   * Vide veut dire « prêt à soumettre ». La liste est calculée par
   * `missingVenueSubmissionRequirements()` et non déduite des compteurs
   * ci-dessus : la TVA vit sur l'établissement, qu'un frontend n'a pas
   * forcément sous la main, et le client ne décide de rien qui compte.
   */
  missingRequirements: z.array(z.enum(VENUE_SUBMISSION_REQUIREMENTS)),

  description: z.string().nullable(),
  latitude: z.number(),
  longitude: z.number(),
  timeZone: z.string(),
  phone: z.string().nullable(),
  /**
   * Volontairement `string` et non `url` : la colonne est un `text` libre et une
   * valeur héritée mal formée ne doit pas faire échouer le tableau de bord de
   * son propriétaire. La validation d'URL a sa place à l'écriture.
   */
  website: z.string().nullable(),
  instagram: z.string().nullable(),
  amenities: z.array(z.string()),
  languages: z.array(z.enum(SUPPORTED_LOCALES)),
  openingHours: openingHoursSchema,

  createdAt: isoDateTimeSchema,
});
export type BusinessVenueDto = z.infer<typeof businessVenueSchema>;

/**
 * Un créneau du planning, avec son remplissage.
 *
 * `venueTimeZone` voyage avec le créneau, et ce n'est pas un confort : sans lui,
 * l'écran n'a pas de quoi afficher une heure juste. Mesuré — le tableau de bord
 * codait `Europe/Brussels` en dur faute de mieux, ce qui affiche une heure fausse
 * dès la première salle hors de Belgique et contredit l'invariant « horodatage en
 * UTC, affiché dans le fuseau de la salle ». `bookingSchema` transporte déjà
 * `venue.timeZone` ; ce DTO-ci ne le faisait pas.
 */
export const businessSlotSchema = z.object({
  id: uuidSchema,
  offerId: uuidSchema,
  offerTitle: z.string(),
  venueName: z.string(),
  /** IANA, celui du lieu. Les deux instants ci-dessous s'affichent dedans, jamais dans celui du navigateur. */
  venueTimeZone: z.string(),
  startAt: isoDateTimeSchema,
  endAt: isoDateTimeSchema,
  capacity: z.int().positive(),
  reservedCount: z.int().nonnegative(),
  status: z.enum(SLOT_STATUSES),
});
export type BusinessSlotDto = z.infer<typeof businessSlotSchema>;
