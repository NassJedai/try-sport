import { describe, expect, it } from 'vitest';
import {
  isValidVatNumber,
  normaliseVatNumber,
  validateVatNumber,
  vatCountryOf,
} from './vat-number.js';

describe('normalisation', () => {
  it('accepts what a manager actually types', () => {
    // Espaces, points, minuscules : la même entreprise, écrite de quatre façons.
    for (const raw of ['BE0417497106', 'be0417497106', 'BE 0417.456', 'BE-0417']) {
      expect(normaliseVatNumber(raw)).toBe(raw.toUpperCase().replace(/[^0-9A-Z]/g, ''));
    }
    expect(normaliseVatNumber(' be 0417.497.106 ')).toBe('BE0417497106');
  });

  it('rends la forme canonique, préfixe compris, même quand il manque', () => {
    // Le numéro d'entreprise belge se tape le plus souvent sans « BE ».
    const result = validateVatNumber('0417.497.106');
    expect(result).toEqual({ ok: true, value: 'BE0417497106', country: 'BE' });
  });

  it('déduit le pays sans préfixe pour les trois formats supportés', () => {
    expect(vatCountryOf('0417497106')).toBe('BE');
    expect(vatCountryOf('40303265045')).toBe('FR');
    expect(vatCountryOf('A28015865')).toBe('ES');
  });

  it('refuse de deviner un pays sur un numéro ambigu', () => {
    // Neuf chiffres : un SIREN sans sa clé. Aucun des trois formats.
    const result = validateVatNumber('303265045');
    expect(result.ok).toBe(false);
  });
});

describe('Belgique', () => {
  it('accepte des numéros dont la clé modulo 97 tombe juste', () => {
    for (const value of ['BE0417497106', 'BE0400378485', 'BE0403170701']) {
      expect(isValidVatNumber(value)).toBe(true);
    }
  });

  it('refuse un numéro de bonne structure dont la clé est fausse', () => {
    // Un chiffre de contrôle décalé de un : la structure passe, la clé non.
    // C'est exactement ce qu'un contrôle de format seul laisserait filer.
    const result = validateVatNumber('BE0417497107');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('clé de contrôle');
  });

  it('refuse une longueur ou un préfixe impossibles', () => {
    expect(isValidVatNumber('BE041749710')).toBe(false);
    expect(isValidVatNumber('BE04174971060')).toBe(false);
    // Les numéros d'entreprise commencent par 0 ou 1.
    expect(isValidVatNumber('BE2417497106')).toBe(false);
    expect(isValidVatNumber('BE0000000097')).toBe(false);
  });
});

describe('France', () => {
  it('accepte une clé cohérente avec un SIREN valide', () => {
    for (const value of ['FR40303265045', 'FR83404833048']) {
      expect(isValidVatNumber(value)).toBe(true);
    }
  });

  it('refuse une clé qui ne correspond pas au SIREN', () => {
    // Même SIREN, clé fausse.
    const result = validateVatNumber('FR44404833048');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('SIREN');
  });

  it('refuse un SIREN qui ne satisfait pas Luhn', () => {
    // 123456789 n'est pas un SIREN : sans le contrôle Luhn, une clé calculée
    // dessus rendrait ce numéro inventé acceptable.
    expect(isValidVatNumber('FR32123456789')).toBe(false);
  });

  it('refuse une clé alphanumérique, faute de pouvoir la vérifier', () => {
    expect(isValidVatNumber('FRAB303265045')).toBe(false);
  });
});

describe('Espagne', () => {
  it('accepte les CIF de société, clé lettre ou clé chiffre', () => {
    for (const value of ['ESA28015865', 'ESA15075062', 'ESQ2826004J', 'ESB12345674']) {
      expect(isValidVatNumber(value)).toBe(true);
    }
  });

  it('accepte les deux clés possibles quand la forme juridique le permet', () => {
    // J accepte chiffre ou lettre ; les deux dérivent de la même somme.
    expect(isValidVatNumber('ESJ12345674')).toBe(true);
    expect(isValidVatNumber('ESJ1234567D')).toBe(true);
  });

  it('impose une lettre là où la forme juridique l’exige', () => {
    // Q est une entité publique : la clé est toujours une lettre.
    expect(isValidVatNumber('ESQ2826004J')).toBe(true);
    expect(isValidVatNumber('ESQ28260040')).toBe(false);
  });

  it('impose un chiffre là où la forme juridique l’exige', () => {
    // B est une SARL : la clé est toujours un chiffre.
    expect(isValidVatNumber('ESB12345674')).toBe(true);
    expect(isValidVatNumber('ESB1234567E')).toBe(false);
  });

  it('accepte le NIF d’une personne physique et le NIE', () => {
    expect(isValidVatNumber('ES12345678Z')).toBe(true);
    expect(isValidVatNumber('ESX1234567L')).toBe(true);
  });

  it('refuse un caractère de contrôle faux', () => {
    const result = validateVatNumber('ESA28015866');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('contrôle');
    expect(isValidVatNumber('ES12345678A')).toBe(false);
    expect(isValidVatNumber('ESX1234567M')).toBe(false);
  });

  it('refuse une forme juridique qui n’existe pas', () => {
    // I, O, T, Y, Z ne sont pas des préfixes de CIF.
    expect(isValidVatNumber('ESI12345674')).toBe(false);
  });
});

describe('pays non supportés et saisies vides', () => {
  it('refuse un pays hors BE, FR, ES avec un message qui le dit', () => {
    const result = validateVatNumber('NL123456789B01');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('belges');
  });

  it('refuse une chaîne vide ou décorative', () => {
    expect(validateVatNumber('')).toEqual({
      ok: false,
      message: 'Le numéro de TVA est obligatoire.',
    });
    expect(isValidVatNumber('   ')).toBe(false);
    expect(isValidVatNumber('à compléter')).toBe(false);
  });

  it('traite null et undefined comme absents, jamais comme valides', () => {
    // La règle de complétude interroge une colonne nullable : une TVA absente
    // est un manque, pas une exception à faire remonter.
    expect(isValidVatNumber(null)).toBe(false);
    expect(isValidVatNumber(undefined)).toBe(false);
    expect(vatCountryOf(null)).toBeNull();
  });

  it('rend toujours un message en français quand il refuse', () => {
    for (const value of ['', 'PATATE', 'BE0417497107', 'FR44404833048', 'ESA28015866']) {
      const result = validateVatNumber(value);
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.message.length).toBeGreaterThan(20);
    }
  });
});
