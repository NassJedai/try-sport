# TRY — Project Plan

Sports discovery marketplace. Launch Brussels, architected for Belgium → Benelux →
Europe without a rewrite.

**Principle:** build for scale, do not over-engineer before scale.

---

## 1. Current state

The repository was empty at the start of this build. Everything below was created
from scratch.

| Layer | Status |
| --- | --- |
| Monorepo, tooling, CI config | Built |
| `@try/utils`, `@try/contracts` | Built, 84 tests |
| `@try/database` — schema, migrations, seed | Built, not executed (see §11) |
| `@try/config`, `@try/logger` | Built, tested |
| API — auth, discovery, offers, booking, check-in, payments, reviews, favourites | Built, 29 tests |
| Reservation lifecycle jobs | Built — hold expiry, completion, no-shows |
| Mobile consumer app | Built — discovery → booking → QR → review |
| Business web app | Built — dashboard, bookings, check-in, CRM |
| Admin web app | Built — shell, access control, moderation + overview endpoints |
| Supply onboarding | Built — business → venue → offer → schedule → submit → approve |

---

## 2. Architecture

```
                         CDN / Edge
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
  Consumer (Expo)     Business (Next.js)    Admin (Next.js)
        │                    │                    │
        └────────────────────┼────────────────────┘
                             ▼
                    TRY API — NestJS + Fastify
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
  PostgreSQL+PostGIS       Redis               Queue
                             │
      Stripe · Maps · Object storage · Email · Push · Analytics
```

**Modular monolith, not microservices.** Module boundaries are real — each domain
owns its services and communicates outward through `DomainEvents` — but they
deploy as one process. That keeps a booking, its payment and its trial history
inside one database transaction, which at this stage is worth far more than
independent deployability. `docs/architecture.md` records how to extract Search,
Payments, Notifications and Booking later, and §9 lists the metrics that would
justify doing so.

**No critical writes from the client.** Bookings, payments, check-ins, trial
history, lead conversion and permissions all go through the API. The mobile app
never touches Postgres.

---

## 3. Technology choices

| Area | Choice | Why |
| --- | --- | --- |
| Backend | NestJS 11 + Fastify 5 | DI and module boundaries that survive team growth; Fastify for throughput |
| ORM | Drizzle 0.45 | SQL transparency for PostGIS, versioned SQL migrations, no proprietary engine — [ADR-001](docs/adr/ADR-001-database-orm.md) |
| Database | Postgres + PostGIS | Geo discovery is the core query; PostGIS is the only serious answer |
| Validation | Zod 4 | One schema drives validation, types and OpenAPI |
| Mobile | Expo 57 / RN 0.87, Expo Router | New Architecture, OTA updates, EAS |
| Web | Next.js 16, Tailwind 4 | Server Components where they pay, familiar to hire for |
| Server state | TanStack Query | Cache, prefetch, optimistic updates |
| Client state | Zustand | Local UI state only — server state is never duplicated into it |
| Maps | Mapbox | Vector tiles, clustering, styling — [ADR-002](docs/adr/ADR-002-map-provider.md) |
| Auth | Own JWT + OTP, provider-agnostic | [ADR-003](docs/adr/ADR-003-authentication.md) |
| Search | Postgres FTS behind `SearchProvider` | [ADR-005](docs/adr/ADR-005-search.md) |

---

## 4. Database schema

38 tables. Full reference in `docs/database.md`. The load-bearing decisions:

- **Money is integer minor units + currency, everywhere.** No floats. Commission
  in basis points so 12.5% is exact.
- **`venues.location`** is a `geography(Point,4326)` STORED GENERATED column
  derived from lat/lng, with a GiST index. It cannot drift from its coordinates,
  and it is managed by a hand-written migration — [ADR-006](docs/adr/ADR-006-postgis-column.md).
- **`slots.reserved_count`** carries `CHECK (reserved_count BETWEEN 0 AND capacity)`.
  Overselling is refused by the storage engine, not merely by application code.
- **Partial unique index** on `reservations(user_id, slot_id)` over live statuses
  stops a double tap creating two bookings across two API instances.
- **`payments`** enforces `platform_fee + merchant = amount`, so a rounding bug
  fails the write instead of quietly mis-paying a venue.
- **`users` / `profiles` split** so a GDPR erasure drops personal data without
  orphaning reservations or breaking payment reconciliation.
- **Timestamps are `timestamptz` in UTC**, rendered in the venue's timezone.

---

## 5. API modules

`auth · users · businesses · venues · categories · discovery · search · offers ·
availability · bookings · trials · checkins · payments · billing · reviews ·
favorites · leads · notifications · analytics · admin · health`

REST under `/v1`, OpenAPI at `/docs` outside production. Cross-cutting: request
ids, structured logging with redaction, rate limiting, idempotency keys, a global
auth guard that fails closed.

---

## 6. Screens

**Consumer (Expo Router).** Tabs: Explorer · Carte · Réservations · Favoris ·
Profil. Routes `/`, `/search`, `/offer/[id]`, `/venue/[id]`, `/booking/[id]`,
`/booking/[id]/qr`, `/map`, `/profile`. Onboarding: intro → interests → location.

**Business.** Onboarding (business → venue → offer → schedule → submit),
dashboard (trials, check-ins, no-shows, conversions, attributed revenue),
today's bookings, QR/code validation, CRM-lite pipeline.

**Admin.** Overview metrics, moderation queues for venues and offers, users,
bookings, payments, audit log.

---

## 7. Security

Never trust the client. Price, commission, role, payment status, booking status
and payout are all resolved server-side. Permissions are enforced in the API,
never in a component. Specifics in `docs/security.md`:

- Rate limits on login, OTP, signup, search, booking, payment, review, referral.
- Idempotency keys on every money-moving or trial-consuming mutation.
- OTP and refresh tokens stored hashed; refresh rotation with reuse detection.
- QR check-in tokens are HMAC-signed — a reservation UUID is not a credential.
- Admin actions are audited in the same transaction as the change.
- Explicit CORS allowlist; wildcard is rejected by configuration in production.

---

## 8. Performance

Budgets in `docs/performance.md`. Targets: read p95 < 300 ms, booking p95 < 700 ms
excluding the payment provider, 60 fps minimum on mobile.

The home screen is one aggregating call (`GET /v1/discovery/home`), not eight.
Lists are cursor-paginated and bounded. Cards carry three image variants so a feed
never downloads a 4000×3000 original for a thumbnail. Navigation is cached-first:
tapping an offer renders the known image, title, price and venue immediately, then
hydrates.

---

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Overselling a class | Conditional UPDATE + CHECK constraint + concurrency tests |
| Double charge on retry | Idempotency keys; Stripe idempotency; idempotent webhooks |
| Supply cold-start in a new city | Business onboarding is self-serve; ranking gives unproven venues a neutral score rather than last place |
| Trial abuse | Eligibility evaluated under an advisory lock; no-shows count as consumed |
| Vendor lock-in | Payment, storage, email, search and map providers all sit behind interfaces |
| Scaling past the monolith | Extract only on measured CPU saturation, DB contention, queue latency or deployment coupling — not on principle |

---

## 10. MVP checklist

**Consumer** — open app ✔ · create account ✔ · select interests ✔ · set location ✔ ·
browse ✔ · filter ✔ · map ✔ · offer detail ✔ · availability ✔ · book free ✔ ·
book paid ✔ · confirmation ✔ · upcoming booking ✔ · QR ✔ · check-in ✔ · review ✔ ·
continuation answer ✔

**Business** — create business ✔ · venue ✔ · offer ✔ · schedule ✔ · submit ✔ ·
receive bookings ✔ · today's list ✔ · validate QR ✔ · mark no-show ✔ · leads ✔ ·
update status ✔ · mark converted ✔ · analytics ✔

**Admin** — secure login ✔ · role enforced server-side and verified with real
signed tokens (a valid USER token gets 403) ✔ · moderation queue ✔ ·
approve/reject/suspend venue ✔ · approve/reject/pause offer ✔ · platform overview
metrics ✔ · every decision audited in the same transaction ✔

Still to build in the console UI: the users, bookings and payments *browsing*
views. The endpoints they need beyond `/v1/admin/overview` do not exist yet.

**Business onboarding** — create business ✔ · add venue ✔ · create offer ✔ ·
recurring schedule that materialises real slots ✔ · submit for approval ✔ ·
pause/resume ✔ · cancel a slot and release its bookings ✔

The business web app currently exposes the dashboard, bookings and CRM; the
onboarding wizard UI on top of these endpoints is not built.

---

## 11. Known gaps

Stated plainly rather than marked done:

1. ~~The database has never been started~~ **Résolu.** PostgreSQL 17.11 +
   PostGIS 3.5 tourne en local (binaires Postgres.app extraits sans root,
   cluster dans `~/.try-sport`, port 5433, `scripts/db.sh`). Les 3 migrations et
   le seed complet sont passés ; les **7 tests de concurrence passent contre la
   vraie base** ; le parcours OTP → dashboard → CRM est vérifié dans le
   navigateur avec les données réelles.
2. ~~Integration tests skipped~~ **Résolu — et ils ont payé.** Le premier run
   réel a trouvé quatre vrais bugs : Drizzle enveloppe les erreurs Postgres, donc
   `isUniqueViolation` lisait `error.code` au mauvais niveau et la détection de
   double réservation était silencieusement cassée ; et les frontières SQL brut
   mentaient sur les dates dans les deux sens (les `timestamptz` sortent en
   chaînes, les paramètres `Date` sont refusés à l'entrée) — crash du ranking et
   des métriques business au premier appel réel.
3. ~~Mobile : compile et se sert, jamais affichée~~ **Résolu — l'app tourne sur
   un vrai iPhone**, et c'est ce passage sur l'appareil qui a payé. Trois causes
   distinctes se cachaient derrière la même erreur affichée (« impossible de se
   connecter »), ce qui a coûté plusieurs allers-retours :
   - **Aucun `babel.config.js` n'existait.** Les worklets de Reanimated
     n'étaient donc jamais transformés et l'app plantait au premier import
     (« Exception in HostFunction »). Invisible au typecheck, invisible à la
     compilation du bundle : seul un lancement sur un appareil le montre.
   - **Version du SDK.** Épinglé sur 57 puis 56 (`latest` sur npm), alors que
     l'Expo Go de l'App Store supporte **54**. Règle tirée de cet épisode et du
     précédent sur react-native : dans l'écosystème Expo/RN, « dernière version
     npm » n'est pas « version supportée » — c'est `expo install` qui fait foi.
   - **Quatre serveurs Metro simultanés**, le téléphone tapant sur un ancien qui
     servait un état d'avant réinstallation. Puis, une fois cela réglé, un
     décalage de port entre l'entrée mémorisée dans Expo Go et le serveur.
4. **Payments are wired but unexercised** against real Stripe test keys.
5. ~~Two UI surfaces lag their APIs~~ **Résolu** : l'assistant d'inscription des
   salles et les vues admin (utilisateurs, réservations, paiements) sont
   construits et vérifiés dans le navigateur avec un compte neuf.
6. **Deferred by design:** referrals, TRY+, corporate, waitlist, dynamic pricing,
   Stripe Connect payouts, Meta CAPI. Flags exist; implementations do not.
7. **Notifications : e-mail uniquement.** Les rappels avant séance partent par
   e-mail et s'affichent dans l'app ; il n'y a pas de notification *push*. C'est
   un choix de séquence, pas un oubli : le push demande des identifiants Apple et
   Google que le projet n'a pas encore, et la table `notifications` est déjà la
   file dans laquelle un envoi push viendrait puiser.

### Fixed after the first pass

An audit of my own checklist found four things claimed or implied as working
that were not:

- **No review endpoint existed**, despite "leave review ✔" and "continuation ✔".
  The mobile booking screen linked to a route that did not exist. Now built,
  including the forward-only lead rule (a late review must not drag a converted
  customer back to "interested"), unit-tested in `lead-pipeline.test.ts`.
- **No favourites endpoint existed**, despite a favourites tab and an
  `isFavorite` field on every offer. Now built, with optimistic UI.
- **Nothing ever completed a trial.** `CHECKED_IN` was terminal in practice, so
  `TrialCompleted` never fired and every venue's funnel stalled at "attended".
- **Nothing read `hold_expires_at`.** An abandoned payment held a seat *and* the
  user's trial allowance at that venue permanently. Both are now released by a
  scheduled sweep, verified to fail gracefully and keep serving when the database
  is unreachable.
- **Nothing expanded recurring schedules into slots.** `schedules` and
  `expanded_until` existed, but only the seed ever created slots — so a real
  business could define "every Monday at 19:00" and never receive a booking. Now
  expanded on write and rolled forward nightly, idempotently.

---

## 12. Phases

- **Phase 0–2 (done)** Monorepo, shared packages, database, API core.
- **Phase 3–4 (done)** Discovery, booking, payments, check-in, tests.
- **Phase 5–6 (done)** Mobile consumer app, business and admin web apps.
- **Phase 7 (next)** Run migrations against a real database, execute the
  integration suite, exercise Stripe test mode end to end, EAS build profiles,
  load-test discovery and booking.
