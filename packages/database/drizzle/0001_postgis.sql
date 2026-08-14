-- Hand-written migration: PostGIS geolocation for venues.
--
-- Kept out of the drizzle-kit schema on purpose. drizzle-kit renders a
-- parameterised type as a quoted identifier ("geography(Point, 4326)"), which
-- Postgres rejects, so the geospatial column and its index are managed here.
-- drizzle-kit builds its snapshot from the TypeScript schema rather than by
-- introspecting the database, so it will neither see nor drop this column.

CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint

-- Derived from latitude/longitude rather than written by the application: a
-- generated column cannot drift from the coordinates it is built from, and there
-- is no trigger to forget. `geography` (not `geometry`) so ST_DWithin and
-- ST_Distance work in metres over the spheroid.
ALTER TABLE "venues"
  ADD COLUMN IF NOT EXISTS "location" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED;
--> statement-breakpoint

-- The index behind "what can I try near me". Without it, every discovery query
-- is a sequential scan over every venue in the country.
CREATE INDEX IF NOT EXISTS "venues_location_gix" ON "venues" USING gist ("location");
--> statement-breakpoint

-- Cities carry a centroid used as the search origin when a user declines
-- location access, so the same nearby query serves both cases.
ALTER TABLE "cities"
  ADD COLUMN IF NOT EXISTS "location" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "cities_location_gix" ON "cities" USING gist ("location");
--> statement-breakpoint

ALTER TABLE "districts"
  ADD COLUMN IF NOT EXISTS "location" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "districts_location_gix" ON "districts" USING gist ("location");
