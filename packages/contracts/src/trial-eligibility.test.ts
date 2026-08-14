import { describe, expect, it } from 'vitest';
import { evaluateTrialEligibility } from './trial-eligibility.js';
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
