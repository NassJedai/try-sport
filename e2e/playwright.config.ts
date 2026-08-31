import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { ADMIN_AUTH_FILE, ADMIN_URL, API_URL, BUSINESS_AUTH_FILE, BUSINESS_URL } from './lib/env';

/**
 * Filet de fumée des deux tableaux de bord web (`apps/business`,
 * `apps/admin`) — 8 à 12 tests, pas une couverture exhaustive. Voir
 * `TODO.md` (motif du 22 août) : ce filet existe parce que trois fois de
 * suite, une suite unitaire/intégration verte a cohabité avec un produit
 * cassé à l'écran ; il ferme ce trou-là précisément, pas plus.
 *
 * Racine du monorepo, pas `e2e/` : les trois commandes `webServer`
 * (`pnpm --filter …`) ont besoin du `pnpm-workspace.yaml` et du `.env`
 * racine pour résoudre leurs paquets et leur configuration.
 */
const REPO_ROOT = path.join(__dirname, '..');

export default defineConfig({
  testDir: './tests',
  // Explicite : `outputDir` se résout par défaut depuis le `cwd` du process
  // (`pnpm e2e`, lancé depuis la racine), pas depuis ce fichier de config —
  // contrairement à `testDir`/`globalSetup`. Sans ce chemin absolu, une
  // exécution laisse un `test-results/` à la racine du monorepo plutôt que
  // sous `e2e/` avec le reste des artefacts (voir `.gitignore`).
  outputDir: path.join(__dirname, 'test-results'),
  timeout: 30_000,
  expect: { timeout: 8_000 },
  // Un seul worker : ce filet a besoin d'un ordre déterministe entre les
  // personas (le gérant modifie une offre avant que l'admin ne vérifie
  // l'alerte, voir `business-offers.spec.ts` / `admin-alerts.spec.ts`) et
  // partage un budget de rate-limit OTP très serré (5 requêtes / 15 min par
  // IP, en mémoire côté API) — la vitesse d'une exécution parallèle ne vaut
  // pas le risque de griller ce budget ou de casser l'ordre.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  globalSetup: require.resolve('./global-setup'),
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 900 },
  },
  // `reuseExistingServer: true` inconditionnellement (pas seulement hors CI) :
  // la consigne de la mission est de cohabiter avec un `pnpm dev` déjà lancé
  // en local, jamais de risquer un second process sur le même port.
  webServer: [
    {
      name: 'api',
      command: 'pnpm --filter @try/api dev',
      cwd: REPO_ROOT,
      url: `${API_URL}/health`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      name: 'business',
      command: 'pnpm --filter @try/business dev',
      cwd: REPO_ROOT,
      url: BUSINESS_URL,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      name: 'admin',
      command: 'pnpm --filter @try/admin dev',
      cwd: REPO_ROOT,
      url: ADMIN_URL,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: 'business-setup',
      testMatch: /business\.setup\.ts/,
    },
    {
      name: 'admin-setup',
      testMatch: /admin\.setup\.ts/,
    },
    {
      name: 'business',
      testMatch: /business-offers\.spec\.ts/,
      dependencies: ['business-setup'],
      use: { storageState: BUSINESS_AUTH_FILE },
    },
    {
      name: 'admin',
      testMatch: /admin-.*\.spec\.ts/,
      // Dépend aussi de `business`, pas seulement de `admin-setup` : c'est ce
      // qui garantit que le changement de titre que ce projet vérifie a déjà
      // eu lieu avant que le premier test admin ne démarre.
      dependencies: ['admin-setup', 'business'],
      use: { storageState: ADMIN_AUTH_FILE },
    },
  ],
});
