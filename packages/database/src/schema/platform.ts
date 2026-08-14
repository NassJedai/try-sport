import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { createdAt, fkId, primaryId, timestampColumn, updatedAt } from './columns.js';
import { users } from './identity.js';

/**
 * Audit log for every privileged action. Written in the same transaction as the
 * change it describes, so an approval cannot exist without its audit record.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: primaryId(),
    actorId: fkId('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorType: varchar('actor_type', { length: 20 }).notNull(),
    action: varchar('action', { length: 80 }).notNull(),

    entityType: varchar('entity_type', { length: 60 }).notNull(),
    entityId: fkId('entity_id'),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    /** Stored for admin actions only, and never for ordinary consumer traffic. */
    ipAddress: varchar('ip_address', { length: 45 }),
    requestId: varchar('request_id', { length: 64 }),
    createdAt: createdAt(),
  },
  (table) => [
    index('audit_logs_entity_idx').on(table.entityType, table.entityId, table.createdAt),
    index('audit_logs_actor_idx').on(table.actorId, table.createdAt),
    index('audit_logs_action_idx').on(table.action, table.createdAt),
  ],
);

export const reports = pgTable(
  'reports',
  {
    id: primaryId(),
    reporterUserId: fkId('reporter_user_id').references(() => users.id, { onDelete: 'set null' }),
    entityType: varchar('entity_type', { length: 60 }).notNull(),
    entityId: fkId('entity_id').notNull(),
    reason: varchar('reason', { length: 60 }).notNull(),
    details: text('details'),
    status: varchar('status', { length: 20 }).notNull().default('OPEN'),
    resolvedByUserId: fkId('resolved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestampColumn('resolved_at'),
    createdAt: createdAt(),
  },
  (table) => [
    index('reports_status_idx').on(table.status, table.createdAt),
    index('reports_entity_idx').on(table.entityType, table.entityId),
  ],
);

/**
 * Feature flags as rows, not as a third-party platform. Percentage rollout is
 * evaluated against a stable hash of the user id, so a user does not flip between
 * variants on every request.
 */
export const featureFlags = pgTable(
  'feature_flags',
  {
    id: primaryId(),
    key: varchar('key', { length: 80 }).notNull(),
    description: text('description'),
    isEnabled: boolean('is_enabled').notNull().default(false),
    rolloutPercentage: integer('rollout_percentage').notNull().default(0),
    /** Optional allowlist for staff testing before a general rollout. */
    enabledUserIds: jsonb('enabled_user_ids').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('feature_flags_key_key').on(table.key)],
);
