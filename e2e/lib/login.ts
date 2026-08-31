import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { readLastOtp } from './dev-otp';

/**
 * Pilote le vrai écran de connexion (`/sign-in`, identique dans sa structure
 * pour `apps/business` et `apps/admin`) de bout en bout : saisit l'e-mail,
 * clique « Recevoir mon code » (c'est CE clic, et lui seul, qui consomme la
 * requête `otp/request`), relit le code par l'endpoint dev-only plutôt que de
 * gratter les logs, le saisit, clique « Se connecter », et attend le tableau
 * de bord. Voir `lib/dev-otp.ts` pour la garde qui rend cette lecture inerte
 * hors développement local.
 */
export async function signInWithOtp(
  page: Page,
  request: APIRequestContext,
  baseUrl: string,
  email: string,
): Promise<void> {
  await page.goto(`${baseUrl}/sign-in`);

  await page.locator('#email').fill(email);
  await page.getByRole('button', { name: /recevoir mon code/i }).click();

  const codeInput = page.locator('#code');
  await expect(codeInput).toBeVisible();

  const code = await readLastOtp(request, email);
  await codeInput.fill(code);
  await page.getByRole('button', { name: /se connecter/i }).click();

  await page.waitForURL(`${baseUrl}/`);
}
