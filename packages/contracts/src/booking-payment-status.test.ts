import { describe, expect, it } from 'vitest';
import {
  BOOKING_PAYMENT_STATUS_LABELS_FR,
  bookingPaymentStatus,
  isOutstandingBookingPayment,
  isRefundedBookingPayment,
} from './booking-payment-status.js';
import { BOOKING_PAYMENT_STATUSES, PAYMENT_STATUSES, RESERVATION_STATUSES } from './enums.js';
import { bookingPaymentSchema } from './schemas/bookings.js';

/** 25,00 € — minor units, integer, as everywhere else in this codebase. */
const PRICE = 2500;

describe('booking payment status', () => {
  it('carries every payment status onto the booking', () => {
    // The rule this file exists for: whatever a payment row can be, the booking
    // that carries it must be able to say so. A vocabulary that cannot express
    // "remboursé" forces the server to report something false.
    for (const status of PAYMENT_STATUSES) {
      expect(BOOKING_PAYMENT_STATUSES).toContain(status);
      expect(
        bookingPaymentStatus({
          priceAmount: PRICE,
          paymentStatus: status,
          reservationStatus: 'CONFIRMED',
        }),
      ).toBe(status);
    }
  });

  it('reports a refunded payment as refunded, not as in flight', () => {
    // The regression that motivated the change: REFUNDED used to fall through to
    // PROCESSING, telling a customer their money was on its way to the venue
    // when it had already come back to them.
    expect(
      bookingPaymentStatus({
        priceAmount: PRICE,
        paymentStatus: 'REFUNDED',
        reservationStatus: 'REFUNDED',
      }),
    ).toBe('REFUNDED');
    expect(
      bookingPaymentStatus({
        priceAmount: PRICE,
        paymentStatus: 'PARTIALLY_REFUNDED',
        reservationStatus: 'CANCELLED_USER',
      }),
    ).toBe('PARTIALLY_REFUNDED');
  });

  it('says NOT_REQUIRED for a free trial, whatever the reservation is doing', () => {
    for (const reservationStatus of RESERVATION_STATUSES) {
      expect(
        bookingPaymentStatus({ priceAmount: 0, paymentStatus: null, reservationStatus }),
      ).toBe('NOT_REQUIRED');
    }
  });

  it('never charges a free trial, even if a payment row somehow exists', () => {
    // No money moved: nothing can be refunded, failed or in flight.
    expect(
      bookingPaymentStatus({
        priceAmount: 0,
        paymentStatus: 'SUCCEEDED',
        reservationStatus: 'CONFIRMED',
      }),
    ).toBe('NOT_REQUIRED');
  });

  it('asks for payment while a priced booking waits for it', () => {
    // Formerly REQUIRES_CONFIRMATION, an invented synonym of the value the
    // payment row is actually created with.
    expect(
      bookingPaymentStatus({
        priceAmount: PRICE,
        paymentStatus: null,
        reservationStatus: 'PAYMENT_PENDING',
      }),
    ).toBe('REQUIRES_PAYMENT');
    expect(
      bookingPaymentStatus({
        priceAmount: PRICE,
        paymentStatus: 'REQUIRES_PAYMENT',
        reservationStatus: 'PAYMENT_PENDING',
      }),
    ).toBe('REQUIRES_PAYMENT');
  });

  it('does not invite payment on a priced booking with no payment row', () => {
    // Data anomaly, not a state. Never REQUIRES_PAYMENT: asking a user to pay
    // for a booking that may already be cancelled is worse than saying nothing.
    for (const reservationStatus of RESERVATION_STATUSES) {
      if (reservationStatus === 'PAYMENT_PENDING') continue;
      expect(
        bookingPaymentStatus({ priceAmount: PRICE, paymentStatus: null, reservationStatus }),
      ).toBe('PROCESSING');
    }
    expect(
      bookingPaymentStatus({
        priceAmount: PRICE,
        paymentStatus: undefined,
        reservationStatus: 'CANCELLED_USER',
      }),
    ).toBe('PROCESSING');
  });

  it('returns a value the booking contract accepts, for every input', () => {
    for (const reservationStatus of RESERVATION_STATUSES) {
      for (const paymentStatus of [...PAYMENT_STATUSES, null]) {
        for (const priceAmount of [0, PRICE]) {
          const status = bookingPaymentStatus({ priceAmount, paymentStatus, reservationStatus });
          expect(
            bookingPaymentSchema.safeParse({
              status,
              amount: { amount: priceAmount, currency: 'EUR' },
              clientSecret: null,
              provider: priceAmount === 0 ? 'NONE' : 'STRIPE',
            }).success,
          ).toBe(true);
        }
      }
    }
  });

  it('rejects the vocabulary the booking view used to invent', () => {
    const parsed = bookingPaymentSchema.safeParse({
      status: 'REQUIRES_CONFIRMATION',
      amount: { amount: PRICE, currency: 'EUR' },
      clientSecret: null,
      provider: 'STRIPE',
    });
    expect(parsed.success).toBe(false);
  });

  it('labels every status in French', () => {
    // A manager reading an empty cell instead of "Remboursé" is the defect this
    // record prevents: adding a status without a label breaks the build.
    for (const status of BOOKING_PAYMENT_STATUSES) {
      expect(BOOKING_PAYMENT_STATUS_LABELS_FR[status]).toBeTruthy();
    }
    expect(BOOKING_PAYMENT_STATUS_LABELS_FR.REFUNDED).toBe('Remboursé');
    expect(BOOKING_PAYMENT_STATUS_LABELS_FR.PARTIALLY_REFUNDED).toBe('Partiellement remboursé');
  });

  it('classifies refunded and outstanding payments', () => {
    expect(isRefundedBookingPayment('REFUNDED')).toBe(true);
    expect(isRefundedBookingPayment('PARTIALLY_REFUNDED')).toBe(true);
    expect(isRefundedBookingPayment('SUCCEEDED')).toBe(false);
    expect(isOutstandingBookingPayment('REQUIRES_PAYMENT')).toBe(true);
    expect(isOutstandingBookingPayment('PROCESSING')).toBe(true);
    expect(isOutstandingBookingPayment('NOT_REQUIRED')).toBe(false);
    expect(isOutstandingBookingPayment('REFUNDED')).toBe(false);
  });
});
