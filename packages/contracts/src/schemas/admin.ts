import { z } from 'zod';
import { RESERVATION_STATUSES } from '../enums.js';
import { isoDateTimeSchema, moneySchema, uuidSchema } from './common.js';

/**
 * Ce que la console de modération lit, et que le contrat ne disait pas.
 *
 * La liste des réservations de `/v1/admin/bookings` n'avait **aucun schéma** :
 * sa forme était écrite à la main dans le type de retour du service côté API et
 * recopiée à la main, une seconde fois, dans une `interface AdminBooking` de la
 * page admin. Deux descriptions du même objet, aucune des deux opposable à
 * l'autre : `status` y était un `string` libre, donc un statut inventé serait
 * passé sans que rien ne le signale, et la liste des statuts filtrables était
 * elle aussi recopiée.
 *
 * Le fuseau est la raison immédiate de ce fichier. La console formatait
 * `slotStartAt` sans fuseau, donc dans celui du navigateur : un modérateur à
 * Lisbonne lisait 18:00 là où la salle bruxelloise affiche 19:00. Ce n'est pas
 * un détail d'affichage — c'est l'invariant « horodatage en UTC, affiché dans le
 * fuseau de la salle », et il ne peut pas être tenu si le fuseau ne traverse pas
 * le contrat.
 */
export const adminBookingSchema = z.object({
  id: uuidSchema,
  status: z.enum(RESERVATION_STATUSES),
  userEmail: z.email(),
  offerTitle: z.string(),
  venueName: z.string(),
  /** IANA, celui du lieu. `slotStartAt` s'affiche dedans, jamais dans celui du navigateur. */
  venueTimeZone: z.string(),
  slotStartAt: isoDateTimeSchema,
  price: moneySchema,
  createdAt: isoDateTimeSchema,
});
export type AdminBookingDto = z.infer<typeof adminBookingSchema>;

/**
 * Volontairement `{ items }` sans curseur : cette route rend une page unique
 * bornée par `limit`, contrairement à `/v1/admin/payments` qui pagine. Le
 * contrat décrit ce que la route fait aujourd'hui, pas ce qu'on aimerait
 * qu'elle fasse.
 */
export const adminBookingListSchema = z.object({
  items: z.array(adminBookingSchema),
});
export type AdminBookingListDto = z.infer<typeof adminBookingListSchema>;
