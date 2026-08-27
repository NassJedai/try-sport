import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { buildCursorPage, decodeCursor, money } from '@try/utils';
import type { CurrencyCode } from '@try/utils';
import {
  isCapturedPayment,
  missingVenueSubmissionRequirements,
  VENUE_SUBMISSION_REQUIREMENT_LABELS_FR,
} from '@try/contracts';
import type { PaymentStatus, VenueStatus, VenueSubmissionRequirement } from '@try/contracts';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import { DATABASE } from '../../common/database.module.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { isPlatformAdmin, type AuthenticatedUser } from '../../common/auth/current-user.js';

/**
 * Vues de navigation du back-office : utilisateurs, réservations, paiements.
 *
 * Lecture seule, admin uniquement, listes bornées. Le support s'en sert pour
 * répondre à « ce client dit que… » — la recherche part donc de l'e-mail, la
 * seule chose qu'un utilisateur sait donner au téléphone.
 */
@Injectable()
export class AdminBrowseService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private assertAdmin(actor: AuthenticatedUser): void {
    if (!isPlatformAdmin(actor)) throw ApiException.forbidden('platform admin required');
  }

  async users(
    actor: AuthenticatedUser,
    query: { q?: string; limit: number },
  ): Promise<{
    items: {
      id: string;
      email: string;
      firstName: string | null;
      role: string;
      isSuspended: boolean;
      reservationCount: number;
      createdAt: string;
      lastSeenAt: string | null;
    }[];
  }> {
    this.assertAdmin(actor);

    const rows = await this.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        firstName: schema.profiles.firstName,
        role: schema.users.role,
        isSuspended: schema.users.isSuspended,
        createdAt: schema.users.createdAt,
        lastSeenAt: schema.users.lastSeenAt,
        reservationCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${schema.reservations} r WHERE r.user_id = ${schema.users.id}
        )`,
      })
      .from(schema.users)
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.users.id))
      .where(
        query.q
          ? or(
              ilike(schema.users.email, `%${query.q}%`),
              ilike(schema.profiles.firstName, `%${query.q}%`),
            )
          : undefined,
      )
      .orderBy(desc(schema.users.createdAt))
      .limit(query.limit);

    return {
      items: rows.map((row) => ({
        id: row.id,
        email: row.email,
        firstName: row.firstName,
        role: row.role,
        isSuspended: row.isSuspended,
        reservationCount: row.reservationCount,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      })),
    };
  }

  async bookings(
    actor: AuthenticatedUser,
    query: { status?: string; limit: number },
  ): Promise<{
    items: {
      id: string;
      status: string;
      userEmail: string;
      offerTitle: string;
      venueName: string;
      /** IANA, celui du lieu — voir `adminBookingSchema` dans `@try/contracts`. */
      venueTimeZone: string;
      slotStartAt: string;
      price: { amount: number; currency: string };
      createdAt: string;
    }[];
  }> {
    this.assertAdmin(actor);

    const rows = await this.db
      .select({
        id: schema.reservations.id,
        status: schema.reservations.status,
        userEmail: schema.users.email,
        offerTitle: schema.offers.title,
        venueName: schema.venues.name,
        venueTimeZone: schema.venues.timeZone,
        slotStartAt: schema.reservations.slotStartAt,
        priceAmount: schema.reservations.priceAmount,
        currency: schema.reservations.currency,
        createdAt: schema.reservations.createdAt,
      })
      .from(schema.reservations)
      .innerJoin(schema.users, eq(schema.users.id, schema.reservations.userId))
      .innerJoin(schema.offers, eq(schema.offers.id, schema.reservations.offerId))
      .innerJoin(schema.venues, eq(schema.venues.id, schema.reservations.venueId))
      .where(
        query.status
          ? eq(
              schema.reservations.status,
              query.status as (typeof schema.reservations.$inferSelect)['status'],
            )
          : undefined,
      )
      .orderBy(desc(schema.reservations.createdAt))
      .limit(query.limit);

    return {
      items: rows.map((row) => ({
        id: row.id,
        status: row.status,
        userEmail: row.userEmail,
        offerTitle: row.offerTitle,
        venueName: row.venueName,
        venueTimeZone: row.venueTimeZone,
        slotStartAt: row.slotStartAt.toISOString(),
        price: money(row.priceAmount, row.currency as CurrencyCode),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * `status` et `cursor` sont tous deux optionnels et orthogonaux : le filtre
   * restreint l'ensemble, le curseur avance dedans. Sans l'un ni l'autre,
   * c'est la première page de tout, comme avant ce lot.
   */
  async payments(
    actor: AuthenticatedUser,
    query: { status?: PaymentStatus; cursor?: string; limit: number },
  ): Promise<{
    items: {
      id: string;
      status: string;
      userEmail: string;
      businessName: string;
      amount: { amount: number; currency: string };
      platformFee: { amount: number; currency: string };
      /**
       * Commission nette du rembourse : platformFee - refundedPlatformFee,
       * uniquement sur un paiement effectivement encaisse (voir
       * `isCapturedPayment`, @try/contracts/payment-capture.ts).
       *
       * `null` et `0` repondent a deux questions differentes et ne doivent
       * jamais s'afficher pareil :
       *
       * - `null` : aucun encaissement constate (`isCapturedPayment` faux —
       *   `REQUIRES_PAYMENT`, `PROCESSING`, `FAILED`, `CANCELLED`). Aucune
       *   commission n'a jamais existe sur cette ligne ; ce n'est pas zero,
       *   c'est sans objet — cette ligne n'est pas une vente.
       * - un montant, potentiellement `0` : un encaissement a bien ete
       *   constate. Le net vaut reellement zero quand le remboursement a
       *   couvert l'integralite de la commission brute (`REFUNDED` total) ;
       *   c'est une information sur cette vente, pas une absence de vente.
       *
       * Tranche cote serveur — voir invariant 2 de CLAUDE.md, le client ne
       * decide de rien qui compte. Le lot d'interface qui consomme ce champ
       * doit afficher « — » sur `null` et le montant (y compris `0 €`) sur un
       * nombre, sans reconstituer la distinction a partir du statut.
       */
      netPlatformFee: { amount: number; currency: string } | null;
      refunded: { amount: number; currency: string };
      providerPaymentIntentId: string | null;
      createdAt: string;
    }[];
    /** Curseur opaque vers la page suivante, `null` s'il n'y en a pas. */
    nextCursor: string | null;
    /**
     * Total de lignes correspondant au filtre `status` (ou de la table
     * entière si aucun filtre), indépendant de la page courante — sinon un
     * admin qui voit 50 lignes ne sait pas s'il en existe 50 ou 5000.
     *
     * Un `COUNT(*)` par appel, volontairement : cette vue est un outil de
     * support à faible trafic (un admin au clavier, pas un flux public), la
     * colonne `status` est indexée (`payments_status_idx`) pour le cas
     * filtré, et à l'échelle d'un lancement mono-ville le cas non filtré
     * reste un scan bon marché. Recompter à chaque page plutôt que de ne le
     * faire qu'à la première évite au client d'avoir à porter cette valeur
     * lui-même d'une page à l'autre. Si ce volume change d'ordre de
     * grandeur, la bonne suite est un total approché (`reltuples`) ou une
     * réponse qui ne le recalcule qu'en l'absence de curseur — pas d'y
     * toucher à l'aveugle aujourd'hui.
     */
    total: number;
  }> {
    this.assertAdmin(actor);

    const statusCondition = query.status ? eq(schema.payments.status, query.status) : undefined;

    // Curseur invalide ou mal formé : dégrade en silence vers la première
    // page, comme `discovery.service.ts` le fait déjà pour son propre
    // curseur — un lien copié-collé de travers ne doit pas rendre un 400,
    // juste recommencer au début.
    const decoded = query.cursor ? decodeCursor(query.cursor) : null;
    const cursor =
      decoded && typeof decoded.sortValue === 'string' ? { at: new Date(decoded.sortValue), id: decoded.id } : null;
    // Keyset sur (created_at, id) DESC, pas un OFFSET : un paiement inséré
    // pendant qu'un admin feuillette ne doit ni décaler ni dupliquer les
    // pages suivantes. `id` départage les égalités de `created_at` — rares,
    // mais un `Date` JS ne porte que la milliseconde, jamais la microseconde
    // que `timestamptz` peut stocker ; deux paiements à moins d'une
    // milliseconde d'écart sont un cas non couvert par ce départage, comme
    // partout ailleurs dans ce dépôt où `mode: 'date'` est utilisé pour
    // comparer des timestamps.
    const cursorCondition = cursor
      ? or(
          lt(schema.payments.createdAt, cursor.at),
          and(eq(schema.payments.createdAt, cursor.at), lt(schema.payments.id, cursor.id)),
        )
      : undefined;

    const [rows, totalRows] = await Promise.all([
      this.db
        .select({
          id: schema.payments.id,
          status: schema.payments.status,
          userEmail: schema.users.email,
          businessName: schema.businesses.name,
          amount: schema.payments.amount,
          platformFeeAmount: schema.payments.platformFeeAmount,
          refundedAmount: schema.payments.refundedAmount,
          refundedPlatformFeeAmount: schema.payments.refundedPlatformFeeAmount,
          currency: schema.payments.currency,
          providerPaymentIntentId: schema.payments.providerPaymentIntentId,
          createdAt: schema.payments.createdAt,
        })
        .from(schema.payments)
        .innerJoin(schema.users, eq(schema.users.id, schema.payments.userId))
        .innerJoin(schema.businesses, eq(schema.businesses.id, schema.payments.businessId))
        .where(and(statusCondition, cursorCondition))
        .orderBy(desc(schema.payments.createdAt), desc(schema.payments.id))
        // Une ligne de plus que demandé : révèle s'il existe une page
        // suivante sans un second aller-retour dédié.
        .limit(query.limit + 1),
      this.db
        .select({ total: sql<number>`COUNT(*)::int` })
        .from(schema.payments)
        .where(statusCondition),
    ]);

    const page = buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: row.id,
    }));

    return {
      items: page.items.map((row) => {
        const currency = row.currency as CurrencyCode;
        const captured = isCapturedPayment(row.status);
        return {
          id: row.id,
          status: row.status,
          userEmail: row.userEmail,
          businessName: row.businessName,
          amount: money(row.amount, currency),
          platformFee: money(row.platformFeeAmount, currency),
          netPlatformFee: captured
            ? money(row.platformFeeAmount - row.refundedPlatformFeeAmount, currency)
            : null,
          refunded: money(row.refundedAmount, currency),
          providerPaymentIntentId: row.providerPaymentIntentId,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      nextCursor: page.nextCursor,
      total: totalRows[0]?.total ?? 0,
    };
  }

  /**
   * Recherche de lieux, tous statuts confondus — la brique manquante pour
   * suspendre/réactiver un lieu sans en connaître l'UUID par cœur.
   *
   * `incompleteVenues` ci-dessous répond à une question différente (« quels
   * dossiers relancer ? », filtré sur l'incomplétude) ; celle-ci répond à
   * « trouve-moi ce lieu », sans présupposer de statut. Calquée sur
   * `payments()` juste au-dessus : même trio filtre exact + curseur keyset +
   * total, pour la même raison — un lieu suspendu ou archivé, par
   * construction rare et ancien, doit rester atteignable même au-delà de la
   * première page.
   */
  async venues(
    actor: AuthenticatedUser,
    query: { q?: string; status?: VenueStatus; cursor?: string; limit: number },
  ): Promise<{
    items: {
      id: string;
      name: string;
      status: string;
      businessId: string;
      businessName: string;
      cityName: string | null;
      createdAt: string;
    }[];
    nextCursor: string | null;
    total: number;
  }> {
    this.assertAdmin(actor);

    const searchCondition = query.q
      ? or(ilike(schema.venues.name, `%${query.q}%`), ilike(schema.businesses.name, `%${query.q}%`))
      : undefined;
    const statusCondition = query.status ? eq(schema.venues.status, query.status) : undefined;
    // Un lieu supprimé n'est jamais un résultat de recherche valide — même
    // logique que `incompleteVenues`.
    const baseCondition = and(isNull(schema.venues.deletedAt), searchCondition, statusCondition);

    // Même curseur keyset que `payments()` : voir les commentaires là-bas
    // pour le raisonnement (pas un OFFSET, `id` départage les égalités de
    // `created_at`).
    const decoded = query.cursor ? decodeCursor(query.cursor) : null;
    const cursor =
      decoded && typeof decoded.sortValue === 'string'
        ? { at: new Date(decoded.sortValue), id: decoded.id }
        : null;
    const cursorCondition = cursor
      ? or(
          lt(schema.venues.createdAt, cursor.at),
          and(eq(schema.venues.createdAt, cursor.at), lt(schema.venues.id, cursor.id)),
        )
      : undefined;

    const [rows, totalRows] = await Promise.all([
      this.db
        .select({
          id: schema.venues.id,
          name: schema.venues.name,
          status: schema.venues.status,
          businessId: schema.businesses.id,
          businessName: schema.businesses.name,
          cityName: schema.cities.name,
          createdAt: schema.venues.createdAt,
        })
        .from(schema.venues)
        .innerJoin(schema.businesses, eq(schema.businesses.id, schema.venues.businessId))
        .leftJoin(schema.cities, eq(schema.cities.id, schema.venues.cityId))
        .where(and(baseCondition, cursorCondition))
        .orderBy(desc(schema.venues.createdAt), desc(schema.venues.id))
        .limit(query.limit + 1),
      this.db
        .select({ total: sql<number>`COUNT(*)::int` })
        .from(schema.venues)
        .innerJoin(schema.businesses, eq(schema.businesses.id, schema.venues.businessId))
        .where(baseCondition),
    ]);

    const page = buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: row.id,
    }));

    return {
      items: page.items.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        businessId: row.businessId,
        businessName: row.businessName,
        cityName: row.cityName,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
      total: totalRows[0]?.total ?? 0,
    };
  }

  /**
   * Lieux inscrits dont le dossier reste incomplet — des prospects à
   * relancer, pas une file de modération.
   *
   * Volontairement sans filtre de statut : deux lieux `ACTIVE` sans TVA
   * existent déjà en base, hérités d'avant que la complétude ne soit
   * vérifiée à la soumission. Ils sont hors-règle sans être bloqués par
   * elle — la complétude ne s'évalue qu'à la soumission — et doivent
   * apparaître ici comme n'importe quel autre dossier incomplet, décision de
   * Nassim : pas de traitement manuel à part. Un lieu `deleted_at` n'est en
   * revanche jamais un prospect.
   *
   * La TVA vit sur `businesses`, pas sur `venues` : la jointure est
   * obligatoire, exactement comme dans `BusinessService.listVenues`.
   */
  async incompleteVenues(actor: AuthenticatedUser): Promise<{
    items: {
      id: string;
      name: string;
      status: string;
      businessId: string;
      businessName: string;
      missing: VenueSubmissionRequirement[];
      missingLabels: string[];
      createdAt: string;
    }[];
  }> {
    this.assertAdmin(actor);

    const rows = await this.db
      .select({
        id: schema.venues.id,
        name: schema.venues.name,
        status: schema.venues.status,
        description: schema.venues.description,
        createdAt: schema.venues.createdAt,
        businessId: schema.businesses.id,
        businessName: schema.businesses.name,
        vatNumber: schema.businesses.vatNumber,
      })
      .from(schema.venues)
      .innerJoin(schema.businesses, eq(schema.businesses.id, schema.venues.businessId))
      .where(isNull(schema.venues.deletedAt))
      .orderBy(asc(schema.venues.createdAt));

    if (rows.length === 0) return { items: [] };

    const venueIds = rows.map((row) => row.id);

    const [offerCounts, imageCounts] = await Promise.all([
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
    ]);

    const offerCountByVenue = new Map(offerCounts.map((row) => [row.venueId, row.count]));
    const imageCountByVenue = new Map(imageCounts.map((row) => [row.venueId, row.count]));

    const items = rows
      .map((row) => {
        const missing = missingVenueSubmissionRequirements({
          offerCount: offerCountByVenue.get(row.id) ?? 0,
          imageCount: imageCountByVenue.get(row.id) ?? 0,
          description: row.description,
          vatNumber: row.vatNumber,
        });
        return { row, missing };
      })
      .filter(({ missing }) => missing.length > 0)
      .map(({ row, missing }) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        businessId: row.businessId,
        businessName: row.businessName,
        missing,
        missingLabels: missing.map((requirement) => VENUE_SUBMISSION_REQUIREMENT_LABELS_FR[requirement]),
        createdAt: row.createdAt.toISOString(),
      }));

    return { items };
  }
}
