import { z } from 'zod';
import { isoDateTimeSchema, uuidSchema } from './common.js';

/**
 * Une notification telle que l'app la reçoit.
 *
 * `type` est volontairement une chaîne libre et non une énumération fermée :
 * ajouter un type côté serveur ne doit pas casser les apps déjà installées sur
 * les téléphones, qu'on ne peut pas mettre à jour de force. Le client affiche
 * `title` et `body`, qui suffisent à tout rendre, et ne se sert de `type` que
 * pour choisir une icône — avec un cas par défaut.
 */
export const notificationSchema = z.object({
  id: uuidSchema,
  type: z.string().max(60),
  title: z.string(),
  body: z.string(),
  /** Cible interne, ex. « /booking/<id> ». Jamais une URL externe. */
  deepLink: z.string().nullable(),
  readAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type NotificationDto = z.infer<typeof notificationSchema>;

export const notificationListSchema = z.object({
  items: z.array(notificationSchema),
  /**
   * Compté côté serveur plutôt que déduit de `items` : la liste est plafonnée à
   * 50, donc un compte dérivé du tableau plafonnerait avec elle et la pastille
   * afficherait « 50 » à quelqu'un qui en a 200.
   */
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationListDto = z.infer<typeof notificationListSchema>;
