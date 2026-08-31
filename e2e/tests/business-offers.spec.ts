import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { authorizedGet } from '../lib/api';
import { expectAllButtonsHaveAccessibleName } from '../lib/accessibility';
import { ACCESS_TOKEN_STORAGE_KEYS, BUSINESS_URL, EDIT_STATE_FILE } from '../lib/env';

/**
 * Le parcours gérant, en surface : la page « Offres & planning »
 * (`apps/business/app/offers/page.tsx`) et le panneau d'édition
 * (`OfferEditForm`) d'une offre déjà en ligne — la dernière impasse comblée le
 * 2026-08-28 (gel → notification admin, voir `editable-fields.ts`).
 *
 * Chaque test cible une offre différente de « Move Collective »
 * (`business@try.local`, seed `packages/database/src/scripts/seed-data.ts`) :
 * Pilates Reformer (payante, pour l'édition de titre), Renforcement express
 * (payante, pour la validation de prix), Vinyasa Flow (gratuite avec prix
 * barré, pour le test qui protège ce prix barré), Cycling (pour
 * l'accessibilité). Aucun des quatre tests ne dépend donc d'un autre pour
 * choisir sa cible — seul le test 1 (liste + prix formatés) doit s'exécuter
 * avant qu'un titre ne soit modifié, ce que l'ordre par défaut de Playwright
 * (tests d'un même fichier exécutés dans l'ordre d'écriture, un seul worker
 * par fichier) garantit déjà.
 *
 * Titres identifiés par sous-chaîne plutôt que texte exact partout où c'est
 * possible : la consigne de la mission est de ne pas dépendre d'un titre
 * exact « susceptible de changer », mais ces quatre offres du seed sont des
 * fixtures stables, rejouées par `global-setup.ts` avant chaque exécution —
 * s'appuyer sur elles n'est pas la même chose que s'appuyer sur un état
 * laissé par une session manuelle précédente.
 */

test('la liste des offres affiche des prix formatés', async ({ page }) => {
  await page.goto(`${BUSINESS_URL}/offers`);
  await expect(page.getByRole('heading', { name: 'Offres & planning' })).toBeVisible();

  // 1000 unités mineures EUR -> « 10,00 € » (`formatMoney`, `@try/utils`) —
  // jamais un calcul flottant dans le composant, jamais les centimes bruts.
  const paidOffer = page.locator('li').filter({ hasText: 'Pilates Reformer — Première séance' });
  await expect(paidOffer).toContainText(/10,00\s*€/);

  // Une offre à `priceAmount: 0` affiche le mot « gratuit », pas « 0,00 € ».
  const freeOffer = page.locator('li').filter({ hasText: 'Vinyasa Flow — Cours découverte' });
  await expect(freeOffer).toContainText('gratuit');
});

test('modifier une offre en ligne : bandeau, titre, mise à jour de la liste', async ({ page }) => {
  await page.goto(`${BUSINESS_URL}/offers`);

  const card = page.locator('li').filter({ hasText: 'Pilates Reformer — Première séance' });
  await expect(card).toBeVisible();
  const oldTitle = (await card.locator('h3').innerText()).trim();

  await card.getByRole('button', { name: 'Modifier' }).click();

  // Offre `ACTIVE` : le champ `title` est `MODERATED` mais l'édition est
  // désormais `NOTIFY_ADMIN` (desserrage du 2026-08-28) — le bandeau doit le
  // dire, pas juste laisser passer silencieusement.
  await expect(
    page.getByRole('status').filter({ hasText: 'signalé à l’équipe TRIALYA' }),
  ).toBeVisible();

  const newTitle = `${oldTitle} (édité e2e)`;
  await page.getByLabel('Titre de l’offre').fill(newTitle);
  await page.getByRole('button', { name: 'Enregistrer les modifications' }).click();

  // Le panneau se ferme après succès (`onSaved` → `setEditingOfferId(null)`
  // dans `OffersPage`) et la liste est invalidée : le nouveau titre doit
  // apparaître, l'ancien doit avoir disparu. `exact: true` : la section
  // Photos plus bas rend un `<h3>` « Offre « {titre} » » par offre, qui
  // matcherait aussi `newTitle` en recherche par sous-chaîne.
  await expect(page.getByRole('heading', { name: newTitle, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: oldTitle, exact: true })).toHaveCount(0);

  // Pont vers `admin-alerts.spec.ts` (projet `admin`, qui ne démarre
  // qu'après le projet `business` en entier — voir `playwright.config.ts`) :
  // un fichier plutôt qu'un état en mémoire, les deux projets ne partagent
  // pas nécessairement le même process Node.
  writeFileSync(EDIT_STATE_FILE, JSON.stringify({ oldTitle, newTitle }), 'utf-8');
});

test('un prix invalide affiche un message et bloque l’enregistrement', async ({ page }) => {
  await page.goto(`${BUSINESS_URL}/offers`);

  const card = page.locator('li').filter({ hasText: 'Renforcement express — 30 minutes' });
  await card.getByRole('button', { name: 'Modifier' }).click();

  // La même saisie citée dans la mission : l'ancienne heuristique
  // (`Number(price.replace(',', '.')) > 0`) ne remplaçait que la première
  // virgule et grisait le bouton sans un mot d'explication
  // (`price-field.ts`, commentaire de tête).
  await page.getByLabel(/Prix découverte/).fill('1,234,50');

  await expect(
    page.getByText('Le prix doit être un nombre valide, par exemple 8 ou 8,50.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enregistrer les modifications' })).toBeDisabled();
});

test('une offre gratuite éditée ne perd pas son prix barré (vérifié par l’API)', async ({
  page,
  request,
}) => {
  await page.goto(`${BUSINESS_URL}/offers`);

  const card = page.locator('li').filter({ hasText: 'Vinyasa Flow — Cours découverte' });
  await card.getByRole('button', { name: 'Modifier' }).click();

  // Offre gratuite : `isPaid` est faux, donc `OfferEditForm` ne rend même pas
  // le champ « Prix habituel » — la seule façon de perdre le prix barré en
  // le laissant intact à l'écran serait un bug d'enregistrement
  // (`referencePriceAmount: isPaid ? … : undefined`, voir le commentaire de
  // `handleSubmit`), invisible dans le DOM. D'où la vérification par API
  // plus bas plutôt qu'à l'écran.
  await expect(page.getByLabel(/Prix habituel/)).toHaveCount(0);

  const descriptionInput = page.getByLabel('Description');
  const newDescription = `${(await descriptionInput.inputValue()).trim()} (e2e)`;
  await descriptionInput.fill(newDescription);
  await page.getByRole('button', { name: 'Enregistrer les modifications' }).click();

  // Le panneau fermé (bouton disparu) est le signal que la sauvegarde a
  // réussi, avant d'aller vérifier l'effet côté serveur.
  await expect(page.getByRole('button', { name: 'Enregistrer les modifications' })).toHaveCount(0);

  const viewer = await authorizedGet<{ businessMemberships: { businessId: string }[] }>(
    page,
    request,
    '/v1/auth/me',
    ACCESS_TOKEN_STORAGE_KEYS.business,
  );
  const businessId = viewer.businessMemberships[0]?.businessId;
  if (!businessId) throw new Error('Le compte démo business@try.local n’a aucune adhésion.');

  const offers = await authorizedGet<{
    items: { title: string; priceAmount: number; referencePriceAmount: number | null }[];
  }>(page, request, `/v1/businesses/${businessId}/offers`, ACCESS_TOKEN_STORAGE_KEYS.business);

  const offer = offers.items.find((item) => item.title.startsWith('Vinyasa Flow'));
  if (!offer) throw new Error('Offre « Vinyasa Flow » introuvable après l’édition.');

  expect(offer.priceAmount).toBe(0);
  // La valeur brute du seed (`seed-data.ts`, `referencePrice: 2200`) — pas
  // `null`, ce que produirait le bug corrigé ci-dessus.
  expect(offer.referencePriceAmount).toBe(2200);
});

test('la page offres n’a pas de bouton sans nom accessible', async ({ page }) => {
  await page.goto(`${BUSINESS_URL}/offers`);
  await expect(page.getByRole('heading', { name: 'Offres & planning' })).toBeVisible();

  // La plupart des contrôles à risque (icônes seules dans `CapacityStepper`,
  // pastilles `PillToggle`) ne sont rendus qu'une fois un panneau d'édition
  // ouvert — on l'ouvre avant de vérifier, pour couvrir plus que la liste nue.
  const card = page.locator('li').filter({ hasText: 'Cycling — Première séance' });
  await card.getByRole('button', { name: 'Modifier' }).click();
  await expect(page.getByRole('button', { name: 'Enregistrer les modifications' })).toBeVisible();

  await expectAllButtonsHaveAccessibleName(page);
});
