import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { allocateRefundLine, MoneyError, refundedFeeAt } from '@try/utils';
import type { Clock } from '@try/utils';
import { schema } from '@try/database';
import type { Database, Transaction } from '@try/database';
import type { Logger } from '@try/logger';
import { hasNoObservedCapture } from '@try/contracts';
import type { PaymentStatus } from '@try/contracts';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { LOGGER } from '../../common/logger.module.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { DomainEvents } from '../events/domain-events.js';
import type { ProviderRefund } from './payment-provider.js';
import { confirmReservationOnCapture, type ConfirmedReservationEffect } from './confirm-capture.js';

const PROVIDER = 'STRIPE';
/**
 * Statuts ou la seance TIENT TOUJOURS : elle est confirmee, ou elle a eu lieu.
 * Un remboursement total sans annulation applicative y est donc anormal.
 *
 * DELIBEREMENT PAS `isLiveReservationStatus` de @try/contracts, malgre la
 * parente des noms. Le contrat repond « l'utilisateur peut-il encore agir
 * dessus depuis l'app ? » — donc PENDING, PAYMENT_PENDING, CONFIRMED. Ici on
 * demande « la seance tient-elle toujours ? » — donc CONFIRMED et CHECKED_IN.
 * Les deux ensembles se croisent sans se recouvrir, et prendre celui du
 * contrat ferait cesser l'alerte sur CHECKED_IN, c'est-a-dire sur le cas le
 * plus anormal : la personne est venue et a ete integralement remboursee.
 *
 * Rapprocher les deux demanderait un predicat nomme pour CETTE question dans
 * les contrats. Tant qu'il n'existe pas, ce Set reste local et son nom dit
 * lequel des deux il est.
 */
const STANDING_RESERVATION_STATUSES = new Set(['CONFIRMED', 'CHECKED_IN']);

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
  /**
   * Non-null uniquement quand ce remboursement vient de reveler un encaissement
   * dont le `payment_intent.succeeded` n'a jamais ete applique (voir
   * `hasNoObservedCapture`, @try/contracts/payment-capture.ts) — c'est-a-dire
   * quand `R > 0` a fait sortir le paiement d'un statut "jamais capture". Porte de quoi emettre
   * `PaymentSucceeded` apres commit ; ne peut se produire que via `apply()`
   * (chemin webhook) — `refundReservation` exige deja SUCCEEDED/
   * PARTIALLY_REFUNDED en entree, donc n'atteint jamais cette branche.
   */
  capturedPayment: { paymentId: string; reservationId: string; amount: number } | null;
  /**
   * Non-null si, en plus de `capturedPayment`, la reservation vient d'etre
   * confirmee comme effet de bord de cette decouverte (voir
   * `confirmReservationOnCapture`, appele depuis `applyWithin`) : porte de
   * quoi emettre `BookingConfirmed` apres commit, exactement comme
   * `capturedPayment` porte de quoi emettre `PaymentSucceeded`.
   *
   * Reste `null` meme quand une confirmation etait due si le remboursement
   * constate est TOTAL (`nextStatus === 'REFUNDED'`) : confirmer une
   * reservation qu'on est en train de rembourser a 100% la ferait entrer
   * dans `TRIAL_CONSUMING_STATUSES` de facon irreversible (REFUNDED n'est
   * pas atteignable depuis CONFIRMED, voir reservation-state-machine.ts) —
   * cul-de-sac decouvert en revue le 2026-08-16. Seul un remboursement
   * PARTIEL peut declencher cette confirmation ; un remboursement total sur
   * un encaissement jamais vu reste un signal (`logger.warn` plus bas), pas
   * une decision automatique.
   */
  capturedReservation: ConfirmedReservationEffect | null;
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
  capturedPayment: null,
  capturedReservation: null,
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

      // Ce remboursement vient de reveler un encaissement dont le
      // `payment_intent.succeeded` n'avait jamais ete applique : rejoue, apres
      // commit, exactement les evenements que ce webhook aurait produits — voir
      // confirm-capture.ts et hasNoObservedCapture (@try/contracts/payment-capture.ts)
      // plus bas.
      if (result.capturedPayment) {
        if (result.capturedReservation) {
          this.events.emit('BookingConfirmed', {
            reservationId: result.capturedReservation.reservationId,
            userId: result.capturedReservation.userId,
            businessId: result.capturedReservation.businessId,
            venueId: result.capturedReservation.venueId,
            offerId: result.capturedReservation.offerId,
            isFree: false,
          });
        }
        this.events.emit('PaymentSucceeded', {
          reservationId: result.capturedPayment.reservationId,
          paymentId: result.capturedPayment.paymentId,
          amount: result.capturedPayment.amount,
        });
      }
    }

    return result;
  }

  /** Se greffe sur une transaction existante. Chemin d'annulation. */
  async applyWithin(tx: Transaction, input: RefundApplyInput): Promise<RefundApplyResult> {
    const now = this.clock.now();

    // 1. Resolution du paiement, avec verrou — precedee d'un verrou sur
    // `reservations`, dans le MEME ordre que le chemin d'annulation
    // (reservations puis payments — voir booking.service.ts `cancel()` puis
    // payment.service.ts `refundReservation()`).
    //
    // Ce n'est PAS optionnel, et ce n'est pas seulement pour le rejeu de
    // `confirmReservationOnCapture` plus bas : l'etape 3 ci-dessous insere des
    // lignes dans `refunds`, dont la colonne `reservation_id` porte une
    // contrainte de cle etrangere vers `reservations(id)`
    // (`refunds_reservation_id_reservations_id_fk`). Pour verifier cette
    // contrainte, Postgres prend LUI-MEME, silencieusement, un verrou `FOR KEY
    // SHARE` sur la ligne `reservations` referencee au moment de l'INSERT — que
    // notre code touche explicitement cette table ou non. Verifie en confondant
    // le bug : verrouiller `payments` avant `reservations` ici (comme avant
    // cette revue) reproduit un interblocage ABBA reel avec le chemin
    // d'annulation des qu'un remboursement (n'importe lequel — pas seulement un
    // encaissement jamais vu) est traite dans sa PROPRE transaction (le chemin
    // webhook, `apply()`) au meme moment qu'une annulation ; confirme par
    // Postgres (`deadlock detected`, code `40P01`) dans
    // refund-webhook.integration.test.ts avant ce correctif.
    //
    // `FOR KEY SHARE` (le niveau le plus faible) plutot que `FOR UPDATE` :
    // c'est exactement le niveau que Postgres demandera de toute facon a
    // l'etape 3, et plusieurs verrous `FOR KEY SHARE` concurrents sur la meme
    // ligne ne se bloquent pas entre eux — deux remboursements concurrents sur
    // le meme paiement (voir le test de serialisation plus bas) continuent donc
    // a ne se serialiser que sur le verrou `payments`, pas plus qu'avant.
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

    // Lecture non verrouillee : seul le reservation_id nous interesse a ce
    // stade, pour savoir QUOI verrouiller avant `payments`. Si aucune ligne ne
    // correspond, il n'y a de toute facon rien a verrouiller.
    const [lookup] = await tx
      .select({ reservationId: schema.payments.reservationId })
      .from(schema.payments)
      .where(criterion)
      .limit(1);

    if (!lookup) {
      // Le compte Stripe peut porter d'autres flux ; l'evenement est marque
      // traite et sa charge utile reste dans webhook_events pour inspection.
      this.logger.warn({ input }, 'paiement inconnu pour ce remboursement');
      return NOT_FOUND_RESULT;
    }

    await tx.execute(sql`SELECT 1 FROM reservations WHERE id = ${lookup.reservationId} FOR KEY SHARE`);

    const [payment] = await tx
      .select()
      .from(schema.payments)
      .where(criterion)
      .for('update')
      .limit(1);

    if (!payment) {
      // Theoriquement inatteignable juste apres l'avoir trouve ci-dessus (aucun
      // DELETE sur `payments` n'existe dans le code) ; garde defensive plutot
      // que de supposer que ce restera toujours vrai.
      this.logger.warn({ input }, 'paiement inconnu pour ce remboursement');
      return NOT_FOUND_RESULT;
    }

    if (payment.amount === 0) {
      this.logger.error({ paymentId: payment.id }, 'remboursement recu sur une reservation gratuite');
      return this.toNoopResult(payment);
    }

    // Memorise AVANT toute ecriture : les statuts en jeu ici ne sont eux-memes
    // ecrits que par payment.service.ts, jamais par ce service — le lire
    // maintenant capture fidelement "ce qu'on savait avant ce remboursement".
    const encaissementJamaisVu = hasNoObservedCapture(payment.status);

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
    let nextStatus: PaymentStatus;
    if (R >= payment.amount) {
      nextStatus = 'REFUNDED';
    } else if (R > 0) {
      nextStatus = 'PARTIALLY_REFUNDED';
    } else if (!encaissementJamaisVu) {
      // La capture etait deja etablie avant cet appel (webhook de succes deja
      // traite, ou remboursement precedent deja observe) : R === 0 signifie
      // juste "rien de rembourse pour l'instant". No-op historique.
      nextStatus = 'SUCCEEDED';
    } else {
      // R === 0 sous encaissementJamaisVu : aucune ligne SUCCEEDED n'existe pour
      // ce paiement (R est justement la somme des lignes SUCCEEDED, calculee a
      // l'etape 4 ci-dessus ; la contrainte `refunds_amount_positive` — CHECK
      // amount > 0, active depuis 0000_init.sql, verifiee en base le
      // 2026-08-16 via pg_constraint — garantit qu'une telle ligne, si elle
      // existait, porterait forcement R > 0). Une ligne PENDING ou FAILED
      // seule ne suffit plus a promouvoir depuis la revue du 2026-08-16 :
      // PENDING n'est pas un encaissement confirme, et attendre son webhook de
      // resolution (refund.updated -> SUCCEEDED) pour corriger un
      // sur-comptage de commission contredirait l'hypothese meme qui justifie
      // cette reconstruction — la perte de webhooks. Sans ligne SUCCEEDED, on
      // n'en sait pas plus qu'avant cet appel : statut inchange, aucune
      // ecriture de commission, aucun effet de bord reservation.
      nextStatus = payment.status;

      if (encaissementJamaisVu) {
        // Observabilite : c'est l'anomalie la plus digne d'etre vue (un
        // remboursement arrive sur un paiement dont on n'a jamais vu la
        // capture) mais qui ne change rien a l'etat — sans ce log, elle passe
        // completement inapercue.
        this.logger.warn(
          { paymentId: payment.id, previousStatus: payment.status },
          "remboursement recu sur un paiement jamais confirme, sans ligne SUCCEEDED suffisante pour reconstruire l'encaissement — statut inchange",
        );
      }
    }

    // Reconstruction reelle, pas seulement "encaissementJamaisVu" : d'apres le
    // if/else ci-dessus, quand encaissementJamaisVu est vrai, la seule autre
    // issue possible laisse nextStatus === payment.status (R === 0, sans
    // preuve). C'est cette comparaison, et non encaissementJamaisVu seul, qui
    // doit gouverner le log, l'ecriture de succeeded_at/failure_code, et le
    // rejeu des effets de bord de reservation ci-dessous : sans elle, une
    // redelivrance qui ne change rien journalise quand meme "encaissement
    // reconstruit" a chaque fois.
    const captureRecovered = encaissementJamaisVu && nextStatus !== payment.status;

    if (captureRecovered) {
      // Defaut de livraison webhook, pas une anomalie silencieuse : ce
      // remboursement est la seule preuve qu'on ait jamais eue que Stripe a
      // pris l'argent.
      this.logger.error(
        {
          paymentId: payment.id,
          previousStatus: payment.status,
          providerPaymentIntentId: payment.providerPaymentIntentId,
        },
        'encaissement reconstruit depuis un remboursement — payment_intent.succeeded jamais applique',
      );
    }

    const [updatedPayment] = await tx
      .update(schema.payments)
      .set({
        refundedAmount: R,
        refundedPlatformFeeAmount: F,
        refundedMerchantAmount: merchantRefunded,
        providerChargeId: sql`COALESCE(${schema.payments.providerChargeId}, ${providerChargeId})`,
        status: nextStatus,
        updatedAt: now,
        // Sans ca, un paiement reconstruit depuis FAILED resterait marque en
        // echec tout en portant un remboursement. `succeeded_at` NE PORTE PAS
        // la date de capture, quoi qu'en dise l'ancien commentaire ici : faute
        // de mieux, on y met la plus ancienne date de remboursement connue
        // (refunds.created_at porte l'occurredAt fournisseur du remboursement,
        // pas un horodatage de capture — voir l'INSERT plus haut). C'est la
        // meilleure approximation disponible, pas la verite ; sans consequence
        // aujourd'hui car aucune lecture de cette colonne n'existe ailleurs.
        // Restreint a SUCCEEDED (revue du 2026-08-16) : la preuve qui a fait
        // promouvoir `nextStatus` ne repose que sur des lignes SUCCEEDED (voir
        // l'etape 4) ; inclure PENDING ici pouvait faire dater cette colonne
        // par une ligne plus ancienne mais non aboutie, dont on ne sait meme
        // pas si elle finira par reussir.
        ...(captureRecovered
          ? {
              failureCode: null,
              succeededAt: sql`COALESCE(${schema.payments.succeededAt}, (
                SELECT MIN(refunds.created_at) FROM refunds
                WHERE refunds.payment_id = ${payment.id} AND refunds.status = 'SUCCEEDED'
              ))`,
            }
          : {}),
      })
      .where(eq(schema.payments.id, payment.id))
      .returning();

    if (!updatedPayment) {
      // Le verrou pris a l'etape 1 rend ce cas theorique ; le signaler fort si
      // jamais rencontre plutot que de rendre un resultat inconsistant.
      throw new ApiException('REFUND_FAILED', undefined, undefined, { paymentId: payment.id });
    }

    // Un remboursement TOTAL ne rejoue jamais la confirmation de reservation,
    // meme quand il vient de reveler un encaissement jamais vu : confirmer une
    // reservation qu'on est en train de rembourser a 100% la ferait entrer dans
    // TRIAL_CONSUMING_STATUSES sans retour possible (REFUNDED n'est pas
    // atteignable depuis CONFIRMED — reservation-state-machine.ts:62-79,95-104),
    // ET declencherait `BookingConfirmed` (e-mail de confirmation avec code de
    // check-in) pour un client qu'on vient de rembourser integralement — bug
    // trouve en revue le 2026-08-16. Seul un remboursement PARTIEL peut
    // legitimement confirmer une reservation encore PAYMENT_PENDING : le client
    // a bien paye une partie, sa venue reste due.
    const shouldConfirmReservation = captureRecovered && nextStatus !== 'REFUNDED';

    // Rejoue, DANS CETTE MEME transaction, les effets de bord qu'un
    // `payment_intent.succeeded` normal aurait produits (reservation ->
    // CONFIRMED si elle est encore PAYMENT_PENDING, trial_history assorti) —
    // evenements diffuses par `apply()` apres commit (voir confirm-capture.ts).
    // Safe ICI, contrairement a une premiere version de ce correctif : le
    // verrou `reservations` (`FOR KEY SHARE`) est deja detenu par CETTE
    // transaction depuis l'etape 1, AVANT le verrou `payments` — dans le meme
    // ordre que le chemin d'annulation. Une transaction ne se bloque jamais
    // elle-meme en demandant un verrou (meme plus fort, `FOR UPDATE` via cet
    // UPDATE) sur une ligne dont elle detient deja un verrou compatible ou plus
    // faible ; seul l'ORDRE entre deux transactions CONCURRENTES compte, et il
    // est desormais identique des deux cotes.
    const capturedReservation = shouldConfirmReservation
      ? await confirmReservationOnCapture(tx, updatedPayment.reservationId, now)
      : null;

    // Le webhook ne deplace jamais le statut d'une reservation de sa propre
    // initiative : la confirmation ci-dessus est la seule exception assumee,
    // bornee au seul cas ou elle rejoue un `payment_intent.succeeded` qui
    // aurait du arriver, sur un remboursement PARTIEL. Le reste (remboursement
    // total constate hors chemin applicatif) reste un signal, jamais une
    // decision automatique.
    if (updatedPayment.refundedAmount >= updatedPayment.amount && updatedPayment.amount > 0) {
      const [reservation] = await tx
        .select({ status: schema.reservations.status })
        .from(schema.reservations)
        .where(eq(schema.reservations.id, updatedPayment.reservationId))
        .limit(1);

      const reservationStillLive =
        !!reservation && STANDING_RESERVATION_STATUSES.has(reservation.status);
      if (reservationStillLive) {
        this.logger.warn(
          { reservationId: updatedPayment.reservationId, paymentId: updatedPayment.id },
          'remboursement total constate cote fournisseur alors que la reservation est toujours active — decision humaine requise',
        );
      } else if (reservation && captureRecovered) {
        // Remboursement TOTAL sur un encaissement jamais vu : la reservation
        // reste volontairement hors de CONFIRMED (voir plus haut), donc son
        // statut ici est typiquement encore PAYMENT_PENDING (ou deja EXPIRED si
        // le hold a expire entre-temps) — ce n'est pas une race, c'est le
        // comportement voulu. Signal pour permettre une verification manuelle
        // (la place a pu, independamment, etre liberee par expiration du hold).
        this.logger.warn(
          {
            reservationId: updatedPayment.reservationId,
            paymentId: updatedPayment.id,
            reservationStatus: reservation.status,
          },
          'remboursement total constate sur un paiement dont l\'encaissement n\'avait jamais ete confirme — la reservation n\'est pas confirmee automatiquement',
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
      capturedPayment: captureRecovered
        ? { paymentId: updatedPayment.id, reservationId: updatedPayment.reservationId, amount: updatedPayment.amount }
        : null,
      capturedReservation,
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
      capturedPayment: null,
      capturedReservation: null,
    };
  }
}
