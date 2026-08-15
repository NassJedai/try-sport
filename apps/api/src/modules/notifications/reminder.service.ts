import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { Clock } from '@try/utils';
import { formatDateInZone, formatTimeInZone } from '@try/utils';
import type { Logger } from '@try/logger';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { LOGGER } from '../../common/logger.module.js';
import { NotificationService } from './notification.service.js';

/**
 * Les deux rappels envoyés avant une séance.
 *
 * Les fenêtres ne se chevauchent pas et couvrent tout : une réservation prise
 * 30 minutes avant le début tombe uniquement dans la fenêtre courte, et ne reçoit
 * donc jamais un « c'est demain » qui serait faux.
 *
 * Le rappel de la veille sert à ce qu'on annule à temps — une place libérée peut
 * encore être reprise. Celui de deux heures sert à ce qu'on vienne. Les deux
 * attaquent le même problème : le no-show, qui est ce qui coûte réellement de
 * l'argent à une salle, puisqu'elle a bloqué une place et un coach pour personne.
 */
const REMINDERS = [
  { type: 'SESSION_REMINDER_24H', fromMinutes: 120, toMinutes: 24 * 60, lead: 'day' },
  { type: 'SESSION_REMINDER_2H', fromMinutes: 0, toMinutes: 120, lead: 'hours' },
] as const;

/** Plafond par tour : un pic de réservations ne doit pas monopoliser la boucle. */
const BATCH_LIMIT = 500;

@Injectable()
export class ReminderService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Envoie les rappels dus, exactement une fois chacun.
   *
   * La fenêtre est délibérément large (« tout ce qui commence dans moins de
   * 24 h ») plutôt qu'étroite (« ce qui commence dans 24 h ± 15 min ») : une
   * fenêtre étroite rate définitivement les rappels si le job saute un tour —
   * redéploiement, base indisponible, machine surchargée. Large + garde
   * d'unicité en base, un tour manqué se rattrape tout seul au suivant.
   */
  async sendDueReminders(): Promise<number> {
    const now = this.clock.now();
    let sent = 0;

    for (const reminder of REMINDERS) {
      const from = new Date(now.getTime() + reminder.fromMinutes * 60_000);
      const to = new Date(now.getTime() + reminder.toMinutes * 60_000);

      const due = await this.db
        .select({
          reservationId: schema.reservations.id,
          userId: schema.reservations.userId,
          email: schema.users.email,
          offerTitle: schema.offers.title,
          venueName: schema.venues.name,
          timeZone: schema.venues.timeZone,
          startAt: schema.reservations.slotStartAt,
        })
        .from(schema.reservations)
        .innerJoin(schema.users, eq(schema.users.id, schema.reservations.userId))
        .innerJoin(schema.offers, eq(schema.offers.id, schema.reservations.offerId))
        .innerJoin(schema.venues, eq(schema.venues.id, schema.reservations.venueId))
        .where(
          and(
            // CONFIRMED seulement : une séance déjà scannée n'a pas besoin d'un
            // rappel, et une annulée encore moins.
            eq(schema.reservations.status, 'CONFIRMED'),
            gte(schema.reservations.slotStartAt, from),
            lt(schema.reservations.slotStartAt, to),
            // Pré-filtre : sans lui, on chargerait à chaque tour toutes les
            // réservations des prochaines 24 h pour n'en insérer aucune. La
            // garantie de non-doublon reste l'index unique, pas ce filtre.
            sql`NOT EXISTS (
              SELECT 1 FROM ${schema.notifications} n
              WHERE n.reservation_id = ${schema.reservations.id}
                AND n.type = ${reminder.type}
            )`,
          ),
        )
        .limit(BATCH_LIMIT);

      for (const row of due) {
        const whenLabel = `${formatDateInZone(row.startAt, row.timeZone)} à ${formatTimeInZone(
          row.startAt,
          row.timeZone,
        )}`;

        // L'ordre compte : on réserve d'abord le droit d'envoyer, on envoie
        // ensuite. Deux instances de l'API font tourner le même cron ; c'est la
        // base qui arbitre, une seule gagne l'insertion et donc une seule envoie.
        // Dans l'ordre inverse, les deux enverraient avant de se rendre compte.
        const [claimed] = await this.db
          .insert(schema.notifications)
          .values({
            userId: row.userId,
            reservationId: row.reservationId,
            type: reminder.type,
            title:
              reminder.lead === 'day'
                ? `Demain : ${row.offerTitle}`
                : `Dans 2 h : ${row.offerTitle}`,
            body: `${row.offerTitle} chez ${row.venueName}, ${whenLabel}.`,
            deepLink: `/booking/${row.reservationId}`,
          })
          .onConflictDoNothing({
            target: [schema.notifications.reservationId, schema.notifications.type],
            // Le prédicat doit être répété : face à un index PARTIEL, Postgres
            // n'infère l'index d'arbitrage que si la clause `WHERE` correspond.
            // Sans elle : « no unique or exclusion constraint matching the
            // ON CONFLICT specification » — donc zéro rappel envoyé, jamais.
            where: sql`reservation_id IS NOT NULL`,
          })
          .returning({ id: schema.notifications.id });

        if (!claimed) continue;

        await this.notifications.sendReminder({
          email: row.email,
          offerTitle: row.offerTitle,
          venueName: row.venueName,
          whenLabel,
          lead: reminder.lead,
        });

        // `sent_at` distingue « affiché dans l'app » de « parti par e-mail ».
        // La ligne existe dès la réservation du droit d'envoi ; sans cette
        // marque, on ne saurait pas dire, en cas d'incident chez le fournisseur
        // d'e-mails, ce qui est réellement parti.
        await this.db
          .update(schema.notifications)
          .set({ sentAt: this.clock.now() })
          .where(eq(schema.notifications.id, claimed.id));

        sent += 1;
      }

      if (due.length === BATCH_LIMIT) {
        this.logger.warn(
          { type: reminder.type, limit: BATCH_LIMIT },
          'reminder batch hit its limit; the remainder goes out on the next tick',
        );
      }
    }

    return sent;
  }
}
