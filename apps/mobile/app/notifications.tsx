import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, queryKeys } from '@try/api-client';
import type { NotificationDto } from '@try/contracts';
import { radius, spacing, touchTarget, typography } from '@try/design-tokens';
import { api } from '@/api/client';
import { useTheme } from '@/theme';
import { Skeleton } from '@/components/Skeleton';
import { EmptyState, ErrorState } from '@/components/States';

/**
 * Le centre de notifications.
 *
 * Rien n'est marqué lu à l'ouverture de l'écran : « j'ai fait défiler jusqu'à
 * l'app » n'est pas « j'ai lu ». La lecture est déclenchée par un appui sur la
 * ligne, et le bouton « tout marquer comme lu » est là pour la vider d'un geste.
 */
export default function NotificationsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: queryKeys.notifications.list(false),
    queryFn: () => api.notifications.list(),
    retry: false,
  });

  const isAnonymous = isError && error instanceof ApiError && error.isAuthError;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
  }, [queryClient]);

  const markRead = useMutation({
    mutationFn: (id: string) => api.notifications.markRead(id),
    onSettled: invalidate,
  });

  const markAllRead = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSettled: invalidate,
  });

  const open = useCallback(
    (item: NotificationDto) => {
      if (!item.readAt) markRead.mutate(item.id);

      // Seules les cibles internes connues sont suivies. Le champ vient du
      // serveur aujourd'hui, mais une cible venue d'ailleurs ne doit jamais
      // pouvoir pousser l'app vers un écran arbitraire.
      if (item.deepLink?.startsWith('/booking/')) {
        router.push(item.deepLink as never);
      }
    },
    [markRead, router],
  );

  if (isLoading) {
    return (
      <View style={[styles.fill, { backgroundColor: theme.background, paddingTop: insets.top }]}>
        <View style={styles.list}>
          <Skeleton height={72} />
          <Skeleton height={72} />
          <Skeleton height={72} />
        </View>
      </View>
    );
  }

  if (isAnonymous) {
    return (
      <View style={[styles.fill, { backgroundColor: theme.background, paddingTop: insets.top }]}>
        <EmptyState
          emoji="🔔"
          title="Tes rappels t'attendent"
          message="Connecte-toi pour recevoir un rappel avant chaque séance."
          actionLabel="Se connecter"
          onAction={() => router.push('/(auth)/sign-in')}
        />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={[styles.fill, { backgroundColor: theme.background, paddingTop: insets.top }]}>
        <ErrorState error={error} onRetry={() => void refetch()} />
      </View>
    );
  }

  const items = data?.items ?? [];

  return (
    <View style={[styles.fill, { backgroundColor: theme.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.textPrimary }]} accessibilityRole="header">
          Notifications
        </Text>
        {(data?.unreadCount ?? 0) > 0 && (
          <Pressable
            onPress={() => markAllRead.mutate()}
            disabled={markAllRead.isPending}
            accessibilityRole="button"
            accessibilityLabel="Tout marquer comme lu"
            style={styles.markAll}
          >
            <Text style={[styles.markAllLabel, { color: theme.accentText }]}>
              Tout marquer comme lu
            </Text>
          </Pressable>
        )}
      </View>

      {items.length === 0 ? (
        <EmptyState
          emoji="🔔"
          title="Rien pour l'instant"
          message="On te préviendra la veille et deux heures avant chaque séance réservée."
          actionLabel="Explorer"
          onAction={() => router.push('/(tabs)')}
        />
      ) : (
        <FlashList
          data={items}
          keyExtractor={(item) => item.id}
          onRefresh={() => void refetch()}
          refreshing={isRefetching}
          contentContainerStyle={{ paddingHorizontal: spacing.base, paddingBottom: insets.bottom }}
          ItemSeparatorComponent={() => (
            <View style={[styles.separator, { backgroundColor: theme.border }]} />
          )}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => open(item)}
              accessibilityRole="button"
              // Le lecteur d'écran doit annoncer l'état non-lu : la pastille est
              // une information, pas une décoration, et elle est invisible pour
              // qui n'a pas l'écran sous les yeux.
              accessibilityLabel={`${item.readAt ? '' : 'Non lu. '}${item.title}. ${item.body}`}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? theme.surfaceMuted : 'transparent' },
              ]}
            >
              <View
                style={[
                  styles.dot,
                  { backgroundColor: item.readAt ? 'transparent' : theme.accentText },
                ]}
              />
              <View style={styles.rowBody}>
                <Text
                  style={[
                    styles.rowTitle,
                    { color: theme.textPrimary, fontWeight: item.readAt ? '500' : '700' },
                  ]}
                  numberOfLines={2}
                >
                  {item.title}
                </Text>
                <Text style={[styles.rowText, { color: theme.textSecondary }]} numberOfLines={3}>
                  {item.body}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: spacing.base, gap: spacing.base },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.base,
    gap: spacing.sm,
  },
  title: { fontSize: typography.title1.fontSize, fontWeight: '700' },
  markAll: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  markAllLabel: { fontSize: typography.footnote.fontSize, fontWeight: '600' },
  separator: { height: StyleSheet.hairlineWidth },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: spacing.base,
    paddingHorizontal: spacing.xs,
    minHeight: touchTarget.minimum,
    borderRadius: radius.md,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: spacing.xs },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { fontSize: typography.callout.fontSize },
  rowText: { fontSize: typography.footnote.fontSize },
});
