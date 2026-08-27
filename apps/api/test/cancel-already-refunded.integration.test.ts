import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { Clock } from '@try/utils';
import type { Logger } from '@try/logger';
import { ApiException } from '../src/common/errors/api-exception.js';
import { DomainEvents } from '../src/modules/events/domain-events.js';
import { RefundLedgerService } from '../src/modules/payments/refund-ledger.service.js';
import { PaymentService } from '../src/modules/payments/payment.service.js';
import type {
  CheckoutSessionResult,
  PaymentProvider,
  ProviderRefund,
  RefundInput,
  RefundOutcome,
  VerifiedWebhookEvent,
} from '../src/modules/payments/payment-provider.js';
import { connect, createTestUser, describeIfDatabase, seedBookableSlot } from './integration-setup.js';

/**
 * Exigence C : `POST /v1/bookings/:id/cancel` sur une reservation deja
 * remboursee cote Stripe ne doit plus renvoyer une 500. Le bug vivait dans
 * `PaymentService.refundReservation`, seule fonction touchee par cette
 * exigence (`booking.service.ts` n'est pas modifie) — c'est donc elle qu'on
 * exerce directement ici, contre un vrai Postgres.
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
    providerRefundId: `re_cancel_${refundCounter}_${Math.random().toString(36).slice(2, 8)}`,
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

class FakeProvider implements PaymentProvider {
  constructor(
    // Extension de double de test, pas un affaiblissement : la forme callable
    // recoit desormais l'entree (necessaire pour asserter le montant et la cle
    // d'idempotence du solde reclame en 2b) ; les usages existants a zero
    // argument (une valeur fixe, ou une fonction qui ignore son parametre)
    // restent valides tels quels.
    private readonly refundOutcome?: RefundOutcome | ((input: RefundInput) => Promise<RefundOutcome>),
    private readonly listRefundsResult: ProviderRefund[] = [],
  ) {}

  createCheckoutSession(): Promise<CheckoutSessionResult> {
    return Promise.reject(new Error('createCheckoutSession not used in this test'));
  }

  cancelIntent(): Promise<void> {
    return Promise.resolve();
  }

  async refund(input: RefundInput): Promise<RefundOutcome> {
    if (!this.refundOutcome) throw new Error('refund() not configured for this test');
    return typeof this.refundOutcome === 'function' ? this.refundOutcome(input) : this.refundOutcome;
  }

  listRefunds(): Promise<ProviderRefund[]> {
    return Promise.resolve(this.listRefundsResult);
  }

  verifyWebhook(): VerifiedWebhookEvent {
    throw new Error('verifyWebhook not used in this test');
  }

  interpret(): VerifiedWebhookEvent {
    throw new Error('interpret not used in this test');
  }
}

describeIfDatabase('annulation sur une reservation deja remboursee cote fournisseur', () => {
  let db: Database;
  let close: () => Promise<void>;
  let ledger: RefundLedgerService;

  beforeAll(() => {
    ({ db, close } = connect());
    ledger = new RefundLedgerService(db, clock, fakeLogger(), new DomainEvents(fakeLogger()));
  });

  afterAll(async () => {
    await close();
  });

  async function seedPaidReservation(options: {
    amount: number;
    platformFeeAmount: number;
    status?: 'SUCCEEDED' | 'PARTIALLY_REFUNDED';
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
        providerPaymentIntentId: `pi_cancel_${suffix}`,
        providerChargeId: `ch_cancel_${suffix}`,
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

  it('remboursement total deja regle chez Stripe -> refunded:true, jamais une 500, une ligne avec le vrai re_', async () => {
    const seed = await seedPaidReservation({ amount: 1000, platformFeeAmount: 150 });
    try {
      const alreadyRefund = providerRefund({
        amountMinor: 1000,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
      });
      const provider = new FakeProvider({ kind: 'ALREADY_SETTLED', refunds: [alreadyRefund] });
      const payments = new PaymentService(db, provider, clock, fakeLogger(), new DomainEvents(fakeLogger()), ledger);

      const refunded = await payments.refundReservation(db, {
        reservationId: seed.reservationId,
        reason: 'requested_by_customer',
      });

      expect(refunded).toBe(true);

      const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, seed.paymentId));
      expect(payment?.status).toBe('REFUNDED');
      expect(payment?.refundedAmount).toBe(1000);
      expect(payment?.refundedPlatformFeeAmount).toBe(150);
      expect(payment?.refundedMerchantAmount).toBe(850);

      const rows = await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, seed.paymentId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.providerRefundId).toBe(alreadyRefund.providerRefundId);
      // Jamais NULL : c'est precisement le piege qui provoquait la 500 puis le
      // double comptage a la livraison du vrai webhook.
      expect(rows[0]?.providerRefundId).not.toBeNull();

      // Puis le webhook refund.created correspondant arrive : toujours une seule ligne.
      const replay = await ledger.apply({ paymentId: seed.paymentId, refunds: [alreadyRefund] });
      expect(replay.refundedAmount).toBe(1000);
      const rowsAfterReplay = await db
        .select()
        .from(schema.refunds)
        .where(eq(schema.refunds.paymentId, seed.paymentId));
      expect(rowsAfterReplay).toHaveLength(1);
    } finally {
      await seed.cleanup();
    }
  });

  it('remboursement partiel deja effectue cote Stripe : le solde est complete a l\'annulation', async () => {
    const seed = await seedPaidReservation({
      amount: 1000,
      platformFeeAmount: 150,
      status: 'PARTIALLY_REFUNDED',
      refundedAmount: 300,
      refundedPlatformFeeAmount: 45,
      refundedMerchantAmount: 255,
    });
    try {
      const already = providerRefund({
        amountMinor: 300,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
        occurredAt: new Date(Date.now() - 10_000),
      });
      // La ligne existante que ce partiel represente, deja au registre — c'est
      // l'etat qu'aurait laisse un webhook refund.created traite plus tot.
      await db.insert(schema.refunds).values({
        paymentId: seed.paymentId,
        reservationId: seed.reservationId,
        provider: 'STRIPE',
        providerRefundId: already.providerRefundId,
        amount: 300,
        currency: 'EUR',
        status: 'SUCCEEDED',
        platformFeeAmount: 45,
        merchantAmount: 255,
        succeededAt: already.occurredAt,
        createdAt: already.occurredAt,
      });

      const newRefund = providerRefund({
        amountMinor: 700,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
      });
      const provider = new FakeProvider({ kind: 'CREATED', refund: newRefund });
      const payments = new PaymentService(db, provider, clock, fakeLogger(), new DomainEvents(fakeLogger()), ledger);

      const refunded = await payments.refundReservation(db, { reservationId: seed.reservationId });

      expect(refunded).toBe(true);

      const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, seed.paymentId));
      expect(payment?.refundedAmount).toBe(1000);
      expect(payment?.status).toBe('REFUNDED');

      const rows = await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, seed.paymentId));
      expect(rows).toHaveLength(2);
    } finally {
      await seed.cleanup();
    }
  });

  it('fournisseur en panne reseau -> l\'erreur remonte (REFUND_FAILED), aucune ecriture partielle', async () => {
    const seed = await seedPaidReservation({ amount: 1000, platformFeeAmount: 150 });
    try {
      const provider = new FakeProvider(() =>
        Promise.reject(new ApiException('REFUND_FAILED', undefined, undefined, { reason: 'network' })),
      );
      const payments = new PaymentService(db, provider, clock, fakeLogger(), new DomainEvents(fakeLogger()), ledger);

      await expect(
        payments.refundReservation(db, { reservationId: seed.reservationId }),
      ).rejects.toMatchObject({ code: 'REFUND_FAILED' });

      const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, seed.paymentId));
      expect(payment?.status).toBe('SUCCEEDED');
      expect(payment?.refundedAmount).toBe(0);

      const rows = await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, seed.paymentId));
      expect(rows).toHaveLength(0);
    } finally {
      await seed.cleanup();
    }
  });

  it('partiel inconnu de la base : le solde est reclame et applique (B2)', async () => {
    const seed = await seedPaidReservation({ amount: 1000, platformFeeAmount: 150 });
    try {
      const firstPartial = providerRefund({
        amountMinor: 300,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
      });
      const topUp = providerRefund({
        amountMinor: 700,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
      });

      const calls: RefundInput[] = [];
      const provider = new FakeProvider(async (input: RefundInput) => {
        calls.push(input);
        return calls.length === 1
          ? { kind: 'ALREADY_SETTLED', refunds: [firstPartial] }
          : { kind: 'CREATED', refund: topUp };
      });
      const payments = new PaymentService(db, provider, clock, fakeLogger(), new DomainEvents(fakeLogger()), ledger);

      const refunded = await payments.refundReservation(db, { reservationId: seed.reservationId });

      expect(refunded).toBe(true);
      expect(calls).toHaveLength(2);
      // Le solde reclame porte exactement ce qui manque, et sur une cle NEUVE :
      // c'est ce qui evite que Stripe rejoue sa reponse d'erreur mise en cache.
      expect(calls[1]?.amountMinor).toBe(700);
      expect(calls[0]?.idempotencyKey).not.toBe(calls[1]?.idempotencyKey);

      const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, seed.paymentId));
      expect(payment?.status).toBe('REFUNDED');
      expect(payment?.refundedAmount).toBe(1000);
      expect(payment?.refundedPlatformFeeAmount).toBe(150);
      expect(payment?.refundedMerchantAmount).toBe(850);

      const rows = await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, seed.paymentId));
      expect(rows).toHaveLength(2);

      // Non-regression d'idempotence : rejouer le webhook des deux mouvements
      // laisse toujours deux lignes et le meme cumul.
      const replay = await ledger.apply({ paymentId: seed.paymentId, refunds: [firstPartial, topUp] });
      expect(replay.refundedAmount).toBe(1000);
      const rowsAfterReplay = await db
        .select()
        .from(schema.refunds)
        .where(eq(schema.refunds.paymentId, seed.paymentId));
      expect(rowsAfterReplay).toHaveLength(2);
    } finally {
      await seed.cleanup();
    }
  });

  it('le solde reste irrecuperable -> rien n\'est commit (B2)', async () => {
    const seed = await seedPaidReservation({ amount: 1000, platformFeeAmount: 150 });
    try {
      const stuckPartial = providerRefund({
        amountMinor: 300,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
      });
      // Le fournisseur revele le meme partiel de 300 aux DEUX appels : la
      // relance unique ne suffit pas a combler le solde, la situation est
      // genuinement irrecuperable pour cette tentative.
      const provider = new FakeProvider(
        async () => ({ kind: 'ALREADY_SETTLED', refunds: [stuckPartial] }) as RefundOutcome,
      );
      const payments = new PaymentService(db, provider, clock, fakeLogger(), new DomainEvents(fakeLogger()), ledger);

      await expect(
        db.transaction((tx) => payments.refundReservation(tx, { reservationId: seed.reservationId })),
      ).rejects.toMatchObject({ code: 'REFUND_FAILED' });

      const [reservation] = await db
        .select({ status: schema.reservations.status })
        .from(schema.reservations)
        .where(eq(schema.reservations.id, seed.reservationId));
      expect(reservation?.status).toBe('CONFIRMED');

      const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, seed.paymentId));
      expect(payment?.status).toBe('SUCCEEDED');
      expect(payment?.refundedAmount).toBe(0);

      const rows = await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, seed.paymentId));
      expect(rows).toHaveLength(0);
    } finally {
      await seed.cleanup();
    }
  });
});
