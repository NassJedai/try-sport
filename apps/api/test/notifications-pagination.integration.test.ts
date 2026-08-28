import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import {
  NotificationController,
  notificationsQuerySchema,
} from '../src/modules/notifications/notification.controller.js';
import { connect, createTestUser, describeIfDatabase } from './integration-setup.js';

/**
 * Reproduit et corrige le defaut signale par le verificateur du lot
 * « edition d'une offre en ligne » (2026-08-28) : la pagination
 * `cursor`/`limit` ajoutee a `GET /v1/notifications`
 * (`notification.controller.ts`) n'avait aucun test committe — la seule
 * preuve etait un test jetable, execute puis supprime, qui ne protege rien
 * contre une regression future.
 *
 * Calque sur `admin-payments-pagination.integration.test.ts`, le meme
 * curseur keyset opaque (`@try/utils#decodeCursor`/`buildCursorPage`) que
 * `AdminBrowseService.payments()`.
 */

const MAX_LIMIT = 100;

describeIfDatabase('NotificationController.list — pagination par curseur', () => {
  let db: Database;
  let close: () => Promise<void>;
  let controller: NotificationController;

  const pending: Array<() => Promise<void>> = [];

  beforeAll(() => {
    ({ db, close } = connect());
    controller = new NotificationController(db, { now: () => new Date() } as never);
  });

  afterEach(async () => {
    while (pending.length > 0) {
      await pending.pop()!();
    }
  });

  afterAll(async () => {
    await close();
  });

  /**
   * Insere `count` notifications distinctes pour un seul utilisateur,
   * `createdAt` explicitement espace d'une seconde entre chacune : c'est
   * l'ordre que la pagination doit respecter, et le seul moyen de le
   * controler sans dependre de l'horloge reelle entre deux inserts.
   */
  async function seedNotifications(
    userId: string,
    count: number,
    options: { readEvery?: number; startAt?: Date } = {},
  ): Promise<{ ids: string[] }> {
    const t0 = options.startAt ?? new Date();
    const rows = await db
      .insert(schema.notifications)
      .values(
        Array.from({ length: count }, (_, index) => ({
          userId,
          type: 'TEST_NOTIFICATION',
          title: `Notification ${index}`,
          body: `Corps ${index}`,
          deepLink: null,
          createdAt: new Date(t0.getTime() + index * 1000),
          readAt:
            options.readEvery && (index + 1) % options.readEvery === 0
              ? new Date(t0.getTime() + index * 1000)
              : null,
        })),
      )
      .returning({ id: schema.notifications.id });

    const ids = rows.map((row) => row.id);
    pending.push(async () => {
      await db.delete(schema.notifications).where(inArray(schema.notifications.id, ids));
    });

    return { ids };
  }

  it('sans parametre, rend les 50 plus recentes avec le compte non lu global, comme avant ce lot', async () => {
    const user = await createTestUser(db);
    pending.push(async () => {
      await db.delete(schema.users).where(inArray(schema.users.id, [user.id]));
    });

    const seed = await seedNotifications(user.id, 65, { readEvery: 5 });

    const page = await controller.list({ id: user.id } as never);

    expect(page.items).toHaveLength(50);
    // Plus recentes d'abord : le dernier index insere est le premier rendu.
    expect(page.items[0]!.title).toBe('Notification 64');
    expect(page.items[49]!.title).toBe('Notification 15');
    // Forme de reponse inchangee : items/unreadCount toujours presents, la
    // page mobile ne lit que ceux-la.
    expect(typeof page.unreadCount).toBe('number');
    expect(page.unreadCount).toBe(65 - Math.floor(65 / 5));
    // Extensions ajoutees par ce lot, en plus, jamais a la place.
    expect(page.total).toBe(65);
    expect(page.nextCursor).not.toBeNull();
    expect(seed.ids).toHaveLength(65);
  });

  it('le curseur traverse toutes les pages sans doublon ni trou, deuxieme page = le reste exact', async () => {
    const user = await createTestUser(db);
    pending.push(async () => {
      await db.delete(schema.users).where(inArray(schema.users.id, [user.id]));
    });

    const TOTAL = 62;
    const seed = await seedNotifications(user.id, TOTAL);

    const firstPage = await controller.list(
      { id: user.id } as never,
      notificationsQuerySchema.parse({ limit: '50' }),
    );
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.total).toBe(TOTAL);

    const secondPage = await controller.list(
      { id: user.id } as never,
      notificationsQuerySchema.parse({ limit: '50', cursor: firstPage.nextCursor! }),
    );
    expect(secondPage.items).toHaveLength(TOTAL - 50);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.total).toBe(TOTAL);

    const firstIds = firstPage.items.map((item) => item.id);
    const secondIds = secondPage.items.map((item) => item.id);
    // Pas de chevauchement entre les deux pages.
    expect(firstIds.filter((id) => secondIds.includes(id))).toHaveLength(0);
    // Pas de trou : l'union des deux pages couvre exactement les lignes semees.
    const collected = new Set([...firstIds, ...secondIds]);
    expect(collected.size).toBe(TOTAL);
    for (const id of seed.ids) {
      expect(collected.has(id)).toBe(true);
    }
  });

  /**
   * Le controleur lui-meme ne borne rien — comme `AdminBrowseService.payments()`
   * (voir le commentaire sur `MAX_ADMIN_PAGE` dans le fichier modele), c'est
   * `zodQuery(notificationsQuerySchema)` qui applique la limite a la
   * frontiere HTTP, avant que `list()` ne soit meme appele. Appeler
   * `controller.list()` directement pour un `limit` hors bornes ne prouverait
   * donc rien : c'est le schema qu'il faut interroger.
   */
  it('`limit` est borne a 100 : le schema HTTP rejette toute valeur superieure, la valeur par defaut reste 50', () => {
    expect(() => notificationsQuerySchema.parse({ limit: '1000' })).toThrow();
    expect(() => notificationsQuerySchema.parse({ limit: '0' })).toThrow();
    expect(notificationsQuerySchema.parse({ limit: String(MAX_LIMIT) }).limit).toBe(MAX_LIMIT);
    expect(notificationsQuerySchema.parse({}).limit).toBe(50);
  });

  it('a `limit` maximal (100), la page rend bien 100 lignes sur un total qui en compte davantage', async () => {
    const user = await createTestUser(db);
    pending.push(async () => {
      await db.delete(schema.users).where(inArray(schema.users.id, [user.id]));
    });

    await seedNotifications(user.id, MAX_LIMIT + 20);

    const parsed = notificationsQuerySchema.parse({ limit: String(MAX_LIMIT) });
    const page = await controller.list({ id: user.id } as never, parsed);

    expect(page.items).toHaveLength(MAX_LIMIT);
    expect(page.total).toBe(MAX_LIMIT + 20);
    expect(page.nextCursor).not.toBeNull();
  });

  it('un curseur invalide degrade en silence vers la premiere page, jamais une erreur', async () => {
    const user = await createTestUser(db);
    pending.push(async () => {
      await db.delete(schema.users).where(inArray(schema.users.id, [user.id]));
    });

    await seedNotifications(user.id, 5);

    const page = await controller.list(
      { id: user.id } as never,
      notificationsQuerySchema.parse({ cursor: 'ceci-nest-pas-un-curseur-valide' }),
    );

    expect(page.items).toHaveLength(5);
    expect(page.total).toBe(5);
  });

  it('`unreadCount` reste global, jamais affecte par `unreadOnly` ni par la page courante', async () => {
    const user = await createTestUser(db);
    pending.push(async () => {
      await db.delete(schema.users).where(inArray(schema.users.id, [user.id]));
    });

    // 10 non lues, 10 lues.
    await seedNotifications(user.id, 20, { readEvery: 2 });

    const all = await controller.list({ id: user.id } as never);
    const unreadOnly = await controller.list(
      { id: user.id } as never,
      notificationsQuerySchema.parse({ unreadOnly: 'true', limit: '3' }),
    );

    expect(all.unreadCount).toBe(10);
    expect(unreadOnly.unreadCount).toBe(10);
    // Le total, lui, suit bien le filtre — seul `unreadCount` reste global.
    expect(unreadOnly.total).toBe(10);
    expect(unreadOnly.items).toHaveLength(3);
  });
});
