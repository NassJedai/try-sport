import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Applies every pending migration, in order, exactly once.
 *
 * Both drizzle-generated and hand-written migrations run through this single
 * path: the hand-written PostGIS and search files are registered in
 * `drizzle/meta/_journal.json`, so there is one mechanism and one ledger
 * (`__drizzle_migrations`) rather than two that can disagree.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'DATABASE_URL is not set. Point it at a Postgres instance with the PostGIS extension available.',
    );
    process.exit(1);
  }

  const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

  // A single connection: running migrations over a pool risks two workers racing.
  const client = postgres(url, { max: 1, onnotice: () => {} });

  try {
    console.log(`Applying migrations from ${migrationsFolder}`);
    await migrate(drizzle(client), { migrationsFolder });
    console.log('Migrations applied.');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

void main();
