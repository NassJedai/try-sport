'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@try/api-client';

export function Providers({ children }: { children: React.ReactNode }) {
  /**
   * Created inside state, not at module scope.
   *
   * A module-level QueryClient in Next.js is shared across every request on the
   * server, which would leak one venue's cached data into another's response.
   */
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: (failureCount, error) =>
              error instanceof ApiError && !error.isRetryable ? false : failureCount < 2,
            refetchOnWindowFocus: true,
          },
          mutations: { retry: false },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
