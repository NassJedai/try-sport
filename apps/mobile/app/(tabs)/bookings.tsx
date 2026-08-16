import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import type { BookingDto } from '@try/contracts';
import { formatDateInZone, formatTimeInZone } from '@try/utils';
import { radius, spacing, typography } from '@try/design-tokens';
import { api } from '@/api/client';
import { useTheme } from '@/theme';
import { Skeleton } from '@/components/Skeleton';
import { EmptyState, ErrorState } from '@/components/States';

type Scope = 'UPCOMING' | 'PAST';

export default function BookingsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [scope, setScope] = useState<Scope>('UPCOMING');

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.bookings.list(scope),
    queryFn: () => api.bookings.list(scope),
  });

  return (
    <View
      style={[styles.fill, { backgroundColor: theme.background, paddingTop: insets.top + spacing.base }]}
    >
      <Text style={[styles.heading, { color: theme.textPrimary }]} accessibilityRole="header">
        Mes réservations
      </Text>

      <View style={styles.tabs} accessibilityRole="tablist">
        {(['UPCOMING', 'PAST'] as const).map((value) => (
          <Pressable
            key={value}
            onPress={() => setScope(value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: scope === value }}
            style={[
              styles.tab,
              {
                backgroundColor: scope === value ? theme.accent : theme.surfaceMuted,
              },
            ]}
          >
            <Text
              style={[
                styles.tabLabel,
                { color: scope === value ? theme.onAccent : theme.textSecondary },
              ]}
            >
              {value === 'UPCOMING' ? 'À venir' : 'Passées'}
            </Text>
          </Pressable>
        ))}
      </View>

      {isLoading ? (
        <View style={styles.list}>
          <Skeleton height={96} />
          <Skeleton height={96} />
        </View>
      ) : isError ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (data?.items.length ?? 0) === 0 ? (
        <EmptyState
          emoji={scope === 'UPCOMING' ? '📅' : '🕰️'}
          title={scope === 'UPCOMING' ? 'Aucune séance prévue' : 'Rien dans l’historique'}
          message={
            scope === 'UPCOMING'
              ? 'Découvre une activité près de toi et réserve ton premier essai.'
              : 'Tes séances passées apparaîtront ici.'
          }
        />
      ) : (
        /**
         * FlashList rather than FlatList: it recycles views instead of mounting
         * one per row, which is what keeps a long history at 60 fps on a mid-range
         * Android device.
         */
        <FlashList
          data={data?.items ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: spacing.base }}
          ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
          renderItem={({ item }) => <BookingRow booking={item} />}
        />
      )}
    </View>
  );
}

function BookingRow({ booking }: { booking: BookingDto }) {
  const theme = useTheme();
  const router = useRouter();
  const startAt = new Date(booking.slot.startAt);

  return (
    <Pressable
      onPress={() => router.push({ pathname: '/booking/[id]', params: { id: booking.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${booking.offer.title} chez ${booking.venue.name}, ${formatDateInZone(
        startAt,
        booking.venue.timeZone,
      )}`}
      style={[styles.row, { backgroundColor: theme.surfaceMuted }]}
    >
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: theme.textPrimary }]} numberOfLines={1}>
          {booking.offer.title}
        </Text>
        <Text style={[styles.rowVenue, { color: theme.textSecondary }]} numberOfLines={1}>
          {booking.venue.name}
        </Text>
        <Text style={[styles.rowWhen, { color: theme.textSecondary }]}>
          {formatDateInZone(startAt, booking.venue.timeZone)} ·{' '}
          {formatTimeInZone(startAt, booking.venue.timeZone)}
        </Text>
      </View>

      {booking.checkIn && (
        <View style={[styles.code, { backgroundColor: theme.accentSubtle }]}>
          <Text style={[styles.codeText, { color: theme.accentText }]}>QR</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  heading: {
    fontSize: typography.title1.fontSize,
    fontWeight: '700',
    paddingHorizontal: spacing.base,
  },
  tabs: { flexDirection: 'row', gap: spacing.sm, padding: spacing.base },
  tab: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    minHeight: 40,
    justifyContent: 'center',
  },
  tabLabel: { fontSize: typography.footnote.fontSize, fontWeight: '600' },
  list: { padding: spacing.base, gap: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.base,
    borderRadius: radius.lg,
    gap: spacing.md,
    minHeight: 88,
  },
  rowBody: { flex: 1, gap: spacing.xxs },
  rowTitle: { fontSize: typography.bodyStrong.fontSize, fontWeight: '600' },
  rowVenue: { fontSize: typography.footnote.fontSize },
  rowWhen: { fontSize: typography.footnote.fontSize },
  code: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  codeText: { fontSize: typography.caption.fontSize, fontWeight: '700' },
});
