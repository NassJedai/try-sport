import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import { SystemClock } from '@try/utils';
import type { Logger } from '@try/logger';
import type { AppConfig } from '@try/config';
import { BookingService } from '../src/modules/bookings/booking.service.js';
import { PaymentService } from '../src/modules/payments/payment.service.js';
import { RefundLedgerService } from '../src/modules/payments/refund-ledger.service.js';
import { StripePaymentProvider } from '../src/modules/payments/stripe.provider.js';
import { AuditService } from '../src/modules/admin/audit.service.js';
import { CryptoService } from '../src/common/crypto.service.js';
import { DomainEvents } from '../src/modules/events/domain-events.js';
import {
  connect,
  createTestUser,
  INTEGRATION_DATABASE_URL,
  seedBookableSlot,
} from './integration-setup.js';

/**
 * Parcours de paiement hebergé Stripe Checkout, contre le vrai Stripe en mode
 * test — pas un double.
 *
 * Deux verites empiriques, verifiees contre la vraie API avant d'ecrire quoi
 * que ce soit ici :
 *
 *  1. `checkout.sessions.create` accepte reellement nos parametres (montant,
 *     `expires_at`, `success_url`/`cancel_url` en `try://`,
 *     `payment_intent_data`) et rend une vraie URL `checkout.stripe.com`.
 *  2. Le PaymentIntent d'une Checkout Session hebergee N'EXISTE PAS avant que
 *     le client ouvre reellement la page — `session.payment_intent` revient
 *     `null`, meme avec `expand`, immediatement apres la creation ET
 *     plusieurs secondes plus tard. Ce deuxieme point a invalide ma toute
 *     premiere implementation (qui supposait, a tort, que
 *     `providerPaymentIntentId` etait connu des la creation) : c'est ce test,
 *     lance contre le vrai Stripe, qui l'a revele — pas une relecture.
 *
 * Consequence sur la preuve : rien ici ne peut piloter un vrai navigateur
 * pour completer la page hebergee elle-meme (ce depot n'a pas Playwright, et
 * en ajouter un pour ce seul test aurait ete un contournement plus lourd que
 * ce qu'il prouve). Ce test prouve donc separement les deux moities reelles :
 * un VRAI PaymentIntent, cree et confirme directement contre Stripe avec la
 * carte de test 4242, pour la moitie « de l'argent bouge reellement en mode
 * test » — puis l'application du fait metier
 * (`PaymentService.applyCheckoutCompleted`, exactement la methode que le
 * dispatcher webhook appelle) avec les identifiants reels que Stripe vient de
 * rendre, pour la moitie « notre code reagit correctement ». La livraison
 * HTTP du webhook (signature, route `/v1/webhooks/stripe`) est deja couverte
 * ailleurs (`stripe.provider.test.ts`, `webhook-dispatcher.test.ts`).
 *
 * Sautee, bruyamment, si `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` ne sont
 * pas dans l'environnement — exactement le meme principe que
 * `describeIfDatabase`, pour la meme raison : un run qui saute en silence se
 * fait passer pour un run qui a verifie quelque chose.
 */
const STRIPE_CONFIGURED = Boolean(
  process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET,
);

function describeSuite(name: string, fn: () => void): void {
  if (!INTEGRATION_DATABASE_URL) {
    describe.skip(`${name} [requires TEST_DATABASE_URL with PostGIS]`, fn);
    return;
  }
  if (!STRIPE_CONFIGURED) {
    describe.skip(`${name} [requires STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET]`, fn);
    return;
  }
  describe(name, fn);
}

function fakeLogger(): Logger {
  const noop = (): void => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop };
  return { ...logger, child: () => logger } as unknown as Logger;
}

describeSuite('Checkout Session hebergee — paiement de test reel de bout en bout', () => {
  let db: Database;
  let close: () => Promise<void>;
  let bookings: BookingService;
  let payments: PaymentService;
  let stripe: Stripe;

  beforeAll(() => {
    ({ db, close } = connect());

    const config = {
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    } as AppConfig;

    const clock = new SystemClock();
    const logger = fakeLogger();
    const events = new DomainEvents(logger);
    const provider = new StripePaymentProvider(config);
    const ledger = new RefundLedgerService(db, clock, logger, events);
    payments = new PaymentService(db, provider, clock, logger, events, ledger);
    const crypto = new CryptoService({ CHECKIN_TOKEN_SECRET: 'integration-test-secret' } as AppConfig);

    bookings = new BookingService(db, clock, logger, crypto, payments, events, new AuditService(db));
    stripe = new Stripe(config.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 15_000 });
  });

  afterAll(async () => {
    await close();
  });

  it(
    'cree une session hebergee reelle avec le bon montant, puis — la carte de test 4242 ' +
      "reellement debitee cote Stripe — confirme la reservation, enregistre la commission " +
      "au bon montant, et rembourse a l'annulation",
    async () => {
      const AMOUNT = 4000; // 40,00 EUR — un quart exact, sans ambiguite d'arrondi.
      const EXPECTED_FEE = 1000; // 25 % (commissionBasisPoints par defaut du seed : 2500).
      const slot = await seedBookableSlot(db, { capacity: 1, priceAmount: AMOUNT });
      const user = await createTestUser(db);
      let reservationId: string | undefined;

      try {
        const result = await bookings.create({ userId: user.id, dto: { slotId: slot.slotId } });
        reservationId = result.reservationId;

        expect(result.requiresPayment).toBe(true);
        expect(result.status).toBe('PAYMENT_PENDING');
        // Une vraie page Stripe, jamais un prix ou un secret venu du client :
        // seul un identifiant de session est renvoye.
        expect(result.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);

        const [paymentBefore] = await db
          .select()
          .from(schema.payments)
          .where(eq(schema.payments.reservationId, result.reservationId));

        expect(paymentBefore?.status).toBe('REQUIRES_PAYMENT');
        // Pas encore connu : voir le commentaire d'en-tete de ce fichier.
        expect(paymentBefore?.providerPaymentIntentId).toBeNull();
        expect(paymentBefore?.amount).toBe(AMOUNT);
        expect(paymentBefore?.platformFeeAmount).toBe(EXPECTED_FEE);
        expect(paymentBefore?.merchantAmount).toBe(AMOUNT - EXPECTED_FEE);

        // La moitie « de l'argent bouge reellement en mode test » : un vrai
        // PaymentIntent, cree et confirme directement contre Stripe avec la
        // carte de test 4242 4242 4242 4242 (celle que la doc Stripe met en
        // avant pour ce scenario). Verifiable dans le dashboard Stripe test.
        const intent = await stripe.paymentIntents.create({
          amount: AMOUNT,
          currency: 'eur',
          confirm: true,
          payment_method: 'pm_card_visa',
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          metadata: { reservation_id: result.reservationId },
        });
        expect(intent.status).toBe('succeeded');
        const chargeId =
          typeof intent.latest_charge === 'string'
            ? intent.latest_charge
            : (intent.latest_charge?.id ?? null);
        expect(chargeId).toMatch(/^ch_/);

        // La moitie « notre code reagit correctement » : exactement la methode
        // que `WebhookDispatcherService` appelle pour un fait
        // `CHECKOUT_COMPLETED`, avec les identifiants et le montant reellement
        // rendus par Stripe ci-dessus.
        await payments.applyCheckoutCompleted({
          reservationId: result.reservationId,
          providerIntentId: intent.id,
          paid: true,
          amountTotalMinor: AMOUNT,
        });

        const [reservation] = await db
          .select()
          .from(schema.reservations)
          .where(eq(schema.reservations.id, result.reservationId));
        expect(reservation?.status).toBe('CONFIRMED');

        const [paymentAfter] = await db
          .select()
          .from(schema.payments)
          .where(eq(schema.payments.reservationId, result.reservationId));
        expect(paymentAfter?.status).toBe('SUCCEEDED');
        expect(paymentAfter?.providerPaymentIntentId).toBe(intent.id);
        expect(paymentAfter?.platformFeeAmount).toBe(EXPECTED_FEE);

        const [trial] = await db
          .select()
          .from(schema.trialHistory)
          .where(eq(schema.trialHistory.reservationId, result.reservationId));
        expect(trial?.status).toBe('CONFIRMED');

        // Redelivrance hors sequence d'un `payment_intent.succeeded` pour le
        // meme intent, maintenant que `providerPaymentIntentId` est connu —
        // doit rester un no-op sans effet de bord (idempotence croisee entre
        // les deux chemins d'application).
        await payments.markSucceeded(intent.id, chargeId);
        const [paymentAfterReplay] = await db
          .select()
          .from(schema.payments)
          .where(eq(schema.payments.reservationId, result.reservationId));
        expect(paymentAfterReplay?.status).toBe('SUCCEEDED');

        // L'annulation et le remboursement doivent continuer de fonctionner
        // sur un paiement passe par ce chemin — verifie, pas suppose.
        const cancelOutcome = await bookings.cancel({
          reservationId: result.reservationId,
          userId: user.id,
        });
        expect(cancelOutcome.refunded).toBe(true);

        const [paymentRefunded] = await db
          .select()
          .from(schema.payments)
          .where(eq(schema.payments.reservationId, result.reservationId));
        expect(paymentRefunded?.status).toBe('REFUNDED');
        expect(paymentRefunded?.refundedAmount).toBe(AMOUNT);
        expect(paymentRefunded?.refundedPlatformFeeAmount).toBe(EXPECTED_FEE);
      } finally {
        if (reservationId) {
          const [payment] = await db
            .select({ id: schema.payments.id })
            .from(schema.payments)
            .where(eq(schema.payments.reservationId, reservationId));
          if (payment) {
            await db.delete(schema.refunds).where(eq(schema.refunds.paymentId, payment.id));
            await db.delete(schema.payments).where(eq(schema.payments.id, payment.id));
          }
          await db.delete(schema.reservations).where(eq(schema.reservations.id, reservationId));
        }
        await slot.cleanup();
        await db.delete(schema.users).where(eq(schema.users.id, user.id));
      }
    },
    30_000,
  );

  it('refuse un montant rapporte par Stripe qui ne correspond pas au paiement enregistre', async () => {
    const AMOUNT = 5000;
    const slot = await seedBookableSlot(db, { capacity: 1, priceAmount: AMOUNT });
    const user = await createTestUser(db);
    let reservationId: string | undefined;

    try {
      const result = await bookings.create({ userId: user.id, dto: { slotId: slot.slotId } });
      reservationId = result.reservationId;

      await payments.applyCheckoutCompleted({
        reservationId: result.reservationId,
        providerIntentId: 'pi_fake_mismatch',
        paid: true,
        amountTotalMinor: 100, // 1,00 EUR — tres different des 50,00 EUR attendus.
      });

      const [payment] = await db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.reservationId, result.reservationId));
      expect(payment?.status).toBe('REQUIRES_PAYMENT');
      expect(payment?.providerPaymentIntentId).toBeNull();

      const [reservation] = await db
        .select()
        .from(schema.reservations)
        .where(eq(schema.reservations.id, result.reservationId));
      expect(reservation?.status).toBe('PAYMENT_PENDING');
    } finally {
      if (reservationId) {
        await db.delete(schema.payments).where(eq(schema.payments.reservationId, reservationId));
        await db.delete(schema.reservations).where(eq(schema.reservations.id, reservationId));
      }
      await slot.cleanup();
      await db.delete(schema.users).where(eq(schema.users.id, user.id));
    }
  });
});
