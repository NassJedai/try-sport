# ADR-005 — Search

**Status:** accepted · **Date:** 2026-08-14

## Context

Users search activities, categories, venues, districts and cities. At launch the
corpus is a few hundred offers in one city.

## Decision

**Postgres full-text search** for the MVP, behind a `SearchProvider` interface.

- `tsvector` GENERATED columns on `offers` and `venues`, GIN-indexed, using the
  `french` configuration so "pilates débutant" matches "cours de pilates pour
  débutants".
- `pg_trgm` for typo tolerance on venue names ("Basicfit" → "Basic-Fit"), which
  tsvector matching cannot do.
- `websearch_to_tsquery`, which tolerates the punctuation people actually type.

## Consequences

- No extra service, no sync pipeline, no index that can silently fall behind the
  database — the generated columns cannot drift.
- Ranking beyond `ts_rank` is limited; acceptable while discovery is driven
  mostly by geography and category.
- Typesense or Meilisearch becomes a new implementation of one interface when
  multi-city volume or multilingual (NL) relevance justifies it.
