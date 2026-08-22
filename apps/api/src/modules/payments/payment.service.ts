import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
   * Creates the PaymentIntent for a reservation and records our side of it.
   *
   * The commission is computed here from the business's contract — never sent by
   * a client, never trusted from a webhook. `platformFee + merchant = amount` is
   * additionally enforced by a CHECK constraint, so a rounding mistake fails the
   * insert instead of quietly mis-paying a venue.
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
    },
  ): Promise<string> {
    const gross = money(input.amount, input.currency);
    const platformFee = applyBasisPoints(gross, input.commissionBasisPoints);
    const merchantAmount = gross.amount - platformFee.amount;

    const intent = await this.provider.createIntent({
      reservationId: input.reservationId,
      amountMinor: gross.amount,
      currency: input.currency,
      applicationFeeMinor: platformFee.amount,
      metadata: {
        reservation_id: input.reservationId,
        business_id: input.businessId,
        user_id: input.userId,
      },
      // Keyed on the reservation: a retry of this booking reuses the same intent.
      idempotencyKey: `reservation:${input.reservationId}`,
    });

    await tx.insert(schema.payments).values({
      reservationId: input.reservationId,
      userId: input.userId,
      businessId: input.businessId,
      status: 'REQUIRES_PAYMENT',
      provider: 'STRIPE',
      providerPaymentIntentId: intent.providerIntentId,
      amount: gross.amount,
      platformFeeAmount: platformFee.amount,
      merchantAmount,
      currency: input.currency,
    });

    return intent.clientSecret;
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
   */
  async markSucceeded(providerIntentId: string, providerChargeId?: string | null): Promise<void> {
    const now = this.clock.now();

    const outcome = await this.db.transaction(async (tx) => {
      const [payment] = await tx
        .update(schema.payments)
        .set({
          status: 'SUCCEEDED',
          succeededAt: now,
          updatedAt: now,
          ...(providerChargeId
            ? {
                providerChargeId: sql`COALESCE(${schema.payments.providerChargeId}, ${providerChargeId})`,
              }
            : {}),
        })
        .where(
          and(
            eq(schema.payments.providerPaymentIntentId, providerIntentId),
            inArray(schema.payments.status, NEVER_CAPTURED_PAYMENT_STATUSES),
          ),
        )
        .returning();

      if (!payment) {
        const [existing] = await tx
          .select({ status: schema.payments.status })
          .from(schema.payments)
          .where(eq(schema.payments.providerPaymentIntentId, providerIntentId))
          .limit(1);

        if (existing?.status === 'REFUNDED' || existing?.status === 'PARTIALLY_REFUNDED') {
          this.logger.warn(
            { providerIntentId, status: existing.status },
            'payment_intent.succeeded livre hors sequence, apres un remboursement — ignore pour ne pas effacer le remboursement du bilan',
          );
        } else {
          // Already processed, or an intent we do not know about. Both are safe to
          // acknowledge; logging keeps the second case visible.
          this.logger.info({ providerIntentId }, 'payment webhook ignored (already applied)');
        }
        return null;
      }

      const confirmed = await confirmReservationOnCapture(tx, payment.reservationId, now);
      return { payment, confirmed };
    });

    if (!outcome) return;

    // Emis APRES le commit, exactement comme RefundLedgerService.apply() et
    // BusinessService (LeadConverted) : emettre depuis l'interieur de la
    // transaction ci-dessus exposerait un abonne (l'e-mail de confirmation) a
    // un evenement pour un etat qu'une erreur survenue plus tard dans la meme
    // transaction pourrait encore annuler. Rien ne peut plus le faire a partir
    // d'ici : la transaction a deja commit.
    if (outcome.confirmed) {
      this.events.emit('BookingConfirmed', {
        reservationId: outcome.confirmed.reservationId,
        userId: outcome.confirmed.userId,
        businessId: outcome.confirmed.businessId,
        venueId: outcome.confirmed.venueId,
        offerId: outcome.confirmed.offerId,
        isFree: false,
      });
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
