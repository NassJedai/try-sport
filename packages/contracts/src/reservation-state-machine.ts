import { RESERVATION_STATUSES } from './enums.js';
import type { ReservationStatus } from './enums.js';

/**
 * Who is allowed to drive a transition. Authorisation is part of the state
 * machine rather than of the controller, so there is exactly one place that
 * decides whether a business may mark someone as a no-show.
 */
export const TRANSITION_ACTORS = ['USER', 'BUSINESS', 'ADMIN', 'SYSTEM'] as const;
export type TransitionActor = (typeof TRANSITION_ACTORS)[number];

interface Transition {
  readonly to: ReservationStatus;
  readonly actors: readonly TransitionActor[];
  readonly reason: string;
}

/**
 * The complete, explicit transition table. Anything absent from this table is
 * forbidden — there is no default-allow path.
 *
 * SYSTEM covers payment webhooks, expiry sweeps and post-session completion jobs.
 */
const TRANSITIONS: Record<ReservationStatus, readonly Transition[]> = {
  PENDING: [
    {
      to: 'PAYMENT_PENDING',
      actors: ['SYSTEM'],
      reason: 'Paid offer: a PaymentIntent was created and awaits client confirmation.',
    },
    {
      to: 'CONFIRMED',
      actors: ['SYSTEM'],
      reason: 'Free offer: nothing to collect, so the booking confirms immediately.',
    },
    { to: 'CANCELLED_USER', actors: ['USER'], reason: 'User abandoned before confirmation.' },
    {
      to: 'EXPIRED',
      actors: ['SYSTEM'],
      reason: 'Held capacity was never confirmed and has been released.',
    },
  ],

  PAYMENT_PENDING: [
    {
      to: 'CONFIRMED',
      actors: ['SYSTEM'],
      reason: 'Stripe reported payment_intent.succeeded.',
    },
    { to: 'CANCELLED_USER', actors: ['USER'], reason: 'User abandoned the payment sheet.' },
    {
      to: 'EXPIRED',
      actors: ['SYSTEM'],
      reason: 'Payment was never completed within the hold window.',
    },
    {
      to: 'CANCELLED_BUSINESS',
      actors: ['BUSINESS', 'ADMIN'],
      reason: 'Session was cancelled while payment was still in flight.',
    },
  ],

  CONFIRMED: [
    {
      to: 'CHECKED_IN',
      actors: ['BUSINESS', 'ADMIN'],
      reason: 'Staff validated the QR code or short code at the venue.',
    },
    { to: 'CANCELLED_USER', actors: ['USER'], reason: 'User cancelled within the policy window.' },
    {
      to: 'CANCELLED_BUSINESS',
      actors: ['BUSINESS', 'ADMIN'],
      reason: 'Venue cancelled the session.',
    },
    {
      to: 'NO_SHOW',
      actors: ['BUSINESS', 'ADMIN', 'SYSTEM'],
      reason: 'Session elapsed without a check-in.',
    },
  ],

  CHECKED_IN: [
    {
      to: 'COMPLETED',
      actors: ['SYSTEM', 'BUSINESS', 'ADMIN'],
      reason: 'Session finished; the trial now counts as consumed.',
    },
    {
      to: 'CANCELLED_BUSINESS',
      actors: ['ADMIN'],
      reason: 'Admin correction after an erroneous check-in.',
    },
  ],

  COMPLETED: [
    { to: 'REFUNDED', actors: ['ADMIN'], reason: 'Support refunded a completed session.' },
  ],

  // Refunds remain reachable from cancellations because money may already have moved.
  CANCELLED_USER: [
    { to: 'REFUNDED', actors: ['SYSTEM', 'ADMIN'], reason: 'Refund issued for a paid booking.' },
  ],
  CANCELLED_BUSINESS: [
    {
      to: 'REFUNDED',
      actors: ['SYSTEM', 'ADMIN'],
      reason: 'Venue cancelled a paid booking; the user is always refunded.',
    },
  ],
  NO_SHOW: [
    {
      to: 'REFUNDED',
      actors: ['ADMIN'],
      reason: 'Goodwill refund after a no-show dispute.',
    },
    {
      to: 'CHECKED_IN',
      actors: ['ADMIN'],
      reason: 'Correction: the user did attend but staff failed to scan.',
    },
  ],

  REFUNDED: [],
  EXPIRED: [],
};

/**
 * Ce qu'un statut *entraîne* — par opposition à ce qu'il autorise.
 *
 * `TRANSITIONS` est exhaustive et le compilateur l'exige : ajouter un statut à
 * `RESERVATION_STATUSES` sans lui donner de ligne de transitions ne compile pas.
 * Mais cette garde s'arrêtait là, et c'était la partie la moins chère. Les
 * conséquences — occuper une place, consommer l'essai, rester actionnable —
 * vivaient dans trois tableaux littéraux : un statut ajouté n'y figurait pas et
 * ne retenait donc **aucune place** et ne consommait **aucun essai**, en
 * silence. Or ces deux réponses sont l'argent et l'essai, c'est-à-dire les deux
 * choses que la plateforme vend.
 *
 * `Record<ReservationStatus, ReservationStatusEffects>` : trois questions
 * auxquelles il faut répondre pour tout nouveau statut, sans quoi rien ne
 * compile. Le défaut n'existe plus.
 *
 * `isTerminal` est absent de la table exprès : il se **déduit** de
 * `TRANSITIONS` — un statut est terminal quand plus aucune transition n'en part.
 * Le déclarer permettrait de le contredire.
 */
interface ReservationStatusEffects {
  /** La réservation occupe encore une place dans le créneau. */
  readonly holdsCapacity: boolean;
  /**
   * La réservation compte contre l'allocation d'essai de l'utilisateur.
   *
   * Les réservations en cours comptent, sinon un utilisateur tiendrait dix
   * « premières séances » simultanées dans le même lieu. `NO_SHOW` compte parce
   * que la salle a bloqué une place réelle et l'a perdue. Annulations,
   * expirations et remboursements ne comptent pas : l'expérience n'a pas été
   * consommée, et punir l'utilisateur rendrait l'annulation anxiogène.
   */
  readonly consumesTrial: boolean;
  /** L'utilisateur peut encore agir dessus depuis l'app (annuler, montrer le QR). */
  readonly isLive: boolean;
}

const RESERVATION_STATUS_EFFECTS: Record<ReservationStatus, ReservationStatusEffects> = {
  PENDING: { holdsCapacity: true, consumesTrial: true, isLive: true },
  PAYMENT_PENDING: { holdsCapacity: true, consumesTrial: true, isLive: true },
  CONFIRMED: { holdsCapacity: true, consumesTrial: true, isLive: true },
  CHECKED_IN: { holdsCapacity: true, consumesTrial: true, isLive: false },
  COMPLETED: { holdsCapacity: true, consumesTrial: true, isLive: false },
  CANCELLED_USER: { holdsCapacity: false, consumesTrial: false, isLive: false },
  CANCELLED_BUSINESS: { holdsCapacity: false, consumesTrial: false, isLive: false },
  NO_SHOW: { holdsCapacity: true, consumesTrial: true, isLive: false },
  REFUNDED: { holdsCapacity: false, consumesTrial: false, isLive: false },
  EXPIRED: { holdsCapacity: false, consumesTrial: false, isLive: false },
};

function statusesWhere(
  effect: (effects: ReservationStatusEffects) => boolean,
): readonly ReservationStatus[] {
  return RESERVATION_STATUSES.filter((status) => effect(RESERVATION_STATUS_EFFECTS[status]));
}

/**
 * States from which nothing further can happen without an admin correction.
 *
 * Déduit de `TRANSITIONS`, jamais déclaré : « terminal » veut dire « aucune
 * transition n'en part », et une liste écrite à la main pouvait affirmer le
 * contraire de la table.
 */
export const TERMINAL_RESERVATION_STATUSES: readonly ReservationStatus[] =
  RESERVATION_STATUSES.filter((status) => TRANSITIONS[status].length === 0);

/** The booking still occupies capacity in the slot. */
export const CAPACITY_HOLDING_STATUSES: readonly ReservationStatus[] = statusesWhere(
  (effects) => effects.holdsCapacity,
);

/** Statuses that count against a user's trial allowance. */
export const TRIAL_CONSUMING_STATUSES: readonly ReservationStatus[] = statusesWhere(
  (effects) => effects.consumesTrial,
);

export function isTerminalReservationStatus(status: ReservationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function holdsCapacity(status: ReservationStatus): boolean {
  return RESERVATION_STATUS_EFFECTS[status].holdsCapacity;
}

export function consumesTrial(status: ReservationStatus): boolean {
  return RESERVATION_STATUS_EFFECTS[status].consumesTrial;
}

/** A booking the user can still act on from the app (cancel, show QR). */
export function isLiveReservationStatus(status: ReservationStatus): boolean {
  return RESERVATION_STATUS_EFFECTS[status].isLive;
}

export function allowedTransitionsFrom(status: ReservationStatus): readonly Transition[] {
  return TRANSITIONS[status];
}

export function canTransition(
  from: ReservationStatus,
  to: ReservationStatus,
  actor: TransitionActor,
): boolean {
  const transition = TRANSITIONS[from].find((candidate) => candidate.to === to);
  return transition !== undefined && transition.actors.includes(actor);
}

export class InvalidReservationTransitionError extends Error {
  constructor(
    readonly from: ReservationStatus,
    readonly to: ReservationStatus,
    readonly actor: TransitionActor,
  ) {
    const permitted = TRANSITIONS[from]
      .filter((transition) => transition.actors.includes(actor))
      .map((transition) => transition.to);
    super(
      `${actor} cannot move a reservation from ${from} to ${to}. ` +
        `Permitted for this actor: ${permitted.length > 0 ? permitted.join(', ') : 'none'}.`,
    );
    this.name = 'InvalidReservationTransitionError';
  }
}

export function assertTransition(
  from: ReservationStatus,
  to: ReservationStatus,
  actor: TransitionActor,
): void {
  if (!canTransition(from, to, actor)) {
    throw new InvalidReservationTransitionError(from, to, actor);
  }
}
