/**
 * Numéros de TVA intracommunautaire — Belgique, France, Espagne.
 *
 * Ces numéros finissent sur des factures. Un contrôle de structure seul laisse
 * passer des numéros inventés qui ressemblent à des vrais : les trois pays
 * supportés ont tous une clé de contrôle, et elle est vérifiée ici. Ce n'est pas
 * une vérification d'existence — seul VIES sait si un numéro est réellement
 * attribué et actif — mais une saisie fautive ou fantaisiste est refusée à
 * l'entrée plutôt que découverte à la facturation.
 *
 * La validation vit dans `contracts` et non dans l'API parce que trois
 * consommateurs en ont besoin : le formulaire d'inscription (valider avant
 * d'envoyer), l'API (refuser une valeur fausse) et la règle de complétude du
 * dossier (voir `venue-submission.ts`), qui exige une TVA *valide* et non
 * simplement présente.
 */

export const VAT_COUNTRIES = ['BE', 'FR', 'ES'] as const;
export type VatCountry = (typeof VAT_COUNTRIES)[number];

/** Longueur maximale acceptée en entrée, avant normalisation. */
export const VAT_NUMBER_MAX_INPUT_LENGTH = 30;

/**
 * Forme canonique : majuscules, préfixe pays, sans séparateur.
 *
 * Un gérant tape « BE 0123.456.749 » aussi souvent que « be0123456749 ». Tout ce
 * qui n'est ni chiffre ni lettre disparaît — espaces, points, tirets, barres
 * obliques — et le résultat est ce qui sera stocké.
 */
export function normaliseVatNumber(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Déduit le pays d'un numéro déjà normalisé.
 *
 * Le préfixe fait foi quand il est là. Sans préfixe, la longueur suffit à lever
 * l'ambiguïté entre les trois pays supportés — 10 chiffres commençant par 0 ou 1
 * en Belgique, 11 chiffres en France, 9 caractères dont une lettre en Espagne —
 * et un cas ambigu (9 chiffres, un SIREN sans sa clé) rend `null` plutôt qu'un
 * pays deviné.
 */
function inferCountry(normalised: string): { country: VatCountry; digits: string } | null {
  for (const country of VAT_COUNTRIES) {
    if (normalised.startsWith(country)) {
      return { country, digits: normalised.slice(2) };
    }
  }

  if (/^[01]\d{9}$/.test(normalised)) return { country: 'BE', digits: normalised };
  if (/^\d{11}$/.test(normalised)) return { country: 'FR', digits: normalised };
  if (/^(?=.*[A-Z])[0-9A-Z]{9}$/.test(normalised)) return { country: 'ES', digits: normalised };

  return null;
}

/**
 * Belgique — `BE` + 10 chiffres, le numéro d'entreprise de la BCE.
 *
 * Les deux derniers chiffres sont la clé : `97 - (huit premiers chiffres mod 97)`.
 * Le numéro commence par 0 ou 1, les seuls préfixes attribués.
 */
function isValidBelgianVat(digits: string): boolean {
  if (!/^[01]\d{9}$/.test(digits)) return false;

  const base = Number(digits.slice(0, 8));
  if (base === 0) return false;

  return 97 - (base % 97) === Number(digits.slice(8));
}

/**
 * France — `FR` + clé sur 2 chiffres + SIREN sur 9 chiffres.
 *
 * Deux contrôles indépendants : le SIREN satisfait Luhn, et la clé vaut
 * `(12 + 3 × (SIREN mod 97)) mod 97`.
 *
 * Les clés alphanumériques (numéros attribués aux entités sans SIREN) sont
 * refusées : rien ici ne peut les vérifier, et accepter sans vérifier revient à
 * ne pas valider du tout. Un tel cas passe par le support.
 */
function isValidFrenchVat(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false;

  const key = Number(digits.slice(0, 2));
  const siren = digits.slice(2);
  if (!satisfiesLuhn(siren)) return false;

  return (12 + 3 * (Number(siren) % 97)) % 97 === key;
}

function satisfiesLuhn(digits: string): boolean {
  let sum = 0;
  let doubled = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (doubled) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    doubled = !doubled;
  }

  return sum % 10 === 0;
}

/** Table de la lettre de contrôle du DNI/NIE espagnol, indexée par `n mod 23`. */
const ES_PERSON_CONTROL_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
/** Table de la lettre de contrôle du CIF, indexée par le chiffre de contrôle. */
const ES_ENTITY_CONTROL_LETTERS = 'JABCDEFGHI';
/** Préfixes de CIF valides pour un assujetti à la TVA. */
const ES_ENTITY_PREFIXES = 'ABCDEFGHJNPQRSUVW';
/** Ces formes juridiques ont toujours une lettre de contrôle… */
const ES_LETTER_CONTROL_ONLY = 'NPQRSW';
/** …et celles-là toujours un chiffre. Les autres acceptent les deux. */
const ES_DIGIT_CONTROL_ONLY = 'ABEH';

/**
 * Espagne — `ES` + 9 caractères, NIF de personne physique ou CIF de société.
 *
 * Trois formes coexistent et ont chacune leur clé :
 * - DNI : 8 chiffres + lettre issue de la table `n mod 23` ;
 * - NIE : X, Y ou Z + 7 chiffres + même table, le préfixe valant 0, 1 ou 2 ;
 * - CIF : lettre de forme juridique + 7 chiffres + clé, chiffre ou lettre selon
 *   la forme juridique.
 */
function isValidSpanishVat(value: string): boolean {
  if (!/^[0-9A-Z]{9}$/.test(value)) return false;

  const control = value.slice(8);

  if (/^\d{8}[A-Z]$/.test(value)) {
    return control === ES_PERSON_CONTROL_LETTERS[Number(value.slice(0, 8)) % 23];
  }

  if (/^[XYZ]\d{7}[A-Z]$/.test(value)) {
    const prefix = 'XYZ'.indexOf(value[0] as string);
    return control === ES_PERSON_CONTROL_LETTERS[Number(`${prefix}${value.slice(1, 8)}`) % 23];
  }

  const form = value[0] as string;
  const body = value.slice(1, 8);
  if (!ES_ENTITY_PREFIXES.includes(form) || !/^\d{7}$/.test(body)) return false;

  let sum = 0;
  for (let index = 0; index < 7; index += 1) {
    const digit = body.charCodeAt(index) - 48;
    // Les positions impaires (1re, 3e, 5e, 7e) sont doublées, et un résultat à
    // deux chiffres est réduit à la somme de ses chiffres.
    if (index % 2 === 0) {
      const doubled = digit * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += digit;
    }
  }

  const expectedDigit = (10 - (sum % 10)) % 10;
  const expectedLetter = ES_ENTITY_CONTROL_LETTERS[expectedDigit] as string;

  if (ES_LETTER_CONTROL_ONLY.includes(form)) return control === expectedLetter;
  if (ES_DIGIT_CONTROL_ONLY.includes(form)) return control === String(expectedDigit);
  return control === expectedLetter || control === String(expectedDigit);
}

export type VatNumberValidation =
  | { readonly ok: true; readonly value: string; readonly country: VatCountry }
  | { readonly ok: false; readonly message: string };

/**
 * Valide et normalise un numéro de TVA.
 *
 * Rend la forme canonique et le pays, ou un message en français exploitable
 * champ par champ. Les messages disent quoi corriger et donnent un exemple :
 * « invalide » seul renvoie le gérant à sa propre relecture.
 */
export function validateVatNumber(raw: string): VatNumberValidation {
  const value = normaliseVatNumber(raw);

  if (value.length === 0) {
    return { ok: false, message: 'Le numéro de TVA est obligatoire.' };
  }

  const inferred = inferCountry(value);
  if (!inferred) {
    return {
      ok: false,
      message:
        'Numéro de TVA non reconnu. TRIALYA gère les numéros belges (BE), français (FR) et espagnols (ES) — par exemple BE0123456749.',
    };
  }

  const canonical = `${inferred.country}${inferred.digits}`;

  switch (inferred.country) {
    case 'BE':
      if (!/^[01]\d{9}$/.test(inferred.digits)) {
        return {
          ok: false,
          message:
            'Un numéro de TVA belge s’écrit BE suivi de 10 chiffres commençant par 0 ou 1, par exemple BE0123456749.',
        };
      }
      if (!isValidBelgianVat(inferred.digits)) {
        return {
          ok: false,
          message:
            'Ce numéro de TVA belge n’est pas valide : sa clé de contrôle ne correspond pas. Vérifie les chiffres saisis.',
        };
      }
      return { ok: true, value: canonical, country: 'BE' };

    case 'FR':
      if (!/^\d{11}$/.test(inferred.digits)) {
        return {
          ok: false,
          message:
            'Un numéro de TVA français s’écrit FR suivi de 11 chiffres — la clé sur 2 chiffres puis le SIREN sur 9 —, par exemple FR40303265045.',
        };
      }
      if (!isValidFrenchVat(inferred.digits)) {
        return {
          ok: false,
          message:
            'Ce numéro de TVA français n’est pas valide : la clé ne correspond pas au SIREN. Vérifie les chiffres saisis.',
        };
      }
      return { ok: true, value: canonical, country: 'FR' };

    case 'ES':
      if (!/^[0-9A-Z]{9}$/.test(inferred.digits)) {
        return {
          ok: false,
          message:
            'Un numéro de TVA espagnol s’écrit ES suivi de 9 caractères (NIF ou CIF), par exemple ESA28015865.',
        };
      }
      if (!isValidSpanishVat(inferred.digits)) {
        return {
          ok: false,
          message:
            'Ce numéro de TVA espagnol n’est pas valide : son caractère de contrôle ne correspond pas. Vérifie la saisie.',
        };
      }
      return { ok: true, value: canonical, country: 'ES' };
  }
}

/** Vrai si le numéro est structurellement valide et satisfait sa clé de contrôle. */
export function isValidVatNumber(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  return validateVatNumber(raw).ok;
}

/** Le pays d'un numéro valide, `null` si le numéro ne l'est pas. */
export function vatCountryOf(raw: string | null | undefined): VatCountry | null {
  if (raw === null || raw === undefined) return null;
  const result = validateVatNumber(raw);
  return result.ok ? result.country : null;
}
