import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are versioned SQL files checked into the repo. The database is never
 * changed by hand and `drizzle-kit push` is not used outside a throwaway local
 * database: every environment must be reachable by replaying the same files.
 */
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  casing: 'snake_case',
  verbose: true,
  strict: true,
});
