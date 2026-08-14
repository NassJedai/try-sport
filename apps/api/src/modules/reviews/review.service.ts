import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { leadStatusAfterContinuation } from '@try/contracts';
import type { SubmitReviewDto } from '@try/contracts';
import type { Clock } from '@try/utils';
import { schema } from '@try/database';
import type { Database, Transaction } from '@try/database';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { DomainEvents } from '../events/domain-events.js';
import { isUniqueViolation } from '../bookings/booking.service.js';

/**
 * The post-experience loop, and the most commercially important few seconds in
 * the product.
 *
 * A rating makes the marketplace trustworthy. The continuation answer — "tu
 * aimerais continuer ?" — is what turns an attended trial into a qualified lead,
 * which is the thing a venue is actually paying TRY for.
 */
@Injectable()
export class ReviewService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly events: DomainEvents,
  ) {}

  async submit(input: {
    userId: string;
    reservationId: string;
    dto: SubmitReviewDto;
  }): Promise<{ reviewId: string }> {
    const now = this.clock.now();

    return this.db.transaction(async (tx) => {
      const [reservation] = await tx
        .select()
        .from(schema.reservations)
        .where(eq(schema.reservations.id, input.reservationId))
        .limit(1);

      if (!reservation) throw ApiException.notFound('reservation', input.reservationId);
      if (reservation.userId !== input.userId) {
        // 404 rather than 403: confirming someone else's booking exists is a leak.
        throw ApiException.notFound('reservation', input.reservationId);
      }

      /**
       * Only someone who actually turned up may review. This is the single rule
       * that keeps ratings meaningful — without it, a competitor or a no-show
       * could rate a venue they never experienced.
       */
      if (reservation.status !== 'CHECKED_IN' && reservation.status !== 'COMPLETED') {
        throw new ApiException(
          'CONFLICT',
          'Tu pourras laisser un avis après ta séance.',
          undefined,
          { status: reservation.status },
        );
      }

      let reviewId: string;
      try {
        const [review] = await tx
          .insert(schema.reviews)
          .values({
            reservationId: reservation.id,
            userId: reservation.userId,
            venueId: reservation.venueId,
            offerId: reservation.offerId,
            rating: input.dto.rating,
            comment: input.dto.comment?.trim() || null,
            isPublished: true,
          })
          .returning({ id: schema.reviews.id });

        if (!review) throw new ApiException('INTERNAL_ERROR');
        reviewId = review.id;
      } catch (error) {
        // One review per reservation, enforced by the database.
        if (isUniqueViolation(error, 'reviews_reservation_key')) {
          throw new ApiException('CONFLICT', 'Tu as déjà laissé un avis pour cette séance.');
        }
        throw error;
      }

      await this.recomputeVenueRating(tx, reservation.venueId);

      /**
       * Feed the answer into the venue's pipeline.
       *
       * The lead already exists from check-in; this enriches it. Status only
       * moves forward — a venue that has already contacted or converted this
       * person must not be dragged back to INTERESTED by a late review.
       */
      const [lead] = await tx
        .select({ id: schema.leads.id, status: schema.leads.status })
        .from(schema.leads)
        .where(eq(schema.leads.reservationId, reservation.id))
        .limit(1);

      if (lead) {
        // The forward-only rule lives in @try/contracts and is unit-tested there.
        const nextStatus = leadStatusAfterContinuation(lead.status, input.dto.continuation);

        await tx
          .update(schema.leads)
          .set({
            rating: input.dto.rating,
            continuation: input.dto.continuation ?? null,
            status: nextStatus,
            lostAt: nextStatus === 'LOST' && lead.status !== 'LOST' ? now : null,
            /**
             * Consent is recorded as a timestamp, not a boolean: GDPR requires
             * knowing *when* it was given. The venue only sees an email address
             * if this is set.
             */
            contactConsentAt: input.dto.shareWithVenue ? now : null,
            updatedAt: now,
          })
          .where(eq(schema.leads.id, lead.id));
      }

      // Completing here as well as in the scheduled job: a user who reviews
      // immediately after the session should not wait for the sweeper.
      if (reservation.status === 'CHECKED_IN') {
        await tx
          .update(schema.reservations)
          .set({ status: 'COMPLETED', completedAt: now, updatedAt: now })
          .where(eq(schema.reservations.id, reservation.id));

        await tx
          .update(schema.trialHistory)
          .set({ status: 'COMPLETED', completedAt: now, updatedAt: now })
          .where(eq(schema.trialHistory.reservationId, reservation.id));

        this.events.emit('TrialCompleted', {
          reservationId: reservation.id,
          userId: reservation.userId,
          businessId: reservation.businessId,
          venueId: reservation.venueId,
        });
      }

      this.events.emit('ReviewSubmitted', {
        reservationId: reservation.id,
        userId: reservation.userId,
        venueId: reservation.venueId,
        rating: input.dto.rating,
      });

      return { reviewId };
    });
  }

  /**
   * Recomputes the denormalised aggregates the discovery feed reads.
   *
   * Recomputed from the source rows rather than incremented, so a moderated or
   * deleted review cannot leave the average permanently wrong. Stored in
   * hundredths to keep the column integral.
   */
  private async recomputeVenueRating(tx: Transaction, venueId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE ${schema.venues} v
      SET average_rating_hundredths = agg.avg_rating,
          review_count = agg.review_count
      FROM (
        SELECT ROUND(AVG(rating) * 100)::int AS avg_rating,
               COUNT(*)::int AS review_count
        FROM ${schema.reviews}
        WHERE venue_id = ${venueId} AND is_published = true
      ) agg
      WHERE v.id = ${venueId}
    `);
  }

  /** Reviews a user can still leave — drives the prompt in "my bookings". */
  async listPendingReviews(userId: string): Promise<{ reservationId: string; offerTitle: string }[]> {
    const rows = await this.db
      .select({
        reservationId: schema.reservations.id,
        offerTitle: schema.offers.title,
      })
      .from(schema.reservations)
      .innerJoin(schema.offers, eq(schema.offers.id, schema.reservations.offerId))
      .leftJoin(schema.reviews, eq(schema.reviews.reservationId, schema.reservations.id))
      .where(
        and(
          eq(schema.reservations.userId, userId),
          sql`${schema.reservations.status} IN ('CHECKED_IN', 'COMPLETED')`,
          sql`${schema.reviews.id} IS NULL`,
        ),
      )
      .limit(10);

    return rows;
  }
}
