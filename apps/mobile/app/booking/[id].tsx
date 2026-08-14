import { useEffect } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import { formatDateInZone, formatMoney, formatTimeInZone } from '@try/utils';
import { radius, spacing, typography } from '@try/design-tokens';
import { api } from '@/api/client';
import { useTheme } from '@/theme';
import { Button } from '@/components/Button';
import { Skeleton } from '@/components/Skeleton';
import { ErrorState } from '@/components/States';

export default function BookingDetailScreen() {
  const { id, created } = useLocalSearchParams<{ id: string; created?: string }>();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const justCreated = created === '1';

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.bookings.detail(id),
    queryFn: () => api.bookings.detail(id),
  });

  useEffect(() => {
    /**
     * A single success haptic on confirmation. Restrained on purpose — the
     * moment deserves acknowledgement, not confetti on every screen.
     */
    if (justCreated) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [justCreated]);

  const cancel = useMutation({
    mutationFn: () => api.bookings.cancel(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.bookings.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.offers.all });
      router.back();
    },
  });

  if (isLoading) {
    return (
      <View style={[styles.fill, { backgroundColor: theme.background, padding: spacing.base }]}>
        <Skeleton height={120} />
        <Skeleton height={200} style={{ marginTop: spacing.base }} />
      </View>
    );
  }

  if (isError || !data) {
    return (
      <View style={[styles.fill, { backgroundColor: theme.background }]}>
        <ErrorState error={error} onRetry={() => void refetch()} />
      </View>
    );
  }

  const startAt = new Date(data.slot.startAt);
  const timeZone = data.venue.timeZone;
  const isConfirmed = data.status === 'CONFIRMED' || data.status === 'CHECKED_IN';

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={{
        paddingTop: insets.top + spacing.base,
        paddingBottom: insets.bottom + spacing.xxl,
        paddingHorizontal: spacing.base,
      }}
    >
      {justCreated && (
        <View
          style={[styles.confirmation, { backgroundColor: theme.successSubtle }]}
          accessibilityRole="alert"
        >
          <Text style={styles.confirmationEmoji} accessible={false}>
            ✓
          </Text>
          <Text style={[styles.confirmationTitle, { color: theme.success }]}>
            C’est réservé
          </Text>
          <Text style={[styles.confirmationBody, { color: theme.textSecondary }]}>
            Tu recevras un rappel avant ta séance.
          </Text>
        </View>
      )}

      <Text style={[styles.title, { color: theme.textPrimary }]} accessibilityRole="header">
        {data.offer.title}
      </Text>
      <Text style={[styles.venue, { color: theme.textSecondary }]}>{data.venue.name}</Text>

      <View style={[styles.card, { backgroundColor: theme.surfaceMuted }]}>
        <Row label="Quand" value={`${formatDateInZone(startAt, timeZone)} · ${formatTimeInZone(startAt, timeZone)}`} />
        <Row label="Où" value={`${data.venue.addressLine}, ${data.venue.cityName}`} />
        <Row label="Durée" value={`${data.offer.durationMinutes} min`} />
        <Row
          label="Prix"
          value={formatMoney(data.price, { freeLabel: 'Gratuit', compactWholeAmounts: true })}
        />
        <Row label="Statut" value={statusLabel(data.status)} />
      </View>

      {data.checkIn && isConfirmed && (
        <View style={[styles.card, { backgroundColor: theme.accentSubtle }]}>
          <Text style={[styles.checkInTitle, { color: theme.textPrimary }]}>
            Ton code d’entrée
          </Text>
          <Text
            style={[styles.code, { color: theme.textPrimary }]}
            accessibilityLabel={`Code d'entrée ${data.checkIn.shortCode.split('').join(' ')}`}
          >
            {data.checkIn.shortCode}
          </Text>
          <Button
            label="Afficher le QR code"
            variant="secondary"
            onPress={() =>
              router.push({ pathname: '/booking/[id]/qr', params: { id: data.id } })
            }
          />
        </View>
      )}

      {data.cancellation.canCancel && (
        <View style={styles.cancelBlock}>
          <Text style={[styles.policy, { color: theme.textTertiary }]}>
            {data.cancellation.policyLabel}
            {!data.cancellation.refundable && data.price.amount > 0
              ? ' Passé ce délai, la séance n’est plus remboursée.'
              : ''}
          </Text>
          <Button
            label="Annuler ma réservation"
            variant="ghost"
            onPress={() => cancel.mutate()}
            loading={cancel.isPending}
            haptic="none"
          />
        </View>
      )}

      {data.review?.canReview && (
        <Button
          label="Laisser un avis"
          onPress={() => router.push({ pathname: '/booking/[id]/review', params: { id: data.id } })}
          style={{ marginTop: spacing.base }}
        />
      )}
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: theme.textTertiary }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: theme.textPrimary }]}>{value}</Text>
    </View>
  );
}

function statusLabel(status: string): string {
  return (
    {
      PENDING: 'En attente',
      PAYMENT_PENDING: 'Paiement en attente',
      CONFIRMED: 'Confirmée',
      CHECKED_IN: 'Enregistrée sur place',
      COMPLETED: 'Terminée',
      CANCELLED_USER: 'Annulée',
      CANCELLED_BUSINESS: 'Annulée par le lieu',
      NO_SHOW: 'Absence',
      REFUNDED: 'Remboursée',
      EXPIRED: 'Expirée',
    }[status] ?? status
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  confirmation: {
    borderRadius: radius.xl,
    padding: spacing.xl,
    alignItems: 'center',
    marginBottom: spacing.xl,
    gap: spacing.xs,
  },
  confirmationEmoji: { fontSize: 32 },
  confirmationTitle: { fontSize: typography.title2.fontSize, fontWeight: '700' },
  confirmationBody: { fontSize: typography.footnote.fontSize, textAlign: 'center' },
  title: {
    fontSize: typography.title1.fontSize,
    lineHeight: typography.title1.lineHeight,
    fontWeight: '700',
  },
  venue: { fontSize: typography.callout.fontSize, marginTop: spacing.xxs },
  card: {
    borderRadius: radius.lg,
    padding: spacing.base,
    marginTop: spacing.lg,
    gap: spacing.md,
  },
  row: { gap: spacing.xxs },
  rowLabel: { fontSize: typography.caption.fontSize, textTransform: 'uppercase' },
  rowValue: { fontSize: typography.body.fontSize, fontWeight: '500' },
  checkInTitle: { fontSize: typography.title3.fontSize, fontWeight: '700' },
  code: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 4,
    textAlign: 'center',
    marginVertical: spacing.md,
    fontVariant: ['tabular-nums'],
  },
  cancelBlock: { marginTop: spacing.xxl, gap: spacing.sm },
  policy: { fontSize: typography.footnote.fontSize, textAlign: 'center' },
});
