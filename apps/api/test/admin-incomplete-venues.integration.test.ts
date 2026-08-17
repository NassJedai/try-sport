import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import { AdminBrowseService } from '../src/modules/admin/admin-browse.service.js';
import type { AuthenticatedUser } from '../src/common/auth/current-user.js';
import { connect, createTestUser, describeIfDatabase } from './integration-setup.js';

/**
 * Ce que ce test protège : la vue admin des dossiers incomplets liste
 * vraiment ce qui manque, et n'oublie personne — y compris les deux salles
 * `ACTIVE` héritées sans TVA, hors-règle sans être bloquées, que Nassim veut
 * voir comme n'importe quel autre dossier incomplet plutôt que traitées à
 * part.
 */
describeIfDatabase('admin — lieux inscrits mais incomplets', () => {
  let db: Database;
  let close: () => Promise<void>;
  let adminId: string;
  let browse: AdminBrowseService;

  beforeAll(async () => {
    ({ db, close } = connect());
    browse = new AdminBrowseService(db);
    const admin = await createTestUser(db);
    adminId = admin.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE id = ${adminId}`);
    await close();
  });

  function admin(): AuthenticatedUser {
    return { id: adminId, email: 'admin@try.local', role: 'SUPER_ADMIN', memberships: [] };
  }

  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  async function seedBusiness(overrides: Partial<typeof schema.businesses.$inferInsert> = {}) {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [row] = await db
      .insert(schema.businesses)
      .values({
        slug: `biz-${suffix}`,
        name: `Business ${suffix}`,
        contactEmail: `biz-${suffix}@try.local`,
        status: 'ACTIVE',
        vatNumber: 'BE0417497106', // TVA valide (Colruyt, connue pour passer la clé de contrôle)
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
        description: 'Une description bien assez longue pour passer la validation métier.',
        addressLine: '1 Test Street',
        postalCode: '1000',
        cityId: city!.id,
        latitude: 50.8467,
        longitude: 4.3525,
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

  async function seedOffer(venueId: string, businessId: string, categoryId: string) {
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
      })
      .returning();
    return row!;
  }

  async function seedImage(venueId: string) {
    await db.insert(schema.venueImages).values({
      venueId,
      storageKey: `test/${Math.random().toString(36).slice(2)}.jpg`,
      role: 'GALLERY',
      width: 800,
      height: 600,
    });
  }

  function cleanupGraph(input: { businessId: string; venueId?: string; categoryId?: string }): void {
    cleanups.push(async () => {
      if (input.venueId) {
        await db.execute(sql`DELETE FROM offers WHERE venue_id = ${input.venueId}`);
        await db.execute(sql`DELETE FROM venue_images WHERE venue_id = ${input.venueId}`);
        await db.execute(sql`DELETE FROM venues WHERE id = ${input.venueId}`);
      }
      await db.execute(sql`DELETE FROM businesses WHERE id = ${input.businessId}`);
      if (input.categoryId) await db.execute(sql`DELETE FROM categories WHERE id = ${input.categoryId}`);
    });
  }

  it("liste un dossier DRAFT auquel il manque une offre et une photo, avec les libellés attendus", async () => {
    const biz = await seedBusiness();
    const venue = await seedVenue(biz.id);
    cleanupGraph({ businessId: biz.id, venueId: venue.id });

    const { items } = await browse.incompleteVenues(admin());
    const mine = items.find((item) => item.id === venue.id);

    expect(mine).toBeDefined();
    expect(mine!.missing).toEqual(
      expect.arrayContaining(['AT_LEAST_ONE_OFFER', 'AT_LEAST_ONE_PHOTO']),
    );
    expect(mine!.missing).not.toContain('VENUE_DESCRIPTION');
    expect(mine!.missing).not.toContain('VALID_VAT_NUMBER');
    expect(mine!.missingLabels).toEqual(expect.arrayContaining(['Aucune offre', 'Aucune photo']));
    expect(mine!.businessName).toBe(biz.name);
  });

  it('un dossier complet (offre, photo, description, TVA valide) ne figure pas dans la vue', async () => {
    const biz = await seedBusiness();
    const venue = await seedVenue(biz.id);
    const category = await seedCategory();
    await seedOffer(venue.id, biz.id, category.id);
    await seedImage(venue.id);
    cleanupGraph({ businessId: biz.id, venueId: venue.id, categoryId: category.id });

    const { items } = await browse.incompleteVenues(admin());
    expect(items.find((item) => item.id === venue.id)).toBeUndefined();
  });

  it(
    'deux salles ACTIVE sans TVA — hors-règle mais jamais bloquées puisque la complétude ne se ' +
      'vérifie qu\x27à la soumission — apparaissent quand même, comme n\x27importe quel dossier incomplet',
    async () => {
      const bizA = await seedBusiness({ vatNumber: null });
      const bizB = await seedBusiness({ vatNumber: null });
      const venueA = await seedVenue(bizA.id, { status: 'ACTIVE' });
      const venueB = await seedVenue(bizB.id, { status: 'ACTIVE' });
      const categoryA = await seedCategory();
      const categoryB = await seedCategory();
      await seedOffer(venueA.id, bizA.id, categoryA.id);
      await seedOffer(venueB.id, bizB.id, categoryB.id);
      await seedImage(venueA.id);
      await seedImage(venueB.id);
      cleanupGraph({ businessId: bizA.id, venueId: venueA.id, categoryId: categoryA.id });
      cleanupGraph({ businessId: bizB.id, venueId: venueB.id, categoryId: categoryB.id });

      const { items } = await browse.incompleteVenues(admin());
      const mineA = items.find((item) => item.id === venueA.id);
      const mineB = items.find((item) => item.id === venueB.id);

      expect(mineA).toBeDefined();
      expect(mineA!.status).toBe('ACTIVE');
      expect(mineA!.missing).toEqual(['VALID_VAT_NUMBER']);
      expect(mineB).toBeDefined();
      expect(mineB!.status).toBe('ACTIVE');
      expect(mineB!.missing).toEqual(['VALID_VAT_NUMBER']);
    },
  );
});
