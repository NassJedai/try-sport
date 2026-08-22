import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Clock } from '@try/utils';
import type { Logger } from '@try/logger';
import { AuditService } from '../src/modules/admin/audit.service.js';
import { DomainEvents } from '../src/modules/events/domain-events.js';
import { BusinessService } from '../src/modules/business/business.service.js';
import type { AuthenticatedUser } from '../src/common/auth/current-user.js';
import { connect, createTestUser, describeIfDatabase, seedBookableSlot } from './integration-setup.js';

/**
 * Correction 1 — le PATCH d'un prospect renvoyait l'état d'AVANT la mise à
 * jour : la lecture qui construit la réponse se faisait hors transaction,
 * avec un `limit: 1` sans filtre sur le prospect concerné. Pire, si cette
 * relecture ne trouvait rien, le handler levait un 404 qui déclenchait le
 * rollback de l'écriture déjà faite. Voir `docs/audit-parcours.md`, section
 * « Le PATCH d'un prospect renvoie l'état d'avant ».
 */
describeIfDatabase('BusinessService.updateLead', () => {
  function fakeLogger(): Logger {
    const noop = (): void => {};
    const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop };
    return { ...logger, child: () => logger } as unknown as Logger;
  }

  let db: ReturnType<typeof connect>['db'];
  let close: ReturnType<typeof connect>['close'];
  let service: BusinessService;
  let events: DomainEvents;
  let actorUserId: string;
  const clock: Clock = { now: () => new Date('2026-08-16T10:00:00Z') };

  beforeAll(async () => {
    ({ db, close } = connect());
    events = new DomainEvents(fakeLogger());
    const audit = new AuditService(db);
    service = new BusinessService(db, clock, audit, events);

    // `audit_logs.actor_id` carries a foreign key to `users`: a fabricated
    // UUID with no row behind it makes every write fail on the audit insert
    // rather than exercise the behaviour under test.
    const actor = await createTestUser(db);
    actorUserId = actor.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM audit_logs WHERE actor_id = ${actorUserId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${actorUserId}`);
    await close();
  });

  async function seedLead(): Promise<{ leadId: string; businessId: string; cleanup: () => Promise<void> }> {
    const slot = await seedBookableSlot(db, { capacity: 5 });
    const user = await createTestUser(db);

    const [reservation] = await db
      .insert(schema.reservations)
      .values({
        userId: user.id,
        slotId: slot.slotId,
        offerId: slot.offerId,
        venueId: slot.venueId,
        businessId: slot.businessId,
        status: 'CONFIRMED',
        priceAmount: 0,
        currency: 'EUR',
        trialRule: 'NO_RESTRICTION',
        slotStartAt: new Date(Date.now() + 7 * 86_400_000),
        slotEndAt: new Date(Date.now() + 7 * 86_400_000 + 3_600_000),
      })
      .returning();

    const [lead] = await db
      .insert(schema.leads)
      .values({
        businessId: slot.businessId,
        venueId: slot.venueId,
        offerId: slot.offerId,
        userId: user.id,
        reservationId: reservation!.id,
        status: 'NEW',
        currency: 'EUR',
      })
      .returning();

    return {
      leadId: lead!.id,
      businessId: slot.businessId,
      cleanup: async () => {
        await db.execute(sql`DELETE FROM leads WHERE id = ${lead!.id}`);
        await db.execute(sql`DELETE FROM reservations WHERE id = ${reservation!.id}`);
        await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
        await slot.cleanup();
      },
    };
  }

  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()!;
      await cleanup();
    }
  });

  function actorFor(businessId: string): AuthenticatedUser {
    return {
      id: actorUserId,
      role: 'BUSINESS',
      businessMemberships: [{ businessId, role: 'MANAGER' }],
    } as unknown as AuthenticatedUser;
  }

  it("renvoie le statut APRÈS écriture, pas celui d'avant", async () => {
    const { leadId, businessId, cleanup } = await seedLead();
    cleanups.push(cleanup);
    const actor = actorFor(businessId);

    const response = await service.updateLead({
      actor,
      businessId,
      leadId,
      dto: { status: 'CONVERTED' },
    });

    // Avant la correction, ceci lisait encore "NEW" — la réponse était bâtie
    // par une seconde requête hors transaction, avec un `limit: 1` sans filtre
    // sur le prospect concerné.
    expect(response.status).toBe('CONVERTED');
    expect(response.id).toBe(leadId);

    const [persisted] = await db
      .select({ status: schema.leads.status })
      .from(schema.leads)
      .where(sql`${schema.leads.id} = ${leadId}`);
    expect(persisted?.status).toBe('CONVERTED');
  });

  it("n'annule jamais une écriture réussie derrière un 404 sur un prospect existant", async () => {
    const { leadId, businessId, cleanup } = await seedLead();
    cleanups.push(cleanup);
    const actor = actorFor(businessId);

    await expect(
      service.updateLead({ actor, businessId, leadId, dto: { status: 'CONTACTED' } }),
    ).resolves.toMatchObject({ status: 'CONTACTED' });

    await expect(
      service.updateLead({ actor, businessId, leadId, dto: { status: 'CONVERTED' } }),
    ).resolves.toMatchObject({ status: 'CONVERTED' });

    const [persisted] = await db
      .select({ status: schema.leads.status })
      .from(schema.leads)
      .where(sql`${schema.leads.id} = ${leadId}`);
    expect(persisted?.status).toBe('CONVERTED');
  });

  it(
    "un second prospect de la même salle, mis à jour plus récemment, ne provoque ni 404 " +
      "ni perte de l'écriture sur le prospect ciblé",
    async () => {
      // Reproduit le défaut d'origine : la relecture finale interrogeait
      // `listLeads(businessId, { limit: 1 })`, trié par `desc(updatedAt)`, sans
      // filtrer sur le prospect concerné. Dès qu'un AUTRE prospect de la même
      // salle avait un `updatedAt` plus récent, `items.find()` échouait, le
      // handler levait un 404 *dans* la transaction, et le rollback emportait
      // l'écriture pourtant réussie sur le bon prospect.
      const target = await seedLead();
      cleanups.push(target.cleanup);
      const other = await seedLead();
      cleanups.push(other.cleanup);

      // `other` doit appartenir à la MÊME salle que `target` pour reproduire le
      // bug (l'ancienne relecture filtrait uniquement sur businessId).
      await db
        .update(schema.leads)
        .set({ businessId: target.businessId })
        .where(sql`${schema.leads.id} = ${other.leadId}`);

      // `other` doit rester en tête du tri `desc(updatedAt)` quoi qu'il arrive
      // — y compris devant le `updatedAt` que `target` vient de recevoir à
      // l'instant de sa création (horloge RÉELLE du serveur de test, pas
      // l'horloge figée du service). D'où une date loin dans le futur plutôt
      // qu'une valeur calée sur l'horloge mockée à 2026-08-16T10:00:00Z.
      await db
        .update(schema.leads)
        .set({ updatedAt: new Date('2099-01-01T00:00:00Z') })
        .where(sql`${schema.leads.id} = ${other.leadId}`);

      const actor = actorFor(target.businessId);

      const response = await service.updateLead({
        actor,
        businessId: target.businessId,
        leadId: target.leadId,
        dto: { status: 'CONTACTED' },
      });

      expect(response.id).toBe(target.leadId);
      expect(response.status).toBe('CONTACTED');

      const [persisted] = await db
        .select({ status: schema.leads.status })
        .from(schema.leads)
        .where(sql`${schema.leads.id} = ${target.leadId}`);
      expect(persisted?.status).toBe('CONTACTED');
    },
  );

  it('un prospect inexistant lève un 404 (comportement inchangé)', async () => {
    const { leadId, businessId, cleanup } = await seedLead();
    cleanups.push(cleanup);
    const actor = actorFor(businessId);

    await expect(
      service.updateLead({
        actor,
        businessId,
        leadId: '00000000-0000-0000-0000-000000000000',
        dto: { status: 'CONTACTED' },
      }),
    ).rejects.toMatchObject({ status: 404 });

    // Et le prospect qui existe réellement n'a pas été touché par cet appel.
    const [persisted] = await db
      .select({ status: schema.leads.status })
      .from(schema.leads)
      .where(sql`${schema.leads.id} = ${leadId}`);
    expect(persisted?.status).toBe('NEW');
  });

  it("émet LeadConverted exactement une fois pour une vraie conversion, jamais pour une mise à jour qui n'en est pas une", async () => {
    // `updateLead` émet APRÈS que sa transaction a commit, jamais depuis
    // l'intérieur — voir la section « Emit after COMMIT » de domain-events.ts.
    // Ce test vérifie seulement qu'il part bien, une fois, au bon déclencheur ;
    // l'ordre commit/emit lui-même est couvert par
    // domain-events-after-commit.integration.test.ts.
    const { leadId, businessId, cleanup } = await seedLead();
    cleanups.push(cleanup);
    const actor = actorFor(businessId);

    const received: { leadId: string; businessId: string }[] = [];
    const handler = (payload: { leadId: string; businessId: string }): void => {
      received.push(payload);
    };
    events.on('LeadConverted', handler);

    await service.updateLead({ actor, businessId, leadId, dto: { status: 'CONTACTED' } });
    expect(received).toHaveLength(0);

    await service.updateLead({ actor, businessId, leadId, dto: { status: 'CONVERTED' } });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ leadId, businessId });

    // Re-marquer CONVERTED un prospect déjà CONVERTED n'est pas une nouvelle
    // conversion — `becomingConverted` doit rester faux.
    await service.updateLead({ actor, businessId, leadId, dto: { status: 'CONVERTED' } });
    expect(received).toHaveLength(1);
  });
});
