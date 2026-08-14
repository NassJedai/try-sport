import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { assertOfferTransition, assertVenueTransition } from '@try/contracts';
import type { OfferStatus, VenueStatus } from '@try/contracts';
import type { Clock } from '@try/utils';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { Logger } from '@try/logger';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { LOGGER } from '../../common/logger.module.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { AuditService } from './audit.service.js';
import { OnboardingService } from '../business/onboarding.service.js';
import { isPlatformAdmin, type AuthenticatedUser } from '../../common/auth/current-user.js';

export interface ModerationQueueItem {
  id: string;
  kind: 'venue' | 'offer';
  name: string;
  businessName: string;
  cityName: string | null;
  submittedAt: string;
}

/**
 * Platform moderation.
 *
 * Every action here changes what consumers can see, so all of them are
 * admin-only, validated by the shared moderation state machine, and written to
 * the audit log inside the same transaction as the change.
 */
@Injectable()
export class ModerationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly audit: AuditService,
  ) {}

  private assertAdmin(actor: AuthenticatedUser): void {
    if (!isPlatformAdmin(actor)) {
      throw ApiException.forbidden('platform admin required');
    }
  }

  /** Oldest first: a submission queue that is not FIFO frustrates businesses. */
  async queue(actor: AuthenticatedUser): Promise<{ items: ModerationQueueItem[] }> {
    this.assertAdmin(actor);

    const venues = await this.db
      .select({
        id: schema.venues.id,
        name: schema.venues.name,
        businessName: schema.businesses.name,
        cityName: schema.cities.name,
        updatedAt: schema.venues.updatedAt,
      })
      .from(schema.venues)
      .innerJoin(schema.businesses, eq(schema.businesses.id, schema.venues.businessId))
      .leftJoin(schema.cities, eq(schema.cities.id, schema.venues.cityId))
      .where(eq(schema.venues.status, 'PENDING_APPROVAL'))
      .orderBy(asc(schema.venues.updatedAt))
      .limit(100);

    const offers = await this.db
      .select({
        id: schema.offers.id,
        name: schema.offers.title,
        businessName: schema.businesses.name,
        cityName: schema.cities.name,
        updatedAt: schema.offers.updatedAt,
      })
      .from(schema.offers)
      .innerJoin(schema.businesses, eq(schema.businesses.id, schema.offers.businessId))
      .innerJoin(schema.venues, eq(schema.venues.id, schema.offers.venueId))
      .leftJoin(schema.cities, eq(schema.cities.id, schema.venues.cityId))
      .where(eq(schema.offers.status, 'PENDING_APPROVAL'))
      .orderBy(asc(schema.offers.updatedAt))
      .limit(100);

    const items: ModerationQueueItem[] = [
      ...venues.map((row) => ({
        id: row.id,
        kind: 'venue' as const,
        name: row.name,
        businessName: row.businessName,
        cityName: row.cityName,
        submittedAt: row.updatedAt.toISOString(),
      })),
      ...offers.map((row) => ({
        id: row.id,
        kind: 'offer' as const,
        name: row.name,
        businessName: row.businessName,
        cityName: row.cityName,
        submittedAt: row.updatedAt.toISOString(),
      })),
    ].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

    return { items };
  }

  async decideVenue(input: {
    actor: AuthenticatedUser;
    venueId: string;
    decision: 'APPROVE' | 'REJECT' | 'SUSPEND' | 'REINSTATE';
    reason?: string;
  }): Promise<{ status: VenueStatus }> {
    this.assertAdmin(input.actor);
    const now = this.clock.now();

    const target: VenueStatus =
      input.decision === 'APPROVE'
        ? 'ACTIVE'
        : input.decision === 'REJECT'
          ? 'REJECTED'
          : input.decision === 'SUSPEND'
            ? 'SUSPENDED'
            : 'ACTIVE';

    // A rejection or suspension without a usable reason is not actionable.
    const reason =
      input.decision === 'REJECT' || input.decision === 'SUSPEND'
        ? OnboardingService.assertRejectionReason(input.reason)
        : null;

    return this.db.transaction(async (tx) => {
      const [venue] = await tx
        .select({ id: schema.venues.id, status: schema.venues.status })
        .from(schema.venues)
        .where(eq(schema.venues.id, input.venueId))
        .for('update')
        .limit(1);

      if (!venue) throw ApiException.notFound('venue', input.venueId);

      assertVenueTransition(venue.status, target, 'ADMIN');

      await tx
        .update(schema.venues)
        .set({
          status: target,
          approvedAt: target === 'ACTIVE' ? now : null,
          rejectedReason: reason,
          updatedAt: now,
        })
        .where(eq(schema.venues.id, input.venueId));

      /**
       * Offers follow their venue.
       *
       * Suspending a venue without pausing its offers would leave them bookable —
       * the single most damaging thing moderation could get wrong.
       */
      if (target !== 'ACTIVE') {
        await tx
          .update(schema.offers)
          .set({ status: 'PAUSED', updatedAt: now })
          .where(
            and(eq(schema.offers.venueId, input.venueId), eq(schema.offers.status, 'ACTIVE')),
          );
      }

      await this.audit.record(tx, {
        actorId: input.actor.id,
        actorType: 'ADMIN',
        action: `venue.${input.decision.toLowerCase()}`,
        entityType: 'venue',
        entityId: input.venueId,
        metadata: { from: venue.status, to: target, reason },
      });

      this.logger.info(
        { venueId: input.venueId, from: venue.status, to: target },
        'venue moderation decision',
      );

      return { status: target };
    });
  }

  async decideOffer(input: {
    actor: AuthenticatedUser;
    offerId: string;
    decision: 'APPROVE' | 'REJECT' | 'PAUSE';
    reason?: string;
  }): Promise<{ status: OfferStatus }> {
    this.assertAdmin(input.actor);
    const now = this.clock.now();

    const target: OfferStatus =
      input.decision === 'APPROVE'
        ? 'ACTIVE'
        : input.decision === 'REJECT'
          ? 'REJECTED'
          : 'PAUSED';

    const reason =
      input.decision === 'REJECT'
        ? OnboardingService.assertRejectionReason(input.reason)
        : (input.reason ?? null);

    return this.db.transaction(async (tx) => {
      const [offer] = await tx
        .select({
          id: schema.offers.id,
          status: schema.offers.status,
          venueStatus: schema.venues.status,
          publishedAt: schema.offers.publishedAt,
        })
        .from(schema.offers)
        .innerJoin(schema.venues, eq(schema.venues.id, schema.offers.venueId))
        .where(eq(schema.offers.id, input.offerId))
        .limit(1);

      if (!offer) throw ApiException.notFound('offer', input.offerId);

      // Approving an offer at a venue that is not itself live would publish
      // something nobody can actually attend.
      if (target === 'ACTIVE' && offer.venueStatus !== 'ACTIVE') {
        throw new ApiException(
          'CONFLICT',
          'Le lieu doit être approuvé avant de publier ses offres.',
          undefined,
          { venueStatus: offer.venueStatus },
        );
      }

      assertOfferTransition(offer.status, target, 'ADMIN');

      await tx
        .update(schema.offers)
        .set({
          status: target,
          // Set once: republishing later must not reset the freshness signal
          // that the discovery ranking reads.
          publishedAt: target === 'ACTIVE' ? (offer.publishedAt ?? now) : offer.publishedAt,
          rejectedReason: input.decision === 'REJECT' ? reason : null,
          updatedAt: now,
        })
        .where(eq(schema.offers.id, input.offerId));

      await this.audit.record(tx, {
        actorId: input.actor.id,
        actorType: 'ADMIN',
        action: `offer.${input.decision.toLowerCase()}`,
        entityType: 'offer',
        entityId: input.offerId,
        metadata: { from: offer.status, to: target, reason },
      });

      return { status: target };
    });
  }

  /** Platform-wide numbers for the admin overview. */
  async overview(actor: AuthenticatedUser): Promise<Record<string, number>> {
    this.assertAdmin(actor);

    const [row] = (await this.db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL)::int AS users,
        (SELECT COUNT(*) FROM users WHERE last_seen_at > now() - interval '30 days')::int AS monthly_active_users,
        (SELECT COUNT(*) FROM venues WHERE status = 'ACTIVE')::int AS active_venues,
        (SELECT COUNT(*) FROM offers WHERE status = 'ACTIVE')::int AS active_offers,
        (SELECT COUNT(*) FROM venues WHERE status = 'PENDING_APPROVAL')::int AS venues_pending,
        (SELECT COUNT(*) FROM offers WHERE status = 'PENDING_APPROVAL')::int AS offers_pending,
        (SELECT COUNT(*) FROM reservations)::int AS bookings,
        (SELECT COUNT(*) FROM reservations WHERE status = 'COMPLETED')::int AS completed_trials,
        (SELECT COUNT(*) FROM reservations WHERE checked_in_at IS NOT NULL)::int AS check_ins,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'SUCCEEDED')::int AS gmv_minor,
        (SELECT COALESCE(SUM(platform_fee_amount), 0) FROM payments WHERE status = 'SUCCEEDED')::int AS platform_revenue_minor,
        (SELECT COUNT(*) FROM leads WHERE status = 'CONVERTED')::int AS conversions
    `)) as unknown as Record<string, number>[];

    return row ?? {};
  }
}
