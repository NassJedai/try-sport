import { consumesTrial } from './reservation-state-machine.js';
import { EXPERIENCE_TYPES } from './enums.js';
import type { ExperienceType, ReservationStatus, TrialRule } from './enums.js';

/**
 * Trial eligibility is the rule that makes TRY a discovery marketplace rather
 * than a discount site: a user gets the introductory price once, then converts
 * to the venue's normal pricing. It is evaluated on the server only.
 */

/* ---------------------------------------------------------------------------
 * Cohérence d'une offre : tarif découverte ⇒ allocation obligatoire
 * ------------------------------------------------------------------------ */

/**
 * Cette offre vend-elle un tarif de découverte ?
 *
 * Règle métier, en une phrase : **une offre dont le prix est un tarif de
 * découverte doit obligatoirement consommer une allocation d'essai dans une
 * portée ; seule une offre au tarif normal peut être en `NO_RESTRICTION`.**
 *
 * Sans cette contrainte, `NO_RESTRICTION` sur un `FREE_TRIAL` rend l'essai
 * gratuit répétable à l'infini : ce n'est plus une marketplace de découverte,
 * c'est un site de bons plans. Le gérant choisit la *portée* — établissement,
 * lieu ou offre —, jamais le *nombre* : une seule séance découverte est une
 * règle de plateforme.
 *
 * `Record<ExperienceType, boolean>` et non une liste : la table est exhaustive
 * par construction. Ajouter un type d'expérience à `EXPERIENCE_TYPES` sans dire
 * s'il porte un tarif de découverte casse la compilation, au lieu de répondre
 * « non » en silence — et « non » est justement la réponse qui laisse fuir
 * l'argent.
 *
 * **Ce que cette table protège, et ce qu'elle ne protège pas.** L'allocation
 * d'essai protège *la séance découverte offerte par la plateforme* — celle qui
 * fait de TRIALYA une marketplace de découverte. Elle ne prétend pas encadrer
 * tout tarif attractif : ce qu'une salle décide de vendre au-delà de l'essai
 * relève de son commerce, pas d'une règle de plateforme.
 */
const CARRIES_DISCOVERY_PRICE: Record<ExperienceType, boolean> = {
  FREE_TRIAL: true,
  DISCOVERY_PRICE: true,
  /**
   * **Non** — arbitré le 2026-08-26, après avoir été classé `true` à tort.
   *
   * Le pack est le produit qui **suit** l'essai, pas une seconde forme d'essai.
   * `CLAUDE.md` en fait la réponse sanctionnée à « je veux offrir plusieurs
   * séances découvertes » : « une offre distincte à tarification propre, jamais
   * en assouplissant l'allocation d'essai ». Le classer comme tarif de
   * découverte le ferait consommer l'allocation qu'il est censé contourner
   * proprement.
   *
   * La conséquence était décisive : un pack consommant l'allocation devenait
   * inachetable par le client ayant déjà fait son essai gratuit dans le même
   * lieu — c'est-à-dire par le client le plus intéressé, et c'est exactement le
   * chemin de conversion pour lequel le pack existe. Une règle anti-abus qui
   * empêche la vente se trompe de cible.
   *
   * **Déclencheur d'un réexamen** : le jour où un pack serait vendu *au-dessous*
   * du tarif découverte de la même salle. Le pack cesserait alors d'être le
   * produit d'après pour redevenir une porte d'entrée moins chère que la porte
   * d'entrée — et cette table devrait être rouverte.
   */
  DISCOVERY_PACK: false,
  /** Un cours d'initiation est vendu à son prix : il s'adresse aux débutants, pas aux nouveaux venus. */
  INITIATION: false,
  DAY_PASS: false,
  BEGINNER_CLASS: false,
  PREMIUM_EXPERIENCE: false,
};

export function carriesDiscoveryPrice(experienceType: ExperienceType): boolean {
  return CARRIES_DISCOVERY_PRICE[experienceType];
}

/** Prêt pour une interface : les types qui exigent une portée d'essai. */
export const DISCOVERY_PRICED_EXPERIENCE_TYPES: readonly ExperienceType[] =
  EXPERIENCE_TYPES.filter(carriesDiscoveryPrice);

export interface OfferTrialConfiguration {
  readonly experienceType: ExperienceType;
  readonly trialRule: TrialRule;
}

/**
 * « Cette offre a-t-elle une configuration d'essai cohérente ? »
 *
 * Vérifiable dès la création, où les deux champs sont présents — d'où le
 * `.check()` de `createOfferSchema`. Sur une **mise à jour partielle**, elle ne
 * l'est pas : le DTO peut ne porter que `trialRule`, et le type d'expérience
 * vit alors dans la ligne existante. Le service doit donc rappeler ce prédicat
 * sur la fusion `{ ...existing, ...dto }` avant d'écrire — c'est la seule
 * couche qui a les deux valeurs sous la main.
 */
export function offerTrialConfigurationIsCoherent(offer: OfferTrialConfiguration): boolean {
  return !(carriesDiscoveryPrice(offer.experienceType) && offer.trialRule === 'NO_RESTRICTION');
}

/** Le message rendu au gérant, en français, quand la configuration est incohérente. */
export const INCOHERENT_TRIAL_RULE_MESSAGE =
  'Une offre découverte doit limiter l’essai à une portée (établissement, lieu ou offre) : « aucune restriction » est réservé aux offres au tarif normal.';

export interface TrialHistoryEntry {
  readonly businessId: string;
  readonly venueId: string;
  readonly offerId: string;
  readonly status: ReservationStatus;
}

export interface TrialEligibilityQuery {
  readonly rule: TrialRule;
  readonly businessId: string;
  readonly venueId: string;
  readonly offerId: string;
  /**
   * The user's prior reservations, already narrowed to the relevant business.
   * Statuses are filtered here rather than by the caller so the "does a
   * cancellation count?" decision lives in one place.
   */
  readonly history: readonly TrialHistoryEntry[];
}

export const TRIAL_INELIGIBILITY_REASONS = [
  'ALREADY_TRIED_THIS_BUSINESS',
  'ALREADY_TRIED_THIS_VENUE',
  'ALREADY_TRIED_THIS_OFFER',
] as const;
export type TrialIneligibilityReason = (typeof TRIAL_INELIGIBILITY_REASONS)[number];

export type TrialEligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly reason: TrialIneligibilityReason;
      /** The reservation that consumed the allowance, for a specific error message. */
      readonly conflictingEntry: TrialHistoryEntry;
    };

export function evaluateTrialEligibility(query: TrialEligibilityQuery): TrialEligibility {
  const { rule, businessId, venueId, offerId, history } = query;

  if (rule === 'NO_RESTRICTION') return { eligible: true };

  const consumed = history.filter((entry) => consumesTrial(entry.status));

  const conflict = consumed.find((entry) => {
    switch (rule) {
      case 'ONE_TRIAL_PER_BUSINESS':
        return entry.businessId === businessId;
      case 'ONE_TRIAL_PER_VENUE':
        return entry.venueId === venueId;
      case 'ONE_TRIAL_PER_OFFER':
        return entry.offerId === offerId;
    }
  });

  if (!conflict) return { eligible: true };

  const reason: TrialIneligibilityReason =
    rule === 'ONE_TRIAL_PER_BUSINESS'
      ? 'ALREADY_TRIED_THIS_BUSINESS'
      : rule === 'ONE_TRIAL_PER_VENUE'
        ? 'ALREADY_TRIED_THIS_VENUE'
        : 'ALREADY_TRIED_THIS_OFFER';

  return { eligible: false, reason, conflictingEntry: conflict };
}

/** User-facing copy in French; the API returns the code and the client may re-map it. */
export const TRIAL_INELIGIBILITY_MESSAGES: Record<TrialIneligibilityReason, string> = {
  ALREADY_TRIED_THIS_BUSINESS:
    'Tu as déjà profité d’une séance découverte chez cet établissement.',
  ALREADY_TRIED_THIS_VENUE: 'Tu as déjà profité d’une séance découverte dans ce lieu.',
  ALREADY_TRIED_THIS_OFFER: 'Tu as déjà réservé cette offre découverte.',
};
