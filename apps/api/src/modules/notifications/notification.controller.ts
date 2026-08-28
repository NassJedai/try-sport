import { Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { notificationListSchema, type NotificationListDto } from '@try/contracts';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import { buildCursorPage, decodeCursor } from '@try/utils';
import type { Clock } from '@try/utils';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user.js';
import { zodQuery } from '../../common/zod-validation.pipe.js';

/**
 * `cursor`/`limit` reproduisent exactement `paymentsQuerySchema`
 * (`admin-browse.controller.ts`, `GET /v1/admin/payments`) : même curseur
 * keyset opaque (`@try/utils#decodeCursor`/`buildCursorPage`), mêmes bornes
 * de limite (1-100, défaut 50). Un lot précédent plafonnait cette liste à
 * `.limit(50)` sans jamais permettre d'aller plus loin — au-delà de 50
 * notifications, les plus anciennes devenaient inatteignables alors que
 * `unreadCount` continuait, lui, à toutes les compter.
 *
 * `unreadOnly` reste une chaîne libre plutôt qu'un `z.enum(['true','false'])`
 * volontairement : c'est le contrat de comportement d'avant ce lot
 * (`unreadOnly === 'true'`, tout le reste vaut « non ») et l'app mobile
 * n'envoie jamais que `'true'` ou rien — resserrer ici casserait sans rien
 * gagner.
 *
 * Exporté pour `notifications-pagination.integration.test.ts` : les tests de
 * ce fichier appellent `list()` directement, hors du pipeline HTTP de Nest où
 * `zodQuery` s'appliquerait — sans cet export, rien ne prouverait que `limit`
 * est réellement borné à 100 (`AdminBrowseService.payments()` a la même
 * lacune, documentée mais non couverte, voir `admin-payments-pagination.integration.test.ts`).
 */
export const notificationsQuerySchema = z.object({
  unreadOnly: z.string().optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Extension de `NotificationListDto` (`@try/contracts`) : `nextCursor` et
 * `total` suivent le même contrat que `GET /v1/admin/payments`, mais ce
 * couple n'existe pas encore côté `notificationListSchema` — signalé à
 * `contracts-guardian`. En attendant, le type vit ici, dans le seul
 * consommateur qui l'écrit ; le JSON qu'il décrit reste un sur-ensemble
 * rétrocompatible de l'ancien (voir le commentaire sur `list` ci-dessous).
 */
export interface PaginatedNotificationListDto extends NotificationListDto {
  /** Curseur opaque vers la page suivante, `null` s'il n'y en a pas. */
  nextCursor: string | null;
  /** Total de lignes correspondant au filtre `unreadOnly`, indépendant de la page courante. */
  total: number;
}

/**
 * Centre de notifications de l'utilisateur.
 *
 * Chaque requête est bornée à `user.id` pris du jeton, jamais à un identifiant
 * fourni par le client : une notification contient le nom du lieu et l'horaire
 * d'une personne, et une liste « donne-moi les notifications de l'utilisateur X »
 * serait une fuite de données de fréquentation.
 */
@ApiTags('notifications')
@Controller({ path: 'notifications', version: '1' })
export class NotificationController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Sans paramètre — le seul appel que fait l'app mobile aujourd'hui
   * (`NotificationBell`, `notifications.tsx`) — le comportement reste
   * strictement celui d'avant ce lot : les 50 notifications les plus
   * récentes, `unreadCount` global. `nextCursor`/`total` s'ajoutent au JSON
   * sans rien retirer ; le client mobile ne lit que `items`/`unreadCount` et
   * ignore le reste, aucune app installée ne peut donc casser sur ce
   * changement.
   */
  @Get()
  @ApiOperation({ summary: 'Notifications, newest first, with unread count and keyset pagination' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    // Valeur par défaut, pas seulement un paramètre requis : un appelant qui
    // construit ce contrôleur directement (comme le fait
    // `reminders.integration.test.ts`, en dehors du pipeline HTTP de Nest où
    // `zodQuery` s'appliquerait automatiquement) doit obtenir le même
    // comportement par défaut qu'avant ce lot, pas une exception.
    @Query(zodQuery(notificationsQuerySchema))
    query: z.infer<typeof notificationsQuerySchema> = notificationsQuerySchema.parse({}),
  ): Promise<PaginatedNotificationListDto> {
    const onlyUnread = query.unreadOnly === 'true';
    const baseCondition = onlyUnread
      ? and(eq(schema.notifications.userId, user.id), isNull(schema.notifications.readAt))
      : eq(schema.notifications.userId, user.id);

    // Curseur invalide ou mal formé : dégrade en silence vers la première
    // page, comme `AdminBrowseService.payments()` — un lien copié-collé de
    // travers ne doit pas rendre un 400, juste recommencer au début.
    const decoded = query.cursor ? decodeCursor(query.cursor) : null;
    const cursor =
      decoded && typeof decoded.sortValue === 'string'
        ? { at: new Date(decoded.sortValue), id: decoded.id }
        : null;
    // Keyset sur (created_at, id) DESC, pas un OFFSET — même raisonnement
    // que `AdminBrowseService.payments()` : une notification insérée pendant
    // qu'un utilisateur feuillette ne doit ni décaler ni dupliquer les pages
    // suivantes.
    const cursorCondition = cursor
      ? or(
          lt(schema.notifications.createdAt, cursor.at),
          and(eq(schema.notifications.createdAt, cursor.at), lt(schema.notifications.id, cursor.id)),
        )
      : undefined;

    const [rows, totalRows, unreadRows] = await Promise.all([
      this.db
        .select({
          id: schema.notifications.id,
          type: schema.notifications.type,
          title: schema.notifications.title,
          body: schema.notifications.body,
          deepLink: schema.notifications.deepLink,
          readAt: schema.notifications.readAt,
          createdAt: schema.notifications.createdAt,
        })
        .from(schema.notifications)
        .where(and(baseCondition, cursorCondition))
        .orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id))
        // Une ligne de plus que demandé : révèle une page suivante sans
        // second aller-retour, comme `AdminBrowseService.payments()`.
        .limit(query.limit + 1),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.notifications)
        .where(baseCondition),
      // Toujours global, jamais filtré par `unreadOnly` : c'est la pastille,
      // pas le compte de la page — voir le commentaire sur `unreadCount`
      // dans `notificationListSchema` (`@try/contracts`).
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.notifications)
        .where(and(eq(schema.notifications.userId, user.id), isNull(schema.notifications.readAt))),
    ]);

    const page = buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: row.id,
    }));

    // Le schéma est appliqué, pas seulement déclaré : il garantit qu'une colonne
    // ajoutée un jour à la table n'est pas renvoyée par inadvertance à un
    // téléphone. Il ne convertit rien, en revanche — les dates sont mises au
    // format ISO ici, parce que Drizzle rend des objets `Date` et que le contrat
    // promet des chaînes. C'est ce parse qui l'a signalé plutôt que de laisser
    // passer une sérialisation implicite qui aurait varié selon l'appelant.
    const parsed = notificationListSchema.parse({
      items: page.items.map((item) => ({
        ...item,
        readAt: item.readAt?.toISOString() ?? null,
        createdAt: item.createdAt.toISOString(),
      })),
      unreadCount: unreadRows[0]?.count ?? 0,
    });

    return { ...parsed, nextCursor: page.nextCursor, total: totalRows[0]?.count ?? 0 };
  }

  /**
   * Marque une notification comme lue.
   *
   * Le `WHERE` porte aussi sur `user_id` : sans ça, connaître l'identifiant d'une
   * notification suffirait à la marquer lue chez quelqu'un d'autre. Un identifiant
   * n'est pas une autorisation.
   */
  @Post(':id/read')
  async markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ ok: boolean }> {
    const updated = await this.db
      .update(schema.notifications)
      .set({ readAt: this.clock.now() })
      .where(
        and(
          eq(schema.notifications.id, id),
          eq(schema.notifications.userId, user.id),
          isNull(schema.notifications.readAt),
        ),
      )
      .returning({ id: schema.notifications.id });

    // Déjà lue ou inexistante : même réponse. Distinguer les deux dirait à un
    // curieux si un identifiant existe.
    return { ok: updated.length > 0 };
  }

  @Post('read-all')
  async markAllRead(@CurrentUser() user: AuthenticatedUser): Promise<{ updated: number }> {
    const updated = await this.db
      .update(schema.notifications)
      .set({ readAt: this.clock.now() })
      .where(and(eq(schema.notifications.userId, user.id), isNull(schema.notifications.readAt)))
      .returning({ id: schema.notifications.id });

    return { updated: updated.length };
  }
}
