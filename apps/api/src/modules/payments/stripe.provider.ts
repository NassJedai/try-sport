import { Inject, Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { SUPPORTED_CURRENCIES } from '@try/utils';
import type { CurrencyCode } from '@try/utils';
import type { AppConfig } from '@try/config';
import { CONFIG } from '../../common/config.module.js';
import { ApiException } from '../../common/errors/api-exception.js';
import type {
  CheckoutSessionResult,
  CreateCheckoutSessionInput,
  PaymentProvider,
  ProviderRefund,
  ProviderRefundStatus,
  RefundInput,
  RefundOutcome,
  VerifiedWebhookEvent,
  WebhookFact,
} from './payment-provider.js';

/**
 * Seul fichier du depot autorise a `import Stripe`.
 *
 * Toute la connaissance de `data.object`, `last_payment_error`, `payment_intent`,
 * `latest_charge`, `amount_refunded`, `charge_already_refunded` est confinee ici.
 * Le domaine ne voit jamais un type Stripe : il recoit `ProviderRefund` et
 * `WebhookFact`, son propre vocabulaire.
 */
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

  /**
   * Creates a Checkout Session — a Stripe-hosted payment page — rather than a
   * bare PaymentIntent. Chosen over the native card element because the
   * mobile app has no native build yet (Expo Go only, see PROJECT_PLAN.md):
   * this works today by opening a URL in the phone's browser, no
   * `@stripe/stripe-react-native` required.
   *
   * Does NOT return a PaymentIntent id: verified empirically against the real
   * API that `session.payment_intent` comes back `null` right after creation
   * — even with an explicit `expand` — because Stripe does not create the
   * underlying PaymentIntent until the customer actually opens the page. The
   * domain learns it later, from `checkout.session.completed`
   * (`WebhookFact.CHECKOUT_COMPLETED`), keyed on the reservation id carried
   * in the session's own metadata rather than on an intent id that does not
   * exist yet.
   */
  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionResult> {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: input.amountMinor,
              product_data: { name: input.description },
            },
          },
        ],
        metadata: input.metadata,
        payment_intent_data: {
          metadata: input.metadata,
          ...(input.connectedAccountId
            ? {
                application_fee_amount: input.applicationFeeMinor,
                transfer_data: { destination: input.connectedAccountId },
              }
            : {}),
        },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        // Stripe rejects anything under 30 minutes from creation for `mode:
        // payment` — the caller (PaymentService) is responsible for a value
        // that respects that floor with margin; this is not re-validated here
        // so a mistake fails loudly against the real API instead of silently
        // clamping to a value the caller did not ask for.
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
      },
      // Stripe's own idempotency, so a retried API call cannot create two sessions.
      { idempotencyKey: input.idempotencyKey },
    );

    if (!session.url) {
      throw new ApiException('PAYMENT_FAILED', undefined, undefined, { sessionId: session.id });
    }

    return { checkoutUrl: session.url };
  }

  async cancelIntent(providerIntentId: string): Promise<void> {
    await this.stripe.paymentIntents.cancel(providerIntentId);
  }

  async refund(input: RefundInput): Promise<RefundOutcome> {
    try {
      const refund = await this.stripe.refunds.create(
        {
          payment_intent: input.providerIntentId,
          amount: input.amountMinor,
          reason: asStripeReason(input.reason),
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return { kind: 'CREATED', refund: toProviderRefund(refund) };
    } catch (error) {
      const code = providerErrorCode(error);
      // Stripe n'envoie PAS de `code` sur « Refund amount is greater than
      // unrefunded amount on charge » (verifie contre l'API) : c'est un
      // invalid_request_error sur le parametre `amount`. On le reconnait donc a
      // sa forme structurelle, jamais au texte du message.
      const amountRefused =
        providerErrorField(error, 'type') === 'invalid_request_error' &&
        providerErrorField(error, 'param') === 'amount';
      if (code === 'charge_already_refunded' || code === 'amount_too_large' || amountRefused) {
        // Le fournisseur en sait plus que nous : on relit sa verite au lieu de
        // la deviner. Cette relecture peut echouer a son tour — elle ne doit pas
        // franchir la frontiere fournisseur sous forme d'erreur brute.
        let refunds: ProviderRefund[];
        try {
          refunds = await this.listRefunds(input.providerIntentId);
        } catch (listError) {
          throw new ApiException('REFUND_FAILED', undefined, undefined, {
            providerIntentId: input.providerIntentId,
            providerCode: code ?? 'unknown',
            stage: 'listRefunds',
            listErrorCode: providerErrorCode(listError) ?? 'unknown',
          });
        }
        return { kind: 'ALREADY_SETTLED', refunds };
      }
      // Panne reseau, cle revoquee : doivent rester bruyantes, mais typees.
      throw new ApiException('REFUND_FAILED', undefined, undefined, {
        providerIntentId: input.providerIntentId,
        providerCode: code ?? 'unknown',
      });
    }
  }

  async listRefunds(providerIntentId: string): Promise<ProviderRefund[]> {
    // Ne pas `await` avant `.autoPagingToArray()` : `list()` rend un
    // `ApiListPromise`, une promesse elle-meme augmentee des methodes de
    // pagination. L'attendre d'abord la resout en `Response<ApiList<Refund>>`,
    // qui n'a plus `autoPagingToArray`.
    const page = this.stripe.refunds.list({ payment_intent: providerIntentId, limit: 100 });
    const all = await page.autoPagingToArray({ limit: 1000 });
    return all
      .map(toProviderRefund)
      .sort((a: ProviderRefund, b: ProviderRefund) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  verifyWebhook(rawBody: Buffer, signature: string): VerifiedWebhookEvent {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch {
      // An unverifiable webhook is indistinguishable from a forgery.
      throw ApiException.forbidden('invalid stripe webhook signature');
    }
    return this.interpret(event as unknown as Record<string, unknown>);
  }

  interpret(payload: Record<string, unknown>): VerifiedWebhookEvent {
    const type = typeof payload.type === 'string' ? payload.type : '';
    const id = typeof payload.id === 'string' ? payload.id : '';
    const object = (payload.data as { object?: Record<string, unknown> } | undefined)?.object ?? {};
    let fact: WebhookFact;
    try {
      fact = toFact(type, object);
    } catch (error) {
      // L'analyse metier ne doit jamais empecher l'enregistrement : un evenement
      // illisible se constate en base et se rejoue, il ne se perd pas en 500.
      fact = { kind: 'UNPARSEABLE', reason: error instanceof Error ? error.message : String(error) };
    }
    return { id, type, payload, fact };
  }
}

function asStripeReason(reason: string | undefined): Stripe.RefundCreateParams.Reason | undefined {
  return reason === 'requested_by_customer' || reason === 'duplicate' || reason === 'fraudulent'
    ? reason
    : undefined;
}

/**
 * Remonte la chaine `cause` pour trouver un champ d'erreur Stripe donne.
 *
 * Lire `error.code` en surface marche contre un stub mais pas contre le vrai
 * SDK, qui embarque le champ sous `.raw.<field>` et enveloppe l'erreur dans une
 * `cause` selon le point d'echec (reseau, parsing). Meme discipline que
 * `isUniqueViolation` (booking.service.ts) pour la meme raison : Postgres et
 * Stripe enveloppent tous les deux leurs erreurs, et une detection naive
 * echoue silencieusement en production sans jamais echouer en test contre un
 * mock plat.
 *
 * Generalise a `type`/`param` en plus de `code` : Stripe n'envoie AUCUN `code`
 * sur certaines erreurs `invalid_request_error` (ex. montant superieur au
 * disponible), qui ne se reconnaissent qu'a leur forme structurelle.
 *
 * PIEGE VERIFIE CONTRE LE VRAI SDK (`stripe` Node, `Error.js` :
 * `this.type = type || this.constructor.name`) : sur une `StripeError`
 * reelle, la racine `error.type` ne contient PAS le type d'erreur de l'API
 * Stripe — elle contient le NOM DE LA CLASSE JS (`"StripeInvalidRequestError"`),
 * une convention propre au SDK. Le vrai type d'erreur API
 * (`"invalid_request_error"`) vit sous `error.rawType` (alias documente de
 * `raw.type`, assigne explicitement dans le constructeur) et, en repli, sous
 * `error.raw.type`. Lire la racine pour `type` renvoie donc TOUJOURS le nom de
 * classe, jamais la valeur utile — confirme empiriquement par
 * `inspect-stripe-error.mjs` contre une vraie erreur "Refund amount is
 * greater than unrefunded amount on charge" (voir rapport). `code` et `param`
 * n'ont pas ce probleme : le constructeur les recopie tels quels depuis
 * `raw.code`/`raw.param` (`this.code = raw.code`, `this.param = raw.param`),
 * donc la racine reste fiable pour ces deux champs.
 */
function providerErrorField(error: unknown, field: 'code' | 'type' | 'param', depth = 0): string | null {
  if (depth > 5 || error === null || typeof error !== 'object') return null;

  if (field === 'type') {
    // Ne JAMAIS lire la racine ici : voir le commentaire de la fonction.
    const rawType = (error as { rawType?: unknown }).rawType;
    if (typeof rawType === 'string') return rawType;
    const raw = (error as { raw?: Record<string, unknown> }).raw;
    if (raw && typeof raw.type === 'string') return raw.type as string;
    return providerErrorField((error as { cause?: unknown }).cause, field, depth + 1);
  }

  const candidate = (error as Record<string, unknown>)[field];
  if (typeof candidate === 'string') return candidate;
  const raw = (error as { raw?: Record<string, unknown> }).raw;
  if (raw && typeof raw[field] === 'string') return raw[field] as string;
  return providerErrorField((error as { cause?: unknown }).cause, field, depth + 1);
}

/** Conserve tel quel : meme remontee de la chaine `cause`, meme contrat. */
function providerErrorCode(error: unknown): string | null {
  return providerErrorField(error, 'code');
}

function toProviderRefund(refund: Stripe.Refund): ProviderRefund {
  const currency = refund.currency.toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(currency as CurrencyCode)) {
    throw new ApiException('REFUND_FAILED', undefined, undefined, { currency: refund.currency });
  }
  return {
    providerRefundId: refund.id,
    providerIntentId: idOf(refund.payment_intent),
    providerChargeId: idOf(refund.charge),
    amountMinor: refund.amount,
    currency: currency as CurrencyCode,
    status: toRefundStatus(refund.status),
    reason: refund.reason ? String(refund.reason).slice(0, 60) : null,
    failureReason: refund.failure_reason ? String(refund.failure_reason).slice(0, 120) : null,
    occurredAt: new Date(refund.created * 1000),
  };
}

/** Stripe rend soit une chaine, soit l'objet developpe. */
function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
}

function toRefundStatus(status: string | null): ProviderRefundStatus {
  switch (status) {
    case 'succeeded':
      return 'SUCCEEDED';
    case 'failed':
      return 'FAILED';
    case 'canceled':
      return 'CANCELED';
    default:
      return 'PENDING'; // 'pending', 'requires_action', null, inconnu
  }
}

/**
 * Mappage exact des types d'evenements Stripe vers le vocabulaire du domaine.
 *
 * `charge.refunded` ne transporte jamais d'ecriture : il ne fait que declencher
 * une relecture (`REFUND_RECONCILE`), parce que `data.object` y est une Charge
 * dont `amount_refunded` est un CUMUL et non un delta, et dont `refunds.data[]`
 * est tronque au-dela de 10 elements. Ecrire depuis cet evenement double-compte
 * ou cree une ligne sans cle d'idempotence.
 */
function toFact(type: string, object: Record<string, unknown>): WebhookFact {
  switch (type) {
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
    case 'charge.refund.updated':
      return { kind: 'REFUND_OBSERVED', refund: toProviderRefund(object as unknown as Stripe.Refund) };

    case 'charge.refunded': {
      const providerChargeId = typeof object.id === 'string' ? object.id : null;
      const refundedTotalMinor =
        typeof object.amount_refunded === 'number' ? object.amount_refunded : 0;
      return {
        kind: 'REFUND_RECONCILE',
        providerIntentId: idOf(object.payment_intent),
        providerChargeId,
        refundedTotalMinor,
      };
    }

    case 'payment_intent.succeeded': {
      const providerIntentId = typeof object.id === 'string' ? object.id : '';
      return {
        kind: 'PAYMENT_SUCCEEDED',
        providerIntentId,
        providerChargeId: idOf(object.latest_charge),
      };
    }

    case 'payment_intent.payment_failed': {
      const providerIntentId = typeof object.id === 'string' ? object.id : '';
      const lastError = object.last_payment_error as { code?: unknown } | null | undefined;
      const failureCode =
        lastError && typeof lastError.code === 'string' ? lastError.code : null;
      return { kind: 'PAYMENT_FAILED', providerIntentId, failureCode };
    }

    case 'payment_intent.canceled': {
      const providerIntentId = typeof object.id === 'string' ? object.id : '';
      return { kind: 'PAYMENT_CANCELED', providerIntentId };
    }

    // The event our hosted Checkout flow actually confirms on. `object` here
    // is the Session, not a PaymentIntent: `payment_intent` is a plain
    // string id once the session has completed (never expanded — nothing
    // here asks for it), and `metadata` is exactly what we set at creation
    // (`payment.service.ts`), verbatim and never editable by the payer.
    case 'checkout.session.completed': {
      const metadata = object.metadata as { reservation_id?: unknown } | null | undefined;
      const reservationId =
        metadata && typeof metadata.reservation_id === 'string' ? metadata.reservation_id : null;
      return {
        kind: 'CHECKOUT_COMPLETED',
        reservationId,
        providerIntentId: idOf(object.payment_intent),
        paid: object.payment_status === 'paid',
        amountTotalMinor: typeof object.amount_total === 'number' ? object.amount_total : null,
      };
    }

    // Un litige n'est pas un remboursement (fonds retenus, frais de dossier,
    // decision contestable) : enregistre, journalise, hors perimetre assume.
    // `charge.succeeded` / `charge.updated` sont un doublon de
    // `payment_intent.succeeded` : aucun de ces types n'ecrit quoi que ce soit.
    //
    // Les evenements async de Checkout (methodes a reglement differe, type
    // SEPA) sont volontairement hors perimetre de ce lot : seule la carte,
    // qui regle en synchrone via `checkout.session.completed` ci-dessus, a
    // ete testee de bout en bout contre le vrai Stripe. Une session qui
    // n'aboutit jamais reste couverte par le sweep applicatif
    // (`LifecycleJobsService.expirePaymentHolds`), qui ne depend d'aucun de
    // ces evenements pour liberer la place.
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed':
    case 'charge.succeeded':
    case 'charge.updated':
    default:
      return { kind: 'UNSUPPORTED' };
  }
}

/**
 * Used when Stripe is not configured (local development against free offers only).
 * It refuses to pretend a payment succeeded — a fake "paid" booking is exactly the
 * kind of false green that hides a broken payment path until production.
 */
@Injectable()
export class UnconfiguredPaymentProvider implements PaymentProvider {
  createCheckoutSession(): Promise<CheckoutSessionResult> {
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

  refund(): Promise<RefundOutcome> {
    return Promise.reject(new ApiException('REFUND_FAILED'));
  }

  listRefunds(): Promise<ProviderRefund[]> {
    // Jamais [] : un tableau vide mentirait « aucun remboursement n'existe ».
    return Promise.reject(new ApiException('SERVICE_UNAVAILABLE'));
  }

  verifyWebhook(): VerifiedWebhookEvent {
    throw ApiException.forbidden('payments are not configured');
  }

  interpret(): VerifiedWebhookEvent {
    throw ApiException.forbidden('payments are not configured');
  }
}
