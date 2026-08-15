import { useCallback } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import type { DiscoverySectionDto } from '@try/contracts';
import { spacing, typography } from '@try/design-tokens';
import { api } from '@/api/client';
import { useTheme } from '@/theme';
import { usePreferences } from '@/store/preferences';
import { OfferCard } from '@/components/OfferCard';
import { SectionSkeleton } from '@/components/Skeleton';
import { EmptyState, ErrorState } from '@/components/States';
import { NotificationBell } from '@/components/NotificationBell';

/**
 * The discovery home.
 *
 * One aggregating request builds the entire screen. Eight parallel section
 * requests would each pay mobile-network latency before anything could paint;
 * this way the first meaningful render is a single round trip.
 */
export default function ExploreScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const coordinates = usePreferences((state) => state.coordinates);
  const cityId = usePreferences((state) => state.cityId);

  const queryInput = {
    latitude: coordinates?.latitude,
    longitude: coordinates?.longitude,
    cityId: cityId ?? undefined,
  };

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: queryKeys.discovery.home(queryInput),
    queryFn: () => api.discovery.home(queryInput),
    // Cached home content is shown immediately on cold start and revalidated
    // behind it, so the app opens to content rather than to a spinner.
    staleTime: 5 * 60_000,
  });

  const handleSearch = useCallback(() => router.push('/search'), [router]);

  if (isLoading) {
    return (
      <ScrollView
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={{ paddingTop: insets.top + spacing.base }}
      >
        <View style={styles.header}>
          <Text style={[styles.city, { color: theme.textSecondary }]}>Chargement…</Text>
          <Text style={[styles.prompt, { color: theme.textPrimary }]}>Que veux-tu essayer ?</Text>
        </View>
        <SectionSkeleton />
        <SectionSkeleton />
      </ScrollView>
    );
  }

  if (isError) {
    return (
      <View style={[styles.fill, { backgroundColor: theme.background }]}>
        <ErrorState error={error} onRetry={() => void refetch()} />
      </View>
    );
  }

  const sections = data?.sections ?? [];

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={{
        paddingTop: insets.top + spacing.base,
        paddingBottom: spacing.xxxl,
      }}
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />
      }
      // Progressive rendering: sections below the fold mount as they approach.
      removeClippedSubviews
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={[styles.city, { color: theme.textSecondary }]}>{data?.cityName}</Text>
          <Text
            style={[styles.prompt, { color: theme.textPrimary }]}
            accessibilityRole="header"
          >
            Que veux-tu essayer ?
          </Text>
        </View>
        <NotificationBell />
      </View>

      <Text
        onPress={handleSearch}
        accessibilityRole="search"
        style={[
          styles.searchBar,
          { backgroundColor: theme.surfaceMuted, color: theme.textTertiary },
        ]}
      >
        Rechercher une activité, un lieu…
      </Text>

      {sections.length === 0 ? (
        <EmptyState
          emoji="🔍"
          title="Rien à essayer pour l’instant"
          message="Aucune expérience disponible autour de toi. Élargis ta zone de recherche pour voir plus de résultats."
          actionLabel="Élargir la recherche"
          onAction={handleSearch}
        />
      ) : (
        sections.map((section) => <Section key={section.key} section={section} />)
      )}
    </ScrollView>
  );
}

function Section({ section }: { section: DiscoverySectionDto }) {
  const theme = useTheme();

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text
          style={[styles.sectionTitle, { color: theme.textPrimary }]}
          accessibilityRole="header"
        >
          {section.title}
        </Text>
        {section.subtitle && (
          <Text style={[styles.sectionSubtitle, { color: theme.textSecondary }]}>
            {section.subtitle}
          </Text>
        )}
      </View>

      <View style={styles.cards}>
        {section.offers.map((offer, index) => (
          <OfferCard key={offer.id} offer={offer} section={section.key} position={index} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.base,
    marginBottom: spacing.base,
  },
  // La colonne de texte prend la place restante : sans `flex: 1`, une longue
  // ville pousserait la cloche hors de l'écran.
  headerText: { flex: 1 },
  city: {
    fontSize: typography.footnote.fontSize,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  prompt: {
    fontSize: typography.display.fontSize,
    lineHeight: typography.display.lineHeight,
    fontWeight: '700',
    marginTop: spacing.xs,
  },
  searchBar: {
    marginHorizontal: spacing.base,
    marginBottom: spacing.xl,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    borderRadius: 14,
    fontSize: typography.body.fontSize,
    overflow: 'hidden',
  },
  section: { marginBottom: spacing.xxl },
  sectionHeader: { paddingHorizontal: spacing.base, marginBottom: spacing.md },
  sectionTitle: {
    fontSize: typography.title2.fontSize,
    lineHeight: typography.title2.lineHeight,
    fontWeight: '700',
  },
  sectionSubtitle: { fontSize: typography.footnote.fontSize, marginTop: spacing.xxs },
  cards: { paddingHorizontal: spacing.base, gap: spacing.base },
});
