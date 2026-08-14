import { Global, Module } from '@nestjs/common';
import { createLogger } from '@try/logger';
import type { Logger } from '@try/logger';
import { CONFIG, ConfigModule } from './config.module.js';
import type { AppConfig } from '@try/config';

export const LOGGER = Symbol('LOGGER');

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: LOGGER,
      inject: [CONFIG],
      useFactory: (config: AppConfig): Logger =>
        createLogger({
          level: config.LOG_LEVEL,
          pretty: config.isLocal,
          environment: config.APP_ENV,
        }),
    },
  ],
  exports: [LOGGER],
})
export class LoggerModule {}
