import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { createDatabase } from '@try/database';
import type { Database } from '@try/database';
import type { AppConfig } from '@try/config';
import { CONFIG } from './config.module.js';

export const DATABASE = Symbol('DATABASE');
export const DATABASE_HANDLE = Symbol('DATABASE_HANDLE');

type DatabaseHandle = ReturnType<typeof createDatabase>;

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle) {}

  /** Drains the pool on SIGTERM so in-flight bookings finish before the process exits. */
  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_HANDLE,
      inject: [CONFIG],
      useFactory: (config: AppConfig): DatabaseHandle =>
        createDatabase({
          url: config.DATABASE_URL,
          maxConnections: config.DATABASE_MAX_CONNECTIONS,
          ssl: config.DATABASE_SSL,
        }),
    },
    {
      provide: DATABASE,
      inject: [DATABASE_HANDLE],
      useFactory: (handle: DatabaseHandle): Database => handle.db,
    },
    DatabaseLifecycle,
  ],
  exports: [DATABASE, DATABASE_HANDLE],
})
export class DatabaseModule {}
