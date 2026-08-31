import { expect, test } from '@playwright/test';
import { ADMIN_URL } from '../lib/env';

/**
 * Filet de fumée générique : deux écrans que l'équipe TRIALYA ouvre au
 * quotidien (modération, paiements) doivent se charger sans lever d'erreur
 * console — le signal le plus simple d'un écran qui a pris du retard sur son
 * API sans que ça se voie visuellement (les deux surfaces citées dans la
 * mission).
 */
test('modération et paiements se chargent sans erreur console', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto(`${ADMIN_URL}/moderation`);
  await expect(page.getByRole('heading', { name: 'Modération' })).toBeVisible();

  await page.goto(`${ADMIN_URL}/payments`);
  await expect(page.getByRole('heading', { name: 'Paiements' })).toBeVisible();
  // Le tableau doit avoir fini de charger (« Chargement… » disparu), sinon
  // une requête encore en vol pourrait produire une erreur après l'assertion
  // ci-dessous plutôt qu'avant.
  await expect(page.getByText('Chargement…')).toHaveCount(0);

  expect(consoleErrors, `Erreurs console :\n${consoleErrors.join('\n')}`).toEqual([]);
});
