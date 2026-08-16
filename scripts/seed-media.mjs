#!/usr/bin/env node
/**
 * Compatibilité : `node scripts/seed-media.mjs` depuis la racine du dépôt.
 *
 * La génération vit désormais dans `packages/database/src/scripts/seed-media.ts`
 * (en TypeScript, lu via `tsx`), pour deux raisons :
 *   1. `seed.ts` l'appelle directement en fin de course — un `pnpm db:seed` seul
 *      doit laisser le catalogue avec des images, pas dépendre d'un second
 *      script qu'on penserait à lancer.
 *   2. Cette ancienne version importait `../packages/database/dist/index.js` :
 *      sur un dépôt fraîchement cloné (ou après `pnpm clean`), ce fichier
 *      n'existe pas tant que `pnpm --filter @try/database build` n'a pas
 *      tourné — un piège silencieux (`Cannot find module`) plutôt qu'une
 *      erreur parlante. `tsx` lit le code source directement, aucun build
 *      requis.
 *
 * Ce fichier reste comme point d'entrée pour qui tape encore la commande de
 * mémoire ; il délègue à `pnpm --filter @try/database seed:media`, utile pour
 * compléter un catalogue déjà peuplé (nouvelle offre publiée depuis, gérant
 * qui n'a pas encore uploadé) sans repasser par un `pnpm db:seed` complet.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const result = spawnSync('pnpm', ['--filter', '@try/database', 'run', 'seed:media'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error('Impossible de lancer pnpm --filter @try/database seed:media :', result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
