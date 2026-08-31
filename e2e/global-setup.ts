import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AUTH_DIR } from './lib/env';

const REPO_ROOT = path.join(__dirname, '..');

/**
 * Rejoue le seed avant toute chose, pour que ce filet ne dépende jamais d'un
 * titre d'offre ou d'un statut laissé par une session manuelle précédente
 * (voir la consigne de la mission : « ne pas dépendre de titres exacts
 * susceptibles de changer »). Le seed (`packages/database/src/scripts/seed.ts`)
 * est idempotent (TRUNCATE ... RESTART IDENTITY CASCADE) et refuse déjà de
 * tourner sur une base qui ressemble à de la production
 * (`assertNotProduction`, sur `DATABASE_URL` et `NODE_ENV`/`APP_ENV`) — ce
 * garde-fou n'est pas dupliqué ici, on s'appuie dessus plutôt que de le
 * réécrire.
 *
 * `pnpm --filter @try/database seed` charge lui-même le `.env` racine
 * (`tsx --env-file-if-exists=../../.env`), donc `DATABASE_URL` n'a pas besoin
 * d'être répété ici — exécuté avec `cwd` à la racine du monorepo pour que le
 * filtre pnpm résolve le bon paquet.
 */
export default async function globalSetup(): Promise<void> {
  mkdirSync(AUTH_DIR, { recursive: true });

  execSync('pnpm --filter @try/database seed', {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}
