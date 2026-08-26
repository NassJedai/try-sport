import { describe, expect, it } from 'vitest';
import { CONTINUATION_ANSWERS, LEAD_STATUSES } from './enums.js';
import {
  isOperatorOwnedStatus,
  isTerminalLeadStatus,
  LEAD_PIPELINE_ORDER,
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

/**
 * La classification des statuts, désormais exhaustive par construction.
 *
 * La règle « à sens unique » ne tenait que parce qu'une liste littérale nommait
 * les trois statuts posés par le gérant. Un statut ajouté à `LEAD_STATUSES` en
 * était absent, donc réputé non possédé par la salle — et un avis client arrivé
 * trois jours plus tard pouvait le réécrire. C'est précisément le retour en
 * arrière que ce fichier interdit.
 */
describe('classification des statuts de lead', () => {
  it('classe chaque statut, sans trou', () => {
    for (const status of LEAD_STATUSES) {
      expect(typeof isOperatorOwnedStatus(status)).toBe('boolean');
      expect(typeof isTerminalLeadStatus(status)).toBe('boolean');
    }
  });

  it('protège tout statut possédé par le gérant contre l’automatisation', () => {
    // Le test générique que la liste littérale ne donnait pas : quel que soit le
    // statut classé « posé par le gérant », aucune réponse client ne le déplace.
    for (const status of LEAD_STATUSES.filter(isOperatorOwnedStatus)) {
      for (const answer of [...CONTINUATION_ANSWERS, null, undefined] as const) {
        expect(leadStatusAfterContinuation(status, answer)).toBe(status);
      }
    }
  });

  it('traite tout statut terminal comme possédé par le gérant', () => {
    // « Signé » et « perdu » sont des décisions commerciales : rien
    // d'automatique ne doit pouvoir en sortir.
    for (const status of LEAD_STATUSES.filter(isTerminalLeadStatus)) {
      expect(isOperatorOwnedStatus(status)).toBe(true);
    }
  });

  it('garde l’entonnoir ordonné et sans statut hors parcours', () => {
    expect(LEAD_PIPELINE_ORDER).toEqual(['NEW', 'ATTENDED', 'INTERESTED', 'CONTACTED', 'CONVERTED']);
    // `LOST` est une sortie, pas une étape : le compter dans l'entonnoir
    // gonflerait le taux de conversion de la salle.
    expect(LEAD_PIPELINE_ORDER).not.toContain('LOST');
  });
});
