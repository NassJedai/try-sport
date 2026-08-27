import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@try/database';
import { InvalidReservationTransitionError } from '@try/contracts';
import type { ReservationStatus } from '@try/contracts';
import { ApiException } from '../src/common/errors/api-exception.js';
import { AuditService } from '../src/modules/admin/audit.service.js';
import { DomainEvents } from '../src/modules/events/domain-events.js';
import { BookingService, NO_SHOW_MANUAL_CUTOFF_HOURS } from '../src/modules/bookings/booking.service.js';
import { connect, createTestUser, describeIfDatabase, seedBookableSlot } from './integration-setup.js';

/**
 * `BookingService.markNoShow` — le geste manuel par lequel un membre de
 * l'établissement déclare qu'un client n'est pas venu, sans attendre le sweep
 * horaire (`LifecycleJobsService.markNoShows`). Voir le commentaire de
 * `markNoShow` pour l'alignement complet entre les deux chemins.
 */
describeIfDatabase('BookingService.markNoShow — déclaration manuelle d’une absence', () => {
  let ctx: ReturnType<typeof connect>;
  let audit: AuditService;
  const pending: Array<() => Promise<void>> = [];

  beforeAll(() => {
    ctx = connect();
    audit = new AuditService(ctx.db);
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

  function service(now: Date): BookingService {
    const events = new DomainEvents(silentLogger as never);
    return new BookingService(
      ctx.db,
      { now: () => now } as never,
      silentLogger as never,
      // Ni le hachage de token ni Stripe ne sont sollicités par markNoShow.
      {} as never,
      {} as never,
      events,
      audit,
    );
  }

  /** Crée une réservation dans le statut et l'horaire de fin voulus, avec son historique d'essai. */
  async function seedReservation(options: {
    status: ReservationStatus;
    slotEndAt: Date;
    existingBusiness?: { businessId: string; cityId: string };
  }): Promise<{
    reservationId: string;
    businessId: string;
    venueId: string;
    slotId: string;
    userId: string;
  }> {
    const seed = await seedBookableSlot(ctx.db, {
      capacity: 5,
      existingBusiness: options.existingBusiness,
    });
    const user = await createTestUser(ctx.db);
    const slotStartAt = new Date(options.slotEndAt.getTime() - 3_600_000);

    const [reservation] = await ctx.db
      .insert(schema.reservations)
      .values({
        userId: user.id,
        slotId: seed.slotId,
        offerId: seed.offerId,
        venueId: seed.venueId,
        businessId: seed.businessId,
        status: options.status,
        priceAmount: 0,
        trialRule: 'ONE_TRIAL_PER_VENUE',
        slotStartAt,
        slotEndAt: options.slotEndAt,
      })
      .returning({ id: schema.reservations.id });

    // `seedBookableSlot` part de reservedCount=0 ; le porter à 1 simule une
    // place réellement occupée, pour vérifier que markNoShow ne la libère pas.
    await ctx.db
      .update(schema.slots)
      .set({ reservedCount: 1 })
      .where(eq(schema.slots.id, seed.slotId));

    await ctx.db.insert(schema.trialHistory).values({
      userId: user.id,
      businessId: seed.businessId,
      venueId: seed.venueId,
      offerId: seed.offerId,
      reservationId: reservation!.id,
      reservedAt: new Date(),
      status: options.status,
      trialRule: 'ONE_TRIAL_PER_VENUE',
    });

    pending.push(async () => {
      await ctx.db.execute(sql`DELETE FROM audit_logs WHERE entity_id = ${reservation!.id}`);
      await ctx.db.execute(sql`DELETE FROM trial_history WHERE reservation_id = ${reservation!.id}`);
      await ctx.db.execute(sql`DELETE FROM reservations WHERE id = ${reservation!.id}`);
      if (!options.existingBusiness) await seed.cleanup();
      await ctx.db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    });

    return {
      reservationId: reservation!.id,
      businessId: seed.businessId,
      venueId: seed.venueId,
      slotId: seed.slotId,
      userId: user.id,
    };
  }

  function staffActor(businessId: string, userId = 'staff-user'): unknown {
    return {
      id: userId,
      role: 'USER',
      memberships: [{ businessId, role: 'STAFF' }],
    };
  }

  it('cas nominal : une réservation CONFIRMED devient NO_SHOW, l’essai reste consommé, le geste est audité', async () => {
    const now = new Date();
    const slotEndAt = new Date(now.getTime() - 30 * 60_000); // séance finie il y a 30 minutes
    const seeded = await seedReservation({ status: 'CONFIRMED', slotEndAt });

    const svc = service(now);
    const result = await svc.markNoShow({
      actor: staffActor(seeded.businessId, seeded.userId) as never,
      reservationId: seeded.reservationId,
    });

    expect(result).toEqual({ reservationId: seeded.reservationId, status: 'NO_SHOW' });

    const [reservation] = await ctx.db
      .select({ status: schema.reservations.status })
      .from(schema.reservations)
      .where(eq(schema.reservations.id, seeded.reservationId));
    expect(reservation!.status).toBe('NO_SHOW');

    const [trial] = await ctx.db
      .select({ status: schema.trialHistory.status })
      .from(schema.trialHistory)
      .where(eq(schema.trialHistory.reservationId, seeded.reservationId));
    // L'essai reste consommé — NO_SHOW compte contre l'allocation (reservation-state-machine.ts).
    expect(trial!.status).toBe('NO_SHOW');

    const [slot] = await ctx.db
      .select({ reservedCount: schema.slots.reservedCount })
      .from(schema.slots)
      .where(eq(schema.slots.id, seeded.slotId));
    // Aucune capacité libérée : la place reste comptée, la séance est déjà passée.
    expect(slot!.reservedCount).toBe(1);

    const [entry] = await ctx.db
      .select({ action: schema.auditLogs.action, actorType: schema.auditLogs.actorType })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.entityId, seeded.reservationId));
    expect(entry).toMatchObject({ action: 'reservation.no_show', actorType: 'BUSINESS_MEMBER' });
  });

  it("refuse le geste d'un membre d'un autre établissement", async () => {
    const now = new Date();
    const slotEndAt = new Date(now.getTime() - 30 * 60_000);
    const seeded = await seedReservation({ status: 'CONFIRMED', slotEndAt });
    const otherBusiness = await seedBookableSlot(ctx.db, { capacity: 5 });
    pending.push(otherBusiness.cleanup);

    const svc = service(now);

    await expect(
      svc.markNoShow({
        actor: staffActor(otherBusiness.businessId) as never,
        reservationId: seeded.reservationId,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Rien n'a bougé : le refus est total, pas une transition partiellement écrite.
    const [reservation] = await ctx.db
      .select({ status: schema.reservations.status })
      .from(schema.reservations)
      .where(eq(schema.reservations.id, seeded.reservationId));
    expect(reservation!.status).toBe('CONFIRMED');
  });

  it("refuse depuis un statut invalide — transition interdite, pas juste inhabituelle", async () => {
    const now = new Date();
    const slotEndAt = new Date(now.getTime() - 30 * 60_000);
    // Déjà annulée par l'utilisateur : CANCELLED_USER -> NO_SHOW n'existe pas
    // dans la table (reservation-state-machine.ts).
    const seeded = await seedReservation({ status: 'CANCELLED_USER', slotEndAt });

    const svc = service(now);

    await expect(
      svc.markNoShow({
        actor: staffActor(seeded.businessId, seeded.userId) as never,
        reservationId: seeded.reservationId,
      }),
    ).rejects.toBeInstanceOf(InvalidReservationTransitionError);

    const [reservation] = await ctx.db
      .select({ status: schema.reservations.status })
      .from(schema.reservations)
      .where(eq(schema.reservations.id, seeded.reservationId));
    expect(reservation!.status).toBe('CANCELLED_USER');
  });

  it('refuse tant que la séance n’est pas terminée', async () => {
    const now = new Date();
    const slotEndAt = new Date(now.getTime() + 30 * 60_000); // finit dans 30 minutes
    const seeded = await seedReservation({ status: 'CONFIRMED', slotEndAt });

    const svc = service(now);

    const error: unknown = await svc
      .markNoShow({
        actor: staffActor(seeded.businessId, seeded.userId) as never,
        reservationId: seeded.reservationId,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('CONFLICT');
    expect((error as ApiException).context).toMatchObject({ reason: 'SESSION_NOT_OVER' });

    const [reservation] = await ctx.db
      .select({ status: schema.reservations.status })
      .from(schema.reservations)
      .where(eq(schema.reservations.id, seeded.reservationId));
    expect(reservation!.status).toBe('CONFIRMED');
  });

  it('refuse une fois le délai dépassé — au-delà, c’est le sweep automatique ou une correction admin', async () => {
    const now = new Date();
    const slotEndAt = new Date(
      now.getTime() - (NO_SHOW_MANUAL_CUTOFF_HOURS * 3_600_000 + 60_000),
    ); // une minute au-delà de la même borne que l'automate
    const seeded = await seedReservation({ status: 'CONFIRMED', slotEndAt });

    const svc = service(now);

    const error: unknown = await svc
      .markNoShow({
        actor: staffActor(seeded.businessId, seeded.userId) as never,
        reservationId: seeded.reservationId,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('CONFLICT');
    expect((error as ApiException).context).toMatchObject({ reason: 'NO_SHOW_WINDOW_CLOSED' });

    const [reservation] = await ctx.db
      .select({ status: schema.reservations.status })
      .from(schema.reservations)
      .where(eq(schema.reservations.id, seeded.reservationId));
    expect(reservation!.status).toBe('CONFIRMED');
  });
});
