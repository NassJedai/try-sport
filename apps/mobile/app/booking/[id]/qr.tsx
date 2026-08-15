import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Platform } from 'react-native';
import * as Brightness from 'expo-brightness';
import { queryKeys } from '@try/api-client';
import { radius, spacing, typography } from '@try/design-tokens';
import { api } from '@/api/client';
import { useTheme } from '@/theme';
import { Skeleton } from '@/components/Skeleton';
import { ErrorState } from '@/components/States';
import { QrCode } from '@/components/QrCode';

/**
 * The QR screen shown at the venue door.
 *
 * Presented as a modal on a white card regardless of theme: a dark-mode QR on an
 * OLED screen at low brightness is exactly what a scanner struggles with, and the
 * user is standing at a desk with someone waiting.
 */
export default function BookingQrScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.bookings.detail(id),
    queryFn: () => api.bookings.detail(id),
  });

  useEffect(() => {
    // Raise brightness while the code is on screen, and restore it on exit.
    let previous: number | null = null;

    // Pas de contrôle de luminosité dans un navigateur : le module n'existe pas
    // sur le web et l'appel ferait planter l'écran d'aperçu.
    if (Platform.OS === 'web') return;

    void (async () => {
      const { status } = await Brightness.requestPermissionsAsync();
      if (status !== 'granted') return;
      previous = await Brightness.getBrightnessAsync();
      await Brightness.setBrightnessAsync(1);
    })();

    return () => {
      if (previous !== null) void Brightness.setBrightnessAsync(previous);
    };
  }, []);

  if (isLoading) {
    return (
      <View style={[styles.fill, { backgroundColor: theme.background }]}>
        <Skeleton height={280} width={280} />
      </View>
    );
  }

  if (isError || !data?.checkIn) {
    return (
      <View style={[styles.fill, { backgroundColor: theme.background }]}>
        <ErrorState
          error={error ?? new Error('no check-in token')}
          onRetry={() => void refetch()}
        />
      </View>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: theme.background }]}>
      <Text style={[styles.title, { color: theme.textPrimary }]} accessibilityRole="header">
        {data.offer.title}
      </Text>
      <Text style={[styles.venue, { color: theme.textSecondary }]}>{data.venue.name}</Text>

      <View style={styles.card}>
        <QrCode value={data.checkIn.qrToken} size={240} />
      </View>

      <Text style={[styles.orLabel, { color: theme.textTertiary }]}>
        ou communique ce code
      </Text>
      <Text
        style={[styles.code, { color: theme.textPrimary }]}
        accessibilityLabel={`Code ${data.checkIn.shortCode.split('').join(' ')}`}
      >
        {data.checkIn.shortCode}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  title: {
    fontSize: typography.title2.fontSize,
    fontWeight: '700',
    textAlign: 'center',
  },
  venue: { fontSize: typography.callout.fontSize, marginBottom: spacing.lg },
  card: {
    // Always white: scanners need the contrast, whatever theme the user is in.
    backgroundColor: '#FFFFFF',
    padding: spacing.lg,
    borderRadius: radius.xl,
  },
  orLabel: {
    fontSize: typography.footnote.fontSize,
    marginTop: spacing.xl,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  code: {
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: 4,
    fontVariant: ['tabular-nums'],
  },
});
