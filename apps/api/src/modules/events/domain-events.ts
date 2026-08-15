import { EventEmitter } from 'node:events';
import { Inject, Injectable } from '@nestjs/common';
import { getRequestId } from '@try/logger';
import type { Logger } from '@try/logger';
import { LOGGER } from '../../common/logger.module.js';

/**
 * In-process domain events.
 *
 * The modular monolith uses these to decouple side effects (email, push,
 * analytics) from the transaction that caused them: confirming a booking must not
 * wait on an email provider, and an email provider outage must not roll back a
 * confirmed booking.
 *
 * Deliberately not Kafka. When a module needs to be extracted, these event names
 * are already the seam — the emit sites do not change, only the transport behind
 * this class.
 */

export interface DomainEventMap {
  BookingConfirmed: {
    reservationId: string;
    userId: string;
    businessId: string;
    venueId: string;
    offerId: string;
    isFree: boolean;
  };
  BookingPaymentPending: {
    reservationId: string;
    userId: string;
    businessId: string;
    venueId: string;
    offerId: string;
    isFree: boolean;
  };
  BookingCancelled: {
    reservationId: string;
    userId: string;
    businessId: string;
    refunded: boolean;
  };
  BookingExpired: { reservationId: string; userId: string };
  CheckInCompleted: {
    reservationId: string;
    userId: string;
    businessId: string;
    venueId: string;
    method: 'qr' | 'code';
  };
  TrialCompleted: { reservationId: string; userId: string; businessId: string; venueId: string };
  ReviewSubmitted: { reservationId: string; userId: string; venueId: string; rating: number };
  LeadConverted: { leadId: string; businessId: string; revenueMinor: number };
  PaymentSucceeded: { reservationId: string; paymentId: string; amount: number };
  PaymentFailed: { reservationId: string; paymentId: string; failureCode: string | null };
  PaymentRefunded: {
    reservationId: string;
    paymentId: string;
    providerRefundId: string;
    amountMinor: number;
    cumulativeRefundedMinor: number;
    platformFeeReversedMinor: number;
    isFullRefund: boolean;
  };
}

export type DomainEventName = keyof DomainEventMap;

export type DomainEventHandler<K extends DomainEventName> = (
  payload: DomainEventMap[K] & { requestId: string | undefined },
) => void | Promise<void>;

@Injectable()
export class DomainEvents {
  private readonly emitter = new EventEmitter();

  constructor(@Inject(LOGGER) private readonly logger: Logger) {
    // Listeners are side effects; one failing must never take down the emitter
    // or, worse, surface as an unhandled rejection that kills the process.
    this.emitter.setMaxListeners(50);
  }

  emit<K extends DomainEventName>(name: K, payload: DomainEventMap[K]): void {
    this.emitter.emit(name, { ...payload, requestId: getRequestId() });
  }

  on<K extends DomainEventName>(name: K, handler: DomainEventHandler<K>): void {
    this.emitter.on(name, (payload: DomainEventMap[K] & { requestId: string | undefined }) => {
      void (async () => {
        try {
          await handler(payload);
        } catch (error) {
          this.logger.error(
            { err: error, event: name, requestId: payload.requestId },
            'domain event handler failed',
          );
        }
      })();
    });
  }
}
