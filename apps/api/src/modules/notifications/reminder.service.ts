import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { Clock } from '@try/utils';
import { formatDateInZone, formatTimeInZone } from '@try/utils';
import type { AppConfig } from '@try/config';
import type { Logger } from '@try/logger';
import {
  missingVenueSubmissionRequirements,
  VENUE_SUBMISSION_REQUIREMENT_ACTIONS_FR,
} from '@try/contracts';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { CONFIG } from '../../common/config.module.js';
import { LOGGER } from '../../common/logger.module.js';
import { buildTitle, NotificationService } from './notification.service.js';
import { venueCompletionUrl } from './business-links.js';

/**
 * Les deux rappels envoyés avant une séance.
 *
 * Les fenêtres ne se chevauchent pas et couvrent tout : une réservation prise
 * 30 minutes avant le début tombe uniquement dans la fenêtre courte.
 *
 * Attention au piège du libellé : la fenêtre longue commence deux heures avant
 * la séance, pas à minuit, donc elle attrape aussi des séances du jour même.
 * « Demain » y serait faux une fois sur deux — le titre se décide sur le
 * calendrier du lieu, jamais sur le nom de la fenêtre.
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

/**
 * Les deux relances de dossier incomplet.
 *
 * Ancrées sur `venues.createdAt`, pas sur le dernier refus : un dossier créé
 * il y a des mois et redevenu incomplet après un refus tardif ne reçoit donc
 * pas de troisième cycle automatique — il reste néanmoins visible en
 * permanence dans la vue admin des dossiers incomplets
 * (`AdminBrowseService.incompleteVenues`), qui n'a pas cette limite de
 * fenêtre. Les deux relances couvrent l'onboarding initial ; au-delà, le
 * suivi redevient manuel plutôt que de multiplier les rappels automatiques.
 *
 * Fenêtre large (24h de marge), même raison que `REMINDERS` plus haut : un
 * tour manqué — redéploiement, base indisponible — se rattrape tout seul au
 * suivant, la garde d'unicité empêchant tout doublon.
 */
const VENUE_SUBMISSION_REMINDERS = [
  { milestone: 'J1', fromDays: 1, toDays: 2 },
  { milestone: 'J3', fromDays: 3, toDays: 4 },
] as const;

@Injectable()
export class ReminderService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CONFIG) private readonly config: AppConfig,
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
        const dayLabel = formatDateInZone(row.startAt, row.timeZone);
        const whenLabel = `${dayLabel} à ${formatTimeInZone(row.startAt, row.timeZone)}`;

        // « Demain » est faux pour une séance à 20 h alors qu'il est 17 h : la
        // fenêtre longue commence à deux heures du début, pas à minuit. Le jour
        // se juge sur le calendrier du LIEU — c'est là que la personne doit se
        // présenter, et un lieu peut être dans un autre fuseau que le serveur.
        const isToday = dayLabel === formatDateInZone(now, row.timeZone);

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
            title: buildTitle(reminder.lead, isToday, row.offerTitle),
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
          isToday,
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

  /**
   * Relances J+1 / J+3 des dossiers d'inscription restés incomplets.
   *
   * Même patron que `sendDueReminders` : on réserve d'abord le droit
   * d'envoyer (`INSERT ... ON CONFLICT DO NOTHING` sur `(venue_id, type)`),
   * on n'envoie qu'ensuite. Un dossier complété entre-temps ne reçoit rien —
   * la complétude est revérifiée à l'instant de l'envoi, jamais supposée
   * depuis la fenêtre.
   *
   * Un seul destinataire par lieu : le premier `OWNER` accepté, sinon le
   * premier `MANAGER` accepté, ordre stable par date d'acceptation — pas de
   * fan-out à tous les membres ici, à la différence d'une décision de
   * modération, parce qu'il s'agit d'une simple relance périodique, pas d'un
   * événement qui engage l'établissement.
   */
  async sendDueVenueCompletionReminders(): Promise<number> {
    const now = this.clock.now();
    let sent = 0;

    for (const reminder of VENUE_SUBMISSION_REMINDERS) {
      const type = `VENUE_SUBMISSION_REMINDER_${reminder.milestone}`;
      const from = new Date(now.getTime() - reminder.toDays * 86_400_000);
      const to = new Date(now.getTime() - reminder.fromDays * 86_400_000);

      const due = await this.db
        .select({
          venueId: schema.venues.id,
          venueName: schema.venues.name,
          description: schema.venues.description,
          businessId: schema.businesses.id,
          contactEmail: schema.businesses.contactEmail,
          vatNumber: schema.businesses.vatNumber,
        })
        .from(schema.venues)
        .innerJoin(schema.businesses, eq(schema.businesses.id, schema.venues.businessId))
        .where(
          and(
            isNull(schema.venues.deletedAt),
            // DRAFT/REJECTED seulement : un lieu PENDING_APPROVAL ou déjà en
            // ligne a nécessairement passé la porte de complétude à la
            // soumission — relancer ces salles-là serait un rappel sans objet.
            sql`${schema.venues.status} IN ('DRAFT', 'REJECTED')`,
            gte(schema.venues.createdAt, from),
            lt(schema.venues.createdAt, to),
            // Pré-filtre, comme pour les rappels de séance : la garantie de
            // non-doublon reste l'index unique, pas ce filtre.
            sql`NOT EXISTS (
              SELECT 1 FROM ${schema.notifications} n
              WHERE n.venue_id = ${schema.venues.id}
                AND n.type = ${type}
            )`,
          ),
        )
        .limit(BATCH_LIMIT);

      if (due.length === 0) continue;

      const venueIds = due.map((row) => row.venueId);
      const businessIds = [...new Set(due.map((row) => row.businessId))];

      const [offerCounts, imageCounts, members] = await Promise.all([
        this.db
          .select({ venueId: schema.offers.venueId, count: sql<number>`COUNT(*)::int` })
          .from(schema.offers)
          .where(inArray(schema.offers.venueId, venueIds))
          .groupBy(schema.offers.venueId),
        this.db
          .select({ venueId: schema.venueImages.venueId, count: sql<number>`COUNT(*)::int` })
          .from(schema.venueImages)
          .where(inArray(schema.venueImages.venueId, venueIds))
          .groupBy(schema.venueImages.venueId),
        this.db
          .select({
            businessId: schema.businessMembers.businessId,
            userId: schema.businessMembers.userId,
            role: schema.businessMembers.role,
            acceptedAt: schema.businessMembers.acceptedAt,
          })
          .from(schema.businessMembers)
          .where(
            and(
              inArray(schema.businessMembers.businessId, businessIds),
              inArray(schema.businessMembers.role, ['OWNER', 'MANAGER']),
              isNotNull(schema.businessMembers.acceptedAt),
            ),
          ),
      ]);

      const offerCountByVenue = new Map(offerCounts.map((row) => [row.venueId, row.count]));
      const imageCountByVenue = new Map(imageCounts.map((row) => [row.venueId, row.count]));

      const representativeByBusiness = new Map<string, string>();
      for (const member of [...members].sort((a, b) => {
        const rank = (role: string): number => (role === 'OWNER' ? 0 : 1);
        const rankDiff = rank(a.role) - rank(b.role);
        if (rankDiff !== 0) return rankDiff;
        return (a.acceptedAt?.getTime() ?? 0) - (b.acceptedAt?.getTime() ?? 0);
      })) {
        if (!representativeByBusiness.has(member.businessId)) {
          representativeByBusiness.set(member.businessId, member.userId);
        }
      }

      for (const row of due) {
        const missing = missingVenueSubmissionRequirements({
          offerCount: offerCountByVenue.get(row.venueId) ?? 0,
          imageCount: imageCountByVenue.get(row.venueId) ?? 0,
          description: row.description,
          vatNumber: row.vatNumber,
        });
        // Complété entre-temps : rien à relancer, et la fenêtre ne se
        // représentera pas — ce dossier ne recevra plus ce palier.
        if (missing.length === 0) continue;

        const representativeUserId = representativeByBusiness.get(row.businessId);
        if (!representativeUserId) {
          this.logger.warn(
            { venueId: row.venueId, businessId: row.businessId },
            'aucun OWNER/MANAGER accepté pour relancer ce lieu',
          );
          continue;
        }

        const completionUrl = venueCompletionUrl(this.config, row.venueId);
        const missingActions = missing.map(
          (requirement) => VENUE_SUBMISSION_REQUIREMENT_ACTIONS_FR[requirement],
        );

        // Même ordre que `sendDueReminders` : on réserve, on n'envoie que si
        // la réservation a réellement créé la ligne.
        const [claimed] = await this.db
          .insert(schema.notifications)
          .values({
            userId: representativeUserId,
            venueId: row.venueId,
            type,
            title: `Il manque encore quelque chose à « ${row.venueName} »`,
            body: missingActions.join(' '),
            deepLink: completionUrl,
          })
          .onConflictDoNothing({
            target: [schema.notifications.venueId, schema.notifications.type],
            // Répété comme pour `notifications_reservation_type_key` : sans
            // ce prédicat, Postgres ne retrouve pas l'index PARTIEL et
            // refuse la clause ON CONFLICT.
            where: sql`venue_id IS NOT NULL`,
          })
          .returning({ id: schema.notifications.id });

        if (!claimed) continue;

        await this.notifications.sendVenueSubmissionReminder({
          email: row.contactEmail,
          venueName: row.venueName,
          milestone: reminder.milestone,
          missingActions,
          completionUrl,
        });

        await this.db
          .update(schema.notifications)
          .set({ sentAt: this.clock.now() })
          .where(eq(schema.notifications.id, claimed.id));

        sent += 1;
      }

      if (due.length === BATCH_LIMIT) {
        this.logger.warn(
          { type, limit: BATCH_LIMIT },
          'venue submission reminder batch hit its limit; the remainder goes out on the next tick',
        );
      }
    }

    return sent;
  }
}
