import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, ilike, or, sql } from 'drizzle-orm';
import { money } from '@try/utils';
import type { CurrencyCode } from '@try/utils';
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
        slotStartAt: row.slotStartAt.toISOString(),
        price: money(row.priceAmount, row.currency as CurrencyCode),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async payments(
    actor: AuthenticatedUser,
    query: { limit: number },
  ): Promise<{
    items: {
      id: string;
      status: string;
      userEmail: string;
      businessName: string;
      amount: { amount: number; currency: string };
      platformFee: { amount: number; currency: string };
      /** Commission nette du rembourse : platformFee - refundedPlatformFee. */
      netPlatformFee: { amount: number; currency: string };
      refunded: { amount: number; currency: string };
      providerPaymentIntentId: string | null;
      createdAt: string;
    }[];
  }> {
    this.assertAdmin(actor);

    const rows = await this.db
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
      .orderBy(desc(schema.payments.createdAt))
      .limit(query.limit);

    return {
      items: rows.map((row) => {
        const currency = row.currency as CurrencyCode;
        return {
          id: row.id,
          status: row.status,
          userEmail: row.userEmail,
          businessName: row.businessName,
          amount: money(row.amount, currency),
          platformFee: money(row.platformFeeAmount, currency),
          netPlatformFee: money(row.platformFeeAmount - row.refundedPlatformFeeAmount, currency),
          refunded: money(row.refundedAmount, currency),
          providerPaymentIntentId: row.providerPaymentIntentId,
          createdAt: row.createdAt.toISOString(),
        };
      }),
    };
  }
}
