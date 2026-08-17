import { describe, expect, it } from 'vitest';
import {
  canEditOfferField,
  canEditVenueField,
  FREE_OFFER_FIELDS,
  FREE_VENUE_FIELDS,
  isSensitiveOfferField,
  isSensitiveVenueField,
  offerEditRefusalReason,
  offerFieldClass,
  offerFieldEditDecision,
  reviewOfferFieldEdits,
  reviewVenueFieldEdits,
  SENSITIVE_OFFER_FIELDS,
  SENSITIVE_VENUE_FIELDS,
  venueEditRefusalReason,
  venueFieldClass,
  venueFieldEditDecision,
  type OfferField,
  type VenueField,
} from './editable-fields.js';
import { OFFER_STATUSES, VENUE_STATUSES } from './enums.js';

describe('classification des champs', () => {
  it('range le contact et l’exploitation courante en libre', () => {
    // Aucun modérateur n'a jamais validé un numéro de téléphone.
    for (const field of ['phone', 'website', 'instagram', 'amenities', 'languages', 'openingHours'] as const) {
      expect(venueFieldClass(field)).toBe('FREE');
      expect(isSensitiveVenueField(field)).toBe(false);
    }
    for (const field of ['capacity', 'skillLevel', 'whatToBring', 'conditions', 'cancellationPolicy', 'trialRule'] as const) {
      expect(offerFieldClass(field)).toBe('FREE');
      expect(isSensitiveOfferField(field)).toBe(false);
    }
  });

  it('range le nom, l’adresse et la géolocalisation en identité', () => {
    for (const field of ['name', 'addressLine', 'postalCode', 'cityId', 'districtId', 'latitude', 'longitude', 'timeZone'] as const) {
      expect(venueFieldClass(field)).toBe('IDENTITY');
      expect(isSensitiveVenueField(field)).toBe(true);
    }
  });

  it('range le prix, les catégories et le type d’expérience en modéré', () => {
    // Le cœur de la règle : ce qui est vendu est gelé une fois validé.
    expect(offerFieldClass('priceAmount')).toBe('MODERATED');
    expect(offerFieldClass('referencePriceAmount')).toBe('MODERATED');
    expect(offerFieldClass('currency')).toBe('MODERATED');
    expect(offerFieldClass('experienceType')).toBe('MODERATED');
    expect(offerFieldClass('categoryId')).toBe('MODERATED');
    expect(venueFieldClass('categoryIds')).toBe('MODERATED');
    expect(venueFieldClass('description')).toBe('MODERATED');
  });

  it('classe tous les champs modifiables, sans en oublier un', () => {
    // Le typage l'impose déjà (Record<keyof UpdateVenueDto, …>) ; ce test le
    // rend visible à l'exécution et fixe le nombre de champs classés.
    expect([...SENSITIVE_VENUE_FIELDS, ...FREE_VENUE_FIELDS].sort()).toEqual(
      [
        'addressLine',
        'amenities',
        'categoryIds',
        'cityId',
        'description',
        'districtId',
        'instagram',
        'languages',
        'latitude',
        'longitude',
        'name',
        'openingHours',
        'phone',
        'postalCode',
        'timeZone',
        'website',
      ].sort(),
    );
    expect([...SENSITIVE_OFFER_FIELDS, ...FREE_OFFER_FIELDS].sort()).toEqual(
      [
        'amenities',
        'cancellationPolicy',
        'capacity',
        'categoryId',
        'conditions',
        'currency',
        'description',
        'durationMinutes',
        'experienceType',
        'languages',
        'priceAmount',
        'referencePriceAmount',
        'skillLevel',
        'title',
        'trialRule',
        'whatToBring',
      ].sort(),
    );
  });
});

describe('un lieu refusé peut être corrigé', () => {
  it('ouvre tous ses champs, sensibles compris', () => {
    // L'impasse que ce chantier existe pour lever : sans cela, le gérant n'a
    // d'autre issue que de recréer son lieu, doublon compris.
    for (const field of [...SENSITIVE_VENUE_FIELDS, ...FREE_VENUE_FIELDS]) {
      expect(venueFieldEditDecision('REJECTED', field)).toBe('ALLOWED');
    }
    for (const field of [...SENSITIVE_OFFER_FIELDS, ...FREE_OFFER_FIELDS]) {
      expect(offerFieldEditDecision('REJECTED', field)).toBe('ALLOWED');
    }
  });

  it('ouvre tout autant en brouillon', () => {
    for (const field of [...SENSITIVE_VENUE_FIELDS, ...FREE_VENUE_FIELDS]) {
      expect(venueFieldEditDecision('DRAFT', field)).toBe('ALLOWED');
    }
  });
});

describe('un dossier en cours d’examen ne bouge pas', () => {
  it('gèle le fond et laisse le contact ouvert', () => {
    expect(venueFieldEditDecision('PENDING_APPROVAL', 'name')).toBe('FORBIDDEN');
    expect(venueFieldEditDecision('PENDING_APPROVAL', 'addressLine')).toBe('FORBIDDEN');
    expect(venueFieldEditDecision('PENDING_APPROVAL', 'description')).toBe('FORBIDDEN');
    expect(venueFieldEditDecision('PENDING_APPROVAL', 'phone')).toBe('ALLOWED');
    expect(offerFieldEditDecision('PENDING_APPROVAL', 'priceAmount')).toBe('FORBIDDEN');
    expect(offerFieldEditDecision('PENDING_APPROVAL', 'capacity')).toBe('ALLOWED');
  });
});

describe('une salle en ligne', () => {
  it('change de nom et d’adresse librement, mais prévient l’admin', () => {
    for (const status of ['ACTIVE', 'PAUSED'] as const) {
      for (const field of ['name', 'addressLine', 'postalCode', 'cityId', 'districtId', 'latitude', 'longitude', 'timeZone'] as const) {
        expect(venueFieldEditDecision(status, field)).toBe('NOTIFY_ADMIN');
        // NOTIFY_ADMIN est un oui : l'écriture passe.
        expect(canEditVenueField(status, field)).toBe(true);
      }
    }
  });

  it('ne touche pas au prix de ses offres', () => {
    // Passer une séance découverte de 5 € à 45 € après approbation est l'abus
    // que la modération existe pour empêcher.
    for (const status of ['ACTIVE', 'PAUSED'] as const) {
      expect(offerFieldEditDecision(status, 'priceAmount')).toBe('FORBIDDEN');
      expect(offerFieldEditDecision(status, 'referencePriceAmount')).toBe('FORBIDDEN');
      expect(offerFieldEditDecision(status, 'currency')).toBe('FORBIDDEN');
      expect(canEditOfferField(status, 'priceAmount')).toBe(false);
    }
  });

  it('ne se recatégorise pas et ne change pas de type d’expérience', () => {
    expect(venueFieldEditDecision('ACTIVE', 'categoryIds')).toBe('FORBIDDEN');
    expect(offerFieldEditDecision('ACTIVE', 'categoryId')).toBe('FORBIDDEN');
    expect(offerFieldEditDecision('ACTIVE', 'experienceType')).toBe('FORBIDDEN');
  });

  it('garde ses horaires, son téléphone et sa capacité sous son seul contrôle', () => {
    expect(venueFieldEditDecision('ACTIVE', 'openingHours')).toBe('ALLOWED');
    expect(venueFieldEditDecision('ACTIVE', 'phone')).toBe('ALLOWED');
    expect(offerFieldEditDecision('ACTIVE', 'capacity')).toBe('ALLOWED');
  });
});

describe('une suspension ne se contourne pas en éditant', () => {
  it('gèle absolument tout, y compris le téléphone', () => {
    for (const field of [...SENSITIVE_VENUE_FIELDS, ...FREE_VENUE_FIELDS]) {
      expect(venueFieldEditDecision('SUSPENDED', field)).toBe('FORBIDDEN');
      expect(venueFieldEditDecision('ARCHIVED', field)).toBe('FORBIDDEN');
      expect(canEditVenueField('SUSPENDED', field)).toBe(false);
    }
    for (const field of [...SENSITIVE_OFFER_FIELDS, ...FREE_OFFER_FIELDS]) {
      expect(offerFieldEditDecision('ARCHIVED', field)).toBe('FORBIDDEN');
    }
  });
});

describe('verdict sur une demande entière', () => {
  it('sépare ce qui passe, ce qui notifie et ce qui est refusé', () => {
    const verdict = reviewVenueFieldEdits('ACTIVE', ['phone', 'name', 'categoryIds']);
    expect(verdict).toEqual({
      allowed: ['phone'],
      notifyAdmin: ['name'],
      forbidden: ['categoryIds'],
    });
  });

  it('refuse une clé inconnue plutôt que de l’ignorer', () => {
    // Le refus est le défaut. Une clé que la classification ne connaît pas ne
    // doit pas passer par une porte ouverte.
    const verdict = reviewVenueFieldEdits('DRAFT', ['name', 'commissionBasisPoints']);
    expect(verdict.forbidden).toEqual(['commissionBasisPoints']);
    expect(verdict.allowed).toEqual(['name']);
  });

  it('ne refuse rien sur un lieu refusé, quelle que soit la demande', () => {
    const verdict = reviewVenueFieldEdits('REJECTED', [
      'name',
      'addressLine',
      'categoryIds',
      'description',
      'phone',
    ]);
    expect(verdict.forbidden).toEqual([]);
    expect(verdict.notifyAdmin).toEqual([]);
    expect(verdict.allowed).toHaveLength(5);
  });

  it('accepte une demande vide sans rien décider', () => {
    expect(reviewVenueFieldEdits('SUSPENDED', [])).toEqual({
      allowed: [],
      notifyAdmin: [],
      forbidden: [],
    });
  });

  it('tient sur une offre', () => {
    const verdict = reviewOfferFieldEdits('ACTIVE', ['capacity', 'priceAmount']);
    expect(verdict.allowed).toEqual(['capacity']);
    expect(verdict.forbidden).toEqual(['priceAmount']);
    expect(verdict.notifyAdmin).toEqual([]);
  });
});

describe('cohérence de la table', () => {
  it('donne une décision pour chaque couple statut × champ', () => {
    for (const status of VENUE_STATUSES) {
      for (const field of [...SENSITIVE_VENUE_FIELDS, ...FREE_VENUE_FIELDS] as VenueField[]) {
        expect(['ALLOWED', 'NOTIFY_ADMIN', 'FORBIDDEN']).toContain(
          venueFieldEditDecision(status, field),
        );
      }
    }
    for (const status of OFFER_STATUSES) {
      for (const field of [...SENSITIVE_OFFER_FIELDS, ...FREE_OFFER_FIELDS] as OfferField[]) {
        expect(['ALLOWED', 'NOTIFY_ADMIN', 'FORBIDDEN']).toContain(
          offerFieldEditDecision(status, field),
        );
      }
    }
  });

  it('explique tout refus, et n’explique rien quand il n’y a rien à refuser', () => {
    for (const status of VENUE_STATUSES) {
      const refuses = [...SENSITIVE_VENUE_FIELDS, ...FREE_VENUE_FIELDS].some(
        (field) => venueFieldEditDecision(status, field) === 'FORBIDDEN',
      );
      expect(venueEditRefusalReason(status) === null).toBe(!refuses);
    }
    for (const status of OFFER_STATUSES) {
      const refuses = [...SENSITIVE_OFFER_FIELDS, ...FREE_OFFER_FIELDS].some(
        (field) => offerFieldEditDecision(status, field) === 'FORBIDDEN',
      );
      expect(offerEditRefusalReason(status) === null).toBe(!refuses);
    }
  });

  it('n’autorise jamais un champ modéré sur une offre publiée', () => {
    // Formulé comme une invariante et non comme un cas : si un champ modéré
    // devient modifiable en ACTIVE, ce test tombe, quel que soit le champ.
    for (const field of SENSITIVE_OFFER_FIELDS) {
      for (const status of ['PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'ARCHIVED'] as const) {
        expect(offerFieldEditDecision(status, field)).toBe('FORBIDDEN');
      }
    }
  });

  it('ne notifie l’admin que sur une salle en ligne', () => {
    for (const status of VENUE_STATUSES) {
      const notifies = [...SENSITIVE_VENUE_FIELDS, ...FREE_VENUE_FIELDS].some(
        (field) => venueFieldEditDecision(status, field) === 'NOTIFY_ADMIN',
      );
      expect(notifies).toBe(status === 'ACTIVE' || status === 'PAUSED');
    }
  });
});
