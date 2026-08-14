import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '@try/database';
import { DATABASE } from '../../common/database.module.js';

/**
 * Discovery reads.
 *
 * These are hand-written SQL rather than query-builder chains for two reasons:
 * the PostGIS `location` column is intentionally outside the drizzle schema, and
 * these are the hottest queries in the product — being able to read exactly what
 * Postgres will execute, and to paste it into EXPLAIN, is worth more here than
 * builder ergonomics.
 *
 * Every query is bounded by LIMIT and filtered on indexed predicates.
 */

export interface OfferCardRow extends Record<string, unknown> {
  id: string;
  title: string;
  experience_type: string;
  price_amount: number;
  reference_price_amount: number | null;
  currency: string;
  duration_minutes: number;
  published_at: Date | null;
  category_slug: string;
  category_name: string;
  venue_id: string;
  venue_name: string;
  venue_latitude: number;
  venue_longitude: number;
  district_name: string | null;
  average_rating: number | null;
  review_count: number;
  distance_meters: number | null;
  next_slot_at: Date | null;
  image_key: string | null;
  image_width: number | null;
  image_height: number | null;
  image_blurhash: string | null;
  trial_count: number;
  conversion_count: number;
}

export interface NearbyQuery {
  latitude: number | null;
  longitude: number | null;
  cityId: string | null;
  radiusMeters: number;
  limit: number;
  categoryIds?: string[];
  maxPrice?: number;
  freeOnly?: boolean;
  availableFrom?: Date;
  availableTo?: Date;
  minRating?: number;
  search?: string;
  experienceTypes?: string[];
  skillLevels?: string[];
  districtIds?: string[];
  sort?: 'RELEVANCE' | 'DISTANCE' | 'PRICE_ASC' | 'RATING' | 'SOONEST';
  cursorOffset?: number;
}

@Injectable()
export class DiscoveryRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The core discovery query.
   *
   * `ST_DWithin(location, origin, radius)` is index-assisted by the GiST index on
   * `venues.location`, so the radius filter runs before any join work rather than
   * computing a distance for every venue in the country.
   *
   * The next-bookable-slot is a LATERAL subquery: it stops at the first matching
   * row per offer, instead of aggregating the whole slots table and discarding
   * all but the earliest.
   */
  async findOffers(query: NearbyQuery): Promise<OfferCardRow[]> {
    const hasOrigin = query.latitude !== null && query.longitude !== null;

    // Built as one parameterised fragment; nothing here is string-interpolated
    // from user input, so the query plan is stable and injection is impossible.
    const origin = hasOrigin
      ? sql`ST_SetSRID(ST_MakePoint(${query.longitude}, ${query.latitude}), 4326)::geography`
      : sql`(SELECT c.location FROM cities c WHERE c.id = ${query.cityId})`;

    const conditions = [
      sql`o.status = 'ACTIVE'`,
      sql`v.status = 'ACTIVE'`,
      sql`b.status = 'ACTIVE'`,
      sql`o.deleted_at IS NULL`,
      sql`v.deleted_at IS NULL`,
    ];

    if (hasOrigin || query.cityId) {
      conditions.push(sql`ST_DWithin(v.location, ${origin}, ${query.radiusMeters})`);
    }
    if (query.cityId && !hasOrigin) {
      conditions.push(sql`v.city_id = ${query.cityId}`);
    }
    if (query.categoryIds?.length) {
      conditions.push(sql`o.category_id = ANY(${query.categoryIds}::uuid[])`);
    }
    if (query.districtIds?.length) {
      conditions.push(sql`v.district_id = ANY(${query.districtIds}::uuid[])`);
    }
    if (query.freeOnly) {
      conditions.push(sql`o.price_amount = 0`);
    }
    if (query.maxPrice !== undefined) {
      conditions.push(sql`o.price_amount <= ${query.maxPrice}`);
    }
    if (query.minRating !== undefined) {
      conditions.push(sql`v.average_rating_hundredths >= ${Math.round(query.minRating * 100)}`);
    }
    if (query.experienceTypes?.length) {
      conditions.push(sql`o.experience_type = ANY(${query.experienceTypes}::experience_type[])`);
    }
    if (query.skillLevels?.length) {
      conditions.push(sql`o.skill_level = ANY(${query.skillLevels}::skill_level[])`);
    }
    if (query.search) {
      // websearch_to_tsquery tolerates the punctuation people actually type.
      conditions.push(
        sql`(o.search_vector @@ websearch_to_tsquery('french', ${query.search})
             OR v.search_vector @@ websearch_to_tsquery('french', ${query.search})
             OR v.name % ${query.search})`,
      );
    }

    /**
     * A slot must exist for the offer to be worth showing at all.
     *
     * When the caller gives no explicit window the cutoff is Postgres's `now()`,
     * not the API process's clock: several API instances with a few seconds of
     * drift would otherwise disagree about whether a 19:00 class is still bookable.
     */
    const slotWindowStart = query.availableFrom ? sql`${query.availableFrom}` : sql`now()`;
    const slotConditions = [
      sql`s.offer_id = o.id`,
      sql`s.status = 'OPEN'`,
      sql`s.reserved_count < s.capacity`,
      sql`s.start_at > ${slotWindowStart}`,
    ];
    if (query.availableTo) {
      slotConditions.push(sql`s.start_at <= ${query.availableTo}`);
    }

    const distanceExpression =
      hasOrigin || query.cityId ? sql`ST_Distance(v.location, ${origin})` : sql`NULL::double precision`;

    const orderBy = this.buildOrderBy(query.sort ?? 'RELEVANCE', hasOrigin || Boolean(query.cityId));

    const rows = await this.db.execute<OfferCardRow>(sql`
      SELECT
        o.id,
        o.title,
        o.experience_type,
        o.price_amount,
        o.reference_price_amount,
        o.currency,
        o.duration_minutes,
        o.published_at,
        o.trial_count,
        o.conversion_count,
        c.slug  AS category_slug,
        c.name  AS category_name,
        v.id    AS venue_id,
        v.name  AS venue_name,
        v.latitude  AS venue_latitude,
        v.longitude AS venue_longitude,
        d.name  AS district_name,
        v.average_rating_hundredths AS average_rating,
        v.review_count,
        ${distanceExpression} AS distance_meters,
        next_slot.start_at AS next_slot_at,
        img.storage_key AS image_key,
        img.width  AS image_width,
        img.height AS image_height,
        img.blurhash AS image_blurhash
      FROM offers o
      JOIN venues     v ON v.id = o.venue_id
      JOIN businesses b ON b.id = o.business_id
      JOIN categories c ON c.id = o.category_id
      LEFT JOIN districts d ON d.id = v.district_id
      -- First bookable slot only; LATERAL stops at one row per offer.
      LEFT JOIN LATERAL (
        SELECT s.start_at
        FROM slots s
        WHERE ${sql.join(slotConditions, sql` AND `)}
        ORDER BY s.start_at ASC
        LIMIT 1
      ) next_slot ON TRUE
      LEFT JOIN LATERAL (
        SELECT oi.storage_key, oi.width, oi.height, oi.blurhash
        FROM offer_images oi
        WHERE oi.offer_id = o.id
        ORDER BY oi.sort_order ASC
        LIMIT 1
      ) img ON TRUE
      WHERE ${sql.join(conditions, sql` AND `)}
        AND next_slot.start_at IS NOT NULL
      ORDER BY ${orderBy}
      LIMIT ${query.limit}
      OFFSET ${query.cursorOffset ?? 0}
    `);

    return rows as unknown as OfferCardRow[];
  }

  private buildOrderBy(sort: NonNullable<NearbyQuery['sort']>, hasDistance: boolean) {
    switch (sort) {
      case 'DISTANCE':
        return hasDistance ? sql`distance_meters ASC NULLS LAST, o.id ASC` : sql`o.id ASC`;
      case 'PRICE_ASC':
        return sql`o.price_amount ASC, o.id ASC`;
      case 'RATING':
        return sql`v.average_rating_hundredths DESC NULLS LAST, v.review_count DESC, o.id ASC`;
      case 'SOONEST':
        return sql`next_slot.start_at ASC NULLS LAST, o.id ASC`;
      case 'RELEVANCE':
      default:
        /**
         * A cheap SQL proxy for the ranking model: near, well-rated and available
         * soon. The full weighted score (including personalisation) is applied in
         * the service over this candidate set — ranking the entire table in SQL
         * would mean scoring rows nobody will ever see.
         */
        return hasDistance
          ? sql`distance_meters ASC NULLS LAST, v.average_rating_hundredths DESC NULLS LAST, o.id ASC`
          : sql`v.average_rating_hundredths DESC NULLS LAST, o.id ASC`;
    }
  }

  /**
   * Map pins for a viewport. Capped, and the caller is told when the cap bit, so
   * the UI can prompt the user to zoom rather than silently showing a subset.
   */
  async findMapPins(input: {
    bounds: { minLatitude: number; minLongitude: number; maxLatitude: number; maxLongitude: number };
    limit: number;
    categoryIds?: string[];
    maxPrice?: number;
    freeOnly?: boolean;
  }): Promise<
    {
      offer_id: string;
      venue_id: string;
      latitude: number;
      longitude: number;
      price_amount: number;
      currency: string;
      category_slug: string;
    }[]
  > {
    const conditions = [
      sql`o.status = 'ACTIVE'`,
      sql`v.status = 'ACTIVE'`,
      sql`o.deleted_at IS NULL`,
      // ST_MakeEnvelope + && uses the GiST index for the viewport test.
      sql`v.location && ST_MakeEnvelope(
            ${input.bounds.minLongitude}, ${input.bounds.minLatitude},
            ${input.bounds.maxLongitude}, ${input.bounds.maxLatitude}, 4326
          )::geography`,
    ];

    if (input.categoryIds?.length) {
      conditions.push(sql`o.category_id = ANY(${input.categoryIds}::uuid[])`);
    }
    if (input.freeOnly) conditions.push(sql`o.price_amount = 0`);
    if (input.maxPrice !== undefined) conditions.push(sql`o.price_amount <= ${input.maxPrice}`);

    const rows = await this.db.execute(sql`
      SELECT
        o.id AS offer_id,
        v.id AS venue_id,
        v.latitude,
        v.longitude,
        o.price_amount,
        o.currency,
        c.slug AS category_slug
      FROM offers o
      JOIN venues v ON v.id = o.venue_id
      JOIN categories c ON c.id = o.category_id
      WHERE ${sql.join(conditions, sql` AND `)}
        AND EXISTS (
          SELECT 1 FROM slots s
          WHERE s.offer_id = o.id AND s.status = 'OPEN'
            AND s.reserved_count < s.capacity AND s.start_at > now()
        )
      ORDER BY o.price_amount ASC
      LIMIT ${input.limit}
    `);

    return rows as unknown as {
      offer_id: string;
      venue_id: string;
      latitude: number;
      longitude: number;
      price_amount: number;
      currency: string;
      category_slug: string;
    }[];
  }

  /** Resolves the city whose centroid is closest, for the home header. */
  async resolveCity(input: {
    latitude: number | null;
    longitude: number | null;
    cityId: string | null;
  }): Promise<{ id: string; name: string; latitude: number; longitude: number } | null> {
    const rows = await this.db.execute(
      input.cityId
        ? sql`SELECT id, name, latitude, longitude FROM cities WHERE id = ${input.cityId} LIMIT 1`
        : input.latitude !== null && input.longitude !== null
          ? sql`
              SELECT id, name, latitude, longitude
              FROM cities
              WHERE is_active = true
              ORDER BY location <-> ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326)::geography
              LIMIT 1
            `
          : sql`SELECT id, name, latitude, longitude FROM cities WHERE is_active = true ORDER BY created_at ASC LIMIT 1`,
    );

    const list = rows as unknown as {
      id: string;
      name: string;
      latitude: number;
      longitude: number;
    }[];
    return list[0] ?? null;
  }

  async listCategoriesWithCounts(
    cityId: string | null,
  ): Promise<{ id: string; slug: string; name: string; icon: string; offer_count: number }[]> {
    const rows = await this.db.execute(sql`
      SELECT c.id, c.slug, c.name, c.icon,
             COUNT(o.id)::int AS offer_count
      FROM categories c
      LEFT JOIN offers o
        ON o.category_id = c.id AND o.status = 'ACTIVE' AND o.deleted_at IS NULL
      LEFT JOIN venues v
        ON v.id = o.venue_id AND v.status = 'ACTIVE'
        ${cityId ? sql`AND v.city_id = ${cityId}` : sql``}
      WHERE c.is_active = true
      GROUP BY c.id, c.slug, c.name, c.icon, c.sort_order
      ORDER BY c.sort_order ASC
    `);

    return rows as unknown as {
      id: string;
      slug: string;
      name: string;
      icon: string;
      offer_count: number;
    }[];
  }

  /** Interest category ids for personalising the ranking. */
  async findUserInterestCategoryIds(userId: string): Promise<string[]> {
    const rows = await this.db.execute(
      sql`SELECT category_id FROM user_interests WHERE user_id = ${userId}`,
    );
    return (rows as unknown as { category_id: string }[]).map((row) => row.category_id);
  }

  async findFavoriteOfferIds(userId: string, offerIds: string[]): Promise<Set<string>> {
    if (offerIds.length === 0) return new Set();
    const rows = await this.db.execute(
      sql`SELECT offer_id FROM favorites WHERE user_id = ${userId} AND offer_id = ANY(${offerIds}::uuid[])`,
    );
    return new Set((rows as unknown as { offer_id: string }[]).map((row) => row.offer_id));
  }
}
