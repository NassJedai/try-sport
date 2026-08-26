import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import { SystemClock } from '@try/utils';
import type { AppConfig } from '@try/config';
import { DiscoveryRepository } from '../src/modules/discovery/discovery.repository.js';
import { DiscoveryService } from '../src/modules/discovery/discovery.service.js';
import { OfferCardMapper } from '../src/modules/discovery/offer-card.mapper.js';
import { connect, createTestUser, describeIfDatabase, seedBookableSlot } from './integration-setup.js';

/**
 * `findUserInterestCategoryIds` (renamed `findUserInterestCategorySlugs`)
 * returned `user_interests.category_id` — a uuid — while
 * `DiscoveryService.rank` compared it against `OfferCardRow.category_slug` —
 * a string like `yoga`. The two could never be equal: `personalization` (25%
 * of `DEFAULT_RANKING_WEIGHTS`) was dead weight, and the "Pour toi" rail
 * built itself empty and vanished (`sections.filter(s => s.offers.length >
 * 0)`) for every single user, always. Fixed 2026-08-26.
 *
 * This test seeds a real declared interest and a real offer in that category
 * and proves both halves of the regression: the repository join must return
 * the *slug*, and the end-to-end `home()` call must surface a non-empty
 * `FOR_YOU` section containing that offer — not a lower score nobody would
 * notice, but a whole rail that was never shown to anyone.
 */
describeIfDatabase('personnalisation de la découverte', () => {
  let db: Database;
  let close: () => Promise<void>;
  let repository: DiscoveryRepository;
  let service: DiscoveryService;

  beforeAll(() => {
    ({ db, close } = connect());
    repository = new DiscoveryRepository(db);
    const mapper = new OfferCardMapper({
      STORAGE_PUBLIC_BASE_URL: 'https://cdn.try.local',
    } as AppConfig);
    service = new DiscoveryService(repository, mapper, new SystemClock());
  });

  afterAll(async () => {
    await close();
  });

  async function categoryOf(offerId: string): Promise<{ id: string; slug: string }> {
    const [row] = await db
      .select({ id: schema.categories.id, slug: schema.categories.slug })
      .from(schema.offers)
      .innerJoin(schema.categories, sql`${schema.categories.id} = ${schema.offers.categoryId}`)
      .where(sql`${schema.offers.id} = ${offerId}`);
    if (!row) throw new Error('offer has no category');
    return row;
  }

  it('findUserInterestCategorySlugs renvoie des slugs, pas des uuid', async () => {
    const matching = await seedBookableSlot(db, { capacity: 5, priceAmount: 0 });
    const user = await createTestUser(db);
    const category = await categoryOf(matching.offerId);

    await db.insert(schema.userInterests).values({ userId: user.id, categoryId: category.id });

    try {
      const slugs = await repository.findUserInterestCategorySlugs(user.id);
      expect(slugs).toEqual([category.slug]);
      // The old, buggy return value — guards against reintroducing it.
      expect(slugs).not.toContain(category.id);
    } finally {
      await db.execute(sql`DELETE FROM user_interests WHERE user_id = ${user.id}`);
      await matching.cleanup();
      await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    }
  });

  it(
    "un intérêt déclaré fait remonter l'offre correspondante et peuple un rail " +
      "« Pour toi » non vide — l'offre d'une autre catégorie n'y figure pas",
    async () => {
      const matching = await seedBookableSlot(db, { capacity: 5, priceAmount: 0 });
      const other = await seedBookableSlot(db, {
        capacity: 5,
        priceAmount: 0,
        existingBusiness: { businessId: matching.businessId, cityId: matching.cityId },
      });
      const user = await createTestUser(db);
      const matchingCategory = await categoryOf(matching.offerId);

      await db
        .insert(schema.userInterests)
        .values({ userId: user.id, categoryId: matchingCategory.id });

      try {
        const home = await service.home({ cityId: matching.cityId, radiusMeters: 20_000 }, user.id);

        const forYou = home.sections.find((section) => section.key === 'FOR_YOU');
        expect(forYou).toBeDefined();
        expect(forYou!.offers.length).toBeGreaterThan(0);

        const forYouIds = forYou!.offers.map((offer) => offer.id);
        expect(forYouIds).toContain(matching.offerId);
        expect(forYouIds).not.toContain(other.offerId);
      } finally {
        await db.execute(sql`DELETE FROM user_interests WHERE user_id = ${user.id}`);
        await other.cleanup();
        await matching.cleanup();
        await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
      }
    },
  );
});
