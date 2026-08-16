import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@try/database';
import { OnboardingService } from '../src/modules/business/onboarding.service.js';
import { AuditService } from '../src/modules/admin/audit.service.js';
import { connect, describeIfDatabase } from './integration-setup.js';

/**
 * Ce que ce test protège : le taux de commission plateforme (25 %, soit 2500
 * points de base) n'a qu'un seul gardien — le DEFAULT de la colonne Postgres
 * `businesses.commission_basis_points`. `OnboardingService.createBusiness` ne
 * fixe volontairement pas ce champ à l'insertion (voir onboarding.service.ts,
 * commentaire au-dessus de `status: 'PENDING_APPROVAL'`), précisément pour
 * qu'il n'existe qu'un seul endroit où le taux commercial est énoncé.
 *
 * Ce test fait passer une salle par le vrai flux d'inscription (le service,
 * pas un INSERT direct) pour attraper deux régressions distinctes :
 *  - quelqu'un réintroduit une valeur en dur dans le service (le test échoue
 *    même si la base est migrée) ;
 *  - la migration 0005_commission_default.sql n'a pas été appliquée sur cette
 *    base (le test échoue même si le service est intact).
 */
describeIfDatabase('inscription → taux de commission par défaut', () => {
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

  function buildOnboarding(): OnboardingService {
    const audit = new AuditService(ctx.db);
    return new OnboardingService(ctx.db, { now: () => new Date() } as never, audit);
  }

  it('inscrit une nouvelle salle à 2500 points de base (25 %), jamais codé en dur dans le service', async () => {
    const suffix = Math.random().toString(36).slice(2, 10);

    const [user] = await ctx.db
      .insert(schema.users)
      .values({ email: `owner-${suffix}@try.local`, role: 'USER' })
      .returning({ id: schema.users.id });

    pending.push(async () => {
      await ctx.db.execute(sql`DELETE FROM users WHERE id = ${user!.id}`);
    });

    const { businessId } = await buildOnboarding().createBusiness({
      actor: { id: user!.id, email: `owner-${suffix}@try.local`, role: 'USER', memberships: [] },
      dto: {
        name: `Salle Commission ${suffix}`,
        contactEmail: `biz-${suffix}@try.local`,
        countryCode: 'BE',
      },
    });

    pending.push(async () => {
      await ctx.db.execute(sql`DELETE FROM business_members WHERE business_id = ${businessId}`);
      await ctx.db.execute(sql`DELETE FROM businesses WHERE id = ${businessId}`);
    });

    const [row] = await ctx.db
      .select({ commissionBasisPoints: schema.businesses.commissionBasisPoints })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId));

    expect(
      row?.commissionBasisPoints,
      "Le taux de commission d'une nouvelle salle doit être 2500 (25 %), lu " +
        "depuis le DEFAULT de la colonne businesses.commission_basis_points. " +
        "Si cette valeur vaut 1500 : soit onboarding.service.ts fixe " +
        "explicitement commissionBasisPoints à l'insertion (régression — le " +
        "taux doit rester absent du service, voir le commentaire dans " +
        "createBusiness), soit la migration " +
        "packages/database/drizzle/0005_commission_default.sql n'a pas été " +
        "appliquée sur cette base (lancer `pnpm --filter @try/database migrate`).",
    ).toBe(2500);
  });
});
