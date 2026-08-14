import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  deletedAt,
  fkId,
  latitudeColumn,
  longitudeColumn,
  primaryId,
  timestampColumn,
  updatedAt,
} from './columns.js';
import {
  billingModelEnum,
  businessRoleEnum,
  businessStatusEnum,
  cancellationPolicyEnum,
  currencyEnum,
  experienceTypeEnum,
  offerStatusEnum,
  skillLevelEnum,
  trialRuleEnum,
  venueStatusEnum,
} from './enums.js';
import { cities, districts } from './geography.js';
import { users } from './identity.js';

export const categories = pgTable(
  'categories',
  {
    id: primaryId(),
    slug: varchar('slug', { length: 60 }).notNull(),
    name: text('name').notNull(),
    /** Icon name resolved by the client's icon set, not a URL. */
    icon: varchar('icon', { length: 60 }).notNull().default('activity'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('categories_slug_key').on(table.slug)],
);

/**
 * A business is the commercial entity. It is never assumed to equal a venue:
 * a chain with 100 locations is one business and 100 venues, and every query
 * that scopes by ownership goes through `business_members`.
 */
export const businesses = pgTable(
  'businesses',
  {
    id: primaryId(),
    slug: varchar('slug', { length: 120 }).notNull(),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    vatNumber: varchar('vat_number', { length: 30 }),
    contactEmail: varchar('contact_email', { length: 254 }).notNull(),
    contactPhone: varchar('contact_phone', { length: 30 }),
    countryCode: varchar('country_code', { length: 2 }).notNull().default('BE'),
    status: businessStatusEnum('status').notNull().default('PENDING_APPROVAL'),

    /**
     * How TRY earns from this business. Stored per business so the commercial
     * model can vary by contract without a schema change; the commission rate is
     * in basis points so 12.5% is exact.
     */
    billingModel: billingModelEnum('billing_model').notNull().default('COMMISSION'),
    commissionBasisPoints: integer('commission_basis_points').notNull().default(1500),
    perAttendeeFeeAmount: integer('per_attendee_fee_amount').notNull().default(0),
    currency: currencyEnum('currency').notNull().default('EUR'),

    /** Stripe Connect account, populated when payouts are enabled. */
    stripeAccountId: varchar('stripe_account_id', { length: 64 }),
    approvedAt: timestampColumn('approved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('businesses_slug_key').on(table.slug),
    index('businesses_status_idx').on(table.status),
    check(
      'businesses_commission_range',
      sql`${table.commissionBasisPoints} >= 0 AND ${table.commissionBasisPoints} <= 10000`,
    ),
    check('businesses_per_attendee_fee_positive', sql`${table.perAttendeeFeeAmount} >= 0`),
  ],
);

/** Staff membership. One user account can belong to several businesses. */
export const businessMembers = pgTable(
  'business_members',
  {
    id: primaryId(),
    businessId: fkId('business_id')
      .references(() => businesses.id, { onDelete: 'cascade' })
      .notNull(),
    userId: fkId('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    role: businessRoleEnum('role').notNull().default('STAFF'),
    invitedByUserId: fkId('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    acceptedAt: timestampColumn('accepted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('business_members_key').on(table.businessId, table.userId),
    index('business_members_user_idx').on(table.userId),
  ],
);

export const venues = pgTable(
  'venues',
  {
    id: primaryId(),
    businessId: fkId('business_id')
      .references(() => businesses.id, { onDelete: 'cascade' })
      .notNull(),
    slug: varchar('slug', { length: 120 }).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: venueStatusEnum('status').notNull().default('DRAFT'),

    addressLine: text('address_line').notNull(),
    postalCode: varchar('postal_code', { length: 12 }).notNull(),
    cityId: fkId('city_id')
      .references(() => cities.id, { onDelete: 'restrict' })
      .notNull(),
    districtId: fkId('district_id').references(() => districts.id, { onDelete: 'set null' }),

    latitude: latitudeColumn(),
    longitude: longitudeColumn(),
    /**
     * NOTE: the PostGIS `location geography(Point, 4326)` column and its GiST
     * index are added by the hand-written migration `0001_postgis.sql`, not by
     * drizzle-kit — drizzle-kit emits a parameterised type as a quoted identifier
     * (`"geography(Point, 4326)"`), which Postgres rejects.
     *
     * The column is GENERATED ALWAYS from latitude/longitude, so it can never
     * drift from the stored coordinates, and it is queried through raw SQL
     * fragments in the discovery repository. See docs/adr/ADR-006-postgis-column.md.
     */

    /** Sessions are displayed in the venue's timezone, not the viewer's. */
    timeZone: varchar('time_zone', { length: 64 }).notNull().default('Europe/Brussels'),

    phone: varchar('phone', { length: 30 }),
    website: text('website'),
    instagram: varchar('instagram', { length: 60 }),

    amenities: jsonb('amenities').$type<string[]>().notNull().default([]),
    languages: jsonb('languages').$type<string[]>().notNull().default(['fr']),
    openingHours: jsonb('opening_hours')
      .$type<{ dayOfWeek: number; opensAt: string; closesAt: string }[]>()
      .notNull()
      .default([]),

    /**
     * Denormalised review aggregates. Recomputed when a review lands; the feed
     * would otherwise join and aggregate the whole reviews table per card.
     */
    averageRating: integer('average_rating_hundredths'),
    reviewCount: integer('review_count').notNull().default(0),

    approvedAt: timestampColumn('approved_at'),
    rejectedReason: text('rejected_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('venues_slug_key').on(table.slug),
    index('venues_business_idx').on(table.businessId),
    index('venues_city_idx').on(table.cityId),
    index('venues_district_idx').on(table.districtId),
    index('venues_status_idx').on(table.status),
    check(
      'venues_rating_range',
      sql`${table.averageRating} IS NULL OR (${table.averageRating} >= 0 AND ${table.averageRating} <= 500)`,
    ),
  ],
);

export const venueCategories = pgTable(
  'venue_categories',
  {
    venueId: fkId('venue_id')
      .references(() => venues.id, { onDelete: 'cascade' })
      .notNull(),
    categoryId: fkId('category_id')
      .references(() => categories.id, { onDelete: 'cascade' })
      .notNull(),
  },
  (table) => [
    uniqueIndex('venue_categories_key').on(table.venueId, table.categoryId),
    index('venue_categories_category_idx').on(table.categoryId),
  ],
);

/**
 * Images store the storage key, not a CDN URL. The URL is composed at read time
 * from the current CDN base, so moving from R2 to CloudFront is a config change
 * rather than a data migration.
 */
export const venueImages = pgTable(
  'venue_images',
  {
    id: primaryId(),
    venueId: fkId('venue_id')
      .references(() => venues.id, { onDelete: 'cascade' })
      .notNull(),
    storageKey: text('storage_key').notNull(),
    role: varchar('role', { length: 20 }).notNull().default('GALLERY'),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    blurhash: varchar('blurhash', { length: 64 }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [index('venue_images_venue_idx').on(table.venueId, table.sortOrder)],
);

export const offers = pgTable(
  'offers',
  {
    id: primaryId(),
    venueId: fkId('venue_id')
      .references(() => venues.id, { onDelete: 'cascade' })
      .notNull(),
    /** Denormalised from the venue so ownership checks avoid an extra join. */
    businessId: fkId('business_id')
      .references(() => businesses.id, { onDelete: 'cascade' })
      .notNull(),
    categoryId: fkId('category_id')
      .references(() => categories.id, { onDelete: 'restrict' })
      .notNull(),

    title: varchar('title', { length: 120 }).notNull(),
    description: text('description').notNull(),
    status: offerStatusEnum('status').notNull().default('DRAFT'),
    experienceType: experienceTypeEnum('experience_type').notNull(),
    skillLevel: skillLevelEnum('skill_level').notNull().default('ALL_LEVELS'),

    /** Minor units. `reference_price_amount` is the venue's regular price. */
    priceAmount: integer('price_amount').notNull(),
    referencePriceAmount: integer('reference_price_amount'),
    currency: currencyEnum('currency').notNull().default('EUR'),

    durationMinutes: smallint('duration_minutes').notNull(),
    capacity: smallint('capacity').notNull(),
    languages: jsonb('languages').$type<string[]>().notNull().default(['fr']),
    amenities: jsonb('amenities').$type<string[]>().notNull().default([]),
    whatToBring: jsonb('what_to_bring').$type<string[]>().notNull().default([]),
    conditions: text('conditions'),

    cancellationPolicy: cancellationPolicyEnum('cancellation_policy').notNull().default('STANDARD'),
    trialRule: trialRuleEnum('trial_rule').notNull().default('ONE_TRIAL_PER_VENUE'),

    /** Rolling conversion stats feeding the ranking score. */
    trialCount: integer('trial_count').notNull().default(0),
    conversionCount: integer('conversion_count').notNull().default(0),

    publishedAt: timestampColumn('published_at'),
    rejectedReason: text('rejected_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    index('offers_venue_idx').on(table.venueId),
    index('offers_business_idx').on(table.businessId),
    index('offers_category_idx').on(table.categoryId),
    index('offers_status_idx').on(table.status),
    index('offers_published_idx').on(table.publishedAt),
    /** Discovery filters on price constantly; only live offers are worth indexing. */
    index('offers_active_price_idx')
      .on(table.priceAmount)
      .where(sql`status = 'ACTIVE'`),
    check('offers_price_non_negative', sql`${table.priceAmount} >= 0`),
    check(
      'offers_reference_price_higher',
      sql`${table.referencePriceAmount} IS NULL OR ${table.referencePriceAmount} >= ${table.priceAmount}`,
    ),
    check('offers_duration_positive', sql`${table.durationMinutes} > 0`),
    check('offers_capacity_positive', sql`${table.capacity} > 0`),
  ],
);

export const offerImages = pgTable(
  'offer_images',
  {
    id: primaryId(),
    offerId: fkId('offer_id')
      .references(() => offers.id, { onDelete: 'cascade' })
      .notNull(),
    storageKey: text('storage_key').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    blurhash: varchar('blurhash', { length: 64 }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [index('offer_images_offer_idx').on(table.offerId, table.sortOrder)],
);

/** Venue-level closures: holidays, maintenance, private events. */
export const venueBlockedDates = pgTable(
  'venue_blocked_dates',
  {
    id: primaryId(),
    venueId: fkId('venue_id')
      .references(() => venues.id, { onDelete: 'cascade' })
      .notNull(),
    /** Venue-local calendar date. */
    blockedOn: varchar('blocked_on', { length: 10 }).notNull(),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('venue_blocked_dates_key').on(table.venueId, table.blockedOn)],
);
