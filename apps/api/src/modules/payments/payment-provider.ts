import type { CurrencyCode } from '@try/utils';

/**
 * The payment provider boundary.
 *
 * Nothing in the domain imports Stripe. Swapping provider, or adding a second one
 * for another market, means writing a new implementation of this interface rather
 * than touching the booking flow.
 */

export interface CreateCheckoutSessionInput {
  reservationId: string;
  amountMinor: number;
  currency: CurrencyCode;
  /** Merchant's connected account, when payouts run through Connect. */
  connectedAccountId?: string | null;
  /** TRY's cut, in minor units. */
  applicationFeeMinor?: number;
  metadata: Record<string, string>;
  idempotencyKey: string;
  /** Line-item name shown on the hosted page — what the customer thinks they're paying for. */
  description: string;
  /**
   * Where the provider sends the browser back to once the customer is done.
   * Cosmetic only: the webhook is the sole source of truth for whether the
   * reservation is confirmed, never this redirect. A closed tab, a failed
   * deep link, or a customer who never returns must not change that.
   */
  successUrl: string;
  cancelUrl: string;
  /**
   * The session stops accepting payment at this instant. The caller owns
   * reconciling this against whatever hold window the reservation itself
   * uses — the provider is not responsible for knowing that a shorter value
   * might be silently rejected or might race the reservation's own expiry.
   */
  expiresAt: Date;
}

export interface CheckoutSessionResult {
  /**
   * Hosted page to open in the customer's browser. The only thing available
   * right away: verified empirically against the real API (see
   * `stripe.provider.ts`) that a Checkout Session's underlying PaymentIntent
   * does not exist yet at creation time — `session.payment_intent` comes back
   * `null` even with an explicit expand, until the customer actually opens
   * the page. So there is no `providerIntentId` here; the domain learns it
   * later, from the `checkout.session.completed` webhook.
   */
  checkoutUrl: string;
}

export interface RefundInput {
  providerIntentId: string;
  amountMinor: number;
  reason?: string;
  idempotencyKey: string;
}

export type ProviderRefundStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';

/** Un mouvement de remboursement chez le fournisseur, decrit sans son vocabulaire. */
export interface ProviderRefund {
  /** Cle du registre. Opaque : le domaine ne l'interprete jamais. */
  providerRefundId: string;
  providerIntentId: string | null;
  providerChargeId: string | null;
  /** Unites mineures entieres, toujours > 0. */
  amountMinor: number;
  currency: CurrencyCode;
  status: ProviderRefundStatus;
  /** Deja normalise et tronque a 60 caracteres (longueur de refunds.reason). */
  reason: string | null;
  /** Tronque a 120 caracteres (longueur de refunds.failure_reason). */
  failureReason: string | null;
  occurredAt: Date;
}

/**
 * Le fait metier porte par un evenement. Union fermee : le domaine commute
 * dessus avec verification d'exhaustivite, donc un `case` mal orthographie ne
 * compile plus (aujourd'hui le switch compare des chaines libres).
 */
export type WebhookFact =
  | { kind: 'PAYMENT_SUCCEEDED'; providerIntentId: string; providerChargeId: string | null }
  | { kind: 'PAYMENT_FAILED'; providerIntentId: string; failureCode: string | null }
  | { kind: 'PAYMENT_CANCELED'; providerIntentId: string }
  /**
   * A Checkout Session finished. Unlike `PAYMENT_SUCCEEDED`, this cannot be
   * keyed on a PaymentIntent id — the intent does not exist until the
   * customer opens the page, so `payments` was written with it still null.
   * `reservationId` (from the session's own metadata, set by us at creation
   * and never editable by the payer) is what lets the domain find the row;
   * `providerIntentId`, if present, backfills the column the rest of the
   * domain (refunds, `payment_intent.*` events) already keys on.
   */
  | {
      kind: 'CHECKOUT_COMPLETED';
      reservationId: string | null;
      providerIntentId: string | null;
      paid: boolean;
      /** `session.amount_total`, in minor units — a defence-in-depth cross-check. */
      amountTotalMinor: number | null;
    }
  | { kind: 'REFUND_OBSERVED'; refund: ProviderRefund }
  /** « Des remboursements existent sur ce paiement, relis-les. » Ne transporte
   *  aucune ecriture : refundedTotalMinor n'est qu'une sonde de comparaison. */
  | {
      kind: 'REFUND_RECONCILE';
      providerIntentId: string | null;
      providerChargeId: string | null;
      refundedTotalMinor: number;
    }
  | { kind: 'UNSUPPORTED' }
  /** La charge utile n'a pas pu etre traduite en fait metier. Portee pour etre
   *  enregistree puis rejouee, jamais pour faire echouer la reception. */
  | { kind: 'UNPARSEABLE'; reason: string };

export interface VerifiedWebhookEvent {
  id: string;
  /** Type brut du fournisseur. Uniquement pour webhook_events.event_type et les logs. */
  type: string;
  fact: WebhookFact;
  /** Charge utile verbatim. Unique lecteur : la colonne jsonb. */
  payload: Record<string, unknown>;
}

export type RefundOutcome =
  | { kind: 'CREATED'; refund: ProviderRefund }
  /** Le fournisseur a deja rendu l'argent : on rapporte son etat, pas une erreur. */
  | { kind: 'ALREADY_SETTLED'; refunds: ProviderRefund[] };

export interface PaymentProvider {
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionResult>;
  cancelIntent(providerIntentId: string): Promise<void>;
  refund(input: RefundInput): Promise<RefundOutcome>;
  /** Relecture autoritative de tous les remboursements d'un paiement. */
  listRefunds(providerIntentId: string): Promise<ProviderRefund[]>;
  /**
   * Verifies the provider's signature over the *raw* body. Parsing before
   * verifying would defeat the signature entirely.
   */
  verifyWebhook(rawBody: Buffer, signature: string): VerifiedWebhookEvent;
  /** Reinterprete une charge utile DEJA verifiee et stockee. Pour le rejeu. */
  interpret(payload: Record<string, unknown>): VerifiedWebhookEvent;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
