import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAt, fkId, primaryId, timestampColumn, updatedAt } from './columns.js';
import {
  continuationAnswerEnum,
  currencyEnum,
  leadStatusEnum,
} from './enums.js';
import { businesses, offers, venues } from './catalog.js';
import { reservations } from './booking.js';
import { users } from './identity.js';

export const favorites = pgTable(
  'favorites',
  {
    userId: fkId('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    offerId: fkId('offer_id')
      .references(() => offers.id, { onDelete: 'cascade' })
      .notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('favorites_key').on(table.userId, table.offerId),
    index('favorites_user_idx').on(table.userId, table.createdAt),
    index('favorites_offer_idx').on(table.offerId),
  ],
);

/**
 * A review is tied to a reservation, not merely to a venue: only someone who
 * actually attended can review, which is what keeps ratings trustworthy.
 */
export const reviews = pgTable(
  'reviews',
  {
    id: primaryId(),
    reservationId: fkId('reservation_id')
      .references(() => reservations.id, { onDelete: 'cascade' })
      .notNull(),
    userId: fkId('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    venueId: fkId('venue_id')
      .references(() => venues.id, { onDelete: 'cascade' })
      .notNull(),
    offerId: fkId('offer_id')
      .references(() => offers.id, { onDelete: 'cascade' })
      .notNull(),
    rating: smallint('rating').notNull(),
    comment: text('comment'),
    /** Hidden by moderation rather than deleted, so abuse patterns stay visible. */
    isPublished: boolean('is_published').notNull().default(true),
    moderatedByUserId: fkId('moderated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** One review per reservation — no rating stuffing. */
    uniqueIndex('reviews_reservation_key').on(table.reservationId),
    index('reviews_venue_idx').on(table.venueId, table.createdAt),
    index('reviews_offer_idx').on(table.offerId),
    check('reviews_rating_range', sql`${table.rating} >= 1 AND ${table.rating} <= 5`),
  ],
);

/**
 * The CRM-lite record: a trial that attended, and what happened next. This is the
 * object the business is actually buying, so it carries its own status pipeline
 * and the attributed revenue when it converts.
 *
 * PII exposure is deliberately minimal: `contactEmail` is populated only when the
 * user consented to be contacted, and the venue never sees anything else.
 */
export const leads = pgTable(
  'leads',
  {
    id: primaryId(),
    businessId: fkId('business_id')
      .references(() => businesses.id, { onDelete: 'cascade' })
      .notNull(),
    venueId: fkId('venue_id')
      .references(() => venues.id, { onDelete: 'cascade' })
      .notNull(),
    userId: fkId('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    reservationId: fkId('reservation_id')
      .references(() => reservations.id, { onDelete: 'cascade' })
      .notNull(),
    offerId: fkId('offer_id')
      .references(() => offers.id, { onDelete: 'cascade' })
      .notNull(),

    status: leadStatusEnum('status').notNull().default('NEW'),
    continuation: continuationAnswerEnum('continuation'),
    rating: smallint('rating'),

    /** Set only with explicit consent at review time. */
    contactConsentAt: timestampColumn('contact_consent_at'),
    notes: text('notes'),

    visitedAt: timestampColumn('visited_at'),
    contactedAt: timestampColumn('contacted_at'),
    convertedAt: timestampColumn('converted_at'),
    lostAt: timestampColumn('lost_at'),

    /** Declared by the business when marking CONVERTED. Minor units. */
    attributedRevenueAmount: integer('attributed_revenue_amount'),
    currency: currencyEnum('currency').notNull().default('EUR'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('leads_reservation_key').on(table.reservationId),
    index('leads_business_status_idx').on(table.businessId, table.status),
    index('leads_venue_idx').on(table.venueId, table.createdAt),
    index('leads_user_idx').on(table.userId),
    check(
      'leads_revenue_non_negative',
      sql`${table.attributedRevenueAmount} IS NULL OR ${table.attributedRevenueAmount} >= 0`,
    ),
  ],
);

/** "Viens tester un cours de boxe avec moi" — tracked end to end. */
export const referrals = pgTable(
  'referrals',
  {
    id: primaryId(),
    referrerUserId: fkId('referrer_user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    code: varchar('code', { length: 40 }).notNull(),
    offerId: fkId('offer_id').references(() => offers.id, { onDelete: 'set null' }),

    /** Funnel counters; incremented atomically rather than recomputed. */
    shareCount: integer('share_count').notNull().default(0),
    clickCount: integer('click_count').notNull().default(0),
    signupCount: integer('signup_count').notNull().default(0),
    bookingCount: integer('booking_count').notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('referrals_code_key').on(table.code),
    index('referrals_referrer_idx').on(table.referrerUserId),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: primaryId(),
    userId: fkId('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    type: varchar('type', { length: 60 }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Deep link target, e.g. "/booking/<id>". */
    deepLink: text('deep_link'),
    /**
     * Présent pour tout ce qui concerne une réservation, et c'est ce qui rend
     * l'envoi idempotent : `(reservation_id, type)` est unique, donc un cron qui
     * rejoue ne peut pas produire un deuxième rappel pour la même séance.
     * Nul pour les messages qui ne visent pas une réservation.
     */
    reservationId: fkId('reservation_id').references(() => reservations.id, {
      onDelete: 'cascade',
    }),
    /**
     * Même rôle que `reservationId`, pour les relances qui portent sur un lieu
     * plutôt que sur une réservation — la complétude d'un dossier d'inscription
     * (rappels J+1 / J+3). `(venue_id, type)` est unique : un cron qui rejoue ne
     * doit pas produire deux fois le même rappel pour le même lieu. Nul pour tout
     * le reste, réservations comprises.
     */
    venueId: fkId('venue_id').references(() => venues.id, { onDelete: 'cascade' }),
    readAt: timestampColumn('read_at'),
    sentAt: timestampColumn('sent_at'),
    createdAt: createdAt(),
  },
  (table) => [
    index('notifications_user_idx').on(table.userId, table.createdAt),
    index('notifications_unread_idx')
      .on(table.userId)
      .where(sql`read_at IS NULL`),
    uniqueIndex('notifications_reservation_type_key')
      .on(table.reservationId, table.type)
      .where(sql`reservation_id IS NOT NULL`),
    uniqueIndex('notifications_venue_type_key')
      .on(table.venueId, table.type)
      .where(sql`venue_id IS NOT NULL`),
    index('notifications_user_recent_idx').on(table.userId, table.createdAt.desc()),
  ],
);
