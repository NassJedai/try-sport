import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  CANCELLATION_POLICY_DEFINITIONS,
  TRIAL_CONSUMING_STATUSES,
  TRIAL_INELIGIBILITY_MESSAGES,
  evaluateTrialEligibility,
} from '@try/contracts';
import type {
  AvailabilityQueryDto,
  AvailabilityResponseDto,
  OfferDetailDto,
  SlotDto,
} from '@try/contracts';
import { discountPercent, money, zonedDayKey } from '@try/utils';
import type { Clock, CurrencyCode } from '@try/utils';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { AppConfig } from '@try/config';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { CONFIG } from '../../common/config.module.js';
import { ApiException } from '../../common/errors/api-exception.js';

/** Slots closer than this are hidden: nobody can cross Brussels in ten minutes. */
const MIN_LEAD_TIME_MINUTES = 30;

@Injectable()
export class OfferService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async findDetail(offerId: string, viewerId: string | null): Promise<OfferDetailDto> {
    const [row] = await this.db
      .select({
        offer: schema.offers,
        venue: schema.venues,
        category: schema.categories,
        district: { name: schema.districts.name },
        city: { name: schema.cities.name },
      })
      .from(schema.offers)
      .innerJoin(schema.venues, eq(schema.venues.id, schema.offers.venueId))
      .innerJoin(schema.categories, eq(schema.categories.id, schema.offers.categoryId))
      .innerJoin(schema.cities, eq(schema.cities.id, schema.venues.cityId))
      .leftJoin(schema.districts, eq(schema.districts.id, schema.venues.districtId))
      .where(eq(schema.offers.id, offerId))
      .limit(1);

    if (!row) throw ApiException.notFound('offer', offerId);

    // A paused or draft offer is invisible to consumers but must stay reachable
    // for the business preview, so this check is on the public route only.
    if (row.offer.status !== 'ACTIVE' && !viewerId) {
      throw ApiException.notFound('offer', offerId);
    }

    const [images, venueImages, reviewData, favorite, eligibility] = await Promise.all([
      this.db
        .select()
        .from(schema.offerImages)
        .where(eq(schema.offerImages.offerId, offerId))
        .orderBy(asc(schema.offerImages.sortOrder)),
      this.db
        .select()
        .from(schema.venueImages)
        .where(eq(schema.venueImages.venueId, row.venue.id))
        .orderBy(asc(schema.venueImages.sortOrder)),
      this.loadReviewSummary(row.venue.id),
      viewerId ? this.isFavorite(viewerId, offerId) : Promise.resolve(false),
      viewerId
        ? this.checkEligibility(viewerId, row.offer, row.venue.id)
        : Promise.resolve(null),
    ]);

    const currency = row.offer.currency as CurrencyCode;
    const price = money(row.offer.priceAmount, currency);
    const reference =
      row.offer.referencePriceAmount !== null &&
      row.offer.referencePriceAmount > row.offer.priceAmount
        ? money(row.offer.referencePriceAmount, currency)
        : null;

    const badges: OfferDetailDto['badges'] = [];
    if (price.amount === 0) badges.push('FREE');
    else if (reference) badges.push('DISCOVERY_PRICE');

    return {
      id: row.offer.id,
      status: row.offer.status,
      title: row.offer.title,
      description: row.offer.description,
      experienceType: row.offer.experienceType,
      skillLevel: row.offer.skillLevel,
      category: {
        id: row.category.id,
        slug: row.category.slug,
        name: row.category.name,
        icon: row.category.icon,
      },
      price,
      referencePrice: reference,
      discountPercent: reference ? discountPercent(reference, price) : 0,
      badges,
      durationMinutes: row.offer.durationMinutes,
      capacity: row.offer.capacity,
      languages: row.offer.languages as OfferDetailDto['languages'],
      gallery: images.map((image) => this.buildImage(image)),
      amenities: row.offer.amenities,
      whatToBring: row.offer.whatToBring,
      conditions: row.offer.conditions,
      cancellationPolicy: row.offer.cancellationPolicy,
      cancellationPolicyLabel:
        CANCELLATION_POLICY_DEFINITIONS[row.offer.cancellationPolicy].labelFr,
      trialRule: row.offer.trialRule,
      venue: {
        id: row.venue.id,
        slug: row.venue.slug,
        name: row.venue.name,
        coordinates: { latitude: row.venue.latitude, longitude: row.venue.longitude },
        addressLine: row.venue.addressLine,
        districtName: row.district?.name ?? null,
        cityName: row.city.name,
        timeZone: row.venue.timeZone,
        logo: null,
        averageRating: row.venue.averageRating === null ? null : row.venue.averageRating / 100,
        reviewCount: row.venue.reviewCount,
        description: row.venue.description,
        phone: row.venue.phone,
        website: row.venue.website,
        instagram: row.venue.instagram,
        cover: venueImages[0] ? this.buildImage(venueImages[0]) : null,
        gallery: venueImages.map((image) => this.buildImage(image)),
        amenities: row.venue.amenities,
        languages: row.venue.languages as OfferDetailDto['venue']['languages'],
        openingHours: row.venue.openingHours,
        categories: [
          { id: row.category.id, slug: row.category.slug, name: row.category.name },
        ],
      },
      distanceMeters: null,
      reviews: reviewData,
      viewerEligibility: eligibility,
      isFavorite: favorite,
      publishedAt: row.offer.publishedAt?.toISOString() ?? null,
    };
  }

  /**
   * Availability grouped by the *venue's* calendar day.
   *
   * Grouping by UTC day would put a 21:00 Brussels class on the wrong date for
   * half the year, and a 00:30 session on the previous day.
   */
  async findAvailability(
    offerId: string,
    query: AvailabilityQueryDto,
  ): Promise<AvailabilityResponseDto> {
    const now = this.clock.now();

    const [offer] = await this.db
      .select({
        id: schema.offers.id,
        status: schema.offers.status,
        timeZone: schema.venues.timeZone,
      })
      .from(schema.offers)
      .innerJoin(schema.venues, eq(schema.venues.id, schema.offers.venueId))
      .where(eq(schema.offers.id, offerId))
      .limit(1);

    if (!offer) throw ApiException.notFound('offer', offerId);

    const from = query.from ? new Date(query.from) : now;
    const earliest = new Date(
      Math.max(from.getTime(), now.getTime() + MIN_LEAD_TIME_MINUTES * 60_000),
    );
    const until = new Date(earliest.getTime() + query.days * 86_400_000);

    const rows = await this.db
      .select({
        id: schema.slots.id,
        startAt: schema.slots.startAt,
        endAt: schema.slots.endAt,
        capacity: schema.slots.capacity,
        reservedCount: schema.slots.reservedCount,
        status: schema.slots.status,
      })
      .from(schema.slots)
      .where(
        and(
          eq(schema.slots.offerId, offerId),
          gte(schema.slots.startAt, earliest),
          lte(schema.slots.startAt, until),
          // Cancelled slots are excluded entirely; full ones are shown as disabled
          // so the user sees the class exists and can pick another time.
          sql`${schema.slots.status} IN ('OPEN', 'FULL')`,
        ),
      )
      .orderBy(asc(schema.slots.startAt))
      // Hard cap: a client cannot request an unbounded slot list.
      .limit(500);

    const byDay = new Map<string, SlotDto[]>();
    for (const slot of rows) {
      const dayKey = zonedDayKey(slot.startAt, offer.timeZone);
      const remaining = Math.max(0, slot.capacity - slot.reservedCount);

      const entry: SlotDto = {
        id: slot.id,
        startAt: slot.startAt.toISOString(),
        endAt: slot.endAt.toISOString(),
        capacity: slot.capacity,
        remainingCapacity: remaining,
        isBookable: slot.status === 'OPEN' && remaining > 0,
      };

      const existing = byDay.get(dayKey);
      if (existing) existing.push(entry);
      else byDay.set(dayKey, [entry]);
    }

    return {
      offerId,
      timeZone: offer.timeZone,
      days: [...byDay.entries()].map(([date, slots]) => ({ date, slots })),
    };
  }

  private async loadReviewSummary(venueId: string): Promise<OfferDetailDto['reviews']> {
    const [aggregate] = await this.db
      .select({
        average: sql<number | null>`AVG(${schema.reviews.rating})::float`,
        total: sql<number>`COUNT(*)::int`,
      })
      .from(schema.reviews)
      .where(and(eq(schema.reviews.venueId, venueId), eq(schema.reviews.isPublished, true)));

    const distributionRows = await this.db
      .select({
        rating: schema.reviews.rating,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(schema.reviews)
      .where(and(eq(schema.reviews.venueId, venueId), eq(schema.reviews.isPublished, true)))
      .groupBy(schema.reviews.rating);

    const latest = await this.db
      .select({
        id: schema.reviews.id,
        rating: schema.reviews.rating,
        comment: schema.reviews.comment,
        createdAt: schema.reviews.createdAt,
        firstName: schema.profiles.firstName,
      })
      .from(schema.reviews)
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.reviews.userId))
      .where(and(eq(schema.reviews.venueId, venueId), eq(schema.reviews.isPublished, true)))
      .orderBy(sql`${schema.reviews.createdAt} DESC`)
      .limit(5);

    return {
      averageRating: aggregate?.average ?? null,
      reviewCount: aggregate?.total ?? 0,
      distribution: Object.fromEntries(
        distributionRows.map((row) => [String(row.rating), row.count]),
      ),
      latest: latest.map((review) => ({
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        // Only a first name is ever published alongside a review.
        authorFirstName: review.firstName ?? 'Membre TRIALYA',
        createdAt: review.createdAt.toISOString(),
      })),
    };
  }

  private async isFavorite(userId: string, offerId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ offerId: schema.favorites.offerId })
      .from(schema.favorites)
      .where(and(eq(schema.favorites.userId, userId), eq(schema.favorites.offerId, offerId)))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Resolves eligibility for display. This is advisory only — the booking
   * transaction re-evaluates it under a lock, because anything shown to a client
   * can be stale by the time they tap.
   */
  private async checkEligibility(
    userId: string,
    offer: typeof schema.offers.$inferSelect,
    venueId: string,
  ): Promise<OfferDetailDto['viewerEligibility']> {
    if (offer.trialRule === 'NO_RESTRICTION') {
      return { eligible: true, reason: null, message: null };
    }

    const history = await this.db
      .select({
        businessId: schema.trialHistory.businessId,
        venueId: schema.trialHistory.venueId,
        offerId: schema.trialHistory.offerId,
        status: schema.trialHistory.status,
      })
      .from(schema.trialHistory)
      .where(
        and(
          eq(schema.trialHistory.userId, userId),
          eq(schema.trialHistory.businessId, offer.businessId),
          // `inArray`, jamais « = ANY(tableau interpolé) » : Drizzle déplie un tableau JS
          // en tuple « ($1, $2) », que Postgres refuse de caster en tableau.
          inArray(schema.trialHistory.status, [...TRIAL_CONSUMING_STATUSES]),
        ),
      );

    const result = evaluateTrialEligibility({
      rule: offer.trialRule,
      businessId: offer.businessId,
      venueId,
      offerId: offer.id,
      history,
    });

    return result.eligible
      ? { eligible: true, reason: null, message: null }
      : {
          eligible: false,
          reason: result.reason,
          message: TRIAL_INELIGIBILITY_MESSAGES[result.reason],
        };
  }

  private buildImage(image: {
    storageKey: string;
    width: number;
    height: number;
    blurhash: string | null;
  }) {
    const base = this.config.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, '');
    return {
      thumbnail: `${base}/${image.storageKey}?w=400&q=70&fm=webp`,
      medium: `${base}/${image.storageKey}?w=800&q=75&fm=webp`,
      large: `${base}/${image.storageKey}?w=1600&q=80&fm=webp`,
      blurhash: image.blurhash,
      width: image.width,
      height: image.height,
    };
  }

  static minLeadTimeMinutes(): number {
    return MIN_LEAD_TIME_MINUTES;
  }
}
