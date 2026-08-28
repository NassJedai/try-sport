import { describe, expect, it } from 'vitest';
import { parseDecimalToMinor, toDecimalString } from '@try/utils';
import {
  PRICE_INVALID_FORMAT_MESSAGE,
  PRICE_NOT_POSITIVE_MESSAGE,
  anyPriceFieldHasError,
  validateOptionalPriceField,
  validateRequiredPositivePriceField,
} from './price-field';

/**
 * Premier fichier de test d'`apps/business`. Ciblé sur la conversion d'argent
 * du formulaire d'édition d'offre (`OfferEditForm`) : c'est la seule logique
 * de ce dépôt frontend qui manipule des montants avant de les envoyer au
 * serveur, et un bug ici reprice une offre en silence.
 */

describe('validateRequiredPositivePriceField', () => {
  it('accepte un entier', () => {
    expect(validateRequiredPositivePriceField('25', 'EUR')).toEqual({ amount: 2500, error: null });
  });

  it('accepte une virgule décimale', () => {
    expect(validateRequiredPositivePriceField('25,50', 'EUR')).toEqual({ amount: 2550, error: null });
  });

  it('rejette une saisie à virgules multiples avec un message lisible, plutôt que de ne lire que la première', () => {
    // L'ancienne heuristique (`Number(price.replace(',', '.'))`) ne remplaçait
    // que la première virgule : "1,234,50" devenait "1.234,50", que `Number()`
    // évalue à `NaN`... mais `NaN > 0` est `false` sans lever d'erreur, donc le
    // bouton se grisait sans un mot d'explication. Ici, l'échec est explicite.
    const result = validateRequiredPositivePriceField('1,234,50', 'EUR');
    expect(result.amount).toBeNull();
    expect(result.error).toBe(PRICE_INVALID_FORMAT_MESSAGE);
  });

  it('refuse 0 : réservé au gratuit, une offre payante doit avoir un prix qui compte', () => {
    const result = validateRequiredPositivePriceField('0', 'EUR');
    expect(result.amount).toBeNull();
    expect(result.error).toBe(PRICE_NOT_POSITIVE_MESSAGE);
  });

  it('un champ vide ne produit ni montant ni erreur — état initial, pas une faute', () => {
    expect(validateRequiredPositivePriceField('', 'EUR')).toEqual({ amount: null, error: null });
    expect(validateRequiredPositivePriceField('   ', 'EUR')).toEqual({ amount: null, error: null });
  });

  it('rejette un texte qui ne ressemble pas à un nombre', () => {
    const result = validateRequiredPositivePriceField('vingt-cinq', 'EUR');
    expect(result.amount).toBeNull();
    expect(result.error).toBe(PRICE_INVALID_FORMAT_MESSAGE);
  });

  it('rejette plus de décimales que la devise n’en supporte', () => {
    const result = validateRequiredPositivePriceField('25,505', 'EUR');
    expect(result.amount).toBeNull();
    expect(result.error).toBe(PRICE_INVALID_FORMAT_MESSAGE);
  });
});

describe('validateOptionalPriceField', () => {
  it('un champ vide est un choix valide : pas de prix barré', () => {
    expect(validateOptionalPriceField('', 'EUR')).toEqual({ amount: null, error: null });
  });

  it('accepte 0 — contrairement au prix découverte, aucune règle produit ne l’interdit ici', () => {
    expect(validateOptionalPriceField('0', 'EUR')).toEqual({ amount: 0, error: null });
  });

  it('rejette une saisie non convertible avec un message, jamais silencieusement', () => {
    const result = validateOptionalPriceField('1,234,50', 'EUR');
    expect(result.amount).toBeNull();
    expect(result.error).toBe(PRICE_INVALID_FORMAT_MESSAGE);
  });
});

describe('anyPriceFieldHasError', () => {
  // Le scénario démontré sur `OfferEditForm` : le prix découverte est valide,
  // mais le prix habituel (facultatif) contient une saisie illisible.
  // `referencePriceValidation.amount` vaut `null` — la même valeur qu'un
  // champ vide — et seul `.error` distingue les deux. Avant ce correctif,
  // `canSubmit` ne regardait que la validation du prix découverte et laissait
  // passer la soumission, envoyant `referencePriceAmount: null` et effaçant
  // le prix barré enregistré sans que personne ne l'ait demandé.
  it('détecte une erreur sur le prix habituel même quand le prix découverte est valide', () => {
    const price = validateRequiredPositivePriceField('10', 'EUR');
    const referencePrice = validateOptionalPriceField('1,234,50', 'EUR');
    expect(referencePrice.amount).toBeNull(); // même valeur qu'un champ vide…
    expect(referencePrice.error).toBe(PRICE_INVALID_FORMAT_MESSAGE); // … mais pas la même erreur
    expect(anyPriceFieldHasError(price, referencePrice)).toBe(true);
  });

  it('ne bloque rien quand tous les champs de montant sont valides, vides compris', () => {
    const price = validateRequiredPositivePriceField('10', 'EUR');
    const referencePrice = validateOptionalPriceField('', 'EUR');
    expect(anyPriceFieldHasError(price, referencePrice)).toBe(false);
  });

  it('détecte une erreur sur le prix découverte lui-même', () => {
    const price = validateRequiredPositivePriceField('0', 'EUR');
    const referencePrice = validateOptionalPriceField('15', 'EUR');
    expect(anyPriceFieldHasError(price, referencePrice)).toBe(true);
  });
});

describe('aller-retour hydratation → soumission (toDecimalString → parseDecimalToMinor)', () => {
  // `OfferEditForm` hydrate le champ prix avec `toDecimalString(detail.price)`
  // puis, à la soumission, reconvertit la saisie avec `parseDecimalToMinor`
  // (via `validateRequiredPositivePriceField`). Si un gérant rouvre le
  // formulaire et l'enregistre sans rien changer, le montant qui repart doit
  // être exactement celui qui est arrivé — jamais un centime de dérive.
  it.each([
    [0, 'EUR'],
    [2500, 'EUR'],
    [2550, 'EUR'],
    [1, 'EUR'],
    [999999, 'USD'],
  ] as const)('%i minor units en %s survit à l’aller-retour', (amount, currency) => {
    const hydrated = toDecimalString({ amount, currency });
    const reparsed = parseDecimalToMinor(hydrated, currency);
    expect(reparsed.amount).toBe(amount);

    const viaValidator = validateOptionalPriceField(hydrated, currency);
    expect(viaValidator.amount).toBe(amount);
  });
});
