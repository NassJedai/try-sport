# Architecture

## Shape

A **modular monolith**. Module boundaries are real — each domain owns its
services and talks outward through `DomainEvents` rather than reaching into
another module's internals — but everything deploys as one process.

That is a deliberate trade. Keeping a booking, its payment and its trial history
inside a single database transaction is worth far more at this stage than
independent deployability. Microservices would buy team autonomy we do not yet
need, and cost us distributed transactions we cannot afford to get wrong.

```
Consumer (Expo) ─┐
Business (Next)  ├─► TRY API (NestJS + Fastify) ─► Postgres + PostGIS
Admin (Next)   ──┘            │                     Redis
                              └─► Stripe · Storage · Email · Push · Analytics
```

## Layers

**Controllers** validate input with Zod and resolve the caller's identity. They
contain no business rules.

**Services** own the domain. Booking eligibility, state transitions, pricing and
commission live here, and they are unit-testable because time comes from an
injected `Clock` and the database is reached through a handle that can be a
transaction.

**Repositories** hold the SQL that is worth reading — the discovery queries are
hand-written on purpose, because they are the hottest path and we want to see
exactly what Postgres will run.

**The database** enforces what must never be violated: capacity, payment
reconciliation, one-live-booking-per-slot, rating ranges. Application bugs should
hit a constraint, not corrupt data.

## Where the truth lives

| Concern | Source of truth |
| --- | --- |
| Business data | PostgreSQL |
| Money movement | Stripe |
| Business rules | The API |
| Behavioural analytics | PostHog |
| Cache, rate limits | Redis (never authoritative) |

Redis may make a booking *faster*; it must never be what makes a booking *valid*.

## Domain events

`BookingConfirmed`, `CheckInCompleted`, `TrialCompleted`, `LeadConverted`,
`PaymentSucceeded` and friends decouple side effects from the transaction that
caused them. Confirming a booking must not wait on an email provider, and an
email outage must not roll back a confirmed booking.

They are in-process `EventEmitter` calls today. That is the point: when a module
needs extracting, these names are already the seam, and only the transport behind
`DomainEvents` changes.

## Extraction path

Extract only on evidence — CPU saturation, database contention, queue latency, or
deployment coupling between teams. Not because microservices are scalable.

| Candidate | Why it would go first | What it needs |
| --- | --- | --- |
| Search | Different scaling curve; already behind `SearchProvider` | Index sync pipeline |
| Notifications | Purely async, already event-driven | A durable queue |
| Payments | Compliance isolation | Webhook routing, shared payment tables |
| Booking | Last, if ever — it owns the transaction everything else depends on | Distributed locking, and a very good reason |

## Portability

Nothing in the domain imports a vendor SDK. `PaymentProvider`, `EmailTransport`,
`SearchProvider`, `MapProvider` and `AnalyticsService` are interfaces; Stripe,
Resend, Postgres FTS, Mapbox and PostHog are implementations.

Moving to AWS (ECS, Aurora, ElastiCache, S3, CloudFront, SQS) is a deployment
change, not a rewrite. See [ADR-004](adr/ADR-004-hosting.md).
