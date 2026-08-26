import { Inject, Injectable } from '@nestjs/common';
import { DEFAULT_RANKING_WEIGHTS, scoreOffer } from '@try/contracts';
import type {
  DiscoveryHomeDto,
  DiscoveryHomeQueryDto,
  DiscoverySectionDto,
  MapOffersQueryDto,
  MapOffersResponseDto,
  OfferCardDto,
  OfferCardPageDto,
  SearchOffersQueryDto,
} from '@try/contracts';
import { decodeCursor, encodeCursor, money } from '@try/utils';
import type { Clock, CurrencyCode } from '@try/utils';
import { CLOCK } from '../../common/clock.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { DiscoveryRepository } from './discovery.repository.js';
import type { OfferCardRow } from './discovery.repository.js';
import { OfferCardMapper } from './offer-card.mapper.js';

/** How many cards each home section previews. */
const SECTION_SIZE = 10;
/** Candidate pool scored in memory before slicing into sections. */
const HOME_CANDIDATE_POOL = 120;

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly repository: DiscoveryRepository,
    private readonly mapper: OfferCardMapper,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * One call builds the entire home screen.
   *
   * The alternative — a request per section — costs eight round trips before
   * first paint on a mobile connection. Here a single candidate pool is fetched
   * and sliced in memory, so the sections are cheap and mutually consistent.
   */
  async home(
    query: DiscoveryHomeQueryDto,
    viewerId: string | null,
  ): Promise<DiscoveryHomeDto> {
    const now = this.clock.now();

    const city = await this.repository.resolveCity({
      latitude: query.latitude ?? null,
      longitude: query.longitude ?? null,
      cityId: query.cityId ?? null,
    });

    if (!city) {
      throw new ApiException('NOT_FOUND', 'Aucune ville disponible pour le moment.');
    }

    const hasPreciseLocation = query.latitude !== undefined && query.longitude !== undefined;

    const [candidates, categories, interests] = await Promise.all([
      this.repository.findOffers({
        latitude: query.latitude ?? null,
        longitude: query.longitude ?? null,
        cityId: city.id,
        radiusMeters: query.radiusMeters,
        limit: HOME_CANDIDATE_POOL,
        sort: 'RELEVANCE',
      }),
      this.repository.listCategoriesWithCounts(city.id),
      viewerId ? this.repository.findUserInterestCategorySlugs(viewerId) : Promise.resolve([]),
    ]);

    const interestSet = new Set(interests);
    const scored = this.rank(candidates, {
      now,
      radiusMeters: query.radiusMeters,
      interestSet,
    });

    const cards = scored.map((entry) => ({
      card: this.mapper.toCard(entry.row, now),
      row: entry.row,
      matchesInterest: entry.matchesInterest,
    }));

    const endOfToday = new Date(now.getTime() + 24 * 3_600_000);

    const sections: DiscoverySectionDto[] = [
      this.section('NEARBY', 'À essayer près de toi', hasPreciseLocation ? null : city.name, cards, {
        filter: (entry) => entry.card.distanceMeters !== null,
        seeAllFilter: { sort: 'DISTANCE' },
      }),
      this.section(
        'AVAILABLE_TODAY',
        'Disponible aujourd’hui',
        'Réserve pour ce soir',
        cards,
        {
          filter: (entry) =>
            entry.card.nextSlotAt !== null && new Date(entry.card.nextSlotAt) <= endOfToday,
          seeAllFilter: { sort: 'SOONEST' },
        },
      ),
      this.section('FREE_TRIALS', 'Essais gratuits', 'Zéro engagement', cards, {
        filter: (entry) => entry.card.price.amount === 0,
        seeAllFilter: { freeOnly: 'true' },
      }),
      this.section('UNDER_10', 'Moins de 10 €', null, cards, {
        filter: (entry) => entry.card.price.amount > 0 && entry.card.price.amount <= 1000,
        seeAllFilter: { maxPrice: '1000' },
      }),
      this.section('POPULAR_THIS_WEEK', 'Populaire cette semaine', null, cards, {
        filter: (entry) => entry.card.badges.includes('POPULAR'),
        seeAllFilter: { sort: 'RATING' },
      }),
      this.section('NEW', 'Nouveautés', null, cards, {
        filter: (entry) => entry.card.badges.includes('NEW'),
        seeAllFilter: null,
      }),
    ];

    // "Pour toi" only appears once we actually know something about the user;
    // an empty personalised rail is worse than no rail.
    if (interestSet.size > 0) {
      sections.unshift(
        this.section('FOR_YOU', 'Pour toi', 'D’après ce que tu aimes', cards, {
          filter: (entry) => entry.matchesInterest,
          seeAllFilter: null,
        }),
      );
    }

    return {
      cityName: city.name,
      cityId: city.id,
      sections: sections.filter((section) => section.offers.length > 0),
      categories: categories.map((category) => ({
        id: category.id,
        slug: category.slug,
        name: category.name,
        icon: category.icon,
        offerCount: category.offer_count,
      })),
      generatedAt: now.toISOString(),
    };
  }

  async search(
    query: SearchOffersQueryDto,
    viewerId: string | null,
  ): Promise<OfferCardPageDto> {
    const now = this.clock.now();

    /**
     * Offset-based paging behind an opaque cursor.
     *
     * Keyset paging is the right answer for a stable sort, but RELEVANCE ranks
     * partly in memory, so there is no single column to key on. Encoding the
     * offset keeps the client contract cursor-based, so switching to keyset later
     * is a server-side change with no client release.
     */
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const offset = cursor && typeof cursor.sortValue === 'number' ? cursor.sortValue : 0;

    const rows = await this.repository.findOffers({
      latitude: query.latitude ?? null,
      longitude: query.longitude ?? null,
      cityId: query.cityId ?? null,
      radiusMeters: query.radiusMeters ?? 10_000,
      // One extra row reveals whether another page exists, without a COUNT.
      limit: query.limit + 1,
      cursorOffset: offset,
      categoryIds: query.categoryIds,
      districtIds: query.districtIds,
      maxPrice: query.maxPrice,
      freeOnly: query.freeOnly,
      minRating: query.minRating,
      search: query.q,
      experienceTypes: query.experienceTypes,
      skillLevels: query.skillLevels,
      availableFrom: query.availableFrom ? new Date(query.availableFrom) : undefined,
      availableTo: query.availableTo ? new Date(query.availableTo) : undefined,
      sort: query.sort,
    });

    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;

    let cards = pageRows.map((row) => this.mapper.toCard(row, now));

    // Personalised re-ranking applies only to RELEVANCE; an explicit sort is a
    // user instruction and must be honoured exactly.
    if (query.sort === 'RELEVANCE' && viewerId) {
      const interests = new Set(await this.repository.findUserInterestCategorySlugs(viewerId));
      const ranked = this.rank(pageRows, {
        now,
        radiusMeters: query.radiusMeters ?? 10_000,
        interestSet: interests,
      });
      cards = ranked.map((entry) => this.mapper.toCard(entry.row, now));
    }

    return {
      items: cards,
      nextCursor: hasMore
        ? encodeCursor({ sortValue: offset + query.limit, id: 'offset' })
        : null,
    };
  }

  async map(query: MapOffersQueryDto): Promise<MapOffersResponseDto> {
    const pins = await this.repository.findMapPins({
      bounds: query.bounds,
      limit: query.limit + 1,
      categoryIds: query.categoryIds,
      maxPrice: query.maxPrice,
      freeOnly: query.freeOnly,
    });

    const truncated = pins.length > query.limit;

    return {
      pins: pins.slice(0, query.limit).map((pin) => ({
        offerId: pin.offer_id,
        venueId: pin.venue_id,
        coordinates: { latitude: pin.latitude, longitude: pin.longitude },
        price: money(pin.price_amount, pin.currency as CurrencyCode),
        isFree: pin.price_amount === 0,
        categorySlug: pin.category_slug,
      })),
      truncated,
    };
  }

  /** Applies the documented weighted score over a candidate set. */
  private rank(
    rows: OfferCardRow[],
    context: { now: Date; radiusMeters: number; interestSet: Set<string> },
  ): { row: OfferCardRow; score: number; matchesInterest: boolean }[] {
    return rows
      .map((row) => {
        const matchesInterest = context.interestSet.has(row.category_slug);
        const conversionRate =
          row.trial_count > 0 ? row.conversion_count / row.trial_count : null;

        const { total } = scoreOffer(
          {
            distanceMeters: row.distance_meters ?? context.radiusMeters,
            searchRadiusMeters: context.radiusMeters,
            matchesUserInterests: matchesInterest,
            averageRating: row.average_rating === null ? null : row.average_rating / 100,
            reviewCount: row.review_count,
            conversionRate,
            openSlotsNext7Days: row.next_slot_at ? 5 : 0,
            hasSlotToday: row.next_slot_at
              ? new Date(row.next_slot_at).getTime() - context.now.getTime() < 86_400_000
              : false,
            publishedAt: row.published_at ?? context.now,
          },
          context.now,
          DEFAULT_RANKING_WEIGHTS,
        );

        return { row, score: total, matchesInterest };
      })
      .sort((a, b) => b.score - a.score);
  }

  private section(
    key: DiscoverySectionDto['key'],
    title: string,
    subtitle: string | null,
    cards: { card: OfferCardDto; matchesInterest: boolean }[],
    options: {
      filter: (entry: { card: OfferCardDto; matchesInterest: boolean }) => boolean;
      seeAllFilter: Record<string, string> | null;
    },
  ): DiscoverySectionDto {
    return {
      key,
      title,
      subtitle,
      offers: cards.filter(options.filter).slice(0, SECTION_SIZE).map((entry) => entry.card),
      seeAllFilter: options.seeAllFilter,
    };
  }
}
