import {
  ATTRIBUTION_SOURCES,
  BILLING_MODELS,
  BUSINESS_ROLES,
  BUSINESS_STATUSES,
  CANCELLATION_POLICIES,
  CONTINUATION_ANSWERS,
  EXPERIENCE_TYPES,
  LEAD_STATUSES,
  OFFER_STATUSES,
  PAYMENT_STATUSES,
  RESERVATION_STATUSES,
  SKILL_LEVELS,
  SLOT_STATUSES,
  SUPPORTED_LOCALES,
  TRIAL_RULES,
  USER_ROLES,
  VENUE_STATUSES,
} from '@try/contracts';
import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Postgres enums are generated from the shared TypeScript constants, so the
 * database and the API can never disagree about what a status is. Adding a value
 * requires a migration (`ALTER TYPE ... ADD VALUE`), which is the point: a status
 * the database has not been told about must not reach it.
 */
export const reservationStatusEnum = pgEnum('reservation_status', RESERVATION_STATUSES);
export const offerStatusEnum = pgEnum('offer_status', OFFER_STATUSES);
export const venueStatusEnum = pgEnum('venue_status', VENUE_STATUSES);
export const businessStatusEnum = pgEnum('business_status', BUSINESS_STATUSES);
export const userRoleEnum = pgEnum('user_role', USER_ROLES);
export const businessRoleEnum = pgEnum('business_role', BUSINESS_ROLES);
export const trialRuleEnum = pgEnum('trial_rule', TRIAL_RULES);
export const experienceTypeEnum = pgEnum('experience_type', EXPERIENCE_TYPES);
export const skillLevelEnum = pgEnum('skill_level', SKILL_LEVELS);
export const leadStatusEnum = pgEnum('lead_status', LEAD_STATUSES);
export const continuationAnswerEnum = pgEnum('continuation_answer', CONTINUATION_ANSWERS);
export const paymentStatusEnum = pgEnum('payment_status', PAYMENT_STATUSES);
export const billingModelEnum = pgEnum('billing_model', BILLING_MODELS);
export const slotStatusEnum = pgEnum('slot_status', SLOT_STATUSES);
export const attributionSourceEnum = pgEnum('attribution_source', ATTRIBUTION_SOURCES);
export const localeEnum = pgEnum('locale', SUPPORTED_LOCALES);
export const cancellationPolicyEnum = pgEnum('cancellation_policy', CANCELLATION_POLICIES);
export const currencyEnum = pgEnum('currency', ['EUR', 'USD', 'GBP', 'CHF']);
export const platformEnum = pgEnum('device_platform', ['IOS', 'ANDROID', 'WEB']);
