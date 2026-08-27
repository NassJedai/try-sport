import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  CANCELLATION_POLICY_DEFINITIONS,
  TRIAL_CONSUMING_STATUSES,
  TRIAL_INELIGIBILITY_MESSAGES,
  assertTransition,
  assessCancellation,
  evaluateTrialEligibility,
} from '@try/contracts';
import type { CreateBookingDto, ReservationStatus, TrialHistoryEntry } from '@try/contracts';
import { acquireTrialEligibilityLock, schema } from '@try/database';
import type { Database, Transaction } from '@try/database';
import { generateCheckInCode, generateSecureToken } from '@try/utils';
import type { Clock } from '@try/utils';
import type { Logger } from '@try/logger';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { LOGGER } from '../../common/logger.module.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { CryptoService } from '../../common/crypto.service.js';
import { hasBusinessRole, type AuthenticatedUser } from '../../common/auth/current-user.js';
import { PaymentService } from '../payments/payment.service.js';
import { DomainEvents } from '../events/domain-events.js';
import { AuditService } from '../admin/audit.service.js';

/**
 * How long an unconfirmed booking holds a place before the sweeper releases it.
 *
 * Deliberately kept ABOVE `CHECKOUT_SESSION_MINUTES` below, by a margin, not
 * equal to it. Two independent clocks bound the same payment attempt — the
 * Checkout Session's own expiry at the provider, and this hold's expiry in
 * our own database — and whichever is SHORTER is the one that actually
 * decides when a customer can no longer pay. If the DB hold expired first, a
 * customer still legitimately paying on the hosted page could have their
 * capacity released and resold while their card was being charged: the
 * `payment_intent.succeeded` webhook would still arrive and
 * `PaymentService.markSucceeded` would still mark the payment SUCCEEDED, but
 * `confirmReservationOnCapture` would find the reservation no longer
 * PAYMENT_PENDING and silently do nothing — money captured, no confirmed
 * booking, nothing automatic to fix it. Keeping the DB hold comfortably above
 * the Checkout Session's own expiry makes the provider's own cutoff the one
 * that always fires first, closing that window rather than merely narrowing
 * it. The margin (2 minutes) covers `LifecycleJobsService.expirePaymentHolds`
 * own cron granularity (`EVERY_MINUTE`) plus ordinary webhook delivery lag;
 * `expirePaymentHolds` additionally cancels the underlying PaymentIntent for
 * every hold it releases, as a second, independent guard against this same
 * race — see its doc comment.
 *
 * Raised from 15 to 32 minutes on 2026-08-27, when payment moved from a
 * PaymentIntent the mobile app created but never actually confirmed (no
 * native build exists yet — Expo Go only) to a real, completable
 * browser-hosted Checkout page. Stripe refuses a Checkout Session
 * `expires_at` under 30 minutes for `mode: payment`, so 15 stopped being
 * achievable regardless of preference once payment became real. This is a
 * genuine product tradeoff — a slot stays unavailable to everyone else for up
 * to 32 minutes because of one indecisive payer — flagged here rather than
 * decided silently; lower it only together with `CHECKOUT_SESSION_MINUTES`,
 * never alone.
 */
const PAYMENT_HOLD_MINUTES = 32;

/**
 * The Checkout Session's own lifetime, passed to the provider as
 * `expiresAt`. Not a preference: 30 minutes is Stripe's documented floor for
 * `expires_at` on a `mode: payment` session (max 24h) — asking for less is
 * rejected by the API outright. See `PAYMENT_HOLD_MINUTES` above for why the
 * DB hold must stay above this number, never below or equal to it.
 */
const CHECKOUT_SESSION_MINUTES = 30;

/** Check-in opens before the session so nobody is turned away for being early. */
const CHECKIN_OPENS_MINUTES_BEFORE = 60;
const CHECKIN_CLOSES_MINUTES_AFTER = 120;

/**
 * Fenêtre du geste manuel « marquer absent » (`BookingService.markNoShow`).
 *
 * Bornée aux deux mêmes heures que le sweep automatique
 * (`LifecycleJobsService.markNoShows`), lu depuis cette seule constante par
 * les deux chemins : un membre du personnel et l'automate ne doivent jamais
 * pouvoir se contredire sur « c'est encore le moment » ou « c'est trop tard ».
 * Voir `BookingService.noShowWindow`.
 */
export const NO_SHOW_MANUAL_CUTOFF_HOURS = 4;

export interface CreateBookingResult {
  reservationId: string;
  status: ReservationStatus;
  requiresPayment: boolean;
  /**
   * Stripe-hosted checkout page to open in the phone's browser. Null for a
   * free booking. Returned once, at creation, exactly like the PaymentIntent
   * client secret it replaces — never re-issued on a later read (see
   * `BookingQueryService`), so a cached response cannot leak a live payment
   * link into logs or client-side storage indefinitely.
   */
  checkoutUrl: string | null;
}

@Injectable()
export class BookingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly crypto: CryptoService,
    private readonly payments: PaymentService,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates a booking.
   *
   * Everything that decides whether this booking may exist — offer state, slot
   * state, capacity, trial eligibility, price — is resolved here from ids. The
   * client sends a slot id and nothing else that matters; it cannot influence
   * what it is charged.
   *
   * Concurrency is handled by two mechanisms working together:
   *
   *   1. Capacity: a single conditional UPDATE
   *      (`SET reserved_count = reserved_count + 1 WHERE reserved_count < capacity`).
   *      Postgres takes a row lock for the duration of the UPDATE, so two
   *      simultaneous requests for the last place are serialised and exactly one
   *      sees a matching row. A CHECK constraint backs this up at the storage
   *      layer, so overselling is impossible even if this code regresses.
   *
   *   2. Trial eligibility: a rule that spans rows, so a read-then-write check is
   *      racy under READ COMMITTED. A transaction-scoped advisory lock on
   *      (user, business) serialises just those requests, which is far cheaper
   *      than pushing the whole path to SERIALIZABLE. Business, not venue: a
   *      business's trial rule can be scoped as wide as "one trial across the
   *      whole business" (`ONE_TRIAL_PER_BUSINESS`), which spans several
   *      venues — a lock keyed on venue alone would let two simultaneous
   *      bookings at two different venues of the same business both slip
   *      through (this was a real bug, fixed 2026-08-26). Business is the
   *      widest scope any trial rule can span, so it is always the correct
   *      lock key regardless of which rule the offer actually uses.
   *
   * The duplicate-booking case is additionally enforced by a partial unique index,
   * so even a request that bypassed this service could not create two live
   * bookings for one user and slot. Trial eligibility has the same backstop:
   * `trial_history` carries three partial unique indexes, one per scope (see
   * migration 0007), so a regression on the advisory lock above hits the
   * database instead of silently overselling a discovery price.
   */
  async create(input: {
    userId: string;
    dto: CreateBookingDto;
  }): Promise<CreateBookingResult> {
    const now = this.clock.now();

    const { result, event } = await this.db.transaction(async (tx) => {
      const context = await this.loadBookingContext(tx, input.dto.slotId);

      if (context.offer.status !== 'ACTIVE') {
        throw ApiException.conflict('OFFER_NOT_BOOKABLE', { offerId: context.offer.id });
      }
      if (context.venue.status !== 'ACTIVE') {
        throw ApiException.conflict('OFFER_NOT_BOOKABLE', { venueId: context.venue.id });
      }
      if (context.slot.status !== 'OPEN') {
        throw ApiException.conflict('SLOT_NOT_BOOKABLE', { slotId: context.slot.id });
      }
      if (context.slot.startAt.getTime() <= now.getTime()) {
        throw ApiException.conflict('SLOT_IN_PAST', { slotId: context.slot.id });
      }

      // Serialise this user's bookings at this business — not just this venue —
      // before reading their history. See the class-level doc for why.
      await acquireTrialEligibilityLock(tx, input.userId, context.business.id);

      await this.assertTrialEligible(tx, {
        userId: input.userId,
        businessId: context.business.id,
        venueId: context.venue.id,
        offerId: context.offer.id,
        trialRule: context.offer.trialRule,
      });

      // Atomic capacity claim. Zero rows back means the slot filled up in the
      // microseconds since we read it.
      const claimed = await tx
        .update(schema.slots)
        .set({
          reservedCount: sql`${schema.slots.reservedCount} + 1`,
          status: sql`CASE WHEN ${schema.slots.reservedCount} + 1 >= ${schema.slots.capacity} THEN 'FULL'::slot_status ELSE ${schema.slots.status} END`,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.slots.id, context.slot.id),
            eq(schema.slots.status, 'OPEN'),
            sql`${schema.slots.reservedCount} < ${schema.slots.capacity}`,
          ),
        )
        .returning({ reservedCount: schema.slots.reservedCount });

      if (claimed.length === 0) {
        throw ApiException.conflict('SLOT_FULL', { slotId: context.slot.id });
      }

      const requiresPayment = context.offer.priceAmount > 0;
      const checkInCode = generateCheckInCode();
      const checkInToken = generateSecureToken(32);

      let reservationId: string;
      try {
        const [reservation] = await tx
          .insert(schema.reservations)
          .values({
            userId: input.userId,
            slotId: context.slot.id,
            offerId: context.offer.id,
            venueId: context.venue.id,
            businessId: context.business.id,
            status: requiresPayment ? 'PAYMENT_PENDING' : 'CONFIRMED',
            // Snapshotted: a later price change must not alter this agreement.
            priceAmount: context.offer.priceAmount,
            currency: context.offer.currency,
            trialRule: context.offer.trialRule,
            slotStartAt: context.slot.startAt,
            slotEndAt: context.slot.endAt,
            checkInCode,
            checkInTokenHash: this.crypto.hashToken(checkInToken),
            confirmedAt: requiresPayment ? null : now,
            holdExpiresAt: requiresPayment
              ? new Date(now.getTime() + PAYMENT_HOLD_MINUTES * 60_000)
              : null,
          })
          .returning({ id: schema.reservations.id });

        if (!reservation) throw new ApiException('INTERNAL_ERROR');
        reservationId = reservation.id;
      } catch (error) {
        // The partial unique index rejected a second live booking for this slot.
        if (isUniqueViolation(error, 'reservations_user_slot_live_key')) {
          throw ApiException.conflict('DUPLICATE_BOOKING', { slotId: context.slot.id });
        }
        throw error;
      }

      // Trial history is written in the same transaction as the reservation, so
      // eligibility can never disagree with what was actually booked.
      try {
        await tx.insert(schema.trialHistory).values({
          userId: input.userId,
          businessId: context.business.id,
          venueId: context.venue.id,
          offerId: context.offer.id,
          reservationId,
          reservedAt: now,
          status: requiresPayment ? 'PAYMENT_PENDING' : 'CONFIRMED',
          trialRule: context.offer.trialRule,
        });
      } catch (error) {
        // Storage-level backstop (migration 0007): should never fire given the
        // advisory lock above, but a regression there must surface as the
        // same domain error the pre-lock check would have thrown, not a raw
        // 500 from an unhandled constraint violation.
        if (isUniqueViolation(error, 'trial_history_business_scope_key')) {
          throw new ApiException(
            'TRIAL_NOT_ELIGIBLE',
            TRIAL_INELIGIBILITY_MESSAGES.ALREADY_TRIED_THIS_BUSINESS,
            undefined,
            { reason: 'ALREADY_TRIED_THIS_BUSINESS' },
          );
        }
        if (isUniqueViolation(error, 'trial_history_venue_scope_key')) {
          throw new ApiException(
            'TRIAL_NOT_ELIGIBLE',
            TRIAL_INELIGIBILITY_MESSAGES.ALREADY_TRIED_THIS_VENUE,
            undefined,
            { reason: 'ALREADY_TRIED_THIS_VENUE' },
          );
        }
        if (isUniqueViolation(error, 'trial_history_offer_scope_key')) {
          throw new ApiException(
            'TRIAL_NOT_ELIGIBLE',
            TRIAL_INELIGIBILITY_MESSAGES.ALREADY_TRIED_THIS_OFFER,
            undefined,
            { reason: 'ALREADY_TRIED_THIS_OFFER' },
          );
        }
        throw error;
      }

      await tx
        .update(schema.offers)
        .set({ trialCount: sql`${schema.offers.trialCount} + 1` })
        .where(eq(schema.offers.id, context.offer.id));

      let checkoutUrl: string | null = null;
      if (requiresPayment) {
        /**
         * The Checkout Session is created inside the transaction so a failure to
         * reach Stripe rolls back the held capacity. The reverse order would leak
         * a place on every Stripe outage.
         */
        checkoutUrl = await this.payments.createIntentForReservation(tx, {
          reservationId,
          userId: input.userId,
          businessId: context.business.id,
          amount: context.offer.priceAmount,
          currency: context.offer.currency,
          commissionBasisPoints: context.business.commissionBasisPoints,
          description: `${context.offer.title} — ${context.business.name}`,
          checkoutExpiresAt: new Date(now.getTime() + CHECKOUT_SESSION_MINUTES * 60_000),
        });
      }

      return {
        result: {
          reservationId,
          status: requiresPayment ? ('PAYMENT_PENDING' as const) : ('CONFIRMED' as const),
          requiresPayment,
          checkoutUrl,
        },
        event: {
          reservationId,
          userId: input.userId,
          businessId: context.business.id,
          venueId: context.venue.id,
          offerId: context.offer.id,
          isFree: !requiresPayment,
        },
      };
    });

    /**
     * Emitted after COMMIT, never from inside the callback above — see the
     * "Emit after COMMIT" section of `domain-events.ts` for why. In short:
     * `DomainEvents.on` wraps handlers in `void (async () => …)()`, and an
     * async body runs synchronously up to its first `await`, so from inside
     * the callback `BookingLifecycleListener` would issue its read *during*
     * the emit, while the transaction is still open. That read goes through
     * the pool, a connection that cannot see the uncommitted reservation, so
     * it finds nothing and used to return early with no error and no log
     * (see `booking-lifecycle.listener.ts`). Emitting here also means a
     * later rollback can no longer announce a booking that never existed.
     */
    this.events.emit(
      result.requiresPayment ? 'BookingPaymentPending' : 'BookingConfirmed',
      event,
    );

    this.logger.info(
      {
        reservationId: result.reservationId,
        offerId: event.offerId,
        requiresPayment: result.requiresPayment,
      },
      'reservation created',
    );

    return result;
  }

  /**
   * Cancels a booking and releases its capacity.
   *
   * The state transition is validated by the shared state machine, so a business
   * cannot cancel "as the user" and a completed session cannot be un-completed.
   */
  async cancel(input: {
    reservationId: string;
    userId: string;
    reason?: string;
  }): Promise<{ refunded: boolean }> {
    const now = this.clock.now();

    const event = await this.db.transaction(async (tx) => {
      const [reservation] = await tx
        .select()
        .from(schema.reservations)
        .where(eq(schema.reservations.id, input.reservationId))
        .for('update')
        .limit(1);

      if (!reservation) throw ApiException.notFound('reservation', input.reservationId);
      if (reservation.userId !== input.userId) {
        throw ApiException.forbidden('reservation belongs to another user');
      }

      assertTransition(reservation.status, 'CANCELLED_USER', 'USER');

      const [offer] = await tx
        .select({ cancellationPolicy: schema.offers.cancellationPolicy })
        .from(schema.offers)
        .where(eq(schema.offers.id, reservation.offerId))
        .limit(1);

      const assessment = assessCancellation({
        policy: offer?.cancellationPolicy ?? 'STANDARD',
        slotStartAt: reservation.slotStartAt,
        now,
      });

      if (!assessment.canCancel) {
        throw ApiException.conflict('BOOKING_NOT_CANCELLABLE', {
          reservationId: reservation.id,
        });
      }

      await tx
        .update(schema.reservations)
        .set({
          status: 'CANCELLED_USER',
          cancelledAt: now,
          cancellationReason: input.reason ?? null,
          updatedAt: now,
        })
        .where(eq(schema.reservations.id, reservation.id));

      await this.releaseCapacity(tx, reservation.slotId, now);

      // Keep trial history in step: a cancelled booking must not burn a trial.
      await tx
        .update(schema.trialHistory)
        .set({ status: 'CANCELLED_USER', updatedAt: now })
        .where(eq(schema.trialHistory.reservationId, reservation.id));

      let refunded = false;
      if (reservation.priceAmount > 0 && assessment.refundable) {
        refunded = await this.payments.refundReservation(tx, {
          reservationId: reservation.id,
          reason: 'requested_by_customer',
        });
      }

      return {
        reservationId: reservation.id,
        userId: reservation.userId,
        businessId: reservation.businessId,
        refunded,
      };
    });

    // After COMMIT, for the reasons spelled out in `create` above: a listener
    // reading through the pool must be able to see the cancelled row, and a
    // rollback must not leave an announced cancellation that never happened.
    this.events.emit('BookingCancelled', event);

    return { refunded: event.refunded };
  }

  /**
   * Un membre de l'établissement déclare qu'un client n'est pas venu.
   *
   * Ce geste existe en double : ce chemin manuel, et le sweep horaire
   * `LifecycleJobsService.markNoShows` qui fait la même chose 4h après la fin
   * de la séance pour les réservations qu'aucun membre du personnel n'a
   * traitées à la main. Les deux doivent produire exactement le même état —
   * même transition, même conséquence sur l'essai, aucun remboursement — pour
   * que l'un ne prenne jamais le personnel à contre-pied de l'autre :
   *
   *   - **Depuis quel statut** : uniquement `CONFIRMED`, comme l'automate.
   *     `assertTransition` le fait respecter — une réservation déjà annulée,
   *     déjà check-in, ou déjà marquée absente ne peut pas l'être une seconde
   *     fois (`NO_SHOW → NO_SHOW` n'existe pas dans la table).
   *   - **Fenêtre** : `noShowWindow` ci-dessous — pas avant la fin de la
   *     séance (on ne peut rien conclure sur une arrivée en retard tant que la
   *     séance n'est pas terminée), pas après le même délai que l'automate
   *     (passé ce délai, soit l'automate l'a déjà fait, soit la correction
   *     relève d'un admin — pas d'une nouvelle déclaration du personnel sur un
   *     souvenir qui devient vieux).
   *   - **Essai** : `NO_SHOW` consomme l'allocation d'essai — table des
   *     conséquences dans `reservation-state-machine.ts`, décision produit
   *     déjà actée, pas rediscutée ici.
   *   - **Argent** : aucun remboursement déclenché, comme l'automate. La seule
   *     transition qui rembourse un no-show est `NO_SHOW → REFUNDED`, réservée
   *     à un admin (« geste de bonne volonté après contestation ») — jamais
   *     automatique à la déclaration.
   *   - **Réversibilité** : `NO_SHOW → CHECKED_IN` existe dans la machine à
   *     états mais reste réservé à l'acteur `ADMIN`, pas `BUSINESS`. Ce
   *     service n'ouvre donc aucune correction : l'établissement qui se
   *     trompe doit passer par une correction admin, pas se corriger seul —
   *     l'inverse laisserait un établissement réécrire librement une
   *     déclaration qui, ailleurs, consomme l'essai d'un client contre son gré.
   */
  async markNoShow(input: {
    actor: AuthenticatedUser;
    reservationId: string;
  }): Promise<{ reservationId: string; status: 'NO_SHOW' }> {
    const now = this.clock.now();

    const event = await this.db.transaction(async (tx) => {
      const [reservation] = await tx
        .select()
        .from(schema.reservations)
        .where(eq(schema.reservations.id, input.reservationId))
        .for('update')
        .limit(1);

      if (!reservation) throw ApiException.notFound('reservation', input.reservationId);

      if (!hasBusinessRole(input.actor, reservation.businessId, 'STAFF')) {
        throw ApiException.forbidden('not a member of this business');
      }

      // Statut d'abord : une transition interdite (déjà annulée, déjà
      // check-in, déjà no-show) est refusée quel que soit l'horaire.
      assertTransition(reservation.status, 'NO_SHOW', 'BUSINESS');

      const window = BookingService.noShowWindow(reservation.slotEndAt);
      if (now.getTime() < window.opensAt.getTime()) {
        throw new ApiException(
          'CONFLICT',
          'La séance n’est pas encore terminée : reviens une fois qu’elle est passée pour signaler une absence.',
          undefined,
          { reservationId: reservation.id, reason: 'SESSION_NOT_OVER' },
        );
      }
      if (now.getTime() > window.closesAt.getTime()) {
        throw new ApiException(
          'CONFLICT',
          'Le délai pour signaler cette absence est dépassé. Le système l’a peut-être déjà fait, ou contacte le support.',
          undefined,
          { reservationId: reservation.id, reason: 'NO_SHOW_WINDOW_CLOSED' },
        );
      }

      await tx
        .update(schema.reservations)
        .set({ status: 'NO_SHOW', updatedAt: now })
        .where(eq(schema.reservations.id, reservation.id));

      // Aligné avec `LifecycleJobsService.markNoShows` : l'essai reste
      // consommé, la place reste occupée (aucune capacité à libérer, la
      // séance est déjà passée), aucun remboursement.
      await tx
        .update(schema.trialHistory)
        .set({ status: 'NO_SHOW', updatedAt: now })
        .where(eq(schema.trialHistory.reservationId, reservation.id));

      await this.audit.record(tx, {
        actorId: input.actor.id,
        actorType: 'BUSINESS_MEMBER',
        action: 'reservation.no_show',
        entityType: 'reservation',
        entityId: reservation.id,
        metadata: {
          slotStartAt: reservation.slotStartAt,
          slotEndAt: reservation.slotEndAt,
          previousStatus: reservation.status,
        },
      });

      return {
        reservationId: reservation.id,
        userId: reservation.userId,
        businessId: reservation.businessId,
        venueId: reservation.venueId,
      };
    });

    // Après COMMIT, pour la même raison que `create`/`cancel` ci-dessus : un
    // écouteur qui relit à travers le pool doit voir la ligne déjà validée.
    this.events.emit('BookingNoShow', event);

    return { reservationId: event.reservationId, status: 'NO_SHOW' };
  }

  /**
   * Releases the place a cancelled or expired booking held.
   * `GREATEST(reserved_count - 1, 0)` rather than a bare decrement: the CHECK
   * constraint forbids negatives, and a double-release bug should not take the
   * whole endpoint down with a constraint violation.
   */
  private async releaseCapacity(tx: Transaction, slotId: string, now: Date): Promise<void> {
    await tx
      .update(schema.slots)
      .set({
        reservedCount: sql`GREATEST(${schema.slots.reservedCount} - 1, 0)`,
        status: sql`CASE WHEN ${schema.slots.status} = 'FULL' THEN 'OPEN'::slot_status ELSE ${schema.slots.status} END`,
        updatedAt: now,
      })
      .where(eq(schema.slots.id, slotId));
  }

  private async assertTrialEligible(
    tx: Transaction,
    input: {
      userId: string;
      businessId: string;
      venueId: string;
      offerId: string;
      trialRule: TrialHistoryEntry extends never ? never : (typeof schema.offers.$inferSelect)['trialRule'];
    },
  ): Promise<void> {
    if (input.trialRule === 'NO_RESTRICTION') return;

    const history = await tx
      .select({
        businessId: schema.trialHistory.businessId,
        venueId: schema.trialHistory.venueId,
        offerId: schema.trialHistory.offerId,
        status: schema.trialHistory.status,
      })
      .from(schema.trialHistory)
      .where(
        and(
          eq(schema.trialHistory.userId, input.userId),
          eq(schema.trialHistory.businessId, input.businessId),
          inArray(schema.trialHistory.status, [...TRIAL_CONSUMING_STATUSES]),
        ),
      );

    const eligibility = evaluateTrialEligibility({
      rule: input.trialRule,
      businessId: input.businessId,
      venueId: input.venueId,
      offerId: input.offerId,
      history,
    });

    if (!eligibility.eligible) {
      throw new ApiException(
        'TRIAL_NOT_ELIGIBLE',
        TRIAL_INELIGIBILITY_MESSAGES[eligibility.reason],
        undefined,
        { reason: eligibility.reason },
      );
    }
  }

  private async loadBookingContext(tx: Transaction, slotId: string) {
    const [row] = await tx
      .select({
        slot: {
          id: schema.slots.id,
          startAt: schema.slots.startAt,
          endAt: schema.slots.endAt,
          status: schema.slots.status,
          capacity: schema.slots.capacity,
          reservedCount: schema.slots.reservedCount,
        },
        offer: {
          id: schema.offers.id,
          title: schema.offers.title,
          status: schema.offers.status,
          priceAmount: schema.offers.priceAmount,
          currency: schema.offers.currency,
          trialRule: schema.offers.trialRule,
          durationMinutes: schema.offers.durationMinutes,
        },
        venue: {
          id: schema.venues.id,
          status: schema.venues.status,
          timeZone: schema.venues.timeZone,
        },
        business: {
          id: schema.businesses.id,
          name: schema.businesses.name,
          status: schema.businesses.status,
          commissionBasisPoints: schema.businesses.commissionBasisPoints,
        },
      })
      .from(schema.slots)
      .innerJoin(schema.offers, eq(schema.offers.id, schema.slots.offerId))
      .innerJoin(schema.venues, eq(schema.venues.id, schema.offers.venueId))
      .innerJoin(schema.businesses, eq(schema.businesses.id, schema.offers.businessId))
      .where(eq(schema.slots.id, slotId))
      .limit(1);

    if (!row) throw ApiException.notFound('slot', slotId);
    return row;
  }

  static checkInWindow(slotStartAt: Date, slotEndAt: Date): { opensAt: Date; expiresAt: Date } {
    return {
      opensAt: new Date(slotStartAt.getTime() - CHECKIN_OPENS_MINUTES_BEFORE * 60_000),
      expiresAt: new Date(slotEndAt.getTime() + CHECKIN_CLOSES_MINUTES_AFTER * 60_000),
    };
  }

  static cancellationPolicyLabel(policy: keyof typeof CANCELLATION_POLICY_DEFINITIONS): string {
    return CANCELLATION_POLICY_DEFINITIONS[policy].labelFr;
  }

  /**
   * Fenêtre pendant laquelle `markNoShow` accepte la déclaration d'un membre
   * du personnel — voir `NO_SHOW_MANUAL_CUTOFF_HOURS`. `LifecycleJobsService`
   * lit cette même constante pour son propre cutoff, afin que les deux
   * chemins ne puissent jamais diverger sur la borne.
   */
  static noShowWindow(slotEndAt: Date): { opensAt: Date; closesAt: Date } {
    return {
      opensAt: slotEndAt,
      closesAt: new Date(slotEndAt.getTime() + NO_SHOW_MANUAL_CUTOFF_HOURS * 3_600_000),
    };
  }
}

/**
 * Detects a unique-constraint violation (SQLSTATE 23505).
 *
 * Walks the `cause` chain: Drizzle wraps the postgres.js error in a
 * DrizzleQueryError, so the SQLSTATE lives one level down. Reading `error.code`
 * directly worked against no database at all — the first run against a real
 * Postgres showed every duplicate-booking detection silently missing.
 */
export function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = current as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
      cause?: unknown;
    };

    if (candidate.code === '23505') {
      if (!constraintName) return true;
      return (
        candidate.constraint_name === constraintName || candidate.constraint === constraintName
      );
    }

    current = candidate.cause;
  }

  return false;
}
