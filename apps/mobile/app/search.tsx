import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import { radius, spacing, typography } from '@try/design-tokens';
import { api } from '@/api/client';
import { useTheme } from '@/theme';
import { usePreferences } from '@/store/preferences';
import { OfferCard } from '@/components/OfferCard';
import { OfferCardSkeleton } from '@/components/Skeleton';
import { EmptyState, ErrorState } from '@/components/States';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

export default function SearchScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const coordinates = usePreferences((state) => state.coordinates);
  const filters = usePreferences((state) => state.filters);

  // Debounced so a query is not issued on every keystroke.
  const debouncedQuery = useDebouncedValue(query, 300);

  const searchInput = {
    q: debouncedQuery.trim() || undefined,
    latitude: coordinates?.latitude,
    longitude: coordinates?.longitude,
    radiusMeters: filters.radiusMeters,
    freeOnly: filters.freeOnly,
    maxPrice: filters.maxPrice,
    sort: filters.sort,
  };

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.discovery.search(searchInput),
    queryFn: () => api.discovery.search(searchInput),
  });

  return (
    <View style={[styles.fill, { backgroundColor: theme.background, paddingTop: insets.top + spacing.base }]}>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Pilates, boxe, padel, Ixelles…"
        placeholderTextColor={theme.textTertiary}
        autoFocus
        returnKeyType="search"
        accessibilityLabel="Rechercher une activité"
        style={[styles.input, { backgroundColor: theme.surfaceMuted, color: theme.textPrimary }]}
      />

      {isLoading ? (
        <View style={styles.list}>
          <OfferCardSkeleton />
          <OfferCardSkeleton />
        </View>
      ) : isError ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (data?.items.length ?? 0) === 0 ? (
        <EmptyState
          emoji="🔍"
          title="Aucun résultat"
          message={
            debouncedQuery
              ? `Rien ne correspond à « ${debouncedQuery} ». Essaie un autre terme ou élargis ta zone.`
              : 'Commence à taper pour trouver une activité.'
          }
        />
      ) : (
        <FlashList
          data={data?.items ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: spacing.base }}
          ItemSeparatorComponent={() => <View style={{ height: spacing.base }} />}
          renderItem={({ item, index }) => (
            <OfferCard offer={item} section="search" position={index} />
          )}
          ListHeaderComponent={
            <Text style={[styles.count, { color: theme.textSecondary }]}>
              {data?.items.length} résultat{(data?.items.length ?? 0) > 1 ? 's' : ''}
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  input: {
    marginHorizontal: spacing.base,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    fontSize: typography.body.fontSize,
    minHeight: 52,
  },
  list: { padding: spacing.base, gap: spacing.base },
  count: { fontSize: typography.footnote.fontSize, marginBottom: spacing.md },
});
