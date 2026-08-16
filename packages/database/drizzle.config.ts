import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are versioned SQL files checked into the repo. The database is never
 * changed by hand and `drizzle-kit push` is not used outside a throwaway local
 * database: every environment must be reachable by replaying the same files.
 */

/**
 * The repo's `.env` is loaded here rather than assumed to be exported.
 *
 * `migrate` and `seed` get it from `--env-file-if-exists`, but drizzle-kit runs
 * this config itself and never sees those flags — so without this, `generate`
 * and `studio` were the two commands that still failed on a fresh shell with an
 * error naming a variable the developer had already filled in.
 *
 * Silent when the file is absent: CI and deployed environments supply real
 * variables, and a missing local file is not an error there.
 */
const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

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
