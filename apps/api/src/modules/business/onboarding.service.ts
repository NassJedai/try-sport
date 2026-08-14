import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  assertOfferTransition,
  assertVenueTransition,
  REJECTION_REASON_MIN_LENGTH,
} from '@try/contracts';
import type { CreateBusinessDto, CreateOfferDto, CreateVenueDto } from '@try/contracts';
import { slugify } from '@try/utils';
import type { Clock } from '@try/utils';
import { schema } from '@try/database';
import type { Database, Transaction } from '@try/database';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { AuditService } from '../admin/audit.service.js';
import { hasBusinessRole, type AuthenticatedUser } from '../../common/auth/current-user.js';

/**
 * Business self-serve onboarding.
 *
 * Signup → business → venue → offer → schedule → submit → admin approval.
 * Nothing a business creates reaches a consumer without passing through
 * moderation; the transitions are enforced by the shared state machine, so a
 * business cannot publish itself by calling a different endpoint.
 */
@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates the business and makes the caller its OWNER in one transaction.
   *
   * If the membership insert failed separately, we would have an ownerless
   * business that nobody — including support — could administer.
   */
  async createBusiness(input: {
    actor: AuthenticatedUser;
    dto: CreateBusinessDto;
  }): Promise<{ businessId: string }> {
    const now = this.clock.now();

    return this.db.transaction(async (tx) => {
      const slug = await this.uniqueSlug(tx, schema.businesses, slugify(input.dto.name));

      const [business] = await tx
        .insert(schema.businesses)
        .values({
          slug,
          name: input.dto.name,
          legalName: input.dto.legalName ?? null,
          vatNumber: input.dto.vatNumber ?? null,
          contactEmail: input.dto.contactEmail,
          contactPhone: input.dto.contactPhone ?? null,
          countryCode: input.dto.countryCode,
          // Commercial terms are platform-set, never client-supplied.
          status: 'PENDING_APPROVAL',
          billingModel: 'COMMISSION',
          commissionBasisPoints: 1500,
        })
        .returning({ id: schema.businesses.id });

      if (!business) throw new ApiException('INTERNAL_ERROR');

      await tx.insert(schema.businessMembers).values({
        businessId: business.id,
        userId: input.actor.id,
        role: 'OWNER',
        acceptedAt: now,
      });

      // The account is now staff as well as a consumer; both roles coexist.
      await tx
        .update(schema.users)
        .set({ role: 'BUSINESS_MEMBER', updatedAt: now })
        .where(and(eq(schema.users.id, input.actor.id), eq(schema.users.role, 'USER')));

      await this.audit.record(tx, {
        actorId: input.actor.id,
        actorType: 'BUSINESS_MEMBER',
        action: 'business.create',
        entityType: 'business',
        entityId: business.id,
        metadata: { name: input.dto.name },
      });

      return { businessId: business.id };
    });
  }

  async createVenue(input: {
    actor: AuthenticatedUser;
    businessId: string;
    dto: CreateVenueDto;
  }): Promise<{ venueId: string }> {
    this.assertRole(input.actor, input.businessId, 'MANAGER');

    return this.db.transaction(async (tx) => {
      const slug = await this.uniqueSlug(tx, schema.venues, slugify(input.dto.name));

      const [venue] = await tx
        .insert(schema.venues)
        .values({
          businessId: input.businessId,
          slug,
          name: input.dto.name,
          description: input.dto.description ?? null,
          status: 'DRAFT',
          addressLine: input.dto.addressLine,
          postalCode: input.dto.postalCode,
          cityId: input.dto.cityId,
          districtId: input.dto.districtId ?? null,
          latitude: input.dto.latitude,
          longitude: input.dto.longitude,
          timeZone: input.dto.timeZone,
          phone: input.dto.phone ?? null,
          website: input.dto.website ?? null,
          instagram: input.dto.instagram ?? null,
          amenities: input.dto.amenities,
          languages: input.dto.languages,
          openingHours: input.dto.openingHours,
        })
        .returning({ id: schema.venues.id });

      if (!venue) throw new ApiException('INTERNAL_ERROR');

      if (input.dto.categoryIds.length > 0) {
        await tx.insert(schema.venueCategories).values(
          input.dto.categoryIds.map((categoryId) => ({ venueId: venue.id, categoryId })),
        );
      }

      return { venueId: venue.id };
    });
  }

  async createOffer(input: {
    actor: AuthenticatedUser;
    dto: CreateOfferDto;
  }): Promise<{ offerId: string }> {
    const venue = await this.loadVenue(input.dto.venueId);
    this.assertRole(input.actor, venue.businessId, 'MANAGER');

    /**
     * The reference price must genuinely exceed the trial price. A database
     * constraint enforces it too; rejecting it here gives the business a message
     * it can act on instead of a constraint violation.
     */
    if (
      input.dto.referencePriceAmount !== null &&
      input.dto.referencePriceAmount < input.dto.priceAmount
    ) {
      throw new ApiException(
        'VALIDATION_FAILED',
        'Le prix habituel doit être supérieur ou égal au prix découverte.',
        { referencePriceAmount: ['must be >= priceAmount'] },
      );
    }

    const [offer] = await this.db
      .insert(schema.offers)
      .values({
        venueId: input.dto.venueId,
        // Denormalised from the venue, never taken from the client.
        businessId: venue.businessId,
        categoryId: input.dto.categoryId,
        title: input.dto.title,
        description: input.dto.description,
        status: 'DRAFT',
        experienceType: input.dto.experienceType,
        skillLevel: input.dto.skillLevel,
        priceAmount: input.dto.priceAmount,
        referencePriceAmount: input.dto.referencePriceAmount,
        currency: input.dto.currency,
        durationMinutes: input.dto.durationMinutes,
        capacity: input.dto.capacity,
        languages: input.dto.languages,
        amenities: input.dto.amenities,
        whatToBring: input.dto.whatToBring,
        conditions: input.dto.conditions,
        cancellationPolicy: input.dto.cancellationPolicy,
        trialRule: input.dto.trialRule,
      })
      .returning({ id: schema.offers.id });

    if (!offer) throw new ApiException('INTERNAL_ERROR');
    return { offerId: offer.id };
  }

  /** Submits a venue for moderation. */
  async submitVenue(input: { actor: AuthenticatedUser; venueId: string }): Promise<void> {
    const venue = await this.loadVenue(input.venueId);
    this.assertRole(input.actor, venue.businessId, 'MANAGER');

    // A venue with nothing to book would waste a moderator's time.
    const offers = await this.db
      .select({ id: schema.offers.id })
      .from(schema.offers)
      .where(eq(schema.offers.venueId, input.venueId))
      .limit(1);

    if (offers.length === 0) {
      throw new ApiException(
        'CONFLICT',
        'Ajoute au moins une offre avant de soumettre ton lieu.',
      );
    }

    assertVenueTransition(venue.status, 'PENDING_APPROVAL', 'BUSINESS');

    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.venues)
        .set({ status: 'PENDING_APPROVAL', updatedAt: this.clock.now() })
        .where(eq(schema.venues.id, input.venueId));

      await this.audit.record(tx, {
        actorId: input.actor.id,
        actorType: 'BUSINESS_MEMBER',
        action: 'venue.submit',
        entityType: 'venue',
        entityId: input.venueId,
        metadata: { from: venue.status },
      });
    });
  }

  async submitOffer(input: { actor: AuthenticatedUser; offerId: string }): Promise<void> {
    const offer = await this.loadOffer(input.offerId);
    this.assertRole(input.actor, offer.businessId, 'MANAGER');

    assertOfferTransition(offer.status, 'PENDING_APPROVAL', 'BUSINESS');

    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.offers)
        .set({ status: 'PENDING_APPROVAL', updatedAt: this.clock.now() })
        .where(eq(schema.offers.id, input.offerId));

      await this.audit.record(tx, {
        actorId: input.actor.id,
        actorType: 'BUSINESS_MEMBER',
        action: 'offer.submit',
        entityType: 'offer',
        entityId: input.offerId,
        metadata: { from: offer.status },
      });
    });
  }

  /** Pausing and resuming are the business's own controls; no moderation needed. */
  async setOfferPaused(input: {
    actor: AuthenticatedUser;
    offerId: string;
    paused: boolean;
  }): Promise<void> {
    const offer = await this.loadOffer(input.offerId);
    this.assertRole(input.actor, offer.businessId, 'MANAGER');

    const target = input.paused ? 'PAUSED' : 'ACTIVE';
    assertOfferTransition(offer.status, target, 'BUSINESS');

    await this.db
      .update(schema.offers)
      .set({ status: target, updatedAt: this.clock.now() })
      .where(eq(schema.offers.id, input.offerId));
  }

  private assertRole(
    actor: AuthenticatedUser,
    businessId: string,
    role: 'STAFF' | 'MANAGER' | 'OWNER',
  ): void {
    if (!hasBusinessRole(actor, businessId, role)) {
      throw ApiException.forbidden(`requires ${role} on business ${businessId}`);
    }
  }

  private async loadVenue(venueId: string) {
    const [venue] = await this.db
      .select({
        id: schema.venues.id,
        businessId: schema.venues.businessId,
        status: schema.venues.status,
      })
      .from(schema.venues)
      .where(eq(schema.venues.id, venueId))
      .limit(1);

    if (!venue) throw ApiException.notFound('venue', venueId);
    return venue;
  }

  private async loadOffer(offerId: string) {
    const [offer] = await this.db
      .select({
        id: schema.offers.id,
        businessId: schema.offers.businessId,
        venueId: schema.offers.venueId,
        status: schema.offers.status,
      })
      .from(schema.offers)
      .where(eq(schema.offers.id, offerId))
      .limit(1);

    if (!offer) throw ApiException.notFound('offer', offerId);
    return offer;
  }

  /**
   * Slugs are user-visible and must be unique. Collisions are resolved with a
   * numeric suffix rather than by rejecting the name — two studios may legitimately
   * both be called "Studio Move".
   */
  private async uniqueSlug(
    tx: Transaction,
    table: typeof schema.businesses | typeof schema.venues,
    base: string,
  ): Promise<string> {
    const candidate = base || 'venue';

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const slug = attempt === 0 ? candidate : `${candidate}-${attempt + 1}`;
      const existing = await tx
        .select({ slug: table.slug })
        .from(table)
        .where(eq(table.slug, slug))
        .limit(1);

      if (existing.length === 0) return slug;
    }

    // Falls back to a suffix that cannot realistically collide.
    return `${candidate}-${this.clock.now().getTime().toString(36)}`;
  }

  static assertRejectionReason(reason: string | undefined): string {
    if (!reason || reason.trim().length < REJECTION_REASON_MIN_LENGTH) {
      throw new ApiException(
        'VALIDATION_FAILED',
        'Explique la raison du refus pour que l’établissement puisse corriger.',
        { reason: [`minimum ${REJECTION_REASON_MIN_LENGTH} characters`] },
      );
    }
    return reason.trim();
  }
}
