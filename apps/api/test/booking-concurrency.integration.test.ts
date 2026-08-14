import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import {
  connect,
  createTestUser,
  describeIfDatabase,
  expectConstraint,
  seedBookableSlot,
} from './integration-setup.js';

/**
 * The test this whole architecture exists to pass.
 *
 * `capacity = 1, reservations = 2` is the failure that costs a venue a real seat
 * and costs TRY the relationship. These cases exercise the actual Postgres
 * mechanisms — row locking on a conditional UPDATE, a CHECK constraint, and a
 * partial unique index — against genuinely parallel connections. There is no
 * mock that could stand in for any of it.
 */
describeIfDatabase('booking concurrency', () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(() => {
    ({ db, close } = connect());
  });

  afterAll(async () => {
    await close();
  });

  /**
   * Mirrors the atomic claim in BookingService.create: a single conditional
   * UPDATE, which Postgres serialises on the row.
   */
  async function attemptClaim(slotId: string): Promise<boolean> {
    const claimed = await db
      .update(schema.slots)
      .set({ reservedCount: sql`${schema.slots.reservedCount} + 1` })
      .where(
        and(
          eq(schema.slots.id, slotId),
          eq(schema.slots.status, 'OPEN'),
          sql`${schema.slots.reservedCount} < ${schema.slots.capacity}`,
        ),
      )
      .returning({ reservedCount: schema.slots.reservedCount });
    return claimed.length > 0;
  }

  it('never lets two concurrent requests take the last place', async () => {
    const slot = await seedBookableSlot(db, { capacity: 1 });

    try {
      // Fired together, on separate pooled connections.
      const results = await Promise.all([attemptClaim(slot.slotId), attemptClaim(slot.slotId)]);

      expect(results.filter(Boolean)).toHaveLength(1);

      const [row] = await db
        .select({ reservedCount: schema.slots.reservedCount })
        .from(schema.slots)
        .where(eq(schema.slots.id, slot.slotId));

      expect(row?.reservedCount).toBe(1);
    } finally {
      await slot.cleanup();
    }
  });

  it('admits exactly `capacity` bookings out of a stampede', async () => {
    const CAPACITY = 5;
    const ATTEMPTS = 40;
    const slot = await seedBookableSlot(db, { capacity: CAPACITY });

    try {
      const results = await Promise.all(
        Array.from({ length: ATTEMPTS }, () => attemptClaim(slot.slotId)),
      );

      expect(results.filter(Boolean)).toHaveLength(CAPACITY);

      const [row] = await db
        .select({ reservedCount: schema.slots.reservedCount })
        .from(schema.slots)
        .where(eq(schema.slots.id, slot.slotId));

      expect(row?.reservedCount).toBe(CAPACITY);
    } finally {
      await slot.cleanup();
    }
  });

  it('refuses to oversell even when the application logic is bypassed', async () => {
    // Defence in depth: the CHECK constraint must reject an unconditional
    // increment, so a future code path that forgets the guard cannot oversell.
    const slot = await seedBookableSlot(db, { capacity: 1 });

    try {
      await db
        .update(schema.slots)
        .set({ reservedCount: 1 })
        .where(eq(schema.slots.id, slot.slotId));

      await expect(
        db
          .update(schema.slots)
          .set({ reservedCount: sql`${schema.slots.reservedCount} + 1` })
          .where(eq(schema.slots.id, slot.slotId)),
      ).rejects.toSatisfy(expectConstraint('slots_reserved_within_capacity'));
    } finally {
      await slot.cleanup();
    }
  });

  it('rejects a negative reserved count', async () => {
    const slot = await seedBookableSlot(db, { capacity: 2 });
    try {
      await expect(
        db.update(schema.slots).set({ reservedCount: -1 }).where(eq(schema.slots.id, slot.slotId)),
      ).rejects.toSatisfy(expectConstraint('slots_reserved_within_capacity'));
    } finally {
      await slot.cleanup();
    }
  });

  it('stops one user holding two live bookings for the same slot', async () => {
    const slot = await seedBookableSlot(db, { capacity: 10 });
    const user = await createTestUser(db);

    const values = {
      userId: user.id,
      slotId: slot.slotId,
      offerId: slot.offerId,
      venueId: slot.venueId,
      businessId: slot.businessId,
      status: 'CONFIRMED' as const,
      priceAmount: 0,
      currency: 'EUR' as const,
      trialRule: 'NO_RESTRICTION' as const,
      slotStartAt: new Date(Date.now() + 7 * 86_400_000),
      slotEndAt: new Date(Date.now() + 7 * 86_400_000 + 3_600_000),
    };

    try {
      await db.insert(schema.reservations).values(values);

      // The partial unique index is what makes a double tap safe across
      // two API instances, where an in-process guard would not help.
      await expect(db.insert(schema.reservations).values(values)).rejects.toSatisfy(
        expectConstraint('reservations_user_slot_live_key'),
      );
    } finally {
      await db.execute(sql`DELETE FROM reservations WHERE user_id = ${user.id}`);
      await slot.cleanup();
      await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    }
  });

  it('lets the same user rebook after cancelling', async () => {
    const slot = await seedBookableSlot(db, { capacity: 10 });
    const user = await createTestUser(db);

    const base = {
      userId: user.id,
      slotId: slot.slotId,
      offerId: slot.offerId,
      venueId: slot.venueId,
      businessId: slot.businessId,
      priceAmount: 0,
      currency: 'EUR' as const,
      trialRule: 'NO_RESTRICTION' as const,
      slotStartAt: new Date(Date.now() + 7 * 86_400_000),
      slotEndAt: new Date(Date.now() + 7 * 86_400_000 + 3_600_000),
    };

    try {
      const [first] = await db
        .insert(schema.reservations)
        .values({ ...base, status: 'CONFIRMED' })
        .returning();

      await db
        .update(schema.reservations)
        .set({ status: 'CANCELLED_USER', cancelledAt: new Date() })
        .where(eq(schema.reservations.id, first!.id));

      // The index covers live statuses only, so cancelling genuinely frees the user.
      await expect(
        db.insert(schema.reservations).values({ ...base, status: 'CONFIRMED' }),
      ).resolves.toBeDefined();
    } finally {
      await db.execute(sql`DELETE FROM reservations WHERE user_id = ${user.id}`);
      await slot.cleanup();
      await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    }
  });

  it('keeps the payment split reconciled', async () => {
    const slot = await seedBookableSlot(db, { capacity: 1, priceAmount: 2800 });
    const user = await createTestUser(db);

    try {
      const [reservation] = await db
        .insert(schema.reservations)
        .values({
          userId: user.id,
          slotId: slot.slotId,
          offerId: slot.offerId,
          venueId: slot.venueId,
          businessId: slot.businessId,
          status: 'PAYMENT_PENDING',
          priceAmount: 2800,
          currency: 'EUR',
          trialRule: 'NO_RESTRICTION',
          slotStartAt: new Date(Date.now() + 7 * 86_400_000),
          slotEndAt: new Date(Date.now() + 7 * 86_400_000 + 3_600_000),
        })
        .returning();

      // A split that does not add up to the charged amount must not be storable.
      await expect(
        db.insert(schema.payments).values({
          reservationId: reservation!.id,
          userId: user.id,
          businessId: slot.businessId,
          amount: 2800,
          platformFeeAmount: 420,
          merchantAmount: 2000, // 420 + 2000 != 2800
          currency: 'EUR',
        }),
      ).rejects.toSatisfy(expectConstraint('payments_split_reconciles'));

      await expect(
        db.insert(schema.payments).values({
          reservationId: reservation!.id,
          userId: user.id,
          businessId: slot.businessId,
          amount: 2800,
          platformFeeAmount: 420,
          merchantAmount: 2380,
          currency: 'EUR',
        }),
      ).resolves.toBeDefined();
    } finally {
      await db.execute(sql`DELETE FROM payments WHERE user_id = ${user.id}`);
      await db.execute(sql`DELETE FROM reservations WHERE user_id = ${user.id}`);
      await slot.cleanup();
      await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    }
  });
});
