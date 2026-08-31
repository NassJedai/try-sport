import { test } from '@playwright/test';
import { BUSINESS_AUTH_FILE, BUSINESS_URL, DEMO_ACCOUNTS } from '../lib/env';
import { signInWithOtp } from '../lib/login';

/**
 * Connexion réelle du gérant démo (`business@try.local`, OWNER de « Move
 * Collective » — voir le seed), sauvegardée une fois pour tous les tests du
 * projet `business` (`use.storageState`, `playwright.config.ts`). Évite de
 * repasser par le flux OTP à chaque fichier de test : le budget de
 * `otp/request` est de 5 requêtes / 15 min par IP (voir la mémoire d'agent
 * sur ce piège), et une connexion par test l'aurait vite épuisé.
 */
test('le gérant se connecte', async ({ page, request }) => {
  await signInWithOtp(page, request, BUSINESS_URL, DEMO_ACCOUNTS.business);
  await page.context().storageState({ path: BUSINESS_AUTH_FILE });
});
