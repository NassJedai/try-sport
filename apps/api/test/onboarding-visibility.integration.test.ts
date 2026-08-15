import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@try/database';
import { ModerationService } from '../src/modules/admin/moderation.service.js';
import { connect, describeIfDatabase } from './integration-setup.js';

/**
 * Ce que ce test protège : une salle qui s'inscrit finit par être trouvable.
 *
 * C'est la boucle d'acquisition entière, et elle était rompue sans qu'aucun test
 * ne le voie. Chaque morceau marchait : l'inscription créait l'établissement, le
 * lieu, l'offre et les créneaux ; la modération approuvait le lieu et l'offre ;
 * la recherche renvoyait des résultats. Mais l'établissement naissait
 * PENDING_APPROVAL, la découverte filtrait dessus, et RIEN dans la console
 * d'administration ne pouvait le faire passer à ACTIVE. Une salle inscrite
 * restait invisible pour toujours, sans le moindre message d'erreur nulle part.
 *
 * Trouvé en s'inscrivant réellement, pas en lisant du code — d'où ce test, qui
 * vérifie l'état final de la chaîne plutôt que ses maillons un par un.
 */
describeIfDatabase('inscription → visibilité', () => {
  let ctx: ReturnType<typeof connect>;
  const pending: Array<() => Promise<void>> = [];

  beforeAll(() => {
    ctx = connect();
  });

  afterEach(async () => {
    while (pending.length > 0) await pending.pop()!();
  });

  afterAll(async () => {
    await ctx.close();
  });

  const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silentLogger,
  };

  function buildModeration(): ModerationService {
    return new ModerationService(
      ctx.db,
      { now: () => new Date() } as never,
      silentLogger as never,
      { record: () => Promise.resolve() } as never,
    );
  }

  it('rend l\x27établissement actif quand son lieu est approuvé', async () => {
    const suffix = Math.random().toString(36).slice(2, 10);

    const [business] = await ctx.db
      .insert(schema.businesses)
      .values({
        slug: `biz-${suffix}`,
        name: 'Test Onboarding',
        contactEmail: `biz-${suffix}@try.local`,
        // L'état réel d'une inscription en libre-service.
        status: 'PENDING_APPROVAL',
      })
      .returning({ id: schema.businesses.id });

    const [city] = await ctx.db
      .select({ id: schema.cities.id })
      .from(schema.cities)
      .limit(1);

    const [venue] = await ctx.db
      .insert(schema.venues)
      .values({
        businessId: business!.id,
        slug: `venue-${suffix}`,
        name: 'Test Onboarding Venue',
        status: 'PENDING_APPROVAL',
        addressLine: '1 Test Street',
        postalCode: '1000',
        cityId: city!.id,
        latitude: 50.8467,
        longitude: 4.3525,
      })
      .returning({ id: schema.venues.id });

    pending.push(async () => {
      await ctx.db.execute(sql`DELETE FROM venues WHERE id = ${venue!.id}`);
      await ctx.db.execute(sql`DELETE FROM businesses WHERE id = ${business!.id}`);
    });

    await buildModeration().decideVenue({
      actor: { id: business!.id, role: 'ADMIN' } as never,
      venueId: venue!.id,
      decision: 'APPROVE',
    });

    const [after] = await ctx.db
      .select({ status: schema.businesses.status })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, business!.id));

    expect(after!.status).toBe('ACTIVE');
  });

  /**
   * L'inverse compte autant : approuver un lieu ne doit pas servir de porte
   * dérobée pour relever une suspension prononcée contre l'entreprise entière.
   */
  it('ne relève pas la suspension d\x27un établissement', async () => {
    const suffix = Math.random().toString(36).slice(2, 10);

    const [business] = await ctx.db
      .insert(schema.businesses)
      .values({
        slug: `biz-${suffix}`,
        name: 'Test Suspended',
        contactEmail: `biz-${suffix}@try.local`,
        status: 'SUSPENDED',
      })
      .returning({ id: schema.businesses.id });

    const [city] = await ctx.db.select({ id: schema.cities.id }).from(schema.cities).limit(1);

    const [venue] = await ctx.db
      .insert(schema.venues)
      .values({
        businessId: business!.id,
        slug: `venue-${suffix}`,
        name: 'Test Suspended Venue',
        status: 'PENDING_APPROVAL',
        addressLine: '1 Test Street',
        postalCode: '1000',
        cityId: city!.id,
        latitude: 50.8467,
        longitude: 4.3525,
      })
      .returning({ id: schema.venues.id });

    pending.push(async () => {
      await ctx.db.execute(sql`DELETE FROM venues WHERE id = ${venue!.id}`);
      await ctx.db.execute(sql`DELETE FROM businesses WHERE id = ${business!.id}`);
    });

    await buildModeration().decideVenue({
      actor: { id: business!.id, role: 'ADMIN' } as never,
      venueId: venue!.id,
      decision: 'APPROVE',
    });

    const [after] = await ctx.db
      .select({ status: schema.businesses.status })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, business!.id));

    expect(after!.status).toBe('SUSPENDED');
  });
});
