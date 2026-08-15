import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import type { AppConfig } from '@try/config';
import { ApiException } from '../../common/errors/api-exception.js';
import { StripePaymentProvider, UnconfiguredPaymentProvider } from './stripe.provider.js';

/**
 * Construit une erreur avec la VRAIE classe du SDK, pas un objet litteral.
 *
 * Piege verifie empiriquement (voir rapport) : sur une `StripeInvalidRequestError`
 * reelle, `error.type` a la racine vaut le nom de la classe JS
 * (`"StripeInvalidRequestError"`), jamais le type d'erreur API
 * (`"invalid_request_error"`) — celui-ci ne vit que sous `error.rawType` et
 * `error.raw.type`. Un objet litteral `{ type: 'invalid_request_error', ... }`
 * n'aurait jamais pu detecter une detection naive de la racine : c'est
 * exactement le defaut qui a laisse passer B2 en premiere correction.
 */
function realAmountRefusedError(overrides: Partial<{ code: string; message: string }> = {}): unknown {
  return new Stripe.errors.StripeInvalidRequestError({
    type: 'invalid_request_error',
    param: 'amount',
    message:
      overrides.message ??
      'Refund amount (€10.00) is greater than unrefunded amount on charge (€7.00)',
    code: overrides.code,
  });
}

const FAKE_CONFIG = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' } as AppConfig;

/** Expose le client Stripe interne pour y injecter des doubles de test. */
function stripeInternals(provider: StripePaymentProvider): {
  refunds: { create: unknown; list: unknown };
} {
  return (provider as unknown as { stripe: { refunds: { create: unknown; list: unknown } } }).stripe;
}

function fakeRefund(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 're_1',
    object: 'refund',
    amount: 500,
    currency: 'eur',
    status: 'succeeded',
    payment_intent: 'pi_1',
    charge: 'ch_1',
    reason: 'requested_by_customer',
    failure_reason: null,
    created: 1_700_000_000,
    ...overrides,
  };
}

describe('StripePaymentProvider.interpret — mappage des types d\'evenements', () => {
  const provider = new StripePaymentProvider(FAKE_CONFIG);

  it('refund.created -> REFUND_OBSERVED avec un ProviderRefund complet', () => {
    const event = provider.interpret({
      id: 'evt_1',
      type: 'refund.created',
      data: { object: fakeRefund() },
    });

    expect(event.fact.kind).toBe('REFUND_OBSERVED');
    if (event.fact.kind !== 'REFUND_OBSERVED') throw new Error('unreachable');
    expect(event.fact.refund).toEqual({
      providerRefundId: 're_1',
      providerIntentId: 'pi_1',
      providerChargeId: 'ch_1',
      amountMinor: 500,
      currency: 'EUR',
      status: 'SUCCEEDED',
      reason: 'requested_by_customer',
      failureReason: null,
      occurredAt: new Date(1_700_000_000 * 1000),
    });
  });

  it.each([
    ['pending', 'PENDING'],
    ['succeeded', 'SUCCEEDED'],
    ['failed', 'FAILED'],
    ['canceled', 'CANCELED'],
    [null, 'PENDING'],
  ] as const)('refund.updated avec status Stripe %s -> %s', (stripeStatus, expected) => {
    const event = provider.interpret({
      id: 'evt_2',
      type: 'refund.updated',
      data: { object: fakeRefund({ status: stripeStatus }) },
    });
    if (event.fact.kind !== 'REFUND_OBSERVED') throw new Error('unreachable');
    expect(event.fact.refund.status).toBe(expected);
  });

  it('refund.failed -> REFUND_OBSERVED avec statut FAILED', () => {
    const event = provider.interpret({
      id: 'evt_3',
      type: 'refund.failed',
      data: { object: fakeRefund({ status: 'failed', failure_reason: 'insufficient_funds' }) },
    });
    if (event.fact.kind !== 'REFUND_OBSERVED') throw new Error('unreachable');
    expect(event.fact.refund.status).toBe('FAILED');
    expect(event.fact.refund.failureReason).toBe('insufficient_funds');
  });

  it('charge.refund.updated -> REFUND_OBSERVED (alias historique du meme objet)', () => {
    const event = provider.interpret({
      id: 'evt_4',
      type: 'charge.refund.updated',
      data: { object: fakeRefund() },
    });
    expect(event.fact.kind).toBe('REFUND_OBSERVED');
  });

  it("charge.refunded -> REFUND_RECONCILE, ne porte aucune ecriture", () => {
    const event = provider.interpret({
      id: 'evt_5',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_1',
          object: 'charge',
          amount_refunded: 500,
          payment_intent: 'pi_1',
        },
      },
    });

    expect(event.fact).toEqual({
      kind: 'REFUND_RECONCILE',
      providerIntentId: 'pi_1',
      providerChargeId: 'ch_1',
      refundedTotalMinor: 500,
    });
  });

  it('payment_intent.succeeded -> PAYMENT_SUCCEEDED, latest_charge en chaine', () => {
    const event = provider.interpret({
      id: 'evt_6',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_1', object: 'payment_intent', latest_charge: 'ch_1' } },
    });
    expect(event.fact).toEqual({
      kind: 'PAYMENT_SUCCEEDED',
      providerIntentId: 'pi_1',
      providerChargeId: 'ch_1',
    });
  });

  it('payment_intent.succeeded -> latest_charge en objet developpe', () => {
    const event = provider.interpret({
      id: 'evt_7',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_1', object: 'payment_intent', latest_charge: { id: 'ch_2' } } },
    });
    if (event.fact.kind !== 'PAYMENT_SUCCEEDED') throw new Error('unreachable');
    expect(event.fact.providerChargeId).toBe('ch_2');
  });

  it('refund.created -> payment_intent et charge en objets developpes', () => {
    const event = provider.interpret({
      id: 'evt_8',
      type: 'refund.created',
      data: {
        object: fakeRefund({ payment_intent: { id: 'pi_9' }, charge: { id: 'ch_9' } }),
      },
    });
    if (event.fact.kind !== 'REFUND_OBSERVED') throw new Error('unreachable');
    expect(event.fact.refund.providerIntentId).toBe('pi_9');
    expect(event.fact.refund.providerChargeId).toBe('ch_9');
  });

  it('payment_intent.payment_failed -> PAYMENT_FAILED avec le code d\'erreur', () => {
    const event = provider.interpret({
      id: 'evt_9',
      type: 'payment_intent.payment_failed',
      data: {
        object: { id: 'pi_1', object: 'payment_intent', last_payment_error: { code: 'card_declined' } },
      },
    });
    expect(event.fact).toEqual({ kind: 'PAYMENT_FAILED', providerIntentId: 'pi_1', failureCode: 'card_declined' });
  });

  it('payment_intent.canceled -> PAYMENT_CANCELED', () => {
    const event = provider.interpret({
      id: 'evt_10',
      type: 'payment_intent.canceled',
      data: { object: { id: 'pi_1', object: 'payment_intent' } },
    });
    expect(event.fact).toEqual({ kind: 'PAYMENT_CANCELED', providerIntentId: 'pi_1' });
  });

  it("charge.dispute.created -> UNSUPPORTED (un litige n'est pas un remboursement)", () => {
    const event = provider.interpret({
      id: 'evt_11',
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1' } },
    });
    expect(event.fact).toEqual({ kind: 'UNSUPPORTED' });
  });

  it('un type Stripe inconnu -> UNSUPPORTED, jamais une exception', () => {
    const event = provider.interpret({
      id: 'evt_12',
      type: 'balance.available',
      data: { object: {} },
    });
    expect(event.fact).toEqual({ kind: 'UNSUPPORTED' });
  });

  it('refund.created avec une devise non supportee -> UNPARSEABLE, ne leve pas (B1)', () => {
    const event = provider.interpret({
      id: 'evt_13',
      type: 'refund.created',
      data: { object: fakeRefund({ currency: 'sek' }) },
    });
    expect(event.fact.kind).toBe('UNPARSEABLE');
    if (event.fact.kind !== 'UNPARSEABLE') throw new Error('unreachable');
    expect(event.fact.reason).toBeTruthy();
  });

  it('refund.created sans currency -> UNPARSEABLE, ne leve pas (B1)', () => {
    const object = fakeRefund();
    delete (object as Record<string, unknown>).currency;
    const event = provider.interpret({ id: 'evt_14', type: 'refund.created', data: { object } });
    expect(event.fact.kind).toBe('UNPARSEABLE');
  });

  it('charge utile sans data.object -> UNPARSEABLE, ne leve pas (B1)', () => {
    const event = provider.interpret({ id: 'evt_15', type: 'refund.created', data: {} });
    expect(event.fact.kind).toBe('UNPARSEABLE');
  });

  // Garde de non-regression : le cas nominal (eur) reste REFUND_OBSERVED, deja
  // couvert par le premier test de ce describe — non duplique ici.
});

describe('StripePaymentProvider.refund — providerErrorCode remonte la chaine cause', () => {
  it('erreur plate avec .code -> ALREADY_SETTLED (relit via listRefunds)', async () => {
    const provider = new StripePaymentProvider(FAKE_CONFIG);
    const internals = stripeInternals(provider);
    internals.refunds = {
      create: vi.fn().mockRejectedValue({ code: 'charge_already_refunded' }),
      list: vi.fn().mockReturnValue({
        autoPagingToArray: async () => [fakeRefund({ id: 're_already' })],
      }),
    };

    const outcome = await provider.refund({
      providerIntentId: 'pi_1',
      amountMinor: 500,
      idempotencyKey: 'k1',
    });

    expect(outcome.kind).toBe('ALREADY_SETTLED');
    if (outcome.kind !== 'ALREADY_SETTLED') throw new Error('unreachable');
    expect(outcome.refunds).toHaveLength(1);
    expect(outcome.refunds[0]?.providerRefundId).toBe('re_already');
  });

  it('erreur avec .raw.code (forme reelle du SDK Stripe) -> ALREADY_SETTLED', async () => {
    const provider = new StripePaymentProvider(FAKE_CONFIG);
    const internals = stripeInternals(provider);
    internals.refunds = {
      create: vi.fn().mockRejectedValue({ raw: { code: 'amount_too_large' } }),
      list: vi.fn().mockReturnValue({ autoPagingToArray: async () => [] }),
    };

    const outcome = await provider.refund({
      providerIntentId: 'pi_1',
      amountMinor: 500,
      idempotencyKey: 'k2',
    });

    expect(outcome.kind).toBe('ALREADY_SETTLED');
  });

  it("erreur EMBALLEE dans une chaine de cause sur 3 niveaux -> toujours detectee", async () => {
    // C'est le piege numero un du lot : une detection naive de `error.code` en
    // surface passe contre un stub plat mais echoue silencieusement contre le
    // vrai SDK, qui enveloppe l'erreur reseau/parsing dans `.cause`.
    const level3 = { code: 'charge_already_refunded' };
    const level2 = new Error('wrapped');
    (level2 as unknown as { cause: unknown }).cause = level3;
    const level1 = new Error('outer');
    (level1 as unknown as { cause: unknown }).cause = level2;

    const provider = new StripePaymentProvider(FAKE_CONFIG);
    const internals = stripeInternals(provider);
    internals.refunds = {
      create: vi.fn().mockRejectedValue(level1),
      list: vi.fn().mockReturnValue({ autoPagingToArray: async () => [] }),
    };

    const outcome = await provider.refund({
      providerIntentId: 'pi_1',
      amountMinor: 500,
      idempotencyKey: 'k3',
    });

    expect(outcome.kind).toBe('ALREADY_SETTLED');
  });

  it('code inconnu ou absent -> REFUND_FAILED bruyant, jamais absorbe en silence', async () => {
    const provider = new StripePaymentProvider(FAKE_CONFIG);
    const internals = stripeInternals(provider);
    internals.refunds = {
      create: vi.fn().mockRejectedValue({ code: 'rate_limit' }),
      list: vi.fn(),
    };

    await expect(
      provider.refund({ providerIntentId: 'pi_1', amountMinor: 500, idempotencyKey: 'k4' }),
    ).rejects.toMatchObject({ code: 'REFUND_FAILED' } satisfies Partial<ApiException>);
  });

  it('panne reseau sans code du tout -> REFUND_FAILED', async () => {
    const provider = new StripePaymentProvider(FAKE_CONFIG);
    const internals = stripeInternals(provider);
    internals.refunds = {
      create: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
      list: vi.fn(),
    };

    await expect(
      provider.refund({ providerIntentId: 'pi_1', amountMinor: 500, idempotencyKey: 'k5' }),
    ).rejects.toBeInstanceOf(ApiException);
  });

  it("« Refund amount is greater than unrefunded amount » SANS code -> ALREADY_SETTLED (B2, discriminateur structurel)", async () => {
    // Fixture construite avec la VRAIE classe d'erreur du SDK (voir
    // realAmountRefusedError plus haut) : Stripe n'envoie AUCUN champ `code`
    // sur cette erreur, et `error.type` a la racine vaut le nom de la classe
    // JS, pas le type d'erreur API. C'est le test qui aurait attrape le bug
    // initial (racine lue pour `type`) ET sa premiere tentative de correction
    // (fixture en objet litteral qui ne reproduisait pas cette pollution) :
    // reproduit empiriquement contre l'API Stripe, voir le rapport.
    const provider = new StripePaymentProvider(FAKE_CONFIG);
    const internals = stripeInternals(provider);
    internals.refunds = {
      create: vi.fn().mockRejectedValue(realAmountRefusedError()),
      list: vi.fn().mockReturnValue({
        autoPagingToArray: async () => [fakeRefund({ id: 're_partiel', amount: 300 })],
      }),
    };

    const outcome = await provider.refund({
      providerIntentId: 'pi_1',
      amountMinor: 800,
      idempotencyKey: 'k7',
    });

    expect(outcome.kind).toBe('ALREADY_SETTLED');
    if (outcome.kind !== 'ALREADY_SETTLED') throw new Error('unreachable');
    expect(outcome.refunds.map((r) => r.providerRefundId)).toEqual(['re_partiel']);
  });

  it('meme erreur emballee sur deux niveaux de cause -> toujours ALREADY_SETTLED', async () => {
    // La vraie classe d'erreur, enveloppee dans une chaine de `cause` reelle
    // (deux `Error` standard imbriquees), comme le ferait un point d'echec
    // reseau ou une couche de retry qui rattrape puis rethrow.
    const level2 = new Error('wrapped');
    (level2 as unknown as { cause: unknown }).cause = realAmountRefusedError();
    const level1 = new Error('outer');
    (level1 as unknown as { cause: unknown }).cause = level2;

    const provider = new StripePaymentProvider(FAKE_CONFIG);
    const internals = stripeInternals(provider);
    internals.refunds = {
      create: vi.fn().mockRejectedValue(level1),
      list: vi.fn().mockReturnValue({
        autoPagingToArray: async () => [fakeRefund({ id: 're_partiel_2' })],
      }),
    };

    const outcome = await provider.refund({
      providerIntentId: 'pi_1',
      amountMinor: 800,
      idempotencyKey: 'k8',
    });

    expect(outcome.kind).toBe('ALREADY_SETTLED');
  });

  it('listRefunds echoue apres un ALREADY_SETTLED detecte -> REFUND_FAILED type, jamais une erreur brute (B3)', async () => {
    const provider = new StripePaymentProvider(FAKE_CONFIG);
    const internals = stripeInternals(provider);
    internals.refunds = {
      create: vi.fn().mockRejectedValue({ code: 'charge_already_refunded' }),
      list: vi.fn().mockReturnValue({
        autoPagingToArray: async () => {
          throw new Error('ECONNRESET');
        },
      }),
    };

    const promise = provider.refund({ providerIntentId: 'pi_1', amountMinor: 500, idempotencyKey: 'k9' });
    await expect(promise).rejects.toMatchObject({ code: 'REFUND_FAILED' });
    await expect(promise).rejects.toBeInstanceOf(ApiException);
  });

  it('remboursement cree avec succes -> CREATED', async () => {
    const provider = new StripePaymentProvider(FAKE_CONFIG);
    const internals = stripeInternals(provider);
    internals.refunds = {
      create: vi.fn().mockResolvedValue(fakeRefund()),
      list: vi.fn(),
    };

    const outcome = await provider.refund({
      providerIntentId: 'pi_1',
      amountMinor: 500,
      idempotencyKey: 'k6',
    });

    expect(outcome.kind).toBe('CREATED');
    if (outcome.kind !== 'CREATED') throw new Error('unreachable');
    expect(outcome.refund.providerRefundId).toBe('re_1');
  });
});

describe('StripePaymentProvider.listRefunds', () => {
  it('trie par occurredAt croissant', async () => {
    const provider = new StripePaymentProvider(FAKE_CONFIG);
    const internals = stripeInternals(provider);
    internals.refunds = {
      create: vi.fn(),
      list: vi.fn().mockReturnValue({
        autoPagingToArray: async () => [
          fakeRefund({ id: 're_late', created: 200 }),
          fakeRefund({ id: 're_early', created: 100 }),
        ],
      }),
    };

    const refunds = await provider.listRefunds('pi_1');
    expect(refunds.map((r) => r.providerRefundId)).toEqual(['re_early', 're_late']);
  });
});

describe('UnconfiguredPaymentProvider', () => {
  it('listRefunds rejette, ne rend jamais [] (un tableau vide mentirait)', async () => {
    const provider = new UnconfiguredPaymentProvider();
    await expect(provider.listRefunds()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('refund rejette REFUND_FAILED', async () => {
    const provider = new UnconfiguredPaymentProvider();
    await expect(provider.refund()).rejects.toMatchObject({ code: 'REFUND_FAILED' });
  });

  it('interpret refuse : les paiements ne sont pas configures', () => {
    const provider = new UnconfiguredPaymentProvider();
    expect(() => provider.interpret({})).toThrow();
  });
});

describe('frontiere fournisseur', () => {
  it("aucun fichier SOURCE hors stripe.provider.ts n'importe 'stripe' sous apps/api/src", () => {
    const offenders: string[] = [];
    // payments/ -> modules/ -> src/ : exactement apps/api/src.
    const root = join(import.meta.dirname, '..', '..');

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (entry.name === 'stripe.provider.ts') continue;
        // Les fichiers de test sont exclus de cette frontiere, pas le domaine :
        // ce test-ci construit des fixtures avec la VRAIE classe d'erreur du
        // SDK pour que les tests de `stripe.provider.ts` restent representatifs
        // de ce que le SDK produit reellement (voir describe « refund »). La
        // frontiere qui compte — le domaine ne voit jamais un type Stripe —
        // reste verifiee pour tout le reste de l'arborescence.
        if (entry.name.endsWith('.test.ts')) continue;

        const source = readFileSync(path, 'utf8');
        if (/from ['"]stripe['"]/.test(source)) offenders.push(path);
      }
    };

    walk(root);

    expect(offenders).toEqual([]);
  });
});
