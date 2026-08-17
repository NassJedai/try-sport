import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { Clock } from '@try/utils';
import type { Logger } from '@try/logger';
import type { AppConfig } from '@try/config';
import { AuditService } from '../src/modules/admin/audit.service.js';
import { ModerationService } from '../src/modules/admin/moderation.service.js';
import { DomainEvents } from '../src/modules/events/domain-events.js';
import { ModerationLifecycleListener } from '../src/modules/events/moderation-lifecycle.listener.js';
import {
  NotificationService,
  type EmailMessage,
  type EmailTransport,
} from '../src/modules/notifications/notification.service.js';
import { OnboardingService } from '../src/modules/business/onboarding.service.js';
import type { AuthenticatedUser } from '../src/common/auth/current-user.js';
import { connect, describeIfDatabase, waitFor } from './integration-setup.js';

/**
 * Ce que ces tests protègent : une décision de modération (lot 2 de
 * l'inscription autonome) prévient bien tout le monde, avec le bon contenu —
 * et une modification d'identité sur un lieu déjà en ligne alerte l'admin
 * avec de quoi agir, pas juste « quelque chose a changé ».
 */
describeIfDatabase('cycle de vie de la modération', () => {
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
  const clock: Clock = { now: () => new Date() };

  beforeAll(() => {
    ({ db, close } = connect());
  });

  afterAll(async () => {
    await close();
  });

  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  /**
   * `AuditService` écrit réellement dans `audit_logs`, dont `actor_id` porte
   * une FK vers `users` — un id inventé ferait échouer l'insert, pas la
   * décision de modération elle-même.
   */
  async function seedAdminUser(): Promise<{ id: string }> {
    const [row] = await db
      .insert(schema.users)
      .values({ email: `admin-${Math.random().toString(36).slice(2)}@try.local`, role: 'SUPER_ADMIN' })
      .returning();
    return { id: row!.id };
  }

  function adminActorFor(userId: string): AuthenticatedUser {
    return { id: userId, email: 'admin@try.local', role: 'SUPER_ADMIN', memberships: [] };
  }

  function actorFor(businessId: string, userId: string): AuthenticatedUser {
    return { id: userId, email: 'manager@try.local', role: 'BUSINESS_MEMBER', memberships: [{ businessId, role: 'MANAGER' }] };
  }

  /**
   * Une entreprise avec quatre profils de membre : c'est exactement ce qui
   * distingue « prévenu » de « pas prévenu ». Seuls owner/manager comptent
   * dans `decisionRecipients` ; staff et l'invitation non acceptée ne
   * doivent jamais recevoir de ligne.
   */
  async function seedBusinessWithMembers(): Promise<{
    businessId: string;
    contactEmail: string;
    ownerUserId: string;
    managerUserId: string;
    staffUserId: string;
    pendingOwnerUserId: string;
  }> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const contactEmail = `biz-${suffix}@try.local`;
    const [business] = await db
      .insert(schema.businesses)
      .values({ slug: `biz-${suffix}`, name: `Business ${suffix}`, contactEmail, status: 'ACTIVE' })
      .returning();

    async function seedUser(role: 'OWNER' | 'MANAGER' | 'STAFF', accepted: boolean): Promise<string> {
      const [user] = await db
        .insert(schema.users)
        .values({ email: `member-${Math.random().toString(36).slice(2)}@try.local`, role: 'BUSINESS_MEMBER' })
        .returning();
      await db.insert(schema.businessMembers).values({
        businessId: business!.id,
        userId: user!.id,
        role,
        acceptedAt: accepted ? new Date() : null,
      });
      return user!.id;
    }

    const ownerUserId = await seedUser('OWNER', true);
    const managerUserId = await seedUser('MANAGER', true);
    const staffUserId = await seedUser('STAFF', true);
    const pendingOwnerUserId = await seedUser('OWNER', false);

    return { businessId: business!.id, contactEmail, ownerUserId, managerUserId, staffUserId, pendingOwnerUserId };
  }

  async function seedVenue(
    businessId: string,
    overrides: Partial<typeof schema.venues.$inferInsert> = {},
  ): Promise<{ id: string; name: string }> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [city] = await db.select({ id: schema.cities.id }).from(schema.cities).limit(1);
    const [row] = await db
      .insert(schema.venues)
      .values({
        businessId,
        slug: `venue-${suffix}`,
        name: `Venue ${suffix}`,
        status: 'PENDING_APPROVAL',
        addressLine: '1 Test Street',
        postalCode: '1000',
        cityId: city!.id,
        latitude: 50.8467,
        longitude: 4.3525,
        ...overrides,
      })
      .returning();
    return { id: row!.id, name: row!.name };
  }

  async function seedCategory(): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [row] = await db
      .insert(schema.categories)
      .values({ slug: `cat-${suffix}`, name: 'Test Category' })
      .returning();
    return row!.id;
  }

  async function seedOffer(
    venueId: string,
    businessId: string,
    categoryId: string,
    overrides: Partial<typeof schema.offers.$inferInsert> = {},
  ): Promise<{ id: string; title: string }> {
    const [row] = await db
      .insert(schema.offers)
      .values({
        venueId,
        businessId,
        categoryId,
        title: 'Essai découverte',
        description: 'Une offre de test suffisamment longue pour passer la validation Zod.',
        status: 'PENDING_APPROVAL',
        experienceType: 'FREE_TRIAL',
        priceAmount: 0,
        durationMinutes: 60,
        capacity: 10,
        trialRule: 'NO_RESTRICTION',
        ...overrides,
      })
      .returning();
    return { id: row!.id, title: row!.title };
  }

  function pushCleanup(input: {
    businessId: string;
    venueId?: string;
    offerId?: string;
    categoryId?: string;
    userIds?: string[];
  }): void {
    cleanups.push(async () => {
      if (input.offerId) await db.execute(sql`DELETE FROM offers WHERE id = ${input.offerId}`);
      if (input.venueId) {
        await db.execute(sql`DELETE FROM notifications WHERE venue_id = ${input.venueId}`);
        await db.execute(sql`DELETE FROM offers WHERE venue_id = ${input.venueId}`);
        await db.execute(sql`DELETE FROM venues WHERE id = ${input.venueId}`);
      }
      if (input.userIds) {
        for (const userId of input.userIds) {
          await db.execute(sql`DELETE FROM notifications WHERE user_id = ${userId}`);
        }
      }
      await db.execute(sql`DELETE FROM business_members WHERE business_id = ${input.businessId}`);
      await db.execute(sql`DELETE FROM businesses WHERE id = ${input.businessId}`);
      if (input.categoryId) await db.execute(sql`DELETE FROM categories WHERE id = ${input.categoryId}`);
      if (input.userIds) {
        for (const userId of input.userIds) {
          await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
        }
      }
    });
  }

  function wire(): {
    moderation: ModerationService;
    transport: RecordingTransport;
  } {
    const events = new DomainEvents(fakeLogger());
    const audit = new AuditService(db);
    const moderation = new ModerationService(db, clock, fakeLogger(), audit, events);
    const transport = new RecordingTransport();
    const notifications = new NotificationService(transport, fakeLogger(), fakeConfig);
    const listener = new ModerationLifecycleListener(events, notifications, db, fakeConfig, fakeLogger());
    listener.onModuleInit();
    return { moderation, transport };
  }

  async function notificationsFor(userId: string): Promise<{ type: string; body: string; deepLink: string | null }[]> {
    return db
      .select({ type: schema.notifications.type, body: schema.notifications.body, deepLink: schema.notifications.deepLink })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId));
  }

  it(
    "approbation d'un lieu → événement émis après le commit, une notification pour owner et manager " +
      'seulement (pas staff, pas invitation en attente), e-mail parti sur contactEmail',
    async () => {
      const biz = await seedBusinessWithMembers();
      const venue = await seedVenue(biz.businessId);
      const admin = await seedAdminUser();
      pushCleanup({
        businessId: biz.businessId,
        venueId: venue.id,
        userIds: [biz.ownerUserId, biz.managerUserId, biz.staffUserId, biz.pendingOwnerUserId, admin.id],
      });

      const { moderation, transport } = wire();

      const result = await moderation.decideVenue({
        actor: adminActorFor(admin.id),
        venueId: venue.id,
        decision: 'APPROVE',
      });
      expect(result.status).toBe('ACTIVE');

      // La ligne en base existe forcément déjà : `decideVenue` a committé
      // avant de renvoyer. Ce qu'on attend, c'est le travail de l'écouteur,
      // qui part après — d'où le sondage plutôt qu'une lecture immédiate.
      await waitFor(async () => (await notificationsFor(biz.ownerUserId)).length > 0);

      const [ownerNotifs, managerNotifs, staffNotifs, pendingNotifs] = await Promise.all([
        notificationsFor(biz.ownerUserId),
        notificationsFor(biz.managerUserId),
        notificationsFor(biz.staffUserId),
        notificationsFor(biz.pendingOwnerUserId),
      ]);

      expect(ownerNotifs).toHaveLength(1);
      expect(managerNotifs).toHaveLength(1);
      expect(staffNotifs).toHaveLength(0);
      expect(pendingNotifs).toHaveLength(0);
      expect(ownerNotifs[0]!.type).toBe('VENUE_MODERATION_APPROVE');

      await waitFor(async () => transport.to(biz.contactEmail).length > 0);
      const mail = transport.to(biz.contactEmail);
      expect(mail).toHaveLength(1);
      expect(mail[0]!.subject).toContain(venue.name);
    },
  );

  it(
    'refus → le motif figure tel quel dans l\x27e-mail et dans la notification, avec le lien direct ' +
      "vers l'écran de correction",
    async () => {
      const biz = await seedBusinessWithMembers();
      const venue = await seedVenue(biz.businessId);
      const admin = await seedAdminUser();
      pushCleanup({
        businessId: biz.businessId,
        venueId: venue.id,
        userIds: [biz.ownerUserId, biz.managerUserId, biz.staffUserId, biz.pendingOwnerUserId, admin.id],
      });

      const { moderation, transport } = wire();
      const reason = 'Les photos fournies sont floues, merci de les remplacer.';

      await moderation.decideVenue({
        actor: adminActorFor(admin.id),
        venueId: venue.id,
        decision: 'REJECT',
        reason,
      });

      const expectedLink = `http://localhost:3001/onboarding?venueId=${venue.id}`;

      await waitFor(async () => transport.to(biz.contactEmail).length > 0);
      const mail = transport.to(biz.contactEmail)[0]!;
      expect(mail.body).toContain(reason);
      expect(mail.body).toContain(expectedLink);

      await waitFor(async () => (await notificationsFor(biz.ownerUserId)).length > 0);
      const [ownerNotif] = await notificationsFor(biz.ownerUserId);
      expect(ownerNotif!.body).toBe(reason);
      expect(ownerNotif!.deepLink).toBe(expectedLink);
    },
  );

  it(
    "décision sur une offre → même comportement : événement après commit, notification par membre, " +
      "e-mail avec motif et lien de correction sur un refus",
    async () => {
      const biz = await seedBusinessWithMembers();
      // L'offre doit pouvoir être approuvée : son lieu est déjà ACTIVE.
      const venue = await seedVenue(biz.businessId, { status: 'ACTIVE' });
      const categoryId = await seedCategory();
      const offer = await seedOffer(venue.id, biz.businessId, categoryId);
      const admin = await seedAdminUser();
      pushCleanup({
        businessId: biz.businessId,
        venueId: venue.id,
        offerId: offer.id,
        categoryId,
        userIds: [biz.ownerUserId, biz.managerUserId, biz.staffUserId, biz.pendingOwnerUserId, admin.id],
      });

      const { moderation, transport } = wire();
      const reason = 'Le descriptif ne correspond pas à la séance proposée.';

      await moderation.decideOffer({
        actor: adminActorFor(admin.id),
        offerId: offer.id,
        decision: 'REJECT',
        reason,
      });

      const expectedLink = `http://localhost:3001/offers?offerId=${offer.id}`;

      await waitFor(async () => transport.to(biz.contactEmail).length > 0);
      const mail = transport.to(biz.contactEmail)[0]!;
      expect(mail.body).toContain(reason);
      expect(mail.body).toContain(expectedLink);
      expect(mail.subject).toContain(offer.title);

      await waitFor(async () => (await notificationsFor(biz.managerUserId)).length > 0);
      const [managerNotif] = await notificationsFor(biz.managerUserId);
      expect(managerNotif!.type).toBe('OFFER_MODERATION_REJECT');
      expect(managerNotif!.body).toBe(reason);
    },
  );

  it(
    "modification d'identité sur un lieu déjà en ligne → alerte admin en application, avec l'ancienne " +
      'et la nouvelle valeur de chaque champ modifié',
    async () => {
      const biz = await seedBusinessWithMembers();
      const venue = await seedVenue(biz.businessId, {
        status: 'ACTIVE',
        name: 'Ancien Nom',
        addressLine: 'Ancienne Adresse 1',
      });
      const [admin] = await db
        .insert(schema.users)
        .values({ email: `admin-${Math.random().toString(36).slice(2)}@try.local`, role: 'ADMIN' })
        .returning();
      pushCleanup({
        businessId: biz.businessId,
        venueId: venue.id,
        userIds: [biz.ownerUserId, biz.managerUserId, biz.staffUserId, biz.pendingOwnerUserId, admin!.id],
      });

      const events = new DomainEvents(fakeLogger());
      const audit = new AuditService(db);
      const onboarding = new OnboardingService(db, clock, audit, events);
      const transport = new RecordingTransport();
      const notifications = new NotificationService(transport, fakeLogger(), fakeConfig);
      const listener = new ModerationLifecycleListener(events, notifications, db, fakeConfig, fakeLogger());
      listener.onModuleInit();

      await onboarding.updateVenue({
        actor: actorFor(biz.businessId, biz.managerUserId),
        venueId: venue.id,
        dto: { name: 'Nouveau Nom', addressLine: 'Nouvelle Adresse 2' },
      });

      await waitFor(async () => (await notificationsFor(admin!.id)).length > 0);
      const [alert] = await notificationsFor(admin!.id);

      expect(alert!.type).toBe('VENUE_IDENTITY_CHANGED');
      expect(alert!.body).toContain('Nom : « Ancien Nom » → « Nouveau Nom »');
      expect(alert!.body).toContain('Adresse : « Ancienne Adresse 1 » → « Nouvelle Adresse 2 »');

      // Le membre qui a fait la modification n'a pas à s'auto-notifier.
      const managerNotifs = await notificationsFor(biz.managerUserId);
      expect(managerNotifs.filter((n) => n.type === 'VENUE_IDENTITY_CHANGED')).toHaveLength(0);
    },
  );
});
