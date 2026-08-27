import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import type { AppConfig } from '@try/config';
import type { Logger } from '@try/logger';

import { ConfigModule, CONFIG } from './common/config.module.js';
import { LoggerModule, LOGGER } from './common/logger.module.js';
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
import { ReminderService } from './modules/notifications/reminder.service.js';
import { ResendEmailTransport } from './modules/notifications/resend.transport.js';
import { MediaService } from './modules/media/media.service.js';
import { MediaController, MediaFileController } from './modules/media/media.controller.js';
import { NotificationController } from './modules/notifications/notification.controller.js';
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
import { RefundLedgerService } from './modules/payments/refund-ledger.service.js';
import { WebhookDispatcherService } from './modules/payments/webhook-dispatcher.service.js';
import { WebhookController } from './modules/payments/webhook.controller.js';
import { PAYMENT_PROVIDER } from './modules/payments/payment-provider.js';
import {
  StripePaymentProvider,
  UnconfiguredPaymentProvider,
} from './modules/payments/stripe.provider.js';
import { AuditService } from './modules/admin/audit.service.js';
import { BusinessService } from './modules/business/business.service.js';
import { BusinessController } from './modules/business/business.controller.js';
import { OnboardingService } from './modules/business/onboarding.service.js';
import { OnboardingController } from './modules/business/onboarding.controller.js';
import { ScheduleService } from './modules/scheduling/schedule.service.js';
import { ModerationService } from './modules/admin/moderation.service.js';
import { AdminController } from './modules/admin/admin.controller.js';
import { AdminBrowseService } from './modules/admin/admin-browse.service.js';
import { AdminBrowseController } from './modules/admin/admin-browse.controller.js';
import { ReviewService } from './modules/reviews/review.service.js';
import { ReviewController } from './modules/reviews/review.controller.js';
import { FavoriteService } from './modules/favorites/favorite.service.js';
import { FavoriteController } from './modules/favorites/favorite.controller.js';
import { AccountService } from './modules/users/account.service.js';
import { AccountController } from './modules/users/account.controller.js';
import { LifecycleJobsService } from './modules/jobs/lifecycle-jobs.service.js';
import { ReferenceController } from './modules/reference/reference.controller.js';
import { HealthController } from './modules/health/health.controller.js';
import { BookingLifecycleListener } from './modules/events/booking-lifecycle.listener.js';
import { ModerationLifecycleListener } from './modules/events/moderation-lifecycle.listener.js';

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
  imports: [ConfigModule, LoggerModule, DatabaseModule, ScheduleModule.forRoot()],
  controllers: [
    HealthController,
    ReferenceController,
    AuthController,
    DiscoveryController,
    OfferController,
    BookingController,
    CheckInController,
    BusinessController,
    OnboardingController,
    AdminController,
    AdminBrowseController,
    ReviewController,
    FavoriteController,
    AccountController,
    NotificationController,
    MediaController,
    MediaFileController,
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
    ReminderService,
    {
      /**
       * Le vrai transport dès qu'une clé est configurée, sinon la console.
       *
       * La validation de configuration exige déjà `RESEND_API_KEY` hors du
       * développement local ; sans cette fabrique, elle l'exigeait sans jamais
       * s'en servir — la production aurait démarré en écrivant les codes de
       * connexion dans ses journaux, en toute conformité apparente.
       */
      provide: EMAIL_TRANSPORT,
      inject: [CONFIG, LOGGER],
      useFactory: (config: AppConfig, logger: Logger) =>
        config.RESEND_API_KEY
          ? new ResendEmailTransport(config, logger)
          : new ConsoleEmailTransport(logger),
    },

    DiscoveryRepository,
    DiscoveryService,
    OfferCardMapper,
    OfferService,

    BookingService,
    BookingQueryService,
    CheckInService,
    BusinessService,
    OnboardingService,
    ScheduleService,
    ModerationService,
    AdminBrowseService,
    ReviewService,
    FavoriteService,
    AccountService,
    LifecycleJobsService,
    MediaService,

    PaymentService,
    RefundLedgerService,
    WebhookDispatcherService,
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
    ModerationLifecycleListener,

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
