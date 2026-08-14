import { describe } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, schema } from '@try/database';
import type { Database } from '@try/database';

/**
 * Harness for tests that need a real Postgres with PostGIS.
 *
 * These suites are *skipped*, loudly, when DATABASE_URL is absent. They are never
 * silently passed and never rewritten against a fake: the behaviour under test —
 * row locking, CHECK constraints, partial unique indexes — exists only in
 * Postgres, so a mock would prove nothing at all.
 */

export const INTEGRATION_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

/**
 * `describe` that skips — visibly — rather than silently passing when no database
 * is configured. Vitest reports the suite as skipped, so a CI run without a
 * database cannot be mistaken for one that exercised these guarantees.
 */
export function describeIfDatabase(name: string, fn: () => void): void {
  if (!INTEGRATION_DATABASE_URL) {
    describe.skip(`${name} [requires TEST_DATABASE_URL with PostGIS]`, fn);
    return;
  }
  describe(name, fn);
}

export interface TestContext {
  db: Database;
  close: () => Promise<void>;
}

export function connect(): TestContext {
  if (!INTEGRATION_DATABASE_URL) {
    throw new Error('INTEGRATION_DATABASE_URL is not set');
  }
  // A pool, not a single connection: the concurrency tests need genuinely
  // parallel sessions, which is the entire point of the exercise.
  const handle = createDatabase({ url: INTEGRATION_DATABASE_URL, maxConnections: 20 });
  return { db: handle.db, close: handle.close };
}

/** Minimal graph: country -> city -> business -> venue -> category -> offer -> slot. */
export async function seedBookableSlot(
  db: Database,
  options: { capacity: number; priceAmount?: number; trialRule?: 'ONE_TRIAL_PER_VENUE' | 'NO_RESTRICTION' },
): Promise<{
  slotId: string;
  offerId: string;
  venueId: string;
  businessId: string;
  cleanup: () => Promise<void>;
}> {
  const suffix = Math.random().toString(36).slice(2, 10);

  const [country] = await db
    .insert(schema.countries)
    .values({ code: suffix.slice(0, 2).toUpperCase(), name: `Test ${suffix}` })
    .returning();
  const [city] = await db
    .insert(schema.cities)
    .values({
      countryId: country!.id,
      slug: `city-${suffix}`,
      name: 'Test City',
      latitude: 50.8467,
      longitude: 4.3525,
    })
    .returning();
  const [business] = await db
    .insert(schema.businesses)
    .values({
      slug: `biz-${suffix}`,
      name: 'Test Business',
      contactEmail: `biz-${suffix}@try.local`,
      status: 'ACTIVE',
    })
    .returning();
  const [venue] = await db
    .insert(schema.venues)
    .values({
      businessId: business!.id,
      slug: `venue-${suffix}`,
      name: 'Test Venue',
      status: 'ACTIVE',
      addressLine: '1 Test Street',
      postalCode: '1000',
      cityId: city!.id,
      latitude: 50.8467,
      longitude: 4.3525,
    })
    .returning();
  const [category] = await db
    .insert(schema.categories)
    .values({ slug: `cat-${suffix}`, name: 'Test Category' })
    .returning();
  const [offer] = await db
    .insert(schema.offers)
    .values({
      venueId: venue!.id,
      businessId: business!.id,
      categoryId: category!.id,
      title: 'Test Offer',
      description: 'A test offer used by the integration suite.',
      status: 'ACTIVE',
      experienceType: 'FREE_TRIAL',
      priceAmount: options.priceAmount ?? 0,
      durationMinutes: 60,
      capacity: options.capacity,
      trialRule: options.trialRule ?? 'NO_RESTRICTION',
      publishedAt: new Date(),
    })
    .returning();

  const startAt = new Date(Date.now() + 7 * 86_400_000);
  const [slot] = await db
    .insert(schema.slots)
    .values({
      offerId: offer!.id,
      venueId: venue!.id,
      startAt,
      endAt: new Date(startAt.getTime() + 3_600_000),
      capacity: options.capacity,
      reservedCount: 0,
      status: 'OPEN',
    })
    .returning();

  return {
    slotId: slot!.id,
    offerId: offer!.id,
    venueId: venue!.id,
    businessId: business!.id,
    cleanup: async () => {
      await db.execute(sql`DELETE FROM reservations WHERE slot_id = ${slot!.id}`);
      await db.execute(sql`DELETE FROM slots WHERE id = ${slot!.id}`);
      await db.execute(sql`DELETE FROM offers WHERE id = ${offer!.id}`);
      await db.execute(sql`DELETE FROM venues WHERE id = ${venue!.id}`);
      await db.execute(sql`DELETE FROM businesses WHERE id = ${business!.id}`);
      await db.execute(sql`DELETE FROM categories WHERE id = ${category!.id}`);
      await db.execute(sql`DELETE FROM cities WHERE id = ${city!.id}`);
      await db.execute(sql`DELETE FROM countries WHERE id = ${country!.id}`);
    },
  };
}

export async function createTestUser(db: Database): Promise<{ id: string }> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `test-${Math.random().toString(36).slice(2)}@try.local`, role: 'USER' })
    .returning();
  return { id: user!.id };
}
