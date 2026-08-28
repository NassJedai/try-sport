import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { AppConfig } from '@try/config';
import type { Logger } from '@try/logger';
import { EXPERIENCE_TYPE_LABELS_FR, offerFieldLabelFr } from '@try/contracts';
import type { ExperienceType, TrialRule } from '@try/contracts';
import { formatMoney, money } from '@try/utils';
import type { CurrencyCode } from '@try/utils';
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
 * `TrialRule` en clair — même wording que `TRIAL_RULE_OPTIONS` côté
 * `apps/business` (`lib/onboarding/constants.ts`), adapté à la troisième
 * personne puisque ce texte parle d'une salle à un admin, pas au gérant qui la
 * possède. Pas partagé via `@try/contracts` : ce fichier n'a pas de
 * classification `FieldClass` pour un vocabulaire d'alerte interne.
 *
 * Typé `Record<TrialRule, string>`, pas `Record<string, string>` — même motif
 * qu'`EXPERIENCE_TYPE_LABELS_FR` juste au-dessus : exhaustif par construction,
 * une valeur ajoutée un jour à `TRIAL_RULES` (`@try/contracts`) fait échouer
 * la compilation ici plutôt que de laisser l'admin lire un identifiant brut.
 */
const TRIAL_RULE_LABELS_FR: Record<TrialRule, string> = {
  ONE_TRIAL_PER_VENUE: 'Un essai par salle',
  ONE_TRIAL_PER_BUSINESS: 'Un seul essai, dans toutes ses salles',
  ONE_TRIAL_PER_OFFER: 'Un essai par offre',
  NO_RESTRICTION: 'Pas de limite',
};

/** Les deux champs d'une offre exprimés en unités mineures entières — jamais affichés bruts. */
const OFFER_MONEY_FIELDS = new Set(['priceAmount', 'referencePriceAmount']);

/**
 * Rend une valeur avant/après lisible pour l'alerte admin, sans jamais diviser
 * un montant par 100 à la main : `priceAmount`/`referencePriceAmount` passent
 * par `money`/`formatMoney` de `@try/utils` avec la devise réelle de l'offre,
 * `trialRule` par son libellé FR, `experienceType` par
 * `EXPERIENCE_TYPE_LABELS_FR` (`@try/contracts` — même vocabulaire que
 * `offerFieldLabelFr`, exhaustif par construction), `categoryId` par le nom
 * de la catégorie via `categoryNames` (chargé une fois par l'appelant, voir
 * `alertAdminOfOfferModeratedFieldsChange`), tout le reste tel quel.
 *
 * `categoryNames` peut ne pas connaître un id — catégorie supprimée entre
 * temps, cas qu'aucune contrainte n'empêche aujourd'hui : on retombe alors
 * sur l'UUID brut plutôt que de faire échouer toute l'alerte pour une seule
 * valeur illisible.
 */
function formatOfferFieldValue(
  field: string,
  value: unknown,
  currency: CurrencyCode,
  categoryNames: ReadonlyMap<string, string>,
): string {
  if (value === null || value === undefined) return '—';
  if (OFFER_MONEY_FIELDS.has(field)) {
    return formatMoney(money(value as number, currency));
  }
  if (field === 'trialRule') {
    return TRIAL_RULE_LABELS_FR[value as TrialRule] ?? String(value);
  }
  if (field === 'experienceType') {
    return EXPERIENCE_TYPE_LABELS_FR[value as ExperienceType] ?? String(value);
  }
  if (field === 'categoryId') {
    return categoryNames.get(value as string) ?? String(value);
  }
  return String(value);
}

/**
 * Effets de bord du cycle de modération et de l'édition libre des lieux et
 * des offres en ligne.
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

    this.events.on('OfferModeratedFieldsChanged', async (payload) => {
      await this.alertAdminOfOfferModeratedFieldsChange(payload);
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
    if (admins.length === 0) {
      // Même raisonnement que `alertAdminOfOfferModeratedFieldsChange` plus
      // bas : un changement d'identité déjà écrit que personne ne voit passer
      // est une lacune opérationnelle, pas un cas silencieux.
      this.logger.warn(
        { venueId: payload.venueId, fields: payload.changes.map((c) => c.field) },
        'venue identity changed but no admin exists to notify',
      );
      return;
    }

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
    if (admins.length === 0) {
      // Même raisonnement que les deux autres alertes de ce fichier : un
      // changement contractuel déjà écrit que personne ne voit passer est une
      // lacune opérationnelle à détecter, pas un cas normal à ignorer.
      this.logger.warn(
        { businessId: payload.businessId, fields: payload.changes.map((c) => c.field) },
        'business identity changed but no admin exists to notify',
      );
      return;
    }

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

  /**
   * Même raisonnement que `alertAdminOfIdentityChange` ci-dessus, pour un
   * champ `MODERATED` d'une offre déjà en ligne plutôt qu'un champ `IDENTITY`
   * d'un lieu. Depuis le 2026-08-28, `OFFER_EDIT_POLICY` laisse ces champs
   * passer en `NOTIFY_ADMIN` sur `ACTIVE`/`PAUSED` (`editable-fields.ts`) :
   * l'écriture est déjà passée, ceci ne fait qu'en informer l'admin.
   *
   * L'ancienne et la nouvelle valeur viennent de l'événement, comme pour un
   * lieu — pas de requête supplémentaire pour la plupart d'entre elles. Trois
   * exceptions : la devise n'est jamais dans `changes` (`currency` est
   * refusée en toutes circonstances par `updateOffer`), donc une lecture ici
   * pour savoir dans quelle devise formater `priceAmount`/`referencePriceAmount` ;
   * le nom du lieu et de l'établissement, ajoutés au contexte de l'alerte
   * (voir plus bas), viennent des jointures sur la même requête ; et le nom
   * d'une catégorie, quand `categoryId` fait partie des champs changés, vient
   * d'une requête à part sur `categories` (`categoryNames`).
   *
   * Les libellés de champ viennent de `offerFieldLabelFr` (`@try/contracts`),
   * pas d'une table locale : c'est le même vocabulaire que le tableau de bord
   * des salles, exhaustif par construction (`OFFER_FIELD_LABELS_FR` est typé
   * `Record<OfferField, string>`) — une table locale dupliquée aurait fini par
   * diverger. Même raisonnement pour les *valeurs* de `trialRule` et
   * `experienceType`, formatées par `formatOfferFieldValue` via
   * `TRIAL_RULE_LABELS_FR` (local, vocabulaire d'alerte interne) et
   * `EXPERIENCE_TYPE_LABELS_FR` (`@try/contracts`, partagé avec le tableau de
   * bord).
   */
  private async alertAdminOfOfferModeratedFieldsChange(
    payload: DomainEventMap['OfferModeratedFieldsChanged'],
  ): Promise<void> {
    // Jointures ajoutées le 2026-08-28 pour le nom du lieu et de
    // l'établissement (voir plus bas) — l'alerte ne portait jusqu'ici que le
    // titre de l'offre, ce qui forçait l'admin à rouvrir la base pour savoir
    // où agir.
    const [offer] = await this.db
      .select({
        title: schema.offers.title,
        currency: schema.offers.currency,
        venueName: schema.venues.name,
        businessName: schema.businesses.name,
      })
      .from(schema.offers)
      .innerJoin(schema.venues, eq(schema.venues.id, schema.offers.venueId))
      .innerJoin(schema.businesses, eq(schema.businesses.id, schema.offers.businessId))
      .where(eq(schema.offers.id, payload.offerId))
      .limit(1);
    if (!offer) {
      // L'écriture est déjà passée — `updateOffer` a committé avant
      // d'émettre. Une offre introuvable ici voudrait dire qu'elle a
      // disparu entre le commit et le traitement de l'événement ; rien ne
      // supprime une offre aujourd'hui, donc improbable, mais un retour
      // silencieux perdrait la trace d'une alerte qui aurait dû partir.
      this.logger.warn(
        { offerId: payload.offerId, fields: payload.changes.map((c) => c.field) },
        'offer moderated fields changed but offer not found',
      );
      return;
    }

    // `categoryId` porte un UUID dans `payload.changes` ; `formatOfferFieldValue`
    // a besoin du nom pour être lisible. Un seul aller-retour pour toutes les
    // valeurs (avant et après, sur tous les champs changés), pas une requête
    // par valeur.
    const categoryIds = new Set<string>();
    for (const change of payload.changes) {
      if (change.field !== 'categoryId') continue;
      if (typeof change.oldValue === 'string') categoryIds.add(change.oldValue);
      if (typeof change.newValue === 'string') categoryIds.add(change.newValue);
    }
    const categoryNames = new Map<string, string>();
    if (categoryIds.size > 0) {
      const categoryRows = await this.db
        .select({ id: schema.categories.id, name: schema.categories.name })
        .from(schema.categories)
        .where(inArray(schema.categories.id, [...categoryIds]));
      for (const row of categoryRows) categoryNames.set(row.id, row.name);
    }

    const changes = payload.changes
      .map((change) => {
        const label = offerFieldLabelFr(change.field);
        const oldValue = formatOfferFieldValue(change.field, change.oldValue, offer.currency, categoryNames);
        const newValue = formatOfferFieldValue(change.field, change.newValue, offer.currency, categoryNames);
        return `${label} : « ${oldValue} » → « ${newValue} »`;
      })
      .join('\n');

    const admins = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(inArray(schema.users.role, ['ADMIN', 'SUPER_ADMIN']));
    if (admins.length === 0) {
      // Silencieux jusqu'ici : un PATCH accepté qui ne prévient personne parce
      // qu'aucun compte ADMIN/SUPER_ADMIN n'existe est une lacune opérationnelle
      // à détecter, pas un cas normal à ignorer sans trace.
      this.logger.warn(
        { offerId: payload.offerId, fields: payload.changes.map((c) => c.field) },
        'offer moderated fields changed but no admin exists to notify',
      );
      return;
    }

    // Le lieu (et l'établissement, jointure déjà faite ci-dessus donc sans
    // coût) en tête du corps : un admin qui reçoit « le prix a changé » sans
    // savoir sur quel lieu doit rouvrir la base avant de pouvoir agir.
    // Changement de règle assumé le 2026-08-28 — assertions mises à jour en
    // conséquence dans moderation-lifecycle.integration.test.ts.
    const body = `${offer.venueName} — ${offer.businessName}\n\n${changes}`;

    await this.db.insert(schema.notifications).values(
      admins.map((admin) => ({
        userId: admin.id,
        type: 'OFFER_MODERATED_FIELDS_CHANGED',
        title: `Modification d’offre en ligne : ${offer.title} (${offer.venueName})`,
        body,
        deepLink: null,
      })),
    );

    this.logger.info(
      {
        offerId: payload.offerId,
        admins: admins.length,
        fields: payload.changes.map((c) => c.field),
      },
      'offer moderated fields change alerted to admins',
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
