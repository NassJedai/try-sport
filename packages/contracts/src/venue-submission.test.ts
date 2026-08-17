import { describe, expect, it } from 'vitest';
import {
  isVenueSubmissionReady,
  missingVenueSubmissionRequirements,
  VENUE_DESCRIPTION_MIN_LENGTH,
  VENUE_SUBMISSION_REQUIREMENT_ACTIONS_FR,
  VENUE_SUBMISSION_REQUIREMENT_LABELS_FR,
  VENUE_SUBMISSION_REQUIREMENT_SCOPES,
  VENUE_SUBMISSION_REQUIREMENTS,
  type VenueSubmissionState,
} from './venue-submission.js';

const complete: VenueSubmissionState = {
  offerCount: 1,
  imageCount: 1,
  description: 'Un studio de yoga au cœur de Saint-Gilles, ouvert à tous les niveaux.',
  vatNumber: 'BE0417497106',
};

describe('complétude du dossier', () => {
  it('ne réclame rien à un dossier complet', () => {
    expect(missingVenueSubmissionRequirements(complete)).toEqual([]);
    expect(isVenueSubmissionReady(complete)).toBe(true);
  });

  it('énumère les quatre manques d’un dossier vide, dans l’ordre déclaré', () => {
    // L'ordre est le contrat : l'écran de complétion et l'e-mail de rappel
    // listent la même chose dans le même ordre.
    expect(
      missingVenueSubmissionRequirements({
        offerCount: 0,
        imageCount: 0,
        description: null,
        vatNumber: null,
      }),
    ).toEqual([
      'AT_LEAST_ONE_OFFER',
      'VENUE_DESCRIPTION',
      'AT_LEAST_ONE_PHOTO',
      'VALID_VAT_NUMBER',
    ]);
  });

  it('compte l’absence d’offre comme un manque, au même endroit que les autres', () => {
    // Cette règle valait déjà un 409 à la soumission. Elle rejoint l'inventaire
    // pour qu'il n'existe qu'une réponse à « pourquoi je ne peux pas soumettre ».
    expect(missingVenueSubmissionRequirements({ ...complete, offerCount: 0 })).toEqual([
      'AT_LEAST_ONE_OFFER',
    ]);
  });

  it('refuse une photo manquante', () => {
    expect(missingVenueSubmissionRequirements({ ...complete, imageCount: 0 })).toEqual([
      'AT_LEAST_ONE_PHOTO',
    ]);
  });

  it('refuse une description absente, vide ou décorative', () => {
    for (const description of [null, '', '   ', 'Salle de sport.', 'à compléter']) {
      expect(missingVenueSubmissionRequirements({ ...complete, description })).toEqual([
        'VENUE_DESCRIPTION',
      ]);
    }
  });

  it('mesure la description après avoir retiré les espaces', () => {
    const padded = `   ${'x'.repeat(VENUE_DESCRIPTION_MIN_LENGTH)}   `;
    expect(missingVenueSubmissionRequirements({ ...complete, description: padded })).toEqual([]);

    const tooShort = ' '.repeat(50) + 'x'.repeat(VENUE_DESCRIPTION_MIN_LENGTH - 1);
    expect(missingVenueSubmissionRequirements({ ...complete, description: tooShort })).toEqual([
      'VENUE_DESCRIPTION',
    ]);
  });

  it('exige une TVA valide, pas seulement une TVA présente', () => {
    // Le cas qui compte : le gérant a bien rempli le champ, mais le numéro est
    // faux. Il finirait sur une facture.
    expect(missingVenueSubmissionRequirements({ ...complete, vatNumber: 'BE0417497107' })).toEqual([
      'VALID_VAT_NUMBER',
    ]);
    expect(missingVenueSubmissionRequirements({ ...complete, vatNumber: 'à venir' })).toEqual([
      'VALID_VAT_NUMBER',
    ]);
    expect(missingVenueSubmissionRequirements({ ...complete, vatNumber: null })).toEqual([
      'VALID_VAT_NUMBER',
    ]);
  });

  it('accepte une TVA des trois pays, écrite comme un humain l’écrit', () => {
    for (const vatNumber of ['BE 0417.497.106', 'FR40303265045', 'ESA28015865']) {
      expect(isVenueSubmissionReady({ ...complete, vatNumber })).toBe(true);
    }
  });
});

describe('présentation des manques', () => {
  it('traduit chaque exigence, sans trou', () => {
    for (const requirement of VENUE_SUBMISSION_REQUIREMENTS) {
      expect(VENUE_SUBMISSION_REQUIREMENT_LABELS_FR[requirement].length).toBeGreaterThan(3);
      expect(VENUE_SUBMISSION_REQUIREMENT_ACTIONS_FR[requirement].length).toBeGreaterThan(10);
      expect(['BUSINESS', 'VENUE', 'OFFER']).toContain(
        VENUE_SUBMISSION_REQUIREMENT_SCOPES[requirement],
      );
    }
  });

  it('rattache la TVA à l’établissement et non au lieu', () => {
    // Le manque n'est pas toujours sur le lieu : l'écran de complétion doit
    // envoyer le gérant au bon endroit.
    expect(VENUE_SUBMISSION_REQUIREMENT_SCOPES.VALID_VAT_NUMBER).toBe('BUSINESS');
    expect(VENUE_SUBMISSION_REQUIREMENT_SCOPES.AT_LEAST_ONE_OFFER).toBe('OFFER');
  });
});
