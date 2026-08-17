import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Clock } from '@try/utils';
import type { Logger } from '@try/logger';
import { InvalidModerationTransitionError } from '@try/contracts';
import { AuditService } from '../src/modules/admin/audit.service.js';
import { DomainEvents } from '../src/modules/events/domain-events.js';
import { BusinessService } from '../src/modules/business/business.service.js';
import { OnboardingService } from '../src/modules/business/onboarding.service.js';
import type { AuthenticatedUser } from '../src/common/auth/current-user.js';
import { connect, createTestUser, describeIfDatabase } from './integration-setup.js';

/**
 * Lot 1 de l'inscription autonome : l'endpoint qui fermait le trou principal
 * (un lieu `DRAFT` sans offre était irrécupérable), les PATCH de lieu/offre
 * qui ne doivent effacer que ce qu'on leur demande, la revalidation du prix
 * de référence sur les valeurs stockées, la porte de soumission qui liste ce
 * qui manque, et le titre d'une offre qui suit le nom de sa salle.
 */
describeIfDatabase('inscription autonome — édition et soumission', () => {
  function fakeLogger(): Logger {
    const noop = (): void => undefined;
    const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop };
    return { ...logger, child: () => logger } as unknown as Logger;
  }

  let db: ReturnType<typeof connect>['db'];
  let close: ReturnType<typeof connect>['close'];
  let events: DomainEvents;
  let business: BusinessService;
  let onboarding: OnboardingService;
  let actorUserId: string;
  const clock: Clock = { now: () => new Date() };

  beforeAll(async () => {
    ({ db, close } = connect());
    events = new DomainEvents(fakeLogger());
    const audit = new AuditService(db);
    business = new BusinessService(db, clock, audit, events);
    onboarding = new OnboardingService(db, clock, audit, events);

    const actor = await createTestUser(db);
    actorUserId = actor.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM audit_logs WHERE actor_id = ${actorUserId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${actorUserId}`);
    await close();
  });

  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  function actorFor(businessId: string): AuthenticatedUser {
    return {
      id: actorUserId,
      email: 'manager@try.local',
      role: 'BUSINESS_MEMBER',
      memberships: [{ businessId, role: 'MANAGER' }],
    };
  }

  async function seedBusiness(overrides: Partial<typeof schema.businesses.$inferInsert> = {}) {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [row] = await db
      .insert(schema.businesses)
      .values({
        slug: `biz-${suffix}`,
        name: `Business ${suffix}`,
        contactEmail: `biz-${suffix}@try.local`,
        status: 'ACTIVE',
        vatNumber: null,
        ...overrides,
      })
      .returning();
    return row!;
  }

  async function seedVenue(
    businessId: string,
    overrides: Partial<typeof schema.venues.$inferInsert> = {},
  ) {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [city] = await db.select({ id: schema.cities.id }).from(schema.cities).limit(1);

    const [row] = await db
      .insert(schema.venues)
      .values({
        businessId,
        slug: `venue-${suffix}`,
        name: `Venue ${suffix}`,
        status: 'DRAFT',
        addressLine: '1 Test Street',
        postalCode: '1000',
        cityId: city!.id,
        latitude: 50.8467,
        longitude: 4.3525,
        amenities: ['wifi', 'parking'],
        languages: ['fr'],
        openingHours: [{ dayOfWeek: 1, opensAt: '09:00', closesAt: '18:00' }],
        phone: '+32499990000',
        ...overrides,
      })
      .returning();
    return row!;
  }

  async function seedCategory() {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [row] = await db
      .insert(schema.categories)
      .values({ slug: `cat-${suffix}`, name: 'Test Category' })
      .returning();
    return row!;
  }

  async function seedOffer(
    venueId: string,
    businessId: string,
    categoryId: string,
    overrides: Partial<typeof schema.offers.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(schema.offers)
      .values({
        venueId,
        businessId,
        categoryId,
        title: 'Essai découverte',
        description: 'Une offre de test suffisamment longue pour passer la validation Zod.',
        status: 'DRAFT',
        experienceType: 'FREE_TRIAL',
        priceAmount: 0,
        durationMinutes: 60,
        capacity: 10,
        trialRule: 'NO_RESTRICTION',
        ...overrides,
      })
      .returning();
    return row!;
  }

  async function cleanupGraph(input: {
    businessId: string;
    venueId?: string;
    offerId?: string;
    categoryId?: string;
  }): Promise<void> {
    if (input.offerId) {
      await db.execute(sql`DELETE FROM offers WHERE id = ${input.offerId}`);
    }
    if (input.venueId) {
      await db.execute(sql`DELETE FROM offers WHERE venue_id = ${input.venueId}`);
      await db.execute(sql`DELETE FROM venue_images WHERE venue_id = ${input.venueId}`);
      await db.execute(sql`DELETE FROM venue_categories WHERE venue_id = ${input.venueId}`);
      await db.execute(sql`DELETE FROM venues WHERE id = ${input.venueId}`);
    }
    await db.execute(sql`DELETE FROM businesses WHERE id = ${input.businessId}`);
    if (input.categoryId) {
      await db.execute(sql`DELETE FROM categories WHERE id = ${input.categoryId}`);
    }
  }

  it('un lieu DRAFT sans offre est retrouvé par listVenues — impossible auparavant', async () => {
    const biz = await seedBusiness();
    const venue = await seedVenue(biz.id, { description: null });
    cleanups.push(() => cleanupGraph({ businessId: biz.id, venueId: venue.id }));

    const { items } = await business.listVenues(biz.id);

    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(venue.id);
    expect(items[0]!.status).toBe('DRAFT');
    expect(items[0]!.offerCount).toBe(0);
    expect(items[0]!.imageCount).toBe(0);
    // Sans TVA, sans description, sans offre, sans photo : les quatre manquent.
    expect(items[0]!.missingRequirements).toEqual(
      expect.arrayContaining([
        'AT_LEAST_ONE_OFFER',
        'VENUE_DESCRIPTION',
        'AT_LEAST_ONE_PHOTO',
        'VALID_VAT_NUMBER',
      ]),
    );
  });

  it("un PATCH qui ne touche qu'un champ n'efface aucun autre — équipements, horaires, fuseau, prix barré intacts", async () => {
    const biz = await seedBusiness();
    const venue = await seedVenue(biz.id, { timeZone: 'Europe/Brussels' });
    const category = await seedCategory();
    // Un seul cleanup, poussé une fois tout le graphe connu : la catégorie ne
    // doit être supprimée qu'après l'offre qui la référence (`ON DELETE
    // RESTRICT`), donc après tout le reste — c'est l'ordre que `cleanupGraph`
    // respecte déjà en interne.
    cleanups.push(() =>
      cleanupGraph({ businessId: biz.id, venueId: venue.id, categoryId: category.id }),
    );

    const updated = await onboarding.updateVenue({
      actor: actorFor(biz.id),
      venueId: venue.id,
      dto: { phone: '+32499998888' },
    });

    expect(updated.phone).toBe('+32499998888');
    // Tout le reste doit être strictement identique à ce qui a été seedé.
    expect(updated.amenities).toEqual(['wifi', 'parking']);
    expect(updated.openingHours).toEqual([{ dayOfWeek: 1, opensAt: '09:00', closesAt: '18:00' }]);
    expect(updated.timeZone).toBe('Europe/Brussels');
    expect(updated.name).toBe(venue.name);
    expect(updated.addressLine).toBe(venue.addressLine);

    const offer = await seedOffer(venue.id, biz.id, category.id, {
      priceAmount: 1000,
      referencePriceAmount: 1500,
    });

    const updatedOffer = await onboarding.updateOffer({
      actor: actorFor(biz.id),
      offerId: offer.id,
      dto: { capacity: 25 },
    });

    expect(updatedOffer.capacity).toBe(25);
    expect(updatedOffer.title).toBe(offer.title);
    expect(updatedOffer.priceAmount).toBe(1000);

    const [persistedOffer] = await db
      .select()
      .from(schema.offers)
      .where(eq(schema.offers.id, offer.id));
    // Le prix barré n'est pas exposé par BusinessOfferDto : vérifié directement en base.
    expect(persistedOffer?.referencePriceAmount).toBe(1500);
    expect(persistedOffer?.capacity).toBe(25);
  });

  it('un champ modéré est refusé sur une salle en ligne ; un champ identité est accepté et émet VenueIdentityChanged', async () => {
    const biz = await seedBusiness();
    const venue = await seedVenue(biz.id, { status: 'ACTIVE' });
    cleanups.push(() => cleanupGraph({ businessId: biz.id, venueId: venue.id }));

    await expect(
      onboarding.updateVenue({
        actor: actorFor(biz.id),
        venueId: venue.id,
        dto: { description: 'Une description modifiée après mise en ligne, refusée.' },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });

    const received: {
      venueId: string;
      changes: readonly { field: string; oldValue: unknown; newValue: unknown }[];
    }[] = [];
    events.on('VenueIdentityChanged', (payload) => {
      received.push(payload);
    });

    const updated = await onboarding.updateVenue({
      actor: actorFor(biz.id),
      venueId: venue.id,
      dto: { name: 'Nouveau Nom De Salle' },
    });

    expect(updated.name).toBe('Nouveau Nom De Salle');
    expect(received).toHaveLength(1);
    expect(received[0]!.venueId).toBe(venue.id);
    // L'événement porte la valeur avant/après, pas seulement le nom du champ —
    // c'est ce qui permet à l'alerte admin de dire « Ancien Nom → Nouveau Nom »
    // sans aller la rechercher ailleurs.
    expect(received[0]!.changes).toContainEqual({
      field: 'name',
      oldValue: venue.name,
      newValue: 'Nouveau Nom De Salle',
    });
  });

  it('referencePriceAmount est revalidé contre le priceAmount STOCKÉ, pas contre le corps de la requête', async () => {
    const biz = await seedBusiness();
    const venue = await seedVenue(biz.id);
    const category = await seedCategory();
    const offer = await seedOffer(venue.id, biz.id, category.id, {
      priceAmount: 1000,
      referencePriceAmount: 1500,
    });
    cleanups.push(async () => {
      await cleanupGraph({ businessId: biz.id, venueId: venue.id, categoryId: category.id });
    });

    // Ne touche QUE referencePriceAmount ; priceAmount reste 1000 en base.
    await expect(
      onboarding.updateOffer({
        actor: actorFor(biz.id),
        offerId: offer.id,
        dto: { referencePriceAmount: 500 },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });

    // Le prix barré n'a pas bougé après le refus.
    const [afterRejection] = await db
      .select({ referencePriceAmount: schema.offers.referencePriceAmount })
      .from(schema.offers)
      .where(eq(schema.offers.id, offer.id));
    expect(afterRejection?.referencePriceAmount).toBe(1500);

    // Ne touche QUE priceAmount ; 1500 >= 400 reste valide.
    const updated = await onboarding.updateOffer({
      actor: actorFor(biz.id),
      offerId: offer.id,
      dto: { priceAmount: 400 },
    });
    expect(updated.priceAmount).toBe(400);
  });

  it("currency n'est jamais accepté en mise à jour, quel que soit le statut", async () => {
    const biz = await seedBusiness();
    const venue = await seedVenue(biz.id);
    const category = await seedCategory();
    const offer = await seedOffer(venue.id, biz.id, category.id);
    cleanups.push(async () => {
      await cleanupGraph({ businessId: biz.id, venueId: venue.id, categoryId: category.id });
    });

    await expect(
      onboarding.updateOffer({
        actor: actorFor(biz.id),
        offerId: offer.id,
        dto: { currency: 'USD' } as never,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });

    const [persisted] = await db
      .select({ currency: schema.offers.currency })
      .from(schema.offers)
      .where(eq(schema.offers.id, offer.id));
    expect(persisted?.currency).toBe('EUR');
  });

  it('soumission d’un dossier incomplet → 409 listant les manques', async () => {
    const biz = await seedBusiness();
    const venue = await seedVenue(biz.id, { description: null });
    cleanups.push(() => cleanupGraph({ businessId: biz.id, venueId: venue.id }));

    await expect(
      onboarding.submitVenue({ actor: actorFor(biz.id), venueId: venue.id }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      details: {
        missing: expect.arrayContaining([
          'AT_LEAST_ONE_OFFER',
          'VENUE_DESCRIPTION',
          'AT_LEAST_ONE_PHOTO',
          'VALID_VAT_NUMBER',
        ]),
      },
    });

    // Le lieu n'a pas bougé de DRAFT : le refus n'a rien écrit.
    const [persisted] = await db
      .select({ status: schema.venues.status })
      .from(schema.venues)
      .where(eq(schema.venues.id, venue.id));
    expect(persisted?.status).toBe('DRAFT');
  });

  it('resoumission après refus → rejectedReason remis à null ; retrait → DRAFT ; double soumission → conflit, jamais un 500 muet', async () => {
    const biz = await seedBusiness({ vatNumber: 'BE0417497106' });
    const venue = await seedVenue(biz.id, {
      status: 'REJECTED',
      rejectedReason: 'Photos de mauvaise qualité.',
      description: 'Une description bien assez longue pour passer la validation Zod ici.',
    });
    const category = await seedCategory();
    const offer = await seedOffer(venue.id, biz.id, category.id);
    await db.insert(schema.venueImages).values({
      venueId: venue.id,
      storageKey: 'test/venue.jpg',
      width: 1200,
      height: 800,
    });
    cleanups.push(async () => {
      await cleanupGraph({ businessId: biz.id, venueId: venue.id, categoryId: category.id });
    });

    await onboarding.submitVenue({ actor: actorFor(biz.id), venueId: venue.id });

    const [afterResubmit] = await db
      .select({ status: schema.venues.status, rejectedReason: schema.venues.rejectedReason })
      .from(schema.venues)
      .where(eq(schema.venues.id, venue.id));
    expect(afterResubmit?.status).toBe('PENDING_APPROVAL');
    expect(afterResubmit?.rejectedReason).toBeNull();

    await onboarding.withdrawVenue({ actor: actorFor(biz.id), venueId: venue.id });
    const [afterWithdraw] = await db
      .select({ status: schema.venues.status })
      .from(schema.venues)
      .where(eq(schema.venues.id, venue.id));
    expect(afterWithdraw?.status).toBe('DRAFT');

    // Resoumettre, puis soumettre une DEUXIÈME fois sans repasser par DRAFT :
    // la machine à états refuse PENDING_APPROVAL -> PENDING_APPROVAL. Avant le
    // correctif du filtre, cette InvalidModerationTransitionError traversait
    // jusqu'au client sous forme de 500 « Une erreur est survenue » ; le
    // filtre la mappe maintenant sur 409 (voir exception.filter.test.ts pour
    // la preuve au niveau HTTP). Ici, on vérifie que le service lève bien le
    // type d'erreur attendu — pas un type générique qui échapperait au filtre.
    await onboarding.submitVenue({ actor: actorFor(biz.id), venueId: venue.id });
    await expect(
      onboarding.submitVenue({ actor: actorFor(biz.id), venueId: venue.id }),
    ).rejects.toBeInstanceOf(InvalidModerationTransitionError);
  });

  it("le titre d'une offre suit le renommage de sa salle — remplacement prudent aux frontières de mot", async () => {
    const biz = await seedBusiness();
    const venue = await seedVenue(biz.id, { name: 'Studio Move' });
    const category = await seedCategory();
    const matching = await seedOffer(venue.id, biz.id, category.id, {
      title: 'Essai Studio Move',
    });
    const unrelated = await seedOffer(venue.id, biz.id, category.id, {
      title: 'Cours collectif du mardi',
    });
    const falsePositiveGuard = await seedOffer(venue.id, biz.id, category.id, {
      title: 'Studio Movement Center — initiation',
    });
    cleanups.push(async () => {
      await cleanupGraph({ businessId: biz.id, venueId: venue.id, categoryId: category.id });
    });

    await onboarding.updateVenue({
      actor: actorFor(biz.id),
      venueId: venue.id,
      dto: { name: 'Yoga Nova' },
    });

    const rows = await db
      .select({ id: schema.offers.id, title: schema.offers.title })
      .from(schema.offers)
      .where(eq(schema.offers.venueId, venue.id));
    const byId = new Map(rows.map((row) => [row.id, row.title]));

    expect(byId.get(matching.id)).toBe('Essai Yoga Nova');
    expect(byId.get(unrelated.id)).toBe('Cours collectif du mardi');
    // « Studio Move » suivi de « ment » n'est pas une frontière de mot : pas de
    // remplacement à mi-mot.
    expect(byId.get(falsePositiveGuard.id)).toBe('Studio Movement Center — initiation');
  });
});
