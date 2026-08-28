import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import { radius, spacing, touchTarget, typography } from '@try/design-tokens';
import { api } from '@/api/client';
import { useTheme } from '@/theme';
import { usePreferences } from '@/store/preferences';
import { categoryEmoji } from '@/lib/category-icons';
import { OfferCard } from '@/components/OfferCard';
import { OfferCardSkeleton, Skeleton } from '@/components/Skeleton';
import { EmptyState, ErrorState } from '@/components/States';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

/**
 * La recherche, dans l'ordre d'Airbnb : on MONTRE d'abord, on tape ensuite.
 *
 * L'écran s'ouvre sur la grille des disciplines — un geste du pouce suffit pour
 * voir des résultats. Le champ texte reste là pour ce que la grille ne couvre
 * pas (un nom de salle, un quartier), mais il ne réclame jamais le clavier tout
 * seul : pas d'autoFocus. Faire surgir le clavier à l'ouverture, c'est affirmer
 * que l'utilisateur sait déjà ce qu'il cherche — la découverte, c'est
 * précisément l'inverse.
 */
export default function SearchScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ categoryId?: string }>();

  const [query, setQuery] = useState('');
  // Pré-sélection quand on arrive depuis la barre de catégories de l'accueil.
  const [selectedCategories, setSelectedCategories] = useState<string[]>(
    params.categoryId ? [params.categoryId] : [],
  );

  const coordinates = usePreferences((state) => state.coordinates);
  const filters = usePreferences((state) => state.filters);

  const debouncedQuery = useDebouncedValue(query, 300);

  // Le même appel que l'accueil : les catégories sont déjà en cache.
  const home = useQuery({
    queryKey: queryKeys.discovery.home({}),
    queryFn: () => api.discovery.home({}),
  });
  const categories = home.data?.categories ?? [];

  const hasIntent = selectedCategories.length > 0 || debouncedQuery.trim().length > 0;

  const searchInput = useMemo(
    () => ({
      q: debouncedQuery.trim() || undefined,
      categoryIds: selectedCategories.length > 0 ? selectedCategories : undefined,
      latitude: coordinates?.latitude,
      longitude: coordinates?.longitude,
      radiusMeters: filters.radiusMeters,
      freeOnly: filters.freeOnly,
      maxPrice: filters.maxPrice,
      sort: filters.sort,
    }),
    [debouncedQuery, selectedCategories, coordinates, filters],
  );

  const results = useQuery({
    queryKey: queryKeys.discovery.search(searchInput),
    queryFn: () => api.discovery.search(searchInput),
    // Pas de requête tant qu'aucune intention n'est exprimée : l'état d'entrée
    // est la grille des disciplines, pas une liste de « tout ».
    enabled: hasIntent,
  });

  const toggleCategory = useCallback((id: string) => {
    setSelectedCategories((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  }, []);

  const count = results.data?.items.length ?? 0;

  /**
   * « Padel à Paris » plutôt qu'un simple compteur (maquette « 05. Résultats »).
   * Construit uniquement à partir de données déjà en cache — `home.data` est
   * la même requête que celle qui alimente la rangée de disciplines juste
   * au-dessus, aucun appel supplémentaire.
   */
  const resultsTitle = useMemo(() => {
    const cityName = home.data?.cityName;
    if (selectedCategories.length === 1) {
      const name = categories.find((category) => category.id === selectedCategories[0])?.name;
      if (name) return cityName ? `${name} à ${cityName}` : name;
    }
    if (selectedCategories.length > 1) {
      return cityName ? `Plusieurs disciplines à ${cityName}` : 'Plusieurs disciplines';
    }
    if (debouncedQuery.trim().length > 0) {
      return `Résultats pour « ${debouncedQuery.trim()} »`;
    }
    return cityName ? `À essayer à ${cityName}` : 'Résultats';
  }, [categories, debouncedQuery, home.data?.cityName, selectedCategories]);

  return (
    <View
      style={[
        styles.fill,
        { backgroundColor: theme.background, paddingTop: insets.top + spacing.base },
      ]}
    >
      <View
        style={[styles.searchPill, { backgroundColor: theme.surface, borderColor: theme.border }]}
      >
        <Text style={styles.searchGlyph}>🔍</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Un lieu, un quartier, une activité…"
          placeholderTextColor={theme.textTertiary}
          returnKeyType="search"
          accessibilityLabel="Rechercher un lieu ou une activité"
          style={[styles.input, { color: theme.textPrimary }]}
        />
        {query.length > 0 && (
          <Pressable
            onPress={() => setQuery('')}
            accessibilityRole="button"
            accessibilityLabel="Effacer la recherche"
            hitSlop={spacing.sm}
          >
            <Text style={[styles.clearGlyph, { color: theme.textTertiary }]}>✕</Text>
          </Pressable>
        )}
      </View>

      {/* La rangée des disciplines : toujours visible, c'est LE filtre. */}
      <View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          {home.isLoading
            ? Array.from({ length: 6 }, (_, index) => (
                <Skeleton
                  key={index}
                  width={110}
                  height={touchTarget.minimum}
                  borderRadius={radius.pill}
                />
              ))
            : categories.map((category) => {
                const isSelected = selectedCategories.includes(category.id);
                return (
                  <Pressable
                    key={category.id}
                    onPress={() => toggleCategory(category.id)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: isSelected }}
                    accessibilityLabel={category.name}
                    style={[
                      styles.chip,
                      {
                        // Rempli plein lime quand sélectionné, comme "Tous" en
                        // 05.1 du design system — pas le lavis pâle utilisé
                        // avant, réservé aux surfaces non interactives.
                        backgroundColor: isSelected ? theme.accent : theme.surface,
                        borderColor: isSelected ? theme.accent : theme.border,
                      },
                    ]}
                  >
                    <Text style={styles.chipEmoji}>{categoryEmoji(category.icon)}</Text>
                    <Text
                      style={[
                        styles.chipLabel,
                        {
                          color: isSelected ? theme.onAccent : theme.textPrimary,
                          fontWeight: isSelected ? '700' : '500',
                        },
                      ]}
                      numberOfLines={1}
                    >
                      {category.name}
                    </Text>
                  </Pressable>
                );
              })}
        </ScrollView>
      </View>

      {!hasIntent ? (
        // L'état d'entrée : la grille des disciplines, grande, tapable au pouce.
        <ScrollView contentContainerStyle={styles.gridContent}>
          <Text style={[styles.gridTitle, { color: theme.textPrimary }]} accessibilityRole="header">
            Que veux-tu essayer ?
          </Text>
          <View style={styles.grid}>
            {home.isLoading
              ? Array.from({ length: 8 }, (_, index) => (
                  <View key={index} style={styles.tileHalf}>
                    <Skeleton height={96} borderRadius={radius.lg} />
                  </View>
                ))
              : categories.map((category) => (
                  <Pressable
                    key={category.id}
                    onPress={() => toggleCategory(category.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Explorer ${category.name}`}
                    style={[
                      styles.tile,
                      styles.tileHalf,
                      { backgroundColor: theme.surface, borderColor: theme.border },
                    ]}
                  >
                    <View style={[styles.tileIconBadge, { backgroundColor: theme.accentSubtle }]}>
                      <Text style={styles.tileEmoji}>{categoryEmoji(category.icon)}</Text>
                    </View>
                    <Text
                      style={[styles.tileLabel, { color: theme.textPrimary }]}
                      numberOfLines={1}
                    >
                      {category.name}
                    </Text>
                  </Pressable>
                ))}
          </View>
        </ScrollView>
      ) : results.isLoading ? (
        <View style={styles.list}>
          <OfferCardSkeleton />
          <OfferCardSkeleton />
        </View>
      ) : results.isError ? (
        <ErrorState error={results.error} onRetry={() => void results.refetch()} />
      ) : count === 0 ? (
        <EmptyState
          emoji="🔍"
          title="Aucun résultat"
          message="Rien ne correspond à ces critères pour l'instant. Essaie une autre discipline ou élargis ta zone."
          actionLabel="Tout effacer"
          onAction={() => {
            setSelectedCategories([]);
            setQuery('');
          }}
        />
      ) : (
        <FlashList
          data={results.data?.items ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: spacing.base }}
          ItemSeparatorComponent={() => <View style={{ height: spacing.base }} />}
          renderItem={({ item, index }) => (
            <OfferCard offer={item} section="search" position={index} />
          )}
          ListHeaderComponent={
            <View style={styles.resultsHeader}>
              <Text
                style={[styles.resultsTitle, { color: theme.textPrimary }]}
                accessibilityRole="header"
              >
                {resultsTitle}
              </Text>
              <Text style={[styles.count, { color: theme.textSecondary }]}>
                {count} résultat{count > 1 ? 's' : ''}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  searchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.base,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.base,
    minHeight: touchTarget.minimum + 4,
  },
  searchGlyph: { fontSize: 16 },
  clearGlyph: { fontSize: 16, fontWeight: '600' },
  input: {
    flex: 1,
    fontSize: typography.body.fontSize,
    paddingVertical: spacing.sm,
    // Explicites : dans une rangée flex, iOS peut hériter d'un rendu justifié
    // du placeholder — vu sur simulateur, lettres écartées sur toute la largeur.
    textAlign: 'left',
    letterSpacing: 0,
  },
  chipRow: {
    gap: spacing.sm,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.base,
  },
  // Pilule sur une seule ligne (icône + libellé), comme "05.1 Chips" du
  // design system — l'ancien empilement icône/libellé imitait plutôt une
  // tuile, pas un filtre.
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: touchTarget.minimum,
    borderWidth: 1.5,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
  },
  chipEmoji: { fontSize: 17 },
  chipLabel: { fontSize: typography.callout.fontSize },
  gridContent: { paddingHorizontal: spacing.base, paddingBottom: spacing.xl },
  gridTitle: {
    fontSize: typography.title3.fontSize,
    fontWeight: '700',
    marginBottom: spacing.base,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: spacing.sm,
  },
  tileHalf: { width: '48.5%' },
  tile: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingVertical: spacing.lg,
  },
  tileIconBadge: {
    width: spacing.xxxl + spacing.sm,
    height: spacing.xxxl + spacing.sm,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileEmoji: { fontSize: 26 },
  tileLabel: { fontSize: typography.callout.fontSize, fontWeight: '600' },
  list: { padding: spacing.base, gap: spacing.base },
  resultsHeader: { marginBottom: spacing.base },
  resultsTitle: {
    fontSize: typography.title2.fontSize,
    lineHeight: typography.title2.lineHeight,
    fontWeight: '700',
  },
  count: { fontSize: typography.footnote.fontSize, marginTop: spacing.xxs },
});
