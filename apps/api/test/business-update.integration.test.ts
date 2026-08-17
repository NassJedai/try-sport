import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Clock } from '@try/utils';
import type { Logger } from '@try/logger';
import { AuditService } from '../src/modules/admin/audit.service.js';
import { DomainEvents } from '../src/modules/events/domain-events.js';
import { BusinessService } from '../src/modules/business/business.service.js';
import { updateBusinessSchema } from '../src/modules/business/update-business.schema.js';
import type { AuthenticatedUser } from '../src/common/auth/current-user.js';
import { connect, createTestUser, describeIfDatabase } from './integration-setup.js';

/**
 * Lot correctif : `PATCH /v1/businesses/:businessId` — le trou qui rendait
 * l'assistant d'inscription inutilisable. `missingRequirements` contenait
 * *toujours* `VALID_VAT_NUMBER` parce qu'aucun endpoint n'enregistrait la TVA
 * après la création de l'établissement (elle est facultative à la création,
 * exigée à la soumission — voir `venue-submission.ts`). Le dernier test de ce
 * fichier est la preuve que ce blocage est levé.
 */
describeIfDatabase('BusinessService.updateBusiness / getBusiness', () => {
  function fakeLogger(): Logger {
    const noop = (): void => undefined;
    const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop };
    return { ...logger, child: () => logger } as unknown as Logger;
  }

  let db: ReturnType<typeof connect>['db'];
  let close: ReturnType<typeof connect>['close'];
  let events: DomainEvents;
  let business: BusinessService;
  let actorUserId: string;
  const clock: Clock = { now: () => new Date() };

  beforeAll(async () => {
    ({ db, close } = connect());
    events = new DomainEvents(fakeLogger());
    const audit = new AuditService(db);
    business = new BusinessService(db, clock, audit, events);

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
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()!;
      try {
        await cleanup();
      } catch (error) {
        // eslint-disable-next-line no-console -- visibilité en test seulement
        console.error('business-update: cleanup step failed, continuing', error);
      }
    }
  });

  function ownerFor(businessId: string): AuthenticatedUser {
    return {
      id: actorUserId,
      email: 'owner@try.local',
      role: 'BUSINESS_MEMBER',
      memberships: [{ businessId, role: 'OWNER' }],
    };
  }

  function managerFor(businessId: string): AuthenticatedUser {
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
        status: 'PENDING_APPROVAL',
        vatNumber: null,
        ...overrides,
      })
      .returning();
    const row1 = row!;
    cleanups.push(async () => {
      await db.execute(sql`DELETE FROM audit_logs WHERE entity_id = ${row1.id}`);
      await db.execute(sql`DELETE FROM offers WHERE business_id = ${row1.id}`);
      await db.execute(sql`DELETE FROM venues WHERE business_id = ${row1.id}`);
      await db.execute(sql`DELETE FROM businesses WHERE id = ${row1.id}`);
    });
    return row1;
  }

  it('une TVA valide est stockée normalisée, et countryCode se déduit du numéro — jamais du corps de la requête', async () => {
    const biz = await seedBusiness({ countryCode: 'BE' });

    // Saisie humaine plausible : minuscules, espaces, points. Passe par le
    // vrai schéma (comme le pipe de validation le ferait), pas par une valeur
    // déjà propre écrite à la main dans le test.
    const dto = updateBusinessSchema.parse({ vatNumber: 'be 0417.497.106' });

    const updated = await business.updateBusiness({
      actor: ownerFor(biz.id),
      businessId: biz.id,
      dto,
    });

    expect(updated.vatNumber).toBe('BE0417497106');
    expect(updated.countryCode).toBe('BE');

    const [persisted] = await db
      .select({ vatNumber: schema.businesses.vatNumber, countryCode: schema.businesses.countryCode })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, biz.id));
    expect(persisted?.vatNumber).toBe('BE0417497106');
    expect(persisted?.countryCode).toBe('BE');
  });

  it('une TVA à clé de contrôle fausse est refusée par le schéma — 400, message dans details.vatNumber', () => {
    const result = updateBusinessSchema.safeParse({ vatNumber: 'BE0123456789' });

    expect(result.success).toBe(false);
    const issue = result.success
      ? undefined
      : result.error.issues.find((candidate) => candidate.path.join('.') === 'vatNumber');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/clé de contrôle/);
  });

  it("un PATCH d'un seul champ n'efface aucun autre champ de l'établissement", async () => {
    const biz = await seedBusiness({
      legalName: 'Studio Move SRL',
      vatNumber: 'BE0417497106',
      countryCode: 'BE',
      contactPhone: '+32499990000',
    });

    const updated = await business.updateBusiness({
      actor: ownerFor(biz.id),
      businessId: biz.id,
      dto: updateBusinessSchema.parse({ contactEmail: 'new-contact@try.local' }),
    });

    expect(updated.contactEmail).toBe('new-contact@try.local');
    expect(updated.legalName).toBe('Studio Move SRL');
    expect(updated.vatNumber).toBe('BE0417497106');
    expect(updated.countryCode).toBe('BE');
    expect(updated.contactPhone).toBe('+32499990000');
    expect(updated.name).toBe(biz.name);
  });

  it('contactPhone: null est une remise à zéro légitime, distincte de "absent"', async () => {
    const biz = await seedBusiness({ contactPhone: '+32499990000' });

    const updated = await business.updateBusiness({
      actor: ownerFor(biz.id),
      businessId: biz.id,
      dto: updateBusinessSchema.parse({ contactPhone: null }),
    });

    expect(updated.contactPhone).toBeNull();
  });

  it('commissionBasisPoints ne peut pas être modifié, même envoyé explicitement dans le corps', async () => {
    const biz = await seedBusiness();
    const [before] = await db
      .select({ commissionBasisPoints: schema.businesses.commissionBasisPoints })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, biz.id));

    // Le schéma le retire silencieusement : aucune clé `commissionBasisPoints`
    // ne survit au parse, exactement comme `name`.
    const dto = updateBusinessSchema.parse({
      contactPhone: '+32411112222',
      commissionBasisPoints: 9999,
    });
    expect(dto).not.toHaveProperty('commissionBasisPoints');

    await business.updateBusiness({ actor: ownerFor(biz.id), businessId: biz.id, dto });

    const [after] = await db
      .select({ commissionBasisPoints: schema.businesses.commissionBasisPoints })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, biz.id));
    expect(after?.commissionBasisPoints).toBe(before?.commissionBasisPoints);
  });

  it('countryCode envoyé directement dans le corps est refusé — il se déduit du numéro de TVA', async () => {
    const biz = await seedBusiness();

    await expect(
      business.updateBusiness({
        actor: ownerFor(biz.id),
        businessId: biz.id,
        dto: { countryCode: 'FR' } as never,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('un MANAGER est refusé — la donnée est contractuelle, réservée à OWNER', async () => {
    const biz = await seedBusiness();

    await expect(
      business.updateBusiness({
        actor: managerFor(biz.id),
        businessId: biz.id,
        dto: updateBusinessSchema.parse({ legalName: 'Nouvelle raison sociale SRL' }),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('BusinessIdentityChanged est émis quand vatNumber change sur un établissement déjà ACTIVE, pas sur un établissement en attente', async () => {
    const pendingBiz = await seedBusiness({ status: 'PENDING_APPROVAL' });
    const activeBiz = await seedBusiness({ status: 'ACTIVE' });

    const received: { businessId: string }[] = [];
    events.on('BusinessIdentityChanged', (payload) => {
      received.push(payload);
    });

    await business.updateBusiness({
      actor: ownerFor(pendingBiz.id),
      businessId: pendingBiz.id,
      dto: updateBusinessSchema.parse({ vatNumber: 'BE0417497106' }),
    });
    await business.updateBusiness({
      actor: ownerFor(activeBiz.id),
      businessId: activeBiz.id,
      dto: updateBusinessSchema.parse({ vatNumber: 'FR40303265045' }),
    });

    // L'événement est émis de façon synchrone depuis `updateBusiness` (avant
    // que la promesse ne se résolve pour l'appelant) — pas de sondage
    // nécessaire ici, contrairement à un effet asynchrone d'écouteur.
    expect(received.map((r) => r.businessId)).toEqual([activeBiz.id]);
  });

  it('GET relit ce que le PATCH vient d’écrire', async () => {
    const biz = await seedBusiness();

    await business.updateBusiness({
      actor: ownerFor(biz.id),
      businessId: biz.id,
      dto: updateBusinessSchema.parse({ vatNumber: 'BE0417497106', legalName: 'Studio Move SRL' }),
    });

    const fetched = await business.getBusiness(biz.id);
    expect(fetched.vatNumber).toBe('BE0417497106');
    expect(fetched.legalName).toBe('Studio Move SRL');
  });

  it('le blocage est levé : après enregistrement de la TVA, VALID_VAT_NUMBER disparaît de missingRequirements', async () => {
    const biz = await seedBusiness();
    const suffix = Math.random().toString(36).slice(2, 10);
    const [city] = await db.select({ id: schema.cities.id }).from(schema.cities).limit(1);
    await db
      .insert(schema.venues)
      .values({
        businessId: biz.id,
        slug: `venue-${suffix}`,
        name: `Venue ${suffix}`,
        status: 'DRAFT',
        description: null,
        addressLine: '1 Test Street',
        postalCode: '1000',
        cityId: city!.id,
        latitude: 50.8467,
        longitude: 4.3525,
      })
      .returning();

    const before = await business.listVenues(biz.id);
    expect(before.items[0]!.missingRequirements).toContain('VALID_VAT_NUMBER');

    await business.updateBusiness({
      actor: ownerFor(biz.id),
      businessId: biz.id,
      dto: updateBusinessSchema.parse({ vatNumber: 'BE0417497106' }),
    });

    const after = await business.listVenues(biz.id);
    expect(after.items[0]!.missingRequirements).not.toContain('VALID_VAT_NUMBER');
    // Les autres manques (offre, description, photo) restent : seule la TVA a bougé.
    expect(after.items[0]!.missingRequirements).toContain('AT_LEAST_ONE_OFFER');
  });
});
