import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ADMIN_URL, EDIT_STATE_FILE } from '../lib/env';

/**
 * LE test anti-« l'écran ne sait pas demander » : la traversée qui avait
 * manqué au projet jusqu'au 2026-08-28 (`ModerationLifecycleListener` insérait
 * déjà une notification `OFFER_MODERATED_FIELDS_CHANGED` à chaque écriture
 * `NOTIFY_ADMIN`, mais aucun écran ne la rendait visible — voir
 * `apps/admin/app/notifications/page.tsx`).
 *
 * Dépend du projet `business` en entier (`playwright.config.ts`) : lit le
 * pont écrit par `business-offers.spec.ts` (« modifier une offre en ligne… »)
 * plutôt que de refaire l'édition ici — un admin qui voit une alerte doit
 * voir *le même* changement que celui que le gérant vient de faire, pas une
 * simulation locale à l'écran admin.
 */
test('les alertes affichent le changement de titre avant → après', async ({ page }) => {
  const { oldTitle, newTitle } = JSON.parse(readFileSync(EDIT_STATE_FILE, 'utf-8')) as {
    oldTitle: string;
    newTitle: string;
  };

  await page.goto(`${ADMIN_URL}/notifications`);
  await expect(page.getByRole('heading', { name: 'Alertes' })).toBeVisible();

  // `newTitle` porte le suffixe généré par le test business (« (édité e2e) »)
  // — assez unique pour identifier une seule ligne, sans dépendre de l'ordre
  // ou du nombre d'alertes déjà présentes.
  const alert = page.locator('li').filter({ hasText: newTitle });
  await expect(alert).toBeVisible();

  // Le corps de l'alerte (`ModerationLifecycleListener.alertAdminOfOfferModeratedFieldsChange`)
  // porte l'ancienne et la nouvelle valeur sur la même ligne : « Titre de
  // l’offre : « ancien » → « nouveau » ». Les trois assertions, ensemble,
  // vérifient que c'est bien un diff avant → après et pas une coïncidence de
  // texte.
  await expect(alert).toContainText(oldTitle);
  await expect(alert).toContainText(newTitle);
  await expect(alert).toContainText('→');
});
