import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { applyBasisPoints, money } from '@try/utils';
import type { CurrencyCode } from '@try/utils';
import type { Clock } from '@try/utils';
import { schema } from '@try/database';
import type { Database, Executor, Transaction } from '@try/database';
import type { Logger } from '@try/logger';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { LOGGER } from '../../common/logger.module.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { DomainEvents } from '../events/domain-events.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider.js';

@Injectable()
export class PaymentService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly events: DomainEvents,
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
   * already being SUCCEEDED, so Stripe's at-least-once redelivery cannot confirm
   * a booking twice or emit two confirmation emails.
   */
  async markSucceeded(providerIntentId: string): Promise<void> {
    const now = this.clock.now();

    await this.db.transaction(async (tx) => {
      const [payment] = await tx
        .update(schema.payments)
        .set({ status: 'SUCCEEDED', succeededAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.payments.providerPaymentIntentId, providerIntentId),
            sql`${schema.payments.status} <> 'SUCCEEDED'`,
          ),
        )
        .returning();

      if (!payment) {
        // Already processed, or an intent we do not know about. Both are safe to
        // acknowledge; logging keeps the second case visible.
        this.logger.info({ providerIntentId }, 'payment webhook ignored (already applied)');
        return;
      }

      const [reservation] = await tx
        .update(schema.reservations)
        .set({
          status: 'CONFIRMED',
          confirmedAt: now,
          holdExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.reservations.id, payment.reservationId),
            eq(schema.reservations.status, 'PAYMENT_PENDING'),
          ),
        )
        .returning();

      if (reservation) {
        await tx
          .update(schema.trialHistory)
          .set({ status: 'CONFIRMED', updatedAt: now })
          .where(eq(schema.trialHistory.reservationId, reservation.id));

        this.events.emit('BookingConfirmed', {
          reservationId: reservation.id,
          userId: reservation.userId,
          businessId: reservation.businessId,
          venueId: reservation.venueId,
          offerId: reservation.offerId,
          isFree: false,
        });
      }

      this.events.emit('PaymentSucceeded', {
        reservationId: payment.reservationId,
        paymentId: payment.id,
        amount: payment.amount,
      });
    });
  }

  /**
   * Applies a failed payment. The reservation is *not* cancelled immediately —
   * the user may retry with another card within the hold window, and cancelling
   * on the first decline would lose them the slot they were about to pay for.
   */
  async markFailed(providerIntentId: string, failureCode: string | null): Promise<void> {
    const now = this.clock.now();

    const [payment] = await this.db
      .update(schema.payments)
      .set({ status: 'FAILED', failureCode, updatedAt: now })
      .where(
        and(
          eq(schema.payments.providerPaymentIntentId, providerIntentId),
          sql`${schema.payments.status} NOT IN ('SUCCEEDED', 'REFUNDED')`,
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

  /** Full refund of a reservation. Returns false when there was nothing to refund. */
  async refundReservation(
    executor: Executor,
    input: { reservationId: string; reason?: string; initiatedByUserId?: string },
  ): Promise<boolean> {
    const now = this.clock.now();

    const [payment] = await executor
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.reservationId, input.reservationId))
      .limit(1);

    if (!payment || payment.status !== 'SUCCEEDED' || !payment.providerPaymentIntentId) {
      return false;
    }

    const refundable = payment.amount - payment.refundedAmount;
    if (refundable <= 0) return false;

    const result = await this.provider.refund({
      providerIntentId: payment.providerPaymentIntentId,
      amountMinor: refundable,
      reason: input.reason,
      idempotencyKey: `refund:${input.reservationId}:${refundable}`,
    });

    await executor.insert(schema.refunds).values({
      paymentId: payment.id,
      reservationId: input.reservationId,
      providerRefundId: result.providerRefundId,
      amount: refundable,
      currency: payment.currency,
      reason: input.reason ?? null,
      initiatedByUserId: input.initiatedByUserId ?? null,
      succeededAt: now,
    });

    await executor
      .update(schema.payments)
      .set({
        refundedAmount: payment.amount,
        status: 'REFUNDED',
        updatedAt: now,
      })
      .where(eq(schema.payments.id, payment.id));

    this.logger.info(
      { reservationId: input.reservationId, amount: refundable },
      'reservation refunded',
    );

    return true;
  }

  /**
   * Records a webhook before acting on it.
   *
   * The unique index on (provider, provider_event_id) is what makes redelivery
   * safe: a duplicate insert returns nothing and the caller skips processing.
   */
  async recordWebhookEvent(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<{ shouldProcess: boolean; eventRowId: string | null }> {
    const inserted = await this.db
      .insert(schema.webhookEvents)
      .values({
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        payload: input.payload,
        attemptCount: 1,
      })
      .onConflictDoNothing()
      .returning({ id: schema.webhookEvents.id });

    const row = inserted[0];
    return { shouldProcess: row !== undefined, eventRowId: row?.id ?? null };
  }

  async markWebhookProcessed(eventRowId: string): Promise<void> {
    await this.db
      .update(schema.webhookEvents)
      .set({ processedAt: this.clock.now() })
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
