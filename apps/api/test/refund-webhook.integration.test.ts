import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { Clock } from '@try/utils';
import type { Logger } from '@try/logger';
import { DomainEvents } from '../src/modules/events/domain-events.js';
import { RefundLedgerService } from '../src/modules/payments/refund-ledger.service.js';
import { WebhookDispatcherService } from '../src/modules/payments/webhook-dispatcher.service.js';
import { PaymentService } from '../src/modules/payments/payment.service.js';
import type {
  PaymentIntentResult,
  PaymentProvider,
  ProviderRefund,
  RefundOutcome,
  VerifiedWebhookEvent,
} from '../src/modules/payments/payment-provider.js';
import { connect, createTestUser, describeIfDatabase, seedBookableSlot } from './integration-setup.js';

/**
 * Exerce le registre de remboursements contre un vrai Postgres.
 *
 * Aucune de ces garanties (verrou de ligne, upsert avec garde de monotonie,
 * projection recalculee, reattribution) ne se laisse verifier par un mock : ce
 * sont des mecanismes Postgres, testes ici avec de vraies connexions paralleles,
 * exactement comme booking-concurrency.integration.test.ts pour la capacite.
 */

function fakeLogger(): Logger {
  const noop = (): void => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop };
  return { ...logger, child: () => logger } as unknown as Logger;
}

const clock: Clock = { now: () => new Date() };

let refundCounter = 0;
function providerRefund(overrides: Partial<ProviderRefund> = {}): ProviderRefund {
  refundCounter += 1;
  return {
    providerRefundId: `re_test_${refundCounter}_${Math.random().toString(36).slice(2, 8)}`,
    providerIntentId: null,
    providerChargeId: null,
    amountMinor: 100,
    currency: 'EUR',
    status: 'SUCCEEDED',
    reason: null,
    failureReason: null,
    occurredAt: new Date(),
    ...overrides,
  };
}

/** Fournisseur simule implementant PaymentProvider, configurable par test. */
class FakeProvider implements PaymentProvider {
  listRefundsCalls = 0;

  constructor(
    private readonly listRefundsResult: ProviderRefund[] = [],
    private readonly refundOutcome?: RefundOutcome,
  ) {}

  createIntent(): Promise<PaymentIntentResult> {
    return Promise.reject(new Error('createIntent not used in this test'));
  }

  cancelIntent(): Promise<void> {
    return Promise.resolve();
  }

  refund(): Promise<RefundOutcome> {
    if (!this.refundOutcome) return Promise.reject(new Error('refund() not configured for this test'));
    return Promise.resolve(this.refundOutcome);
  }

  listRefunds(): Promise<ProviderRefund[]> {
    this.listRefundsCalls += 1;
    return Promise.resolve(this.listRefundsResult);
  }

  verifyWebhook(): VerifiedWebhookEvent {
    throw new Error('verifyWebhook not used in this test');
  }

  interpret(): VerifiedWebhookEvent {
    throw new Error('interpret not used in this test');
  }
}

describeIfDatabase('registre de remboursements', () => {
  let db: Database;
  let close: () => Promise<void>;
  let ledger: RefundLedgerService;
  let payments: PaymentService;

  beforeAll(() => {
    ({ db, close } = connect());
    const events = new DomainEvents(fakeLogger());
    ledger = new RefundLedgerService(db, clock, fakeLogger(), events);
    // Un fournisseur qui n'est jamais cense etre appele dans les tests du registre
    // pur (seul refundReservation / le dispatcher appellent le fournisseur).
    payments = new PaymentService(db, new FakeProvider(), clock, fakeLogger(), events, ledger);
  });

  afterAll(async () => {
    await close();
  });

  async function seedPaidReservation(options: {
    amount: number;
    platformFeeAmount: number;
    status?: 'SUCCEEDED' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'FAILED';
    refundedAmount?: number;
    refundedPlatformFeeAmount?: number;
    refundedMerchantAmount?: number;
  }): Promise<{
    reservationId: string;
    paymentId: string;
    providerPaymentIntentId: string;
    providerChargeId: string;
    cleanup: () => Promise<void>;
  }> {
    const slot = await seedBookableSlot(db, { capacity: 5, priceAmount: options.amount });
    const user = await createTestUser(db);
    const suffix = Math.random().toString(36).slice(2, 10);

    const [reservation] = await db
      .insert(schema.reservations)
      .values({
        userId: user.id,
        slotId: slot.slotId,
        offerId: slot.offerId,
        venueId: slot.venueId,
        businessId: slot.businessId,
        status: 'CONFIRMED',
        priceAmount: options.amount,
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
        status: options.status ?? 'SUCCEEDED',
        provider: 'STRIPE',
        providerPaymentIntentId: `pi_test_${suffix}`,
        providerChargeId: `ch_test_${suffix}`,
        amount: options.amount,
        platformFeeAmount: options.platformFeeAmount,
        merchantAmount: options.amount - options.platformFeeAmount,
        refundedAmount: options.refundedAmount ?? 0,
        refundedPlatformFeeAmount: options.refundedPlatformFeeAmount ?? 0,
        refundedMerchantAmount: options.refundedMerchantAmount ?? 0,
        currency: 'EUR',
      })
      .returning();

    return {
      reservationId: reservation!.id,
      paymentId: payment!.id,
      providerPaymentIntentId: payment!.providerPaymentIntentId!,
      providerChargeId: payment!.providerChargeId!,
      cleanup: async () => {
        await db.delete(schema.refunds).where(eq(schema.refunds.paymentId, payment!.id));
        await db.delete(schema.payments).where(eq(schema.payments.id, payment!.id));
        await db.delete(schema.reservations).where(eq(schema.reservations.id, reservation!.id));
        await slot.cleanup();
        await db.delete(schema.users).where(eq(schema.users.id, user.id));
      },
    };
  }

  it('remboursement partiel : ajuste la commission au prorata, laisse la reservation intacte', async () => {
    const seed = await seedPaidReservation({ amount: 1000, platformFeeAmount: 150 });
    try {
      const refund = providerRefund({
        amountMinor: 300,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
      });

      const result = await ledger.apply({ paymentId: seed.paymentId, refunds: [refund] });

      expect(result.outcome).toBe('APPLIED');
      expect(result.refundedAmount).toBe(300);
      expect(result.refundedPlatformFeeAmount).toBe(45);
      expect(result.refundedMerchantAmount).toBe(255);
      expect(result.paymentStatus).toBe('PARTIALLY_REFUNDED');

      const [reservation] = await db
        .select({ status: schema.reservations.status })
        .from(schema.reservations)
        .where(eq(schema.reservations.id, seed.reservationId));
      // Le webhook ne deplace jamais le statut d'une reservation.
      expect(reservation?.status).toBe('CONFIRMED');
    } finally {
      await seed.cleanup();
    }
  });

  it('trois tranches 333/333/334 telescopent exactement sur la commission a 1500bp', async () => {
    const seed = await seedPaidReservation({ amount: 1000, platformFeeAmount: 150 });
    try {
      const base = Date.now() - 10_000;
      await ledger.apply({
        paymentId: seed.paymentId,
        refunds: [
          providerRefund({
            amountMinor: 333,
            providerIntentId: seed.providerPaymentIntentId,
            providerChargeId: seed.providerChargeId,
            occurredAt: new Date(base),
          }),
        ],
      });
      await ledger.apply({
        paymentId: seed.paymentId,
        refunds: [
          providerRefund({
            amountMinor: 333,
            providerIntentId: seed.providerPaymentIntentId,
            providerChargeId: seed.providerChargeId,
            occurredAt: new Date(base + 1000),
          }),
        ],
      });
      const result = await ledger.apply({
        paymentId: seed.paymentId,
        refunds: [
          providerRefund({
            amountMinor: 334,
            providerIntentId: seed.providerPaymentIntentId,
            providerChargeId: seed.providerChargeId,
            occurredAt: new Date(base + 2000),
          }),
        ],
      });

      expect(result.refundedAmount).toBe(1000);
      expect(result.refundedPlatformFeeAmount).toBe(150);
      expect(result.refundedMerchantAmount).toBe(850);
      expect(result.paymentStatus).toBe('REFUNDED');
    } finally {
      await seed.cleanup();
    }
  });

  it('meme sequence a 2500bp -> commission renversee exactement 250', async () => {
    const seed = await seedPaidReservation({ amount: 1000, platformFeeAmount: 250 });
    try {
      const base = Date.now() - 10_000;
      const tranches: Array<{ amountMinor: number; offset: number }> = [
        { amountMinor: 333, offset: 0 },
        { amountMinor: 333, offset: 1000 },
        { amountMinor: 334, offset: 2000 },
      ];

      let lastResult: Awaited<ReturnType<typeof ledger.apply>> | undefined;
      for (const tranche of tranches) {
        lastResult = await ledger.apply({
          paymentId: seed.paymentId,
          refunds: [
            providerRefund({
              amountMinor: tranche.amountMinor,
              providerIntentId: seed.providerPaymentIntentId,
              providerChargeId: seed.providerChargeId,
              occurredAt: new Date(base + tranche.offset),
            }),
          ],
        });
      }

      expect(lastResult?.refundedPlatformFeeAmount).toBe(250);
      expect(lastResult?.refundedMerchantAmount).toBe(750);
    } finally {
      await seed.cleanup();
    }
  });

  it('redelivrance du meme re_ (refund.created puis refund.updated x2) -> une seule ligne, agregats inchanges', async () => {
    const seed = await seedPaidReservation({ amount: 1000, platformFeeAmount: 150 });
    try {
      const refund = providerRefund({
        amountMinor: 400,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
      });

      const first = await ledger.apply({ paymentId: seed.paymentId, refunds: [refund] });
      const second = await ledger.apply({ paymentId: seed.paymentId, refunds: [refund] });
      const third = await ledger.apply({ paymentId: seed.paymentId, refunds: [refund] });

      expect(first.insertedRefundIds).toEqual([refund.providerRefundId]);
      expect(second.insertedRefundIds).toEqual([]);
      expect(third.insertedRefundIds).toEqual([]);
      expect(first.refundedAmount).toBe(400);
      expect(second.refundedAmount).toBe(400);
      expect(third.refundedAmount).toBe(400);

      const rows = await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, seed.paymentId));
      expect(rows).toHaveLength(1);
    } finally {
      await seed.cleanup();
    }
  });

  it('deux partiels distincts de meme montant -> deux lignes, le montant n\'est jamais la cle', async () => {
    const seed = await seedPaidReservation({ amount: 1000, platformFeeAmount: 150 });
    try {
      const a = providerRefund({
        amountMinor: 333,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
      });
      const b = providerRefund({
        amountMinor: 333,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
      });

      await ledger.apply({ paymentId: seed.paymentId, refunds: [a] });
      const result = await ledger.apply({ paymentId: seed.paymentId, refunds: [b] });

      expect(result.refundedAmount).toBe(666);
      const rows = await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, seed.paymentId));
      expect(rows).toHaveLength(2);
    } finally {
      await seed.cleanup();
    }
  });

  it('charge.refunded sans refund.* prealable -> declenche listRefunds et reconcilie', async () => {
    const seed = await seedPaidReservation({ amount: 1000, platformFeeAmount: 150 });
    try {
      const refund = providerRefund({
        amountMinor: 400,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
      });
      const provider = new FakeProvider([refund]);
      const dispatcher = new WebhookDispatcherService(provider, payments, ledger, db, fakeLogger());

      await dispatcher.dispatch({
        id: 'evt_reconcile_1',
        type: 'charge.refunded',
        payload: {},
        fact: {
          kind: 'REFUND_RECONCILE',
          providerIntentId: seed.providerPaymentIntentId,
          providerChargeId: seed.providerChargeId,
          refundedTotalMinor: 400,
        },
      });

      expect(provider.listRefundsCalls).toBe(1);
      const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, seed.paymentId));
      expect(payment?.refundedAmount).toBe(400);
      expect(payment?.refundedPlatformFeeAmount).toBe(60);
    } finally {
      await seed.cleanup();
    }
  });

  it('charge.refunded avec cumul deja concordant -> aucun appel reseau, aucune ecriture', async () => {
    const seed = await seedPaidReservation({
      amount: 1000,
      platformFeeAmount: 150,
      status: 'PARTIALLY_REFUNDED',
      refundedAmount: 400,
      refundedPlatformFeeAmount: 60,
      refundedMerchantAmount: 340,
    });
    try {
      const provider = new FakeProvider([]);
      const dispatcher = new WebhookDispatcherService(provider, payments, ledger, db, fakeLogger());

      await dispatcher.dispatch({
        id: 'evt_reconcile_2',
        type: 'charge.refunded',
        payload: {},
        fact: {
          kind: 'REFUND_RECONCILE',
          providerIntentId: seed.providerPaymentIntentId,
          providerChargeId: seed.providerChargeId,
          refundedTotalMinor: 400,
        },
      });

      expect(provider.listRefundsCalls).toBe(0);
      const rows = await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, seed.paymentId));
      expect(rows).toHaveLength(0);
    } finally {
      await seed.cleanup();
    }
  });

  it('un remboursement qui passe a FAILED redescend le cumul et remet sa ventilation a zero', async () => {
    const seed = await seedPaidReservation({ amount: 1000, platformFeeAmount: 150 });
    try {
      const refund = providerRefund({
        amountMinor: 400,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
        status: 'SUCCEEDED',
      });
      await ledger.apply({ paymentId: seed.paymentId, refunds: [refund] });

      const failed: ProviderRefund = { ...refund, status: 'FAILED', failureReason: 'insufficient_funds' };
      const result = await ledger.apply({ paymentId: seed.paymentId, refunds: [failed] });

      expect(result.refundedAmount).toBe(0);
      expect(result.refundedPlatformFeeAmount).toBe(0);
      expect(result.paymentStatus).toBe('SUCCEEDED');

      const [row] = await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, seed.paymentId));
      expect(row?.status).toBe('FAILED');
      expect(row?.platformFeeAmount).toBe(0);
      expect(row?.merchantAmount).toBe(0);
    } finally {
      await seed.cleanup();
    }
  });

  it('un remboursement PENDING recu apres un SUCCEEDED ne retrograde pas la ligne', async () => {
    const seed = await seedPaidReservation({ amount: 1000, platformFeeAmount: 150 });
    try {
      const refund = providerRefund({
        amountMinor: 400,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
        status: 'SUCCEEDED',
      });
      await ledger.apply({ paymentId: seed.paymentId, refunds: [refund] });

      const stalePending: ProviderRefund = { ...refund, status: 'PENDING' };
      const result = await ledger.apply({ paymentId: seed.paymentId, refunds: [stalePending] });

      expect(result.refundedAmount).toBe(400);
      const [row] = await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, seed.paymentId));
      expect(row?.status).toBe('SUCCEEDED');
    } finally {
      await seed.cleanup();
    }
  });

  it('deux applications concurrentes sur le meme paiement se serialisent sans perte', async () => {
    const seed = await seedPaidReservation({ amount: 1000, platformFeeAmount: 150 });
    try {
      const a = providerRefund({
        amountMinor: 300,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
      });
      const b = providerRefund({
        amountMinor: 300,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
      });

      await Promise.all([
        ledger.apply({ paymentId: seed.paymentId, refunds: [a] }),
        ledger.apply({ paymentId: seed.paymentId, refunds: [b] }),
      ]);

      const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, seed.paymentId));
      expect(payment?.refundedAmount).toBe(600);
      expect(payment?.refundedPlatformFeeAmount).toBe(90);

      const rows = await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, seed.paymentId));
      expect(rows).toHaveLength(2);
    } finally {
      await seed.cleanup();
    }
  });

  it('un sur-remboursement force est rejete bruyamment, jamais ecrete', async () => {
    const seed = await seedPaidReservation({ amount: 1000, platformFeeAmount: 150 });
    try {
      const refund = providerRefund({
        amountMinor: 1500,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
      });

      await expect(
        ledger.apply({ paymentId: seed.paymentId, refunds: [refund] }),
      ).rejects.toMatchObject({ code: 'REFUND_FAILED' });

      const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, seed.paymentId));
      expect(payment?.refundedAmount).toBe(0);
      expect(payment?.status).toBe('SUCCEEDED');
    } finally {
      await seed.cleanup();
    }
  });

  it('paiement inconnu -> PAYMENT_NOT_FOUND, aucune ecriture, pas d\'exception non typee', async () => {
    const refund = providerRefund({ amountMinor: 100, providerIntentId: 'pi_does_not_exist_at_all' });
    const result = await ledger.apply({ providerIntentId: 'pi_does_not_exist_at_all', refunds: [refund] });
    expect(result.outcome).toBe('PAYMENT_NOT_FOUND');
  });

  it('paiement a amount=0 (anomalie) -> NOOP sans ecriture', async () => {
    const seed = await seedPaidReservation({ amount: 0, platformFeeAmount: 0 });
    try {
      const refund = providerRefund({ amountMinor: 100, providerIntentId: seed.providerPaymentIntentId });
      const result = await ledger.apply({ paymentId: seed.paymentId, refunds: [refund] });
      expect(result.outcome).toBe('NOOP');

      const rows = await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, seed.paymentId));
      expect(rows).toHaveLength(0);
    } finally {
      await seed.cleanup();
    }
  });
});
