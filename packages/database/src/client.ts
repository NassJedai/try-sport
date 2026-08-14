import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDatabase>['db'];

/**
 * A transaction handle. Repository methods accept this so the booking flow can
 * compose several writes inside one transaction without the caller having to
 * know which connection they are on.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Anything that can run a query: the pool, or a transaction inside it. */
export type Executor = Database | Transaction;

export interface DatabaseOptions {
  url: string;
  /**
   * Connection cap. Serverless Postgres (Neon) charges per connection and pools
   * externally, so the app-side pool stays small; a large pool here just moves
   * queueing from the app to the database.
   */
  maxConnections?: number;
  idleTimeoutSeconds?: number;
  connectTimeoutSeconds?: number;
  ssl?: boolean;
  onQuery?: (query: string, durationMs: number) => void;
}

export function createDatabase(options: DatabaseOptions) {
  const client = postgres(options.url, {
    max: options.maxConnections ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 30,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    ssl: options.ssl ? 'require' : undefined,
    // Postgres enums and numerics arrive as strings; the schema's $type<> mappings
    // and explicit casts in queries handle conversion where it matters.
    prepare: false,
    onnotice: () => {},
  });

  const db = drizzle(client, { schema, casing: 'snake_case' });

  return {
    db,
    client,
    async close(): Promise<void> {
      await client.end({ timeout: 5 });
    },
    /** Liveness probe used by /ready. */
    async ping(): Promise<boolean> {
      const result = await client`SELECT 1 AS ok`;
      return result[0]?.ok === 1;
    },
  };
}

export { schema };
