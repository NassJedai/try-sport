import { Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { notificationListSchema, type NotificationListDto } from '@try/contracts';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { Clock } from '@try/utils';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user.js';

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

  @Get()
  @ApiOperation({ summary: 'Notifications, newest first, with unread count' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('unreadOnly') unreadOnly?: string,
  ): Promise<NotificationListDto> {
    const onlyUnread = unreadOnly === 'true';

    const items = await this.db
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
      .where(
        onlyUnread
          ? and(eq(schema.notifications.userId, user.id), isNull(schema.notifications.readAt))
          : eq(schema.notifications.userId, user.id),
      )
      .orderBy(desc(schema.notifications.createdAt))
      .limit(50);

    const [counted] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, user.id), isNull(schema.notifications.readAt)));

    // Le schéma est appliqué, pas seulement déclaré : c'est lui qui convertit les
    // dates en ISO et qui garantit qu'une colonne ajoutée un jour à la table
    // n'est pas renvoyée par inadvertance à un téléphone.
    return notificationListSchema.parse({ items, unreadCount: counted?.count ?? 0 });
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
