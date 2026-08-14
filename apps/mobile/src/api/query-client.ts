import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@try/api-client';

/**
 * Query defaults tuned for a mobile network, not a datacentre.
 *
 * Discovery data is stale-tolerant: showing yesterday's offer list instantly and
 * revalidating behind it is a far better experience than a spinner on a train.
 * Availability is not — it is refetched aggressively because a stale slot leads
 * the user into a booking that fails.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 24 * 3_600_000,
      retry: (failureCount, error) => {
        // Retrying a 404 or a validation error just delays the inevitable.
        if (error instanceof ApiError && !error.isRetryable) return false;
        return failureCount < 2;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
    mutations: {
      // Never blind-retry a mutation: bookings and payments are not idempotent
      // unless the caller supplied a key, and TanStack cannot know if it did.
      retry: false,
    },
  },
});

/** Availability changes minute to minute; treat it as always stale. */
export const AVAILABILITY_QUERY_OPTIONS = {
  staleTime: 0,
  refetchOnMount: 'always',
  refetchInterval: 60_000,
} as const;
