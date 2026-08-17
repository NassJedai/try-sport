import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { Logger } from '@try/logger';
import type { AppConfig } from '@try/config';
import { ReminderService } from '../src/modules/notifications/reminder.service.js';
import {
  NotificationService,
  type EmailMessage,
  type EmailTransport,
} from '../src/modules/notifications/notification.service.js';
import { connect, describeIfDatabase } from './integration-setup.js';

/**
 * Ce que ces tests protègent : un gérant dont le dossier reste incomplet
 * reçoit exactement un rappel à J+1 et un à J+3 — jamais deux fois le même
 * si le job est rejoué — et plus aucun une fois le dossier complété.
 */
describeIfDatabase('relances J+1 / J+3 de dossier incomplet', () => {
  function fakeLogger(): Logger {
    const noop = (): void => undefined;
    const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop };
    return { ...logger, child: () => logger } as unknown as Logger;
  }

  const fakeConfig = { BUSINESS_PUBLIC_URL: 'http://localhost:3001' } as unknown as AppConfig;

  class RecordingTransport implements EmailTransport {
    readonly sent: EmailMessage[] = [];
    send(message: EmailMessage): Promise<void> {
      this.sent.push(message);
      return Promise.resolve();
    }
    to(email: string): EmailMessage[] {
      return this.sent.filter((message) => message.to === email);
    }
  }

  let db: Database;
  let close: () => Promise<void>;

  beforeAll(() => {
    ({ db, close } = connect());
  });

  afterAll(async () => {
    await close();
  });

  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    // Best-effort : une étape qui échoue (contrainte inattendue, ligne déjà
    // repartie) ne doit pas empêcher les suivantes de s'exécuter. Avant ce
    // correctif, une seule étape en échec laissait toutes les précédentes
    // (business_members, businesses, users) orphelines dans `try_dev` — la
    // base partagée par le développement et les tests d'intégration (voir
    // `reference_test_integration_no_dedicated_db`) — au point de faire
    // apparaître un gérant fantôme dans le tableau de bord.
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()!;
      try {
        await cleanup();
      } catch (error) {
        // eslint-disable-next-line no-console -- visibilité en test seulement, jamais en prod
        console.error('venue-submission-reminders: cleanup step failed, continuing', error);
      }
    }
  });

  function buildService(now: Date, transport: RecordingTransport): ReminderService {
    const notifications = new NotificationService(transport, fakeLogger(), fakeConfig);
    return new ReminderService(db, { now: () => now } as never, fakeLogger(), fakeConfig, notifications);
  }

  /** Lieu créé `hoursAgo` heures dans le passé, avec un unique membre OWNER accepté. */
  async function seedIncompleteVenue(
    hoursAgo: number,
    overrides: Partial<typeof schema.venues.$inferInsert> = {},
  ): Promise<{ venueId: string; venueName: string; ownerUserId: string; contactEmail: string }> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const contactEmail = `biz-${suffix}@try.local`;
    const [business] = await db
      .insert(schema.businesses)
      .values({ slug: `biz-${suffix}`, name: `Business ${suffix}`, contactEmail, status: 'ACTIVE', vatNumber: null })
      .returning();
    const [city] = await db.select({ id: schema.cities.id }).from(schema.cities).limit(1);
    const createdAt = new Date(Date.now() - hoursAgo * 3_600_000);
    const [venue] = await db
      .insert(schema.venues)
      .values({
        businessId: business!.id,
        slug: `venue-${suffix}`,
        name: `Venue ${suffix}`,
        status: 'DRAFT',
        description: null, // manque : pas de description
        addressLine: '1 Test Street',
        postalCode: '1000',
        cityId: city!.id,
        latitude: 50.8467,
        longitude: 4.3525,
        createdAt,
        updatedAt: createdAt,
        ...overrides,
      })
      .returning();
    const [user] = await db
      .insert(schema.users)
      .values({ email: `owner-${suffix}@try.local`, role: 'BUSINESS_MEMBER' })
      .returning();
    await db.insert(schema.businessMembers).values({
      businessId: business!.id,
      userId: user!.id,
      role: 'OWNER',
      acceptedAt: createdAt,
    });

    cleanups.push(async () => {
      await db.execute(sql`DELETE FROM notifications WHERE venue_id = ${venue!.id}`);
      await db.execute(sql`DELETE FROM offers WHERE venue_id = ${venue!.id}`);
      await db.execute(sql`DELETE FROM venues WHERE id = ${venue!.id}`);
      await db.execute(sql`DELETE FROM business_members WHERE business_id = ${business!.id}`);
      await db.execute(sql`DELETE FROM businesses WHERE id = ${business!.id}`);
      await db.execute(sql`DELETE FROM users WHERE id = ${user!.id}`);
    });

    return { venueId: venue!.id, venueName: venue!.name, ownerUserId: user!.id, contactEmail };
  }

  async function notificationsFor(venueId: string): Promise<{ type: string; userId: string; deepLink: string | null }[]> {
    return db
      .select({
        type: schema.notifications.type,
        userId: schema.notifications.userId,
        deepLink: schema.notifications.deepLink,
      })
      .from(schema.notifications)
      .where(eq(schema.notifications.venueId, venueId));
  }

  it('envoie la relance J+1 pour un dossier créé il y a 25 h, jamais deux fois si le job est rejoué', async () => {
    const venue = await seedIncompleteVenue(25);
    const now = new Date();
    const transport = new RecordingTransport();
    const service = buildService(now, transport);

    await service.sendDueVenueCompletionReminders();
    // Le rejeu est le cas réel : redémarrage en plein tour, deuxième instance
    // d'API, fenêtre qui recouvre le tour précédent.
    await service.sendDueVenueCompletionReminders();

    expect(transport.to(venue.contactEmail)).toHaveLength(1);

    const rows = await notificationsFor(venue.venueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('VENUE_SUBMISSION_REMINDER_J1');
    expect(rows[0]!.userId).toBe(venue.ownerUserId);
    expect(rows[0]!.deepLink).toBe(`http://localhost:3001/onboarding?venueId=${venue.venueId}`);
  });

  it('envoie la relance J+3 pour un dossier créé il y a 73 h', async () => {
    const venue = await seedIncompleteVenue(73);
    const now = new Date();
    const transport = new RecordingTransport();
    const service = buildService(now, transport);

    await service.sendDueVenueCompletionReminders();

    expect(transport.to(venue.contactEmail)).toHaveLength(1);
    const rows = await notificationsFor(venue.venueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('VENUE_SUBMISSION_REMINDER_J3');
  });

  it("ne relance pas un dossier créé il y a 25 h qui n'entre pas encore dans la fenêtre J+1 (10 h)", async () => {
    const venue = await seedIncompleteVenue(10);
    const now = new Date();
    const transport = new RecordingTransport();
    const service = buildService(now, transport);

    await service.sendDueVenueCompletionReminders();

    expect(transport.to(venue.contactEmail)).toHaveLength(0);
    expect(await notificationsFor(venue.venueId)).toHaveLength(0);
  });

  it('un dossier complété avant J+1 ne reçoit plus aucune relance', async () => {
    const category = (
      await db.insert(schema.categories).values({ slug: `cat-${Math.random().toString(36).slice(2, 10)}`, name: 'Cat' }).returning()
    )[0]!;
    const venue = await seedIncompleteVenue(25, { description: 'Une description bien assez longue pour passer la validation.' });
    cleanups.push(async () => {
      // Auto-suffisant plutôt que dépendant de l'ordre : le cleanup de
      // `seedIncompleteVenue` supprime déjà les offres du lieu, mais l'ordre
      // LIFO des `cleanups` le ferait tourner APRÈS celui-ci si on ne
      // supprimait pas l'offre ici aussi — la FK `offers_category_id_fk`
      // refuserait alors la suppression de la catégorie.
      await db.execute(sql`DELETE FROM offers WHERE category_id = ${category.id}`);
      await db.execute(sql`DELETE FROM categories WHERE id = ${category.id}`);
    });
    const [business] = await db
      .select({ businessId: schema.venues.businessId, vatNumber: sql<string | null>`null` })
      .from(schema.venues)
      .where(eq(schema.venues.id, venue.venueId));

    // Complète le dossier : offre, photo, TVA valide.
    await db.insert(schema.offers).values({
      venueId: venue.venueId,
      businessId: business!.businessId,
      categoryId: category.id,
      title: 'Essai découverte',
      description: 'Une offre de test suffisamment longue pour passer la validation Zod.',
      status: 'DRAFT',
      experienceType: 'FREE_TRIAL',
      priceAmount: 0,
      durationMinutes: 60,
      capacity: 10,
      trialRule: 'NO_RESTRICTION',
    });
    await db.insert(schema.venueImages).values({
      venueId: venue.venueId,
      storageKey: `test/${Math.random().toString(36).slice(2)}.jpg`,
      role: 'GALLERY',
      width: 800,
      height: 600,
    });
    await db
      .update(schema.businesses)
      .set({ vatNumber: 'BE0417497106' })
      .where(eq(schema.businesses.id, business!.businessId));

    const now = new Date();
    const transport = new RecordingTransport();
    const service = buildService(now, transport);

    await service.sendDueVenueCompletionReminders();

    expect(transport.to(venue.contactEmail)).toHaveLength(0);
    expect(await notificationsFor(venue.venueId)).toHaveLength(0);
  });
});
