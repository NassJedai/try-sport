import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads .env files for local development.
 *
 * Deliberately dependency-free and deliberately *non-overriding*: a variable
 * already present in the real environment always wins. In staging and production
 * configuration comes from the platform's secret store, and a stray .env file
 * checked out on a server must never be able to silently replace it.
 *
 * Files are read from the monorepo root as well as the app directory, because the
 * README tells people to run `cp .env.example .env` once, at the root.
 *
 * Must be called before `NestFactory.create`, which is when the CONFIG factory
 * runs and validation happens.
 */
export function loadEnvFiles(): void {
  // `__dirname` rather than import.meta: this app compiles to CommonJS.
  // At runtime this file is dist/common/, so the app root is two levels up.
  const appRoot = resolve(__dirname, '..', '..');

  const candidates = [
    resolve(appRoot, '..', '..', '.env'), // monorepo root
    resolve(appRoot, '.env'), // apps/api/.env, for per-app overrides
  ];

  for (const path of candidates) {
    if (existsSync(path)) applyEnvFile(path);
  }
}

function applyEnvFile(path: string): void {
  const contents = readFileSync(path, 'utf8');

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (!key) continue;

    let value = line.slice(separator + 1).trim();

    const isQuoted =
      value.length > 1 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));

    if (isQuoted) {
      // Quoted values are taken literally, so `PASSWORD="a#b"` keeps its hash.
      value = value.slice(1, -1);
    } else {
      /**
       * Strip trailing inline comments from unquoted values. .env.example
       * documents each variable inline (`APP_ENV=local  # local | staging | …`),
       * and without this the whole comment becomes part of the value — which
       * fails enum validation and stops the API booting with a valid .env in place.
       */
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trim();
    }

    // Never override what the platform already provided.
    process.env[key] ??= value;
  }
}
