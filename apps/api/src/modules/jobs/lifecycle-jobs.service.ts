import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
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
import { NO_SHOW_MANUAL_CUTOFF_HOURS } from '../bookings/booking.service.js';
import { ReminderService } from '../notifications/reminder.service.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../payments/payment-provider.js';
import { PaymentService } from '../payments/payment.service.js';
import { WebhookDispatcherService } from '../payments/webhook-dispatcher.service.js';

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
    private readonly reminders: ReminderService,
    private readonly dispatcher: WebhookDispatcherService,
    private readonly payments: PaymentService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
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
        await this.cancelDanglingPaymentIntents(expired.map((reservation) => reservation.id));
      }
    });
  }

  /**
   * Best-effort cleanup of the provider side of an expired hold.
   *
   * Not required for correctness — the DB-side release above is what actually
   * frees the seat and hands back the trial — but proactively cancelling the
   * underlying PaymentIntent closes, rather than merely narrows, the window
   * during which a customer could still be mid-payment on a Checkout page
   * whose own expiry deliberately outlives this sweep by design (see
   * `PAYMENT_HOLD_MINUTES` in `booking.service.ts`): a cancelled intent
   * cannot be confirmed, so a `payment_intent.succeeded` arriving after this
   * point becomes structurally impossible rather than merely unlikely. Runs
   * after the sweep's own transaction has committed, for the same reason
   * every other side effect here does: a rollback must never have already
   * cancelled a live payment for a reservation the database still considers
   * PAYMENT_PENDING. A failure per intent (provider outage, an intent
   * already settled by a genuine last-second payment) is logged and
   * otherwise ignored — the reservation is released regardless, and Stripe
   * auto-cancels a Checkout Session's own PaymentIntent at its `expires_at`
   * regardless of whether this call ever reaches it.
   */
  private async cancelDanglingPaymentIntents(reservationIds: string[]): Promise<void> {
    const rows = await this.db
      .select({ providerPaymentIntentId: schema.payments.providerPaymentIntentId })
      .from(schema.payments)
      .where(
        and(
          inArray(schema.payments.reservationId, reservationIds),
          eq(schema.payments.status, 'REQUIRES_PAYMENT'),
        ),
      );

    for (const row of rows) {
      if (!row.providerPaymentIntentId) continue;
      try {
        await this.provider.cancelIntent(row.providerPaymentIntentId);
      } catch (error) {
        this.logger.warn(
          { err: error, providerPaymentIntentId: row.providerPaymentIntentId },
          "echec de l'annulation cote fournisseur d'un PaymentIntent expire (non bloquant)",
        );
      }
    }
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
   *
   * The cutoff (`NO_SHOW_MANUAL_CUTOFF_HOURS`, from `BookingService`) is the
   * same number the manual endpoint (`BookingService.markNoShow`) reads for
   * its own window's upper bound: past that horizon, staff marking someone
   * absent by hand and this sweep marking them absent automatically must
   * agree on exactly when "too late" begins — a single constant, not two
   * literals that could silently drift apart.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'mark-no-shows' })
  async markNoShows(): Promise<void> {
    await this.withLock('jobs:no-shows', async () => {
      const now = this.clock.now();
      const cutoff = new Date(now.getTime() - NO_SHOW_MANUAL_CUTOFF_HOURS * 3_600_000);

      const rows = await this.db
        .update(schema.reservations)
        .set({ status: 'NO_SHOW', updatedAt: now })
        .where(
          and(
            eq(schema.reservations.status, 'CONFIRMED'),
            lt(schema.reservations.slotEndAt, cutoff),
          ),
        )
        .returning({
          id: schema.reservations.id,
          userId: schema.reservations.userId,
          businessId: schema.reservations.businessId,
          venueId: schema.reservations.venueId,
        });

      if (rows.length > 0) {
        await this.db
          .update(schema.trialHistory)
          .set({ status: 'NO_SHOW', updatedAt: now })
          .where(
            // `inArray`, jamais « = ANY(tableau interpolé) » : Drizzle déplie un tableau
            // JS en tuple, que Postgres refuse de caster. Ce job aurait crashé
            // à son premier no-show réel — jamais avant.
            inArray(
              schema.trialHistory.reservationId,
              rows.map((row) => row.id),
            ),
          );

        // Même événement que le geste manuel (`BookingService.markNoShow`) :
        // un consommateur ne doit pas avoir à savoir lequel des deux chemins
        // a détecté l'absence.
        for (const row of rows) {
          this.events.emit('BookingNoShow', {
            reservationId: row.id,
            userId: row.userId,
            businessId: row.businessId,
            venueId: row.venueId,
          });
        }

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

  /**
   * Envoie les rappels avant séance.
   *
   * Toutes les 15 minutes : c'est la précision réelle promise à l'utilisateur
   * (« deux heures avant » signifie entre 1 h 45 et 2 h), et un e-mail de rappel
   * n'a aucun besoin d'être à la minute. Le service ne renvoie jamais deux fois
   * le même rappel, donc rien n'interdirait de le lancer plus souvent — c'est le
   * coût qui n'en vaut pas la peine.
   */
  @Cron('0 */15 * * * *', { name: 'send-session-reminders' })
  async sendSessionReminders(): Promise<void> {
    await this.withLock('jobs:reminders', async () => {
      const sent = await this.reminders.sendDueReminders();
      if (sent > 0) this.logger.info({ count: sent }, 'sent session reminders');
    });
  }

  /**
   * Relances J+1 / J+3 des dossiers d'inscription restés incomplets.
   *
   * Une fois par jour suffit : contrairement aux rappels de séance, la
   * granularité promise est le jour, pas l'heure, et le job ne renvoie
   * jamais deux fois la même relance (`ReminderService.sendDueVenueCompletionReminders`).
   */
  @Cron(CronExpression.EVERY_DAY_AT_9AM, { name: 'venue-submission-reminders' })
  async sendVenueSubmissionReminders(): Promise<void> {
    await this.withLock('jobs:venue-submission-reminders', async () => {
      const sent = await this.reminders.sendDueVenueCompletionReminders();
      if (sent > 0) this.logger.info({ count: sent }, 'sent venue submission reminders');
    });
  }

  /**
   * Rejoue les webhooks dont le traitement a echoue.
   *
   * Le recepteur repond toujours 2xx pour ne pas faire boucler Stripe sur un
   * evenement empoisonne. Le prix est qu'un echec de traitement n'est retente par
   * personne : ce job est la contrepartie. Le rejeu est sur parce que l'ecriture
   * du registre est cle par provider_refund_id et que la projection est
   * recalculee — retraiter un evenement deja partiellement applique converge,
   * il ne double-compte jamais.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'replay-failed-webhooks' })
  async replayFailedWebhooks(): Promise<void> {
    await this.withLock('jobs:replay-webhooks', async () => {
      const rows = await this.db
        .select()
        .from(schema.webhookEvents)
        .where(
          and(
            isNull(schema.webhookEvents.processedAt),
            lt(schema.webhookEvents.attemptCount, 10),
            gt(schema.webhookEvents.createdAt, new Date(this.clock.now().getTime() - 7 * 86_400_000)),
          ),
        )
        .orderBy(schema.webhookEvents.createdAt)
        .limit(100);

      let replayed = 0;
      for (const row of rows) {
        try {
          // La signature a deja ete verifiee a la reception : on reinterprete la
          // charge utile stockee, on ne la re-authentifie pas.
          await this.dispatcher.dispatch(this.provider.interpret(row.payload));
          await this.payments.markWebhookProcessed(row.id);
          replayed += 1;
        } catch (error) {
          await this.payments.markWebhookFailed(
            row.id,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      if (replayed > 0) {
        this.logger.info({ count: replayed, seen: rows.length }, 'replayed failed webhooks');
      }
    });
  }

  /**
   * Controle de derive quotidien entre le registre `refunds` et sa projection
   * sur `payments`. Les deux sont ecrits dans la meme transaction par
   * `RefundLedgerService`, donc un ecart signale un bug, pas un etat transitoire
   * legitime — chaque ligne remontee est un `logger.error`.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'check-refund-ledger-drift' })
  async checkRefundLedgerDrift(): Promise<void> {
    await this.withLock('jobs:refund-ledger-drift', async () => {
      const rows = (await this.db.execute(sql`
        SELECT p.id, p.refunded_amount, p.refunded_platform_fee_amount,
               COALESCE(r.s, 0) AS ledger_amount, COALESCE(r.f, 0) AS ledger_fee
        FROM payments p
        LEFT JOIN (
          SELECT payment_id, SUM(amount) AS s, SUM(platform_fee_amount) AS f
          FROM refunds WHERE status = 'SUCCEEDED' GROUP BY payment_id
        ) r ON r.payment_id = p.id
        WHERE COALESCE(r.s, 0) <> p.refunded_amount
           OR COALESCE(r.f, 0) <> p.refunded_platform_fee_amount
      `)) as unknown as { id: string }[];

      for (const row of rows) {
        this.logger.error({ paymentId: row.id }, 'derive detectee entre le registre refunds et sa projection payments');
      }
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
