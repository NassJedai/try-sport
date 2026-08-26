import { describe, expect, it } from 'vitest';
import { createOfferSchema, updateOfferSchema } from './offers.js';

const baseOffer = {
  venueId: '11111111-1111-4111-8111-111111111111',
  categoryId: '22222222-2222-4222-8222-222222222222',
  title: 'Cours découverte',
  description: 'Une première séance encadrée, ouverte à toutes et tous, sans engagement.',
  priceAmount: 0,
  durationMinutes: 60,
  capacity: 12,
};

/**
 * « Tarif découverte ⇒ allocation obligatoire ».
 *
 * C'est la règle qui fait de TRIALYA une marketplace de découverte plutôt qu'un
 * site de bons plans : une offre au tarif de découverte se consomme une fois
 * dans une portée. `NO_RESTRICTION` sur un essai gratuit rend cet essai
 * répétable à l'infini — le gérant offre alors sa salle, indéfiniment, sans
 * l'avoir voulu.
 */
describe('cohérence tarif découverte / allocation d’essai', () => {
  it('refuse un essai gratuit sans aucune restriction', () => {
    const result = createOfferSchema.safeParse({
      ...baseOffer,
      experienceType: 'FREE_TRIAL',
      trialRule: 'NO_RESTRICTION',
    });

    expect(result.success).toBe(false);
    // Le refus doit nommer le champ à corriger : le gérant voit quel réglage
    // reprendre, pas un formulaire rouge sans explication.
    expect(result.error?.issues[0]?.path).toEqual(['trialRule']);
  });

  it('refuse aussi un prix découverte sans restriction', () => {
    // Ce test couvrait également `DISCOVERY_PACK` jusqu'à l'arbitrage du
    // 2026-08-26 : il décrivait la règle inverse, et la règle a changé. Le cas
    // du pack est désormais asserté positivement plus bas, comme offre normale.
    expect(
      createOfferSchema.safeParse({
        ...baseOffer,
        priceAmount: 1000,
        experienceType: 'DISCOVERY_PRICE',
        trialRule: 'NO_RESTRICTION',
      }).success,
    ).toBe(false);
  });

  it('accepte les trois portées sur une offre découverte', () => {
    for (const trialRule of [
      'ONE_TRIAL_PER_BUSINESS',
      'ONE_TRIAL_PER_VENUE',
      'ONE_TRIAL_PER_OFFER',
    ] as const) {
      expect(
        createOfferSchema.safeParse({ ...baseOffer, experienceType: 'FREE_TRIAL', trialRule })
          .success,
      ).toBe(true);
    }
  });

  it('laisse une offre au tarif normal sans restriction', () => {
    // Un pass journée ou un cours premium se vend autant de fois que le client
    // le souhaite : lui imposer une allocation d'essai n'aurait aucun sens.
    //
    // `DISCOVERY_PACK` est ici depuis le 2026-08-26 : c'est un produit que la
    // salle conçoit et tarifie elle-même, vendu *après* l'essai. Un pack en
    // « aucune restriction » est donc une configuration légitime.
    for (const experienceType of ['DAY_PASS', 'PREMIUM_EXPERIENCE', 'INITIATION', 'DISCOVERY_PACK'] as const) {
      expect(
        createOfferSchema.safeParse({
          ...baseOffer,
          priceAmount: 2500,
          experienceType,
          trialRule: 'NO_RESTRICTION',
        }).success,
      ).toBe(true);
    }
  });

  it('applique la portée par défaut quand le gérant n’en choisit aucune', () => {
    // L'assistant d'inscription n'envoie pas `trialRule` : sans ce défaut, la
    // contrainte ci-dessus refuserait toutes les offres qu'il crée.
    const parsed = createOfferSchema.parse({ ...baseOffer, experienceType: 'FREE_TRIAL' });
    expect(parsed.trialRule).toBe('ONE_TRIAL_PER_VENUE');
  });
});

/**
 * La contrainte croisée ne doit pas déborder sur la mise à jour partielle :
 * `updateOfferSchema` dérive de la base nue, parce qu'en Zod 4 un `refine`
 * empêche `.omit()` et que la règle a besoin des deux champs, dont l'un vit
 * dans la ligne existante.
 */
describe('mise à jour partielle et contrainte croisée', () => {
  it('accepte encore une correction de titre seule', () => {
    expect(updateOfferSchema.parse({ title: 'Cours découverte du samedi' })).toEqual({
      title: 'Cours découverte du samedi',
    });
  });

  it('laisse passer `trialRule` seul — c’est au service de trancher', () => {
    // Le schéma n'a pas le type d'expérience sous la main ici. Le service doit
    // rappeler `offerTrialConfigurationIsCoherent` sur la fusion avec la ligne
    // existante avant d'écrire.
    expect(updateOfferSchema.parse({ trialRule: 'NO_RESTRICTION' })).toEqual({
      trialRule: 'NO_RESTRICTION',
    });
  });
});
