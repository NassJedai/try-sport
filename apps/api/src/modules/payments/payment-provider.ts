import type { CurrencyCode } from '@try/utils';

/**
 * The payment provider boundary.
 *
 * Nothing in the domain imports Stripe. Swapping provider, or adding a second one
 * for another market, means writing a new implementation of this interface rather
 * than touching the booking flow.
 */

export interface CreateIntentInput {
  reservationId: string;
  amountMinor: number;
  currency: CurrencyCode;
  /** Merchant's connected account, when payouts run through Connect. */
  connectedAccountId?: string | null;
  /** TRY's cut, in minor units. */
  applicationFeeMinor?: number;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface PaymentIntentResult {
  providerIntentId: string;
  /** Handed to the client SDK; never a secret key. */
  clientSecret: string;
}

export interface RefundInput {
  providerIntentId: string;
  amountMinor: number;
  reason?: string;
  idempotencyKey: string;
}

export interface RefundResult {
  providerRefundId: string;
}

export interface VerifiedWebhookEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface PaymentProvider {
  createIntent(input: CreateIntentInput): Promise<PaymentIntentResult>;
  cancelIntent(providerIntentId: string): Promise<void>;
  refund(input: RefundInput): Promise<RefundResult>;
  /**
   * Verifies the provider's signature over the *raw* body. Parsing before
   * verifying would defeat the signature entirely.
   */
  verifyWebhook(rawBody: Buffer, signature: string): VerifiedWebhookEvent;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
