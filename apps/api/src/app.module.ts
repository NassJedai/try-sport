import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { AppConfig } from '@try/config';

import { ConfigModule, CONFIG } from './common/config.module.js';
import { LoggerModule } from './common/logger.module.js';
import { DatabaseModule } from './common/database.module.js';
import { CLOCK, SystemClockProvider } from './common/clock.js';
import { CryptoService } from './common/crypto.service.js';
import { RequestContextMiddleware } from './common/request-context.middleware.js';
import { ApiExceptionFilter } from './common/errors/exception.filter.js';
import { AuthGuard } from './common/auth/auth.guard.js';
import { RateLimitGuard } from './common/rate-limit/rate-limit.guard.js';
import { RateLimiter } from './common/rate-limit/rate-limiter.js';
import { IdempotencyService } from './common/idempotency/idempotency.service.js';

import { DomainEvents } from './modules/events/domain-events.js';
import { TokenService } from './modules/auth/token.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import { AuthController } from './modules/auth/auth.controller.js';
import {
  ConsoleEmailTransport,
  EMAIL_TRANSPORT,
  NotificationService,
} from './modules/notifications/notification.service.js';
import { DiscoveryRepository } from './modules/discovery/discovery.repository.js';
import { DiscoveryService } from './modules/discovery/discovery.service.js';
import { DiscoveryController } from './modules/discovery/discovery.controller.js';
import { OfferCardMapper } from './modules/discovery/offer-card.mapper.js';
import { OfferService } from './modules/offers/offer.service.js';
import { OfferController } from './modules/offers/offer.controller.js';
import { BookingService } from './modules/bookings/booking.service.js';
import { BookingQueryService } from './modules/bookings/booking-query.service.js';
import { BookingController } from './modules/bookings/booking.controller.js';
import { CheckInService } from './modules/checkins/checkin.service.js';
import { CheckInController } from './modules/checkins/checkin.controller.js';
import { PaymentService } from './modules/payments/payment.service.js';
import { WebhookController } from './modules/payments/webhook.controller.js';
import { PAYMENT_PROVIDER } from './modules/payments/payment-provider.js';
import {
  StripePaymentProvider,
  UnconfiguredPaymentProvider,
} from './modules/payments/stripe.provider.js';
import { AuditService } from './modules/admin/audit.service.js';
import { BusinessService } from './modules/business/business.service.js';
import { BusinessController } from './modules/business/business.controller.js';
import { HealthController } from './modules/health/health.controller.js';
import { BookingLifecycleListener } from './modules/events/booking-lifecycle.listener.js';

/**
 * A modular monolith, wired in one place.
 *
 * The module boundaries are real — each domain owns its services and talks to
 * others through DomainEvents rather than reaching into their internals — but
 * they deploy as one process. That keeps a booking, its payment and its trial
 * history inside a single database transaction, which is worth far more at this
 * stage than independent deployability.
 */
@Module({
  imports: [ConfigModule, LoggerModule, DatabaseModule],
  controllers: [
    HealthController,
    AuthController,
    DiscoveryController,
    OfferController,
    BookingController,
    CheckInController,
    BusinessController,
    WebhookController,
  ],
  providers: [
    { provide: CLOCK, useClass: SystemClockProvider },
    CryptoService,
    RateLimiter,
    IdempotencyService,
    DomainEvents,
    AuditService,

    TokenService,
    AuthService,
    NotificationService,
    { provide: EMAIL_TRANSPORT, useClass: ConsoleEmailTransport },

    DiscoveryRepository,
    DiscoveryService,
    OfferCardMapper,
    OfferService,

    BookingService,
    BookingQueryService,
    CheckInService,
    BusinessService,

    PaymentService,
    {
      /**
       * Stripe is only constructed when it is actually configured. The fallback
       * refuses paid bookings loudly instead of faking a successful payment,
       * which would hide a broken payment path until production.
       */
      provide: PAYMENT_PROVIDER,
      inject: [CONFIG],
      useFactory: (config: AppConfig) =>
        config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET
          ? new StripePaymentProvider(config)
          : new UnconfiguredPaymentProvider(),
    },

    BookingLifecycleListener,

    // Order matters: authentication resolves the principal that rate limiting
    // then keys on, so an authenticated user is limited per account, not per IP.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
