import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { formatDateInZone, formatTimeInZone } from '@try/utils';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { Logger } from '@try/logger';
import { DATABASE } from '../../common/database.module.js';
import { LOGGER } from '../../common/logger.module.js';
import { NotificationService } from '../notifications/notification.service.js';
import { DomainEvents } from './domain-events.js';

/**
 * Side effects of the booking lifecycle.
 *
 * Everything here happens *after* the transaction has committed and outside the
 * request's critical path: the user gets their 200 as soon as the booking is
 * durable, and a mail outage cannot undo a confirmed booking.
 */
@Injectable()
export class BookingLifecycleListener implements OnModuleInit {
  constructor(
    private readonly events: DomainEvents,
    private readonly notifications: NotificationService,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.events.on('BookingConfirmed', async (payload) => {
      await this.sendConfirmation(payload.reservationId);
    });

    this.events.on('CheckInCompleted', (payload) => {
      this.logger.info(
        { reservationId: payload.reservationId, venueId: payload.venueId },
        'check-in completed',
      );
    });

    this.events.on('BookingCancelled', (payload) => {
      this.logger.info(
        { reservationId: payload.reservationId, refunded: payload.refunded },
        'booking cancelled',
      );
    });
  }

  private async sendConfirmation(reservationId: string): Promise<void> {
    const [row] = await this.db
      .select({
        email: schema.users.email,
        firstName: schema.profiles.firstName,
        offerTitle: schema.offers.title,
        venueName: schema.venues.name,
        timeZone: schema.venues.timeZone,
        startAt: schema.reservations.slotStartAt,
        checkInCode: schema.reservations.checkInCode,
      })
      .from(schema.reservations)
      .innerJoin(schema.users, eq(schema.users.id, schema.reservations.userId))
      .innerJoin(schema.offers, eq(schema.offers.id, schema.reservations.offerId))
      .innerJoin(schema.venues, eq(schema.venues.id, schema.reservations.venueId))
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.reservations.userId))
      .where(eq(schema.reservations.id, reservationId))
      .limit(1);

    /**
     * A missing row here used to be a bare `return`. When emitters still
     * fired from inside their transaction, this read was issued before the
     * COMMIT and found nothing, and the confirmation email vanished with no
     * error and no log. The emitters are fixed (see the "Emit after COMMIT"
     * section of `domain-events.ts`), but the failure must never be silent
     * again — a booking that reaches this point and cannot be read back is a
     * real anomaly worth an alert.
     */
    if (!row) {
      this.logger.error(
        { reservationId },
        'confirmation email dropped: reservation not readable after BookingConfirmed',
      );
      return;
    }

    await this.notifications.sendBookingConfirmation({
      email: row.email,
      firstName: row.firstName,
      offerTitle: row.offerTitle,
      venueName: row.venueName,
      // Rendered in the venue's timezone: the user needs to know when to turn up
      // at that door, not what the server's clock says.
      whenLabel: `${formatDateInZone(row.startAt, row.timeZone)} à ${formatTimeInZone(
        row.startAt,
        row.timeZone,
      )}`,
      checkInCode: row.checkInCode ?? '',
    });
  }
}
