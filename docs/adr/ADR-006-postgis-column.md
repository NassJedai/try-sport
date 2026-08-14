# ADR-006 — PostGIS columns outside the ORM schema

**Status:** accepted · **Date:** 2026-08-14

## Context

`venues.location` is a `geography(Point, 4326)` column, GiST-indexed, and it is
what makes "what can I try near me" fast rather than a sequential scan over every
venue in the country.

Declaring it in the drizzle schema produced invalid SQL. drizzle-kit renders a
parameterised type as a quoted identifier:

```sql
"location" "geography(Point, 4326)" GENERATED ALWAYS AS (...) STORED
```

Postgres reads `"geography(Point, 4326)"` as a type *name* and rejects it.

## Options

1. Store the column as text and cast in queries — loses the GiST index, which is
   the entire point.
2. Post-process generated migrations — a build step someone will forget.
3. Keep PostGIS columns out of the drizzle schema and manage them in
   hand-written migrations.

## Decision

Option 3.

`0001_postgis.sql` adds the extension, the generated columns and the GiST
indexes. It is registered in `drizzle/meta/_journal.json`, so one migrator and
one ledger (`__drizzle_migrations`) apply everything in order — there is no
second mechanism that could disagree.

The column is `GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude),
4326)::geography) STORED`, so it cannot drift from the coordinates it derives
from, and there is no trigger to maintain. Reads never parse EWKB in JavaScript:
queries select `ST_X`/`ST_Y` or a distance.

## Consequences

- drizzle-kit builds its snapshot from the TypeScript schema rather than by
  introspecting the database, so it neither sees nor drops these columns.
- Geo queries live in `DiscoveryRepository` as explicit SQL — which is where we
  wanted them regardless.
- The same pattern covers the `tsvector` columns from ADR-005.
