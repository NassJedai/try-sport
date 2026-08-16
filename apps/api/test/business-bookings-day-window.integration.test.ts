import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Clock } from '@try/utils';
import type { Logger } from '@try/logger';
import { AuditService } from '../src/modules/admin/audit.service.js';
import { DomainEvents } from '../src/modules/events/domain-events.js';
import { BusinessService } from '../src/modules/business/business.service.js';
import { connect, createTestUser, describeIfDatabase, seedBookableSlot } from './integration-setup.js';

/**
 * Correction 2 — le fenêtrage d'une journée dans `listBookings` était de 36h
 * en dur, sans résolution de fuseau, ce qui faisait chevaucher deux journées
 * consécutives de 12h et comptait la même réservation deux fois. Voir
 * `docs/audit-parcours.md`, section « Une réservation de demain s'affiche
 * sous "Aujourd'hui" » et `business.service.ts:200-235`.
 */
describeIfDatabase('BusinessService.listBookings — fenêtrage de la journée', () => {
  function fakeLogger(): Logger {
    const noop = (): void => {};
    const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop };
    return { ...logger, child: () => logger } as unknown as Logger;
  }

  let db: ReturnType<typeof connect>['db'];
  let close: ReturnType<typeof connect>['close'];
  let service: BusinessService;

  beforeAll(() => {
    ({ db, close } = connect());
    const audit = new AuditService(db);
    const events = new DomainEvents(fakeLogger());
    const clock: Clock = { now: () => new Date() };
    service = new BusinessService(db, clock, audit, events);
  });

  afterAll(async () => {
    await close();
  });

  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  async function seedReservationAt(
    slotStartAt: Date,
    timeZone: string,
  ): Promise<{ businessId: string; venueId: string; reservationId: string }> {
    const slot = await seedBookableSlot(db, { capacity: 5 });
    await db
      .update(schema.venues)
      .set({ timeZone })
      .where(eq(schema.venues.id, slot.venueId));

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
        slotStartAt,
        slotEndAt: new Date(slotStartAt.getTime() + 3_600_000),
      })
      .returning();

    cleanups.push(async () => {
      await db.execute(sql`DELETE FROM reservations WHERE id = ${reservation!.id}`);
      await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
      await slot.cleanup();
    });

    return { businessId: slot.businessId, venueId: slot.venueId, reservationId: reservation!.id };
  }

  it('deux journées consécutives ne se chevauchent jamais : une réservation à 05:00 UTC (07:00 Bruxelles) le 17 août n\'apparaît que le 17', async () => {
    const { businessId } = await seedReservationAt(new Date('2026-08-17T05:00:00Z'), 'Europe/Brussels');

    const day16 = await service.listBookings(businessId, {
      limit: 50,
      status: undefined,
      venueId: undefined,
      date: '2026-08-16',
    });
    const day17 = await service.listBookings(businessId, {
      limit: 50,
      status: undefined,
      venueId: undefined,
      date: '2026-08-17',
    });

    expect(day16.items).toHaveLength(0);
    expect(day17.items).toHaveLength(1);
  });

  it('une réservation à 23:30 locale reste dans sa journée, pas le lendemain', async () => {
    // 23:30 à Bruxelles en août (UTC+2) == 21:30 UTC.
    const { businessId } = await seedReservationAt(new Date('2026-08-16T21:30:00Z'), 'Europe/Brussels');

    const day16 = await service.listBookings(businessId, {
      limit: 50,
      status: undefined,
      venueId: undefined,
      date: '2026-08-16',
    });
    const day17 = await service.listBookings(businessId, {
      limit: 50,
      status: undefined,
      venueId: undefined,
      date: '2026-08-17',
    });

    expect(day16.items).toHaveLength(1);
    expect(day17.items).toHaveLength(0);
  });

  it('une réservation à 00:30 locale reste dans sa journée, pas la veille', async () => {
    // 00:30 à Bruxelles le 16 août, en août (UTC+2) == 2026-08-15T22:30:00Z.
    // (Le calcul inverse — ajouter l'offset au lieu de le retrancher — pousse
    // silencieusement l'instant sur le jour SUIVANT ; c'est cette erreur qui
    // faisait échouer ce test avant correction.)
    const { businessId } = await seedReservationAt(new Date('2026-08-15T22:30:00Z'), 'Europe/Brussels');

    const day15 = await service.listBookings(businessId, {
      limit: 50,
      status: undefined,
      venueId: undefined,
      date: '2026-08-15',
    });
    const day16 = await service.listBookings(businessId, {
      limit: 50,
      status: undefined,
      venueId: undefined,
      date: '2026-08-16',
    });

    expect(day15.items).toHaveLength(0);
    expect(day16.items).toHaveLength(1);
  });

  it('passage à l\'heure d\'été : le dimanche de mars (journée de 23h) garde un cours de 19:00 locale dans sa journée', async () => {
    // Dernier dimanche de mars 2026 = 29 mars. 19:00 locale ce jour-là est déjà
    // en heure d'été (UTC+2) => 17:00 UTC.
    const { businessId } = await seedReservationAt(new Date('2026-03-29T17:00:00Z'), 'Europe/Brussels');

    const dayOf = await service.listBookings(businessId, {
      limit: 50,
      status: undefined,
      venueId: undefined,
      date: '2026-03-29',
    });
    const dayAfter = await service.listBookings(businessId, {
      limit: 50,
      status: undefined,
      venueId: undefined,
      date: '2026-03-30',
    });

    expect(dayOf.items).toHaveLength(1);
    expect(dayAfter.items).toHaveLength(0);
  });

  it('passage à l\'heure d\'hiver : le dimanche d\'octobre (journée de 25h) garde un cours de 19:00 locale dans sa journée', async () => {
    // Dernier dimanche d'octobre 2026 = 25 octobre. 19:00 locale ce jour-là est
    // déjà repassée en heure d'hiver (UTC+1) => 18:00 UTC.
    const { businessId } = await seedReservationAt(new Date('2026-10-25T18:00:00Z'), 'Europe/Brussels');

    const dayOf = await service.listBookings(businessId, {
      limit: 50,
      status: undefined,
      venueId: undefined,
      date: '2026-10-25',
    });
    const dayBefore = await service.listBookings(businessId, {
      limit: 50,
      status: undefined,
      venueId: undefined,
      date: '2026-10-24',
    });
    const dayAfter = await service.listBookings(businessId, {
      limit: 50,
      status: undefined,
      venueId: undefined,
      date: '2026-10-26',
    });

    expect(dayOf.items).toHaveLength(1);
    expect(dayBefore.items).toHaveLength(0);
    expect(dayAfter.items).toHaveLength(0);
  });

  it("la branche par défaut (sans `date`) désigne la journée locale COURANTE de la salle", async () => {
    const fixedNow = new Date('2026-08-16T10:00:00Z'); // 12:00 à Bruxelles
    const audit = new AuditService(db);
    const events = new DomainEvents(fakeLogger());
    const clockToday: Clock = { now: () => fixedNow };
    const serviceToday = new BusinessService(db, clockToday, audit, events);

    // Une réservation ce même jour, à 07:00 locale (05:00 UTC) — avant l'appel,
    // donc dans "aujourd'hui" au sens du serveur.
    const { businessId } = await seedReservationAt(new Date('2026-08-16T05:00:00Z'), 'Europe/Brussels');

    const noDate = await serviceToday.listBookings(businessId, {
      limit: 50,
      status: undefined,
      venueId: undefined,
      date: undefined,
    });
    const explicitToday = await serviceToday.listBookings(businessId, {
      limit: 50,
      status: undefined,
      venueId: undefined,
      date: '2026-08-16',
    });

    expect(noDate.items).toHaveLength(1);
    expect(noDate.items.map((item) => item.id)).toEqual(explicitToday.items.map((item) => item.id));
  });
});
