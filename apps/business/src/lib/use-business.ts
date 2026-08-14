'use client';

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import { api } from './api';

/**
 * The business the signed-in member is acting for.
 *
 * Read from the verified session rather than from a URL or localStorage: the API
 * re-checks membership on every call regardless, but the UI should never even
 * offer an id the user has no claim to.
 */
export function useBusinessId(): string | null {
  const { data } = useQuery({
    queryKey: queryKeys.viewer,
    queryFn: () => api.auth.me(),
    retry: false,
  });

  return data?.businessMemberships[0]?.businessId ?? null;
}

export function useBusinessRole(): 'OWNER' | 'MANAGER' | 'STAFF' | null {
  const { data } = useQuery({
    queryKey: queryKeys.viewer,
    queryFn: () => api.auth.me(),
    retry: false,
  });

  return data?.businessMemberships[0]?.role ?? null;
}
