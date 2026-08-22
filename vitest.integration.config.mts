import { defineConfig } from 'vitest/config';

/**
 * Integration tests that require a real Postgres with PostGIS.
 *
 * Kept in a separate config so `pnpm test` stays fast and hermetic. These suites
 * skip themselves with an explicit message when DATABASE_URL is absent rather
 * than silently passing — a green tick that proved nothing is worse than a skip.
 */
export default defineConfig({
  test: {
    include: ['**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    // Booking concurrency tests contend on the same rows on purpose.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
