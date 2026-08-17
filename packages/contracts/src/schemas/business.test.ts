import { describe, expect, it } from 'vitest';
import { VENUE_DESCRIPTION_MIN_LENGTH } from '../venue-submission.js';
import { businessVenueSchema, createBusinessSchema, createVenueSchema } from './business.js';

const wizardPayload = { name: 'Studio Move', contactEmail: 'gerant@studiomove.be' };

describe('création d’un établissement', () => {
  it('accepte encore ce que l’assistant d’inscription envoie aujourd’hui', () => {
    // La TVA et la raison sociale sont exigées pour être visible en ligne, pas
    // pour s'inscrire : rendre ces champs obligatoires ici casserait l'assistant
    // et ramènerait le formulaire long qu'on vient d'écarter.
    const parsed = createBusinessSchema.parse(wizardPayload);
    expect(parsed.vatNumber).toBeUndefined();
    expect(parsed.legalName).toBeUndefined();
  });

  it('normalise un numéro de TVA écrit comme un humain l’écrit', () => {
    expect(createBusinessSchema.parse({ ...wizardPayload, vatNumber: ' be 0417.497.106 ' }))
      .toMatchObject({ vatNumber: 'BE0417497106' });
  });

  it('traite un champ TVA vide comme non renseigné', () => {
    expect(createBusinessSchema.parse({ ...wizardPayload, vatNumber: '' }).vatNumber).toBeUndefined();
  });

  it('refuse un numéro de TVA dont la clé de contrôle est fausse', () => {
    // Le commentaire de ce champ promettait une validation stricte « à
    // l'approbation » qui n'existait nulle part : un numéro inventé traversait
    // jusqu'à la facture.
    const result = createBusinessSchema.safeParse({ ...wizardPayload, vatNumber: 'BE0417497107' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['vatNumber']);
    expect(result.error?.issues[0]?.message).toContain('clé de contrôle');
  });

  it('accepte les trois pays supportés', () => {
    for (const vatNumber of ['BE0417497106', 'FR40303265045', 'ESA28015865']) {
      expect(createBusinessSchema.safeParse({ ...wizardPayload, vatNumber }).success).toBe(true);
    }
    expect(
      createBusinessSchema.safeParse({ ...wizardPayload, vatNumber: 'NL123456789B01' }).success,
    ).toBe(false);
  });
});

describe('création d’un lieu', () => {
  const base = {
    name: 'Studio Move',
    addressLine: 'Rue Haute 12',
    postalCode: '1000',
    cityId: '11111111-1111-4111-8111-111111111111',
    latitude: 50.8467,
    longitude: 4.3525,
    categoryIds: ['22222222-2222-4222-8222-222222222222'],
  };

  it('accepte un lieu sans description', () => {
    // Facultative à la création, exigée à la soumission.
    expect(createVenueSchema.safeParse(base).success).toBe(true);
  });

  it('refuse une description trop courte pour en être une', () => {
    // Sinon le gérant enregistre « Salle de sport » et s'entend dire plus tard
    // que sa description manque.
    expect(createVenueSchema.safeParse({ ...base, description: 'Salle de sport' }).success).toBe(
      false,
    );
    expect(
      createVenueSchema.safeParse({ ...base, description: 'x'.repeat(VENUE_DESCRIPTION_MIN_LENGTH) })
        .success,
    ).toBe(true);
  });
});

describe('un lieu vu par son propriétaire', () => {
  it('accepte la forme qu’un lieu en brouillon sans rien produit', () => {
    // Le cas qui rendait un lieu irrécupérable : DRAFT, aucune offre, aucune
    // photo, pas de commune. Il doit se lire.
    const parsed = businessVenueSchema.parse({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Studio Move',
      status: 'DRAFT',
      rejectedReason: null,
      addressLine: 'Rue Haute 12',
      postalCode: '1000',
      cityId: '11111111-1111-4111-8111-111111111111',
      districtId: null,
      categoryIds: [],
      offerCount: 0,
      imageCount: 0,
      missingRequirements: ['AT_LEAST_ONE_OFFER', 'VENUE_DESCRIPTION', 'AT_LEAST_ONE_PHOTO'],
      description: null,
      latitude: 50.8467,
      longitude: 4.3525,
      timeZone: 'Europe/Brussels',
      phone: null,
      website: null,
      instagram: null,
      amenities: [],
      languages: ['fr'],
      openingHours: [],
      createdAt: '2026-08-17T09:00:00.000Z',
    });

    expect(parsed.missingRequirements).toHaveLength(3);
    expect(parsed.rejectedReason).toBeNull();
  });

  it('porte le motif de refus, que le client public ne voit jamais', () => {
    const parsed = businessVenueSchema.parse({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Studio Move',
      status: 'REJECTED',
      rejectedReason: 'Les photos ne montrent pas la salle.',
      addressLine: 'Rue Haute 12',
      postalCode: '1000',
      cityId: '11111111-1111-4111-8111-111111111111',
      districtId: '44444444-4444-4444-8444-444444444444',
      categoryIds: ['22222222-2222-4222-8222-222222222222'],
      offerCount: 1,
      imageCount: 2,
      missingRequirements: [],
      description: 'Un studio de yoga au cœur de Saint-Gilles, ouvert à tous les niveaux.',
      latitude: 50.8467,
      longitude: 4.3525,
      timeZone: 'Europe/Brussels',
      phone: '+32 2 000 00 00',
      website: 'https://studiomove.be',
      instagram: 'studiomove',
      amenities: ['Douches'],
      languages: ['fr', 'nl'],
      openingHours: [{ dayOfWeek: 1, opensAt: '07:00', closesAt: '21:00' }],
      createdAt: '2026-08-17T09:00:00.000Z',
    });

    expect(parsed.rejectedReason).toBe('Les photos ne montrent pas la salle.');
    // L'écran de correction doit pouvoir se pré-remplir : une mise à jour
    // partielle sur un formulaire vide est un chemin d'effacement.
    expect(parsed.description).not.toBeNull();
    expect(parsed.openingHours).toHaveLength(1);
  });
});
