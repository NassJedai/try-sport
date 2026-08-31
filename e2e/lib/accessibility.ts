import { expect, type Page } from '@playwright/test';

/**
 * Filet minimal, pas un audit complet : vérifie qu'aucun bouton visible de la
 * page n'a un nom accessible vide — le symptôme le plus fréquent et le plus
 * gênant (un lecteur d'écran annonce juste « bouton », sans dire lequel).
 *
 * Volontairement sans `axe-core` ni aucun autre paquet d'audit : la seule
 * dépendance de test autorisée cette semaine est Playwright lui-même. Ceci
 * s'appuie sur le calcul de nom accessible déjà intégré au matcher
 * `toHaveAccessibleName` (moteur d'accessibilité de Chromium, pas une
 * réimplémentation maison) plutôt que sur un paquet de plus.
 */
export async function expectAllButtonsHaveAccessibleName(page: Page): Promise<void> {
  const buttons = page.getByRole('button');
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    await expect(buttons.nth(i), `Le bouton #${i} n'a pas de nom accessible`).toHaveAccessibleName(/\S/);
  }
}
