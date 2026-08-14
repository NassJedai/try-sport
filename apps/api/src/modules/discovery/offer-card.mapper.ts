import { Inject, Injectable } from '@nestjs/common';
import { discountPercent, money } from '@try/utils';
import type { CurrencyCode } from '@try/utils';
import type { OfferBadge, OfferCardDto } from '@try/contracts';
import type { AppConfig } from '@try/config';
import { CONFIG } from '../../common/config.module.js';
import type { OfferCardRow } from './discovery.repository.js';

/** An offer published within this window earns the "NOUVEAU" badge. */
const NEW_OFFER_DAYS = 21;
/** Trials needed before a conversion rate is treated as meaningful. */
const POPULAR_MIN_TRIALS = 25;

@Injectable()
export class OfferCardMapper {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  toCard(row: OfferCardRow, now: Date): OfferCardDto {
    const currency = row.currency as CurrencyCode;
    const price = money(row.price_amount, currency);
    const reference =
      row.reference_price_amount !== null && row.reference_price_amount > row.price_amount
        ? money(row.reference_price_amount, currency)
        : null;

    return {
      id: row.id,
      title: row.title,
      experienceType: row.experience_type as OfferCardDto['experienceType'],
      image: this.buildImage(row),
      price,
      referencePrice: reference,
      // Recomputed from the two prices; never read from a client or a stale column.
      discountPercent: reference ? discountPercent(reference, price) : 0,
      badges: this.buildBadges(row, now),
      durationMinutes: row.duration_minutes,
      venue: {
        id: row.venue_id,
        name: row.venue_name,
        districtName: row.district_name,
        coordinates: { latitude: row.venue_latitude, longitude: row.venue_longitude },
      },
      distanceMeters: row.distance_meters === null ? null : Math.round(row.distance_meters),
      // Stored as hundredths to keep the column integral; presented as 0–5.
      averageRating: row.average_rating === null ? null : row.average_rating / 100,
      reviewCount: row.review_count,
      nextSlotAt: row.next_slot_at ? new Date(row.next_slot_at).toISOString() : null,
    };
  }

  private buildBadges(row: OfferCardRow, now: Date): OfferBadge[] {
    const badges: OfferBadge[] = [];

    if (row.price_amount === 0) {
      badges.push('FREE');
    } else if (
      row.reference_price_amount !== null &&
      row.reference_price_amount > row.price_amount
    ) {
      badges.push('DISCOVERY_PRICE');
    }

    if (row.published_at) {
      const ageDays = (now.getTime() - new Date(row.published_at).getTime()) / 86_400_000;
      if (ageDays <= NEW_OFFER_DAYS) badges.push('NEW');
    }

    /**
     * "Populaire" is earned on conversion, not on booking volume. Badging raw
     * trial counts would promote whatever is cheapest rather than what is good.
     */
    if (row.trial_count >= POPULAR_MIN_TRIALS && row.conversion_count / row.trial_count >= 0.2) {
      badges.push('POPULAR');
    }

    return badges;
  }

  /**
   * Composes CDN URLs from the stored key. Variants exist so a feed never
   * downloads a 4000×3000 original to draw a 160px tile.
   */
  private buildImage(row: OfferCardRow): OfferCardDto['image'] {
    if (!row.image_key) return null;
    const base = this.config.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, '');
    return {
      thumbnail: `${base}/${row.image_key}?w=400&q=70&fm=webp`,
      medium: `${base}/${row.image_key}?w=800&q=75&fm=webp`,
      large: `${base}/${row.image_key}?w=1600&q=80&fm=webp`,
      blurhash: row.image_blurhash,
      width: row.image_width ?? 1600,
      height: row.image_height ?? 1200,
    };
  }
}
