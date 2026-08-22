import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import { SystemClock, generateCheckInCode } from '@try/utils';
import type { Logger } from '@try/logger';
import type { AppConfig } from '@try/config';
import { BookingService } from '../src/modules/bookings/booking.service.js';
import { CheckInService } from '../src/modules/checkins/checkin.service.js';
import { BusinessService } from '../src/modules/business/business.service.js';
import { ReviewService } from '../src/modules/reviews/review.service.js';
import { AuditService } from '../src/modules/admin/audit.service.js';
import { CryptoService } from '../src/common/crypto.service.js';
import { DomainEvents } from '../src/modules/events/domain-events.js';
import type { PaymentService } from '../src/modules/payments/payment.service.js';
import type { AuthenticatedUser } from '../src/common/auth/current-user.js';
import {
  connect,
  createTestUser,
  describeIfDatabase,
  seedBookableSlot,
} from './integration-setup.js';

/**
 * Domain events must be emitted *after* COMMIT, never from inside the
 * transaction callback that produced them.
 *
 * `DomainEvents.on` wraps every handler in `void (async () => …)()`, and an
 * async body runs synchronously up to its first `await` — so an async
 * handler's opening database read is issued *during* the `emit` call. From
 * inside a `db.transaction(...)` callback that read goes out before the
 * COMMIT is even sent, through the pool, on a connection that cannot see
 * uncommitted rows. `BookingLifecycleListener.sendConfirmation` used to treat
 * a missing row as nothing to do, so the confirmation email disappeared with
 * no error and no log for every free booking — see `domain-events.ts` for the
 * full mechanism.
 *
 * Two techniques are used below, deliberately not one:
 *
 *   1. `trackTransactionOrder` monkey-patches `db.transaction` for the
 *      duration of one test to record, synchronously, whether the promise
 *      returned by the *outer* `db.transaction(...)` call has settled at the
 *      moment a `DomainEvents` handler runs. This is checked against the real
 *      service, calling the real transaction — but it proves *ordering*, not
 *      wall-clock timing, so it cannot be racy: JS is single-threaded, and
 *      the flag can only flip after the awaited promise resolves. A test
 *      built this way fails every single time the emit moves back inside the
 *      callback, not 4 times out of 5.
 *
 *   2. The last test reproduces the old, broken ordering by hand (no service
 *      code involved) and reads the row back exactly the way a real listener
 *      would, through the pool. It forces the transaction to stay open until
 *      the handler has finished reading — no `setTimeout`, no lucky
 *      scheduling — so it deterministically shows *why* the ordering matters:
 *      the handler's read genuinely misses an uncommitted row, not just
 *      "sometimes, if the network is fast enough".
 *
 * An earlier version of this file used only technique 2, but applied it to
 * calls into the *real* `BookingService` without forcing the hold. Run five
 * times against the code before this fix, it failed once — the confirmation
 * email bug is real but intermittent at localhost latencies, so a test that
 * merely `await`s the real service and hopes the COMMIT loses the race is not
 * a trustworthy regression guard. That is why every "does the real service
 * behave" test below uses technique 1 instead.
 */
describeIfDatabase('domain events are emitted after COMMIT, not from inside the transaction', () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(() => {
    ({ db, close } = connect());
  });

  afterAll(async () => {
    await close();
  });

  function fakeLogger(): Logger {
    const noop = (): void => {};
    const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop };
    return { ...logger, child: () => logger } as unknown as Logger;
  }
  const silentLogger = fakeLogger();

  /**
   * Monkey-patches `db.transaction` on the shared connection, for the
   * duration of one test, to record whether the *outer* call has already
   * resolved at the instant a `DomainEvents` handler runs.
   *
   * Deliberately not a `Proxy` over the whole `db` object: drizzle's instance
   * relies on private class fields internally, and a `Proxy` that does not
   * rebind every forwarded method to the original target breaks on the first
   * call with "cannot read private member from an object whose class did not
   * declare it". Reassigning the single `transaction` own property, bound to
   * the original instance, sidesteps that entirely.
   *
   * `settled` flips to `false` the instant `.transaction(...)` is invoked and
   * to `true` only once the awaited promise has settled — i.e. once the
   * COMMIT (or ROLLBACK) has already been sent and acknowledged. Reading it
   * from inside a synchronous `DomainEvents` handler is therefore an exact,
   * non-racy answer to "had the transaction that produced this event already
   * finished when it was emitted?".
   */
  function trackTransactionOrder(target: Database): {
    hasSettled: () => boolean;
    restore: () => void;
  } {
    const original = target.transaction.bind(target);
    let settled = false;

    Object.assign(target, {
      transaction: async (...args: Parameters<typeof original>) => {
        settled = false;
        try {
          return await original(...args);
        } finally {
          settled = true;
        }
      },
    });

    return {
      hasSettled: () => settled,
      restore: () => {
        Object.assign(target, { transaction: original });
      },
    };
  }

  function buildBookingService(events: DomainEvents): BookingService {
    return new BookingService(
      db,
      new SystemClock(),
      silentLogger,
      new CryptoService({ CHECKIN_TOKEN_SECRET: 'integration-test-secret' } as AppConfig),
      {} as PaymentService,
      events,
    );
  }

  it('BookingService.create emits BookingConfirmed only once its transaction has settled', async () => {
    const slot = await seedBookableSlot(db, { capacity: 1, priceAmount: 0 });
    const user = await createTestUser(db);
    const events = new DomainEvents(silentLogger);
    const tracker = trackTransactionOrder(db);

    let settledAtEmit: boolean | undefined;
    events.on('BookingConfirmed', (payload) => {
      settledAtEmit = tracker.hasSettled();
      void payload;
    });

    try {
      const result = await buildBookingService(events).create({
        userId: user.id,
        dto: { slotId: slot.slotId },
      });

      expect(result.status).toBe('CONFIRMED');
      // If this is `false`, the emit happened from inside the transaction
      // callback — the exact defect this whole file guards against.
      expect(settledAtEmit).toBe(true);
    } finally {
      tracker.restore();
      await db.execute(sql`DELETE FROM trial_history WHERE user_id = ${user.id}`);
      await db.execute(sql`DELETE FROM reservations WHERE user_id = ${user.id}`);
      await slot.cleanup();
      await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    }
  });

  it('BookingService.cancel emits BookingCancelled only once its transaction has settled', async () => {
    const slot = await seedBookableSlot(db, { capacity: 1, priceAmount: 0 });
    const user = await createTestUser(db);
    const events = new DomainEvents(silentLogger);
    const service = buildBookingService(events);

    const created = await service.create({ userId: user.id, dto: { slotId: slot.slotId } });

    // The tracker is installed only now: `create()` above ran its own
    // transaction, and this test cares about `cancel()`'s alone.
    const tracker = trackTransactionOrder(db);
    let settledAtEmit: boolean | undefined;
    events.on('BookingCancelled', (payload) => {
      settledAtEmit = tracker.hasSettled();
      void payload;
    });

    try {
      const result = await service.cancel({
        reservationId: created.reservationId,
        userId: user.id,
      });

      expect(result.refunded).toBe(false);
      expect(settledAtEmit).toBe(true);
    } finally {
      tracker.restore();
      await db.execute(sql`DELETE FROM trial_history WHERE user_id = ${user.id}`);
      await db.execute(sql`DELETE FROM reservations WHERE user_id = ${user.id}`);
      await slot.cleanup();
      await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    }
  });

  it('CheckInService.checkIn emits CheckInCompleted only once its transaction has settled', async () => {
    const slot = await seedBookableSlot(db, { capacity: 1, priceAmount: 0 });
    const user = await createTestUser(db);
    const staff = await createTestUser(db);
    const checkInCode = generateCheckInCode();

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
        // Inside the check-in window (opens 60 min before start, closes 120
        // min after end) — see `BookingService.checkInWindow`.
        slotStartAt: new Date(Date.now() + 5 * 60_000),
        slotEndAt: new Date(Date.now() + 65 * 60_000),
        checkInCode,
        confirmedAt: new Date(),
      })
      .returning();

    const events = new DomainEvents(silentLogger);
    const audit = new AuditService(db);
    const service = new CheckInService(
      db,
      new SystemClock(),
      new CryptoService({ CHECKIN_TOKEN_SECRET: 'integration-test-secret' } as AppConfig),
      events,
      audit,
    );
    const actor = {
      id: staff.id,
      role: 'BUSINESS',
      memberships: [{ businessId: slot.businessId, role: 'MANAGER' }],
    } as unknown as AuthenticatedUser;

    const tracker = trackTransactionOrder(db);
    let settledAtEmit: boolean | undefined;
    events.on('CheckInCompleted', (payload) => {
      settledAtEmit = tracker.hasSettled();
      void payload;
    });

    try {
      const result = await service.checkIn({
        actor,
        dto: { venueId: slot.venueId, shortCode: checkInCode, override: false },
      });

      expect(result.status).toBe('CHECKED_IN');
      expect(settledAtEmit).toBe(true);
    } finally {
      tracker.restore();
      await db.execute(sql`DELETE FROM audit_logs WHERE actor_id = ${staff.id}`);
      // Cascades check_ins, leads, trial_history, reviews.
      await db.execute(sql`DELETE FROM reservations WHERE id = ${reservation!.id}`);
      await slot.cleanup();
      await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
      await db.execute(sql`DELETE FROM users WHERE id = ${staff.id}`);
    }
  });

  it("BusinessService.updateLead emits LeadConverted only once its transaction has settled", async () => {
    const slot = await seedBookableSlot(db, { capacity: 1, priceAmount: 0 });
    const user = await createTestUser(db);
    const actorUser = await createTestUser(db);

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

    const events = new DomainEvents(silentLogger);
    const audit = new AuditService(db);
    const service = new BusinessService(db, new SystemClock(), audit, events);
    const actor = {
      id: actorUser.id,
      role: 'BUSINESS',
      memberships: [{ businessId: slot.businessId, role: 'MANAGER' }],
    } as unknown as AuthenticatedUser;

    const tracker = trackTransactionOrder(db);
    let settledAtEmit: boolean | undefined;
    events.on('LeadConverted', (payload) => {
      settledAtEmit = tracker.hasSettled();
      void payload;
    });

    try {
      const result = await service.updateLead({
        actor,
        businessId: slot.businessId,
        leadId: lead!.id,
        dto: { status: 'CONVERTED' },
      });

      expect(result.status).toBe('CONVERTED');
      expect(settledAtEmit).toBe(true);
    } finally {
      tracker.restore();
      await db.execute(sql`DELETE FROM audit_logs WHERE actor_id = ${actorUser.id}`);
      // Cascades leads, trial_history, reviews, check_ins.
      await db.execute(sql`DELETE FROM reservations WHERE id = ${reservation!.id}`);
      await slot.cleanup();
      await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
      await db.execute(sql`DELETE FROM users WHERE id = ${actorUser.id}`);
    }
  });

  it('ReviewService.submit emits TrialCompleted and ReviewSubmitted only once its transaction has settled', async () => {
    const slot = await seedBookableSlot(db, { capacity: 1, priceAmount: 0 });
    const user = await createTestUser(db);

    const [reservation] = await db
      .insert(schema.reservations)
      .values({
        userId: user.id,
        slotId: slot.slotId,
        offerId: slot.offerId,
        venueId: slot.venueId,
        businessId: slot.businessId,
        status: 'CHECKED_IN',
        priceAmount: 0,
        currency: 'EUR',
        trialRule: 'NO_RESTRICTION',
        slotStartAt: new Date(Date.now() - 60 * 60_000),
        slotEndAt: new Date(Date.now() - 5 * 60_000),
        checkedInAt: new Date(Date.now() - 30 * 60_000),
      })
      .returning();

    const events = new DomainEvents(silentLogger);
    const service = new ReviewService(db, new SystemClock(), events);

    const tracker = trackTransactionOrder(db);
    let trialCompletedSettled: boolean | undefined;
    let reviewSubmittedSettled: boolean | undefined;
    events.on('TrialCompleted', (payload) => {
      trialCompletedSettled = tracker.hasSettled();
      void payload;
    });
    events.on('ReviewSubmitted', (payload) => {
      reviewSubmittedSettled = tracker.hasSettled();
      void payload;
    });

    try {
      await service.submit({
        userId: user.id,
        reservationId: reservation!.id,
        dto: { rating: 5, shareWithVenue: false },
      });

      expect(trialCompletedSettled).toBe(true);
      expect(reviewSubmittedSettled).toBe(true);
    } finally {
      tracker.restore();
      // Cascades reviews.
      await db.execute(sql`DELETE FROM reservations WHERE id = ${reservation!.id}`);
      await slot.cleanup();
      await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    }
  });

  /**
   * The negative control, and the reason to trust the tests above.
   *
   * It reproduces the old ordering directly — emit from inside the callback
   * — and pins the failure it caused, using a real Postgres connection and
   * the exact read shape `BookingLifecycleListener.sendConfirmation` uses.
   * The transaction is held open, on purpose, until the handler has finished
   * its read: not a race left to the scheduler, but a forced demonstration
   * that a connection outside the transaction genuinely cannot see the
   * uncommitted row.
   */
  it('shows why: a handler emitted from inside the transaction cannot see the row', async () => {
    const slot = await seedBookableSlot(db, { capacity: 1, priceAmount: 0 });
    const user = await createTestUser(db);
    const events = new DomainEvents(silentLogger);

    async function readBackThroughPool(reservationId: string): Promise<boolean> {
      const [row] = await db
        .select({ status: schema.reservations.status })
        .from(schema.reservations)
        .where(eq(schema.reservations.id, reservationId))
        .limit(1);
      return row !== undefined;
    }

    let settle!: (seen: boolean) => void;
    const handlerRead = new Promise<boolean>((resolve) => {
      settle = resolve;
    });

    events.on('BookingConfirmed', async (payload) => {
      settle(await readBackThroughPool(payload.reservationId));
    });

    let reservationId = '';
    try {
      await db.transaction(async (tx) => {
        const [reservation] = await tx
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
            confirmedAt: new Date(),
          })
          .returning({ id: schema.reservations.id });

        reservationId = reservation!.id;

        // The defect, reproduced exactly: emitting before this callback
        // (and therefore the COMMIT) has resolved.
        events.emit('BookingConfirmed', {
          reservationId,
          userId: user.id,
          businessId: slot.businessId,
          venueId: slot.venueId,
          offerId: slot.offerId,
          isFree: true,
        });

        // Hold the transaction open until the handler has finished its read,
        // so the outcome is forced rather than left to microsecond timing. A
        // plain SELECT does not block on the row lock under MVCC, so this
        // cannot deadlock — the handler simply reads a snapshot without the
        // uncommitted row.
        await handlerRead;
      });

      expect(await handlerRead).toBe(false);

      // The row is perfectly fine once committed. Only the handler's timing
      // was ever wrong — which is what made the dropped email so hard to see.
      expect(await readBackThroughPool(reservationId)).toBe(true);
    } finally {
      await db.execute(sql`DELETE FROM reservations WHERE id = ${reservationId}`);
      await slot.cleanup();
      await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    }
  });
});
