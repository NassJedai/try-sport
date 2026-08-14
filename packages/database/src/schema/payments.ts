import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { createdAt, fkId, primaryId, timestampColumn, updatedAt } from './columns.js';
import { currencyEnum, paymentStatusEnum } from './enums.js';
import { businesses, venues } from './catalog.js';
import { reservations } from './booking.js';
import { users } from './identity.js';

/**
 * Payments mirror Stripe; they do not replace it.
 *
 * Postgres is the source of truth for *business* state (is this booking valid?),
 * Stripe is the source of truth for *money movement*. This table is the join
 * between them, and it stores no card data of any kind — only Stripe's ids.
 */
export const payments = pgTable(
  'payments',
  {
    id: primaryId(),
    reservationId: fkId('reservation_id')
      .references(() => reservations.id, { onDelete: 'restrict' })
      .notNull(),
    userId: fkId('user_id')
      .references(() => users.id, { onDelete: 'restrict' })
      .notNull(),
    businessId: fkId('business_id')
      .references(() => businesses.id, { onDelete: 'restrict' })
      .notNull(),

    status: paymentStatusEnum('status').notNull().default('REQUIRES_PAYMENT'),
    provider: varchar('provider', { length: 20 }).notNull().default('STRIPE'),
    providerPaymentIntentId: varchar('provider_payment_intent_id', { length: 64 }),
    providerChargeId: varchar('provider_charge_id', { length: 64 }),

    /** Gross charged to the user. */
    amount: integer('amount').notNull(),
    /** TRY's cut, recomputed server-side from the business's contract. */
    platformFeeAmount: integer('platform_fee_amount').notNull().default(0),
    /** What the venue is owed. Always amount - platformFee. */
    merchantAmount: integer('merchant_amount').notNull().default(0),
    refundedAmount: integer('refunded_amount').notNull().default(0),
    currency: currencyEnum('currency').notNull().default('EUR'),

    failureCode: varchar('failure_code', { length: 60 }),
    failureMessage: text('failure_message'),

    succeededAt: timestampColumn('succeeded_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** One live payment per reservation; retries reuse the same PaymentIntent. */
    uniqueIndex('payments_reservation_key').on(table.reservationId),
    uniqueIndex('payments_intent_key')
      .on(table.providerPaymentIntentId)
      .where(sql`provider_payment_intent_id IS NOT NULL`),
    index('payments_business_idx').on(table.businessId, table.createdAt),
    index('payments_status_idx').on(table.status),

    check('payments_amount_non_negative', sql`${table.amount} >= 0`),
    check(
      'payments_refund_within_amount',
      sql`${table.refundedAmount} >= 0 AND ${table.refundedAmount} <= ${table.amount}`,
    ),
    /** The split must always reconcile; a rounding bug becomes a failed write. */
    check(
      'payments_split_reconciles',
      sql`${table.platformFeeAmount} + ${table.merchantAmount} = ${table.amount}`,
    ),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: primaryId(),
    paymentId: fkId('payment_id')
      .references(() => payments.id, { onDelete: 'restrict' })
      .notNull(),
    reservationId: fkId('reservation_id')
      .references(() => reservations.id, { onDelete: 'restrict' })
      .notNull(),
    providerRefundId: varchar('provider_refund_id', { length: 64 }),
    amount: integer('amount').notNull(),
    currency: currencyEnum('currency').notNull().default('EUR'),
    reason: varchar('reason', { length: 60 }),
    initiatedByUserId: fkId('initiated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    succeededAt: timestampColumn('succeeded_at'),
    createdAt: createdAt(),
  },
  (table) => [
    index('refunds_payment_idx').on(table.paymentId),
    uniqueIndex('refunds_provider_key')
      .on(table.providerRefundId)
      .where(sql`provider_refund_id IS NOT NULL`),
    check('refunds_amount_positive', sql`${table.amount} > 0`),
  ],
);

/**
 * Every webhook Stripe sends is recorded before it is acted on.
 *
 * Stripe guarantees at-least-once delivery, so the unique index on the provider
 * event id is what makes handling idempotent: a redelivered event hits a
 * constraint violation and is acknowledged instead of charging or confirming twice.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: primaryId(),
    provider: varchar('provider', { length: 20 }).notNull().default('STRIPE'),
    providerEventId: varchar('provider_event_id', { length: 100 }).notNull(),
    eventType: varchar('event_type', { length: 80 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    processedAt: timestampColumn('processed_at'),
    /** Retained so a poison event can be inspected rather than silently dropped. */
    failedAt: timestampColumn('failed_at'),
    failureMessage: text('failure_message'),
    attemptCount: integer('attempt_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('webhook_events_provider_event_key').on(table.provider, table.providerEventId),
    index('webhook_events_unprocessed_idx')
      .on(table.createdAt)
      .where(sql`processed_at IS NULL`),
  ],
);

/**
 * Idempotency for mutating endpoints. The stored request fingerprint is what
 * makes a reused key with *different* parameters an error rather than a silent
 * replay of someone else's booking.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: primaryId(),
    key: varchar('key', { length: 255 }).notNull(),
    userId: fkId('user_id').references(() => users.id, { onDelete: 'cascade' }),
    endpoint: varchar('endpoint', { length: 120 }).notNull(),
    requestHash: varchar('request_hash', { length: 128 }).notNull(),
    statusCode: integer('status_code'),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
    lockedAt: timestampColumn('locked_at'),
    completedAt: timestampColumn('completed_at'),
    expiresAt: timestampColumn('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('idempotency_keys_scope_key').on(table.userId, table.endpoint, table.key),
    index('idempotency_keys_expiry_idx').on(table.expiresAt),
  ],
);
