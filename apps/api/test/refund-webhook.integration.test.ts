import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
    status?: 'SUCCEEDED' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'FAILED' | 'REQUIRES_PAYMENT' | 'CANCELLED';
    refundedAmount?: number;
    refundedPlatformFeeAmount?: number;
    refundedMerchantAmount?: number;
    /** Simule un paiement qui a echoue une premiere fois avant de reussir. */
    failureCode?: string;
    /**
     * Statut de la reservation au moment du seed. Par defaut CONFIRMED
     * (comportement historique de ce fixture). Un `payment.status`
     * REQUIRES_PAYMENT/FAILED/CANCELLED combine a une reservation CONFIRMED
     * est INATTEIGNABLE en production : `booking.service.ts` ne confirme une
     * reservation qu'au moment ou `payment.service.markSucceeded` s'applique
     * (voir `booking.service.ts:145,180`) — tant que ca n'est pas arrive, la
     * reservation reste PAYMENT_PENDING. Les tests "encaissement jamais vu"
     * doivent donc passer `reservationStatus: 'PAYMENT_PENDING'` pour
     * reproduire une situation reelle.
     */
    reservationStatus?: 'PAYMENT_PENDING' | 'CONFIRMED';
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
    const reservationStatus = options.reservationStatus ?? 'CONFIRMED';
    const now = new Date();

    const [reservation] = await db
      .insert(schema.reservations)
      .values({
        userId: user.id,
        slotId: slot.slotId,
        offerId: slot.offerId,
        venueId: slot.venueId,
        businessId: slot.businessId,
        status: reservationStatus,
        priceAmount: options.amount,
        currency: 'EUR',
        trialRule: 'NO_RESTRICTION',
        slotStartAt: new Date(Date.now() + 7 * 86_400_000),
        slotEndAt: new Date(Date.now() + 7 * 86_400_000 + 3_600_000),
        confirmedAt: reservationStatus === 'CONFIRMED' ? now : null,
        holdExpiresAt: reservationStatus === 'PAYMENT_PENDING' ? new Date(now.getTime() + 15 * 60_000) : null,
      })
      .returning();

    // Ecrit dans la meme transaction que la reservation en production
    // (booking.service.ts:173-181) : les tests qui verifient que la
    // reconstruction rejoue les effets de bord de `markSucceeded` ont besoin
    // de cette ligne pour observer sa transition vers CONFIRMED.
    await db.insert(schema.trialHistory).values({
      userId: user.id,
      businessId: slot.businessId,
      venueId: slot.venueId,
      offerId: slot.offerId,
      reservationId: reservation!.id,
      reservedAt: now,
      status: reservationStatus,
    });

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
        failureCode: options.failureCode ?? null,
        currency: 'EUR',
      })
      .returning();

    return {
      reservationId: reservation!.id,
      paymentId: payment!.id,
      providerPaymentIntentId: payment!.providerPaymentIntentId!,
      providerChargeId: payment!.providerChargeId!,
      cleanup: async () => {
        // trial_history est en cascade sur reservations (onDelete: 'cascade')
        // mais la supprimer explicitement documente la dependance et rend le
        // cleanup independant de ce detail de schema.
        await db.delete(schema.refunds).where(eq(schema.refunds.paymentId, payment!.id));
        await db.delete(schema.payments).where(eq(schema.payments.id, payment!.id));
        await db.delete(schema.trialHistory).where(eq(schema.trialHistory.reservationId, reservation!.id));
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

  /**
   * Le webhook `payment_intent.succeeded` peut ne jamais arriver (perdu, ou
   * abandonne apres MAX_WEBHOOK_ATTEMPTS) alors que Stripe detient bien
   * l'argent. Un remboursement constate chez le fournisseur est la preuve
   * qu'un encaissement a eu lieu : il ne se refuse jamais sur la foi d'un
   * dernier statut REQUIRES_PAYMENT/FAILED/CANCELLED — c'est le statut qui se
   * corrige.
   *
   * Revue contradictoire du 2026-08-16 (voir le message de commit) : la
   * premiere version de cette reconstruction echangeait un bug d'argent
   * contre un bug de reservation (une reservation PAYMENT_PENDING restait
   * bloquee jusqu'a expiration du hold), et une ligne PENDING seule suffisait
   * a facturer 100% de la commission sur une seance jamais confirmee. Les
   * tests ci-dessous couvrent les deux — `reservationStatus: 'PAYMENT_PENDING'`
   * est desormais systematique ici : c'est la seule combinaison atteignable
   * en production pour un paiement REQUIRES_PAYMENT/FAILED/CANCELLED (voir le
   * commentaire sur `seedPaidReservation`).
   */

  it(
    'encaissement jamais vu : remboursement TOTAL sur une reservation PAYMENT_PENDING reconstruit le statut du ' +
      "paiement mais NE confirme PAS la reservation — l'essai n'est pas consomme de facon permanente",
    async () => {
      const seed = await seedPaidReservation({
        amount: 1000,
        platformFeeAmount: 250,
        status: 'REQUIRES_PAYMENT',
        reservationStatus: 'PAYMENT_PENDING',
      });
      try {
        const refund = providerRefund({
          amountMinor: 1000,
          providerIntentId: seed.providerPaymentIntentId,
          providerChargeId: seed.providerChargeId,
        });

        const result = await ledger.apply({ paymentId: seed.paymentId, refunds: [refund] });

        expect(result.outcome).toBe('APPLIED');
        expect(result.refundedAmount).toBe(1000);
        expect(result.paymentStatus).toBe('REFUNDED');
        // Un remboursement total ne confirme jamais la reservation : voir plus bas.
        expect(result.capturedReservation).toBeNull();

        const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, seed.paymentId));
        expect(payment?.status).toBe('REFUNDED');
        expect(payment?.refundedAmount).toBe(1000);
        expect(payment?.succeededAt).not.toBeNull();

        const rows = await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, seed.paymentId));
        expect(rows).toHaveLength(1);

        // Blocage le plus grave de la revue du 2026-08-16 (2e tour) : la toute
        // premiere version de ce correctif confirmait la reservation meme pour
        // un remboursement TOTAL. Consequences verifiees a l'epoque : CONFIRMED
        // est dans TRIAL_CONSUMING_STATUSES et REFUNDED n'est PAS atteignable
        // depuis CONFIRMED (reservation-state-machine.ts) — un cul-de-sac qui
        // aurait aussi declenche `BookingConfirmed` (e-mail de confirmation +
        // code de check-in) pour un client rembourse a 100%. La reservation
        // doit rester exactement dans l'etat ou l'a laissee le checkout
        // abandonne : PAYMENT_PENDING, jamais confirmee, avec son hold intact
        // (le job `expire-payment-holds` la liberera normalement, EXPIRED
        // n'etant pas dans TRIAL_CONSUMING_STATUSES).
        const [reservation] = await db
          .select()
          .from(schema.reservations)
          .where(eq(schema.reservations.id, seed.reservationId));
        expect(reservation?.status).toBe('PAYMENT_PENDING');
        expect(reservation?.confirmedAt).toBeNull();
        expect(reservation?.holdExpiresAt).not.toBeNull();

        const [trial] = await db
          .select({ status: schema.trialHistory.status })
          .from(schema.trialHistory)
          .where(eq(schema.trialHistory.reservationId, seed.reservationId));
        // Toujours PAYMENT_PENDING, jamais CONFIRMED : l'essai n'est pas
        // consomme de facon permanente. TRIAL_CONSUMING_STATUSES compte
        // PAYMENT_PENDING (un checkout en cours bloque bien un essai
        // concurrent), mais cet etat est reversible via expire-payment-holds
        // -> EXPIRED, qui lui N'EST PAS consommateur — contrairement a
        // CONFIRMED, qui n'a plus aucune sortie vers REFUNDED.
        expect(trial?.status).toBe('PAYMENT_PENDING');
        expect(trial?.status).not.toBe('CONFIRMED');
      } finally {
        await seed.cleanup();
      }
    },
  );

  it('encaissement jamais vu : idem depuis FAILED, efface failure_code mais ne confirme pas la reservation (remboursement total)', async () => {
    const seed = await seedPaidReservation({
      amount: 1000,
      platformFeeAmount: 250,
      status: 'FAILED',
      failureCode: 'card_declined',
      reservationStatus: 'PAYMENT_PENDING',
    });
    try {
      const refund = providerRefund({
        amountMinor: 1000,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
      });

      const result = await ledger.apply({ paymentId: seed.paymentId, refunds: [refund] });

      expect(result.paymentStatus).toBe('REFUNDED');
      expect(result.capturedReservation).toBeNull();

      const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, seed.paymentId));
      expect(payment?.status).toBe('REFUNDED');
      expect(payment?.failureCode).toBeNull();
      expect(payment?.succeededAt).not.toBeNull();

      const [reservation] = await db
        .select({ status: schema.reservations.status })
        .from(schema.reservations)
        .where(eq(schema.reservations.id, seed.reservationId));
      // Meme raisonnement que le test precedent : total -> jamais confirmee.
      expect(reservation?.status).toBe('PAYMENT_PENDING');
    } finally {
      await seed.cleanup();
    }
  });

  it(
    'encaissement jamais vu : remboursement PARTIEL sur PAYMENT_PENDING confirme la reservation et ajuste la ' +
      'commission au prorata (scenario exact de la revue : 1000 paye, 400 rendus)',
    async () => {
      const seed = await seedPaidReservation({
        amount: 1000,
        platformFeeAmount: 150,
        status: 'REQUIRES_PAYMENT',
        reservationStatus: 'PAYMENT_PENDING',
      });
      try {
        const refund = providerRefund({
          amountMinor: 400,
          providerIntentId: seed.providerPaymentIntentId,
          providerChargeId: seed.providerChargeId,
        });

        const result = await ledger.apply({ paymentId: seed.paymentId, refunds: [refund] });

        expect(result.outcome).toBe('APPLIED');
        expect(result.refundedAmount).toBe(400);
        expect(result.paymentStatus).toBe('PARTIALLY_REFUNDED');
        expect(result.refundedPlatformFeeAmount).toBe(60);

        const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, seed.paymentId));
        expect(payment?.status).toBe('PARTIALLY_REFUNDED');
        expect(payment?.refundedAmount).toBe(400);

        // C'est ce scenario precis que la revue a mesure comme casse : "le
        // client a paye 1000, on lui en a rendu 400, la salle est facturee
        // 90 de commission (150-60), et la reservation restait PAYMENT_PENDING
        // jusqu'a expiration du hold — sa place sera relachee". Un
        // remboursement partiel n'annule pas la venue du client : la
        // reservation doit se confirmer normalement.
        const [reservation] = await db
          .select()
          .from(schema.reservations)
          .where(eq(schema.reservations.id, seed.reservationId));
        expect(reservation?.status).toBe('CONFIRMED');
        expect(reservation?.holdExpiresAt).toBeNull();

        const [trial] = await db
          .select({ status: schema.trialHistory.status })
          .from(schema.trialHistory)
          .where(eq(schema.trialHistory.reservationId, seed.reservationId));
        expect(trial?.status).toBe('CONFIRMED');
      } finally {
        await seed.cleanup();
      }
    },
  );

  it(
    "encaissement jamais vu : un payment_intent.succeeded tardif ne reecrit pas SUCCEEDED apres une reconstruction " +
      'totale, ni ne confirme retroactivement une reservation deja remboursee',
    async () => {
      const seed = await seedPaidReservation({
        amount: 1000,
        platformFeeAmount: 250,
        status: 'REQUIRES_PAYMENT',
        reservationStatus: 'PAYMENT_PENDING',
      });
      try {
        const refund = providerRefund({
          amountMinor: 1000,
          providerIntentId: seed.providerPaymentIntentId,
          providerChargeId: seed.providerChargeId,
        });
        await ledger.apply({ paymentId: seed.paymentId, refunds: [refund] });

        // Remboursement TOTAL : la reconstruction n'a PAS confirme la
        // reservation (voir le test dedie plus haut). Livraison tardive du
        // webhook : le garde existant de markSucceeded (exclusion
        // SUCCEEDED/REFUNDED/PARTIALLY_REFUNDED) doit l'absorber sans rien
        // changer — en particulier sans confirmer une reservation qu'on vient
        // de rembourser integralement.
        await payments.markSucceeded(seed.providerPaymentIntentId, seed.providerChargeId);

        const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, seed.paymentId));
        expect(payment?.status).toBe('REFUNDED');
        expect(payment?.refundedAmount).toBe(1000);

        const [reservation] = await db
          .select({ status: schema.reservations.status })
          .from(schema.reservations)
          .where(eq(schema.reservations.id, seed.reservationId));
        expect(reservation?.status).toBe('PAYMENT_PENDING');
      } finally {
        await seed.cleanup();
      }
    },
  );

  it('encaissement jamais vu : une ligne FAILED seule ne promeut pas — la reservation reste PAYMENT_PENDING, aucun log de reconstruction', async () => {
    const seed = await seedPaidReservation({
      amount: 1000,
      platformFeeAmount: 250,
      status: 'REQUIRES_PAYMENT',
      reservationStatus: 'PAYMENT_PENDING',
    });
    try {
      const errorCalls: Array<[Record<string, unknown>, string]> = [];
      const spyLogger = {
        info: () => {},
        warn: () => {},
        error: (meta: Record<string, unknown>, msg: string) => {
          errorCalls.push([meta, msg]);
        },
        debug: () => {},
        fatal: () => {},
        trace: () => {},
      } as unknown as Logger;
      const spiedLedger = new RefundLedgerService(
        db,
        clock,
        { ...spyLogger, child: () => spyLogger } as unknown as Logger,
        new DomainEvents(fakeLogger()),
      );

      const refund = providerRefund({
        amountMinor: 1000,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
        status: 'FAILED',
        failureReason: 'insufficient_funds',
      });

      const result = await spiedLedger.apply({ paymentId: seed.paymentId, refunds: [refund] });

      expect(result.paymentStatus).toBe('REQUIRES_PAYMENT');
      expect(result.refundedAmount).toBe(0);
      expect(result.capturedPayment).toBeNull();
      expect(result.capturedReservation).toBeNull();

      const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, seed.paymentId));
      expect(payment?.status).toBe('REQUIRES_PAYMENT');
      expect(payment?.succeededAt).toBeNull();

      const [reservation] = await db
        .select({ status: schema.reservations.status })
        .from(schema.reservations)
        .where(eq(schema.reservations.id, seed.reservationId));
      expect(reservation?.status).toBe('PAYMENT_PENDING');

      // Le log mentait s'il annoncait une reconstruction qui n'a pas eu lieu
      // (point secondaire de la revue) : rien n'a change ici, il ne doit rien
      // journaliser.
      const match = errorCalls.find(([, msg]) => msg.includes('encaissement reconstruit'));
      expect(match).toBeUndefined();
    } finally {
      await seed.cleanup();
    }
  });

  it(
    "encaissement jamais vu : une ligne PENDING seule ne prouve PLUS la capture (revue 2026-08-16) — aucune " +
      'promotion, aucune commission facturee',
    async () => {
      const seed = await seedPaidReservation({
        amount: 1000,
        platformFeeAmount: 250,
        status: 'REQUIRES_PAYMENT',
        reservationStatus: 'PAYMENT_PENDING',
      });
      try {
        const refund = providerRefund({
          amountMinor: 400,
          providerIntentId: seed.providerPaymentIntentId,
          providerChargeId: seed.providerChargeId,
          status: 'PENDING',
        });

        const result = await ledger.apply({ paymentId: seed.paymentId, refunds: [refund] });

        // PENDING n'entre pas dans la projection (seules les lignes SUCCEEDED
        // comptent) : le cumul reste a 0. Avant la revue du 2026-08-16, cette
        // seule preuve suffisait a promouvoir SUCCEEDED avec R=0 — ce qui
        // facturait 100% de la commission (250) sur une seance jamais
        // confirmee, en pariant sur un second webhook (refund.updated ->
        // SUCCEEDED) pour corriger le tir plus tard, alors que la perte de
        // webhooks est precisement l'hypothese qui justifie cette
        // reconstruction. Sans ligne SUCCEEDED, on ne sait rien de plus
        // qu'avant cet appel.
        expect(result.refundedAmount).toBe(0);
        expect(result.paymentStatus).toBe('REQUIRES_PAYMENT');
        expect(result.capturedPayment).toBeNull();
        expect(result.capturedReservation).toBeNull();

        const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, seed.paymentId));
        expect(payment?.status).toBe('REQUIRES_PAYMENT');
        expect(payment?.succeededAt).toBeNull();

        const [reservation] = await db
          .select({ status: schema.reservations.status })
          .from(schema.reservations)
          .where(eq(schema.reservations.id, seed.reservationId));
        expect(reservation?.status).toBe('PAYMENT_PENDING');

        // REQUIRES_PAYMENT reste hors de l'agregat moderation.service.ts:319 —
        // aucune commission facturee sur cette seance.
        const rows = (await db.execute(sql`
          SELECT COALESCE(SUM(platform_fee_amount - refunded_platform_fee_amount), 0)::int AS "netCommission"
          FROM payments WHERE id = ${seed.paymentId} AND status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED')
        `)) as unknown as { netCommission: number }[];
        expect(rows[0]?.netCommission ?? 0).toBe(0);
      } finally {
        await seed.cleanup();
      }
    },
  );

  it('encaissement jamais vu : amount=0 reste NOOP meme depuis REQUIRES_PAYMENT', async () => {
    const seed = await seedPaidReservation({ amount: 0, platformFeeAmount: 0, status: 'REQUIRES_PAYMENT' });
    try {
      const refund = providerRefund({ amountMinor: 100, providerIntentId: seed.providerPaymentIntentId });
      const result = await ledger.apply({ paymentId: seed.paymentId, refunds: [refund] });

      expect(result.outcome).toBe('NOOP');
      expect(result.paymentStatus).toBe('REQUIRES_PAYMENT');

      const rows = await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, seed.paymentId));
      expect(rows).toHaveLength(0);
    } finally {
      await seed.cleanup();
    }
  });

  it(
    "l'agregat moderation.service.ts:318-320 (WHERE status IN (SUCCEEDED, PARTIALLY_REFUNDED, REFUNDED)) reste " +
      'exact sur un jeu de plusieurs paiements, y compris un encaissement reconstruit',
    async () => {
      // A : reservation en cours, encaissee normalement, jamais remboursee ->
      //     contribue son plein tarif.
      const ongoing = await seedPaidReservation({ amount: 1000, platformFeeAmount: 150, status: 'SUCCEEDED' });
      // B : encaissee normalement puis integralement remboursee par le chemin
      //     habituel (pas de reconstruction) -> contribue 0.
      const refundedNormally = await seedPaidReservation({
        amount: 1000,
        platformFeeAmount: 250,
        status: 'REFUNDED',
        refundedAmount: 1000,
        refundedPlatformFeeAmount: 250,
        refundedMerchantAmount: 750,
      });
      // C : jamais capture cote base, reconstruit ICI par un remboursement
      //     total -> doit retomber a 0 une fois la reconstruction appliquee.
      const reconstructed = await seedPaidReservation({
        amount: 1000,
        platformFeeAmount: 250,
        status: 'REQUIRES_PAYMENT',
        reservationStatus: 'PAYMENT_PENDING',
      });
      // D : checkout abandonne, jamais capture, JAMAIS rembourse -> exclu par
      //     le WHERE (aucun encaissement n'a jamais eu lieu).
      const abandoned = await seedPaidReservation({
        amount: 1000,
        platformFeeAmount: 250,
        status: 'REQUIRES_PAYMENT',
        reservationStatus: 'PAYMENT_PENDING',
      });

      try {
        await ledger.apply({
          paymentId: reconstructed.paymentId,
          refunds: [
            providerRefund({
              amountMinor: 1000,
              providerIntentId: reconstructed.providerPaymentIntentId,
              providerChargeId: reconstructed.providerChargeId,
            }),
          ],
        });

        const paymentIds = [ongoing.paymentId, refundedNormally.paymentId, reconstructed.paymentId, abandoned.paymentId];

        // La formule et la clause WHERE reelles de moderation.service.ts:318-320,
        // portee par le query-builder (pas une copie de chaine SQL) et
        // restreinte a nos 4 paiements pour l'isolation du test.
        const [withStatusFilter] = await db
          .select({
            netCommission: sql<number>`COALESCE(SUM(${schema.payments.platformFeeAmount} - ${schema.payments.refundedPlatformFeeAmount}), 0)::int`,
          })
          .from(schema.payments)
          .where(
            and(
              inArray(schema.payments.id, paymentIds),
              inArray(schema.payments.status, ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED']),
            ),
          );

        // 150 (A) + 0 (B, deja rembourse) + 0 (C, reconstruit puis rembourse) ;
        // D est exclu par le WHERE.
        expect(withStatusFilter?.netCommission).toBe(150);

        // Contre-preuve : le test precedent (avant cette revue) recopiait cette
        // meme formule SANS la clause WHERE, et ne protegeait donc pas la seule
        // chose qui decide. Sur ce meme jeu de donnees, l'omettre revient a
        // compter D en plus (250, jamais capture, jamais rembourse) : la
        // difference entre 400 et 150 EST le bug que l'ancien test ne pouvait
        // pas voir.
        const [withoutStatusFilter] = await db
          .select({
            netCommission: sql<number>`COALESCE(SUM(${schema.payments.platformFeeAmount} - ${schema.payments.refundedPlatformFeeAmount}), 0)::int`,
          })
          .from(schema.payments)
          .where(inArray(schema.payments.id, paymentIds));

        expect(withoutStatusFilter?.netCommission).toBe(400);
      } finally {
        await ongoing.cleanup();
        await refundedNormally.cleanup();
        await reconstructed.cleanup();
        await abandoned.cleanup();
      }
    },
  );

  it(
    '[bug reel, pre-existant, HORS PERIMETRE de cette correction] admin-browse.service.ts:191 facture une ' +
      'commission nette sur un paiement jamais capture',
    async () => {
      const seed = await seedPaidReservation({
        amount: 1000,
        platformFeeAmount: 250,
        status: 'REQUIRES_PAYMENT',
        reservationStatus: 'PAYMENT_PENDING',
      });
      try {
        // Checkout abandonne, jamais rembourse : aucun encaissement n'a jamais
        // eu lieu. Reproduit ICI la formule exacte de admin-browse.service.ts:191
        // (`payments()`, la liste admin des paiements) qui, a la difference de
        // moderation.service.ts:318-320, ne filtre PAS par statut.
        const [row] = (await db.execute(sql`
          SELECT (platform_fee_amount - refunded_platform_fee_amount)::int AS "netPlatformFee", status
          FROM payments WHERE id = ${seed.paymentId}
        `)) as unknown as { netPlatformFee: number; status: string }[];

        expect(row?.status).toBe('REQUIRES_PAYMENT');
        // Ce montant DEVRAIT etre 0 : aucun encaissement n'a jamais eu lieu sur
        // ce paiement. `admin-browse.service.ts:191` le facture quand meme,
        // faute du meme filtre de statut que moderation.service.ts. Signale au
        // chef de projet plutot que corrige ici : `apps/admin` et le reste
        // d'`apps/api/src/modules/admin` ne sont pas dans le perimetre de cette
        // tache (refund-ledger.service.ts, ce fichier de test,
        // payment.service.ts). Ce test caracterise le bug ACTUEL ; il devra
        // etre invertit (`toBe(0)`) le jour ou admin-browse.service.ts applique
        // le meme filtre de statut.
        expect(row?.netPlatformFee).toBe(250);
      } finally {
        await seed.cleanup();
      }
    },
  );

  it('encaissement jamais vu : journalise en erreur (pas en avertissement) uniquement quand une promotion reelle a eu lieu, avec paymentId et statut precedent', async () => {
    const seed = await seedPaidReservation({
      amount: 1000,
      platformFeeAmount: 250,
      status: 'REQUIRES_PAYMENT',
      reservationStatus: 'PAYMENT_PENDING',
    });
    try {
      const errorCalls: Array<[Record<string, unknown>, string]> = [];
      const spyLogger = {
        info: () => {},
        warn: () => {},
        error: (meta: Record<string, unknown>, msg: string) => {
          errorCalls.push([meta, msg]);
        },
        debug: () => {},
        fatal: () => {},
        trace: () => {},
      } as unknown as Logger;
      const spiedLedger = new RefundLedgerService(
        db,
        clock,
        { ...spyLogger, child: () => spyLogger } as unknown as Logger,
        new DomainEvents(fakeLogger()),
      );

      const refund = providerRefund({
        amountMinor: 1000,
        providerIntentId: seed.providerPaymentIntentId,
        providerChargeId: seed.providerChargeId,
      });
      await spiedLedger.apply({ paymentId: seed.paymentId, refunds: [refund] });

      const match = errorCalls.find(([, msg]) => msg.includes('payment_intent.succeeded jamais applique'));
      expect(match).toBeDefined();
      expect(match?.[0]).toMatchObject({
        paymentId: seed.paymentId,
        previousStatus: 'REQUIRES_PAYMENT',
        providerPaymentIntentId: seed.providerPaymentIntentId,
      });
    } finally {
      await seed.cleanup();
    }
  });

  it(
    'encaissement jamais vu : un remboursement PARTIEL emet BookingConfirmed et PaymentSucceeded apres commit ' +
      '(la confirmation de reservation differee, post-commit, produit bien son evenement)',
    async () => {
      const seed = await seedPaidReservation({
        amount: 1000,
        platformFeeAmount: 250,
        status: 'REQUIRES_PAYMENT',
        reservationStatus: 'PAYMENT_PENDING',
      });
      try {
        const events = new DomainEvents(fakeLogger());
        const bookingConfirmed: unknown[] = [];
        const paymentSucceeded: unknown[] = [];
        events.on('BookingConfirmed', (payload) => {
          bookingConfirmed.push(payload);
        });
        events.on('PaymentSucceeded', (payload) => {
          paymentSucceeded.push(payload);
        });
        const spiedLedger = new RefundLedgerService(db, clock, fakeLogger(), events);

        // PARTIEL, pas total : c'est le seul cas ou la reservation se confirme
        // (voir NEVER_CAPTURED_PAYMENT_STATUSES / shouldConfirmReservation dans
        // refund-ledger.service.ts).
        const refund = providerRefund({
          amountMinor: 400,
          providerIntentId: seed.providerPaymentIntentId,
          providerChargeId: seed.providerChargeId,
        });

        await spiedLedger.apply({ paymentId: seed.paymentId, refunds: [refund] });
        // `DomainEvents.on` execute son handler via une IIFE async ; laisser la
        // microtask queue se vider avant d'inspecter les tableaux.
        await new Promise((resolve) => setImmediate(resolve));

        expect(bookingConfirmed).toHaveLength(1);
        expect(bookingConfirmed[0]).toMatchObject({ reservationId: seed.reservationId, isFree: false });
        expect(paymentSucceeded).toHaveLength(1);
        expect(paymentSucceeded[0]).toMatchObject({
          reservationId: seed.reservationId,
          paymentId: seed.paymentId,
          amount: 1000,
        });

        const [reservation] = await db
          .select({ status: schema.reservations.status })
          .from(schema.reservations)
          .where(eq(schema.reservations.id, seed.reservationId));
        expect(reservation?.status).toBe('CONFIRMED');
      } finally {
        await seed.cleanup();
      }
    },
  );

  it(
    "encaissement jamais vu : un remboursement TOTAL emet PaymentSucceeded (l'encaissement a bien eu lieu) mais " +
      'jamais BookingConfirmed (la reservation, elle, ne se confirme pas)',
    async () => {
      const seed = await seedPaidReservation({
        amount: 1000,
        platformFeeAmount: 250,
        status: 'REQUIRES_PAYMENT',
        reservationStatus: 'PAYMENT_PENDING',
      });
      try {
        const events = new DomainEvents(fakeLogger());
        const bookingConfirmed: unknown[] = [];
        const paymentSucceeded: unknown[] = [];
        events.on('BookingConfirmed', (payload) => {
          bookingConfirmed.push(payload);
        });
        events.on('PaymentSucceeded', (payload) => {
          paymentSucceeded.push(payload);
        });
        const spiedLedger = new RefundLedgerService(db, clock, fakeLogger(), events);

        const refund = providerRefund({
          amountMinor: 1000,
          providerIntentId: seed.providerPaymentIntentId,
          providerChargeId: seed.providerChargeId,
        });

        await spiedLedger.apply({ paymentId: seed.paymentId, refunds: [refund] });
        await new Promise((resolve) => setImmediate(resolve));

        // Regression exacte du blocage 1 (revue du 2026-08-16, 2e tour) : avant
        // le correctif, ce remboursement TOTAL emettait BookingConfirmed — un
        // e-mail de confirmation avec code de check-in pour un client rembourse
        // a 100%.
        expect(bookingConfirmed).toHaveLength(0);
        expect(paymentSucceeded).toHaveLength(1);

        const [reservation] = await db
          .select({ status: schema.reservations.status })
          .from(schema.reservations)
          .where(eq(schema.reservations.id, seed.reservationId));
        expect(reservation?.status).toBe('PAYMENT_PENDING');
      } finally {
        await seed.cleanup();
      }
    },
  );

  it(
    "encaissement jamais vu : aucun BookingConfirmed ni PaymentSucceeded quand aucune promotion n'a eu lieu " +
      '(ligne PENDING seule)',
    async () => {
      const seed = await seedPaidReservation({
        amount: 1000,
        platformFeeAmount: 250,
        status: 'REQUIRES_PAYMENT',
        reservationStatus: 'PAYMENT_PENDING',
      });
      try {
        const events = new DomainEvents(fakeLogger());
        const bookingConfirmed: unknown[] = [];
        const paymentSucceeded: unknown[] = [];
        events.on('BookingConfirmed', (payload) => {
          bookingConfirmed.push(payload);
        });
        events.on('PaymentSucceeded', (payload) => {
          paymentSucceeded.push(payload);
        });
        const spiedLedger = new RefundLedgerService(db, clock, fakeLogger(), events);

        const refund = providerRefund({
          amountMinor: 400,
          providerIntentId: seed.providerPaymentIntentId,
          providerChargeId: seed.providerChargeId,
          status: 'PENDING',
        });

        await spiedLedger.apply({ paymentId: seed.paymentId, refunds: [refund] });
        await new Promise((resolve) => setImmediate(resolve));

        expect(bookingConfirmed).toHaveLength(0);
        expect(paymentSucceeded).toHaveLength(0);
      } finally {
        await seed.cleanup();
      }
    },
  );

  it(
    "encaissement jamais vu : une ligne PENDING seule sans preuve suffisante journalise un warn dedie, sinon " +
      "l'anomalie passe totalement inapercue",
    async () => {
      const seed = await seedPaidReservation({
        amount: 1000,
        platformFeeAmount: 250,
        status: 'REQUIRES_PAYMENT',
        reservationStatus: 'PAYMENT_PENDING',
      });
      try {
        const warnCalls: Array<[Record<string, unknown>, string]> = [];
        const spyLogger = {
          info: () => {},
          warn: (meta: Record<string, unknown>, msg: string) => {
            warnCalls.push([meta, msg]);
          },
          error: () => {},
          debug: () => {},
          fatal: () => {},
          trace: () => {},
        } as unknown as Logger;
        const spiedLedger = new RefundLedgerService(
          db,
          clock,
          { ...spyLogger, child: () => spyLogger } as unknown as Logger,
          new DomainEvents(fakeLogger()),
        );

        const refund = providerRefund({
          amountMinor: 400,
          providerIntentId: seed.providerPaymentIntentId,
          providerChargeId: seed.providerChargeId,
          status: 'PENDING',
        });

        const result = await spiedLedger.apply({ paymentId: seed.paymentId, refunds: [refund] });

        expect(result.paymentStatus).toBe('REQUIRES_PAYMENT');

        // Avant ce correctif (revue du 2026-08-16, 2e tour) : l'ancien
        // logger.error inconditionnel a disparu avec le garde `captureRecovered`
        // introduit au tour precedent, et ce cas precis (une ligne PENDING seule
        // sur un paiement jamais confirme) ne journalisait plus rien du tout —
        // pourtant l'anomalie la plus digne d'etre vue.
        const match = warnCalls.find(([, msg]) =>
          msg.includes("sans ligne SUCCEEDED suffisante pour reconstruire l'encaissement"),
        );
        expect(match).toBeDefined();
        expect(match?.[0]).toMatchObject({ paymentId: seed.paymentId, previousStatus: 'REQUIRES_PAYMENT' });
      } finally {
        await seed.cleanup();
      }
    },
  );

  it(
    'un remboursement PARTIEL qui reconstruit une capture jamais vue ne s\'interbloque pas avec une annulation ' +
      "concurrente qui verrouille dans l'ordre inverse (reservations puis payments)",
    async () => {
      const seed = await seedPaidReservation({
        amount: 1000,
        platformFeeAmount: 150,
        status: 'REQUIRES_PAYMENT',
        reservationStatus: 'PAYMENT_PENDING',
      });
      try {
        const refund = providerRefund({
          amountMinor: 400,
          providerIntentId: seed.providerPaymentIntentId,
          providerChargeId: seed.providerChargeId,
        });

        let releaseReservationLocked: () => void = () => {};
        const reservationLocked = new Promise<void>((resolve) => {
          releaseReservationLocked = resolve;
        });

        // Reproduit exactement l'ordre de verrouillage de
        // booking.service.ts (cancel()) -> payment.service.ts
        // (refundReservation()) : reservations, PUIS payments — avec un delai
        // au milieu pour garantir le chevauchement avec ledger.apply()
        // ci-dessous, exactement comme le fait le veritable appel reseau Stripe
        // entre les deux verrous en production.
        const cancelLike = db.transaction(async (tx) => {
          await tx.execute(sql`SELECT 1 FROM reservations WHERE id = ${seed.reservationId} FOR UPDATE`);
          releaseReservationLocked();
          await new Promise((resolve) => setTimeout(resolve, 300));
          await tx.execute(sql`SELECT 1 FROM payments WHERE id = ${seed.paymentId} FOR UPDATE`);
        });

        await reservationLocked;
        const refundApply = ledger.apply({ paymentId: seed.paymentId, refunds: [refund] });

        // Avant le correctif du blocage 2 (revue du 2026-08-16, 2e tour), ce
        // scenario formait un interblocage ABBA : `ledger.apply()` verrouillait
        // `reservations` (via `confirmReservationOnCapture`) A L'INTERIEUR de
        // la meme transaction que son verrou `payments`, dans l'ordre inverse
        // de `cancelLike` ci-dessus. Postgres detecte un tel cycle
        // (`deadlock_timeout`, ~1s par defaut) et rejette L'UNE des deux
        // transactions avec le code 40P01 : ce test echoue en levant cette
        // erreur si la regression reapparait.
        await expect(Promise.all([cancelLike, refundApply])).resolves.toBeDefined();

        const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, seed.paymentId));
        expect(payment?.status).toBe('PARTIALLY_REFUNDED');

        const [reservation] = await db
          .select({ status: schema.reservations.status })
          .from(schema.reservations)
          .where(eq(schema.reservations.id, seed.reservationId));
        expect(reservation?.status).toBe('CONFIRMED');
      } finally {
        await seed.cleanup();
      }
    },
    10_000,
  );
});
