import type { APIRequestContext, Page } from '@playwright/test';
import { API_URL } from './env';

/**
 * Un appel API authentifié, pour les assertions que l'écran ne peut pas
 * prouver lui-même — ex. « le prix barré est toujours en base après
 * l'enregistrement », qui ne se lit nulle part dans le DOM de
 * `OfferEditForm` une fois l'offre gratuite (le champ n'est même pas rendu).
 *
 * Relit le jeton d'accès posé par `BrowserTokenStore` dans le `localStorage`
 * de la page déjà connectée (voir `ACCESS_TOKEN_STORAGE_KEYS`) plutôt que de
 * refaire un flux OTP ou de fabriquer un jeton : `request` (le contexte API de
 * Playwright) ne partage pas les cookies/localStorage de `page`, donc les deux
 * doivent être passés explicitement.
 */
export async function authorizedGet<T>(
  page: Page,
  request: APIRequestContext,
  path: string,
  tokenStorageKey: string,
): Promise<T> {
  const token = await page.evaluate((key) => window.localStorage.getItem(key), tokenStorageKey);
  if (!token) {
    throw new Error(
      `Aucun accessToken sous "${tokenStorageKey}" dans le localStorage de la page — la session est-elle active ?`,
    );
  }

  const response = await request.get(`${API_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok()) {
    throw new Error(`GET ${path} a échoué (${response.status()}) : ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}
