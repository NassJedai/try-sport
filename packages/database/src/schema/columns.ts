import { doublePrecision, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * PostGIS note.
 *
 * `venues.location geography(Point, 4326)` is a STORED GENERATED column derived
 * from latitude/longitude, created in the hand-written migration
 * `0001_postgis.sql`. It is deliberately absent from the drizzle schema because
 * drizzle-kit renders parameterised types as quoted identifiers, which Postgres
 * rejects. Keeping it out means drizzle-kit never tries to manage it, while
 * discovery queries reach it through raw SQL fragments.
 *
 * `geography` rather than `geometry` so ST_DWithin/ST_Distance return real metres
 * over the spheroid instead of degrees.
 */

export const primaryId = () => uuid().primaryKey().defaultRandom();

/**
 * Foreign-key column. Separate from `primaryId` so a reference can never
 * accidentally be declared as a primary key.
 */
export const fkId = (name: string) => uuid(name);

/**
 * All timestamps are `timestamptz` and stored in UTC. `mode: 'date'` hands the
 * application a JS Date so no layer ever sees a naive local time.
 */
export const timestampColumn = (name?: string) =>
  name
    ? timestamp(name, { withTimezone: true, mode: 'date' })
    : timestamp({ withTimezone: true, mode: 'date' });

export const createdAt = () => timestampColumn('created_at').notNull().defaultNow();
export const updatedAt = () => timestampColumn('updated_at').notNull().defaultNow();

/**
 * Soft deletion is applied only where an entity must survive for accounting or
 * moderation history, never as a blanket policy — a `deleted_at` on every table
 * silently turns every query into a potential bug.
 */
export const deletedAt = () => timestampColumn('deleted_at');

export const latitudeColumn = () => doublePrecision('latitude').notNull();
export const longitudeColumn = () => doublePrecision('longitude').notNull();
