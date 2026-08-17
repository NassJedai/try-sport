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
import { DomainEvents } from '../events/domain-events.js';

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
    private readonly events: DomainEvents,
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

    const result = await this.db.transaction(async (tx) => {
      const [venue] = await tx
        .select({
          id: schema.venues.id,
          status: schema.venues.status,
          businessId: schema.venues.businessId,
        })
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

      /**
       * Approuver un lieu active l'établissement qui le porte.
       *
       * Sans cela, l'inscription en libre-service est un cul-de-sac : un
       * établissement naît PENDING_APPROVAL, la découverte filtre là-dessus, et
       * RIEN dans la console ne permettait de le faire passer à ACTIVE. Le lieu
       * et l'offre pouvaient être approuvés, publiés, avec leurs créneaux — et
       * rester introuvables pour toujours. Vu en s'inscrivant vraiment.
       *
       * Le geste est le bon : un admin qui valide l'adresse et le nom d'un lieu
       * a déjà examiné tout ce qu'il y a à examiner de l'établissement. Un écran
       * séparé n'ajouterait qu'une étape, pas une information.
       *
       * Restreint aux établissements ENCORE en attente : réactiver un lieu ne
       * doit jamais relever une suspension décidée au niveau de l'entreprise.
       */
      if (target === 'ACTIVE') {
        await tx
          .update(schema.businesses)
          .set({ status: 'ACTIVE', updatedAt: now })
          .where(
            and(
              eq(schema.businesses.id, venue.businessId),
              eq(schema.businesses.status, 'PENDING_APPROVAL'),
            ),
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

      return { status: target, businessId: venue.businessId };
    });

    // Émis après le commit, jamais dedans — un `decideVenue` tient un `FOR
    // UPDATE` sur la ligne du lieu ; un fournisseur d'e-mail lent à l'intérieur
    // retiendrait ce verrou, et un événement émis avant le commit annoncerait
    // une décision qu'un rollback peut encore annuler. Voir
    // `VenueIdentityChanged` (onboarding.service.ts) et la correction de
    // `LeadConverted` (business.service.ts) pour le même principe déjà appliqué
    // ailleurs — à l'inverse de `BookingConfirmed`
    // (`booking.service.ts:205`), dette connue, pas un modèle à suivre.
    this.events.emit('VenueModerationDecided', {
      venueId: input.venueId,
      businessId: result.businessId,
      decision: input.decision,
      status: result.status,
      reason,
    });

    return { status: result.status };
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

    const result = await this.db.transaction(async (tx) => {
      const [offer] = await tx
        .select({
          id: schema.offers.id,
          status: schema.offers.status,
          venueId: schema.offers.venueId,
          businessId: schema.offers.businessId,
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

      return { status: target, venueId: offer.venueId, businessId: offer.businessId };
    });

    // Émis après le commit — même raison que `decideVenue` juste au-dessus.
    this.events.emit('OfferModerationDecided', {
      offerId: input.offerId,
      venueId: result.venueId,
      businessId: result.businessId,
      decision: input.decision,
      status: result.status,
      // Reflète exactement ce qui est écrit en base : `rejectedReason` n'est
      // renseigné que sur REJECT, un motif de PAUSE n'étant pas persisté.
      reason: input.decision === 'REJECT' ? reason : null,
    });

    return { status: result.status };
  }

  /**
   * Platform-wide numbers for the admin overview.
   *
   * Aliases are quoted camelCase deliberately. Postgres folds unquoted
   * identifiers to lower case, so `AS monthlyActiveUsers` would arrive as
   * `monthlyactiveusers`; the quotes are what let this payload match every
   * other endpoint instead of leaking SQL's naming convention to clients.
   */
  async overview(actor: AuthenticatedUser): Promise<Record<string, number>> {
    this.assertAdmin(actor);

    const [row] = (await this.db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL)::int AS "users",
        (SELECT COUNT(*) FROM users WHERE last_seen_at > now() - interval '30 days')::int AS "monthlyActiveUsers",
        (SELECT COUNT(*) FROM venues WHERE status = 'ACTIVE')::int AS "activeVenues",
        (SELECT COUNT(*) FROM offers WHERE status = 'ACTIVE')::int AS "activeOffers",
        (SELECT COUNT(*) FROM venues WHERE status = 'PENDING_APPROVAL')::int AS "venuesPending",
        (SELECT COUNT(*) FROM offers WHERE status = 'PENDING_APPROVAL')::int AS "offersPending",
        (SELECT COUNT(*) FROM reservations)::int AS "bookings",
        (SELECT COUNT(*) FROM reservations WHERE status = 'COMPLETED')::int AS "completedTrials",
        (SELECT COUNT(*) FROM reservations WHERE checked_in_at IS NOT NULL)::int AS "checkIns",
        -- Net du rembourse : un remboursement partiel doit faire baisser le GMV et
        -- la commission affichee, pas seulement disparaitre d'un des deux chiffres.
        -- PARTIALLY_REFUNDED et REFUNDED restent inclus (le brut a bien ete
        -- encaisse), refunded_amount/refunded_platform_fee_amount portent la part
        -- rendue.
        (SELECT COALESCE(SUM(amount - refunded_amount), 0) FROM payments
          WHERE status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'))::int AS "gmvMinor",
        (SELECT COALESCE(SUM(platform_fee_amount - refunded_platform_fee_amount), 0) FROM payments
          WHERE status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'))::int AS "platformRevenueMinor",
        (SELECT COUNT(*) FROM leads WHERE status = 'CONVERTED')::int AS "conversions"
    `)) as unknown as Record<string, number>[];

    return row ?? {};
  }
}
