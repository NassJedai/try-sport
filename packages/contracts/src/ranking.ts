/**
 * Discovery ranking.
 *
 * Deliberately a transparent weighted sum of normalised signals rather than an
 * opaque model: at this stage we need to be able to explain to a venue why it
 * ranks where it does, and to unit-test that a closer, better-converting offer
 * outranks a distant one. Each signal is normalised to [0, 1] so the weights are
 * directly comparable and sum to 1.
 */

export interface RankingWeights {
  readonly distance: number;
  readonly personalization: number;
  readonly rating: number;
  readonly conversionQuality: number;
  readonly availability: number;
  readonly freshness: number;
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  distance: 0.3,
  personalization: 0.25,
  rating: 0.15,
  conversionQuality: 0.12,
  availability: 0.13,
  freshness: 0.05,
};

export interface RankingSignals {
  readonly distanceMeters: number;
  /** How far the user is willing to travel; distance decays to 0 at this radius. */
  readonly searchRadiusMeters: number;
  /** True when the offer's category is one the user selected during onboarding. */
  readonly matchesUserInterests: boolean;
  /** Average rating in [0, 5]; null when the venue has no reviews yet. */
  readonly averageRating: number | null;
  readonly reviewCount: number;
  /** Share of trials at this venue that turned into customers, in [0, 1]. */
  readonly conversionRate: number | null;
  readonly openSlotsNext7Days: number;
  readonly hasSlotToday: boolean;
  readonly publishedAt: Date;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Linear decay, not a step function: a 1.1 km venue should not fall off a cliff
 * versus a 0.9 km one just because the user picked a "1 km" chip.
 */
export function distanceScore(distanceMeters: number, radiusMeters: number): number {
  if (radiusMeters <= 0) return 0;
  return clamp01(1 - distanceMeters / radiusMeters);
}

/**
 * Bayesian-shrunk rating. A single 5★ review must not outrank a venue with 200
 * reviews averaging 4.8, so ratings are pulled towards the platform mean until
 * enough reviews accumulate.
 */
export function ratingScore(
  averageRating: number | null,
  reviewCount: number,
  priorMean = 4.2,
  priorWeight = 10,
): number {
  if (averageRating === null || reviewCount <= 0) return priorMean / 5;
  const shrunk =
    (averageRating * reviewCount + priorMean * priorWeight) / (reviewCount + priorWeight);
  return clamp01(shrunk / 5);
}

/**
 * Rewards venues whose trials actually turn into customers. This is what keeps
 * the marketplace healthy: ranking on bookings alone would promote venues that
 * are good at attracting trials and bad at converting them.
 */
export function conversionQualityScore(conversionRate: number | null): number {
  if (conversionRate === null) return 0.5; // Unproven venues start neutral, not last.
  // 30% trial-to-customer conversion is treated as excellent for this market.
  return clamp01(conversionRate / 0.3);
}

export function availabilityScore(openSlotsNext7Days: number, hasSlotToday: boolean): number {
  // Saturates at 10 slots: beyond that, more availability is not more useful.
  const supply = clamp01(openSlotsNext7Days / 10);
  return clamp01(supply * 0.7 + (hasSlotToday ? 0.3 : 0));
}

export function freshnessScore(publishedAt: Date, now: Date, halfLifeDays = 30): number {
  const ageDays = Math.max(0, (now.getTime() - publishedAt.getTime()) / 86_400_000);
  return clamp01(Math.exp((-Math.LN2 * ageDays) / halfLifeDays));
}

export interface RankingBreakdown {
  readonly total: number;
  readonly components: Record<keyof RankingWeights, number>;
}

/**
 * Returns the breakdown, not just the total, so the admin app can show why an
 * offer ranks where it does and so regressions are debuggable.
 */
export function scoreOffer(
  signals: RankingSignals,
  now: Date,
  weights: RankingWeights = DEFAULT_RANKING_WEIGHTS,
): RankingBreakdown {
  const components = {
    distance: distanceScore(signals.distanceMeters, signals.searchRadiusMeters),
    personalization: signals.matchesUserInterests ? 1 : 0,
    rating: ratingScore(signals.averageRating, signals.reviewCount),
    conversionQuality: conversionQualityScore(signals.conversionRate),
    availability: availabilityScore(signals.openSlotsNext7Days, signals.hasSlotToday),
    freshness: freshnessScore(signals.publishedAt, now),
  } satisfies Record<keyof RankingWeights, number>;

  const total = (Object.keys(components) as (keyof RankingWeights)[]).reduce(
    (sum, key) => sum + components[key] * weights[key],
    0,
  );

  return { total, components };
}
