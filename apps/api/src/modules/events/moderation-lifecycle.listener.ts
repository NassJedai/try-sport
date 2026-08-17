import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { AppConfig } from '@try/config';
import type { Logger } from '@try/logger';
import { DATABASE } from '../../common/database.module.js';
import { CONFIG } from '../../common/config.module.js';
import { LOGGER } from '../../common/logger.module.js';
import { NotificationService } from '../notifications/notification.service.js';
import { offerCompletionUrl, venueCompletionUrl } from '../notifications/business-links.js';
import { DomainEvents, type DomainEventMap } from './domain-events.js';

/**
 * Libellés FR des huit champs `IDENTITY` (`editable-fields.ts`, côté
 * contracts) — vocabulaire purement interne à cette alerte admin, jamais
 * montré à un gérant, donc pas partagé via `@try/contracts`.
 */
const IDENTITY_FIELD_LABELS_FR: Record<string, string> = {
  name: 'Nom',
  addressLine: 'Adresse',
  postalCode: 'Code postal',
  cityId: 'Ville',
  districtId: 'Commune',
  latitude: 'Latitude',
  longitude: 'Longitude',
  timeZone: 'Fuseau horaire',
};

/** Les deux champs `BusinessIdentityChanged` peut porter — voir `domain-events.ts`. */
const BUSINESS_IDENTITY_FIELD_LABELS_FR: Record<string, string> = {
  legalName: 'Raison sociale',
  vatNumber: 'Numéro de TVA',
};

/**
 * Effets de bord du cycle de modération et de l'édition libre des lieux en
 * ligne.
 *
 * Calqué sur `booking-lifecycle.listener.ts` : tout ici tourne après le
 * commit qui a produit l'événement, hors du chemin critique de la requête
 * qui l'a déclenché.
 */
@Injectable()
export class ModerationLifecycleListener implements OnModuleInit {
  constructor(
    private readonly events: DomainEvents,
    private readonly notifications: NotificationService,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.events.on('VenueModerationDecided', async (payload) => {
      await this.notifyVenueDecision(payload);
    });

    this.events.on('OfferModerationDecided', async (payload) => {
      await this.notifyOfferDecision(payload);
    });

    this.events.on('VenueIdentityChanged', async (payload) => {
      await this.alertAdminOfIdentityChange(payload);
    });

    this.events.on('BusinessIdentityChanged', async (payload) => {
      await this.alertAdminOfBusinessIdentityChange(payload);
    });
  }

  /**
   * Destinataires en application d'une décision de modération : une ligne
   * `notifications` par membre `OWNER`/`MANAGER` ayant accepté son
   * invitation — pas les `STAFF`, qui n'ont pas à arbitrer une décision de
   * modération.
   */
  private async decisionRecipients(
    businessId: string,
  ): Promise<{ userId: string }[]> {
    return this.db
      .select({ userId: schema.businessMembers.userId })
      .from(schema.businessMembers)
      .where(
        and(
          eq(schema.businessMembers.businessId, businessId),
          inArray(schema.businessMembers.role, ['OWNER', 'MANAGER']),
          isNotNull(schema.businessMembers.acceptedAt),
        ),
      );
  }

  private async notifyVenueDecision(
    payload: DomainEventMap['VenueModerationDecided'],
  ): Promise<void> {
    const [venue] = await this.db
      .select({ name: schema.venues.name })
      .from(schema.venues)
      .where(eq(schema.venues.id, payload.venueId))
      .limit(1);
    const [business] = await this.db
      .select({ contactEmail: schema.businesses.contactEmail })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, payload.businessId))
      .limit(1);
    if (!venue || !business) return;

    const correctionUrl = venueCompletionUrl(this.config, payload.venueId);
    const title = this.venueDecisionTitle(payload.decision, venue.name);
    const recipients = await this.decisionRecipients(payload.businessId);

    if (recipients.length > 0) {
      await this.db.insert(schema.notifications).values(
        recipients.map((recipient) => ({
          userId: recipient.userId,
          type: `VENUE_MODERATION_${payload.decision}`,
          title,
          body: payload.reason ?? title,
          deepLink: correctionUrl,
        })),
      );
    }

    await this.notifications.sendVenueModerationDecision({
      email: business.contactEmail,
      venueName: venue.name,
      decision: payload.decision,
      reason: payload.reason,
      correctionUrl,
    });

    this.logger.info(
      { venueId: payload.venueId, decision: payload.decision, recipients: recipients.length },
      'venue moderation decision notified',
    );
  }

  private async notifyOfferDecision(
    payload: DomainEventMap['OfferModerationDecided'],
  ): Promise<void> {
    const [offer] = await this.db
      .select({ title: schema.offers.title })
      .from(schema.offers)
      .where(eq(schema.offers.id, payload.offerId))
      .limit(1);
    const [business] = await this.db
      .select({ contactEmail: schema.businesses.contactEmail })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, payload.businessId))
      .limit(1);
    if (!offer || !business) return;

    const correctionUrl = offerCompletionUrl(this.config, payload.offerId);
    const title = this.offerDecisionTitle(payload.decision, offer.title);
    const recipients = await this.decisionRecipients(payload.businessId);

    if (recipients.length > 0) {
      await this.db.insert(schema.notifications).values(
        recipients.map((recipient) => ({
          userId: recipient.userId,
          type: `OFFER_MODERATION_${payload.decision}`,
          title,
          body: payload.reason ?? title,
          deepLink: correctionUrl,
        })),
      );
    }

    await this.notifications.sendOfferModerationDecision({
      email: business.contactEmail,
      offerTitle: offer.title,
      decision: payload.decision,
      reason: payload.reason,
      correctionUrl,
    });

    this.logger.info(
      { offerId: payload.offerId, decision: payload.decision, recipients: recipients.length },
      'offer moderation decision notified',
    );
  }

  /**
   * Alerte interne, en application seulement — pas d'e-mail : Nassim est le
   * seul destinataire prévu aujourd'hui, et `GET /v1/notifications` (déjà
   * générique par utilisateur) la lui remonte comme n'importe quelle autre
   * notification, dès qu'il est connecté avec un compte `ADMIN`/`SUPER_ADMIN`.
   *
   * L'ancienne et la nouvelle valeur viennent directement de l'événement —
   * `updateVenue` les a déjà en main au moment d'émettre, voir le
   * commentaire sur `VenueIdentityChanged` dans `domain-events.ts`. Pas de
   * requête supplémentaire, pas de table dédiée : `editable-fields.ts` reste
   * la seule source qui dit ce qui est `IDENTITY`.
   */
  private async alertAdminOfIdentityChange(
    payload: DomainEventMap['VenueIdentityChanged'],
  ): Promise<void> {
    const [venue] = await this.db
      .select({ name: schema.venues.name })
      .from(schema.venues)
      .where(eq(schema.venues.id, payload.venueId))
      .limit(1);
    if (!venue) return;

    const changes = payload.changes
      .map((change) => {
        const label = IDENTITY_FIELD_LABELS_FR[change.field] ?? change.field;
        return `${label} : « ${change.oldValue ?? '—'} » → « ${change.newValue ?? '—'} »`;
      })
      .join('\n');

    const admins = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(inArray(schema.users.role, ['ADMIN', 'SUPER_ADMIN']));
    if (admins.length === 0) return;

    await this.db.insert(schema.notifications).values(
      admins.map((admin) => ({
        userId: admin.id,
        type: 'VENUE_IDENTITY_CHANGED',
        title: `Modification de fiche : ${venue.name}`,
        body: changes,
        deepLink: null,
      })),
    );

    this.logger.info(
      { venueId: payload.venueId, admins: admins.length, fields: payload.changes.map((c) => c.field) },
      'venue identity change alerted to admins',
    );
  }

  /**
   * Même raisonnement que `alertAdminOfIdentityChange` ci-dessus, pour un
   * établissement plutôt qu'un lieu : raison sociale et numéro de TVA sont des
   * données contractuelles, `BusinessService.updateBusiness` les a déjà en
   * main au moment d'émettre (voir `BusinessIdentityChanged` dans
   * `domain-events.ts`), donc pas de requête supplémentaire ici pour les deux
   * valeurs.
   */
  private async alertAdminOfBusinessIdentityChange(
    payload: DomainEventMap['BusinessIdentityChanged'],
  ): Promise<void> {
    const [business] = await this.db
      .select({ name: schema.businesses.name })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, payload.businessId))
      .limit(1);
    if (!business) return;

    const changes = payload.changes
      .map((change) => {
        const label = BUSINESS_IDENTITY_FIELD_LABELS_FR[change.field] ?? change.field;
        return `${label} : « ${change.oldValue ?? '—'} » → « ${change.newValue ?? '—'} »`;
      })
      .join('\n');

    const admins = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(inArray(schema.users.role, ['ADMIN', 'SUPER_ADMIN']));
    if (admins.length === 0) return;

    await this.db.insert(schema.notifications).values(
      admins.map((admin) => ({
        userId: admin.id,
        type: 'BUSINESS_IDENTITY_CHANGED',
        title: `Modification de fiche établissement : ${business.name}`,
        body: changes,
        deepLink: null,
      })),
    );

    this.logger.info(
      {
        businessId: payload.businessId,
        admins: admins.length,
        fields: payload.changes.map((c) => c.field),
      },
      'business identity change alerted to admins',
    );
  }

  private venueDecisionTitle(
    decision: DomainEventMap['VenueModerationDecided']['decision'],
    venueName: string,
  ): string {
    switch (decision) {
      case 'APPROVE':
        return `${venueName} est en ligne`;
      case 'REJECT':
        return `${venueName} : dossier à corriger`;
      case 'SUSPEND':
        return `${venueName} a été suspendu`;
      case 'REINSTATE':
        return `${venueName} est de nouveau en ligne`;
    }
  }

  private offerDecisionTitle(
    decision: DomainEventMap['OfferModerationDecided']['decision'],
    offerTitle: string,
  ): string {
    switch (decision) {
      case 'APPROVE':
        return `${offerTitle} est en ligne`;
      case 'REJECT':
        return `${offerTitle} : à corriger`;
      case 'PAUSE':
        return `${offerTitle} a été mise en pause`;
    }
  }
}
