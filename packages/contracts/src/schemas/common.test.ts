import { describe, expect, it } from 'vitest';
import { updateVenueSchema } from './business.js';
import { updateOfferSchema } from './offers.js';

/**
 * `partialUpdateOf` — la garantie « absent veut dire ne change rien ».
 *
 * Ces tests existent parce que `.partial()` seul ne la donne pas : en Zod 4 il
 * laisse les `.default()` actifs. Revenir à `.partial()` rouvrirait un chemin
 * d'effacement silencieux, et ces assertions tomberaient.
 */
describe('mise à jour partielle d’un lieu', () => {
  it('ne rend que les champs réellement envoyés', () => {
    // Le piège : avec `.partial()`, ce renommage arrivait au service avec
    // amenities: [], openingHours: [], languages: ['fr'] et le fuseau de
    // Bruxelles — un `set({ ...dto })` effaçait les équipements et les horaires.
    expect(updateVenueSchema.parse({ name: 'Studio Move' })).toEqual({ name: 'Studio Move' });
  });

  it('ne fabrique rien à partir d’un corps vide', () => {
    expect(updateVenueSchema.parse({})).toEqual({});
  });

  it('refuse de vider les catégories, comme à la création', () => {
    // `categoryIds: []` est une valeur *présente* qui voudrait dire « supprime
    // toutes les catégories ». Le `.min(1)` de la création survit à la mise à
    // jour partielle, donc le schéma refuse — le service n'a pas à trancher.
    expect(updateVenueSchema.safeParse({ categoryIds: [] }).success).toBe(false);
    expect(updateVenueSchema.safeParse({ languages: [] }).success).toBe(false);
    expect(
      updateVenueSchema.safeParse({ categoryIds: ['11111111-1111-4111-8111-111111111111'] })
        .success,
    ).toBe(true);
  });

  it('laisse vider ce qui peut légitimement l’être', () => {
    // Vide et absent sont deux demandes différentes : le service doit lire la
    // présence de la clé, pas la valeur.
    expect(updateVenueSchema.parse({ amenities: [] })).toEqual({ amenities: [] });
    expect(updateVenueSchema.parse({ openingHours: [] })).toEqual({ openingHours: [] });
  });

  it('conserve les bornes de la création', () => {
    expect(updateVenueSchema.safeParse({ name: 'A' }).success).toBe(false);
    expect(updateVenueSchema.safeParse({ latitude: 120 }).success).toBe(false);
  });
});

describe('mise à jour partielle d’une offre', () => {
  it('ne rend que les champs réellement envoyés', () => {
    // Avec `.partial()`, corriger un titre remettait referencePriceAmount à
    // null : le prix barré disparaissait sur une faute de frappe.
    expect(updateOfferSchema.parse({ title: 'Cours découverte' })).toEqual({
      title: 'Cours découverte',
    });
  });

  it('laisse retirer explicitement le prix de référence', () => {
    expect(updateOfferSchema.parse({ referencePriceAmount: null })).toEqual({
      referencePriceAmount: null,
    });
  });

  it('garde les montants en unités mineures entières', () => {
    expect(updateOfferSchema.safeParse({ priceAmount: 1250 }).success).toBe(true);
    expect(updateOfferSchema.safeParse({ priceAmount: 12.5 }).success).toBe(false);
    expect(updateOfferSchema.safeParse({ priceAmount: -1 }).success).toBe(false);
  });

  it('ne permet pas de déplacer une offre vers un autre lieu', () => {
    // `venueId` est retiré du schéma : l'offre porte les statistiques, les
    // créneaux et les réservations de son lieu.
    expect('venueId' in updateOfferSchema.shape).toBe(false);
    expect(updateOfferSchema.parse({ venueId: '11111111-1111-4111-8111-111111111111' })).toEqual(
      {},
    );
  });
});
