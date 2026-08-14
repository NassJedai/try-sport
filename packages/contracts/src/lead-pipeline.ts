import type { ContinuationAnswer, LeadStatus } from './enums.js';

/**
 * The lead pipeline.
 *
 * A lead may be advanced by two independent actors: the consumer, by answering
 * the continuation question, and the venue, by working its CRM. They can arrive
 * out of order — someone reviews their session three days late, after the venue
 * has already phoned them and signed them up.
 *
 * The rule is that an automatic transition never drags a lead *backwards*. A
 * venue that has already contacted, converted or written off a person must not
 * see them reappear as a fresh "interested" lead because of a late review.
 */

/** Statuses a venue has deliberately set; automation must not overwrite them. */
const OPERATOR_OWNED: readonly LeadStatus[] = ['CONTACTED', 'CONVERTED', 'LOST'];

export function isOperatorOwnedStatus(status: LeadStatus): boolean {
  return OPERATOR_OWNED.includes(status);
}

/**
 * Resolves the status implied by a continuation answer, given where the lead
 * already is. Returns the *current* status when automation must not intervene.
 */
export function leadStatusAfterContinuation(
  current: LeadStatus,
  answer: ContinuationAnswer | null | undefined,
): LeadStatus {
  if (isOperatorOwnedStatus(current)) return current;
  if (!answer) return current === 'NEW' ? 'ATTENDED' : current;

  switch (answer) {
    case 'YES':
      return 'INTERESTED';
    case 'NO':
      return 'LOST';
    case 'MAYBE':
      // Explicitly not INTERESTED: telling a venue "maybe" is a hot lead would
      // waste the venue's time and erode trust in the pipeline.
      return 'ATTENDED';
  }
}

/** Ordering used for funnel reporting; not a constraint on transitions. */
export const LEAD_PIPELINE_ORDER: readonly LeadStatus[] = [
  'NEW',
  'ATTENDED',
  'INTERESTED',
  'CONTACTED',
  'CONVERTED',
];

export function isTerminalLeadStatus(status: LeadStatus): boolean {
  return status === 'CONVERTED' || status === 'LOST';
}
