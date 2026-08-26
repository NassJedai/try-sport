import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import { SystemClock } from '@try/utils';
import type { Logger } from '@try/logger';
import type { AuthenticatedUser } from '../src/common/auth/current-user.js';
import { AuditService } from '../src/modules/admin/audit.service.js';
import { ModerationService } from '../src/modules/admin/moderation.service.js';
import { DomainEvents } from '../src/modules/events/domain-events.js';
import { connect, createTestUser, describeIfDatabase, seedBookableSlot } from './integration-setup.js';

/**
 * `moderation.service.ts:overview()` cast `SUM(amount - refunded_amount)` —
 * a `bigint` in Postgres, since `SUM(integer)` always is — down to `::int`.
 * Harmless right up until the *cumulative* total (not any single payment)
 * crosses 2,147,483,647 minor units (€21,474,836.47): past that, the CAST
 * itself raises `integer out of range`, and `GET /v1/admin/overview` 500s in
 * full — not a wrong number, the whole screen. Fixed 2026-08-26.
 *
 * Two payments of 1.2 billion minor units each are enough to cross the
 * threshold on their own regardless of what the rest of the shared
 * integration database already holds — this test asserts on the *delta*
 * `overview()` reports before/after, never on an absolute total.
 */
describeIfDatabase('admin overview — cumul au-delà de int4', () => {
  let db: Database;
  let close: () => Promise<void>;
  let moderation: ModerationService;
  let admin: AuthenticatedUser;

  function fakeLogger(): Logger {
    const noop = (): void => undefined;
    const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop };
    return { ...logger, child: () => logger } as unknown as Logger;
  }

  beforeAll(() => {
    ({ db, close } = connect());
    const logger = fakeLogger();
    const events = new DomainEvents(logger);
    const audit = new AuditService(db);
    moderation = new ModerationService(db, new SystemClock(), logger, audit, events);
    admin = {
      id: 'admin-test',
      email: 'admin@try.local',
      role: 'ADMIN',
      memberships: [],
    };
  });

  afterAll(async () => {
    await close();
  });

  it(
    "reste un 200 avec un total exact quand le cumul de GMV / commission dépasse " +
      "2 147 483 647 unités mineures",
    async () => {
      const seed = await seedBookableSlot(db, { capacity: 10, priceAmount: 0 });
      const userA = await createTestUser(db);
      const userB = await createTestUser(db);

      // Amount well within int4 individually; the pair's SUM is not.
      const HUGE_AMOUNT = 1_200_000_000;
      const reservationIds: string[] = [];
      const paymentIds: string[] = [];

      try {
        const before = await moderation.overview(admin);

        for (const user of [userA, userB]) {
          const [reservation] = await db
            .insert(schema.reservations)
            .values({
              userId: user.id,
              slotId: seed.slotId,
              offerId: seed.offerId,
              venueId: seed.venueId,
              businessId: seed.businessId,
              status: 'CONFIRMED',
              priceAmount: HUGE_AMOUNT,
              currency: 'EUR',
              trialRule: 'NO_RESTRICTION',
              slotStartAt: new Date(Date.now() + 7 * 86_400_000),
              slotEndAt: new Date(Date.now() + 7 * 86_400_000 + 3_600_000),
              confirmedAt: new Date(),
            })
            .returning({ id: schema.reservations.id });
          if (!reservation) throw new Error('reservation insert failed');
          reservationIds.push(reservation.id);

          const [payment] = await db
            .insert(schema.payments)
            .values({
              reservationId: reservation.id,
              userId: user.id,
              businessId: seed.businessId,
              status: 'SUCCEEDED',
              provider: 'STRIPE',
              amount: HUGE_AMOUNT,
              // The whole amount as platform fee: irrelevant to the bug, but
              // it means this single seed also exercises
              // platformRevenueMinor's overflow, not just gmvMinor's.
              platformFeeAmount: HUGE_AMOUNT,
              merchantAmount: 0,
              refundedAmount: 0,
              refundedPlatformFeeAmount: 0,
              refundedMerchantAmount: 0,
              currency: 'EUR',
              succeededAt: new Date(),
            })
            .returning({ id: schema.payments.id });
          if (!payment) throw new Error('payment insert failed');
          paymentIds.push(payment.id);
        }

        // Sum of the two payments alone: 2_400_000_000 — past INT4_MAX
        // (2_147_483_647) — regardless of whatever the shared database
        // already held.
        const after = await moderation.overview(admin);

        expect(after.gmvMinor - before.gmvMinor).toBe(2 * HUGE_AMOUNT);
        expect(after.platformRevenueMinor - before.platformRevenueMinor).toBe(2 * HUGE_AMOUNT);
        expect(Number.isSafeInteger(after.gmvMinor)).toBe(true);
        expect(Number.isSafeInteger(after.platformRevenueMinor)).toBe(true);
      } finally {
        for (const id of paymentIds) {
          await db.execute(sql`DELETE FROM payments WHERE id = ${id}`);
        }
        for (const id of reservationIds) {
          await db.execute(sql`DELETE FROM reservations WHERE id = ${id}`);
        }
        await seed.cleanup();
        await db.execute(sql`DELETE FROM users WHERE id = ${userA.id}`);
        await db.execute(sql`DELETE FROM users WHERE id = ${userB.id}`);
      }
    },
  );
});
