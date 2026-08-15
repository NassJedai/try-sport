import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
 * Contraintes de base introduites par la migration 0004.
 *
 * Sur le modele de booking-concurrency.integration.test.ts:224-246 : une
 * contrainte non testee est une contrainte qu'on supprimera par erreur.
 */
describeIfDatabase('contraintes du registre de remboursements', () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(() => {
    ({ db, close } = connect());
  });

  afterAll(async () => {
    await close();
  });

  async function seedPayment(): Promise<{
    paymentId: string;
    reservationId: string;
    cleanup: () => Promise<void>;
  }> {
    const slot = await seedBookableSlot(db, { capacity: 1, priceAmount: 1000 });
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
        priceAmount: 1000,
        currency: 'EUR',
        trialRule: 'NO_RESTRICTION',
        slotStartAt: new Date(Date.now() + 7 * 86_400_000),
        slotEndAt: new Date(Date.now() + 7 * 86_400_000 + 3_600_000),
      })
      .returning();

    const [payment] = await db
      .insert(schema.payments)
      .values({
        reservationId: reservation!.id,
        userId: user.id,
        businessId: slot.businessId,
        status: 'SUCCEEDED',
        provider: 'STRIPE',
        providerPaymentIntentId: `pi_constraint_${Math.random().toString(36).slice(2, 10)}`,
        amount: 1000,
        platformFeeAmount: 150,
        merchantAmount: 850,
        currency: 'EUR',
      })
      .returning();

    return {
      paymentId: payment!.id,
      reservationId: reservation!.id,
      cleanup: async () => {
        await db.delete(schema.refunds).where(eq(schema.refunds.paymentId, payment!.id));
        await db.delete(schema.payments).where(eq(schema.payments.id, payment!.id));
        await db.delete(schema.reservations).where(eq(schema.reservations.id, reservation!.id));
        await slot.cleanup();
        await db.delete(schema.users).where(eq(schema.users.id, user.id));
      },
    };
  }

  it('refunds_split_reconciles refuse une ligne SUCCEEDED desequilibree', async () => {
    const seed = await seedPayment();
    try {
      await expect(
        db.insert(schema.refunds).values({
          paymentId: seed.paymentId,
          reservationId: seed.reservationId,
          provider: 'STRIPE',
          providerRefundId: 're_bad_1',
          amount: 300,
          currency: 'EUR',
          status: 'SUCCEEDED',
          platformFeeAmount: 40, // 40 + 40 != 300
          merchantAmount: 40,
        }),
      ).rejects.toSatisfy(expectConstraint('refunds_split_reconciles'));
    } finally {
      await seed.cleanup();
    }
  });

  it('refunds_split_reconciles refuse une ligne FAILED avec une ventilation non nulle', async () => {
    const seed = await seedPayment();
    try {
      await expect(
        db.insert(schema.refunds).values({
          paymentId: seed.paymentId,
          reservationId: seed.reservationId,
          provider: 'STRIPE',
          providerRefundId: 're_bad_2',
          amount: 300,
          currency: 'EUR',
          status: 'FAILED',
          platformFeeAmount: 45,
          merchantAmount: 255,
        }),
      ).rejects.toSatisfy(expectConstraint('refunds_split_reconciles'));
    } finally {
      await seed.cleanup();
    }
  });

  it('refunds_split_non_negative refuse une part negative', async () => {
    const seed = await seedPayment();
    try {
      await expect(
        db.insert(schema.refunds).values({
          paymentId: seed.paymentId,
          reservationId: seed.reservationId,
          provider: 'STRIPE',
          providerRefundId: 're_bad_3',
          amount: 300,
          currency: 'EUR',
          status: 'SUCCEEDED',
          platformFeeAmount: -10,
          merchantAmount: 310,
        }),
      ).rejects.toSatisfy(expectConstraint('refunds_split_non_negative'));
    } finally {
      await seed.cleanup();
    }
  });

  it('refunds_status_known refuse un statut hors vocabulaire', async () => {
    const seed = await seedPayment();
    try {
      await expect(
        db.insert(schema.refunds).values({
          paymentId: seed.paymentId,
          reservationId: seed.reservationId,
          provider: 'STRIPE',
          providerRefundId: 're_bad_4',
          amount: 300,
          currency: 'EUR',
          status: 'REVERSED',
          platformFeeAmount: 0,
          merchantAmount: 0,
        }),
      ).rejects.toSatisfy(expectConstraint('refunds_status_known'));
    } finally {
      await seed.cleanup();
    }
  });

  it('refunds_provider_key refuse un doublon (provider, provider_refund_id)', async () => {
    const seed = await seedPayment();
    try {
      const row = {
        paymentId: seed.paymentId,
        reservationId: seed.reservationId,
        provider: 'STRIPE',
        providerRefundId: 're_dup_1',
        amount: 300,
        currency: 'EUR' as const,
        status: 'SUCCEEDED',
        platformFeeAmount: 45,
        merchantAmount: 255,
      };
      await db.insert(schema.refunds).values(row);
      await expect(db.insert(schema.refunds).values(row)).rejects.toSatisfy(
        expectConstraint('refunds_provider_key'),
      );
    } finally {
      await seed.cleanup();
    }
  });

  it('payments_refund_split_reconciles refuse une projection desequilibree', async () => {
    const seed = await seedPayment();
    try {
      await expect(
        db
          .update(schema.payments)
          .set({ refundedAmount: 300, refundedPlatformFeeAmount: 40, refundedMerchantAmount: 40 })
          .where(eq(schema.payments.id, seed.paymentId)),
      ).rejects.toSatisfy(expectConstraint('payments_refund_split_reconciles'));
    } finally {
      await seed.cleanup();
    }
  });

  it('payments_refund_split_within_capture refuse une part de commission negative', async () => {
    const seed = await seedPayment();
    try {
      await expect(
        db
          .update(schema.payments)
          .set({ refundedAmount: 10, refundedPlatformFeeAmount: -5, refundedMerchantAmount: 15 })
          .where(eq(schema.payments.id, seed.paymentId)),
      ).rejects.toSatisfy(expectConstraint('payments_refund_split_within_capture'));
    } finally {
      await seed.cleanup();
    }
  });

  it('payments_refund_split_within_capture refuse une commission rendue superieure a la commission percue', async () => {
    const seed = await seedPayment();
    try {
      // platformFeeAmount encaisse = 150 ; on tente d'en rendre 200.
      await expect(
        db
          .update(schema.payments)
          .set({ refundedAmount: 1000, refundedPlatformFeeAmount: 200, refundedMerchantAmount: 800 })
          .where(eq(schema.payments.id, seed.paymentId)),
      ).rejects.toSatisfy(expectConstraint('payments_refund_split_within_capture'));
    } finally {
      await seed.cleanup();
    }
  });

  it('payments_refund_split_within_capture refuse une part salle negative', async () => {
    const seed = await seedPayment();
    try {
      await expect(
        db
          .update(schema.payments)
          .set({ refundedAmount: 10, refundedPlatformFeeAmount: 15, refundedMerchantAmount: -5 })
          .where(eq(schema.payments.id, seed.paymentId)),
      ).rejects.toSatisfy(expectConstraint('payments_refund_split_within_capture'));
    } finally {
      await seed.cleanup();
    }
  });

  it('payments_refund_split_within_capture refuse une part salle rendue superieure a la part salle percue', async () => {
    const seed = await seedPayment();
    try {
      // merchantAmount encaisse = 850 ; on tente d'en rendre 900.
      await expect(
        db
          .update(schema.payments)
          .set({ refundedAmount: 1000, refundedPlatformFeeAmount: 100, refundedMerchantAmount: 900 })
          .where(eq(schema.payments.id, seed.paymentId)),
      ).rejects.toSatisfy(expectConstraint('payments_refund_split_within_capture'));
    } finally {
      await seed.cleanup();
    }
  });

  it('accepte une ligne SUCCEEDED equilibree et une projection valide', async () => {
    const seed = await seedPayment();
    try {
      await expect(
        db.insert(schema.refunds).values({
          paymentId: seed.paymentId,
          reservationId: seed.reservationId,
          provider: 'STRIPE',
          providerRefundId: 're_ok_1',
          amount: 300,
          currency: 'EUR',
          status: 'SUCCEEDED',
          platformFeeAmount: 45,
          merchantAmount: 255,
        }),
      ).resolves.toBeDefined();

      await expect(
        db
          .update(schema.payments)
          .set({ refundedAmount: 300, refundedPlatformFeeAmount: 45, refundedMerchantAmount: 255 })
          .where(eq(schema.payments.id, seed.paymentId)),
      ).resolves.toBeDefined();
    } finally {
      await seed.cleanup();
    }
  });
});
