# ADR-004 — Hosting and infrastructure

**Status:** accepted · **Date:** 2026-08-14

## Context

A small team needs to ship without operating Kubernetes, while keeping the door
open to AWS if scale or procurement demands it.

## Decision

| Concern | Choice | Portability |
| --- | --- | --- |
| API | Fly.io or Railway (Docker) | Any container host |
| Database | Neon Postgres + PostGIS | Any Postgres 15+ |
| Cache / rate limit | Upstash Redis | Any Redis |
| Object storage | Cloudflare R2 | S3-compatible |
| CDN | Cloudflare | Any CDN |
| Web | Vercel | Any Node host |
| Mobile | Expo EAS | — |
| Payments | Stripe | Behind `PaymentProvider` |
| Analytics | PostHog (EU) | Behind `AnalyticsService` |
| Errors | Sentry | Behind an abstraction |

The API is a plain Docker container reading configuration from the environment.
Nothing in the domain imports a vendor SDK.

## Consequences

- Migration to AWS (ECS, RDS/Aurora, ElastiCache, S3, CloudFront, SQS) is a
  deployment change, not a rewrite.
- Data residency is EU throughout, which matters for GDPR posture in Belgium.
- We accept managed-service pricing in exchange for not employing an SRE yet.
