import { LEAD_STATUSES } from './enums.js';
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

/**
 * Ce que chaque statut est, pour les deux règles qui en dépendent.
 *
 * `Record<LeadStatus, LeadStatusRole>` et non trois listes : la règle « à sens
 * unique » ne tient que si *tout* statut est classé. Un statut ajouté à
 * `LEAD_STATUSES` et absent d'une liste littérale était par défaut « pas possédé
 * par le gérant » — donc écrasable par un avis client arrivé trois jours plus
 * tard. C'est exactement le retour en arrière que ce fichier existe pour
 * interdire. Ici, l'oubli ne compile pas.
 */
interface LeadStatusRole {
  /**
   * Statut posé délibérément par la salle ; l'automatisation ne doit pas
   * l'écraser.
   */
  readonly operatorOwned: boolean;
  /** Rien ne se passe plus après : le lead est signé ou perdu. */
  readonly terminal: boolean;
  /**
   * Position dans l'entonnoir pour le reporting, `null` quand le statut est hors
   * entonnoir. `LOST` n'est pas une étape : c'est une sortie.
   */
  readonly funnelRank: number | null;
}

const LEAD_STATUS_ROLE: Record<LeadStatus, LeadStatusRole> = {
  NEW: { operatorOwned: false, terminal: false, funnelRank: 0 },
  ATTENDED: { operatorOwned: false, terminal: false, funnelRank: 1 },
  INTERESTED: { operatorOwned: false, terminal: false, funnelRank: 2 },
  CONTACTED: { operatorOwned: true, terminal: false, funnelRank: 3 },
  CONVERTED: { operatorOwned: true, terminal: true, funnelRank: 4 },
  LOST: { operatorOwned: true, terminal: true, funnelRank: null },
};

export function isOperatorOwnedStatus(status: LeadStatus): boolean {
  return LEAD_STATUS_ROLE[status].operatorOwned;
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

/**
 * Ordering used for funnel reporting; not a constraint on transitions.
 *
 * Dérivé de `LEAD_STATUS_ROLE` : une liste écrite à la main pouvait omettre un
 * statut sans que rien ne le signale, et l'entonnoir aurait alors compté faux.
 */
export const LEAD_PIPELINE_ORDER: readonly LeadStatus[] = LEAD_STATUSES.map((status) => ({
  status,
  rank: LEAD_STATUS_ROLE[status].funnelRank,
}))
  .filter((entry): entry is { status: LeadStatus; rank: number } => entry.rank !== null)
  .sort((a, b) => a.rank - b.rank)
  .map((entry) => entry.status);

export function isTerminalLeadStatus(status: LeadStatus): boolean {
  return LEAD_STATUS_ROLE[status].terminal;
}
