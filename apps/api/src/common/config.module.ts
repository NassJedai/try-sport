import { Global, Module } from '@nestjs/common';
import { loadConfig } from '@try/config';
import type { AppConfig } from '@try/config';

export const CONFIG = Symbol('CONFIG');

/**
 * Configuration is loaded exactly once at boot. If it is invalid the factory
 * throws and Nest refuses to start, which is the intended behaviour: a missing
 * Stripe key should fail the deploy, not the first payment.
 */
@Global()
@Module({
  providers: [
    {
      provide: CONFIG,
      useFactory: (): AppConfig => loadConfig(),
    },
  ],
  exports: [CONFIG],
})
export class ConfigModule {}
