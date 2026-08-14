# Infrastructure

Decision recorded in [ADR-004](adr/ADR-004-hosting.md). This file is the
operational detail.

| Concern | Choice | Notes |
| --- | --- | --- |
| API | Fly.io or Railway, Docker | Stateless; scale horizontally |
| Database | Neon Postgres + PostGIS | EU region; branching for previews |
| Cache | Upstash Redis | Rate limits, hot cache |
| Storage | Cloudflare R2 | S3-compatible |
| CDN | Cloudflare | Image resizing at the edge |
| Web | Vercel | Business :3001, Admin :3002 |
| Mobile | Expo EAS | development / preview / production profiles |
| Payments | Stripe | Behind `PaymentProvider` |
| Analytics | PostHog EU | Behind `AnalyticsService` |
| Errors | Sentry | Tagged with release, environment, request id |

Everything is EU-region, which matters for GDPR posture in Belgium.

## Environments

`local` → `development` → `staging` → `production`, each with its own database.
Staging never points at production data — the seed script refuses to run against
a URL that looks production-like, and configuration refuses to boot in
staging/production without Redis and Stripe.

## Deploy

The API is a plain container reading configuration from the environment:

```
pnpm install --frozen-lockfile
pnpm run build --filter="./packages/*"   # apps consume compiled output
pnpm --filter @try/api build
node apps/api/dist/main.js
```

Migrations run as a release step *before* the new version takes traffic:

```
pnpm db:migrate
```

Because migrations follow expand → migrate → contract, the previous version can
still serve requests while the new schema is in place.

## Health

- `GET /health` — liveness. Deliberately does not touch the database: a brief
  database blip must not make the orchestrator kill every healthy instance.
- `GET /ready` — readiness. Checks the database and reports `degraded`, removing
  the instance from the load balancer without restarting it.

Both are version-neutral, so probes never need to track an API version.

## Scaling triggers

Move to a more complex architecture only on evidence: sustained CPU saturation,
database contention, queue latency, or deployment coupling between teams. Not
because a pattern is fashionable.

First moves, in order: a read replica for discovery; a dedicated search service;
extracting notifications onto a durable queue.
