import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import {
  DEFAULT_TIME_ZONE,
  addMinutes,
  applyBasisPoints,
  generateCheckInCode,
  money,
  zonedTimeToUtc,
} from '@try/utils';
import type { CurrencyCode } from '@try/utils';
import { createDatabase } from '../client.js';
import * as schema from '../schema/index.js';
import { BRUSSELS_DISTRICTS, BUSINESSES, CATEGORIES, OFFERS, VENUES } from './seed-data.js';
import { attachMissingMedia, defaultMediaDir } from './seed-media.js';

/**
 * Seeds a development or staging database with a realistic Brussels dataset.
 *
 * Idempotent: it truncates the tables it owns first, so it can be re-run while
 * iterating. It refuses to run against production — a seed script that can wipe
 * live data is a loaded gun.
 */

const DEMO_ACCOUNTS = {
  user: 'user@try.local',
  business: 'business@try.local',
  admin: 'admin@try.local',
} as const;

/** Slots are generated for this many days ahead, matching the availability window. */
const SLOT_HORIZON_DAYS = 21;

function assertNotProduction(): void {
  if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production') {
    throw new Error('Refusing to seed a production database.');
  }
  const url = process.env.DATABASE_URL ?? '';
  if (/\bprod\b|production/i.test(url)) {
    throw new Error(
      `DATABASE_URL looks like a production database (${url.replace(/:[^:@]+@/, ':***@')}). Refusing to seed.`,
    );
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  assertNotProduction();

  const { db, close } = createDatabase({ url, maxConnections: 1 });

  console.log('Clearing existing seed data…');
  // CASCADE handles the dependent rows; RESTART IDENTITY keeps re-runs comparable.
  await db.execute(sql`
    TRUNCATE TABLE
      ${schema.leads}, ${schema.reviews}, ${schema.favorites}, ${schema.referrals},
      ${schema.notifications}, ${schema.checkIns}, ${schema.trialHistory},
      ${schema.refunds}, ${schema.payments}, ${schema.reservations},
      ${schema.slots}, ${schema.schedules}, ${schema.offerImages}, ${schema.offers},
      ${schema.venueImages}, ${schema.venueCategories}, ${schema.venueBlockedDates},
      ${schema.venues}, ${schema.businessMembers}, ${schema.businesses},
      ${schema.userInterests}, ${schema.profiles}, ${schema.authIdentities},
      ${schema.refreshTokens}, ${schema.pushTokens}, ${schema.attributions},
      ${schema.users}, ${schema.categories}, ${schema.districts}, ${schema.cities},
      ${schema.countries}, ${schema.auditLogs}, ${schema.featureFlags}
    RESTART IDENTITY CASCADE
  `);

  console.log('Seeding geography…');
  const [belgium] = await db
    .insert(schema.countries)
    .values({
      code: 'BE',
      name: 'Belgique',
      defaultCurrency: 'EUR',
      defaultLocale: 'fr',
      defaultTimeZone: DEFAULT_TIME_ZONE,
    })
    .returning();
  if (!belgium) throw new Error('Failed to insert country');

  const [brussels] = await db
    .insert(schema.cities)
    .values({
      countryId: belgium.id,
      slug: 'bruxelles',
      name: 'Bruxelles',
      timeZone: DEFAULT_TIME_ZONE,
      latitude: 50.8467,
      longitude: 4.3525,
    })
    .returning();
  if (!brussels) throw new Error('Failed to insert city');

  const districtRows = await db
    .insert(schema.districts)
    .values(
      BRUSSELS_DISTRICTS.map((district) => ({
        cityId: brussels.id,
        slug: district.slug,
        name: district.name,
        latitude: district.lat,
        longitude: district.lon,
      })),
    )
    .returning();
  const districtBySlug = new Map(districtRows.map((row) => [row.slug, row]));

  console.log('Seeding categories…');
  const categoryRows = await db
    .insert(schema.categories)
    .values(
      CATEGORIES.map((category, index) => ({
        slug: category.slug,
        name: category.name,
        icon: category.icon,
        sortOrder: index,
      })),
    )
    .returning();
  const categoryBySlug = new Map(categoryRows.map((row) => [row.slug, row]));

  console.log('Seeding demo accounts…');
  const userRows = await db
    .insert(schema.users)
    .values([
      { email: DEMO_ACCOUNTS.user, role: 'USER', emailVerifiedAt: new Date() },
      { email: DEMO_ACCOUNTS.business, role: 'BUSINESS_MEMBER', emailVerifiedAt: new Date() },
      { email: DEMO_ACCOUNTS.admin, role: 'SUPER_ADMIN', emailVerifiedAt: new Date() },
      // Extra consumers so venues have review history and lead pipelines.
      ...Array.from({ length: 24 }, (_, index) => ({
        email: `member${index + 1}@try.local`,
        role: 'USER' as const,
        emailVerifiedAt: new Date(),
      })),
    ])
    .returning();

  const userByEmail = new Map(userRows.map((row) => [row.email, row]));
  const demoUser = userByEmail.get(DEMO_ACCOUNTS.user);
  const demoBusinessUser = userByEmail.get(DEMO_ACCOUNTS.business);
  const demoAdmin = userByEmail.get(DEMO_ACCOUNTS.admin);
  if (!demoUser || !demoBusinessUser || !demoAdmin) throw new Error('Demo accounts missing');

  const firstNames = [
    'Camille', 'Nadia', 'Louis', 'Sofia', 'Youssef', 'Elena', 'Thomas', 'Inès',
    'Maxime', 'Julie', 'Karim', 'Anna', 'Lucas', 'Manon', 'Hugo', 'Sarah',
    'Noah', 'Léa', 'Adam', 'Chloé', 'Gabriel', 'Emma', 'Nathan', 'Zoé', 'Alex',
  ];

  await db.insert(schema.profiles).values(
    userRows.map((user, index) => ({
      userId: user.id,
      firstName: firstNames[index % firstNames.length] ?? 'Alex',
      locale: 'fr' as const,
      timeZone: DEFAULT_TIME_ZONE,
      lastCityId: brussels.id,
      onboardingCompletedAt: new Date(),
    })),
  );

  // The demo consumer gets interests so the "Pour toi" section has signal.
  const pilates = categoryBySlug.get('pilates');
  const boxing = categoryBySlug.get('boxing');
  const yoga = categoryBySlug.get('yoga');
  if (pilates && boxing && yoga) {
    await db.insert(schema.userInterests).values([
      { userId: demoUser.id, categoryId: pilates.id },
      { userId: demoUser.id, categoryId: boxing.id },
      { userId: demoUser.id, categoryId: yoga.id },
    ]);
  }

  console.log('Seeding businesses and venues…');
  const businessRows = await db
    .insert(schema.businesses)
    .values(
      BUSINESSES.map((business) => ({
        slug: business.slug,
        name: business.name,
        contactEmail: business.email,
        countryCode: 'BE',
        status: 'ACTIVE' as const,
        billingModel: 'COMMISSION' as const,
        commissionBasisPoints: 2500,
        approvedAt: new Date(),
      })),
    )
    .returning();
  const businessBySlug = new Map(businessRows.map((row) => [row.slug, row]));

  // The demo business account owns the first business; staff at the second so
  // permission boundaries can be exercised by hand.
  const primaryBusiness = businessBySlug.get('move-collective');
  const secondaryBusiness = businessBySlug.get('atelier-pulse');
  if (!primaryBusiness || !secondaryBusiness) throw new Error('Seed businesses missing');

  await db.insert(schema.businessMembers).values([
    {
      businessId: primaryBusiness.id,
      userId: demoBusinessUser.id,
      role: 'OWNER',
      acceptedAt: new Date(),
    },
    {
      businessId: secondaryBusiness.id,
      userId: demoBusinessUser.id,
      role: 'STAFF',
      acceptedAt: new Date(),
    },
  ]);

  const venueRows = await db
    .insert(schema.venues)
    .values(
      VENUES.map((venue) => {
        const business = businessBySlug.get(venue.businessSlug);
        const district = districtBySlug.get(venue.district);
        if (!business) throw new Error(`Unknown business ${venue.businessSlug}`);
        return {
          businessId: business.id,
          slug: venue.slug,
          name: venue.name,
          description: venue.description,
          status: 'ACTIVE' as const,
          addressLine: venue.address,
          postalCode: venue.postalCode,
          cityId: brussels.id,
          districtId: district?.id ?? null,
          latitude: venue.lat,
          longitude: venue.lon,
          timeZone: DEFAULT_TIME_ZONE,
          amenities: venue.amenities,
          languages: ['fr', 'en'],
          openingHours: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
            dayOfWeek,
            opensAt: '07:00',
            closesAt: '22:00',
          })),
          approvedAt: new Date(),
        };
      }),
    )
    .returning();
  const venueBySlug = new Map(venueRows.map((row) => [row.slug, row]));

  await db.insert(schema.venueCategories).values(
    VENUES.flatMap((venue) => {
      const venueRow = venueBySlug.get(venue.slug);
      if (!venueRow) return [];
      return venue.categories.flatMap((categorySlug) => {
        const category = categoryBySlug.get(categorySlug);
        return category ? [{ venueId: venueRow.id, categoryId: category.id }] : [];
      });
    }),
  );

  console.log('Seeding offers…');
  const offerRows = await db
    .insert(schema.offers)
    .values(
      OFFERS.map((offer) => {
        const venue = venueBySlug.get(offer.venueSlug);
        const category = categoryBySlug.get(offer.categorySlug);
        if (!venue) throw new Error(`Unknown venue ${offer.venueSlug}`);
        if (!category) throw new Error(`Unknown category ${offer.categorySlug}`);
        return {
          venueId: venue.id,
          businessId: venue.businessId,
          categoryId: category.id,
          title: offer.title,
          description: offer.description,
          status: 'ACTIVE' as const,
          experienceType: offer.experienceType,
          skillLevel: offer.skillLevel,
          priceAmount: offer.price,
          referencePriceAmount: offer.referencePrice,
          currency: 'EUR' as const,
          durationMinutes: offer.durationMinutes,
          capacity: offer.capacity,
          languages: ['fr'],
          whatToBring: offer.whatToBring,
          cancellationPolicy: 'STANDARD' as const,
          trialRule: 'ONE_TRIAL_PER_VENUE' as const,
          // Staggered publish dates so the freshness signal has variance.
          publishedAt: new Date(Date.now() - Math.floor(Math.random() * 60) * 86_400_000),
        };
      }),
    )
    .returning();

  const offerByTitle = new Map(offerRows.map((row) => [row.title, row]));

  console.log('Expanding schedules into slots…');
  const now = new Date();
  const slotValues: (typeof schema.slots.$inferInsert)[] = [];
  const scheduleValues: (typeof schema.schedules.$inferInsert)[] = [];

  for (const offer of OFFERS) {
    const offerRow = offerByTitle.get(offer.title);
    const venue = venueBySlug.get(offer.venueSlug);
    if (!offerRow || !venue) continue;

    scheduleValues.push({
      offerId: offerRow.id,
      venueId: venue.id,
      daysOfWeek: offer.daysOfWeek,
      startTime: offer.times[0] ?? '18:00',
      capacity: offer.capacity,
      validFrom: now.toISOString().slice(0, 10),
      isActive: true,
    });

    for (let dayOffset = 0; dayOffset < SLOT_HORIZON_DAYS; dayOffset += 1) {
      const day = new Date(now.getTime() + dayOffset * 86_400_000);
      if (!offer.daysOfWeek.includes(day.getUTCDay())) continue;

      for (const time of offer.times) {
        const [hour, minute] = time.split(':').map(Number);
        if (hour === undefined || minute === undefined) continue;

        // The venue's wall clock is authoritative; convert to the UTC instant.
        const startAt = zonedTimeToUtc(
          {
            year: day.getUTCFullYear(),
            month: day.getUTCMonth() + 1,
            day: day.getUTCDate(),
            hour,
            minute,
          },
          venue.timeZone,
        );
        if (startAt.getTime() <= now.getTime()) continue;

        slotValues.push({
          offerId: offerRow.id,
          venueId: venue.id,
          startAt,
          endAt: addMinutes(startAt, offer.durationMinutes),
          capacity: offer.capacity,
          // Partial fill so the UI shows both "3 places restantes" and full slots.
          reservedCount: Math.random() < 0.25 ? Math.floor(offer.capacity * 0.7) : 0,
          status: 'OPEN' as const,
        });
      }
    }
  }

  await db.insert(schema.schedules).values(scheduleValues);

  // Chunked: a single INSERT with thousands of rows exceeds the parameter limit.
  const CHUNK = 500;
  for (let index = 0; index < slotValues.length; index += CHUNK) {
    await db.insert(schema.slots).values(slotValues.slice(index, index + CHUNK));
  }
  console.log(`  ${slotValues.length} slots created`);

  console.log('Seeding a demonstrable check-in…');
  /**
   * The one reservation the "check someone in at the door" demo depends on.
   * It has to sit on `business@try.local`'s own venue (Move Collective,
   * Studio Move Ixelles — see `businessMembers` above) so the staff account
   * used in the demo can see and check it in, and its slot has to fall inside
   * the check-in window at the moment the seed runs: [start - 60min, end +
   * 120min], see `CHECKIN_OPENS_MINUTES_BEFORE`/`CHECKIN_CLOSES_MINUTES_AFTER`
   * in `apps/api/src/modules/bookings/booking.service.ts`. Anchored to `now`
   * (already captured above for the slot horizon), not a hardcoded date, so a
   * `pnpm db:seed` produces an immediately demoable booking any day it runs.
   * Starting 20 minutes from now — inside the window without needing to fake
   * a session already in progress — reads naturally as "client arrived a bit
   * early". The consumer is the demo user (`user@try.local`) rather than a
   * random seeded member, so the desk shows Camille's name, not "Invité".
   */
  const demoOffer = offerByTitle.get('Pilates Reformer — Première séance');
  const demoVenue = venueBySlug.get('studio-move-ixelles');
  if (!demoOffer || !demoVenue) throw new Error('Demo check-in offer/venue missing');

  const demoSlotStartAt = new Date(now.getTime() + 20 * 60_000);
  const demoSlotEndAt = addMinutes(demoSlotStartAt, demoOffer.durationMinutes);

  const [demoSlot] = await db
    .insert(schema.slots)
    .values({
      offerId: demoOffer.id,
      venueId: demoVenue.id,
      startAt: demoSlotStartAt,
      endAt: demoSlotEndAt,
      capacity: demoOffer.capacity,
      reservedCount: 1,
      status: 'OPEN',
    })
    .returning();
  if (!demoSlot) throw new Error('Failed to insert demo slot');

  const [demoReservation] = await db
    .insert(schema.reservations)
    .values({
      userId: demoUser.id,
      slotId: demoSlot.id,
      offerId: demoOffer.id,
      venueId: demoVenue.id,
      businessId: demoVenue.businessId,
      status: 'CONFIRMED',
      priceAmount: demoOffer.priceAmount,
      currency: 'EUR',
      trialRule: demoOffer.trialRule,
      slotStartAt: demoSlotStartAt,
      slotEndAt: demoSlotEndAt,
      checkInCode: generateCheckInCode(),
      confirmedAt: now,
    })
    .returning();
  if (!demoReservation) throw new Error('Failed to insert demo reservation');

  // Mirrors what BookingService.create writes in the same transaction as the
  // reservation (apps/api/src/modules/bookings/booking.service.ts:173-181):
  // same scope columns, reservedAt at the moment of booking, status matching
  // the reservation's own status. Without this row the demo booking is
  // invisible to trial eligibility — CheckInService then updates it in place
  // (checkin.service.ts:113-116), exactly like every other reservation here.
  await db.insert(schema.trialHistory).values({
    userId: demoUser.id,
    businessId: demoVenue.businessId,
    venueId: demoVenue.id,
    offerId: demoOffer.id,
    reservationId: demoReservation.id,
    reservedAt: now,
    status: 'CONFIRMED',
    trialRule: demoOffer.trialRule,
  });

  console.log(
    `  demo reservation ${demoReservation.id} — code ${demoReservation.checkInCode}, slot at ${demoSlotStartAt.toISOString()} (check-in window open now)`,
  );

  console.log('Seeding reviews and past bookings…');
  const pastReservations: (typeof schema.reservations.$inferInsert)[] = [];
  const consumers = userRows.filter((user) => user.role === 'USER');

  for (const [index, offerRow] of offerRows.entries()) {
    const venue = venueRows.find((row) => row.id === offerRow.venueId);
    if (!venue) continue;

    const reviewCount = 3 + (index % 9);
    for (let i = 0; i < reviewCount; i += 1) {
      const consumer = consumers[(index * 7 + i * 3) % consumers.length];
      if (!consumer) continue;
      const startAt = new Date(now.getTime() - (i + 1) * 3 * 86_400_000);
      pastReservations.push({
        userId: consumer.id,
        slotId: '', // replaced below
        offerId: offerRow.id,
        venueId: venue.id,
        businessId: venue.businessId,
        status: 'COMPLETED',
        priceAmount: offerRow.priceAmount,
        currency: 'EUR',
        trialRule: offerRow.trialRule,
        slotStartAt: startAt,
        slotEndAt: addMinutes(startAt, offerRow.durationMinutes),
        confirmedAt: startAt,
        checkedInAt: startAt,
        completedAt: addMinutes(startAt, offerRow.durationMinutes),
      });
    }
  }

  // Past reservations need real slots to reference; create them in the past.
  const historicSlots = await db
    .insert(schema.slots)
    .values(
      pastReservations.map((reservation) => ({
        offerId: reservation.offerId,
        venueId: reservation.venueId,
        startAt: reservation.slotStartAt,
        endAt: reservation.slotEndAt,
        capacity: 20,
        reservedCount: 1,
        status: 'CLOSED' as const,
      })),
    )
    .onConflictDoNothing()
    .returning();

  // onConflictDoNothing can drop duplicates (same offer + instant); pair what remains.
  const usableReservations = pastReservations
    .map((reservation, index) => {
      const slot = historicSlots[index];
      return slot ? { ...reservation, slotId: slot.id } : null;
    })
    .filter((value): value is (typeof pastReservations)[number] & { slotId: string } =>
      value !== null,
    );

  const insertedReservations = [];
  for (let index = 0; index < usableReservations.length; index += CHUNK) {
    const chunk = await db
      .insert(schema.reservations)
      .values(usableReservations.slice(index, index + CHUNK))
      .onConflictDoNothing()
      .returning();
    insertedReservations.push(...chunk);
  }

  const reviewComments = [
    'Super accueil, le coach prend le temps d’expliquer. Je reviens.',
    'Très bon premier cours, ambiance détendue et matériel nickel.',
    'Séance intense mais bien encadrée. Parfait pour débuter.',
    'Studio propre et lumineux, petit groupe, on est bien suivi.',
    'Bonne découverte. Le créneau du midi est pratique.',
    null,
    'Coach à l’écoute, exercices adaptés à mon niveau.',
    null,
  ];

  if (insertedReservations.length > 0) {
    const reviewValues = insertedReservations.map((reservation, index) => ({
      reservationId: reservation.id,
      userId: reservation.userId,
      venueId: reservation.venueId,
      offerId: reservation.offerId,
      rating: [5, 4, 5, 5, 4, 3, 5, 4][index % 8] ?? 5,
      comment: reviewComments[index % reviewComments.length] ?? null,
      isPublished: true,
    }));

    for (let index = 0; index < reviewValues.length; index += CHUNK) {
      await db
        .insert(schema.reviews)
        .values(reviewValues.slice(index, index + CHUNK))
        .onConflictDoNothing();
    }

    // Trial history mirrors those completed reservations.
    //
    // onConflictDoNothing() (no target) absorbs violations of ANY unique
    // constraint on the table, including the three partial scope-guard
    // indexes added by migration 0007 — expected here: every offer is seeded
    // with the same ONE_TRIAL_PER_VENUE rule (see OFFERS above), and the
    // consumer-picking formula below can legitimately reuse the same user at
    // the same venue across several offers/reviews. Those extra rows are
    // silently skipped rather than mirrored, same as any other duplicate this
    // insert already tolerated before this migration.
    const trialValues = insertedReservations.map((reservation) => ({
      userId: reservation.userId,
      businessId: reservation.businessId,
      venueId: reservation.venueId,
      offerId: reservation.offerId,
      reservationId: reservation.id,
      reservedAt: reservation.createdAt,
      checkedInAt: reservation.checkedInAt,
      completedAt: reservation.completedAt,
      status: reservation.status,
      trialRule: reservation.trialRule,
    }));
    for (let index = 0; index < trialValues.length; index += CHUNK) {
      await db
        .insert(schema.trialHistory)
        .values(trialValues.slice(index, index + CHUNK))
        .onConflictDoNothing();
    }

    // A lead pipeline for the business dashboard.
    const leadStatuses = ['NEW', 'ATTENDED', 'INTERESTED', 'CONTACTED', 'CONVERTED', 'LOST'] as const;
    const leadValues = insertedReservations.slice(0, 120).map((reservation, index) => {
      const status = leadStatuses[index % leadStatuses.length] ?? 'NEW';
      return {
        businessId: reservation.businessId,
        venueId: reservation.venueId,
        userId: reservation.userId,
        reservationId: reservation.id,
        offerId: reservation.offerId,
        status,
        continuation: (['YES', 'MAYBE', 'NO'] as const)[index % 3] ?? 'MAYBE',
        rating: [5, 4, 5, 3][index % 4] ?? 4,
        visitedAt: reservation.completedAt,
        contactedAt: index % 6 >= 3 ? new Date() : null,
        convertedAt: status === 'CONVERTED' ? new Date() : null,
        attributedRevenueAmount: status === 'CONVERTED' ? 48000 : null,
        currency: 'EUR' as const,
      };
    });
    await db.insert(schema.leads).values(leadValues).onConflictDoNothing();
  }

  console.log('Seeding payments…');
  /**
   * `payments` was truncated above but never repopulated: 271 reservations,
   * zero payments, so the admin console and its revenue aggregates
   * (`moderation.service.ts#overview`, `admin-browse.service.ts#payments`) had
   * nothing to show. This section attaches a payment to every reservation that
   * charged the user something, in every state the product needs to tell apart
   * — see `@try/contracts/payment-capture.ts` for why these five are the ones
   * that matter: SUCCEEDED is the plain case, PARTIALLY_REFUNDED and REFUNDED
   * prove a net commission that differs from the gross (down to a genuine
   * zero), and FAILED/REQUIRES_PAYMENT prove the opposite — a payment that
   * never captured anything, where the right answer is "no commission ever
   * existed", not "zero".
   */
  const businessById = new Map(businessRows.map((row) => [row.id, row]));

  /** Recomputed from the business's own contracted rate — never a literal, exactly
   *  like `PaymentService.createIntentForReservation`. */
  function splitCommission(
    grossAmount: number,
    businessId: string,
    currency: CurrencyCode,
  ): { platformFeeAmount: number; merchantAmount: number } {
    const business = businessById.get(businessId);
    if (!business) throw new Error(`Unknown business ${businessId}`);
    const gross = money(grossAmount, currency);
    const platformFee = applyBasisPoints(gross, business.commissionBasisPoints);
    return { platformFeeAmount: platformFee.amount, merchantAmount: gross.amount - platformFee.amount };
  }

  /** Shaped like a Stripe id (prefix + hex) without claiming a real charge happened. */
  function fakeProviderId(prefix: string): string {
    return `${prefix}_seed_${randomUUID().replace(/-/g, '')}`;
  }

  const PARTIAL_REFUND_COUNT = 4;
  const FULL_REFUND_COUNT = 4;

  // Only reservations that actually charged something get a payment; the
  // FREE_TRIAL offers correctly stay payment-less, exactly like production.
  const paidHistoricReservations = insertedReservations.filter(
    (reservation) => reservation.priceAmount > 0,
  );
  const partiallyRefundedReservations = paidHistoricReservations.slice(0, PARTIAL_REFUND_COUNT);
  const fullyRefundedReservations = paidHistoricReservations.slice(
    PARTIAL_REFUND_COUNT,
    PARTIAL_REFUND_COUNT + FULL_REFUND_COUNT,
  );
  // The demo check-in reservation stays a plain success: flipping it to a
  // refund would break the "check someone in at the door" demo it exists for.
  const succeededReservations = [
    ...(demoReservation.priceAmount > 0 ? [demoReservation] : []),
    ...paidHistoricReservations.slice(PARTIAL_REFUND_COUNT + FULL_REFUND_COUNT),
  ];

  const paymentValues: (typeof schema.payments.$inferInsert)[] = [];
  const refundValues: (typeof schema.refunds.$inferInsert)[] = [];

  for (const reservation of succeededReservations) {
    const currency = reservation.currency as CurrencyCode;
    const { platformFeeAmount, merchantAmount } = splitCommission(
      reservation.priceAmount,
      reservation.businessId,
      currency,
    );
    paymentValues.push({
      reservationId: reservation.id,
      userId: reservation.userId,
      businessId: reservation.businessId,
      status: 'SUCCEEDED',
      provider: 'STRIPE',
      providerPaymentIntentId: fakeProviderId('pi'),
      providerChargeId: fakeProviderId('ch'),
      amount: reservation.priceAmount,
      platformFeeAmount,
      merchantAmount,
      currency,
      succeededAt: reservation.confirmedAt ?? reservation.createdAt,
      createdAt: reservation.createdAt,
    });
  }

  // Varied fractions so the partial-refund examples do not all look identical.
  const REFUND_FRACTIONS = [0.3, 0.45, 0.5, 0.65];
  for (const [index, reservation] of partiallyRefundedReservations.entries()) {
    const currency = reservation.currency as CurrencyCode;
    const { platformFeeAmount, merchantAmount } = splitCommission(
      reservation.priceAmount,
      reservation.businessId,
      currency,
    );
    const fraction = REFUND_FRACTIONS[index % REFUND_FRACTIONS.length] ?? 0.4;
    // Strictly between 0 and the gross: a refund of the full amount belongs to
    // the REFUNDED case below, not to this one.
    const refundedAmount = Math.min(
      reservation.priceAmount - 1,
      Math.max(1, Math.round(reservation.priceAmount * fraction)),
    );
    // Same proportional split, recomputed from the (smaller) refunded amount —
    // never derived by subtracting basis points a second time. Because it reuses
    // the exact rounding `applyBasisPoints` uses on the gross, the split can
    // never exceed what was captured (payments_refund_split_within_capture).
    const refundedSplit = splitCommission(refundedAmount, reservation.businessId, currency);
    const paymentId = randomUUID();
    const succeededAt = reservation.confirmedAt ?? reservation.createdAt;

    paymentValues.push({
      id: paymentId,
      reservationId: reservation.id,
      userId: reservation.userId,
      businessId: reservation.businessId,
      status: 'PARTIALLY_REFUNDED',
      provider: 'STRIPE',
      providerPaymentIntentId: fakeProviderId('pi'),
      providerChargeId: fakeProviderId('ch'),
      amount: reservation.priceAmount,
      platformFeeAmount,
      merchantAmount,
      refundedAmount,
      refundedPlatformFeeAmount: refundedSplit.platformFeeAmount,
      refundedMerchantAmount: refundedSplit.merchantAmount,
      currency,
      succeededAt,
      createdAt: reservation.createdAt,
    });

    refundValues.push({
      paymentId,
      reservationId: reservation.id,
      provider: 'STRIPE',
      providerRefundId: fakeProviderId('re'),
      amount: refundedAmount,
      currency,
      reason: 'requested_by_customer',
      initiatedByUserId: demoAdmin.id,
      status: 'SUCCEEDED',
      platformFeeAmount: refundedSplit.platformFeeAmount,
      merchantAmount: refundedSplit.merchantAmount,
      succeededAt: addMinutes(succeededAt, 2 * 24 * 60),
    });
  }

  for (const reservation of fullyRefundedReservations) {
    const currency = reservation.currency as CurrencyCode;
    const { platformFeeAmount, merchantAmount } = splitCommission(
      reservation.priceAmount,
      reservation.businessId,
      currency,
    );
    const paymentId = randomUUID();
    const succeededAt = reservation.confirmedAt ?? reservation.createdAt;

    paymentValues.push({
      id: paymentId,
      reservationId: reservation.id,
      userId: reservation.userId,
      businessId: reservation.businessId,
      status: 'REFUNDED',
      provider: 'STRIPE',
      providerPaymentIntentId: fakeProviderId('pi'),
      providerChargeId: fakeProviderId('ch'),
      amount: reservation.priceAmount,
      platformFeeAmount,
      merchantAmount,
      // The full gross comes back — net commission is a genuine zero, not the
      // absence of a payment. See netPlatformFee in admin-browse.service.ts.
      refundedAmount: reservation.priceAmount,
      refundedPlatformFeeAmount: platformFeeAmount,
      refundedMerchantAmount: merchantAmount,
      currency,
      succeededAt,
      createdAt: reservation.createdAt,
    });

    refundValues.push({
      paymentId,
      reservationId: reservation.id,
      provider: 'STRIPE',
      providerRefundId: fakeProviderId('re'),
      amount: reservation.priceAmount,
      currency,
      reason: 'requested_by_customer',
      initiatedByUserId: demoAdmin.id,
      status: 'SUCCEEDED',
      platformFeeAmount,
      merchantAmount,
      succeededAt: addMinutes(succeededAt, 2 * 24 * 60),
    });
  }

  // A completed session that gets refunded in full is still a session that
  // happened: COMPLETED -> REFUNDED is a real transition in
  // packages/contracts/src/reservation-state-machine.ts ("Support refunded a
  // completed session"), not a reinterpretation of the booking as if it never
  // occurred. trial_history mirrors the reservation's status here exactly like
  // every other transition already applied in this seed (see the check-in demo
  // above and CheckInService in production).
  if (fullyRefundedReservations.length > 0) {
    const fullyRefundedIds = fullyRefundedReservations.map((reservation) => reservation.id);
    await db
      .update(schema.reservations)
      .set({ status: 'REFUNDED' })
      .where(inArray(schema.reservations.id, fullyRefundedIds));
    await db
      .update(schema.trialHistory)
      .set({ status: 'REFUNDED' })
      .where(inArray(schema.trialHistory.reservationId, fullyRefundedIds));
  }

  /**
   * FAILED and REQUIRES_PAYMENT cannot honestly sit on any of the reservations
   * created so far — every one of them is either the upcoming check-in demo or
   * a past COMPLETED session, and neither is what an abandoned or declined
   * payment looks like. A handful of dedicated PAYMENT_PENDING reservations —
   * the exact status `BookingService.create` gives a paid booking before its
   * PaymentIntent resolves — give these two cases something honest to attach
   * to, future slots well past SLOT_HORIZON_DAYS so they can never collide with
   * a schedule-generated one.
   */
  interface AbandonedCartSpec {
    status: 'FAILED' | 'REQUIRES_PAYMENT';
    failureCode: string | null;
    failureMessage: string | null;
  }
  const ABANDONED_CART_SPECS: AbandonedCartSpec[] = [
    { status: 'FAILED', failureCode: 'card_declined', failureMessage: 'Your card was declined.' },
    {
      status: 'FAILED',
      failureCode: 'insufficient_funds',
      failureMessage: 'Your card has insufficient funds.',
    },
    { status: 'FAILED', failureCode: 'expired_card', failureMessage: 'Your card has expired.' },
    { status: 'FAILED', failureCode: 'do_not_honor', failureMessage: 'Your card was declined.' },
    { status: 'REQUIRES_PAYMENT', failureCode: null, failureMessage: null },
    { status: 'REQUIRES_PAYMENT', failureCode: null, failureMessage: null },
    { status: 'REQUIRES_PAYMENT', failureCode: null, failureMessage: null },
    { status: 'REQUIRES_PAYMENT', failureCode: null, failureMessage: null },
  ];

  const paidOfferRows = offerRows.filter((offer) => offer.priceAmount > 0);
  const abandonedTrialHistoryValues: (typeof schema.trialHistory.$inferInsert)[] = [];

  for (const [index, spec] of ABANDONED_CART_SPECS.entries()) {
    const offerRow = paidOfferRows[index % paidOfferRows.length];
    const venue = venueRows.find((row) => row.id === offerRow?.venueId);
    if (!offerRow || !venue) continue;
    const consumer = consumers[(index * 5 + 3) % consumers.length];
    if (!consumer) continue;

    const dayOffset = SLOT_HORIZON_DAYS + 5 + index;
    const day = new Date(now.getTime() + dayOffset * 86_400_000);
    const startAt = zonedTimeToUtc(
      {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        hour: 18,
        minute: 0,
      },
      venue.timeZone,
    );
    const endAt = addMinutes(startAt, offerRow.durationMinutes);

    const [slot] = await db
      .insert(schema.slots)
      .values({
        offerId: offerRow.id,
        venueId: venue.id,
        startAt,
        endAt,
        capacity: offerRow.capacity,
        reservedCount: 1,
        status: 'OPEN',
      })
      .returning();
    if (!slot) throw new Error('Failed to insert abandoned-cart slot');

    const [reservation] = await db
      .insert(schema.reservations)
      .values({
        userId: consumer.id,
        slotId: slot.id,
        offerId: offerRow.id,
        venueId: venue.id,
        businessId: offerRow.businessId,
        status: 'PAYMENT_PENDING',
        priceAmount: offerRow.priceAmount,
        currency: offerRow.currency,
        trialRule: offerRow.trialRule,
        slotStartAt: startAt,
        slotEndAt: endAt,
      })
      .returning();
    if (!reservation) throw new Error('Failed to insert abandoned-cart reservation');

    abandonedTrialHistoryValues.push({
      userId: consumer.id,
      businessId: offerRow.businessId,
      venueId: venue.id,
      offerId: offerRow.id,
      reservationId: reservation.id,
      reservedAt: reservation.createdAt,
      status: 'PAYMENT_PENDING',
      trialRule: offerRow.trialRule,
    });

    const currency = offerRow.currency as CurrencyCode;
    const { platformFeeAmount, merchantAmount } = splitCommission(
      offerRow.priceAmount,
      offerRow.businessId,
      currency,
    );
    paymentValues.push({
      reservationId: reservation.id,
      userId: consumer.id,
      businessId: offerRow.businessId,
      status: spec.status,
      provider: 'STRIPE',
      providerPaymentIntentId: fakeProviderId('pi'),
      // Only ever set on a captured payment (PaymentService.markSucceeded) —
      // never written when the intent is still pending or was declined.
      providerChargeId: null,
      amount: offerRow.priceAmount,
      platformFeeAmount,
      merchantAmount,
      currency,
      failureCode: spec.failureCode,
      failureMessage: spec.failureMessage,
      succeededAt: null,
      createdAt: reservation.createdAt,
    });
  }

  if (abandonedTrialHistoryValues.length > 0) {
    // onConflictDoNothing(): the consumer/venue picked here can coincide with
    // one already given a consuming trial_history row above (same reasoning
    // as the bulk insert a few lines up) — a scope-guard index violation here
    // must be skipped, not crash the whole seed run over a handful of
    // decorative abandoned-cart rows.
    await db.insert(schema.trialHistory).values(abandonedTrialHistoryValues).onConflictDoNothing();
  }

  for (let index = 0; index < paymentValues.length; index += CHUNK) {
    await db.insert(schema.payments).values(paymentValues.slice(index, index + CHUNK));
  }
  if (refundValues.length > 0) {
    await db.insert(schema.refunds).values(refundValues);
  }
  console.log(
    `  ${paymentValues.length} payments (${succeededReservations.length} succeeded, ` +
      `${partiallyRefundedReservations.length} partially refunded, ${fullyRefundedReservations.length} refunded, ` +
      `${ABANDONED_CART_SPECS.length} failed/abandoned), ${refundValues.length} refund ledger entries`,
  );

  console.log('Recomputing venue rating aggregates…');
  // Denormalised aggregates must match the rows that were just inserted.
  await db.execute(sql`
    UPDATE ${schema.venues} v
    SET average_rating_hundredths = agg.avg_rating,
        review_count = agg.review_count
    FROM (
      SELECT venue_id,
             ROUND(AVG(rating) * 100)::int AS avg_rating,
             COUNT(*)::int AS review_count
      FROM ${schema.reviews}
      WHERE is_published = true
      GROUP BY venue_id
    ) agg
    WHERE v.id = agg.venue_id
  `);

  console.log('Seeding feature flags…');
  await db.insert(schema.featureFlags).values([
    { key: 'referrals', description: 'Try with a friend', isEnabled: false },
    { key: 'stripe_connect', description: 'Merchant payouts via Connect', isEnabled: false },
    { key: 'recommendations_v2', description: 'Personalised ranking v2', isEnabled: false },
    { key: 'waitlist', description: 'Join a waitlist for full slots', isEnabled: false },
    { key: 'last_minute', description: 'Last-minute discounted slots', isEnabled: false },
  ]);

  const [{ count: slotCount } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.slots);

  /**
   * The TRUNCATE above empties offer_images and venue_images along with
   * everything else, but this seed has no photo of its own to put back — that
   * content lives in seed-media.ts. Generating it here, on the connection
   * already open, is what makes a bare `pnpm db:seed` leave a catalogue with
   * pictures instead of a wall of grey placeholders. Idempotent: it only fills
   * offers/venues that have no image, so it never overwrites a manager's real
   * upload when run again later against a non-truncated database.
   */
  console.log('Generating placeholder media…');
  const media = await attachMissingMedia(db, defaultMediaDir());
  console.log(`  ${media.offers} offer images, ${media.venues} venue images`);

  console.log('\nSeed complete:');
  console.log(`  ${districtRows.length} districts, ${categoryRows.length} categories`);
  console.log(`  ${businessRows.length} businesses, ${venueRows.length} venues`);
  console.log(`  ${offerRows.length} offers, ${slotCount} slots`);
  console.log(`  ${insertedReservations.length} historic bookings with reviews`);
  console.log(`  ${paymentValues.length} payments, ${refundValues.length} refund ledger entries`);
  console.log(`  ${media.offers} offer images, ${media.venues} venue images`);
  console.log('\nDemo accounts (dev/staging only, OTP is printed by the API in dev):');
  console.log(`  consumer: ${DEMO_ACCOUNTS.user}`);
  console.log(`  business: ${DEMO_ACCOUNTS.business} (OWNER of Move Collective)`);
  console.log(`  admin:    ${DEMO_ACCOUNTS.admin}`);
  console.log(
    `\nDemo check-in: reservation ${demoReservation.id}, code ${demoReservation.checkInCode}, ` +
      `slot ${demoSlotStartAt.toISOString()} — window is open right now.`,
  );

  await close();
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
