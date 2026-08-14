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

/** States from which nothing further can happen without an admin correction. */
export const TERMINAL_RESERVATION_STATUSES: readonly ReservationStatus[] = [
  'REFUNDED',
  'EXPIRED',
];

/** The booking still occupies capacity in the slot. */
export const CAPACITY_HOLDING_STATUSES: readonly ReservationStatus[] = [
  'PENDING',
  'PAYMENT_PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'COMPLETED',
  'NO_SHOW',
];

/**
 * Statuses that count against a user's trial allowance.
 *
 * In-flight bookings count so a user cannot hold ten simultaneous "first sessions"
 * at the same venue. NO_SHOW counts because the venue reserved a real spot and
 * lost it. Cancellations, expiries and refunds do not count — the user never
 * consumed the experience, and punishing them would make cancelling feel unsafe.
 */
export const TRIAL_CONSUMING_STATUSES: readonly ReservationStatus[] = [
  'PENDING',
  'PAYMENT_PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'COMPLETED',
  'NO_SHOW',
];

export function isTerminalReservationStatus(status: ReservationStatus): boolean {
  return TERMINAL_RESERVATION_STATUSES.includes(status);
}

export function holdsCapacity(status: ReservationStatus): boolean {
  return CAPACITY_HOLDING_STATUSES.includes(status);
}

export function consumesTrial(status: ReservationStatus): boolean {
  return TRIAL_CONSUMING_STATUSES.includes(status);
}

/** A booking the user can still act on from the app (cancel, show QR). */
export function isLiveReservationStatus(status: ReservationStatus): boolean {
  return status === 'PENDING' || status === 'PAYMENT_PENDING' || status === 'CONFIRMED';
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
