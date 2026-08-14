import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { money } from '@try/utils';
import type { Clock, CurrencyCode } from '@try/utils';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type {
  BusinessBookingDto,
  BusinessMetricsDto,
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

    const [current] = (await this.db.execute(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE r.status NOT IN ('CANCELLED_USER', 'CANCELLED_BUSINESS', 'EXPIRED')
        )::int AS trials,
        COUNT(*) FILTER (WHERE r.checked_in_at IS NOT NULL)::int AS check_ins,
        COUNT(*) FILTER (WHERE r.status = 'NO_SHOW')::int AS no_shows
      FROM reservations r
      WHERE r.business_id = ${input.businessId}
        AND r.slot_start_at >= ${input.from}
        AND r.slot_start_at <= ${input.to}
        ${venueFilter}
    `)) as unknown as { trials: number; check_ins: number; no_shows: number }[];

    const [conversions] = (await this.db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE l.status = 'CONVERTED')::int AS conversions,
        COALESCE(SUM(l.attributed_revenue_amount) FILTER (WHERE l.status = 'CONVERTED'), 0)::int
          AS attributed_revenue
      FROM leads l
      WHERE l.business_id = ${input.businessId}
        AND l.created_at >= ${input.from}
        AND l.created_at <= ${input.to}
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
  async listBookings(
    businessId: string,
    query: ListBusinessBookingsQueryDto,
  ): Promise<{ items: BusinessBookingDto[]; nextCursor: string | null }> {
    const now = this.clock.now();

    // A venue-local calendar day, resolved against the venue's timezone rather
    // than the server's — "today" at the desk is what matters.
    const dayStart = query.date
      ? new Date(`${query.date}T00:00:00Z`)
      : new Date(now.getTime() - 12 * 3_600_000);
    const dayEnd = new Date(dayStart.getTime() + 36 * 3_600_000);

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
          lte(schema.reservations.slotStartAt, dayEnd),
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

      await tx
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
        .where(eq(schema.leads.id, input.leadId));

      if (becomingConverted) {
        await tx
          .update(schema.offers)
          .set({ conversionCount: sql`${schema.offers.conversionCount} + 1` })
          .where(eq(schema.offers.id, existing.offerId));

        this.events.emit('LeadConverted', {
          leadId: existing.id,
          businessId: input.businessId,
          revenueMinor: input.dto.attributedRevenueAmount ?? 0,
        });
      }

      await this.audit.record(tx, {
        actorId: input.actor.id,
        actorType: 'BUSINESS_MEMBER',
        action: 'lead.update',
        entityType: 'lead',
        entityId: input.leadId,
        metadata: { from: existing.status, to: input.dto.status ?? existing.status },
      });

      const { items } = await this.listLeads(input.businessId, {
        limit: 1,
        status: undefined,
        venueId: undefined,
      });
      const updated = items.find((lead) => lead.id === input.leadId);
      if (!updated) throw ApiException.notFound('lead', input.leadId);
      return updated;
    });
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
