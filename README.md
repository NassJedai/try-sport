# TRY

Sports discovery marketplace. Find an activity near you, try it once without
commitment, and decide afterwards.

Launching in Brussels; architected for Belgium → Benelux → Europe without a
rewrite.

---

## Quick start

```bash
pnpm install
cp .env.example .env          # then fill in DATABASE_URL and the two secrets
pnpm run build --filter="./packages/*"
pnpm db:migrate
pnpm db:seed
pnpm dev
```

You need **Node ≥ 22.12** and a **Postgres 15+ with PostGIS**. Neon and Supabase
both work; so does a local Postgres with `CREATE EXTENSION postgis`.

| Command | What it runs |
| --- | --- |
| `pnpm dev` | Everything, in parallel |
| `pnpm api` | API on :3000 (`/docs` for OpenAPI) |
| `pnpm mobile` | Expo dev server |
| `pnpm business` | Business dashboard on :3001 |
| `pnpm admin` | Admin console on :3002 |
| `pnpm test` | Unit tests |
| `pnpm test:integration` | DB-backed tests (needs `TEST_DATABASE_URL`) |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | Verification |

Seeded demo accounts (dev/staging only — sign in with the code the API prints
when `AUTH_DEV_ECHO_OTP=true`):

```
user@try.local        consumer
business@try.local    OWNER of Move Collective
admin@try.local       platform admin
```

### Two things that will bite you

1. **Move the repo somewhere without spaces in the path** before any native
   mobile build. Metro, Gradle and Xcode all break on them. The API and web apps
   are unaffected.
2. **PostGIS is required**, not optional. Discovery is `ST_DWithin` on a
   GiST-indexed geography column; without the extension the migrations fail.

---

## Layout

```
apps/
  api/          NestJS + Fastify — the only writer of business data
  mobile/       Expo Router consumer app
  business/     Next.js dashboard for venues
  admin/        Next.js moderation console
packages/
  contracts/    Zod schemas, enums, state machine, ranking — the shared vocabulary
  database/     Drizzle schema, migrations, seed
  api-client/   Typed client used by all three frontends
  utils/        Money, geo, time, ids — no framework dependencies
  design-tokens/ Colour, spacing, type, motion, shared web + mobile
  config/       Fail-fast environment validation
  logger/       Structured logs with redaction and request ids
docs/           Architecture, security, performance, ADRs
```

---

## What holds this together

**Money is integer minor units.** Never a float, anywhere. Commission is basis
points so 12.5% is exact.

**The client never decides anything that matters.** It sends a slot id. Price,
eligibility, capacity, commission and status are all resolved server-side.

**Capacity cannot be oversold.** One conditional `UPDATE` serialised by Postgres
row locking, plus a `CHECK` constraint that refuses the write even if the
application code regresses. Proven by
[`booking-concurrency.integration.test.ts`](apps/api/test/booking-concurrency.integration.test.ts).

**Timestamps are UTC, displayed in the venue's timezone.** A 19:00 class stays at
19:00 across a DST change.

**Nothing in the domain imports a vendor SDK.** Payments, storage, email, search
and maps all sit behind interfaces, so the hosting decisions in
[ADR-004](docs/adr/ADR-004-hosting.md) are reversible.

---

## Documentation

- [PROJECT_PLAN.md](PROJECT_PLAN.md) — plan, MVP checklist, and an honest list of
  what is not yet proven
- [docs/architecture.md](docs/architecture.md)
- [docs/database.md](docs/database.md)
- [docs/security.md](docs/security.md)
- [docs/performance.md](docs/performance.md)
- [docs/adr/](docs/adr/) — why the load-bearing decisions were made
