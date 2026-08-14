# Database

PostgreSQL 15+ with PostGIS. 38 tables. Migrations are versioned SQL files in
`packages/database/drizzle/`, applied by one migrator against one ledger
(`__drizzle_migrations`).

The database is never changed by hand, and `drizzle-kit push` is not used outside
a throwaway local database: every environment must be reachable by replaying the
same files in the same order.

## Conventions

- UUID primary keys, `created_at` / `updated_at` on anything mutable.
- **All timestamps are `timestamptz` in UTC.** Rendered in the venue's timezone.
- **Money is an integer column plus a currency column.** Never numeric, never float.
- Soft deletion (`deleted_at`) only where an entity must survive for accounting
  or moderation — never as a blanket policy, because a `deleted_at` on every
  table turns every query into a potential bug.
- Postgres enums are generated from the shared TypeScript constants in
  `@try/contracts`, so the database and the API cannot disagree about what a
  status is.

## Constraints that carry weight

These are the ones that make incorrect states unrepresentable rather than merely
unlikely:

| Constraint | What it prevents |
| --- | --- |
| `slots_reserved_within_capacity` | Overselling a class, even if application code regresses |
| `reservations_user_slot_live_key` (partial unique) | A double tap creating two bookings, across two API instances |
| `payments_split_reconciles` | A rounding bug silently mis-paying a venue |
| `payments_refund_within_amount` | Refunding more than was charged |
| `webhook_events_provider_event_key` | Stripe redelivery confirming a booking twice |
| `reviews_reservation_key` | Rating stuffing — one review per attended session |
| `offers_reference_price_higher` | A "discount" that is really a price rise |

The partial unique index on reservations covers only *live* statuses
(`PENDING`, `PAYMENT_PENDING`, `CONFIRMED`, `CHECKED_IN`, `COMPLETED`, `NO_SHOW`),
so cancelling genuinely frees the user to rebook.

## Geospatial

`venues.location` is `geography(Point, 4326)`, `GENERATED ALWAYS AS
(ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED`, with a
GiST index. Generated, so it cannot drift from the coordinates it derives from
and there is no trigger to forget. `geography` rather than `geometry` so
`ST_DWithin` and `ST_Distance` return metres.

It is created in the hand-written `0001_postgis.sql` rather than by drizzle-kit —
see [ADR-006](adr/ADR-006-postgis-column.md).

## Search

`tsvector` GENERATED columns on `offers` and `venues` with GIN indexes, using the
`french` configuration so "pilates débutant" matches "cours de pilates pour
débutants". `pg_trgm` adds typo tolerance on venue names. See
[ADR-005](adr/ADR-005-search.md).

## Table groups

**Geography** `countries`, `cities`, `districts`

**Identity** `users`, `profiles`, `user_interests`, `auth_identities`,
`otp_codes`, `refresh_tokens`, `push_tokens`

`users` holds the minimal record that must survive for accounting; `profiles`
holds the personal data a user can ask us to erase. A GDPR deletion anonymises
the first and drops the second without orphaning reservations.

**Catalog** `businesses`, `business_members`, `venues`, `venue_images`,
`venue_categories`, `venue_blocked_dates`, `categories`, `offers`, `offer_images`

A business is never assumed to equal a venue — a chain is one business and many
venues, and every ownership query goes through `business_members`.

**Scheduling** `schedules`, `slots`

Recurring rules are the business's mental model; they are expanded into concrete
`slots` because a booking must attach to a real row that can be locked and
counted. You cannot take a transactional lock on a recurrence rule.

**Booking** `reservations`, `check_ins`, `trial_history`, `attributions`

Reservations snapshot price, currency and trial rule at booking time: a later
price change must not alter what a user agreed to pay.

**Payments** `payments`, `refunds`, `webhook_events`, `idempotency_keys`

**Engagement** `favorites`, `reviews`, `leads`, `referrals`, `notifications`

**Platform** `audit_logs`, `reports`, `feature_flags`

## Migration safety

Expand → migrate → contract. Never drop a column in the same release that stops
writing it: add the new shape, backfill, switch reads, and only then remove the
old one, so a rollback never lands on a schema that cannot serve the previous
version.
