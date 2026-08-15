import { describe, expect, it } from 'vitest';
import { WebhookDispatcherService } from './webhook-dispatcher.service.js';
import type { PaymentProvider } from './payment-provider.js';
import type { PaymentService } from './payment.service.js';
import type { RefundLedgerService } from './refund-ledger.service.js';
import type { Database } from '@try/database';
import type { Logger } from '@try/logger';

/**
 * B1 : une charge utile illisible doit se CONSTATER (webhook_events porte
 * l'echec) et jamais se perdre en 500. `dispatch` doit donc rejeter sur
 * `UNPARSEABLE` — c'est ce rejet que le controleur capture pour appeler
 * `markWebhookFailed` au lieu de laisser le handler HTTP planter.
 */
describe('WebhookDispatcherService — case UNPARSEABLE', () => {
  it('rejette avec un message portant le type d\'evenement et la raison', async () => {
    // Le case UNPARSEABLE est atteint avant tout usage d'une dependance : des
    // doubles vides suffisent, aucune des cinq n'est jamais appelee.
    const dispatcher = new WebhookDispatcherService(
      {} as unknown as PaymentProvider,
      {} as unknown as PaymentService,
      {} as unknown as RefundLedgerService,
      {} as unknown as Database,
      {} as unknown as Logger,
    );

    await expect(
      dispatcher.dispatch({
        id: 'evt_x',
        type: 'refund.created',
        payload: {},
        fact: { kind: 'UNPARSEABLE', reason: 'boom' },
      }),
    ).rejects.toThrow(/refund\.created.*boom/);
  });
});
