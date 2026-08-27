import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { Logger } from '@try/logger';
import { DATABASE } from '../../common/database.module.js';
import { LOGGER } from '../../common/logger.module.js';
import { PAYMENT_PROVIDER, type PaymentProvider, type VerifiedWebhookEvent } from './payment-provider.js';
import { PaymentService } from './payment.service.js';
import { RefundLedgerService } from './refund-ledger.service.js';

/**
 * Traduit un `VerifiedWebhookEvent` en action. Extrait du controleur pour que le
 * job de rejeu (`LifecycleJobsService`) puisse retraiter un evenement stocke sans
 * passer par HTTP.
 */
@Injectable()
export class WebhookDispatcherService {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly payments: PaymentService,
    private readonly ledger: RefundLedgerService,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async dispatch(event: VerifiedWebhookEvent): Promise<void> {
    const fact = event.fact;
    switch (fact.kind) {
      case 'PAYMENT_SUCCEEDED':
        await this.payments.markSucceeded(fact.providerIntentId, fact.providerChargeId);
        return;
      case 'PAYMENT_FAILED':
        await this.payments.markFailed(fact.providerIntentId, fact.failureCode);
        return;
      case 'PAYMENT_CANCELED':
        await this.payments.markFailed(fact.providerIntentId, 'canceled');
        return;
      case 'CHECKOUT_COMPLETED':
        await this.payments.applyCheckoutCompleted({
          reservationId: fact.reservationId,
          providerIntentId: fact.providerIntentId,
          paid: fact.paid,
          amountTotalMinor: fact.amountTotalMinor,
        });
        return;
      case 'REFUND_OBSERVED':
        await this.ledger.apply({
          providerIntentId: fact.refund.providerIntentId,
          providerChargeId: fact.refund.providerChargeId,
          refunds: [fact.refund],
        });
        return;
      case 'REFUND_RECONCILE':
        await this.reconcile(fact);
        return;
      case 'UNSUPPORTED':
        this.logger.info({ type: event.type }, 'webhook type non traite');
        return;
      case 'UNPARSEABLE':
        throw new Error(`charge utile illisible (${event.type}): ${fact.reason}`);
      default: {
        const exhaustive: never = fact;
        throw new Error(`fait non gere: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /**
   * `charge.refunded` ne transporte aucune ecriture : il compare le cumul connu
   * au cumul rapporte, et ne relit le fournisseur — hors transaction — que si les
   * deux divergent. Le cas nominal (evenement `refund.*` deja traite) ne fait ni
   * appel reseau ni ecriture.
   */
  private async reconcile(fact: {
    providerIntentId: string | null;
    providerChargeId: string | null;
    refundedTotalMinor: number;
  }): Promise<void> {
    const criterion = fact.providerIntentId
      ? eq(schema.payments.providerPaymentIntentId, fact.providerIntentId)
      : fact.providerChargeId
        ? eq(schema.payments.providerChargeId, fact.providerChargeId)
        : null;

    if (!criterion) {
      this.logger.warn({ fact }, 'charge.refunded sans identifiant exploitable');
      return;
    }

    const [payment] = await this.db
      .select({
        id: schema.payments.id,
        refundedAmount: schema.payments.refundedAmount,
        providerPaymentIntentId: schema.payments.providerPaymentIntentId,
      })
      .from(schema.payments)
      .where(criterion)
      .limit(1);

    if (!payment) {
      this.logger.warn({ fact }, 'charge.refunded : paiement introuvable');
      return;
    }

    if (payment.refundedAmount === fact.refundedTotalMinor) {
      // Cas nominal : refund.created est deja passe, le cumul concorde deja.
      return;
    }

    const intentId = payment.providerPaymentIntentId ?? fact.providerIntentId;
    if (!intentId) {
      this.logger.warn({ fact, paymentId: payment.id }, 'charge.refunded : intent introuvable pour relire les remboursements');
      return;
    }

    const refunds = await this.provider.listRefunds(intentId);
    const applied = await this.ledger.apply({ paymentId: payment.id, refunds });

    if (applied.refundedAmount !== fact.refundedTotalMinor) {
      this.logger.warn(
        { paymentId: payment.id, ours: applied.refundedAmount, stripe: fact.refundedTotalMinor },
        'ecart persiste entre le registre et le cumul rapporte par Stripe apres reconciliation',
      );
    }
  }
}
