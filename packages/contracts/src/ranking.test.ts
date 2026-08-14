import { describe, expect, it } from 'vitest';
import {
  availabilityScore,
  conversionQualityScore,
  DEFAULT_RANKING_WEIGHTS,
  distanceScore,
  freshnessScore,
  ratingScore,
  scoreOffer,
} from './ranking.js';
import type { RankingSignals } from './ranking.js';
import { assessCancellation } from './cancellation-policy.js';

const NOW = new Date('2026-07-15T10:00:00Z');

const signals = (overrides: Partial<RankingSignals> = {}): RankingSignals => ({
  distanceMeters: 1000,
  searchRadiusMeters: 5000,
  matchesUserInterests: false,
  averageRating: 4.5,
  reviewCount: 40,
  conversionRate: 0.2,
  openSlotsNext7Days: 5,
  hasSlotToday: false,
  publishedAt: new Date('2026-07-01T10:00:00Z'),
  ...overrides,
});

describe('ranking components', () => {
  it('decays distance linearly and clamps beyond the radius', () => {
    expect(distanceScore(0, 5000)).toBe(1);
    expect(distanceScore(2500, 5000)).toBeCloseTo(0.5);
    expect(distanceScore(9000, 5000)).toBe(0);
  });

  it('shrinks ratings towards the prior so one 5-star review cannot win', () => {
    const oneGlowingReview = ratingScore(5, 1);
    const establishedVenue = ratingScore(4.8, 200);
    expect(establishedVenue).toBeGreaterThan(oneGlowingReview);
  });

  it('treats an unrated venue as average rather than worst', () => {
    expect(ratingScore(null, 0)).toBeCloseTo(4.2 / 5);
  });

  it('gives unproven venues a neutral conversion score', () => {
    expect(conversionQualityScore(null)).toBe(0.5);
    expect(conversionQualityScore(0)).toBe(0);
    expect(conversionQualityScore(0.3)).toBe(1);
    expect(conversionQualityScore(0.9)).toBe(1);
  });

  it('rewards availability today', () => {
    expect(availabilityScore(5, true)).toBeGreaterThan(availabilityScore(5, false));
    expect(availabilityScore(0, false)).toBe(0);
    expect(availabilityScore(50, true)).toBe(1);
  });

  it('decays freshness by half over the half-life', () => {
    expect(freshnessScore(NOW, NOW)).toBe(1);
    expect(freshnessScore(new Date('2026-06-15T10:00:00Z'), NOW, 30)).toBeCloseTo(0.5, 2);
  });
});

describe('offer scoring', () => {
  it('ranks a closer offer above an identical distant one', () => {
    const close = scoreOffer(signals({ distanceMeters: 400 }), NOW).total;
    const far = scoreOffer(signals({ distanceMeters: 4500 }), NOW).total;
    expect(close).toBeGreaterThan(far);
  });

  it('ranks a matching interest above a non-matching one', () => {
    const matching = scoreOffer(signals({ matchesUserInterests: true }), NOW).total;
    const other = scoreOffer(signals({ matchesUserInterests: false }), NOW).total;
    expect(matching).toBeGreaterThan(other);
  });

  it('ranks a better-converting venue above a trial magnet at equal distance', () => {
    // This is the point of the marketplace: attended and converted trials, not raw bookings.
    const converts = scoreOffer(signals({ conversionRate: 0.28 }), NOW).total;
    const doesNot = scoreOffer(signals({ conversionRate: 0.02 }), NOW).total;
    expect(converts).toBeGreaterThan(doesNot);
  });

  it('keeps the total within [0, 1] at both extremes', () => {
    const best = scoreOffer(
      signals({
        distanceMeters: 0,
        matchesUserInterests: true,
        averageRating: 5,
        reviewCount: 1000,
        conversionRate: 0.5,
        openSlotsNext7Days: 40,
        hasSlotToday: true,
        publishedAt: NOW,
      }),
      NOW,
    ).total;
    const worst = scoreOffer(
      signals({
        distanceMeters: 100_000,
        matchesUserInterests: false,
        averageRating: 1,
        reviewCount: 500,
        conversionRate: 0,
        openSlotsNext7Days: 0,
        hasSlotToday: false,
        publishedAt: new Date('2020-01-01T00:00:00Z'),
      }),
      NOW,
    ).total;

    expect(best).toBeLessThanOrEqual(1);
    expect(worst).toBeGreaterThanOrEqual(0);
    expect(best).toBeGreaterThan(worst);
  });

  it('exposes a breakdown so ranking can be explained to a venue', () => {
    const { components, total } = scoreOffer(signals(), NOW);
    expect(Object.keys(components).sort()).toEqual(Object.keys(DEFAULT_RANKING_WEIGHTS).sort());
    const recomputed = (Object.keys(components) as (keyof typeof components)[]).reduce(
      (sum, key) => sum + components[key] * DEFAULT_RANKING_WEIGHTS[key],
      0,
    );
    expect(total).toBeCloseTo(recomputed, 10);
  });

  it('uses weights that sum to 1 so components stay comparable', () => {
    const sum = Object.values(DEFAULT_RANKING_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe('cancellation policy', () => {
  const start = new Date('2026-07-15T18:00:00Z');

  it('refunds inside the free window', () => {
    const result = assessCancellation({
      policy: 'STANDARD',
      slotStartAt: start,
      now: new Date('2026-07-14T12:00:00Z'),
    });
    expect(result.canCancel).toBe(true);
    expect(result.refundable).toBe(true);
  });

  it('still allows cancelling outside the window, but without a refund', () => {
    // Blocking the cancellation would only manufacture a no-show.
    const result = assessCancellation({
      policy: 'STANDARD',
      slotStartAt: start,
      now: new Date('2026-07-15T17:00:00Z'),
    });
    expect(result.canCancel).toBe(true);
    expect(result.refundable).toBe(false);
  });

  it('refuses to cancel a session that already started', () => {
    const result = assessCancellation({
      policy: 'FLEXIBLE',
      slotStartAt: start,
      now: new Date('2026-07-15T18:30:00Z'),
    });
    expect(result.canCancel).toBe(false);
  });

  it('applies a wider window for the strict policy', () => {
    const at20hBefore = new Date('2026-07-14T22:00:00Z');
    expect(
      assessCancellation({ policy: 'STRICT', slotStartAt: start, now: at20hBefore }).refundable,
    ).toBe(false);
    expect(
      assessCancellation({ policy: 'STANDARD', slotStartAt: start, now: at20hBefore }).refundable,
    ).toBe(true);
  });
});
