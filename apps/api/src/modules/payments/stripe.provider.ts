import { Inject, Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import type { AppConfig } from '@try/config';
import { CONFIG } from '../../common/config.module.js';
import { ApiException } from '../../common/errors/api-exception.js';
import type {
  CreateIntentInput,
  PaymentIntentResult,
  PaymentProvider,
  RefundInput,
  RefundResult,
  VerifiedWebhookEvent,
} from './payment-provider.js';

@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(@Inject(CONFIG) config: AppConfig) {
    if (!config.STRIPE_SECRET_KEY || !config.STRIPE_WEBHOOK_SECRET) {
      throw new Error('Stripe is not configured; StripePaymentProvider must not be constructed.');
    }
    this.stripe = new Stripe(config.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 10_000 });
    this.webhookSecret = config.STRIPE_WEBHOOK_SECRET;
  }

  async createIntent(input: CreateIntentInput): Promise<PaymentIntentResult> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: input.amountMinor,
        currency: input.currency.toLowerCase(),
        // Apple Pay and Google Pay arrive through the same automatic methods.
        automatic_payment_methods: { enabled: true },
        metadata: input.metadata,
        ...(input.connectedAccountId
          ? {
              application_fee_amount: input.applicationFeeMinor,
              transfer_data: { destination: input.connectedAccountId },
            }
          : {}),
      },
      // Stripe's own idempotency, so a retried API call cannot create two intents.
      { idempotencyKey: input.idempotencyKey },
    );

    if (!intent.client_secret) {
      throw new ApiException('PAYMENT_FAILED', undefined, undefined, { intentId: intent.id });
    }

    return { providerIntentId: intent.id, clientSecret: intent.client_secret };
  }

  async cancelIntent(providerIntentId: string): Promise<void> {
    await this.stripe.paymentIntents.cancel(providerIntentId);
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: input.providerIntentId,
        amount: input.amountMinor,
        reason: asStripeReason(input.reason),
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return { providerRefundId: refund.id };
  }

  verifyWebhook(rawBody: Buffer, signature: string): VerifiedWebhookEvent {
    try {
      const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
      return {
        id: event.id,
        type: event.type,
        payload: event as unknown as Record<string, unknown>,
      };
    } catch {
      // An unverifiable webhook is indistinguishable from a forgery.
      throw ApiException.forbidden('invalid stripe webhook signature');
    }
  }
}

function asStripeReason(reason: string | undefined): Stripe.RefundCreateParams.Reason | undefined {
  return reason === 'requested_by_customer' || reason === 'duplicate' || reason === 'fraudulent'
    ? reason
    : undefined;
}

/**
 * Used when Stripe is not configured (local development against free offers only).
 * It refuses to pretend a payment succeeded — a fake "paid" booking is exactly the
 * kind of false green that hides a broken payment path until production.
 */
@Injectable()
export class UnconfiguredPaymentProvider implements PaymentProvider {
  createIntent(): Promise<PaymentIntentResult> {
    return Promise.reject(
      new ApiException(
        'SERVICE_UNAVAILABLE',
        'Les paiements ne sont pas configurés sur cet environnement.',
      ),
    );
  }

  cancelIntent(): Promise<void> {
    return Promise.resolve();
  }

  refund(): Promise<RefundResult> {
    return Promise.reject(new ApiException('REFUND_FAILED'));
  }

  verifyWebhook(): VerifiedWebhookEvent {
    throw ApiException.forbidden('payments are not configured');
  }
}
