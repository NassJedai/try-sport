import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

/**
 * Integration tests that require a real Postgres with PostGIS.
 *
 * Kept in a separate config so `pnpm test` stays fast and hermetic. These suites
 * skip themselves with an explicit message when no database URL is configured
 * rather than silently passing — a green tick that proved nothing is worse than
 * a skip.
 *
 * MAIS UN SKIP QUI SE DÉCLENCHE PAR OUBLI EST EXACTEMENT CE GREEN TICK. Vitest
 * ne charge pas `.env` dans `process.env` : jusqu'au 22 août 2026,
 * `pnpm test:integration` — la commande documentée dans CLAUDE.md — sautait donc
 * la totalité de la suite et sortait en code 0 sur une machine pourtant
 * correctement configurée, base démarrée comprise. Mesuré : « 3 tests skipped »,
 * code de sortie 0. Un relecteur s'y est fait prendre le jour même et a conclu
 * qu'un lot n'avait aucune couverture, alors qu'il en avait.
 *
 * `.env` est donc lu ici explicitement. L'ordre de résolution laisse toujours le
 * dernier mot à l'appelant : une variable posée sur la ligne de commande gagne
 * sur `.env`, jamais l'inverse. Le skip reste possible — une CI sans base doit
 * pouvoir sauter — mais il ne se déclenche plus par distraction.
 */
const dotenv = loadEnv('test', process.cwd(), '');
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  dotenv.TEST_DATABASE_URL ??
  dotenv.DATABASE_URL;

export default defineConfig({
  test: {
    include: ['**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    env: databaseUrl ? { TEST_DATABASE_URL: databaseUrl } : {},
    // Booking concurrency tests contend on the same rows on purpose.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
