import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import { money, zonedTimeToUtc, zonedDayKey, DEFAULT_TIME_ZONE } from '@try/utils';
import type { Clock, CurrencyCode, IanaTimeZone } from '@try/utils';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type {
  BusinessBookingDto,
  BusinessMetricsDto,
  BusinessOfferDto,
  BusinessSlotDto,
  LeadDto,
  ListBusinessBookingsQueryDto,
  ListLeadsQueryDto,
  UpdateLeadDto,
} from '@try/contracts';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { AuditService } from '../admin/audit.service.js';
import { DomainEvents } from '../events/domain-events.js';
import { hasBusinessRole, type AuthenticatedUser } from '../../common/auth/current-user.js';

@Injectable()
export class BusinessService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  /**
   * Authorisation for every business-scoped read and write.
   *
   * Centralised so a new endpoint cannot forget it, and it never trusts a
   * businessId from the URL alone — membership is checked against the caller's
   * verified claims.
   */
  assertMember(
    actor: AuthenticatedUser,
    businessId: string,
    minimumRole: 'STAFF' | 'MANAGER' | 'OWNER' = 'STAFF',
  ): void {
    if (!hasBusinessRole(actor, businessId, minimumRole)) {
      throw ApiException.forbidden(
        `user ${actor.id} lacks ${minimumRole} on business ${businessId}`,
      );
    }
  }

  /**
   * The numbers a venue actually buys: trials booked, how many showed up, and how
   * many became customers.
   *
   * Computed in one pass with FILTER aggregates rather than five round trips.
   */
  async metrics(input: {
    businessId: string;
    venueId?: string;
    from: Date;
    to: Date;
  }): Promise<BusinessMetricsDto> {
    const venueFilter = input.venueId
      ? sql`AND r.venue_id = ${input.venueId}`
      : sql``;

    /**
     * Les paramètres des requêtes SQL brutes doivent être des chaînes : le
     * driver postgres.js ne sérialise les objets Date qu'à travers le schéma
     * drizzle, jamais dans les fragments bruts — le premier appel réel a planté
     * avec « Received an instance of Date ». Symétrique du côté lecture, où les
     * timestamptz arrivent en chaînes.
     */
    const from = input.from.toISOString();
    const to = input.to.toISOString();

    const [current] = (await this.db.execute(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE r.status NOT IN ('CANCELLED_USER', 'CANCELLED_BUSINESS', 'EXPIRED')
        )::int AS trials,
        COUNT(*) FILTER (WHERE r.checked_in_at IS NOT NULL)::int AS check_ins,
        COUNT(*) FILTER (WHERE r.status = 'NO_SHOW')::int AS no_shows
      FROM reservations r
      WHERE r.business_id = ${input.businessId}
        AND r.slot_start_at >= ${from}
        AND r.slot_start_at <= ${to}
        ${venueFilter}
    `)) as unknown as { trials: number; check_ins: number; no_shows: number }[];

    const [conversions] = (await this.db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE l.status = 'CONVERTED')::int AS conversions,
        COALESCE(SUM(l.attributed_revenue_amount) FILTER (WHERE l.status = 'CONVERTED'), 0)::int
          AS attributed_revenue
      FROM leads l
      WHERE l.business_id = ${input.businessId}
        AND l.created_at >= ${from}
        AND l.created_at <= ${to}
        ${input.venueId ? sql`AND l.venue_id = ${input.venueId}` : sql``}
    `)) as unknown as { conversions: number; attributed_revenue: number }[];

    const trials = current?.trials ?? 0;
    const checkIns = current?.check_ins ?? 0;
    const converted = conversions?.conversions ?? 0;

    return {
      trials,
      checkIns,
      noShows: current?.no_shows ?? 0,
      conversions: converted,
      // Guarded: a venue with no trials yet must read 0%, not NaN.
      attendanceRate: trials > 0 ? checkIns / trials : 0,
      conversionRate: checkIns > 0 ? converted / checkIns : 0,
      attributedRevenue: money(conversions?.attributed_revenue ?? 0, 'EUR'),
      previousPeriod: null,
    };
  }

  /** Today's list at the front desk: who is coming, and their code. */
  /**
   * Les offres du gérant, telles qu'il doit les voir : avec le statut de
   * modération, le motif de refus et le nombre de créneaux à venir — le chiffre
   * qui dit en un coup d'œil si une offre vit ou si elle est à l'arrêt.
   */
  async listOffers(businessId: string): Promise<{ items: BusinessOfferDto[] }> {
    const now = this.clock.now();

    const rows = await this.db
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
      .where(eq(schema.offers.businessId, businessId))
      .orderBy(schema.offers.createdAt);

    return { items: rows };
  }

  /**
   * Le planning des prochains jours, avec le remplissage de chaque créneau.
   *
   * Les créneaux annulés restent visibles : un gérant qui vient d'annuler doit
   * voir que l'annulation a pris, pas un trou inexpliqué dans sa grille.
   */
  async listSlots(businessId: string, days: number): Promise<{ items: BusinessSlotDto[] }> {
    const now = this.clock.now();
    const horizon = new Date(now.getTime() + days * 86_400_000);

    const rows = await this.db
      .select({
        id: schema.slots.id,
        offerId: schema.slots.offerId,
        offerTitle: schema.offers.title,
        venueName: schema.venues.name,
        startAt: schema.slots.startAt,
        endAt: schema.slots.endAt,
        capacity: schema.slots.capacity,
        reservedCount: schema.slots.reservedCount,
        status: schema.slots.status,
      })
      .from(schema.slots)
      .innerJoin(schema.offers, eq(schema.offers.id, schema.slots.offerId))
      .innerJoin(schema.venues, eq(schema.venues.id, schema.slots.venueId))
      .where(
        and(
          eq(schema.offers.businessId, businessId),
          gte(schema.slots.startAt, now),
          lte(schema.slots.startAt, horizon),
        ),
      )
      .orderBy(schema.slots.startAt)
      .limit(200);

    return {
      items: rows.map((row) => ({
        ...row,
        startAt: row.startAt.toISOString(),
        endAt: row.endAt.toISOString(),
      })),
    };
  }

  async listBookings(
    businessId: string,
    query: ListBusinessBookingsQueryDto,
  ): Promise<{ items: BusinessBookingDto[]; nextCursor: string | null }> {
    const now = this.clock.now();
    const timeZone = await this.resolveVenueTimeZone(businessId, query.venueId);

    // A venue-local calendar day, resolved against the venue's timezone rather
    // than the server's — "today" at the desk is what matters. The window is
    // computed from local wall-clock midnight to the *next* local midnight, so
    // it is naturally 23h/25h across a DST transition instead of a hardcoded
    // 24h (or, as before, a wrong 36h) span.
    const dayKey = query.date ?? zonedDayKey(now, timeZone);
    const [year, month, day] = dayKey.split('-').map(Number) as [number, number, number];

    const dayStart = zonedTimeToUtc({ year, month, day, hour: 0, minute: 0 }, timeZone);
    // Calendar-day arithmetic, not instant arithmetic: adding "one calendar
    // day" to the UTC instant of local midnight would drift by the DST delta.
    // `Date.UTC` here is only used as a plain calendar (no timezone math),
    // then re-resolved through the venue's timezone below.
    const nextCalendarDay = new Date(Date.UTC(year, month - 1, day) + 24 * 3_600_000);
    const dayEnd = zonedTimeToUtc(
      {
        year: nextCalendarDay.getUTCFullYear(),
        month: nextCalendarDay.getUTCMonth() + 1,
        day: nextCalendarDay.getUTCDate(),
        hour: 0,
        minute: 0,
      },
      timeZone,
    );

    const rows = await this.db
      .select({
        id: schema.reservations.id,
        status: schema.reservations.status,
        firstName: schema.profiles.firstName,
        offerTitle: schema.offers.title,
        slotStartAt: schema.reservations.slotStartAt,
        slotEndAt: schema.reservations.slotEndAt,
        checkInCode: schema.reservations.checkInCode,
        priceAmount: schema.reservations.priceAmount,
        currency: schema.reservations.currency,
        checkedInAt: schema.reservations.checkedInAt,
        userId: schema.reservations.userId,
        venueId: schema.reservations.venueId,
        venueName: schema.venues.name,
      })
      .from(schema.reservations)
      .innerJoin(schema.offers, eq(schema.offers.id, schema.reservations.offerId))
      .innerJoin(schema.venues, eq(schema.venues.id, schema.reservations.venueId))
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.reservations.userId))
      .where(
        and(
          eq(schema.reservations.businessId, businessId),
          query.venueId ? eq(schema.reservations.venueId, query.venueId) : undefined,
          query.status ? eq(schema.reservations.status, query.status) : undefined,
          gte(schema.reservations.slotStartAt, dayStart),
          lt(schema.reservations.slotStartAt, dayEnd),
        ),
      )
      .orderBy(schema.reservations.slotStartAt)
      .limit(query.limit);

    // One extra query resolves first-visit for the whole page, instead of a
    // per-row lookup (the N+1 that would make a busy desk feel slow).
    const firstVisits = await this.resolveFirstVisits(
      rows.map((row) => ({ userId: row.userId, venueId: row.venueId })),
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        status: row.status,
        venueId: row.venueId,
        venueName: row.venueName,
        attendeeFirstName: row.firstName ?? 'Invité',
        isFirstVisit: firstVisits.has(`${row.userId}:${row.venueId}`),
        offerTitle: row.offerTitle,
        slotStartAt: row.slotStartAt.toISOString(),
        slotEndAt: row.slotEndAt.toISOString(),
        shortCode: row.checkInCode ?? '',
        price: money(row.priceAmount, row.currency as CurrencyCode),
        checkedInAt: row.checkedInAt?.toISOString() ?? null,
      })),
      nextCursor: null,
    };
  }

  async listLeads(
    businessId: string,
    query: ListLeadsQueryDto,
  ): Promise<{ items: LeadDto[]; nextCursor: string | null }> {
    const rows = await this.db
      .select({
        lead: schema.leads,
        firstName: schema.profiles.firstName,
        email: schema.users.email,
        offerTitle: schema.offers.title,
        categoryName: schema.categories.name,
      })
      .from(schema.leads)
      .innerJoin(schema.offers, eq(schema.offers.id, schema.leads.offerId))
      .innerJoin(schema.categories, eq(schema.categories.id, schema.offers.categoryId))
      .innerJoin(schema.users, eq(schema.users.id, schema.leads.userId))
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.leads.userId))
      .where(
        and(
          eq(schema.leads.businessId, businessId),
          query.venueId ? eq(schema.leads.venueId, query.venueId) : undefined,
          query.status ? eq(schema.leads.status, query.status) : undefined,
        ),
      )
      .orderBy(desc(schema.leads.updatedAt))
      .limit(query.limit);

    return {
      items: rows.map(({ lead, firstName, email, offerTitle, categoryName }) => ({
        id: lead.id,
        status: lead.status,
        // Only a first name is exposed; the venue needs to greet them, not
        // profile them.
        firstName: firstName ?? 'Invité',
        offerTitle,
        categoryName,
        visitedAt: lead.visitedAt?.toISOString() ?? null,
        continuation: lead.continuation,
        rating: lead.rating,
        // The email appears only once the user has explicitly consented.
        contactEmail: lead.contactConsentAt ? email : null,
        contactPhone: null,
        notes: lead.notes,
        convertedAt: lead.convertedAt?.toISOString() ?? null,
        attributedRevenue:
          lead.attributedRevenueAmount === null
            ? null
            : money(lead.attributedRevenueAmount, lead.currency as CurrencyCode),
        updatedAt: lead.updatedAt.toISOString(),
      })),
      nextCursor: null,
    };
  }

  /**
   * Updates a lead's pipeline status. Marking CONVERTED is the event the whole
   * business model rests on, so it also feeds the offer's conversion counter that
   * discovery ranking reads.
   */
  async updateLead(input: {
    actor: AuthenticatedUser;
    businessId: string;
    leadId: string;
    dto: UpdateLeadDto;
  }): Promise<LeadDto> {
    const now = this.clock.now();

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.leads)
        .where(and(eq(schema.leads.id, input.leadId), eq(schema.leads.businessId, input.businessId)))
        .for('update')
        .limit(1);

      if (!existing) throw ApiException.notFound('lead', input.leadId);

      const becomingConverted =
        input.dto.status === 'CONVERTED' && existing.status !== 'CONVERTED';

      // RETURNING keeps the write and the response in the same statement, in
      // the same transaction: no second query can observe a snapshot older
      // than what was just written, and nothing after this point can 404 and
      // roll the write back away from under the caller.
      const [updated] = await tx
        .update(schema.leads)
        .set({
          status: input.dto.status ?? existing.status,
          notes: input.dto.notes === undefined ? existing.notes : input.dto.notes,
          attributedRevenueAmount:
            input.dto.attributedRevenueAmount === undefined
              ? existing.attributedRevenueAmount
              : input.dto.attributedRevenueAmount,
          contactedAt:
            input.dto.status === 'CONTACTED' && !existing.contactedAt ? now : existing.contactedAt,
          convertedAt: becomingConverted ? now : existing.convertedAt,
          lostAt: input.dto.status === 'LOST' ? now : existing.lostAt,
          updatedAt: now,
        })
        .where(eq(schema.leads.id, input.leadId))
        .returning();

      // Cannot happen: we hold the row lock from the SELECT ... FOR UPDATE
      // above, inside the same transaction. Guarded anyway so a future change
      // to that invariant fails loudly instead of producing `undefined`.
      if (!updated) throw ApiException.notFound('lead', input.leadId);

      if (becomingConverted) {
        await tx
          .update(schema.offers)
          .set({ conversionCount: sql`${schema.offers.conversionCount} + 1` })
          .where(eq(schema.offers.id, existing.offerId));
      }

      await this.audit.record(tx, {
        actorId: input.actor.id,
        actorType: 'BUSINESS_MEMBER',
        action: 'lead.update',
        entityType: 'lead',
        entityId: input.leadId,
        metadata: { from: existing.status, to: input.dto.status ?? existing.status },
      });

      // Same transaction as the write above — never a second, unguarded
      // round trip that could see a different (or absent) row.
      const [display] = await tx
        .select({
          firstName: schema.profiles.firstName,
          email: schema.users.email,
          offerTitle: schema.offers.title,
          categoryName: schema.categories.name,
        })
        .from(schema.leads)
        .innerJoin(schema.offers, eq(schema.offers.id, schema.leads.offerId))
        .innerJoin(schema.categories, eq(schema.categories.id, schema.offers.categoryId))
        .innerJoin(schema.users, eq(schema.users.id, schema.leads.userId))
        .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.leads.userId))
        .where(eq(schema.leads.id, input.leadId));

      // Emitted last, and only here: every write and read this transaction
      // needs has already succeeded by this point, so nothing that follows can
      // still roll it back. `DomainEvents.emit` dispatches to listeners
      // synchronously (see domain-events.ts) — firing it any earlier, before
      // the audit insert or this re-read, would let a later failure roll back
      // the conversion while an event announcing it had already gone out.
      if (becomingConverted) {
        this.events.emit('LeadConverted', {
          leadId: existing.id,
          businessId: input.businessId,
          revenueMinor: input.dto.attributedRevenueAmount ?? 0,
        });
      }

      return {
        id: updated.id,
        status: updated.status,
        firstName: display?.firstName ?? 'Invité',
        offerTitle: display?.offerTitle ?? '',
        categoryName: display?.categoryName ?? '',
        visitedAt: updated.visitedAt?.toISOString() ?? null,
        continuation: updated.continuation,
        rating: updated.rating,
        contactEmail: updated.contactConsentAt ? (display?.email ?? null) : null,
        contactPhone: null,
        notes: updated.notes,
        convertedAt: updated.convertedAt?.toISOString() ?? null,
        attributedRevenue:
          updated.attributedRevenueAmount === null
            ? null
            : money(updated.attributedRevenueAmount, updated.currency as CurrencyCode),
        updatedAt: updated.updatedAt.toISOString(),
      };
    });
  }

  /**
   * The timezone that decides what "today" means for the front desk.
   *
   * A specific venue always wins. Without one, we fall back to the first venue
   * on the business — every launch venue is in Belgium today, so this never
   * diverges in practice, but a business spanning timezones would need the
   * caller to pass `venueId` explicitly rather than relying on this fallback.
   */
  private async resolveVenueTimeZone(
    businessId: string,
    venueId: string | undefined,
  ): Promise<IanaTimeZone> {
    const [venue] = await this.db
      .select({ timeZone: schema.venues.timeZone })
      .from(schema.venues)
      .where(
        and(
          eq(schema.venues.businessId, businessId),
          venueId ? eq(schema.venues.id, venueId) : undefined,
        ),
      )
      .limit(1);

    return venue?.timeZone ?? DEFAULT_TIME_ZONE;
  }

  private async resolveFirstVisits(
    pairs: { userId: string; venueId: string }[],
  ): Promise<Set<string>> {
    if (pairs.length === 0) return new Set();

    const rows = (await this.db.execute(sql`
      SELECT r.user_id, r.venue_id, COUNT(c.id)::int AS visit_count
      FROM reservations r
      LEFT JOIN check_ins c ON c.reservation_id = r.id
      WHERE (r.user_id, r.venue_id) IN (
        ${sql.join(
          pairs.map((pair) => sql`(${pair.userId}::uuid, ${pair.venueId}::uuid)`),
          sql`, `,
        )}
      )
      GROUP BY r.user_id, r.venue_id
    `)) as unknown as { user_id: string; venue_id: string; visit_count: number }[];

    const firstVisits = new Set<string>();
    for (const row of rows) {
      if (row.visit_count <= 1) firstVisits.add(`${row.user_id}:${row.venue_id}`);
    }
    return firstVisits;
  }
}
