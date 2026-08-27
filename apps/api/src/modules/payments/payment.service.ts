import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { applyBasisPoints, money } from '@try/utils';
import type { CurrencyCode } from '@try/utils';
import type { Clock } from '@try/utils';
import { NEVER_CAPTURED_PAYMENT_STATUSES } from '@try/contracts';
import { schema } from '@try/database';
import type { Database, Executor, Transaction } from '@try/database';
import type { Logger } from '@try/logger';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { LOGGER } from '../../common/logger.module.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { DomainEvents } from '../events/domain-events.js';
import { PAYMENT_PROVIDER, type PaymentProvider, type ProviderRefund } from './payment-provider.js';
import { RefundLedgerService } from './refund-ledger.service.js';
import { confirmReservationOnCapture } from './confirm-capture.js';

/** Un webhook dont le traitement echoue N fois est abandonne au job de rejeu manuel. */
const MAX_WEBHOOK_ATTEMPTS = 10;

/** Somme des lignes PENDING, dedoublonnee par identifiant de mouvement. La
 *  projection du registre ne compte que les lignes SUCCEEDED ; une ligne PENDING
 *  est de l'argent deja parti chez le fournisseur, que le webhook confirmera. */
function pendingTotal(lines: ProviderRefund[]): number {
  const byId = new Map<string, ProviderRefund>();
  for (const line of lines) byId.set(line.providerRefundId, line);
  let total = 0;
  for (const line of byId.values()) if (line.status === 'PENDING') total += line.amountMinor;
  return total;
}

@Injectable()
export class PaymentService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly events: DomainEvents,
    private readonly ledger: RefundLedgerService,
  ) {}

  /**
   * Creates a hosted Checkout Session for a reservation and records our side
   * of it. Returns the URL to open in the customer's browser.
   *
   * The commission is computed here from the business's contract — never sent by
   * a client, never trusted from a webhook. `platformFee + merchant = amount` is
   * additionally enforced by a CHECK constraint, so a rounding mistake fails the
   * insert instead of quietly mis-paying a venue.
   *
   * `checkoutExpiresAt` is owned by the caller (`BookingService`, alongside the
   * reservation's own hold window) — see `PAYMENT_HOLD_MINUTES` there for why
   * the two must stay in a specific order, not just both "reasonable".
   */
  async createIntentForReservation(
    tx: Transaction,
    input: {
      reservationId: string;
      userId: string;
      businessId: string;
      amount: number;
      currency: CurrencyCode;
      commissionBasisPoints: number;
      description: string;
      checkoutExpiresAt: Date;
    },
  ): Promise<string> {
    const gross = money(input.amount, input.currency);
    const platformFee = applyBasisPoints(gross, input.commissionBasisPoints);
    const merchantAmount = gross.amount - platformFee.amount;
    const { successUrl, cancelUrl } = this.buildReturnUrls(input.reservationId);

    const session = await this.provider.createCheckoutSession({
      reservationId: input.reservationId,
      amountMinor: gross.amount,
      currency: input.currency,
      applicationFeeMinor: platformFee.amount,
      description: input.description,
      metadata: {
        reservation_id: input.reservationId,
        business_id: input.businessId,
        user_id: input.userId,
      },
      // Keyed on the reservation: a retry of this booking reuses the same session.
      idempotencyKey: `reservation:${input.reservationId}`,
      successUrl,
      cancelUrl,
      expiresAt: input.checkoutExpiresAt,
    });

    await tx.insert(schema.payments).values({
      reservationId: input.reservationId,
      userId: input.userId,
      businessId: input.businessId,
      status: 'REQUIRES_PAYMENT',
      provider: 'STRIPE',
      // Not knowable yet: Stripe does not create the underlying PaymentIntent
      // for a Checkout Session until the customer opens the page (see
      // `createCheckoutSession`'s doc comment). Backfilled by
      // `applyCheckoutCompleted` once `checkout.session.completed` reveals it.
      providerPaymentIntentId: null,
      amount: gross.amount,
      platformFeeAmount: platformFee.amount,
      merchantAmount,
      currency: input.currency,
    });

    return session.checkoutUrl;
  }

  /**
   * Deep links back into the mobile app. `try://` is TRY's fixed URL scheme
   * (see CLAUDE.md — a technical identifier, not user-facing text, hence
   * hardcoded rather than configured). Purely a landing spot: nothing reads
   * `status` to decide whether the booking is paid — that's the webhook's job
   * — it only lets the app show the right screen immediately instead of
   * dropping the customer on their booking list. If the deep link never
   * fires at all (app not installed, an external browser that does not hand
   * the scheme back, the customer closing the tab outright), the booking
   * still resolves correctly the moment the webhook lands; the customer just
   * has to reopen the app instead of being taken straight back into it.
   */
  private buildReturnUrls(reservationId: string): { successUrl: string; cancelUrl: string } {
    return {
      successUrl: `try://booking/${reservationId}/payment-return?status=success`,
      cancelUrl: `try://booking/${reservationId}/payment-return?status=cancel`,
    };
  }

  /**
   * Applies a verified `payment_intent.succeeded` event.
   *
   * Idempotent by construction: the UPDATE is conditional on the payment not
   * already being in a terminal state, so Stripe's at-least-once redelivery
   * cannot confirm a booking twice or emit two confirmation emails. The guard
   * also excludes REFUNDED/PARTIALLY_REFUNDED: Stripe does not guarantee event
   * order, and a `succeeded` delivered after a refund must not resurrect the
   * payment to SUCCEEDED and erase the refund from the books.
   *
   * The guard reuses `NEVER_CAPTURED_PAYMENT_STATUSES` (@try/contracts) — see
   * the divergence note on `markFailed` below, which applies here too: this is
   * an idempotency question ("already settled, do not overwrite"), not a
   * revenue question ("does this count as GMV"), and the two happen to share
   * an answer today but are not guaranteed to forever.
   *
   * For a hosted-Checkout booking this fires as a redundant, order-independent
   * safety net alongside `applyCheckoutCompleted` below — see that method's
   * doc comment for why `providerPaymentIntentId` may still be null in
   * `payments` when this event happens to arrive first.
   */
  async markSucceeded(providerIntentId: string, providerChargeId?: string | null): Promise<void> {
    const outcome = await this.captureSucceeded({
      updateWhere: and(
        eq(schema.payments.providerPaymentIntentId, providerIntentId),
        inArray(schema.payments.status, NEVER_CAPTURED_PAYMENT_STATUSES),
      )!,
      existingWhere: eq(schema.payments.providerPaymentIntentId, providerIntentId),
      providerChargeId,
      outOfSequenceLogMessage:
        'payment_intent.succeeded livre hors sequence, apres un remboursement — ignore pour ne pas effacer le remboursement du bilan',
      logContext: { providerIntentId },
    });

    if (outcome) this.emitCaptureOutcome(outcome, { providerIntentId });
  }

  /**
   * Applies a verified `checkout.session.completed` event (or
   * `checkout.session.async_payment_succeeded`, should that ever be wired up
   * — see `stripe.provider.ts`).
   *
   * Cannot reuse `markSucceeded`'s lookup: a Checkout Session's underlying
   * PaymentIntent does not exist at the moment `createIntentForReservation`
   * writes the `payments` row (verified empirically against the real API —
   * see `stripe.provider.ts`), so `providerPaymentIntentId` is still null
   * there. This looks the row up by `reservationId` instead — taken from the
   * session's own metadata, set by us at creation and never editable by the
   * payer — and backfills `providerPaymentIntentId` with whatever the
   * webhook now reveals, which is the first moment it is knowable. Every
   * downstream consumer of that column (refunds, a redelivered
   * `payment_intent.succeeded`) works unmodified from this point on.
   *
   * A `paid: false` fact (an async payment method still settling, or a
   * session that closed without paying) is a deliberate no-op: nothing to
   * capture yet, and the hold's own expiry sweep is what reclaims the slot
   * if it never arrives.
   *
   * `amountTotalMinor`, when the event carries it, is folded into the UPDATE's
   * own WHERE clause rather than checked separately: this reservation's
   * `metadata.reservation_id` can only ever appear on the one Checkout
   * Session `createIntentForReservation` created for it (server-set,
   * idempotency-keyed one-per-reservation, never client-suppliable), so
   * nothing today can actually present a mismatched amount here — but the
   * check is cheap, and a mismatch is exactly the shape a future regression
   * (a second code path creating sessions, a loosened idempotency key) would
   * take. Cheaper to guard now than to explain later why it wasn't.
   */
  async applyCheckoutCompleted(input: {
    reservationId: string | null;
    providerIntentId: string | null;
    paid: boolean;
    amountTotalMinor: number | null;
  }): Promise<void> {
    if (!input.reservationId) {
      this.logger.warn(
        { providerIntentId: input.providerIntentId },
        'checkout.session.completed sans reservation_id exploitable en metadata',
      );
      return;
    }
    if (!input.paid) return;

    const updateConditions = [
      eq(schema.payments.reservationId, input.reservationId),
      inArray(schema.payments.status, NEVER_CAPTURED_PAYMENT_STATUSES),
    ];
    if (input.amountTotalMinor !== null) {
      updateConditions.push(eq(schema.payments.amount, input.amountTotalMinor));
    }

    const outcome = await this.captureSucceeded({
      updateWhere: and(...updateConditions)!,
      existingWhere: eq(schema.payments.reservationId, input.reservationId),
      providerIntentId: input.providerIntentId,
      outOfSequenceLogMessage:
        'checkout.session.completed livre hors sequence, apres un remboursement — ignore pour ne pas effacer le remboursement du bilan',
      logContext: { reservationId: input.reservationId, providerIntentId: input.providerIntentId },
    });

    if (!outcome) {
      // Distinguish a genuine mismatch from the ordinary "already applied" /
      // "REFUNDED" cases `captureSucceeded` already logged: those return
      // early inside the shared core, so reaching here with a row that
      // exists, is still capturable, but simply has a different `amount`
      // means the WHERE clause's amount condition is what rejected it.
      const [existing] = await this.db
        .select({ status: schema.payments.status, amount: schema.payments.amount })
        .from(schema.payments)
        .where(eq(schema.payments.reservationId, input.reservationId))
        .limit(1);
      if (
        existing &&
        input.amountTotalMinor !== null &&
        existing.amount !== input.amountTotalMinor &&
        (NEVER_CAPTURED_PAYMENT_STATUSES as readonly string[]).includes(existing.status)
      ) {
        this.logger.error(
          {
            reservationId: input.reservationId,
            expected: existing.amount,
            reported: input.amountTotalMinor,
          },
          'checkout.session.completed : montant rapporte par Stripe different du paiement enregistre — refuse',
        );
      }
      return;
    }

    this.emitCaptureOutcome(outcome, { providerIntentId: input.providerIntentId ?? undefined });
  }

  /**
   * Shared core of `markSucceeded` and `applyCheckoutCompleted`: mark a
   * payment row SUCCEEDED and confirm its reservation, whichever column the
   * caller can actually key on. Kept as one implementation on purpose —
   * see `payment-capture-contract-dedup` in project memory for why letting
   * two copies of this exact idempotency guard drift apart has already cost
   * a bug once.
   */
  private async captureSucceeded(input: {
    updateWhere: SQL;
    existingWhere: SQL;
    providerChargeId?: string | null;
    providerIntentId?: string | null;
    outOfSequenceLogMessage: string;
    logContext: Record<string, unknown>;
  }): Promise<{
    payment: typeof schema.payments.$inferSelect;
    confirmed: Awaited<ReturnType<typeof confirmReservationOnCapture>>;
  } | null> {
    const now = this.clock.now();

    return this.db.transaction(async (tx) => {
      const [payment] = await tx
        .update(schema.payments)
        .set({
          status: 'SUCCEEDED',
          succeededAt: now,
          updatedAt: now,
          ...(input.providerChargeId
            ? {
                providerChargeId: sql`COALESCE(${schema.payments.providerChargeId}, ${input.providerChargeId})`,
              }
            : {}),
          ...(input.providerIntentId
            ? {
                providerPaymentIntentId: sql`COALESCE(${schema.payments.providerPaymentIntentId}, ${input.providerIntentId})`,
              }
            : {}),
        })
        .where(input.updateWhere)
        .returning();

      if (!payment) {
        const [existing] = await tx
          .select({ status: schema.payments.status })
          .from(schema.payments)
          .where(input.existingWhere)
          .limit(1);

        if (existing?.status === 'REFUNDED' || existing?.status === 'PARTIALLY_REFUNDED') {
          this.logger.warn({ ...input.logContext, status: existing.status }, input.outOfSequenceLogMessage);
        } else {
          // Already processed, or a payment we do not know about. Both are safe to
          // acknowledge; logging keeps the second case visible.
          this.logger.info(input.logContext, 'payment webhook ignored (already applied)');
        }
        return null;
      }

      const confirmed = await confirmReservationOnCapture(tx, payment.reservationId, now);
      return { payment, confirmed };
    });
  }

  /**
   * Emis APRES le commit, exactement comme RefundLedgerService.apply() et
   * BusinessService (LeadConverted) : emettre depuis l'interieur de la
   * transaction de `captureSucceeded` exposerait un abonne (l'e-mail de
   * confirmation) a un evenement pour un etat qu'une erreur survenue plus
   * tard dans la meme transaction pourrait encore annuler. Rien ne peut plus
   * le faire a partir d'ici : la transaction a deja commit.
   */
  private emitCaptureOutcome(
    outcome: {
      payment: typeof schema.payments.$inferSelect;
      confirmed: Awaited<ReturnType<typeof confirmReservationOnCapture>>;
    },
    logContext: Record<string, unknown>,
  ): void {
    if (outcome.confirmed) {
      this.events.emit('BookingConfirmed', {
        reservationId: outcome.confirmed.reservationId,
        userId: outcome.confirmed.userId,
        businessId: outcome.confirmed.businessId,
        venueId: outcome.confirmed.venueId,
        offerId: outcome.confirmed.offerId,
        isFree: false,
      });
    } else {
      // Money was just captured, but the reservation was no longer
      // PAYMENT_PENDING (already EXPIRED, cancelled, ...) when the webhook
      // landed — the residual race `PAYMENT_HOLD_MINUTES` in
      // `booking.service.ts` narrows but does not claim to eliminate. There
      // is no automatic recovery for this today: the capacity may already be
      // resold, and nothing here issues a refund. Loud on purpose — this is
      // the one path where the platform is now holding a customer's money
      // against no live booking, and it needs a human to notice.
      this.logger.error(
        { ...logContext, paymentId: outcome.payment.id, reservationId: outcome.payment.reservationId },
        'paiement encaisse mais reservation non confirmable — hold deja expire, aucun remboursement automatique',
      );
    }

    this.events.emit('PaymentSucceeded', {
      reservationId: outcome.payment.reservationId,
      paymentId: outcome.payment.id,
      amount: outcome.payment.amount,
    });
  }

  /**
   * Applies a failed payment. The reservation is *not* cancelled immediately —
   * the user may retry with another card within the hold window, and cancelling
   * on the first decline would lose them the slot they were about to pay for.
   *
   * Excludes PARTIALLY_REFUNDED for the same reason as `markSucceeded`: an
   * out-of-order failure event must not erase a refund already on the books.
   *
   * This guard, and `markSucceeded`'s, share `NEVER_CAPTURED_PAYMENT_STATUSES`
   * (@try/contracts/payment-capture.ts) with the platform's revenue aggregates
   * (`admin-browse.service.ts`, `moderation.service.ts`). They are not quite
   * the same question — idempotency asks "is this row already settled, so do
   * not overwrite it", revenue asks "does this money count as GMV" — and they
   * could legitimately diverge. **The trigger that would force the split**: a
   * status where money was captured and then disputed (e.g. a Stripe
   * chargeback/`DISPUTED`) would be "already settled" for idempotency (do not
   * replay a webhook over it) while being excluded from revenue (the money can
   * still leave). Kept shared today because six duplicated copies cost more
   * than a hypothetical future divergence — but whoever introduces such a
   * status must revisit this decision, not just add a row to the
   * `PAYMENT_CAPTURE` table.
   */
  async markFailed(providerIntentId: string, failureCode: string | null): Promise<void> {
    const now = this.clock.now();

    const [payment] = await this.db
      .update(schema.payments)
      .set({ status: 'FAILED', failureCode, updatedAt: now })
      .where(
        and(
          eq(schema.payments.providerPaymentIntentId, providerIntentId),
          inArray(schema.payments.status, NEVER_CAPTURED_PAYMENT_STATUSES),
        ),
      )
      .returning();

    if (!payment) return;

    this.events.emit('PaymentFailed', {
      reservationId: payment.reservationId,
      paymentId: payment.id,
      failureCode,
    });
  }

  /**
   * Refunds whatever remains outstanding on a reservation's payment. Returns
   * false when there was nothing to refund, or when the refund did not fully
   * settle synchronously.
   *
   * `PARTIALLY_REFUNDED` is accepted as a starting status: it is what a payment
   * looks like after Stripe has already returned part of it (observed via
   * webhook, or via the `ALREADY_SETTLED` path below), and refusing it here
   * would silently strand the remaining balance on a cancellation.
   *
   * When the provider reports the charge as already fully refunded
   * (`ALREADY_SETTLED`), this reads Stripe's authoritative list of refunds and
   * applies it through the same ledger as any webhook would — it never inserts
   * a placeholder row, which would have no idempotency key and would double
   * count once the real `refund.created` webhook arrives.
   */
  async refundReservation(
    executor: Executor,
    input: { reservationId: string; reason?: string; initiatedByUserId?: string },
  ): Promise<boolean> {
    const [payment] = await executor
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.reservationId, input.reservationId))
      .for('update')
      .limit(1);

    if (!payment || !payment.providerPaymentIntentId) return false;
    if (payment.status !== 'SUCCEEDED' && payment.status !== 'PARTIALLY_REFUNDED') return false;

    const refundable = payment.amount - payment.refundedAmount;
    if (refundable <= 0) return false;

    const outcome = await this.provider.refund({
      providerIntentId: payment.providerPaymentIntentId,
      amountMinor: refundable,
      reason: input.reason,
      // Indexed on the state BEFORE, not on the amount alone: two partials of the
      // same amount on the same reservation used to collide on the same key.
      idempotencyKey: `refund:${input.reservationId}:${payment.refundedAmount}:${refundable}`,
    });

    const refunds = outcome.kind === 'CREATED' ? [outcome.refund] : outcome.refunds;
    let seen = [...refunds];
    let applied = await this.ledger.applyWithin(executor as Transaction, {
      paymentId: payment.id,
      refunds,
      initiatedByUserId: input.initiatedByUserId ?? null,
    });

    // `applied.refundedAmount` est la projection recalculee depuis le registre :
    // elle inclut les lignes deja connues avant cet appel. On y ajoute ce qui est
    // en vol chez le fournisseur pour savoir ce qui reste reellement du.
    let settled = applied.refundedAmount + pendingTotal(seen);

    if (outcome.kind === 'ALREADY_SETTLED' && settled < payment.amount) {
      // Le fournisseur vient de reveler un remboursement partiel que la base
      // ignorait. On connait desormais sa verite : demander le solde REEL.
      const remaining = payment.amount - settled;
      const topUp = await this.provider.refund({
        providerIntentId: payment.providerPaymentIntentId,
        amountMinor: remaining,
        reason: input.reason,
        // Cle indexee sur l'etat NOUVELLEMENT connu. Indispensable : la premiere
        // cle est empoisonnee chez Stripe, qui rejoue sa reponse d'erreur pendant
        // 24 h et rendrait l'annulation definitivement impossible.
        idempotencyKey: `refund:${input.reservationId}:settled:${settled}:${remaining}`,
      });
      const topUpRefunds = topUp.kind === 'CREATED' ? [topUp.refund] : topUp.refunds;
      seen = [...seen, ...topUpRefunds];
      applied = await this.ledger.applyWithin(executor as Transaction, {
        paymentId: payment.id,
        refunds: topUpRefunds,
        initiatedByUserId: input.initiatedByUserId ?? null,
      });
      settled = applied.refundedAmount + pendingTotal(seen);
    }
    // Une seule relance, jamais de boucle.

    if (settled < payment.amount) {
      this.logger.error(
        { reservationId: input.reservationId, refunded: applied.refundedAmount, settled, expected: payment.amount },
        'remboursement incomplet apres reconciliation',
      );
      // Echouer bruyamment avec l'argent intact vaut mieux que reussir en silence
      // en laissant un solde chez le fournisseur : ce throw annule la transaction
      // de booking.service, la reservation reste CONFIRMED, la place n'est pas
      // liberee, l'utilisateur peut reessayer.
      throw new ApiException('REFUND_FAILED', undefined, undefined, {
        reservationId: input.reservationId,
        refunded: applied.refundedAmount,
        settled,
        expected: payment.amount,
      });
    }

    this.logger.info({ reservationId: input.reservationId, amount: refundable }, 'reservation refunded');

    // false = tout est parti chez le fournisseur mais tout n'est pas encore
    // confirme (lignes PENDING) ; le webhook fera converger le registre.
    return applied.refundedAmount >= payment.amount;
  }

  /**
   * Records a webhook before acting on it.
   *
   * The unique index on (provider, provider_event_id) is what makes redelivery
   * safe. Unlike a plain `onConflictDoNothing`, a redelivered event whose *first*
   * attempt failed is retried here (`processedAt` still null) rather than
   * silently dropped forever — the controller always returns 2xx, so without
   * this Stripe would never resend a failed event and nothing else would either.
   */
  async recordWebhookEvent(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<{ shouldProcess: boolean; eventRowId: string | null; attemptCount: number }> {
    const [row] = await this.db
      .insert(schema.webhookEvents)
      .values({ ...input, attemptCount: 1 })
      .onConflictDoUpdate({
        target: [schema.webhookEvents.provider, schema.webhookEvents.providerEventId],
        set: { attemptCount: sql`${schema.webhookEvents.attemptCount} + 1` },
      })
      .returning({
        id: schema.webhookEvents.id,
        processedAt: schema.webhookEvents.processedAt,
        attemptCount: schema.webhookEvents.attemptCount,
      });

    if (!row) {
      return { shouldProcess: false, eventRowId: null, attemptCount: 0 };
    }

    const shouldProcess = row.processedAt === null && row.attemptCount <= MAX_WEBHOOK_ATTEMPTS;
    return { shouldProcess, eventRowId: row.id, attemptCount: row.attemptCount };
  }

  async markWebhookProcessed(eventRowId: string): Promise<void> {
    await this.db
      .update(schema.webhookEvents)
      .set({ processedAt: this.clock.now(), failedAt: null, failureMessage: null })
      .where(eq(schema.webhookEvents.id, eventRowId));
  }

  async markWebhookFailed(eventRowId: string, message: string): Promise<void> {
    await this.db
      .update(schema.webhookEvents)
      .set({
        failedAt: this.clock.now(),
        failureMessage: message.slice(0, 1000),
        attemptCount: sql`${schema.webhookEvents.attemptCount} + 1`,
      })
      .where(eq(schema.webhookEvents.id, eventRowId));
  }

  static assertConfigured(condition: boolean): void {
    if (!condition) throw new ApiException('SERVICE_UNAVAILABLE');
  }
}
