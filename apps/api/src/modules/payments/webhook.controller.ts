import { Controller, Headers, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { Logger } from '@try/logger';
import { Public } from '../../common/auth/auth.guard.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { LOGGER } from '../../common/logger.module.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider.js';
import { PaymentService } from './payment.service.js';
import { WebhookDispatcherService } from './webhook-dispatcher.service.js';

interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

@ApiTags('payments')
@Controller({ path: 'webhooks', version: '1' })
export class WebhookController {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly payments: PaymentService,
    private readonly dispatcher: WebhookDispatcherService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Stripe webhook receiver.
   *
   * Public because Stripe cannot present a bearer token — the signature *is* the
   * authentication, verified against the raw body before anything is parsed.
   *
   * Idempotent at three levels, not one:
   *  1. The unique index on `(provider, provider_event_id)` — a redelivered event
   *     is retried if its previous attempt failed, acknowledged otherwise.
   *  2. The unique index on `(provider, provider_refund_id)` in `refunds` — a
   *     redelivered `refund.*` cannot double-count, whatever event type carried it.
   *  3. `payments.refunded_*` is a projection RECALCULATED from the ledger on
   *     every application, never incremented, so replay in any order converges.
   *
   * Always returns 200 once the event is recorded. Returning 500 on a handler bug
   * would make Stripe retry the same poison event for days; the row carries the
   * failure for inspection, and `LifecycleJobsService.replayFailedWebhooks` is
   * what actually retries it later (Stripe itself does not, once we have 2xx'd).
   */
  @Post('stripe')
  @HttpCode(200)
  @Public()
  @ApiExcludeEndpoint()
  async stripe(
    @Req() request: RawBodyRequest,
    @Headers('stripe-signature') signature?: string,
  ): Promise<{ received: true }> {
    if (!signature) throw ApiException.forbidden('missing stripe-signature header');

    const rawBody = request.rawBody;
    if (!rawBody) {
      // Signature verification is impossible without the exact bytes Stripe signed.
      throw new ApiException('INTERNAL_ERROR', undefined, undefined, {
        reason: 'raw body not captured for webhook route',
      });
    }

    const event = this.provider.verifyWebhook(rawBody, signature);

    const { shouldProcess, eventRowId } = await this.payments.recordWebhookEvent({
      provider: 'STRIPE',
      providerEventId: event.id,
      eventType: event.type,
      payload: event.payload,
    });

    if (!shouldProcess || !eventRowId) {
      this.logger.info({ eventId: event.id, type: event.type }, 'duplicate webhook ignored');
      return { received: true };
    }

    try {
      await this.dispatcher.dispatch(event);
      await this.payments.markWebhookProcessed(eventRowId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.payments.markWebhookFailed(eventRowId, message);
      this.logger.error({ err: error, eventId: event.id, type: event.type }, 'webhook failed');
    }

    return { received: true };
  }
}
