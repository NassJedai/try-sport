import { describe, expect, it } from 'vitest';
import { LEAD_STATUSES } from './enums.js';
import {
  isOperatorOwnedStatus,
  isTerminalLeadStatus,
  leadStatusAfterContinuation,
} from './lead-pipeline.js';

describe('lead pipeline', () => {
  it('promotes an attended trial to INTERESTED on "oui"', () => {
    expect(leadStatusAfterContinuation('ATTENDED', 'YES')).toBe('INTERESTED');
    expect(leadStatusAfterContinuation('NEW', 'YES')).toBe('INTERESTED');
  });

  it('writes off the lead on "non"', () => {
    expect(leadStatusAfterContinuation('ATTENDED', 'NO')).toBe('LOST');
  });

  it('does not treat "peut-être" as a hot lead', () => {
    // Handing a venue a lukewarm lead as INTERESTED wastes their time and
    // erodes trust in the pipeline they are paying for.
    expect(leadStatusAfterContinuation('ATTENDED', 'MAYBE')).toBe('ATTENDED');
    expect(leadStatusAfterContinuation('NEW', 'MAYBE')).toBe('ATTENDED');
  });

  it('never drags a lead backwards once the venue has acted', () => {
    // The late-review case: the venue already phoned and signed this person up.
    for (const answer of ['YES', 'MAYBE', 'NO'] as const) {
      expect(leadStatusAfterContinuation('CONTACTED', answer)).toBe('CONTACTED');
      expect(leadStatusAfterContinuation('CONVERTED', answer)).toBe('CONVERTED');
      expect(leadStatusAfterContinuation('LOST', answer)).toBe('LOST');
    }
  });

  it('marks a lead as attended when a review arrives without an answer', () => {
    expect(leadStatusAfterContinuation('NEW', null)).toBe('ATTENDED');
    expect(leadStatusAfterContinuation('NEW', undefined)).toBe('ATTENDED');
  });

  it('leaves an already-progressed status untouched when there is no answer', () => {
    expect(leadStatusAfterContinuation('INTERESTED', null)).toBe('INTERESTED');
  });

  it('identifies operator-owned and terminal statuses', () => {
    expect(isOperatorOwnedStatus('CONTACTED')).toBe(true);
    expect(isOperatorOwnedStatus('ATTENDED')).toBe(false);
    expect(isTerminalLeadStatus('CONVERTED')).toBe(true);
    expect(isTerminalLeadStatus('LOST')).toBe(true);
    expect(isTerminalLeadStatus('INTERESTED')).toBe(false);
  });

  it('returns a valid status for every input combination', () => {
    for (const status of LEAD_STATUSES) {
      for (const answer of ['YES', 'MAYBE', 'NO', null] as const) {
        expect(LEAD_STATUSES).toContain(leadStatusAfterContinuation(status, answer));
      }
    }
  });
});
