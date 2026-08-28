import { describe, expect, it } from 'vitest';
import type { OfferDetailDto } from '@try/contracts';
import { diffOfferPatch, type OfferFormValues } from './diff';

/**
 * Fixture minimale — `diffOfferPatch` ne lit que ces champs de
 * `OfferDetailDto` (voir son corps) ; construire le DTO complet (salle,
 * avis, galerie…) n'apporterait rien à ces tests et rendrait chaque cas
 * illisible. `as unknown as OfferDetailDto` est un choix assumé pour ce
 * fichier, pas un oubli de champs.
 */
function original(overrides: {
  title?: string;
  priceAmount: number;
  referencePriceAmount: number | null;
}): OfferDetailDto {
  return {
    title: overrides.title ?? 'Cours découverte',
    description: 'Une séance pour découvrir.',
    category: { id: 'cat-1', slug: 'yoga', name: 'Yoga', icon: 'yoga' },
    experienceType: 'FREE_TRIAL',
    price: { amount: overrides.priceAmount, currency: 'EUR' },
    referencePrice:
      overrides.referencePriceAmount !== null
        ? { amount: overrides.referencePriceAmount, currency: 'EUR' }
        : null,
    durationMinutes: 60,
    capacity: 10,
    trialRule: 'ONE_TRIAL_PER_VENUE',
    skillLevel: 'ALL_LEVELS',
    languages: ['fr'],
    cancellationPolicy: 'STANDARD',
  } as unknown as OfferDetailDto;
}

/** Les champs de `OfferFormValues` que ces tests ne font jamais varier. */
const unrelatedNextFields = {
  description: 'Une séance pour découvrir.',
  categoryId: 'cat-1',
  experienceType: 'FREE_TRIAL',
  durationMinutes: 60,
  capacity: 10,
  trialRule: 'ONE_TRIAL_PER_VENUE',
  skillLevel: 'ALL_LEVELS',
  languages: ['fr'],
  cancellationPolicy: 'STANDARD',
} satisfies Omit<OfferFormValues, 'title' | 'priceAmount' | 'referencePriceAmount'>;

describe('diffOfferPatch — champs de prix', () => {
  // Le scénario du bug : une offre ACTIVE gratuite (`priceAmount: 0`) porte un
  // prix barré en base (`referencePriceAmount: 2200` — la fiche publique
  // affiche « 19 € barré → Gratuit », un état produit normal). Le gérant
  // n'ouvre que le titre. `OfferEditForm` ne rend ni le champ prix découverte
  // ni le champ prix habituel (`isPaid` faux), donc `next.referencePriceAmount`
  // doit valoir `undefined` — jamais la valeur d'un champ non affiché.
  it("offre gratuite à prix barré, édition du titre seul → le patch ne contient AUCUN champ de prix", () => {
    const patch = diffOfferPatch(
      original({ title: 'Cours découverte', priceAmount: 0, referencePriceAmount: 2200 }),
      {
        ...unrelatedNextFields,
        title: 'Cours découverte — nouveau titre',
        priceAmount: 0, // isPaid faux → toujours 0, le champ n'est pas rendu mais sa valeur ne ment pas
        referencePriceAmount: undefined, // champ non rendu : ne doit jamais entrer dans le patch
      },
    );

    expect(patch).toEqual({ title: 'Cours découverte — nouveau titre' });
    expect(patch).not.toHaveProperty('priceAmount');
    expect(patch).not.toHaveProperty('referencePriceAmount');
  });

  it('bascule Payant → Gratuit : envoie priceAmount à 0, ne touche pas au prix habituel non rendu', () => {
    const patch = diffOfferPatch(original({ priceAmount: 1500, referencePriceAmount: null }), {
      ...unrelatedNextFields,
      title: 'Cours découverte',
      priceAmount: 0,
      referencePriceAmount: undefined,
    });

    expect(patch).toEqual({ priceAmount: 0 });
  });

  it('bascule Gratuit → Payant : envoie le nouveau prix découverte et le prix habituel saisi', () => {
    const patch = diffOfferPatch(original({ priceAmount: 0, referencePriceAmount: null }), {
      ...unrelatedNextFields,
      title: 'Cours découverte',
      priceAmount: 1200,
      referencePriceAmount: 1500,
    });

    expect(patch).toEqual({ priceAmount: 1200, referencePriceAmount: 1500 });
  });

  it('champ rendu, effacé volontairement par le gérant : envoie referencePriceAmount: null', () => {
    const patch = diffOfferPatch(original({ priceAmount: 1000, referencePriceAmount: 2200 }), {
      ...unrelatedNextFields,
      title: 'Cours découverte',
      priceAmount: 1000,
      referencePriceAmount: null,
    });

    expect(patch).toEqual({ referencePriceAmount: null });
  });

  it('champ rendu, inchangé : aucun champ de prix dans le patch', () => {
    const patch = diffOfferPatch(original({ priceAmount: 1000, referencePriceAmount: 2200 }), {
      ...unrelatedNextFields,
      title: 'Cours découverte',
      priceAmount: 1000,
      referencePriceAmount: 2200,
    });

    expect(patch).toEqual({});
  });
});
