import { useCallback } from 'react';
import * as Haptics from 'expo-haptics';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import type { OfferCardDto, OfferDetailDto } from '@try/contracts';
import { apiClient } from '@/api/client';

/**
 * Favouriting, optimistically.
 *
 * This is the textbook case for optimistic UI: the action is trivially
 * reversible, carries no money and no capacity, and the heart must fill the
 * instant it is tapped — a 300 ms round trip before feedback makes the whole app
 * feel slow.
 *
 * Payments, capacity and booking confirmation get the opposite treatment: never
 * optimistic, because being wrong there costs the user something real.
 */
export function useFavorite(offerId: string) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (isFavorite: boolean) =>
      apiClient.post<{ isFavorite: boolean }>(`/v1/favorites/${offerId}`, { isFavorite }),

    onMutate: async (isFavorite) => {
      // Cancel in-flight refetches so a slower response cannot overwrite the
      // optimistic value after we have already applied it.
      await queryClient.cancelQueries({ queryKey: queryKeys.offers.detail(offerId) });

      const previousDetail = queryClient.getQueryData<OfferDetailDto>(
        queryKeys.offers.detail(offerId),
      );

      queryClient.setQueryData<OfferDetailDto>(queryKeys.offers.detail(offerId), (current) =>
        current ? { ...current, isFavorite } : current,
      );

      return { previousDetail };
    },

    onError: (_error, _isFavorite, context) => {
      // Roll back to exactly what was there before, not to a guessed inverse.
      if (context?.previousDetail) {
        queryClient.setQueryData(queryKeys.offers.detail(offerId), context.previousDetail);
      }
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.favorites });
    },
  });

  const toggle = useCallback(
    (currentlyFavorite: boolean) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      mutation.mutate(!currentlyFavorite);
    },
    [mutation],
  );

  return { toggle, isPending: mutation.isPending };
}

export function favoritesQueryOptions() {
  return {
    queryKey: queryKeys.favorites,
    queryFn: () => apiClient.get<{ items: OfferCardDto[] }>('/v1/favorites'),
  };
}
