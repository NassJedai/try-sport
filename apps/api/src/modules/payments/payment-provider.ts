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
  createIntent(input: CreateIntentInput): Promise<PaymentIntentResult>;
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
