import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { OfferCardDto } from '@try/contracts';
import type { Clock } from '@try/utils';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { DiscoveryRepository } from '../discovery/discovery.repository.js';
import { OfferCardMapper } from '../discovery/offer-card.mapper.js';

@Injectable()
export class FavoriteService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly discovery: DiscoveryRepository,
    private readonly mapper: OfferCardMapper,
  ) {}

  /**
   * Idempotent toggle.
   *
   * Returns the resulting state rather than flipping blindly, so a double tap or
   * a retried request converges instead of oscillating — which matters because
   * the client updates optimistically before this call returns.
   */
  async toggle(input: { userId: string; offerId: string }): Promise<{ isFavorite: boolean }> {
    const [offer] = await this.db
      .select({ id: schema.offers.id })
      .from(schema.offers)
      .where(eq(schema.offers.id, input.offerId))
      .limit(1);

    if (!offer) throw ApiException.notFound('offer', input.offerId);

    const removed = await this.db
      .delete(schema.favorites)
      .where(
        and(
          eq(schema.favorites.userId, input.userId),
          eq(schema.favorites.offerId, input.offerId),
        ),
      )
      .returning({ offerId: schema.favorites.offerId });

    if (removed.length > 0) return { isFavorite: false };

    await this.db
      .insert(schema.favorites)
      .values({ userId: input.userId, offerId: input.offerId })
      // Two concurrent adds must settle on "favourited", not raise a conflict.
      .onConflictDoNothing();

    return { isFavorite: true };
  }

  async setFavorite(input: {
    userId: string;
    offerId: string;
    isFavorite: boolean;
  }): Promise<{ isFavorite: boolean }> {
    if (input.isFavorite) {
      await this.db
        .insert(schema.favorites)
        .values({ userId: input.userId, offerId: input.offerId })
        .onConflictDoNothing();
      return { isFavorite: true };
    }

    await this.db
      .delete(schema.favorites)
      .where(
        and(
          eq(schema.favorites.userId, input.userId),
          eq(schema.favorites.offerId, input.offerId),
        ),
      );
    return { isFavorite: false };
  }

  /**
   * Saved offers, rendered as the same card the feed uses so the favourites tab
   * is not a second, subtly different presentation of an offer.
   */
  async list(userId: string, limit = 50): Promise<{ items: OfferCardDto[] }> {
    const now = this.clock.now();

    const favorites = await this.db
      .select({ offerId: schema.favorites.offerId })
      .from(schema.favorites)
      .where(eq(schema.favorites.userId, userId))
      .orderBy(desc(schema.favorites.createdAt))
      .limit(limit);

    if (favorites.length === 0) return { items: [] };

    const rows = await this.discovery.findOffersByIds(favorites.map((row) => row.offerId));

    // Preserve "most recently saved first"; the SQL returns them unordered.
    const order = new Map(favorites.map((row, index) => [row.offerId, index]));
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

    return { items: rows.map((row) => this.mapper.toCard(row, now)) };
  }
}
