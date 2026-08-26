import { describe, expect, it } from 'vitest';
import { EXPERIENCE_TYPES, TRIAL_RULES } from './enums.js';
import {
  carriesDiscoveryPrice,
  DISCOVERY_PRICED_EXPERIENCE_TYPES,
  evaluateTrialEligibility,
  offerTrialConfigurationIsCoherent,
} from './trial-eligibility.js';
import type { TrialHistoryEntry } from './trial-eligibility.js';

const BUSINESS = 'business-1';
const VENUE_A = 'venue-a';
const VENUE_B = 'venue-b';
const OFFER_1 = 'offer-1';
const OFFER_2 = 'offer-2';

const entry = (overrides: Partial<TrialHistoryEntry> = {}): TrialHistoryEntry => ({
  businessId: BUSINESS,
  venueId: VENUE_A,
  offerId: OFFER_1,
  status: 'COMPLETED',
  ...overrides,
});

const query = (rule: Parameters<typeof evaluateTrialEligibility>[0]['rule'], history: TrialHistoryEntry[]) => ({
  rule,
  businessId: BUSINESS,
  venueId: VENUE_A,
  offerId: OFFER_1,
  history,
});

describe('trial eligibility', () => {
  it('allows a first-time user under every rule', () => {
    for (const rule of [
      'ONE_TRIAL_PER_BUSINESS',
      'ONE_TRIAL_PER_VENUE',
      'ONE_TRIAL_PER_OFFER',
      'NO_RESTRICTION',
    ] as const) {
      expect(evaluateTrialEligibility(query(rule, [])).eligible).toBe(true);
    }
  });

  it('blocks a second trial at the same venue by default', () => {
    const result = evaluateTrialEligibility(query('ONE_TRIAL_PER_VENUE', [entry()]));
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toBe('ALREADY_TRIED_THIS_VENUE');
  });

  it('lets a chain’s other venues still offer a trial under the per-venue rule', () => {
    // Basic-Fit has ~100 venues; per-business would be far too strict.
    const result = evaluateTrialEligibility(
      query('ONE_TRIAL_PER_VENUE', [entry({ venueId: VENUE_B })]),
    );
    expect(result.eligible).toBe(true);
  });

  it('blocks across every venue of the chain under the per-business rule', () => {
    const result = evaluateTrialEligibility(
      query('ONE_TRIAL_PER_BUSINESS', [entry({ venueId: VENUE_B, offerId: OFFER_2 })]),
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toBe('ALREADY_TRIED_THIS_BUSINESS');
  });

  it('only blocks the same offer under the per-offer rule', () => {
    expect(
      evaluateTrialEligibility(query('ONE_TRIAL_PER_OFFER', [entry({ offerId: OFFER_2 })])).eligible,
    ).toBe(true);
    expect(evaluateTrialEligibility(query('ONE_TRIAL_PER_OFFER', [entry()])).eligible).toBe(false);
  });

  it('ignores cancelled, expired and refunded history', () => {
    const harmless = [
      entry({ status: 'CANCELLED_USER' }),
      entry({ status: 'CANCELLED_BUSINESS' }),
      entry({ status: 'EXPIRED' }),
      entry({ status: 'REFUNDED' }),
    ];
    expect(evaluateTrialEligibility(query('ONE_TRIAL_PER_VENUE', harmless)).eligible).toBe(true);
  });

  it('counts an in-flight booking so a user cannot hold several trials at once', () => {
    for (const status of ['PENDING', 'PAYMENT_PENDING', 'CONFIRMED'] as const) {
      expect(
        evaluateTrialEligibility(query('ONE_TRIAL_PER_VENUE', [entry({ status })])).eligible,
      ).toBe(false);
    }
  });

  it('counts a no-show as consumed', () => {
    expect(
      evaluateTrialEligibility(query('ONE_TRIAL_PER_VENUE', [entry({ status: 'NO_SHOW' })]))
        .eligible,
    ).toBe(false);
  });

  it('never blocks under NO_RESTRICTION', () => {
    expect(evaluateTrialEligibility(query('NO_RESTRICTION', [entry(), entry()])).eligible).toBe(
      true,
    );
  });

  it('reports which reservation consumed the allowance', () => {
    const consumed = entry({ status: 'COMPLETED' });
    const result = evaluateTrialEligibility(
      query('ONE_TRIAL_PER_VENUE', [entry({ status: 'CANCELLED_USER' }), consumed]),
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.conflictingEntry).toEqual(consumed);
  });
});

/**
 * Le tarif de découverte et l'allocation d'essai vont ensemble.
 *
 * Cette table est la garde d'exhaustivité de `EXPERIENCE_TYPES` : ajouter un
 * type d'expérience sans dire s'il porte un tarif de découverte ne compile pas.
 * Ces assertions vérifient l'autre moitié — que la table dit la bonne chose.
 */
describe('tarif découverte et portée d’essai', () => {
  it('classe chaque type d’expérience, sans trou', () => {
    for (const experienceType of EXPERIENCE_TYPES) {
      expect(typeof carriesDiscoveryPrice(experienceType)).toBe('boolean');
    }
  });

  it('reconnaît les deux formes de séance découverte', () => {
    // Cette liste comptait `DISCOVERY_PACK` jusqu'à l'arbitrage du 2026-08-26 :
    // ce test décrivait donc la règle inverse, et la règle a changé — ce n'est
    // pas un test affaibli pour faire passer du code.
    expect(DISCOVERY_PRICED_EXPERIENCE_TYPES).toEqual(['FREE_TRIAL', 'DISCOVERY_PRICE']);
  });

  it('ne compte pas comme découverte ce que la salle vend elle-même', () => {
    for (const experienceType of ['INITIATION', 'DAY_PASS', 'BEGINNER_CLASS', 'PREMIUM_EXPERIENCE'] as const) {
      expect(carriesDiscoveryPrice(experienceType)).toBe(false);
    }
  });

  it('laisse le pack découverte hors de l’allocation d’essai', () => {
    // Le pack est le produit qui *suit* l'essai, pas une seconde forme d'essai.
    // Le faire consommer l'allocation le rendait inachetable par le client qui
    // venait justement de faire son essai gratuit dans ce lieu.
    expect(carriesDiscoveryPrice('DISCOVERY_PACK')).toBe(false);
    expect(DISCOVERY_PRICED_EXPERIENCE_TYPES).not.toContain('DISCOVERY_PACK');
  });

  it('interdit « aucune restriction » à une offre découverte', () => {
    for (const experienceType of DISCOVERY_PRICED_EXPERIENCE_TYPES) {
      expect(
        offerTrialConfigurationIsCoherent({ experienceType, trialRule: 'NO_RESTRICTION' }),
      ).toBe(false);
    }
  });

  it('accepte n’importe quelle portée réelle sur une offre découverte', () => {
    for (const experienceType of DISCOVERY_PRICED_EXPERIENCE_TYPES) {
      for (const trialRule of TRIAL_RULES.filter((rule) => rule !== 'NO_RESTRICTION')) {
        expect(offerTrialConfigurationIsCoherent({ experienceType, trialRule })).toBe(true);
      }
    }
  });

  it('laisse une offre au tarif normal libre de toute portée', () => {
    for (const trialRule of TRIAL_RULES) {
      expect(offerTrialConfigurationIsCoherent({ experienceType: 'DAY_PASS', trialRule })).toBe(
        true,
      );
    }
  });
});
