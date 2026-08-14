import { boolean, index, pgTable, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import {
  createdAt,
  fkId,
  latitudeColumn,
  longitudeColumn,
  primaryId,
  updatedAt,
} from './columns.js';

/**
 * Geography is a first-class hierarchy from day one. Brussels is seeded as one
 * city among many, never hardcoded: expanding to Antwerp, Amsterdam or Paris is
 * inserting rows, not changing business rules.
 */

export const countries = pgTable(
  'countries',
  {
    id: primaryId(),
    /** ISO 3166-1 alpha-2. */
    code: varchar('code', { length: 2 }).notNull(),
    name: text('name').notNull(),
    defaultCurrency: varchar('default_currency', { length: 3 }).notNull().default('EUR'),
    defaultLocale: varchar('default_locale', { length: 5 }).notNull().default('fr'),
    defaultTimeZone: varchar('default_time_zone', { length: 64 })
      .notNull()
      .default('Europe/Brussels'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('countries_code_key').on(table.code)],
);

export const cities = pgTable(
  'cities',
  {
    id: primaryId(),
    countryId: fkId('country_id')
      .references(() => countries.id, { onDelete: 'restrict' })
      .notNull(),
    slug: varchar('slug', { length: 80 }).notNull(),
    name: text('name').notNull(),
    timeZone: varchar('time_zone', { length: 64 }).notNull().default('Europe/Brussels'),
    /** Centroid: the fallback origin when a user declines location access. */
    latitude: latitudeColumn(),
    longitude: longitudeColumn(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('cities_country_slug_key').on(table.countryId, table.slug),
    index('cities_country_idx').on(table.countryId),
  ],
);

/** Communes in Brussels, arrondissements in Paris, boroughs elsewhere. */
export const districts = pgTable(
  'districts',
  {
    id: primaryId(),
    cityId: fkId('city_id')
      .references(() => cities.id, { onDelete: 'cascade' })
      .notNull(),
    slug: varchar('slug', { length: 80 }).notNull(),
    name: text('name').notNull(),
    latitude: latitudeColumn(),
    longitude: longitudeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('districts_city_slug_key').on(table.cityId, table.slug),
    index('districts_city_idx').on(table.cityId),
  ],
);
