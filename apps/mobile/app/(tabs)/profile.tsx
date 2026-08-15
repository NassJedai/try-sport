import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, queryKeys } from '@try/api-client';
import { radius, spacing, typography } from '@try/design-tokens';
import { api, tokenStore } from '@/api/client';
import { useTheme } from '@/theme';
import { Button } from '@/components/Button';
import { Skeleton } from '@/components/Skeleton';

export default function ProfileScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: queryKeys.viewer,
    queryFn: () => api.auth.me(),
    // An anonymous browser is a normal state here, not an error to retry.
    retry: false,
  });

  const isAnonymous = isError && error instanceof ApiError && error.isAuthError;

  const handleSignOut = async () => {
    const refreshToken = await tokenStore.getRefreshToken();
    if (refreshToken) await api.auth.logout(refreshToken).catch(() => undefined);
    await tokenStore.clear();
    // Clearing the cache prevents the next signed-in user seeing the previous
    // account's bookings for a frame.
    queryClient.clear();
    router.replace('/(onboarding)/welcome' as never);
  };

  if (isLoading) {
    return (
      <View style={[styles.fill, { backgroundColor: theme.background, padding: spacing.base, paddingTop: insets.top + spacing.xl }]}>
        <Skeleton height={64} />
      </View>
    );
  }

  if (isAnonymous) {
    return (
      <View style={[styles.fill, styles.centered, { backgroundColor: theme.background, paddingTop: insets.top }]}>
        <Text style={[styles.title, { color: theme.textPrimary }]}>Ton profil</Text>
        <Text style={[styles.body, { color: theme.textSecondary }]}>
          Connecte-toi pour retrouver tes réservations et tes favoris sur tous tes appareils.
        </Text>
        <Button label="Se connecter" onPress={() => router.push('/(auth)/sign-in')} />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={{ padding: spacing.base, paddingTop: insets.top + spacing.xl, gap: spacing.base }}
    >
      <Text style={[styles.title, { color: theme.textPrimary }]} accessibilityRole="header">
        {data?.firstName ?? 'Ton profil'}
      </Text>
      <Text style={[styles.body, { color: theme.textSecondary }]}>{data?.email}</Text>

      <View style={[styles.card, { backgroundColor: theme.surfaceMuted }]}>
        <Text style={[styles.cardTitle, { color: theme.textPrimary }]}>Notifications</Text>
        {[
          ['Réservations', data?.notificationPreferences.bookingUpdates],
          ['Rappels', data?.notificationPreferences.reminders],
          ['Recommandations', data?.notificationPreferences.recommendations],
          ['Offres marketing', data?.notificationPreferences.marketing],
        ].map(([label, enabled]) => (
          <View key={String(label)} style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>{String(label)}</Text>
            <Text style={[styles.rowValue, { color: enabled ? theme.success : theme.textTertiary }]}>
              {enabled ? 'Activé' : 'Désactivé'}
            </Text>
          </View>
        ))}
      </View>

      <Button label="Se déconnecter" variant="ghost" haptic="none" onPress={() => void handleSignOut()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  centered: { justifyContent: 'center', padding: spacing.xl, gap: spacing.base },
  title: { fontSize: typography.title1.fontSize, fontWeight: '700' },
  body: { fontSize: typography.body.fontSize, lineHeight: typography.body.lineHeight },
  card: { borderRadius: radius.lg, padding: spacing.base, gap: spacing.md },
  cardTitle: { fontSize: typography.title3.fontSize, fontWeight: '700' },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabel: { fontSize: typography.body.fontSize },
  rowValue: { fontSize: typography.body.fontSize, fontWeight: '600' },
});
