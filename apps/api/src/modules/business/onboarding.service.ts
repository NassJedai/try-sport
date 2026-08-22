import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  assertOfferTransition,
  assertVenueTransition,
  missingVenueSubmissionRequirements,
  offerEditRefusalReason,
  reviewOfferFieldEdits,
  reviewVenueFieldEdits,
  venueEditRefusalReason,
  REJECTION_REASON_MIN_LENGTH,
  VENUE_SUBMISSION_REQUIREMENT_ACTIONS_FR,
} from '@try/contracts';
import type {
  BusinessOfferDto,
  BusinessVenueDto,
  CreateBusinessDto,
  CreateOfferDto,
  CreateVenueDto,
  UpdateOfferDto,
  UpdateVenueDto,
} from '@try/contracts';
import { slugify } from '@try/utils';
import type { Clock } from '@try/utils';
import { schema } from '@try/database';
import type { Database, Transaction } from '@try/database';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { AuditService } from '../admin/audit.service.js';
import { DomainEvents } from '../events/domain-events.js';
import { toBusinessVenueDto } from './venue-dto.mapper.js';
import { hasBusinessRole, type AuthenticatedUser } from '../../common/auth/current-user.js';

/**
 * Business self-serve onboarding.
 *
 * Signup → business → venue → offer → schedule → submit → admin approval.
 * Nothing a business creates reaches a consumer without passing through
 * moderation; the transitions are enforced by the shared state machine, so a
 * business cannot publish itself by calling a different endpoint.
 */
@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  /**
   * Creates the business and makes the caller its OWNER in one transaction.
   *
   * If the membership insert failed separately, we would have an ownerless
   * business that nobody — including support — could administer.
   */
  async createBusiness(input: {
    actor: AuthenticatedUser;
    dto: CreateBusinessDto;
  }): Promise<{ businessId: string }> {
    const now = this.clock.now();

    return this.db.transaction(async (tx) => {
      const slug = await this.uniqueSlug(tx, schema.businesses, slugify(input.dto.name));

      const [business] = await tx
        .insert(schema.businesses)
        .values({
          slug,
          name: input.dto.name,
          legalName: input.dto.legalName ?? null,
          vatNumber: input.dto.vatNumber ?? null,
          contactEmail: input.dto.contactEmail,
          contactPhone: input.dto.contactPhone ?? null,
          countryCode: input.dto.countryCode,
          // Commercial terms are platform-set, never client-supplied.
          //
          // The rate is deliberately absent: it comes from the column default, so
          // there is exactly one place in the codebase that states what a new
          // business pays. Repeating it here is how the two drifted apart — the
          // schema said 15 %, the commercial rule said 25 %, and nothing failed.
          status: 'PENDING_APPROVAL',
          billingModel: 'COMMISSION',
        })
        .returning({ id: schema.businesses.id });

      if (!business) throw new ApiException('INTERNAL_ERROR');

      await tx.insert(schema.businessMembers).values({
        businessId: business.id,
        userId: input.actor.id,
        role: 'OWNER',
        acceptedAt: now,
      });

      // The account is now staff as well as a consumer; both roles coexist.
      await tx
        .update(schema.users)
        .set({ role: 'BUSINESS_MEMBER', updatedAt: now })
        .where(and(eq(schema.users.id, input.actor.id), eq(schema.users.role, 'USER')));

      await this.audit.record(tx, {
        actorId: input.actor.id,
        actorType: 'BUSINESS_MEMBER',
        action: 'business.create',
        entityType: 'business',
        entityId: business.id,
        metadata: { name: input.dto.name },
      });

      return { businessId: business.id };
    });
  }

  async createVenue(input: {
    actor: AuthenticatedUser;
    businessId: string;
    dto: CreateVenueDto;
  }): Promise<{ venueId: string }> {
    this.assertRole(input.actor, input.businessId, 'MANAGER');

    return this.db.transaction(async (tx) => {
      const slug = await this.uniqueSlug(tx, schema.venues, slugify(input.dto.name));

      const [venue] = await tx
        .insert(schema.venues)
        .values({
          businessId: input.businessId,
          slug,
          name: input.dto.name,
          description: input.dto.description ?? null,
          status: 'DRAFT',
          addressLine: input.dto.addressLine,
          postalCode: input.dto.postalCode,
          cityId: input.dto.cityId,
          districtId: input.dto.districtId ?? null,
          latitude: input.dto.latitude,
          longitude: input.dto.longitude,
          timeZone: input.dto.timeZone,
          phone: input.dto.phone ?? null,
          website: input.dto.website ?? null,
          instagram: input.dto.instagram ?? null,
          amenities: input.dto.amenities,
          languages: input.dto.languages,
          openingHours: input.dto.openingHours,
        })
        .returning({ id: schema.venues.id });

      if (!venue) throw new ApiException('INTERNAL_ERROR');

      if (input.dto.categoryIds.length > 0) {
        await tx.insert(schema.venueCategories).values(
          input.dto.categoryIds.map((categoryId) => ({ venueId: venue.id, categoryId })),
        );
      }

      return { venueId: venue.id };
    });
  }

  async createOffer(input: {
    actor: AuthenticatedUser;
    dto: CreateOfferDto;
  }): Promise<{ offerId: string }> {
    const venue = await this.loadVenue(input.dto.venueId);
    this.assertRole(input.actor, venue.businessId, 'MANAGER');

    /**
     * The reference price must genuinely exceed the trial price. A database
     * constraint enforces it too; rejecting it here gives the business a message
     * it can act on instead of a constraint violation.
     */
    if (
      input.dto.referencePriceAmount !== null &&
      input.dto.referencePriceAmount < input.dto.priceAmount
    ) {
      throw new ApiException(
        'VALIDATION_FAILED',
        'Le prix habituel doit être supérieur ou égal au prix découverte.',
        { referencePriceAmount: ['must be >= priceAmount'] },
      );
    }

    const [offer] = await this.db
      .insert(schema.offers)
      .values({
        venueId: input.dto.venueId,
        // Denormalised from the venue, never taken from the client.
        businessId: venue.businessId,
        categoryId: input.dto.categoryId,
        title: input.dto.title,
        description: input.dto.description,
        status: 'DRAFT',
        experienceType: input.dto.experienceType,
        skillLevel: input.dto.skillLevel,
        priceAmount: input.dto.priceAmount,
        referencePriceAmount: input.dto.referencePriceAmount,
        currency: input.dto.currency,
        durationMinutes: input.dto.durationMinutes,
        capacity: input.dto.capacity,
        languages: input.dto.languages,
        amenities: input.dto.amenities,
        whatToBring: input.dto.whatToBring,
        conditions: input.dto.conditions,
        cancellationPolicy: input.dto.cancellationPolicy,
        trialRule: input.dto.trialRule,
      })
      .returning({ id: schema.offers.id });

    if (!offer) throw new ApiException('INTERNAL_ERROR');
    return { offerId: offer.id };
  }

  /**
   * Submits a venue for moderation.
   *
   * Deux questions distinctes, dans cet ordre : le dossier est-il complet
   * (`missingVenueSubmissionRequirements`, la même liste que l'assistant
   * d'inscription et la vue admin) puis, seulement s'il l'est, ce statut
   * autorise-t-il une soumission (`assertVenueTransition`, la machine à
   * états). Les confondre ferait dire « transition invalide » à un dossier
   * simplement incomplet, ou l'inverse.
   */
  async submitVenue(input: { actor: AuthenticatedUser; venueId: string }): Promise<void> {
    const venue = await this.loadVenue(input.venueId);
    this.assertRole(input.actor, venue.businessId, 'MANAGER');

    const [offerCountRow] = await this.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(schema.offers)
      .where(eq(schema.offers.venueId, input.venueId));
    const [imageCountRow] = await this.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(schema.venueImages)
      .where(eq(schema.venueImages.venueId, input.venueId));

    const missing = missingVenueSubmissionRequirements({
      offerCount: offerCountRow?.count ?? 0,
      imageCount: imageCountRow?.count ?? 0,
      description: venue.description,
      vatNumber: venue.vatNumber,
    });

    if (missing.length > 0) {
      throw new ApiException(
        'CONFLICT',
        `Ce lieu n’est pas encore prêt à être soumis : ${missing
          .map((requirement) => VENUE_SUBMISSION_REQUIREMENT_ACTIONS_FR[requirement])
          .join(' ')}`,
        { missing },
      );
    }

    assertVenueTransition(venue.status, 'PENDING_APPROVAL', 'BUSINESS');

    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.venues)
        .set({
          status: 'PENDING_APPROVAL',
          // Une resoumission (depuis REJECTED) efface l'ancien motif : afficher
          // « Refusée : photos manquantes » sur un dossier de nouveau en examen
          // est contradictoire, et l'historique reste dans audit_logs.
          rejectedReason: null,
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.venues.id, input.venueId));

      await this.audit.record(tx, {
        actorId: input.actor.id,
        actorType: 'BUSINESS_MEMBER',
        action: 'venue.submit',
        entityType: 'venue',
        entityId: input.venueId,
        metadata: { from: venue.status },
      });
    });
  }

  async submitOffer(input: { actor: AuthenticatedUser; offerId: string }): Promise<void> {
    const offer = await this.loadOffer(input.offerId);
    this.assertRole(input.actor, offer.businessId, 'MANAGER');

    assertOfferTransition(offer.status, 'PENDING_APPROVAL', 'BUSINESS');

    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.offers)
        .set({
          status: 'PENDING_APPROVAL',
          // Même règle que côté lieu : une resoumission repart sans l'ancien motif.
          rejectedReason: null,
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.offers.id, input.offerId));

      await this.audit.record(tx, {
        actorId: input.actor.id,
        actorType: 'BUSINESS_MEMBER',
        action: 'offer.submit',
        entityType: 'offer',
        entityId: input.offerId,
        metadata: { from: offer.status },
      });
    });
  }

  /**
   * Withdraws a venue submission back to `DRAFT` so its manager can correct it.
   *
   * `PENDING_APPROVAL → DRAFT` for `BUSINESS` already exists in the shared
   * state machine (`moderation-state-machine.ts:33`); nothing to add there.
   */
  async withdrawVenue(input: { actor: AuthenticatedUser; venueId: string }): Promise<void> {
    const venue = await this.loadVenue(input.venueId);
    this.assertRole(input.actor, venue.businessId, 'MANAGER');

    assertVenueTransition(venue.status, 'DRAFT', 'BUSINESS');

    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.venues)
        .set({ status: 'DRAFT', updatedAt: this.clock.now() })
        .where(eq(schema.venues.id, input.venueId));

      await this.audit.record(tx, {
        actorId: input.actor.id,
        actorType: 'BUSINESS_MEMBER',
        action: 'venue.withdraw',
        entityType: 'venue',
        entityId: input.venueId,
        metadata: { from: venue.status },
      });
    });
  }

  /** Same withdrawal, for an offer. `PENDING_APPROVAL → DRAFT` also pre-exists (`:77`). */
  async withdrawOffer(input: { actor: AuthenticatedUser; offerId: string }): Promise<void> {
    const offer = await this.loadOffer(input.offerId);
    this.assertRole(input.actor, offer.businessId, 'MANAGER');

    assertOfferTransition(offer.status, 'DRAFT', 'BUSINESS');

    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.offers)
        .set({ status: 'DRAFT', updatedAt: this.clock.now() })
        .where(eq(schema.offers.id, input.offerId));

      await this.audit.record(tx, {
        actorId: input.actor.id,
        actorType: 'BUSINESS_MEMBER',
        action: 'offer.withdraw',
        entityType: 'offer',
        entityId: input.offerId,
        metadata: { from: offer.status },
      });
    });
  }

  /**
   * Updates a venue's own fields.
   *
   * `reviewVenueFieldEdits` classe les clés soumises en trois lots ; si
   * `forbidden` n'est pas vide, tout le PATCH est refusé — pas d'écriture
   * partielle sur ce qui était permis. `currency` n'existe pas côté lieu, donc
   * pas de garde équivalente à celle de `updateOffer` ici.
   *
   * Fusion `key in dto ? dto.key : existing.key`, jamais `dto.key ?? existing.key`
   * — voir le commentaire au-dessus de `updateVenueSchema` dans
   * `@try/contracts`. `amenities: []` et `openingHours: []` sont des remises à
   * zéro légitimes que `??` confondrait avec « absent ».
   */
  async updateVenue(input: {
    actor: AuthenticatedUser;
    venueId: string;
    dto: UpdateVenueDto;
  }): Promise<BusinessVenueDto> {
    const dto = input.dto;
    const now = this.clock.now();

    const result = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.venues)
        .where(eq(schema.venues.id, input.venueId))
        .for('update')
        .limit(1);

      if (!existing) throw ApiException.notFound('venue', input.venueId);
      this.assertRole(input.actor, existing.businessId, 'MANAGER');

      const verdict = reviewVenueFieldEdits(existing.status, Object.keys(dto));
      if (verdict.forbidden.length > 0) {
        throw new ApiException('CONFLICT', venueEditRefusalReason(existing.status) ?? undefined, {
          fields: [...verdict.forbidden],
        });
      }

      const [updated] = await tx
        .update(schema.venues)
        .set({
          name: 'name' in dto ? dto.name : existing.name,
          description: 'description' in dto ? (dto.description ?? null) : existing.description,
          addressLine: 'addressLine' in dto ? dto.addressLine : existing.addressLine,
          postalCode: 'postalCode' in dto ? dto.postalCode : existing.postalCode,
          cityId: 'cityId' in dto ? dto.cityId : existing.cityId,
          districtId: 'districtId' in dto ? dto.districtId : existing.districtId,
          latitude: 'latitude' in dto ? dto.latitude : existing.latitude,
          longitude: 'longitude' in dto ? dto.longitude : existing.longitude,
          timeZone: 'timeZone' in dto ? dto.timeZone : existing.timeZone,
          phone: 'phone' in dto ? (dto.phone ?? null) : existing.phone,
          website: 'website' in dto ? (dto.website ?? null) : existing.website,
          instagram: 'instagram' in dto ? (dto.instagram ?? null) : existing.instagram,
          amenities: 'amenities' in dto ? dto.amenities : existing.amenities,
          languages: 'languages' in dto ? dto.languages : existing.languages,
          openingHours: 'openingHours' in dto ? dto.openingHours : existing.openingHours,
          updatedAt: now,
        })
        .where(eq(schema.venues.id, input.venueId))
        .returning();

      if (!updated) throw ApiException.notFound('venue', input.venueId);

      // `categoryIds: []` est refusé par le schéma (`.min(1)` survit à
      // `partialUpdateOf`) : présent veut donc toujours dire "au moins une
      // catégorie", jamais "vide-les toutes".
      if ('categoryIds' in dto && dto.categoryIds) {
        await tx
          .delete(schema.venueCategories)
          .where(eq(schema.venueCategories.venueId, input.venueId));
        await tx.insert(schema.venueCategories).values(
          dto.categoryIds.map((categoryId) => ({ venueId: input.venueId, categoryId })),
        );
      }

      // Le titre des offres suit le nom de la salle — écriture SYSTEM, voir
      // syncOfferTitlesWithVenueName ci-dessous pour la règle et ses limites.
      const nameChanged = 'name' in dto && dto.name !== existing.name;
      if (nameChanged) {
        await this.syncOfferTitlesWithVenueName(tx, {
          venueId: input.venueId,
          oldName: existing.name,
          newName: updated.name,
          actorId: input.actor.id,
        });
      }

      await this.audit.record(tx, {
        actorId: input.actor.id,
        actorType: 'BUSINESS_MEMBER',
        action: 'venue.update',
        entityType: 'venue',
        entityId: input.venueId,
        metadata: { fields: Object.keys(dto), notifyAdmin: verdict.notifyAdmin },
      });

      // `existing` (relu avant l'UPDATE, sous verrou) et `updated` (rendu par
      // le `RETURNING`) portent chacun une des deux moitiés dont l'alerte
      // admin a besoin — les capturer ici coûte une lecture de propriété,
      // pas une requête de plus.
      const identityChanges = verdict.notifyAdmin.map((field) => ({
        field,
        oldValue: existing[field as keyof typeof existing] as unknown,
        newValue: updated[field as keyof typeof updated] as unknown,
      }));

      return { businessId: existing.businessId, identityChanges };
    });

    // Émis après le commit, jamais dedans — voir la section « Emit after
    // COMMIT » de domain-events.ts, refund-ledger.service.ts et LeadConverted
    // (business.service.ts) : un abonné ne doit jamais apprendre un
    // changement qu'un rollback peut encore annuler.
    if (result.identityChanges.length > 0) {
      this.events.emit('VenueIdentityChanged', {
        venueId: input.venueId,
        businessId: result.businessId,
        actorId: input.actor.id,
        changes: result.identityChanges,
      });
    }

    return this.loadBusinessVenueDto(input.venueId);
  }

  /**
   * Updates an offer's own fields.
   *
   * `currency` n'est jamais accepté ici, quel que soit le statut : la changer
   * sans retoucher `priceAmount`/`referencePriceAmount` reprice l'offre en
   * silence, et rien ne recalcule les montants dans l'autre devise. Refus
   * explicite plutôt que silencieux — un gérant qui envoie `currency` doit
   * savoir que ça n'a pas été pris en compte, pas le découvrir plus tard sur
   * une facture.
   */
  async updateOffer(input: {
    actor: AuthenticatedUser;
    offerId: string;
    dto: UpdateOfferDto;
  }): Promise<BusinessOfferDto> {
    const dto = input.dto;

    if ('currency' in dto) {
      throw new ApiException(
        'VALIDATION_FAILED',
        'La devise ne peut pas être modifiée après la création de l’offre. Crée une nouvelle offre si elle doit changer.',
        { currency: ['not editable'] },
      );
    }

    const now = this.clock.now();

    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.offers)
        .where(eq(schema.offers.id, input.offerId))
        .for('update')
        .limit(1);

      if (!existing) throw ApiException.notFound('offer', input.offerId);
      this.assertRole(input.actor, existing.businessId, 'MANAGER');

      const verdict = reviewOfferFieldEdits(existing.status, Object.keys(dto));
      if (verdict.forbidden.length > 0) {
        throw new ApiException('CONFLICT', offerEditRefusalReason(existing.status) ?? undefined, {
          fields: [...verdict.forbidden],
        });
      }

      // Castés explicitement plutôt que laissés à l'inférence du ternaire :
      // le type produit par `partialUpdateOf` reste `number | undefined` aux
      // yeux de TypeScript même à l'intérieur du bras `'priceAmount' in dto`
      // (mapped type générique, pas un objet littéral — le narrowing par `in`
      // ne s'y applique pas). La valeur à l'exécution est bien définie : c'est
      // exactement ce que la garde `in` vérifie juste avant.
      const priceAmount = 'priceAmount' in dto ? (dto.priceAmount as number) : existing.priceAmount;
      const referencePriceAmount =
        'referencePriceAmount' in dto
          ? (dto.referencePriceAmount as number | null)
          : existing.referencePriceAmount;

      // Revalidé sur les valeurs FUSIONNÉES, jamais sur le corps brut de la
      // requête : un PATCH qui ne touche que `referencePriceAmount` doit être
      // comparé au `priceAmount` réellement stocké, comme à la création
      // (onboarding.service.ts, `createOffer`).
      if (referencePriceAmount !== null && referencePriceAmount < priceAmount) {
        throw new ApiException(
          'VALIDATION_FAILED',
          'Le prix habituel doit être supérieur ou égal au prix découverte.',
          { referencePriceAmount: ['must be >= priceAmount'] },
        );
      }

      await tx
        .update(schema.offers)
        .set({
          categoryId: 'categoryId' in dto ? dto.categoryId : existing.categoryId,
          title: 'title' in dto ? dto.title : existing.title,
          description: 'description' in dto ? dto.description : existing.description,
          experienceType: 'experienceType' in dto ? dto.experienceType : existing.experienceType,
          skillLevel: 'skillLevel' in dto ? dto.skillLevel : existing.skillLevel,
          priceAmount,
          referencePriceAmount,
          /**
           * Lu par l'expanseur de créneaux au moment où il matérialise un
           * créneau (schedule.service.ts:41-42) — pas rétroactivement : les
           * créneaux déjà matérialisés gardent leur `endAt` calculé avec
           * l'ancienne durée. Décision assumée, pas un oubli : un participant
           * déjà confirmé sur un créneau ne doit pas voir son horaire de fin
           * bouger sous ses pieds. Seuls les créneaux matérialisés après ce
           * PATCH utilisent la nouvelle durée.
           */
          durationMinutes: 'durationMinutes' in dto ? dto.durationMinutes : existing.durationMinutes,
          capacity: 'capacity' in dto ? dto.capacity : existing.capacity,
          languages: 'languages' in dto ? dto.languages : existing.languages,
          amenities: 'amenities' in dto ? dto.amenities : existing.amenities,
          whatToBring: 'whatToBring' in dto ? dto.whatToBring : existing.whatToBring,
          conditions: 'conditions' in dto ? (dto.conditions ?? null) : existing.conditions,
          cancellationPolicy:
            'cancellationPolicy' in dto ? dto.cancellationPolicy : existing.cancellationPolicy,
          trialRule: 'trialRule' in dto ? dto.trialRule : existing.trialRule,
          updatedAt: now,
        })
        .where(eq(schema.offers.id, input.offerId));

      await this.audit.record(tx, {
        actorId: input.actor.id,
        actorType: 'BUSINESS_MEMBER',
        action: 'offer.update',
        entityType: 'offer',
        entityId: input.offerId,
        metadata: { fields: Object.keys(dto) },
      });
    });

    return this.loadBusinessOfferDto(input.offerId);
  }

  /**
   * Le titre d'une offre suit le nom de sa salle — une écriture SYSTEM, pas
   * une édition du gérant : `title` est classé `MODERATED` dans
   * `editable-fields.ts` et ne passerait normalement pas la porte d'édition
   * (`reviewOfferFieldEdits`), mais laisser une offre afficher le nom d'une
   * salle qui n'existe plus est pire que la contourner ici, à la source du
   * renommage.
   *
   * **Règle prudente, pas une garantie.** Ne remplace que les occurrences de
   * l'ancien nom entourées de frontières de mot Unicode (`replaceWholeWord`,
   * ci-dessous) : pas de coupure au milieu d'un autre mot, accents compris. Un
   * gérant dont le titre contient par coïncidence le nom exact de sa salle
   * sans rapport avec elle verrait quand même son titre réécrit à tort — c'est
   * le risque assumé, documenté ici plutôt que caché. Les noms de moins de 3
   * caractères sont ignorés : le risque de faux positif y dépasse le
   * bénéfice.
   */
  private async syncOfferTitlesWithVenueName(
    tx: Transaction,
    input: { venueId: string; oldName: string; newName: string; actorId: string },
  ): Promise<void> {
    const oldName = input.oldName.trim();
    const newName = input.newName.trim();
    if (oldName.length < 3 || oldName === newName) return;

    const offers = await tx
      .select({ id: schema.offers.id, title: schema.offers.title })
      .from(schema.offers)
      .where(eq(schema.offers.venueId, input.venueId));

    const now = this.clock.now();

    for (const offer of offers) {
      const renamed = OnboardingService.replaceWholeWord(offer.title, oldName, newName);
      if (renamed === offer.title || renamed.length > 120) continue;

      await tx
        .update(schema.offers)
        .set({ title: renamed, updatedAt: now })
        .where(eq(schema.offers.id, offer.id));

      await this.audit.record(tx, {
        actorId: input.actorId,
        actorType: 'SYSTEM',
        action: 'offer.title_synced',
        entityType: 'offer',
        entityId: offer.id,
        metadata: { from: offer.title, to: renamed, reason: 'venue.renamed', venueId: input.venueId },
      });
    }
  }

  /**
   * Remplace `needle` par `replacement` dans `text`, uniquement aux frontières
   * de mot Unicode (lettre ou chiffre de part et d'autre du bord du texte
   * exclu).
   *
   * Pas de `\b` JavaScript : il ne connaît que `[A-Za-z0-9_]`, donc un nom
   * commençant par une lettre accentuée (« Étoile ») ne déclenche aucune
   * frontière en tête de chaîne et le remplacement échoue en silence. Ce
   * balayage manuel traite toute lettre/chiffre Unicode — accents compris —
   * comme caractère de mot.
   */
  private static replaceWholeWord(text: string, needle: string, replacement: string): string {
    const isWordChar = (char: string | undefined): boolean =>
      char !== undefined && /\p{L}|\p{N}/u.test(char);

    const lowerText = text.toLowerCase();
    const lowerNeedle = needle.toLowerCase();

    let result = '';
    let cursor = 0;
    let changed = false;

    while (cursor <= text.length - needle.length) {
      if (lowerText.slice(cursor, cursor + lowerNeedle.length) === lowerNeedle) {
        const before = text[cursor - 1];
        const after = text[cursor + needle.length];
        if (!isWordChar(before) && !isWordChar(after)) {
          result += replacement;
          cursor += needle.length;
          changed = true;
          continue;
        }
      }
      result += text[cursor];
      cursor += 1;
    }
    result += text.slice(cursor);

    return changed ? result : text;
  }

  /** Rebuilds the owner-facing venue view after a write — fresh read, post-commit. */
  private async loadBusinessVenueDto(venueId: string): Promise<BusinessVenueDto> {
    const [row] = await this.db
      .select({ venue: schema.venues, vatNumber: schema.businesses.vatNumber })
      .from(schema.venues)
      .innerJoin(schema.businesses, eq(schema.businesses.id, schema.venues.businessId))
      .where(eq(schema.venues.id, venueId))
      .limit(1);

    if (!row) throw ApiException.notFound('venue', venueId);

    const [[offerCountRow], [imageCountRow], categoryRows] = await Promise.all([
      this.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(schema.offers)
        .where(eq(schema.offers.venueId, venueId)),
      this.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(schema.venueImages)
        .where(eq(schema.venueImages.venueId, venueId)),
      this.db
        .select({ categoryId: schema.venueCategories.categoryId })
        .from(schema.venueCategories)
        .where(eq(schema.venueCategories.venueId, venueId)),
    ]);

    return toBusinessVenueDto({
      venue: row.venue,
      vatNumber: row.vatNumber,
      offerCount: offerCountRow?.count ?? 0,
      imageCount: imageCountRow?.count ?? 0,
      categoryIds: categoryRows.map((category) => category.categoryId),
    });
  }

  /** Rebuilds the owner-facing offer view after a write — same reasoning as above. */
  private async loadBusinessOfferDto(offerId: string): Promise<BusinessOfferDto> {
    const now = this.clock.now();

    const [row] = await this.db
      .select({
        id: schema.offers.id,
        title: schema.offers.title,
        status: schema.offers.status,
        venueId: schema.offers.venueId,
        venueName: schema.venues.name,
        priceAmount: schema.offers.priceAmount,
        durationMinutes: schema.offers.durationMinutes,
        capacity: schema.offers.capacity,
        rejectedReason: schema.offers.rejectedReason,
        upcomingSlots: sql<number>`(
          SELECT COUNT(*) FROM slots s
          WHERE s.offer_id = ${schema.offers.id}
            AND s.start_at > ${now.toISOString()}
            AND s.status IN ('OPEN', 'FULL')
        )::int`,
      })
      .from(schema.offers)
      .innerJoin(schema.venues, eq(schema.venues.id, schema.offers.venueId))
      .where(eq(schema.offers.id, offerId))
      .limit(1);

    if (!row) throw ApiException.notFound('offer', offerId);
    return row;
  }

  /** Pausing and resuming are the business's own controls; no moderation needed. */
  async setOfferPaused(input: {
    actor: AuthenticatedUser;
    offerId: string;
    paused: boolean;
  }): Promise<void> {
    const offer = await this.loadOffer(input.offerId);
    this.assertRole(input.actor, offer.businessId, 'MANAGER');

    const target = input.paused ? 'PAUSED' : 'ACTIVE';
    assertOfferTransition(offer.status, target, 'BUSINESS');

    await this.db
      .update(schema.offers)
      .set({ status: target, updatedAt: this.clock.now() })
      .where(eq(schema.offers.id, input.offerId));
  }

  private assertRole(
    actor: AuthenticatedUser,
    businessId: string,
    role: 'STAFF' | 'MANAGER' | 'OWNER',
  ): void {
    if (!hasBusinessRole(actor, businessId, role)) {
      throw ApiException.forbidden(`requires ${role} on business ${businessId}`);
    }
  }

  /**
   * `vatNumber` vit sur `businesses`, pas sur `venues` — d'où la jointure : la
   * porte de soumission (`submitVenue`) a besoin des deux pour juger de la
   * complétude d'un dossier.
   */
  private async loadVenue(venueId: string) {
    const [venue] = await this.db
      .select({
        id: schema.venues.id,
        businessId: schema.venues.businessId,
        status: schema.venues.status,
        description: schema.venues.description,
        vatNumber: schema.businesses.vatNumber,
      })
      .from(schema.venues)
      .innerJoin(schema.businesses, eq(schema.businesses.id, schema.venues.businessId))
      .where(eq(schema.venues.id, venueId))
      .limit(1);

    if (!venue) throw ApiException.notFound('venue', venueId);
    return venue;
  }

  private async loadOffer(offerId: string) {
    const [offer] = await this.db
      .select({
        id: schema.offers.id,
        businessId: schema.offers.businessId,
        venueId: schema.offers.venueId,
        status: schema.offers.status,
      })
      .from(schema.offers)
      .where(eq(schema.offers.id, offerId))
      .limit(1);

    if (!offer) throw ApiException.notFound('offer', offerId);
    return offer;
  }

  /**
   * Slugs are user-visible and must be unique. Collisions are resolved with a
   * numeric suffix rather than by rejecting the name — two studios may legitimately
   * both be called "Studio Move".
   */
  private async uniqueSlug(
    tx: Transaction,
    table: typeof schema.businesses | typeof schema.venues,
    base: string,
  ): Promise<string> {
    const candidate = base || 'venue';

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const slug = attempt === 0 ? candidate : `${candidate}-${attempt + 1}`;
      const existing = await tx
        .select({ slug: table.slug })
        .from(table)
        .where(eq(table.slug, slug))
        .limit(1);

      if (existing.length === 0) return slug;
    }

    // Falls back to a suffix that cannot realistically collide.
    return `${candidate}-${this.clock.now().getTime().toString(36)}`;
  }

  static assertRejectionReason(reason: string | undefined): string {
    if (!reason || reason.trim().length < REJECTION_REASON_MIN_LENGTH) {
      throw new ApiException(
        'VALIDATION_FAILED',
        'Explique la raison du refus pour que l’établissement puisse corriger.',
        { reason: [`minimum ${REJECTION_REASON_MIN_LENGTH} characters`] },
      );
    }
    return reason.trim();
  }
}
