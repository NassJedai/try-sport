import { BOOKING_PAYMENT_STATUSES } from './enums.js';
import type { BookingPaymentStatus, PaymentStatus, ReservationStatus } from './enums.js';

/**
 * Projection of a payment onto the booking that carries it.
 *
 * There is exactly one payment vocabulary (`PAYMENT_STATUSES`). The booking view
 * is not a second one: it is the same, plus the single case where no payment row
 * exists at all (`NOT_REQUIRED`, a free trial).
 *
 * The point of this function is representability. The booking view used to carry
 * its own inline enum — `NOT_REQUIRED | REQUIRES_CONFIRMATION | PROCESSING |
 * SUCCEEDED | FAILED` — which could not say "refunded", so a refunded payment
 * was reported to the client as `PROCESSING`: money already returned, displayed
 * as money in flight.
 */
export function bookingPaymentStatus(input: {
  /** Amount due, in whole minor units. Zero means nothing was ever charged. */
  priceAmount: number;
  /** The payment row's status, `null` while no payment row exists. */
  paymentStatus: PaymentStatus | null | undefined;
  reservationStatus: ReservationStatus;
}): BookingPaymentStatus {
  // A free trial creates no payment row and no money movement. It wins over
  // anything else: there is nothing to be in flight, refunded or failed.
  if (input.priceAmount === 0) return 'NOT_REQUIRED';

  // The payment row is authoritative and is copied verbatim. Translating it here
  // is exactly how the two vocabularies diverged in the first place.
  if (input.paymentStatus) return input.paymentStatus;

  // No payment row yet: the reservation says where we are. A priced booking
  // awaiting payment is `REQUIRES_PAYMENT` — the same value the payment row is
  // created with, and what the booking view used to call REQUIRES_CONFIRMATION.
  if (input.reservationStatus === 'PAYMENT_PENDING') return 'REQUIRES_PAYMENT';

  // Priced, not awaiting payment, yet no payment row: an anomaly rather than a
  // state. Reported as in-flight — never as `REQUIRES_PAYMENT`, which would
  // invite the user to pay for a booking that may already be cancelled.
  return 'PROCESSING';
}

/**
 * User-facing French labels. A `Record` on purpose: adding a payment status
 * without deciding what a customer or a manager reads is a compile error, not a
 * silently empty cell in a dashboard.
 */
export const BOOKING_PAYMENT_STATUS_LABELS_FR: Record<BookingPaymentStatus, string> = {
  NOT_REQUIRED: 'Aucun paiement requis',
  REQUIRES_PAYMENT: 'Paiement à finaliser',
  PROCESSING: 'Paiement en cours',
  SUCCEEDED: 'Payé',
  FAILED: 'Paiement refusé',
  CANCELLED: 'Paiement annulé',
  REFUNDED: 'Remboursé',
  PARTIALLY_REFUNDED: 'Partiellement remboursé',
};

/** True once money has come back to the customer, in full or in part. */
export function isRefundedBookingPayment(status: BookingPaymentStatus): boolean {
  return status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED';
}

/** True while the booking is still waiting on money from the customer. */
export function isOutstandingBookingPayment(status: BookingPaymentStatus): boolean {
  return status === 'REQUIRES_PAYMENT' || status === 'PROCESSING';
}

export function isBookingPaymentStatus(value: string): value is BookingPaymentStatus {
  return (BOOKING_PAYMENT_STATUSES as readonly string[]).includes(value);
}
