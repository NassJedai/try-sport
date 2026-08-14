-- Hand-written migration: full-text search.
--
-- MVP search runs on Postgres. It is fronted by a SearchProvider interface in the
-- API, so moving to Typesense or Meilisearch later replaces one implementation
-- rather than the search UI, the filters or the ranking.
--
-- `french` configuration: stemming matters here — "pilates reformer débutant"
-- should match "cours de pilates pour débutants".

ALTER TABLE "offers"
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('french', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('french', coalesce("description", '')), 'B')
  ) STORED;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "offers_search_gin" ON "offers" USING gin ("search_vector");
--> statement-breakpoint

ALTER TABLE "venues"
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('french', coalesce("name", '')), 'A') ||
    setweight(to_tsvector('french', coalesce("description", '')), 'B')
  ) STORED;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "venues_search_gin" ON "venues" USING gin ("search_vector");
--> statement-breakpoint

-- Trigram index for typo-tolerant venue lookup ("Basicfit" -> "Basic-Fit"), which
-- plain tsvector matching cannot do.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "venues_name_trgm" ON "venues" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "categories_name_trgm" ON "categories" USING gin ("name" gin_trgm_ops);
