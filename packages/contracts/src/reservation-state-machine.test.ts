import { describe, expect, it } from 'vitest';
import { RESERVATION_STATUSES } from './enums.js';
import type { ReservationStatus } from './enums.js';
import {
  allowedTransitionsFrom,
  assertTransition,
  canTransition,
  consumesTrial,
  holdsCapacity,
  InvalidReservationTransitionError,
  isLiveReservationStatus,
  isTerminalReservationStatus,
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
