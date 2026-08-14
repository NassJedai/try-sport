import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAt, fkId, primaryId, timestampColumn, updatedAt } from './columns.js';
import { slotStatusEnum } from './enums.js';
import { offers, venues } from './catalog.js';

/**
 * Recurring rules are the business's mental model ("every Monday and Wednesday at
 * 19:00"). They are expanded into concrete `slots` rows by a job, because a
 * booking must attach to a real row that can be locked and counted — you cannot
 * take a transactional lock on a recurrence rule.
 *
 * `startTime` is a venue-local wall clock on purpose: a class at 19:00 stays at
 * 19:00 across a DST change. The expansion resolves it to a UTC instant per
 * occurrence.
 */
export const schedules = pgTable(
  'schedules',
  {
    id: primaryId(),
    offerId: fkId('offer_id')
      .references(() => offers.id, { onDelete: 'cascade' })
      .notNull(),
    venueId: fkId('venue_id')
      .references(() => venues.id, { onDelete: 'cascade' })
      .notNull(),
    /** 0 = Sunday, matching JS getDay(). */
    daysOfWeek: jsonb('days_of_week').$type<number[]>().notNull(),
    startTime: varchar('start_time', { length: 5 }).notNull(),
    capacity: smallint('capacity').notNull(),
    validFrom: varchar('valid_from', { length: 10 }).notNull(),
    validUntil: varchar('valid_until', { length: 10 }),
    isActive: boolean('is_active').notNull().default(true),
    /** How far the expander has already materialised this rule. */
    expandedUntil: timestampColumn('expanded_until'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('schedules_offer_idx').on(table.offerId),
    index('schedules_venue_idx').on(table.venueId),
    check('schedules_capacity_positive', sql`${table.capacity} > 0`),
    check('schedules_start_time_format', sql`${table.startTime} ~ '^[0-2][0-9]:[0-5][0-9]$'`),
  ],
);

/**
 * The bookable unit, and the row every booking contends on.
 *
 * `reservedCount` is a counter guarded by a CHECK constraint. The booking
 * transaction increments it with a single conditional UPDATE
 * (`SET reserved_count = reserved_count + 1 WHERE reserved_count < capacity`),
 * which Postgres serialises on the row: two concurrent bookings for the last
 * place cannot both succeed. The CHECK is the second line of defence — even a
 * buggy future code path cannot oversell, because the database refuses the write.
 */
export const slots = pgTable(
  'slots',
  {
    id: primaryId(),
    offerId: fkId('offer_id')
      .references(() => offers.id, { onDelete: 'cascade' })
      .notNull(),
    venueId: fkId('venue_id')
      .references(() => venues.id, { onDelete: 'cascade' })
      .notNull(),
    scheduleId: fkId('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),

    startAt: timestampColumn('start_at').notNull(),
    endAt: timestampColumn('end_at').notNull(),

    capacity: smallint('capacity').notNull(),
    reservedCount: smallint('reserved_count').notNull().default(0),
    status: slotStatusEnum('status').notNull().default('OPEN'),
    cancelledReason: text('cancelled_reason'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** The availability query: slots for an offer in a time window. */
    index('slots_offer_start_idx').on(table.offerId, table.startAt),
    index('slots_venue_start_idx').on(table.venueId, table.startAt),
    index('slots_schedule_idx').on(table.scheduleId),
    /** "Available today" and the next-slot lookup on every offer card. */
    index('slots_open_start_idx')
      .on(table.startAt)
      .where(sql`status = 'OPEN'`),
    /** A schedule may only produce one slot per offer per instant. */
    uniqueIndex('slots_offer_start_key').on(table.offerId, table.startAt),

    check('slots_capacity_positive', sql`${table.capacity} > 0`),
    check(
      'slots_reserved_within_capacity',
      sql`${table.reservedCount} >= 0 AND ${table.reservedCount} <= ${table.capacity}`,
    ),
    check('slots_end_after_start', sql`${table.endAt} > ${table.startAt}`),
  ],
);
