import path from 'node:path';

/**
 * Adresses des trois serveurs que ce filet exerce — surchargeables par
 * variable d'env, mais alignées par défaut sur les ports standards du dépôt
 * (`CLAUDE.md` : api :3000, business :3001, admin :3002) puisque le cas
 * normal est de réutiliser des serveurs de dev déjà démarrés
 * (`reuseExistingServer: true` dans `playwright.config.ts`).
 */
export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';
export const BUSINESS_URL = process.env.E2E_BUSINESS_URL ?? 'http://localhost:3001';
export const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'http://localhost:3002';

/**
 * Comptes de démo du seed (`packages/database/src/scripts/seed.ts`,
 * `DEMO_ACCOUNTS`) — `business@try.local` est OWNER de « Move Collective »,
 * `admin@try.local` est SUPER_ADMIN. Le seed est rejoué par `global-setup.ts`
 * avant toute chose : ces comptes existent donc toujours à ce nom quand les
 * tests démarrent.
 */
export const DEMO_ACCOUNTS = {
  business: 'business@try.local',
  admin: 'admin@try.local',
} as const;

/**
 * Où vivent les artefacts produits par une exécution — état d'authentification
 * du navigateur (jetons réels, jamais commités : voir `.gitignore`) et le
 * petit pont entre le test 01 (business, qui édite un titre) et le test 02
 * (admin, qui doit vérifier ce même changement dans une alerte). Un fichier
 * plutôt qu'une variable de module : `dependencies` dans `playwright.config.ts`
 * ne garantit l'ordre d'exécution entre projets, pas le partage d'un
 * processus Node — un état en mémoire entre fichiers de test serait fragile.
 */
export const AUTH_DIR = path.join(__dirname, '..', '.auth');
export const BUSINESS_AUTH_FILE = path.join(AUTH_DIR, 'business.json');
export const ADMIN_AUTH_FILE = path.join(AUTH_DIR, 'admin.json');
export const EDIT_STATE_FILE = path.join(AUTH_DIR, 'edit-state.json');

/**
 * Les clés `localStorage` sous lesquelles `BrowserTokenStore`
 * (`apps/business/src/lib/api.ts`, `apps/admin/src/lib/api.ts`) range le jeton
 * d'accès — une par origine. Utile pour un test qui a besoin d'appeler l'API
 * directement (voir `lib/api.ts`, `authorizedGet`) sans dupliquer la logique de
 * connexion : on relit le jeton posé par le vrai formulaire de connexion, on
 * n'en fabrique jamais un.
 */
export const ACCESS_TOKEN_STORAGE_KEYS = {
  business: 'try.business.accessToken',
  admin: 'try.admin.accessToken',
} as const;
