import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { allocateRefundLine, MoneyError, refundedFeeAt } from '@try/utils';
import type { Clock } from '@try/utils';
import { schema } from '@try/database';
import type { Database, Transaction } from '@try/database';
import type { Logger } from '@try/logger';
import type { PaymentStatus } from '@try/contracts';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { LOGGER } from '../../common/logger.module.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { DomainEvents } from '../events/domain-events.js';
import type { ProviderRefund } from './payment-provider.js';

const PROVIDER = 'STRIPE';
/** payments.status pour lesquels un remboursement a du sens. */
const REFUNDABLE_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'SUCCEEDED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
];
/** Statuts de reservation ou un remboursement total sans annulation applicative est anormal. */
const LIVE_RESERVATION_STATUSES = new Set(['CONFIRMED', 'CHECKED_IN']);

export interface RefundApplyInput {
  /** Resolution directe quand l'appelant tient deja la ligne. */
  paymentId?: string;
  providerIntentId?: string | null;
  providerChargeId?: string | null;
  refunds: ProviderRefund[];
  initiatedByUserId?: string | null;
}

export interface RefundApplyResult {
  outcome: 'APPLIED' | 'NOOP' | 'PAYMENT_NOT_FOUND';
  paymentId: string | null;
  /**
   * Deviation additive au plan : necessaire pour construire l'evenement
   * `PaymentRefunded` (qui porte `reservationId`) apres le COMMIT, sans que
   * l'appelant ait a re-interroger la ligne payments.
   */
  reservationId: string | null;
  refundedAmount: number;
  refundedPlatformFeeAmount: number;
  refundedMerchantAmount: number;
  paymentAmount: number;
  paymentStatus: PaymentStatus | null;
  /** provider_refund_id des lignes creees pendant cet appel. */
  insertedRefundIds: string[];
}

const NOT_FOUND_RESULT: RefundApplyResult = {
  outcome: 'PAYMENT_NOT_FOUND',
  paymentId: null,
  reservationId: null,
  refundedAmount: 0,
  refundedPlatformFeeAmount: 0,
  refundedMerchantAmount: 0,
  paymentAmount: 0,
  paymentStatus: null,
  insertedRefundIds: [],
};

interface UpsertRow {
  id: string;
  status: string;
  platformFeeAmount: number;
  merchantAmount: number;
  inserted: boolean;
}

/**
 * `allocateRefundLine` leve une `MoneyError` (contrat bas niveau, strict) des
 * qu'une ligne pousse le cumul au-dela du brut — potentiellement bien avant le
 * garde explicite de l'etape 5, si une seule ligne suffit a depasser `amount`.
 * Ce point d'entree traduit systematiquement cette anomalie en `ApiException`
 * typee, pour que ni le controleur webhook ni le chemin d'annulation n'aient a
 * connaitre `MoneyError`.
 */
function safeAllocateRefundLine(
  input: Parameters<typeof allocateRefundLine>[0],
  context: Record<string, unknown>,
): ReturnType<typeof allocateRefundLine> {
  try {
    return allocateRefundLine(input);
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new ApiException('REFUND_FAILED', undefined, undefined, { ...context, reason: error.message });
    }
    throw error;
  }
}

/**
 * Unique ecrivain de `refunds`, de `payments.refunded_amount`,
 * `refunded_platform_fee_amount` et `refunded_merchant_amount`.
 *
 * `refunds` est un registre de mouvements (une ligne = un remboursement
 * fournisseur, cle par `provider_refund_id`) ; les colonnes `payments.refunded_*`
 * sont une PROJECTION recalculee a chaque application, jamais incrementee — donc
 * convergente sous rejeu, quel que soit l'ordre de livraison des webhooks.
 *
 * `platform_fee_amount` / `merchant_amount` (l'encaissement) ne sont jamais
 * touches ici : seule `createIntentForReservation` les ecrit. C'est cette
 * discipline qui rend `payments_split_reconciles` inatteignable.
 */
@Injectable()
export class RefundLedgerService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly events: DomainEvents,
  ) {}

  /** Ouvre sa propre transaction. Chemin webhook et chemin de rejeu. */
  async apply(input: RefundApplyInput): Promise<RefundApplyResult> {
    const result = await this.db.transaction((tx) => this.applyWithin(tx, input));

    // Emis APRES le commit : markSucceeded emettait depuis l'interieur de sa
    // transaction, ce qui expose un abonne a un evenement pour un etat qui peut
    // encore etre annule par un rollback. On ne reproduit pas ce defaut ici.
    if (result.outcome === 'APPLIED') {
      for (const providerRefundId of result.insertedRefundIds) {
        const refund = input.refunds.find((r) => r.providerRefundId === providerRefundId);
        this.events.emit('PaymentRefunded', {
          reservationId: result.reservationId ?? '',
          paymentId: result.paymentId ?? '',
          providerRefundId,
          amountMinor: refund?.amountMinor ?? 0,
          cumulativeRefundedMinor: result.refundedAmount,
          platformFeeReversedMinor: result.refundedPlatformFeeAmount,
          isFullRefund: result.paymentAmount > 0 && result.refundedAmount >= result.paymentAmount,
        });
      }
    }

    return result;
  }

  /** Se greffe sur une transaction existante. Chemin d'annulation. */
  async applyWithin(tx: Transaction, input: RefundApplyInput): Promise<RefundApplyResult> {
    const now = this.clock.now();

    // 1. Resolution du paiement, avec verrou. Jamais de verrou sur `reservations`
    // ici : le chemin d'annulation verrouille reservations puis payments, et un
    // verrou symetrique dans ce service creerait un interblocage.
    const criterion = input.paymentId
      ? eq(schema.payments.id, input.paymentId)
      : input.providerIntentId
        ? eq(schema.payments.providerPaymentIntentId, input.providerIntentId)
        : input.providerChargeId
          ? eq(schema.payments.providerChargeId, input.providerChargeId)
          : null;

    if (!criterion) {
      this.logger.warn({ input }, 'remboursement recu sans identifiant de paiement exploitable');
      return NOT_FOUND_RESULT;
    }

    const [payment] = await tx
      .select()
      .from(schema.payments)
      .where(criterion)
      .for('update')
      .limit(1);

    if (!payment) {
      // Le compte Stripe peut porter d'autres flux ; l'evenement est marque
      // traite et sa charge utile reste dans webhook_events pour inspection.
      this.logger.warn({ input }, 'paiement inconnu pour ce remboursement');
      return NOT_FOUND_RESULT;
    }

    if (payment.amount === 0) {
      this.logger.error({ paymentId: payment.id }, 'remboursement recu sur une reservation gratuite');
      return this.toNoopResult(payment);
    }

    if (!REFUNDABLE_PAYMENT_STATUSES.includes(payment.status)) {
      this.logger.error(
        { paymentId: payment.id, status: payment.status },
        'remboursement recu sur un paiement dans un etat qui ne peut pas etre rembourse',
      );
      return this.toNoopResult(payment);
    }

    // 2. Tri : occurredAt croissant, puis providerRefundId pour lever l'egalite.
    // L'ordre determine l'attribution ligne a ligne, jamais le total.
    const sorted = [...input.refunds].sort((a, b) => {
      const byTime = a.occurredAt.getTime() - b.occurredAt.getTime();
      if (byTime !== 0) return byTime;
      return a.providerRefundId < b.providerRefundId
        ? -1
        : a.providerRefundId > b.providerRefundId
          ? 1
          : 0;
    });

    const insertedRefundIds: string[] = [];
    let providerChargeId = input.providerChargeId ?? null;

    for (const refund of sorted) {
      if (refund.currency !== payment.currency) {
        // Impossible chez Stripe sur un meme PaymentIntent ; une occurrence
        // signale une erreur de rattachement, pas un cas a absorber.
        throw new ApiException('REFUND_FAILED', undefined, undefined, {
          paymentId: payment.id,
          expectedCurrency: payment.currency,
          receivedCurrency: refund.currency,
        });
      }

      if (refund.amountMinor <= 0) {
        this.logger.warn(
          { paymentId: payment.id, providerRefundId: refund.providerRefundId },
          'remboursement ignore : montant non positif',
        );
        continue;
      }

      if (!providerChargeId && refund.providerChargeId) {
        providerChargeId = refund.providerChargeId;
      }

      let ventilation = { platformFeeAmount: 0, merchantAmount: 0 };
      if (refund.status === 'SUCCEEDED') {
        // Somme des AUTRES lignes deja SUCCEEDED : sur une redelivrance, cette
        // ligne peut deja exister (upsert), et sa propre valeur precedente ne
        // doit pas se compter comme un "avant" pour elle-meme, sous peine de
        // doubler son propre montant. Cette ventilation n'a de toute facon qu'un
        // role d'estimation valide pour satisfaire la contrainte a l'insertion :
        // l'etape 4 (reattribution) la recalculera canoniquement juste apres.
        const [sumRow] = await tx
          .select({
            refundedBefore: sql<number>`COALESCE(SUM(${schema.refunds.amount}), 0)::int`,
          })
          .from(schema.refunds)
          .where(
            and(
              eq(schema.refunds.paymentId, payment.id),
              eq(schema.refunds.status, 'SUCCEEDED'),
              sql`NOT (${schema.refunds.provider} = ${PROVIDER} AND ${schema.refunds.providerRefundId} = ${refund.providerRefundId})`,
            ),
          );

        ventilation = safeAllocateRefundLine(
          {
            amount: payment.amount,
            platformFee: payment.platformFeeAmount,
            refundedBefore: sumRow?.refundedBefore ?? 0,
            lineAmount: refund.amountMinor,
          },
          { paymentId: payment.id, providerRefundId: refund.providerRefundId },
        );
      }

      const succeededAt = refund.status === 'SUCCEEDED' ? refund.occurredAt.toISOString() : null;

      // Upsert brut : le garde de monotonie (`WHERE`) et le calcul de `inserted`
      // via `xmax = 0` n'ont pas d'equivalent pratique dans le query-builder pour
      // ce cas precis. `amount` n'apparait jamais dans le SET : l'argent d'une
      // ligne est immuable, une redelivrance ne peut donc pas le changer.
      const upserted = (await tx.execute(sql`
        INSERT INTO refunds (payment_id, reservation_id, provider, provider_refund_id,
                             amount, currency, reason, initiated_by_user_id,
                             status, platform_fee_amount, merchant_amount,
                             failure_reason, succeeded_at, created_at, updated_at)
        VALUES (${payment.id}, ${payment.reservationId}, ${PROVIDER}, ${refund.providerRefundId},
                ${refund.amountMinor}, ${payment.currency}::currency, ${refund.reason},
                ${input.initiatedByUserId ?? null},
                ${refund.status}, ${ventilation.platformFeeAmount}, ${ventilation.merchantAmount},
                ${refund.failureReason}, ${succeededAt},
                ${refund.occurredAt.toISOString()}, ${now.toISOString()})
        ON CONFLICT (provider, provider_refund_id) DO UPDATE
          SET status = EXCLUDED.status,
              platform_fee_amount = EXCLUDED.platform_fee_amount,
              merchant_amount = EXCLUDED.merchant_amount,
              failure_reason = EXCLUDED.failure_reason,
              succeeded_at = COALESCE(refunds.succeeded_at, EXCLUDED.succeeded_at),
              updated_at = EXCLUDED.updated_at
          WHERE refunds.status = 'PENDING'
             OR (refunds.status = 'SUCCEEDED' AND EXCLUDED.status IN ('FAILED', 'CANCELED'))
        RETURNING id, status,
                  platform_fee_amount AS "platformFeeAmount",
                  merchant_amount AS "merchantAmount",
                  (xmax = 0) AS inserted
      `)) as unknown as UpsertRow[];

      const row = upserted[0];
      if (row?.inserted) {
        insertedRefundIds.push(refund.providerRefundId);
      }
    }

    // 4. Reattribution, executee INCONDITIONNELLEMENT : sans elle, un passage
    // SUCCEEDED -> FAILED (ou toute redelivrance) laisse la somme des lignes
    // diverger silencieusement de la projection.
    const succeededLines = await tx
      .select({
        id: schema.refunds.id,
        amount: schema.refunds.amount,
        platformFeeAmount: schema.refunds.platformFeeAmount,
        merchantAmount: schema.refunds.merchantAmount,
      })
      .from(schema.refunds)
      .where(and(eq(schema.refunds.paymentId, payment.id), eq(schema.refunds.status, 'SUCCEEDED')))
      .orderBy(schema.refunds.createdAt, schema.refunds.id);

    let cumulative = 0;
    for (const line of succeededLines) {
      const recomputed = safeAllocateRefundLine(
        {
          amount: payment.amount,
          platformFee: payment.platformFeeAmount,
          refundedBefore: cumulative,
          lineAmount: line.amount,
        },
        { paymentId: payment.id, refundId: line.id },
      );
      if (
        recomputed.platformFeeAmount !== line.platformFeeAmount ||
        recomputed.merchantAmount !== line.merchantAmount
      ) {
        await tx
          .update(schema.refunds)
          .set({
            platformFeeAmount: recomputed.platformFeeAmount,
            merchantAmount: recomputed.merchantAmount,
            updatedAt: now,
          })
          .where(eq(schema.refunds.id, line.id));
      }
      cumulative += line.amount;
    }

    // 5. Projection. En pratique, `safeAllocateRefundLine` a deja leve plus haut
    // des qu'une ligne pousse le cumul au-dela du brut ; ce garde reste en place
    // en dernier rempart, au cas ou la reattribution changerait de forme.
    const R = cumulative;
    if (R > payment.amount) {
      // Ne jamais ecreter avec LEAST() : un cumul superieur au brut signifie que
      // notre `amount` est faux, ce qui merite du bruit, pas un silence complice.
      throw new ApiException('REFUND_FAILED', undefined, undefined, {
        paymentId: payment.id,
        refundedCumulative: R,
        paymentAmount: payment.amount,
      });
    }

    const F = refundedFeeAt({ amount: payment.amount, platformFee: payment.platformFeeAmount, refundedCumulative: R });
    const merchantRefunded = R - F;
    // Calcule en JS plutot qu'en SQL brut : R et payment.amount sont deja des
    // entiers ici, et un CASE SQL sur des parametres non types compare parfois en
    // TEXTE ('300' >= '1000' est vrai lexicographiquement) plutot qu'en entier.
    const nextStatus: PaymentStatus = R === 0 ? 'SUCCEEDED' : R >= payment.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

    const [updatedPayment] = await tx
      .update(schema.payments)
      .set({
        refundedAmount: R,
        refundedPlatformFeeAmount: F,
        refundedMerchantAmount: merchantRefunded,
        providerChargeId: sql`COALESCE(${schema.payments.providerChargeId}, ${providerChargeId})`,
        status: nextStatus,
        updatedAt: now,
      })
      .where(eq(schema.payments.id, payment.id))
      .returning();

    if (!updatedPayment) {
      // Le verrou pris a l'etape 1 rend ce cas theorique ; le signaler fort si
      // jamais rencontre plutot que de rendre un resultat inconsistant.
      throw new ApiException('REFUND_FAILED', undefined, undefined, { paymentId: payment.id });
    }

    // Le webhook ne deplace jamais le statut d'une reservation. Un remboursement
    // total constate hors du chemin d'annulation applicatif (dashboard Stripe,
    // CLI) laisse donc une reservation potentiellement encore CONFIRMED : signal
    // pour la console admin, jamais une decision automatique.
    if (updatedPayment.refundedAmount >= updatedPayment.amount && updatedPayment.amount > 0) {
      const [reservation] = await tx
        .select({ status: schema.reservations.status })
        .from(schema.reservations)
        .where(eq(schema.reservations.id, updatedPayment.reservationId))
        .limit(1);

      if (reservation && LIVE_RESERVATION_STATUSES.has(reservation.status)) {
        this.logger.warn(
          { reservationId: updatedPayment.reservationId, paymentId: updatedPayment.id },
          'remboursement total constate cote fournisseur alors que la reservation est toujours active — decision humaine requise',
        );
      }
    }

    return {
      outcome: 'APPLIED',
      paymentId: updatedPayment.id,
      reservationId: updatedPayment.reservationId,
      refundedAmount: updatedPayment.refundedAmount,
      refundedPlatformFeeAmount: updatedPayment.refundedPlatformFeeAmount,
      refundedMerchantAmount: updatedPayment.refundedMerchantAmount,
      paymentAmount: updatedPayment.amount,
      paymentStatus: updatedPayment.status,
      insertedRefundIds,
    };
  }

  private toNoopResult(payment: {
    id: string;
    reservationId: string;
    refundedAmount: number;
    refundedPlatformFeeAmount: number;
    refundedMerchantAmount: number;
    amount: number;
    status: PaymentStatus;
  }): RefundApplyResult {
    return {
      outcome: 'NOOP',
      paymentId: payment.id,
      reservationId: payment.reservationId,
      refundedAmount: payment.refundedAmount,
      refundedPlatformFeeAmount: payment.refundedPlatformFeeAmount,
      refundedMerchantAmount: payment.refundedMerchantAmount,
      paymentAmount: payment.amount,
      paymentStatus: payment.status,
      insertedRefundIds: [],
    };
  }
}
