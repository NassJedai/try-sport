# ADR-001 — Database access layer

**Status:** accepted · **Date:** 2026-08-14

## Context

TRY's central query is geospatial ("what can I try within 3 km, available
tonight, that I haven't already tried"). We need type safety, versioned
migrations we can review, and unobstructed access to PostGIS.

## Options

**Prisma.** Best-in-class DX and the most familiar to hire for. But PostGIS is
not a supported type: geography columns must be handled through `Unsupported`
and raw queries, which loses exactly the type safety that motivates Prisma. Its
migration engine also resists hand-written SQL, which we need for generated
columns.

**Kysely.** Excellent SQL fidelity and typing. No first-class migration and
schema-definition story, so we would assemble one.

**Drizzle.** Schema in TypeScript, migrations emitted as plain reviewable SQL
files, and raw `sql` fragments compose with the query builder instead of falling
outside it.

## Decision

**Drizzle ORM** with the `postgres.js` driver.

The deciding factor is that discovery queries are hand-written SQL *by choice* —
they are the hottest path in the product and we want to read exactly what
Postgres will execute and paste it into EXPLAIN. Drizzle lets those live beside
typed queries rather than in a separate escape hatch. Migrations being ordinary
SQL files also means the PostGIS and full-text work in `0001`/`0002` is reviewed
like any other change.

## Consequences

- Relational-query ergonomics are thinner than Prisma's; acceptable, since the
  queries that matter are deliberately explicit anyway.
- `drizzle-kit` renders parameterised types as quoted identifiers, so PostGIS
  columns are managed by hand — see ADR-006.
- Nothing prevents a later move to Kysely: the repository layer is the seam.
