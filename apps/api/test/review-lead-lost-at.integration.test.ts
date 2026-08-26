import { afterAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@try/database';
import { SystemClock } from '@try/utils';
import { ReviewService } from '../src/modules/reviews/review.service.js';
import { DomainEvents } from '../src/modules/events/domain-events.js';
import { connect, createTestUser, describeIfDatabase, seedBookableSlot } from './integration-setup.js';

/**
 * `lostAt: nextStatus === 'LOST' && lead.status !== 'LOST' ? now : null` wrote
 * `null` unconditionally on every branch except "just became LOST". LOST is
 * operator-owned (`leadStatusAfterContinuation` returns the current status
 * unchanged once a lead is LOST — see lead-pipeline.ts), so a lead a business
 * had already marked LOST from the dashboard (`BusinessService.updateLead`,
 * which sets `lostAt`) recomputed `nextStatus === 'LOST'` again on review
 * submission — and this wiped the loss date back to null even though status
 * never moved. `business.service.ts:597` writes the same field correctly
 * (`input.dto.status === 'LOST' ? now : existing.lostAt`); this was the one
 * place that didn't. Fixed 2026-08-26.
 */
describeIfDatabase('avis — préserve la date de perte du prospect', () => {
  const ctx = connect();

  afterAll(async () => {
    await ctx.close();
  });

  it(
    "un prospect déjà LOST le reste avec sa date de perte d'origine, même après un avis",
    async () => {
      const seed = await seedBookableSlot(ctx.db, { capacity: 5, priceAmount: 0 });
      const user = await createTestUser(ctx.db);
      const service = new ReviewService(ctx.db, new SystemClock(), new DomainEvents({
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
        fatal: () => undefined,
        trace: () => undefined,
        child(): unknown {
          return this;
        },
      } as never));

      const [reservation] = await ctx.db
        .insert(schema.reservations)
        .values({
          userId: user.id,
          slotId: seed.slotId,
          offerId: seed.offerId,
          venueId: seed.venueId,
          businessId: seed.businessId,
          status: 'CHECKED_IN',
          priceAmount: 0,
          trialRule: 'NO_RESTRICTION',
          slotStartAt: new Date(Date.now() - 3_600_000),
          slotEndAt: new Date(Date.now() - 1_800_000),
          confirmedAt: new Date(Date.now() - 7_200_000),
          checkedInAt: new Date(Date.now() - 1_900_000),
        })
        .returning({ id: schema.reservations.id });
      if (!reservation) throw new Error('reservation insert failed');

      // The date a manager already marked this prospect lost from the
      // dashboard — well before this review is submitted.
      const originalLostAt = new Date(Date.now() - 5 * 86_400_000);
      const [lead] = await ctx.db
        .insert(schema.leads)
        .values({
          businessId: seed.businessId,
          venueId: seed.venueId,
          userId: user.id,
          reservationId: reservation.id,
          offerId: seed.offerId,
          status: 'LOST',
          lostAt: originalLostAt,
        })
        .returning({ id: schema.leads.id });
      if (!lead) throw new Error('lead insert failed');

      try {
        await service.submit({
          userId: user.id,
          reservationId: reservation.id,
          dto: { rating: 4, continuation: 'YES', shareWithVenue: true },
        });

        const [updatedLead] = await ctx.db
          .select({ status: schema.leads.status, lostAt: schema.leads.lostAt })
          .from(schema.leads)
          .where(eq(schema.leads.id, lead.id));

        expect(updatedLead?.status).toBe('LOST');
        // The bug wrote `null` here.
        expect(updatedLead?.lostAt).not.toBeNull();
        expect(updatedLead?.lostAt?.getTime()).toBe(originalLostAt.getTime());
      } finally {
        await ctx.db.execute(sql`DELETE FROM leads WHERE id = ${lead.id}`);
        await ctx.db.execute(sql`DELETE FROM reviews WHERE reservation_id = ${reservation.id}`);
        await ctx.db.execute(sql`DELETE FROM trial_history WHERE reservation_id = ${reservation.id}`);
        await ctx.db.execute(sql`DELETE FROM reservations WHERE id = ${reservation.id}`);
        await seed.cleanup();
        await ctx.db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
      }
    },
  );
});
