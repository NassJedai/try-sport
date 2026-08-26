import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAt, fkId, primaryId, timestampColumn, updatedAt } from './columns.js';
import {
  attributionSourceEnum,
  currencyEnum,
  reservationStatusEnum,
  trialRuleEnum,
} from './enums.js';
import { businesses, offers, venues } from './catalog.js';
import { slots } from './scheduling.js';
import { users } from './identity.js';

/**
 * A reservation. Prices are *snapshotted* at booking time: an offer whose price
 * changes tomorrow must not retroactively change what a user agreed to pay, and
 * refunds have to be reconciled against the amount actually charged.
 */
export const reservations = pgTable(
  'reservations',
  {
    id: primaryId(),
    userId: fkId('user_id')
      .references(() => users.id, { onDelete: 'restrict' })
      .notNull(),
    slotId: fkId('slot_id')
      .references(() => slots.id, { onDelete: 'restrict' })
      .notNull(),
    offerId: fkId('offer_id')
      .references(() => offers.id, { onDelete: 'restrict' })
      .notNull(),
    venueId: fkId('venue_id')
      .references(() => venues.id, { onDelete: 'restrict' })
      .notNull(),
    businessId: fkId('business_id')
      .references(() => businesses.id, { onDelete: 'restrict' })
      .notNull(),

    status: reservationStatusEnum('status').notNull().default('PENDING'),

    /** Snapshot of the agreed price, in minor units. */
    priceAmount: integer('price_amount').notNull(),
    currency: currencyEnum('currency').notNull().default('EUR'),
    /** Snapshot of the rule applied, so history stays explainable after a rule change. */
    trialRule: trialRuleEnum('trial_rule').notNull(),

    /** Denormalised from the slot to keep "my bookings" and reminders index-only. */
    slotStartAt: timestampColumn('slot_start_at').notNull(),
    slotEndAt: timestampColumn('slot_end_at').notNull(),

    /** Only a hash of the QR token is stored; the token itself lives on the device. */
    checkInTokenHash: varchar('check_in_token_hash', { length: 128 }),
    checkInCode: varchar('check_in_code', { length: 12 }),

    confirmedAt: timestampColumn('confirmed_at'),
    checkedInAt: timestampColumn('checked_in_at'),
    completedAt: timestampColumn('completed_at'),
    cancelledAt: timestampColumn('cancelled_at'),
    cancellationReason: text('cancellation_reason'),
    /** Set when a PENDING/PAYMENT_PENDING hold should be swept back to capacity. */
    holdExpiresAt: timestampColumn('hold_expires_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('reservations_user_idx').on(table.userId, table.slotStartAt),
    index('reservations_slot_idx').on(table.slotId),
    index('reservations_venue_start_idx').on(table.venueId, table.slotStartAt),
    index('reservations_business_idx').on(table.businessId, table.createdAt),
    index('reservations_offer_idx').on(table.offerId),
    index('reservations_status_idx').on(table.status),
    /** The expiry sweep looks only at holds that can still be released. */
    index('reservations_hold_expiry_idx')
      .on(table.holdExpiresAt)
      .where(sql`status IN ('PENDING', 'PAYMENT_PENDING')`),

    /**
     * A user cannot hold two live bookings for the same slot. Enforced by the
     * database rather than by a read-then-write check, so a double tap that
     * arrives on two API instances at once still produces exactly one booking.
     */
    uniqueIndex('reservations_user_slot_live_key')
      .on(table.userId, table.slotId)
      .where(
        sql`status IN ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW')`,
      ),

    uniqueIndex('reservations_check_in_code_key')
      .on(table.checkInCode)
      .where(sql`check_in_code IS NOT NULL`),

    check('reservations_price_non_negative', sql`${table.priceAmount} >= 0`),
    check('reservations_slot_window', sql`${table.slotEndAt} > ${table.slotStartAt}`),
  ],
);

/**
 * Check-in events, kept as their own table rather than as columns on the
 * reservation: a manager override is an auditable event with an actor and a
 * reason, and support needs to see that it happened.
 */
export const checkIns = pgTable(
  'check_ins',
  {
    id: primaryId(),
    reservationId: fkId('reservation_id')
      .references(() => reservations.id, { onDelete: 'cascade' })
      .notNull(),
    venueId: fkId('venue_id')
      .references(() => venues.id, { onDelete: 'cascade' })
      .notNull(),
    /** The staff member who validated the code. */
    performedByUserId: fkId('performed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    method: varchar('method', { length: 10 }).notNull(),
    wasOverride: boolean('was_override').notNull().default(false),
    overrideReason: text('override_reason'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('check_ins_reservation_key').on(table.reservationId),
    index('check_ins_venue_idx').on(table.venueId, table.createdAt),
  ],
);

/**
 * The authoritative record of which trials a user has consumed.
 *
 * Derivable from `reservations`, but kept explicit because eligibility is checked
 * on the hot booking path and because the definition of "consumed" is a business
 * rule that may change: this table records the decision that was actually made.
 */
export const trialHistory = pgTable(
  'trial_history',
  {
    id: primaryId(),
    userId: fkId('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    businessId: fkId('business_id')
      .references(() => businesses.id, { onDelete: 'cascade' })
      .notNull(),
    venueId: fkId('venue_id')
      .references(() => venues.id, { onDelete: 'cascade' })
      .notNull(),
    offerId: fkId('offer_id')
      .references(() => offers.id, { onDelete: 'cascade' })
      .notNull(),
    reservationId: fkId('reservation_id')
      .references(() => reservations.id, { onDelete: 'cascade' })
      .notNull(),

    reservedAt: timestampColumn('reserved_at').notNull(),
    checkedInAt: timestampColumn('checked_in_at'),
    completedAt: timestampColumn('completed_at'),
    /** Mirrors the reservation status so eligibility is a single indexed read. */
    status: reservationStatusEnum('status').notNull(),
    /**
     * Snapshot of the rule applied when this trial was consumed — mirrors
     * `reservations.trial_rule` for the same reason: an offer's scope may
     * change later, but the constraint that guarded this specific row must
     * keep referring to the scope that was actually in force.
     */
    trialRule: trialRuleEnum('trial_rule').notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('trial_history_reservation_key').on(table.reservationId),
    /** The exact lookup performed before every booking. */
    index('trial_history_user_venue_idx').on(table.userId, table.venueId),
    index('trial_history_user_business_idx').on(table.userId, table.businessId),
    index('trial_history_user_offer_idx').on(table.userId, table.offerId),

    /**
     * Storage-level backstop for the trial rule, on the same principle as the
     * capacity CHECK constraint: the advisory lock in
     * `packages/database/src/locking.ts` is the primary defence against a
     * concurrent double-consumption, but a regression there (or a future
     * write path that bypasses it) must hit the database, not pass silently.
     *
     * One partial unique index per scope, not one column-spanning index: the
     * scope is chosen per offer, so a user who legitimately consumed a
     * ONE_TRIAL_PER_VENUE trial at venue A and a ONE_TRIAL_PER_OFFER trial at
     * venue B of the same business must not conflict with each other. Each
     * index only ever applies to rows recorded under its own rule.
     */
    uniqueIndex('trial_history_business_scope_key')
      .on(table.userId, table.businessId)
      .where(
        sql`trial_rule = 'ONE_TRIAL_PER_BUSINESS' AND status IN ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW')`,
      ),
    uniqueIndex('trial_history_venue_scope_key')
      .on(table.userId, table.venueId)
      .where(
        sql`trial_rule = 'ONE_TRIAL_PER_VENUE' AND status IN ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW')`,
      ),
    uniqueIndex('trial_history_offer_scope_key')
      .on(table.userId, table.offerId)
      .where(
        sql`trial_rule = 'ONE_TRIAL_PER_OFFER' AND status IN ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW')`,
      ),
  ],
);

/**
 * Marketing attribution captured at signup and carried to the first booking.
 * Kept separate from the reservation so a user's acquisition source is recorded
 * once, even if they book five times.
 */
export const attributions = pgTable(
  'attributions',
  {
    id: primaryId(),
    userId: fkId('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    source: attributionSourceEnum('source').notNull().default('organic'),
    medium: varchar('medium', { length: 40 }),
    campaign: varchar('campaign', { length: 80 }),
    content: varchar('content', { length: 80 }),
    term: varchar('term', { length: 80 }),
    referralCode: varchar('referral_code', { length: 40 }),
    landingOfferId: fkId('landing_offer_id').references(() => offers.id, { onDelete: 'set null' }),
    landingVenueId: fkId('landing_venue_id').references(() => venues.id, { onDelete: 'set null' }),
    /** Set once the attributed user completes their first booking. */
    firstReservationId: fkId('first_reservation_id').references(() => reservations.id, {
      onDelete: 'set null',
    }),
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    index('attributions_user_idx').on(table.userId),
    index('attributions_campaign_idx').on(table.source, table.campaign),
    index('attributions_referral_idx').on(table.referralCode),
  ],
);
