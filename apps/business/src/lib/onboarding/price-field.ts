import { parseDecimalToMinor, type CurrencyCode } from '@try/utils';

/**
 * Validation d'un champ de prix saisi en texte — extraite de `OfferEditForm`
 * pour être testable sans DOM, et pour qu'il n'existe qu'un seul endroit qui
 * décide ce qu'est un prix valide.
 *
 * `parseDecimalToMinor` est la seule autorité : l'ancienne heuristique
 * (`Number(price.replace(',', '.')) > 0`) ne remplaçait qu'une seule virgule et
 * laissait passer silencieusement une saisie comme « 1,234,50 » — le bouton
 * restait grisé sans qu'aucun message n'explique pourquoi. Ici, toute saisie
 * que `parseDecimalToMinor` rejette produit un message affiché sous le champ.
 *
 * Un blocage muet subsiste, et c'est un choix assumé plutôt qu'un oubli : un
 * champ vide ne produit ni montant ni erreur (voir plus bas) — le bouton reste
 * inactif sans message, parce qu'un champ que le gérant n'a pas encore
 * commencé à remplir n'est pas une faute à lui signaler.
 */

export const PRICE_INVALID_FORMAT_MESSAGE = 'Le prix doit être un nombre valide, par exemple 8 ou 8,50.';
export const PRICE_NOT_POSITIVE_MESSAGE = 'Le prix doit être strictement supérieur à 0.';

export interface PriceFieldValidation {
  /** Le montant en unités mineures si la saisie est exploitable, `null` sinon. */
  readonly amount: number | null;
  /** Le message à afficher sous le champ, `null` si rien à signaler. */
  readonly error: string | null;
}

/**
 * Un prix facultatif — le prix habituel (« prix barré »). Une saisie vide est
 * un choix valide (« pas de prix barré »), pas une erreur : elle ne produit ni
 * montant ni message.
 */
export function validateOptionalPriceField(input: string, currency: CurrencyCode): PriceFieldValidation {
  if (input.trim() === '') return { amount: null, error: null };
  try {
    return { amount: parseDecimalToMinor(input, currency).amount, error: null };
  } catch {
    return { amount: null, error: PRICE_INVALID_FORMAT_MESSAGE };
  }
}

/**
 * Un prix requis et strictement positif — le prix découverte d'une offre
 * payante. `0` n'est pas une erreur de format, mais il n'est pas accepté non
 * plus : c'est la valeur réservée au gratuit, une offre « Payante » doit
 * afficher un montant qui compte.
 *
 * Une saisie vide n'est volontairement pas une erreur ici : c'est l'état avant
 * que le gérant n'ait tapé quoi que ce soit, pas une faute à signaler. Elle ne
 * produit simplement pas de montant, donc pas de soumission possible.
 */
export function validateRequiredPositivePriceField(
  input: string,
  currency: CurrencyCode,
): PriceFieldValidation {
  if (input.trim() === '') return { amount: null, error: null };
  try {
    const amount = parseDecimalToMinor(input, currency).amount;
    if (amount <= 0) return { amount: null, error: PRICE_NOT_POSITIVE_MESSAGE };
    return { amount, error: null };
  } catch {
    return { amount: null, error: PRICE_INVALID_FORMAT_MESSAGE };
  }
}

/**
 * « Un de ces champs de montant a-t-il une erreur ? » — la vérification que
 * `canSubmit` doit faire porter sur *tous* les champs de montant d'un
 * formulaire, pas seulement sur celui qui est requis.
 *
 * Root cause d'un bug constaté sur `OfferEditForm` : `canSubmit` n'y
 * consultait que `priceValidation` (le prix découverte, requis) et ignorait
 * `referencePriceValidation.error` (le prix habituel, facultatif). Une saisie
 * illisible comme « 1,234,50 » dans le prix habituel laissait alors
 * `referencePriceValidation.amount` à `null` — la même valeur qu'une saisie
 * vide, qui *veut dire* « pas de prix barré » — et le bouton restait actif :
 * enregistrer envoyait `referencePriceAmount: null`, effaçant en silence un
 * prix barré déjà en base sans que le gérant l'ait demandé. `null` en sortie
 * ne dit pas s'il vient d'un champ vide (valide) ou d'un champ en erreur
 * (jamais soumissible) — c'est `.error`, pas `.amount`, qui porte cette
 * distinction, d'où cette fonction plutôt qu'une nouvelle comparaison à
 * `null`.
 *
 * Prend un nombre variable de validations à dessein : un futur champ de
 * montant sur ce formulaire (ou un autre) s'ajoute à l'appel plutôt que
 * d'ouvrir une nouvelle condition à recopier.
 */
export function anyPriceFieldHasError(...validations: readonly PriceFieldValidation[]): boolean {
  return validations.some((validation) => validation.error !== null);
}
