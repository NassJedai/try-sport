import { describe, expect, it } from 'vitest';
import { recurringScheduleSchema, updateVenueSchema } from './business.js';
import { openingHoursSchema, updateOfferSchema } from './offers.js';
import { timeOfDaySchema } from './common.js';

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

/**
 * L'heure murale, bornée.
 *
 * Ces assertions décrivent un défaut reproduit par un appel réel, pas une
 * hypothèse : `POST /v1/schedules` avec `startTime: '29:59'` rendait 201 et sept
 * créneaux décalés d'un jour entier, parce que trois couches laissaient passer —
 * le format seul ici, `Number.isInteger(29)` dans le service, puis
 * `Date.UTC(..., 29, ...)` qui normalise en 05:59 le lendemain. Affaiblir ce
 * schéma rouvre le chemin en entier.
 */
describe('heure murale du jour', () => {
  it('accepte les bornes réelles d’une journée', () => {
    for (const value of ['00:00', '09:30', '19:00', '23:59']) {
      expect(timeOfDaySchema.safeParse(value).success).toBe(true);
    }
  });

  it('refuse une heure qui déborde du jour', () => {
    // 29:59 est la valeur exacte qui créait sept créneaux au mauvais jour.
    for (const value of ['24:00', '25:00', '29:59', '99:99']) {
      expect(timeOfDaySchema.safeParse(value).success).toBe(false);
    }
  });

  it('refuse des minutes qui n’existent pas', () => {
    for (const value of ['12:60', '12:99']) {
      expect(timeOfDaySchema.safeParse(value).success).toBe(false);
    }
  });

  it('refuse ce qui n’a pas la forme HH:mm', () => {
    for (const value of ['9:00', '09:0', '0900', '09:00:00', '', 'midi']) {
      expect(timeOfDaySchema.safeParse(value).success).toBe(false);
    }
  });

  it('reste au moins aussi strict que la contrainte SQL des horaires', () => {
    // La base impose `^[0-2][0-9]:[0-5][0-9]$` sur schedules.start_time. Tout ce
    // que le contrat accepte doit passer cette contrainte, sans quoi le gérant
    // reçoit un 500 au lieu d'un 400 nommant le champ — c'est ce qui arrivait
    // avec '99:99', accepté ici et refusé par la base.
    const sqlConstraint = /^[0-2][0-9]:[0-5][0-9]$/;
    for (const hour of Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))) {
      for (const minute of ['00', '07', '30', '59']) {
        const value = `${hour}:${minute}`;
        expect(timeOfDaySchema.safeParse(value).success).toBe(true);
        expect(sqlConstraint.test(value)).toBe(true);
      }
    }
  });
});

describe('horaires appliqués aux schémas qui les portent', () => {
  it('refuse un créneau récurrent hors du jour', () => {
    const base = {
      offerId: '11111111-1111-4111-8111-111111111111',
      daysOfWeek: [1],
      capacity: 10,
      validFrom: '2026-09-01',
    };
    expect(recurringScheduleSchema.safeParse({ ...base, startTime: '19:00' }).success).toBe(true);

    const rejected = recurringScheduleSchema.safeParse({ ...base, startTime: '29:59' });
    expect(rejected.success).toBe(false);
    // Le gérant doit lire quel champ corriger, pas « requête invalide ».
    expect(rejected.error?.issues[0]?.path).toEqual(['startTime']);
  });

  it('refuse un horaire d’ouverture hors du jour', () => {
    expect(
      openingHoursSchema.safeParse([{ dayOfWeek: 1, opensAt: '07:00', closesAt: '22:00' }]).success,
    ).toBe(true);
    expect(
      openingHoursSchema.safeParse([{ dayOfWeek: 1, opensAt: '29:59', closesAt: '22:00' }]).success,
    ).toBe(false);
    // Une salle ouverte jusqu'à 2 h ferme à 02:00, pas à 24:00 ou 26:00.
    expect(
      openingHoursSchema.safeParse([{ dayOfWeek: 1, opensAt: '22:00', closesAt: '02:00' }]).success,
    ).toBe(true);
    expect(
      openingHoursSchema.safeParse([{ dayOfWeek: 1, opensAt: '22:00', closesAt: '26:00' }]).success,
    ).toBe(false);
  });
});
