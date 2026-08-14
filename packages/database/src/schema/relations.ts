import { relations } from 'drizzle-orm';
import { cities, countries, districts } from './geography.js';
import { profiles, userInterests, users } from './identity.js';
import {
  businesses,
  businessMembers,
  categories,
  offerImages,
  offers,
  venueCategories,
  venueImages,
  venues,
} from './catalog.js';
import { schedules, slots } from './scheduling.js';
import { attributions, checkIns, reservations, trialHistory } from './booking.js';
import { payments, refunds } from './payments.js';
import { favorites, leads, notifications, referrals, reviews } from './engagement.js';

/**
 * Relations power Drizzle's relational queries. They are declared for the joins
 * the product actually performs — declaring every possible edge would invite
 * accidental deep nesting, which is how N+1 queries get written.
 */

export const countriesRelations = relations(countries, ({ many }) => ({
  cities: many(cities),
}));

export const citiesRelations = relations(cities, ({ one, many }) => ({
  country: one(countries, { fields: [cities.countryId], references: [countries.id] }),
  districts: many(districts),
  venues: many(venues),
}));

export const districtsRelations = relations(districts, ({ one, many }) => ({
  city: one(cities, { fields: [districts.cityId], references: [cities.id] }),
  venues: many(venues),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(profiles, { fields: [users.id], references: [profiles.userId] }),
  interests: many(userInterests),
  memberships: many(businessMembers),
  reservations: many(reservations),
  favorites: many(favorites),
  reviews: many(reviews),
}));

export const profilesRelations = relations(profiles, ({ one }) => ({
  user: one(users, { fields: [profiles.userId], references: [users.id] }),
}));

export const userInterestsRelations = relations(userInterests, ({ one }) => ({
  user: one(users, { fields: [userInterests.userId], references: [users.id] }),
  category: one(categories, { fields: [userInterests.categoryId], references: [categories.id] }),
}));

export const businessesRelations = relations(businesses, ({ many }) => ({
  venues: many(venues),
  members: many(businessMembers),
  offers: many(offers),
  leads: many(leads),
}));

export const businessMembersRelations = relations(businessMembers, ({ one }) => ({
  business: one(businesses, { fields: [businessMembers.businessId], references: [businesses.id] }),
  user: one(users, { fields: [businessMembers.userId], references: [users.id] }),
}));

export const venuesRelations = relations(venues, ({ one, many }) => ({
  business: one(businesses, { fields: [venues.businessId], references: [businesses.id] }),
  city: one(cities, { fields: [venues.cityId], references: [cities.id] }),
  district: one(districts, { fields: [venues.districtId], references: [districts.id] }),
  images: many(venueImages),
  categories: many(venueCategories),
  offers: many(offers),
  reviews: many(reviews),
}));

export const venueImagesRelations = relations(venueImages, ({ one }) => ({
  venue: one(venues, { fields: [venueImages.venueId], references: [venues.id] }),
}));

export const venueCategoriesRelations = relations(venueCategories, ({ one }) => ({
  venue: one(venues, { fields: [venueCategories.venueId], references: [venues.id] }),
  category: one(categories, { fields: [venueCategories.categoryId], references: [categories.id] }),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  offers: many(offers),
  venues: many(venueCategories),
}));

export const offersRelations = relations(offers, ({ one, many }) => ({
  venue: one(venues, { fields: [offers.venueId], references: [venues.id] }),
  business: one(businesses, { fields: [offers.businessId], references: [businesses.id] }),
  category: one(categories, { fields: [offers.categoryId], references: [categories.id] }),
  images: many(offerImages),
  slots: many(slots),
  schedules: many(schedules),
}));

export const offerImagesRelations = relations(offerImages, ({ one }) => ({
  offer: one(offers, { fields: [offerImages.offerId], references: [offers.id] }),
}));

export const schedulesRelations = relations(schedules, ({ one, many }) => ({
  offer: one(offers, { fields: [schedules.offerId], references: [offers.id] }),
  venue: one(venues, { fields: [schedules.venueId], references: [venues.id] }),
  slots: many(slots),
}));

export const slotsRelations = relations(slots, ({ one, many }) => ({
  offer: one(offers, { fields: [slots.offerId], references: [offers.id] }),
  venue: one(venues, { fields: [slots.venueId], references: [venues.id] }),
  schedule: one(schedules, { fields: [slots.scheduleId], references: [schedules.id] }),
  reservations: many(reservations),
}));

export const reservationsRelations = relations(reservations, ({ one }) => ({
  user: one(users, { fields: [reservations.userId], references: [users.id] }),
  slot: one(slots, { fields: [reservations.slotId], references: [slots.id] }),
  offer: one(offers, { fields: [reservations.offerId], references: [offers.id] }),
  venue: one(venues, { fields: [reservations.venueId], references: [venues.id] }),
  business: one(businesses, { fields: [reservations.businessId], references: [businesses.id] }),
  payment: one(payments, { fields: [reservations.id], references: [payments.reservationId] }),
  checkIn: one(checkIns, { fields: [reservations.id], references: [checkIns.reservationId] }),
  review: one(reviews, { fields: [reservations.id], references: [reviews.reservationId] }),
  lead: one(leads, { fields: [reservations.id], references: [leads.reservationId] }),
}));

export const checkInsRelations = relations(checkIns, ({ one }) => ({
  reservation: one(reservations, {
    fields: [checkIns.reservationId],
    references: [reservations.id],
  }),
  venue: one(venues, { fields: [checkIns.venueId], references: [venues.id] }),
}));

export const trialHistoryRelations = relations(trialHistory, ({ one }) => ({
  user: one(users, { fields: [trialHistory.userId], references: [users.id] }),
  venue: one(venues, { fields: [trialHistory.venueId], references: [venues.id] }),
  reservation: one(reservations, {
    fields: [trialHistory.reservationId],
    references: [reservations.id],
  }),
}));

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  reservation: one(reservations, {
    fields: [payments.reservationId],
    references: [reservations.id],
  }),
  refunds: many(refunds),
}));

export const refundsRelations = relations(refunds, ({ one }) => ({
  payment: one(payments, { fields: [refunds.paymentId], references: [payments.id] }),
}));

export const favoritesRelations = relations(favorites, ({ one }) => ({
  user: one(users, { fields: [favorites.userId], references: [users.id] }),
  offer: one(offers, { fields: [favorites.offerId], references: [offers.id] }),
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
  user: one(users, { fields: [reviews.userId], references: [users.id] }),
  venue: one(venues, { fields: [reviews.venueId], references: [venues.id] }),
  offer: one(offers, { fields: [reviews.offerId], references: [offers.id] }),
  reservation: one(reservations, {
    fields: [reviews.reservationId],
    references: [reservations.id],
  }),
}));

export const leadsRelations = relations(leads, ({ one }) => ({
  business: one(businesses, { fields: [leads.businessId], references: [businesses.id] }),
  venue: one(venues, { fields: [leads.venueId], references: [venues.id] }),
  user: one(users, { fields: [leads.userId], references: [users.id] }),
  reservation: one(reservations, { fields: [leads.reservationId], references: [reservations.id] }),
}));

export const referralsRelations = relations(referrals, ({ one }) => ({
  referrer: one(users, { fields: [referrals.referrerUserId], references: [users.id] }),
}));

export const attributionsRelations = relations(attributions, ({ one }) => ({
  user: one(users, { fields: [attributions.userId], references: [users.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));
