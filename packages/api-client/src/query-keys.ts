/**
 * Centralised TanStack Query keys.
 *
 * Keys defined ad hoc at call sites drift, and then an invalidation silently
 * misses a cache entry — which shows up as a booking that stays "upcoming" after
 * it was cancelled. Hierarchical arrays let a mutation invalidate a whole subtree.
 */
export const queryKeys = {
  viewer: ['viewer'] as const,

  discovery: {
    all: ['discovery'] as const,
    home: (input: { latitude?: number; longitude?: number; cityId?: string }) =>
      ['discovery', 'home', input] as const,
    search: (filters: Record<string, unknown>) => ['discovery', 'search', filters] as const,
    map: (bounds: Record<string, number>) => ['discovery', 'map', bounds] as const,
  },

  offers: {
    all: ['offers'] as const,
    detail: (offerId: string) => ['offers', 'detail', offerId] as const,
    availability: (offerId: string) => ['offers', 'availability', offerId] as const,
  },

  bookings: {
    all: ['bookings'] as const,
    list: (scope: string) => ['bookings', 'list', scope] as const,
    detail: (bookingId: string) => ['bookings', 'detail', bookingId] as const,
  },

  favorites: ['favorites'] as const,

  notifications: {
    all: ['notifications'] as const,
    list: (unreadOnly: boolean) => ['notifications', 'list', unreadOnly] as const,
  },

  business: {
    all: ['business'] as const,
    metrics: (businessId: string, range: { from: string; to: string }) =>
      ['business', businessId, 'metrics', range] as const,
    bookings: (businessId: string, filters: Record<string, unknown>) =>
      ['business', businessId, 'bookings', filters] as const,
    leads: (businessId: string, filters: Record<string, unknown>) =>
      ['business', businessId, 'leads', filters] as const,
  },
} as const;
