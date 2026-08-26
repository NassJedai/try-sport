import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { schema } from '@try/database';
import { InvalidReservationTransitionError } from '@try/contracts';
import { ScheduleService } from '../src/modules/scheduling/schedule.service.js';
import { connect, createTestUser, describeIfDatabase, seedBookableSlot } from './integration-setup.js';

/**
 * Ce que ce test protège : quand une salle annule une séance, les inscrits
 * récupèrent tout — leur place, leur essai, et une réservation proprement close.
 *
 * Il existe parce que la première annulation réelle a rendu une 500 : le motif
 * `= ANY(${tableau})` explosait au premier inscrit. Zéro inscrit → aucun
 * tableau → aucun crash : le chemin n'était vert que tant qu'il était vide.
 * C'est exactement le genre de test qui doit contenir des données.
 */
describeIfDatabase('annulation de créneau par la salle', () => {
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

  it('libère la réservation ET l\x27essai de chaque inscrit', async () => {
    const seed = await seedBookableSlot(ctx.db, { capacity: 5 });
    const user = await createTestUser(ctx.db);

    const [reservation] = await ctx.db
      .insert(schema.reservations)
      .values({
        userId: user.id,
        slotId: seed.slotId,
        offerId: seed.offerId,
        venueId: seed.venueId,
        businessId: seed.businessId,
        status: 'CONFIRMED',
        priceAmount: 0,
        trialRule: 'ONE_TRIAL_PER_VENUE',
        slotStartAt: new Date(Date.now() + 86_400_000),
        slotEndAt: new Date(Date.now() + 86_400_000 + 3_600_000),
      })
      .returning({ id: schema.reservations.id });

    // L'essai consommé par cette réservation — ce que l'utilisateur doit
    // récupérer, sinon la salle qui annule lui coûte sa seule chance d'essayer.
    await ctx.db.insert(schema.trialHistory).values({
      userId: user.id,
      businessId: seed.businessId,
      venueId: seed.venueId,
      offerId: seed.offerId,
      reservationId: reservation!.id,
      reservedAt: new Date(),
      status: 'CONFIRMED',
      trialRule: 'ONE_TRIAL_PER_VENUE',
    });

    pending.push(async () => {
      await ctx.db.execute(sql`DELETE FROM trial_history WHERE reservation_id = ${reservation!.id}`);
      await seed.cleanup();
      await ctx.db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    });

    const service = new ScheduleService(
      ctx.db,
      { now: () => new Date() } as never,
      silentLogger as never,
    );

    const result = await service.cancelSlot({
      actor: {
        id: user.id,
        role: 'USER',
        memberships: [{ businessId: seed.businessId, role: 'OWNER' }],
      } as never,
      slotId: seed.slotId,
      reason: 'Fermeture exceptionnelle — test',
    });

    expect(result.affectedReservations).toBe(1);

    const [slot] = await ctx.db.execute(
      sql`SELECT status FROM slots WHERE id = ${seed.slotId}`,
    );
    const [booking] = await ctx.db.execute(
      sql`SELECT status FROM reservations WHERE id = ${reservation!.id}`,
    );
    const [trial] = await ctx.db.execute(
      sql`SELECT status FROM trial_history WHERE reservation_id = ${reservation!.id}`,
    );

    expect(slot!.status).toBe('CANCELLED');
    expect(booking!.status).toBe('CANCELLED_BUSINESS');
    // L'essai est rendu : il ne compte plus contre ONE_TRIAL_PER_VENUE.
    expect(trial!.status).toBe('CANCELLED_BUSINESS');
  });

  /**
   * PENDING → CANCELLED_BUSINESS n'a jamais figuré dans la machine à états
   * (reservation-state-machine.ts) : seuls PAYMENT_PENDING et CONFIRMED le
   * peuvent, pour l'acteur BUSINESS. `cancelSlot` écrivait pourtant ce statut
   * sans jamais passer par `assertTransition`, avec `WHERE status IN
   * ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED')` — une transition interdite
   * restait représentable dans ce seul chemin. Aucun code applicatif n'écrit
   * PENDING aujourd'hui (BookingService.create() saute directement à
   * PAYMENT_PENDING ou CONFIRMED), donc ce test force l'état à la main pour
   * prouver la garde plutôt que d'attendre un chemin qui n'existe pas encore.
   */
  it(
    "refuse d'annuler une réservation PENDING — transition interdite, pas juste inatteinte",
    async () => {
      const seed = await seedBookableSlot(ctx.db, { capacity: 5 });
      const user = await createTestUser(ctx.db);

      const [reservation] = await ctx.db
        .insert(schema.reservations)
        .values({
          userId: user.id,
          slotId: seed.slotId,
          offerId: seed.offerId,
          venueId: seed.venueId,
          businessId: seed.businessId,
          status: 'PENDING',
          priceAmount: 0,
          trialRule: 'NO_RESTRICTION',
          slotStartAt: new Date(Date.now() + 86_400_000),
          slotEndAt: new Date(Date.now() + 86_400_000 + 3_600_000),
        })
        .returning({ id: schema.reservations.id });

      pending.push(async () => {
        await ctx.db.execute(sql`DELETE FROM reservations WHERE id = ${reservation!.id}`);
        await seed.cleanup();
        await ctx.db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
      });

      const service = new ScheduleService(
        ctx.db,
        { now: () => new Date() } as never,
        silentLogger as never,
      );

      await expect(
        service.cancelSlot({
          actor: {
            id: user.id,
            role: 'USER',
            memberships: [{ businessId: seed.businessId, role: 'OWNER' }],
          } as never,
          slotId: seed.slotId,
          reason: 'Fermeture exceptionnelle — test',
        }),
      ).rejects.toBeInstanceOf(InvalidReservationTransitionError);

      // La transaction entière a été annulée : ni le créneau ni la
      // réservation ne bougent — pas un succès partiel qui aurait ignoré la
      // seule ligne invalide.
      const [slot] = await ctx.db.execute(sql`SELECT status FROM slots WHERE id = ${seed.slotId}`);
      const [booking] = await ctx.db.execute(
        sql`SELECT status FROM reservations WHERE id = ${reservation!.id}`,
      );
      expect(slot!.status).toBe('OPEN');
      expect(booking!.status).toBe('PENDING');
    },
  );
});
