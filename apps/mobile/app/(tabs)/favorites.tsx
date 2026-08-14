import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@try/api-client';
import { spacing } from '@try/design-tokens';
import { useTheme } from '@/theme';
import { favoritesQueryOptions } from '@/hooks/use-favorite';
import { OfferCard } from '@/components/OfferCard';
import { OfferCardSkeleton } from '@/components/Skeleton';
import { EmptyState, ErrorState } from '@/components/States';

export default function FavoritesScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const { data, isLoading, isError, error, refetch } = useQuery({
    ...favoritesQueryOptions(),
    retry: false,
  });

  // Being signed out is a normal state here, not a failure worth retrying.
  const isAnonymous = isError && error instanceof ApiError && error.isAuthError;

  return (
    <View
      style={[
        styles.fill,
        { backgroundColor: theme.background, paddingTop: insets.top + spacing.base },
      ]}
    >
      {isLoading ? (
        <View style={styles.list}>
          <OfferCardSkeleton />
          <OfferCardSkeleton />
        </View>
      ) : isAnonymous ? (
        <EmptyState
          emoji="♥"
          title="Retrouve tes favoris"
          message="Connecte-toi pour enregistrer des expériences et les retrouver sur tous tes appareils."
          actionLabel="Se connecter"
          onAction={() => router.push('/(auth)/sign-in')}
        />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (data?.items.length ?? 0) === 0 ? (
        <EmptyState
          emoji="♥"
          title="Aucun favori"
          message="Enregistre les expériences qui t’intéressent pour les retrouver ici."
          actionLabel="Explorer"
          onAction={() => router.push('/(tabs)')}
        />
      ) : (
        <FlashList
          data={data?.items ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: spacing.base }}
          ItemSeparatorComponent={() => <View style={{ height: spacing.base }} />}
          renderItem={({ item, index }) => (
            <OfferCard offer={item} section="favorites" position={index} />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: spacing.base, gap: spacing.base },
});
