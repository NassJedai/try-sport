import { describe, expect, it } from 'vitest';
import { RESERVATION_STATUSES } from './enums.js';
import type { ReservationStatus } from './enums.js';
import {
  allowedTransitionsFrom,
  assertTransition,
  canTransition,
  CAPACITY_HOLDING_STATUSES,
  consumesTrial,
  holdsCapacity,
  InvalidReservationTransitionError,
  isLiveReservationStatus,
  isTerminalReservationStatus,
  TERMINAL_RESERVATION_STATUSES,
  TRIAL_CONSUMING_STATUSES,
} from './reservation-state-machine.js';

describe('reservation state machine', () => {
  it('walks the happy path of a free booking', () => {
    expect(canTransition('PENDING', 'CONFIRMED', 'SYSTEM')).toBe(true);
    expect(canTransition('CONFIRMED', 'CHECKED_IN', 'BUSINESS')).toBe(true);
    expect(canTransition('CHECKED_IN', 'COMPLETED', 'SYSTEM')).toBe(true);
  });

  it('walks the happy path of a paid booking', () => {
    expect(canTransition('PENDING', 'PAYMENT_PENDING', 'SYSTEM')).toBe(true);
    expect(canTransition('PAYMENT_PENDING', 'CONFIRMED', 'SYSTEM')).toBe(true);
  });

  it('refuses to skip payment', () => {
    // A client must never be able to jump a booking straight to CONFIRMED.
    expect(canTransition('PAYMENT_PENDING', 'CHECKED_IN', 'BUSINESS')).toBe(false);
    expect(canTransition('PENDING', 'COMPLETED', 'SYSTEM')).toBe(false);
  });

  it('does not let a user confirm or check in their own booking', () => {
    expect(canTransition('PENDING', 'CONFIRMED', 'USER')).toBe(false);
    expect(canTransition('CONFIRMED', 'CHECKED_IN', 'USER')).toBe(false);
    expect(canTransition('CONFIRMED', 'COMPLETED', 'USER')).toBe(false);
  });

  it('does not let a business cancel on the user’s behalf', () => {
    expect(canTransition('CONFIRMED', 'CANCELLED_USER', 'BUSINESS')).toBe(false);
    expect(canTransition('CONFIRMED', 'CANCELLED_USER', 'USER')).toBe(true);
  });

  it('only lets an admin refund a completed session', () => {
    expect(canTransition('COMPLETED', 'REFUNDED', 'ADMIN')).toBe(true);
    expect(canTransition('COMPLETED', 'REFUNDED', 'BUSINESS')).toBe(false);
    expect(canTransition('COMPLETED', 'REFUNDED', 'USER')).toBe(false);
  });

  it('treats refunded and expired as terminal', () => {
    expect(allowedTransitionsFrom('REFUNDED')).toHaveLength(0);
    expect(allowedTransitionsFrom('EXPIRED')).toHaveLength(0);
    expect(isTerminalReservationStatus('REFUNDED')).toBe(true);
    expect(isTerminalReservationStatus('CONFIRMED')).toBe(false);
  });

  it('allows an admin to correct a wrongly recorded no-show', () => {
    expect(canTransition('NO_SHOW', 'CHECKED_IN', 'ADMIN')).toBe(true);
    expect(canTransition('NO_SHOW', 'CHECKED_IN', 'BUSINESS')).toBe(false);
  });

  it('throws a message naming the permitted transitions', () => {
    expect(() => assertTransition('COMPLETED', 'CHECKED_IN', 'BUSINESS')).toThrow(
      InvalidReservationTransitionError,
    );
    expect(() => assertTransition('COMPLETED', 'CHECKED_IN', 'BUSINESS')).toThrow(/none/);
    expect(() => assertTransition('CONFIRMED', 'COMPLETED', 'BUSINESS')).toThrow(/CHECKED_IN/);
  });

  it('never allows a transition out of a terminal state, for any actor', () => {
    const actors = ['USER', 'BUSINESS', 'ADMIN', 'SYSTEM'] as const;
    for (const terminal of ['REFUNDED', 'EXPIRED'] as ReservationStatus[]) {
      for (const to of RESERVATION_STATUSES) {
        for (const actor of actors) {
          expect(canTransition(terminal, to, actor)).toBe(false);
        }
      }
    }
  });

  it('never allows a self-transition', () => {
    for (const status of RESERVATION_STATUSES) {
      expect(allowedTransitionsFrom(status).some((t) => t.to === status)).toBe(false);
    }
  });

  describe('capacity and trial accounting', () => {
    it('holds capacity while the booking is in flight or honoured', () => {
      expect(holdsCapacity('PENDING')).toBe(true);
      expect(holdsCapacity('CONFIRMED')).toBe(true);
      expect(holdsCapacity('NO_SHOW')).toBe(true);
      expect(holdsCapacity('CANCELLED_USER')).toBe(false);
      expect(holdsCapacity('EXPIRED')).toBe(false);
    });

    it('does not burn a trial on a cancelled or expired booking', () => {
      // Cancelling must feel safe, or users stop booking at all.
      expect(consumesTrial('CANCELLED_USER')).toBe(false);
      expect(consumesTrial('CANCELLED_BUSINESS')).toBe(false);
      expect(consumesTrial('EXPIRED')).toBe(false);
      expect(consumesTrial('REFUNDED')).toBe(false);
    });

    it('burns a trial for in-flight, attended and no-show bookings', () => {
      // In-flight counts, otherwise a user could hold ten trials at one venue.
      expect(consumesTrial('PENDING')).toBe(true);
      expect(consumesTrial('CONFIRMED')).toBe(true);
      expect(consumesTrial('COMPLETED')).toBe(true);
      // The venue lost a real spot; that counts.
      expect(consumesTrial('NO_SHOW')).toBe(true);
    });

    it('marks exactly the statuses the app can still act on as live', () => {
      const live = RESERVATION_STATUSES.filter(isLiveReservationStatus);
      expect(live).toEqual(['PENDING', 'PAYMENT_PENDING', 'CONFIRMED']);
    });
  });
});

/**
 * Les conséquences d'un statut, et non plus seulement ses transitions.
 *
 * Le compilateur exigeait déjà une ligne de transitions pour tout nouveau
 * statut. Il n'exigeait rien sur les conséquences : place occupée et essai
 * consommé vivaient dans des tableaux littéraux, et un statut ajouté n'y
 * figurait pas — il ne retenait donc aucune place et ne consommait aucun essai,
 * en silence. Ces deux réponses sont l'argent et l'essai.
 *
 * Ces tests vérifient ce qu'un type ne peut pas vérifier : que la table dit vrai
 * et que les listes dérivées ne dérivent pas de leurs prédicats.
 */
describe('conséquences d’un statut de réservation', () => {
  it('répond aux trois questions pour chaque statut, sans trou', () => {
    for (const status of RESERVATION_STATUSES) {
      expect(typeof holdsCapacity(status)).toBe('boolean');
      expect(typeof consumesTrial(status)).toBe('boolean');
      expect(typeof isLiveReservationStatus(status)).toBe('boolean');
    }
  });

  it('garde les listes exportées alignées sur leurs prédicats', () => {
    // `TRIAL_CONSUMING_STATUSES` part en SQL (`inArray`) dans deux services :
    // une liste qui diverge de `consumesTrial()` ferait répondre deux choses
    // différentes à la même question selon la couche.
    expect(CAPACITY_HOLDING_STATUSES).toEqual(RESERVATION_STATUSES.filter(holdsCapacity));
    expect(TRIAL_CONSUMING_STATUSES).toEqual(RESERVATION_STATUSES.filter(consumesTrial));
  });

  it('déduit « terminal » de la table des transitions plutôt que de le déclarer', () => {
    // Une liste écrite à la main pouvait affirmer qu'un statut est terminal
    // alors que des transitions en partaient.
    expect(TERMINAL_RESERVATION_STATUSES).toEqual(
      RESERVATION_STATUSES.filter((status) => allowedTransitionsFrom(status).length === 0),
    );
    expect(TERMINAL_RESERVATION_STATUSES).toEqual(['REFUNDED', 'EXPIRED']);
  });

  it('ne consomme jamais un essai sans occuper une place', () => {
    // Règle métier : la salle ne perd un essai que si elle a bloqué la place
    // correspondante. L'inverse est permis — une place peut être tenue sans que
    // l'essai soit consommé —, mais pas celui-ci.
    for (const status of RESERVATION_STATUSES) {
      if (consumesTrial(status)) expect(holdsCapacity(status)).toBe(true);
    }
  });

  it('ne laisse aucun statut terminal actionnable depuis l’app', () => {
    for (const status of TERMINAL_RESERVATION_STATUSES) {
      expect(isLiveReservationStatus(status)).toBe(false);
    }
  });
});
