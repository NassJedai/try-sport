import { defineConfig } from 'vitest/config';

/**
 * One Vitest process for the whole workspace.
 *
 * Running a separate Vitest per package under Turbo spawns a worker pool per
 * package at once, which oversubscribes the machine and kills workers mid-run.
 * Projects give the same isolation with a single scheduler.
 *
 * `apps/*` is matched by glob so a new app is picked up without editing this file.
 */
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    // Integration suites talk to a real database and are opt-in; see test:integration.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', '**/*.integration.test.ts'],
  },
});
