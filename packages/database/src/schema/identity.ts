import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, fkId, primaryId, timestampColumn, updatedAt } from './columns.js';
import { localeEnum, platformEnum, userRoleEnum } from './enums.js';

/**
 * Identity is split from profile deliberately.
 *
 * `users` is the minimal account record that must survive for accounting and
 * fraud history. `profiles` holds the personal data a user can ask us to erase.
 * A GDPR deletion therefore anonymises `users` and drops `profiles`, without
 * orphaning reservations or breaking payment reconciliation.
 */
export const users = pgTable(
  'users',
  {
    id: primaryId(),
    email: varchar('email', { length: 254 }).notNull(),
    emailVerifiedAt: timestampColumn('email_verified_at'),
    role: userRoleEnum('role').notNull().default('USER'),
    isSuspended: boolean('is_suspended').notNull().default(false),
    /** Set when the account is erased; the row is kept but carries no PII. */
    anonymizedAt: timestampColumn('anonymized_at'),
    lastSeenAt: timestampColumn('last_seen_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('users_email_key').on(table.email),
    index('users_role_idx').on(table.role),
    index('users_created_at_idx').on(table.createdAt),
  ],
);

export const profiles = pgTable(
  'profiles',
  {
    userId: fkId('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    firstName: varchar('first_name', { length: 80 }),
    lastName: varchar('last_name', { length: 80 }),
    avatarUrl: text('avatar_url'),
    phone: varchar('phone', { length: 30 }),
    locale: localeEnum('locale').notNull().default('fr'),
    timeZone: varchar('time_zone', { length: 64 }).notNull().default('Europe/Brussels'),
    /** Last known coarse location, used to warm the home feed on cold start. */
    lastCityId: fkId('last_city_id'),
    onboardingCompletedAt: timestampColumn('onboarding_completed_at'),
    /** Granular consent, stored explicitly rather than inferred. */
    notificationPreferences: jsonb('notification_preferences')
      .$type<{
        bookingUpdates: boolean;
        reminders: boolean;
        recommendations: boolean;
        marketing: boolean;
      }>()
      .notNull()
      .default({
        bookingUpdates: true,
        reminders: true,
        recommendations: true,
        marketing: false,
      }),
    marketingConsentAt: timestampColumn('marketing_consent_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('profiles_last_city_idx').on(table.lastCityId)],
);

/** Categories a user picked during onboarding; the personalization signal. */
export const userInterests = pgTable(
  'user_interests',
  {
    userId: fkId('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    categoryId: fkId('category_id').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('user_interests_key').on(table.userId, table.categoryId),
    index('user_interests_category_idx').on(table.categoryId),
  ],
);

/**
 * External identity providers. Keeping this table separate from `users` is what
 * lets TRY add or swap a provider (Google, Apple, later an enterprise SSO) without
 * touching the domain: a user is still one row in `users`.
 */
export const authIdentities = pgTable(
  'auth_identities',
  {
    id: primaryId(),
    userId: fkId('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    provider: varchar('provider', { length: 20 }).notNull(),
    /** The provider's stable subject claim, never the email. */
    providerAccountId: varchar('provider_account_id', { length: 255 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('auth_identities_provider_account_key').on(
      table.provider,
      table.providerAccountId,
    ),
    index('auth_identities_user_idx').on(table.userId),
  ],
);

/**
 * Email one-time codes. Only a hash is stored: a leaked database must not grant
 * anybody a working login code.
 */
export const otpCodes = pgTable(
  'otp_codes',
  {
    id: primaryId(),
    email: varchar('email', { length: 254 }).notNull(),
    codeHash: varchar('code_hash', { length: 128 }).notNull(),
    expiresAt: timestampColumn('expires_at').notNull(),
    consumedAt: timestampColumn('consumed_at'),
    /** Throttles brute force on a single code independently of IP rate limits. */
    attemptCount: integer('attempt_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    index('otp_codes_email_idx').on(table.email, table.createdAt),
    index('otp_codes_expires_idx').on(table.expiresAt),
  ],
);

/**
 * Refresh tokens are rotated on every use and stored hashed. `replacedBy` makes
 * reuse detectable: presenting an already-rotated token means it was stolen, and
 * the whole family is revoked.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: primaryId(),
    userId: fkId('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    familyId: fkId('family_id').notNull(),
    expiresAt: timestampColumn('expires_at').notNull(),
    revokedAt: timestampColumn('revoked_at'),
    replacedByTokenId: fkId('replaced_by_token_id'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('refresh_tokens_hash_key').on(table.tokenHash),
    index('refresh_tokens_user_idx').on(table.userId),
    index('refresh_tokens_family_idx').on(table.familyId),
  ],
);

export const pushTokens = pgTable(
  'push_tokens',
  {
    id: primaryId(),
    userId: fkId('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    token: varchar('token', { length: 512 }).notNull(),
    platform: platformEnum('platform').notNull(),
    deviceId: varchar('device_id', { length: 128 }),
    lastUsedAt: timestampColumn('last_used_at'),
    disabledAt: timestampColumn('disabled_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('push_tokens_token_key').on(table.token),
    index('push_tokens_user_idx').on(table.userId),
  ],
);
