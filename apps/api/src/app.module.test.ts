import 'reflect-metadata';
import { beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module.js';
import { DATABASE, DATABASE_HANDLE } from './common/database.module.js';
import { BookingService } from './modules/bookings/booking.service.js';
import { CheckInService } from './modules/checkins/checkin.service.js';
import { DiscoveryService } from './modules/discovery/discovery.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import { PaymentService } from './modules/payments/payment.service.js';
import { BookingQueryService } from './modules/bookings/booking-query.service.js';

/**
 * Container smoke test.
 *
 * NestJS resolves constructor dependencies from `emitDecoratorMetadata`, which
 * needs each injected class to be a *runtime* import. A stray `import type` on an
 * injected service degrades that metadata to `Object`, and the application fails
 * to boot — while `tsc --noEmit` and `nest build` both stay perfectly green.
 *
 * This test is the guard for that whole class of failure: it compiles the real
 * module graph and asserts every service actually resolves.
 */
describe('AppModule dependency graph', () => {
  let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;

  beforeAll(async () => {
    // Minimum configuration for the container to build. No connection is opened:
    // postgres.js connects lazily and nothing here issues a query.
    Object.assign(process.env, {
      APP_ENV: 'local',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/try_test',
      JWT_SECRET: 'x'.repeat(32),
      CHECKIN_TOKEN_SECRET: 'y'.repeat(32),
    });

    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue({})
      .overrideProvider(DATABASE_HANDLE)
      .useValue({ ping: () => Promise.resolve(true), close: () => Promise.resolve() })
      .compile();
  });

  it('resolves every domain service', () => {
    expect(moduleRef.get(BookingService)).toBeInstanceOf(BookingService);
    expect(moduleRef.get(BookingQueryService)).toBeInstanceOf(BookingQueryService);
    expect(moduleRef.get(CheckInService)).toBeInstanceOf(CheckInService);
    expect(moduleRef.get(DiscoveryService)).toBeInstanceOf(DiscoveryService);
    expect(moduleRef.get(AuthService)).toBeInstanceOf(AuthService);
    expect(moduleRef.get(PaymentService)).toBeInstanceOf(PaymentService);
  });

  it('injects real instances rather than undefined placeholders', () => {
    const booking = moduleRef.get(BookingService);
    // A degraded `import type` shows up here as an undefined dependency.
    for (const key of ['db', 'clock', 'crypto', 'payments', 'events'] as const) {
      expect((booking as unknown as Record<string, unknown>)[key]).toBeDefined();
    }
  });

  it('falls back to a provider that refuses payments when Stripe is unconfigured', async () => {
    const payments = moduleRef.get(PaymentService);
    expect(payments).toBeDefined();
    // Local config has no Stripe keys, so paid bookings must fail loudly rather
    // than silently "succeed" with a fake payment.
    await expect(
      (payments as unknown as { provider: { createIntent: () => Promise<unknown> } }).provider.createIntent(),
    ).rejects.toThrow();
  });
});
