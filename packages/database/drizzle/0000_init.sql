CREATE TYPE "public"."attribution_source" AS ENUM('organic', 'meta', 'google', 'tiktok', 'referral', 'business_qr', 'influencer');--> statement-breakpoint
CREATE TYPE "public"."billing_model" AS ENUM('FREE', 'COMMISSION', 'PAY_PER_ATTENDEE', 'PAY_PER_CONVERSION', 'SUBSCRIPTION');--> statement-breakpoint
CREATE TYPE "public"."business_role" AS ENUM('OWNER', 'MANAGER', 'STAFF');--> statement-breakpoint
CREATE TYPE "public"."business_status" AS ENUM('PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."cancellation_policy" AS ENUM('FLEXIBLE', 'STANDARD', 'STRICT');--> statement-breakpoint
CREATE TYPE "public"."continuation_answer" AS ENUM('YES', 'MAYBE', 'NO');--> statement-breakpoint
CREATE TYPE "public"."currency" AS ENUM('EUR', 'USD', 'GBP', 'CHF');--> statement-breakpoint
CREATE TYPE "public"."experience_type" AS ENUM('FREE_TRIAL', 'DISCOVERY_PRICE', 'DISCOVERY_PACK', 'INITIATION', 'DAY_PASS', 'BEGINNER_CLASS', 'PREMIUM_EXPERIENCE');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('NEW', 'ATTENDED', 'INTERESTED', 'CONTACTED', 'CONVERTED', 'LOST');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('fr', 'en', 'nl');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'REJECTED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('REQUIRES_PAYMENT', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('IOS', 'ANDROID', 'WEB');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED_USER', 'CANCELLED_BUSINESS', 'NO_SHOW', 'REFUNDED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."skill_level" AS ENUM('ALL_LEVELS', 'BEGINNER', 'INTERMEDIATE', 'ADVANCED');--> statement-breakpoint
CREATE TYPE "public"."slot_status" AS ENUM('OPEN', 'FULL', 'CANCELLED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."trial_rule" AS ENUM('ONE_TRIAL_PER_BUSINESS', 'ONE_TRIAL_PER_VENUE', 'ONE_TRIAL_PER_OFFER', 'NO_RESTRICTION');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('USER', 'BUSINESS_MEMBER', 'ADMIN', 'SUPER_ADMIN');--> statement-breakpoint
CREATE TYPE "public"."venue_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'REJECTED', 'SUSPENDED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "cities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_id" uuid NOT NULL,
	"slug" varchar(80) NOT NULL,
	"name" text NOT NULL,
	"time_zone" varchar(64) DEFAULT 'Europe/Brussels' NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "countries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(2) NOT NULL,
	"name" text NOT NULL,
	"default_currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"default_locale" varchar(5) DEFAULT 'fr' NOT NULL,
	"default_time_zone" varchar(64) DEFAULT 'Europe/Brussels' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "districts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid NOT NULL,
	"slug" varchar(80) NOT NULL,
	"name" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"provider_account_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"code_hash" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"first_name" varchar(80),
	"last_name" varchar(80),
	"avatar_url" text,
	"phone" varchar(30),
	"locale" "locale" DEFAULT 'fr' NOT NULL,
	"time_zone" varchar(64) DEFAULT 'Europe/Brussels' NOT NULL,
	"last_city_id" uuid,
	"onboarding_completed_at" timestamp with time zone,
	"notification_preferences" jsonb DEFAULT '{"bookingUpdates":true,"reminders":true,"recommendations":true,"marketing":false}'::jsonb NOT NULL,
	"marketing_consent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" varchar(512) NOT NULL,
	"platform" "device_platform" NOT NULL,
	"device_id" varchar(128),
	"last_used_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"family_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_token_id" uuid,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_interests" (
	"user_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"email_verified_at" timestamp with time zone,
	"role" "user_role" DEFAULT 'USER' NOT NULL,
	"is_suspended" boolean DEFAULT false NOT NULL,
	"anonymized_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "business_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "business_role" DEFAULT 'STAFF' NOT NULL,
	"invited_by_user_id" uuid,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(120) NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"vat_number" varchar(30),
	"contact_email" varchar(254) NOT NULL,
	"contact_phone" varchar(30),
	"country_code" varchar(2) DEFAULT 'BE' NOT NULL,
	"status" "business_status" DEFAULT 'PENDING_APPROVAL' NOT NULL,
	"billing_model" "billing_model" DEFAULT 'COMMISSION' NOT NULL,
	"commission_basis_points" integer DEFAULT 1500 NOT NULL,
	"per_attendee_fee_amount" integer DEFAULT 0 NOT NULL,
	"currency" "currency" DEFAULT 'EUR' NOT NULL,
	"stripe_account_id" varchar(64),
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "businesses_commission_range" CHECK ("businesses"."commission_basis_points" >= 0 AND "businesses"."commission_basis_points" <= 10000),
	CONSTRAINT "businesses_per_attendee_fee_positive" CHECK ("businesses"."per_attendee_fee_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(60) NOT NULL,
	"name" text NOT NULL,
	"icon" varchar(60) DEFAULT 'activity' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"blurhash" varchar(64),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"title" varchar(120) NOT NULL,
	"description" text NOT NULL,
	"status" "offer_status" DEFAULT 'DRAFT' NOT NULL,
	"experience_type" "experience_type" NOT NULL,
	"skill_level" "skill_level" DEFAULT 'ALL_LEVELS' NOT NULL,
	"price_amount" integer NOT NULL,
	"reference_price_amount" integer,
	"currency" "currency" DEFAULT 'EUR' NOT NULL,
	"duration_minutes" smallint NOT NULL,
	"capacity" smallint NOT NULL,
	"languages" jsonb DEFAULT '["fr"]'::jsonb NOT NULL,
	"amenities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"what_to_bring" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conditions" text,
	"cancellation_policy" "cancellation_policy" DEFAULT 'STANDARD' NOT NULL,
	"trial_rule" "trial_rule" DEFAULT 'ONE_TRIAL_PER_VENUE' NOT NULL,
	"trial_count" integer DEFAULT 0 NOT NULL,
	"conversion_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"rejected_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "offers_price_non_negative" CHECK ("offers"."price_amount" >= 0),
	CONSTRAINT "offers_reference_price_higher" CHECK ("offers"."reference_price_amount" IS NULL OR "offers"."reference_price_amount" >= "offers"."price_amount"),
	CONSTRAINT "offers_duration_positive" CHECK ("offers"."duration_minutes" > 0),
	CONSTRAINT "offers_capacity_positive" CHECK ("offers"."capacity" > 0)
);
--> statement-breakpoint
CREATE TABLE "venue_blocked_dates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"blocked_on" varchar(10) NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venue_categories" (
	"venue_id" uuid NOT NULL,
	"category_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venue_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"role" varchar(20) DEFAULT 'GALLERY' NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"blurhash" varchar(64),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"slug" varchar(120) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "venue_status" DEFAULT 'DRAFT' NOT NULL,
	"address_line" text NOT NULL,
	"postal_code" varchar(12) NOT NULL,
	"city_id" uuid NOT NULL,
	"district_id" uuid,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"time_zone" varchar(64) DEFAULT 'Europe/Brussels' NOT NULL,
	"phone" varchar(30),
	"website" text,
	"instagram" varchar(60),
	"amenities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"languages" jsonb DEFAULT '["fr"]'::jsonb NOT NULL,
	"opening_hours" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"average_rating_hundredths" integer,
	"review_count" integer DEFAULT 0 NOT NULL,
	"approved_at" timestamp with time zone,
	"rejected_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "venues_rating_range" CHECK ("venues"."average_rating_hundredths" IS NULL OR ("venues"."average_rating_hundredths" >= 0 AND "venues"."average_rating_hundredths" <= 500))
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"days_of_week" jsonb NOT NULL,
	"start_time" varchar(5) NOT NULL,
	"capacity" smallint NOT NULL,
	"valid_from" varchar(10) NOT NULL,
	"valid_until" varchar(10),
	"is_active" boolean DEFAULT true NOT NULL,
	"expanded_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_capacity_positive" CHECK ("schedules"."capacity" > 0),
	CONSTRAINT "schedules_start_time_format" CHECK ("schedules"."start_time" ~ '^[0-2][0-9]:[0-5][0-9]$')
);
--> statement-breakpoint
CREATE TABLE "slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"schedule_id" uuid,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"capacity" smallint NOT NULL,
	"reserved_count" smallint DEFAULT 0 NOT NULL,
	"status" "slot_status" DEFAULT 'OPEN' NOT NULL,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slots_capacity_positive" CHECK ("slots"."capacity" > 0),
	CONSTRAINT "slots_reserved_within_capacity" CHECK ("slots"."reserved_count" >= 0 AND "slots"."reserved_count" <= "slots"."capacity"),
	CONSTRAINT "slots_end_after_start" CHECK ("slots"."end_at" > "slots"."start_at")
);
--> statement-breakpoint
CREATE TABLE "attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" "attribution_source" DEFAULT 'organic' NOT NULL,
	"medium" varchar(40),
	"campaign" varchar(80),
	"content" varchar(80),
	"term" varchar(80),
	"referral_code" varchar(40),
	"landing_offer_id" uuid,
	"landing_venue_id" uuid,
	"first_reservation_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"performed_by_user_id" uuid,
	"method" varchar(10) NOT NULL,
	"was_override" boolean DEFAULT false NOT NULL,
	"override_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"status" "reservation_status" DEFAULT 'PENDING' NOT NULL,
	"price_amount" integer NOT NULL,
	"currency" "currency" DEFAULT 'EUR' NOT NULL,
	"trial_rule" "trial_rule" NOT NULL,
	"slot_start_at" timestamp with time zone NOT NULL,
	"slot_end_at" timestamp with time zone NOT NULL,
	"check_in_token_hash" varchar(128),
	"check_in_code" varchar(12),
	"confirmed_at" timestamp with time zone,
	"checked_in_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"hold_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_price_non_negative" CHECK ("reservations"."price_amount" >= 0),
	CONSTRAINT "reservations_slot_window" CHECK ("reservations"."slot_end_at" > "reservations"."slot_start_at")
);
--> statement-breakpoint
CREATE TABLE "trial_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"reserved_at" timestamp with time zone NOT NULL,
	"checked_in_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"status" "reservation_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(255) NOT NULL,
	"user_id" uuid,
	"endpoint" varchar(120) NOT NULL,
	"request_hash" varchar(128) NOT NULL,
	"status_code" integer,
	"response_body" jsonb,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"status" "payment_status" DEFAULT 'REQUIRES_PAYMENT' NOT NULL,
	"provider" varchar(20) DEFAULT 'STRIPE' NOT NULL,
	"provider_payment_intent_id" varchar(64),
	"provider_charge_id" varchar(64),
	"amount" integer NOT NULL,
	"platform_fee_amount" integer DEFAULT 0 NOT NULL,
	"merchant_amount" integer DEFAULT 0 NOT NULL,
	"refunded_amount" integer DEFAULT 0 NOT NULL,
	"currency" "currency" DEFAULT 'EUR' NOT NULL,
	"failure_code" varchar(60),
	"failure_message" text,
	"succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_non_negative" CHECK ("payments"."amount" >= 0),
	CONSTRAINT "payments_refund_within_amount" CHECK ("payments"."refunded_amount" >= 0 AND "payments"."refunded_amount" <= "payments"."amount"),
	CONSTRAINT "payments_split_reconciles" CHECK ("payments"."platform_fee_amount" + "payments"."merchant_amount" = "payments"."amount")
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"provider_refund_id" varchar(64),
	"amount" integer NOT NULL,
	"currency" "currency" DEFAULT 'EUR' NOT NULL,
	"reason" varchar(60),
	"initiated_by_user_id" uuid,
	"succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(20) DEFAULT 'STRIPE' NOT NULL,
	"provider_event_id" varchar(100) NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_message" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"user_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"status" "lead_status" DEFAULT 'NEW' NOT NULL,
	"continuation" "continuation_answer",
	"rating" smallint,
	"contact_consent_at" timestamp with time zone,
	"notes" text,
	"visited_at" timestamp with time zone,
	"contacted_at" timestamp with time zone,
	"converted_at" timestamp with time zone,
	"lost_at" timestamp with time zone,
	"attributed_revenue_amount" integer,
	"currency" "currency" DEFAULT 'EUR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_revenue_non_negative" CHECK ("leads"."attributed_revenue_amount" IS NULL OR "leads"."attributed_revenue_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(60) NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"deep_link" text,
	"read_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referrer_user_id" uuid NOT NULL,
	"code" varchar(40) NOT NULL,
	"offer_id" uuid,
	"share_count" integer DEFAULT 0 NOT NULL,
	"click_count" integer DEFAULT 0 NOT NULL,
	"signup_count" integer DEFAULT 0 NOT NULL,
	"booking_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"comment" text,
	"is_published" boolean DEFAULT true NOT NULL,
	"moderated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" >= 1 AND "reviews"."rating" <= 5)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"actor_type" varchar(20) NOT NULL,
	"action" varchar(80) NOT NULL,
	"entity_type" varchar(60) NOT NULL,
	"entity_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" varchar(45),
	"request_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(80) NOT NULL,
	"description" text,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"rollout_percentage" integer DEFAULT 0 NOT NULL,
	"enabled_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_user_id" uuid,
	"entity_type" varchar(60) NOT NULL,
	"entity_id" uuid NOT NULL,
	"reason" varchar(60) NOT NULL,
	"details" text,
	"status" varchar(20) DEFAULT 'OPEN' NOT NULL,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cities" ADD CONSTRAINT "cities_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "districts" ADD CONSTRAINT "districts_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_interests" ADD CONSTRAINT "user_interests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_images" ADD CONSTRAINT "offer_images_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_blocked_dates" ADD CONSTRAINT "venue_blocked_dates_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_categories" ADD CONSTRAINT "venue_categories_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_categories" ADD CONSTRAINT "venue_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_images" ADD CONSTRAINT "venue_images_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_landing_offer_id_offers_id_fk" FOREIGN KEY ("landing_offer_id") REFERENCES "public"."offers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_landing_venue_id_venues_id_fk" FOREIGN KEY ("landing_venue_id") REFERENCES "public"."venues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_first_reservation_id_reservations_id_fk" FOREIGN KEY ("first_reservation_id") REFERENCES "public"."reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_slot_id_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."slots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_history" ADD CONSTRAINT "trial_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_history" ADD CONSTRAINT "trial_history_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_history" ADD CONSTRAINT "trial_history_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_history" ADD CONSTRAINT "trial_history_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_history" ADD CONSTRAINT "trial_history_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_user_id_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_moderated_by_user_id_users_id_fk" FOREIGN KEY ("moderated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cities_country_slug_key" ON "cities" USING btree ("country_id","slug");--> statement-breakpoint
CREATE INDEX "cities_country_idx" ON "cities" USING btree ("country_id");--> statement-breakpoint
CREATE UNIQUE INDEX "countries_code_key" ON "countries" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "districts_city_slug_key" ON "districts" USING btree ("city_id","slug");--> statement-breakpoint
CREATE INDEX "districts_city_idx" ON "districts" USING btree ("city_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_provider_account_key" ON "auth_identities" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "auth_identities_user_idx" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "otp_codes_email_idx" ON "otp_codes" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "otp_codes_expires_idx" ON "otp_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "profiles_last_city_idx" ON "profiles" USING btree ("last_city_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_tokens_token_key" ON "push_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "push_tokens_user_idx" ON "push_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_key" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_interests_key" ON "user_interests" USING btree ("user_id","category_id");--> statement-breakpoint
CREATE INDEX "user_interests_category_idx" ON "user_interests" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "business_members_key" ON "business_members" USING btree ("business_id","user_id");--> statement-breakpoint
CREATE INDEX "business_members_user_idx" ON "business_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "businesses_slug_key" ON "businesses" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "businesses_status_idx" ON "businesses" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_key" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "offer_images_offer_idx" ON "offer_images" USING btree ("offer_id","sort_order");--> statement-breakpoint
CREATE INDEX "offers_venue_idx" ON "offers" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "offers_business_idx" ON "offers" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "offers_category_idx" ON "offers" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "offers_status_idx" ON "offers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "offers_published_idx" ON "offers" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "offers_active_price_idx" ON "offers" USING btree ("price_amount") WHERE status = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "venue_blocked_dates_key" ON "venue_blocked_dates" USING btree ("venue_id","blocked_on");--> statement-breakpoint
CREATE UNIQUE INDEX "venue_categories_key" ON "venue_categories" USING btree ("venue_id","category_id");--> statement-breakpoint
CREATE INDEX "venue_categories_category_idx" ON "venue_categories" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "venue_images_venue_idx" ON "venue_images" USING btree ("venue_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "venues_slug_key" ON "venues" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "venues_business_idx" ON "venues" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "venues_city_idx" ON "venues" USING btree ("city_id");--> statement-breakpoint
CREATE INDEX "venues_district_idx" ON "venues" USING btree ("district_id");--> statement-breakpoint
CREATE INDEX "venues_status_idx" ON "venues" USING btree ("status");--> statement-breakpoint
CREATE INDEX "schedules_offer_idx" ON "schedules" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "schedules_venue_idx" ON "schedules" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "slots_offer_start_idx" ON "slots" USING btree ("offer_id","start_at");--> statement-breakpoint
CREATE INDEX "slots_venue_start_idx" ON "slots" USING btree ("venue_id","start_at");--> statement-breakpoint
CREATE INDEX "slots_schedule_idx" ON "slots" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "slots_open_start_idx" ON "slots" USING btree ("start_at") WHERE status = 'OPEN';--> statement-breakpoint
CREATE UNIQUE INDEX "slots_offer_start_key" ON "slots" USING btree ("offer_id","start_at");--> statement-breakpoint
CREATE INDEX "attributions_user_idx" ON "attributions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "attributions_campaign_idx" ON "attributions" USING btree ("source","campaign");--> statement-breakpoint
CREATE INDEX "attributions_referral_idx" ON "attributions" USING btree ("referral_code");--> statement-breakpoint
CREATE UNIQUE INDEX "check_ins_reservation_key" ON "check_ins" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "check_ins_venue_idx" ON "check_ins" USING btree ("venue_id","created_at");--> statement-breakpoint
CREATE INDEX "reservations_user_idx" ON "reservations" USING btree ("user_id","slot_start_at");--> statement-breakpoint
CREATE INDEX "reservations_slot_idx" ON "reservations" USING btree ("slot_id");--> statement-breakpoint
CREATE INDEX "reservations_venue_start_idx" ON "reservations" USING btree ("venue_id","slot_start_at");--> statement-breakpoint
CREATE INDEX "reservations_business_idx" ON "reservations" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "reservations_offer_idx" ON "reservations" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "reservations_status_idx" ON "reservations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reservations_hold_expiry_idx" ON "reservations" USING btree ("hold_expires_at") WHERE status IN ('PENDING', 'PAYMENT_PENDING');--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_user_slot_live_key" ON "reservations" USING btree ("user_id","slot_id") WHERE status IN ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW');--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_check_in_code_key" ON "reservations" USING btree ("check_in_code") WHERE check_in_code IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "trial_history_reservation_key" ON "trial_history" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "trial_history_user_venue_idx" ON "trial_history" USING btree ("user_id","venue_id");--> statement-breakpoint
CREATE INDEX "trial_history_user_business_idx" ON "trial_history" USING btree ("user_id","business_id");--> statement-breakpoint
CREATE INDEX "trial_history_user_offer_idx" ON "trial_history" USING btree ("user_id","offer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_scope_key" ON "idempotency_keys" USING btree ("user_id","endpoint","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_reservation_key" ON "payments" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_intent_key" ON "payments" USING btree ("provider_payment_intent_id") WHERE provider_payment_intent_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payments_business_idx" ON "payments" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "refunds_payment_idx" ON "refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_provider_key" ON "refunds" USING btree ("provider_refund_id") WHERE provider_refund_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_key" ON "webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("created_at") WHERE processed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "favorites_key" ON "favorites" USING btree ("user_id","offer_id");--> statement-breakpoint
CREATE INDEX "favorites_user_idx" ON "favorites" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "favorites_offer_idx" ON "favorites" USING btree ("offer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_reservation_key" ON "leads" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "leads_business_status_idx" ON "leads" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "leads_venue_idx" ON "leads" USING btree ("venue_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_user_idx" ON "leads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id") WHERE read_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_code_key" ON "referrals" USING btree ("code");--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" USING btree ("referrer_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_reservation_key" ON "reviews" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "reviews_venue_idx" ON "reviews" USING btree ("venue_id","created_at");--> statement-breakpoint
CREATE INDEX "reviews_offer_idx" ON "reviews" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags" USING btree ("key");--> statement-breakpoint
CREATE INDEX "reports_status_idx" ON "reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "reports_entity_idx" ON "reports" USING btree ("entity_type","entity_id");