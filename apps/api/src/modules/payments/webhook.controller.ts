import { Controller, Headers, Inject, Post, Req } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { Logger } from '@try/logger';
import { Public } from '../../common/auth/auth.guard.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { LOGGER } from '../../common/logger.module.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider.js';
import { PaymentService } from './payment.service.js';

interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

@ApiTags('payments')
@Controller({ path: 'webhooks', version: '1' })
export class WebhookController {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly payments: PaymentService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Stripe webhook receiver.
   *
   * Public because Stripe cannot present a bearer token — the signature *is* the
   * authentication, verified against the raw body before anything is parsed.
   *
   * The handler is idempotent at two levels: the unique index on the provider
   * event id (redelivery is acknowledged, not reprocessed) and the conditional
   * UPDATEs inside PaymentService. Stripe guarantees at-least-once delivery, so
   * both matter.
   *
   * It always returns 200 once the event is recorded. Returning 500 on a handler
   * bug would make Stripe retry the same poison event for days; the row carries
   * the failure for inspection instead.
   */
  @Post('stripe')
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
      await this.dispatch(event.type, event.payload);
      await this.payments.markWebhookProcessed(eventRowId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.payments.markWebhookFailed(eventRowId, message);
      this.logger.error({ err: error, eventId: event.id, type: event.type }, 'webhook failed');
    }

    return { received: true };
  }

  private async dispatch(type: string, payload: Record<string, unknown>): Promise<void> {
    const intentId = extractPaymentIntentId(payload);
    if (!intentId) return;

    switch (type) {
      case 'payment_intent.succeeded':
        await this.payments.markSucceeded(intentId);
        return;
      case 'payment_intent.payment_failed':
        await this.payments.markFailed(intentId, extractFailureCode(payload));
        return;
      case 'payment_intent.canceled':
        await this.payments.markFailed(intentId, 'canceled');
        return;
      default:
        // Unhandled types are still recorded, so adding a handler later can replay them.
        this.logger.debug({ type }, 'webhook type not handled');
    }
  }
}

function extractPaymentIntentId(payload: Record<string, unknown>): string | null {
  const data = payload.data as { object?: { id?: unknown } } | undefined;
  const id = data?.object?.id;
  return typeof id === 'string' ? id : null;
}

function extractFailureCode(payload: Record<string, unknown>): string | null {
  const data = payload.data as
    | { object?: { last_payment_error?: { code?: unknown } } }
    | undefined;
  const code = data?.object?.last_payment_error?.code;
  return typeof code === 'string' ? code : null;
}
