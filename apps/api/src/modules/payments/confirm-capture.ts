import { and, eq } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Transaction } from '@try/database';

export interface ConfirmedReservationEffect {
  reservationId: string;
  userId: string;
  businessId: string;
  venueId: string;
  offerId: string;
}

/**
 * Reservation-side effects of a captured payment: `reservations` -> CONFIRMED
 * and `trial_history` -> CONFIRMED, conditional on the reservation still being
 * `PAYMENT_PENDING` (idempotent — a second call for the same payment, or a call
 * that arrives after the hold already expired, is a safe no-op).
 *
 * Pure DB writes, no event emission: callers decide when to emit, because they
 * do not share the same transaction-commit discipline.
 * `PaymentService.markSucceeded` emits from inside its own transaction
 * (established precedent, unchanged here). `RefundLedgerService` defers
 * emission until after its transaction commits, exactly like it already does
 * for `PaymentRefunded` — emitting from inside would announce a reservation
 * confirmation that a later error in the same transaction could still roll
 * back.
 *
 * Extracted so the two paths that can discover a capture — the
 * `payment_intent.succeeded` webhook, and a refund revealing a capture whose
 * webhook was lost (see `NEVER_CAPTURED_PAYMENT_STATUSES` in
 * `refund-ledger.service.ts`) — cannot drift apart on what "confirmed" means.
 */
export async function confirmReservationOnCapture(
  tx: Transaction,
  reservationId: string,
  now: Date,
): Promise<ConfirmedReservationEffect | null> {
  const [reservation] = await tx
    .update(schema.reservations)
    .set({
      status: 'CONFIRMED',
      confirmedAt: now,
      holdExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(eq(schema.reservations.id, reservationId), eq(schema.reservations.status, 'PAYMENT_PENDING')),
    )
    .returning();

  if (!reservation) return null;

  await tx
    .update(schema.trialHistory)
    .set({ status: 'CONFIRMED', updatedAt: now })
    .where(eq(schema.trialHistory.reservationId, reservation.id));

  return {
    reservationId: reservation.id,
    userId: reservation.userId,
    businessId: reservation.businessId,
    venueId: reservation.venueId,
    offerId: reservation.offerId,
  };
}
