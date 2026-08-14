import { consumesTrial } from './reservation-state-machine.js';
import type { ReservationStatus, TrialRule } from './enums.js';

/**
 * Trial eligibility is the rule that makes TRY a discovery marketplace rather
 * than a discount site: a user gets the introductory price once, then converts
 * to the venue's normal pricing. It is evaluated on the server only.
 */

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
