import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, lt, sql } from 'drizzle-orm';
import { schema, tryAcquireLock } from '@try/database';
import type { Database } from '@try/database';
import type { Clock } from '@try/utils';
import type { Logger } from '@try/logger';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { LOGGER } from '../../common/logger.module.js';
import { DomainEvents } from '../events/domain-events.js';
import { IdempotencyService } from '../../common/idempotency/idempotency.service.js';
import { ScheduleService } from '../scheduling/schedule.service.js';

/**
 * Reservation lifecycle jobs.
 *
 * Two states in the machine cannot be reached by a user action, so without these
 * jobs the system quietly rots:
 *
 *   - An unpaid hold occupies a place forever. `hold_expires_at` was written on
 *     every paid booking but nothing ever read it, so a user who abandoned the
 *     payment sheet would permanently consume a seat *and* permanently burn their
 *     trial allowance at that venue.
 *   - A checked-in session never becomes COMPLETED, so `TrialCompleted` never
 *     fires and the venue's conversion funnel stalls at "attended".
 *
 * Every job takes a non-blocking advisory lock first: with more than one API
 * instance running, the same cron fires on all of them, and two sweepers racing
 * over the same rows is how capacity gets double-released.
 */
@Injectable()
export class LifecycleJobsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly events: DomainEvents,
    private readonly idempotency: IdempotencyService,
    private readonly schedules: ScheduleService,
  ) {}

  /**
   * Releases holds whose payment window has passed.
   *
   * Runs every minute: the hold is 15 minutes, so a minute of granularity is
   * imperceptible to the next person trying to book, and the query is a single
   * indexed scan over a partial index.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'expire-payment-holds' })
  async expirePaymentHolds(): Promise<void> {
    await this.withLock('jobs:expire-holds', async () => {
      const now = this.clock.now();

      const expired = await this.db.transaction(async (tx) => {
        const rows = await tx
          .update(schema.reservations)
          .set({ status: 'EXPIRED', updatedAt: now })
          .where(
            and(
              sql`${schema.reservations.status} IN ('PENDING', 'PAYMENT_PENDING')`,
              lt(schema.reservations.holdExpiresAt, now),
            ),
          )
          .returning({
            id: schema.reservations.id,
            slotId: schema.reservations.slotId,
            userId: schema.reservations.userId,
          });

        for (const reservation of rows) {
          // GREATEST guards the CHECK constraint: a double release must not take
          // the whole job down with a constraint violation.
          await tx
            .update(schema.slots)
            .set({
              reservedCount: sql`GREATEST(${schema.slots.reservedCount} - 1, 0)`,
              status: sql`CASE WHEN ${schema.slots.status} = 'FULL' THEN 'OPEN'::slot_status ELSE ${schema.slots.status} END`,
              updatedAt: now,
            })
            .where(eq(schema.slots.id, reservation.slotId));

          // The trial must be handed back too, or an abandoned payment would
          // cost the user their one chance at that venue.
          await tx
            .update(schema.trialHistory)
            .set({ status: 'EXPIRED', updatedAt: now })
            .where(eq(schema.trialHistory.reservationId, reservation.id));
        }

        return rows;
      });

      for (const reservation of expired) {
        this.events.emit('BookingExpired', {
          reservationId: reservation.id,
          userId: reservation.userId,
        });
      }

      if (expired.length > 0) {
        this.logger.info({ count: expired.length }, 'released expired payment holds');
      }
    });
  }

  /**
   * Completes sessions that have finished.
   *
   * A grace period after the end time avoids racing a late check-in, and this is
   * what emits `TrialCompleted` — the signal the business dashboard's conversion
   * funnel is built on.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'complete-sessions' })
  async completeAttendedSessions(): Promise<void> {
    await this.withLock('jobs:complete-sessions', async () => {
      const now = this.clock.now();
      const cutoff = new Date(now.getTime() - 30 * 60_000);

      const completed = await this.db.transaction(async (tx) => {
        const rows = await tx
          .update(schema.reservations)
          .set({ status: 'COMPLETED', completedAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.reservations.status, 'CHECKED_IN'),
              lt(schema.reservations.slotEndAt, cutoff),
            ),
          )
          .returning({
            id: schema.reservations.id,
            userId: schema.reservations.userId,
            businessId: schema.reservations.businessId,
            venueId: schema.reservations.venueId,
          });

        for (const reservation of rows) {
          await tx
            .update(schema.trialHistory)
            .set({ status: 'COMPLETED', completedAt: now, updatedAt: now })
            .where(eq(schema.trialHistory.reservationId, reservation.id));
        }

        return rows;
      });

      for (const reservation of completed) {
        this.events.emit('TrialCompleted', {
          reservationId: reservation.id,
          userId: reservation.userId,
          businessId: reservation.businessId,
          venueId: reservation.venueId,
        });
      }

      if (completed.length > 0) {
        this.logger.info({ count: completed.length }, 'completed attended sessions');
      }
    });
  }

  /**
   * Marks confirmed bookings that never checked in as no-shows.
   *
   * Waits well past the end of the session: a venue that forgets to scan should
   * have time to do it manually, and wrongly recording a no-show costs the user
   * their trial allowance.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'mark-no-shows' })
  async markNoShows(): Promise<void> {
    await this.withLock('jobs:no-shows', async () => {
      const now = this.clock.now();
      const cutoff = new Date(now.getTime() - 4 * 3_600_000);

      const rows = await this.db
        .update(schema.reservations)
        .set({ status: 'NO_SHOW', updatedAt: now })
        .where(
          and(
            eq(schema.reservations.status, 'CONFIRMED'),
            lt(schema.reservations.slotEndAt, cutoff),
          ),
        )
        .returning({ id: schema.reservations.id });

      if (rows.length > 0) {
        await this.db
          .update(schema.trialHistory)
          .set({ status: 'NO_SHOW', updatedAt: now })
          .where(
            sql`${schema.trialHistory.reservationId} = ANY(${rows.map((row) => row.id)}::uuid[])`,
          );

        this.logger.info({ count: rows.length }, 'marked no-shows');
      }
    });
  }

  /**
   * Rolls the booking horizon forward.
   *
   * Without this, availability shrinks by a day every day until venues silently
   * run out of slots — a failure that looks like "demand dropped" rather than
   * like a bug.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'expand-schedules' })
  async expandSchedules(): Promise<void> {
    await this.withLock('jobs:expand-schedules', async () => {
      await this.schedules.expandDueSchedules();
    });
  }

  /** Keeps the idempotency table from growing without bound. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'purge-idempotency-keys' })
  async purgeIdempotencyKeys(): Promise<void> {
    await this.withLock('jobs:purge-idempotency', async () => {
      const purged = await this.idempotency.purgeExpired();
      if (purged > 0) this.logger.info({ count: purged }, 'purged expired idempotency keys');
    });
  }

  /**
   * Runs `work` only if this instance wins the lock; otherwise returns quietly.
   * The lock is transaction-scoped, so a crashed worker releases it automatically.
   */
  private async withLock(key: string, work: () => Promise<void>): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        if (!(await tryAcquireLock(tx, key))) return;
        await work();
      });
    } catch (error) {
      // A failing job must never take the process down; the next tick retries.
      this.logger.error({ err: error, job: key }, 'scheduled job failed');
    }
  }
}
