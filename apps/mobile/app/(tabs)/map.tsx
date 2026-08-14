import { useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import { formatMoney } from '@try/utils';
import { radius, spacing, typography } from '@try/design-tokens';
import { api } from '@/api/client';
import { useTheme } from '@/theme';
import { usePreferences } from '@/store/preferences';
import { Button } from '@/components/Button';

/**
 * Map discovery.
 *
 * The native map surface is provided by MapProvider (see ADR-002) and is not
 * wired here: adding the Mapbox native module requires a development build, so
 * this screen renders the same viewport-driven data through a list until that
 * build exists. The data contract — debounced bounding-box queries, capped and
 * flagged when truncated — is the part that matters and it is real.
 */
const DEBOUNCE_MS = 400;

export default function MapScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const coordinates = usePreferences((state) => state.coordinates);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Defaults to central Brussels until the user's position is known.
  const center = coordinates ?? { latitude: 50.8467, longitude: 4.3525 };
  const [bounds, setBounds] = useState({
    minLatitude: center.latitude - 0.03,
    maxLatitude: center.latitude + 0.03,
    minLongitude: center.longitude - 0.05,
    maxLongitude: center.longitude + 0.05,
  });

  /**
   * Viewport changes are debounced before they become a request. Querying on
   * every frame of a pan would issue dozens of requests per gesture and make the
   * map stutter on exactly the devices that can least afford it.
   */
  const handleViewportChange = useCallback((next: typeof bounds) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setBounds(next), DEBOUNCE_MS);
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.discovery.map(bounds),
    queryFn: () => api.discovery.map({ bounds }),
  });

  return (
    <View style={[styles.fill, { backgroundColor: theme.background, paddingTop: insets.top + spacing.base }]}>
      <Text style={[styles.heading, { color: theme.textPrimary }]} accessibilityRole="header">
        Autour de toi
      </Text>

      <View style={[styles.canvas, { backgroundColor: theme.surfaceMuted }]}>
        <Text style={[styles.canvasNote, { color: theme.textSecondary }]}>
          {isLoading
            ? 'Chargement des lieux…'
            : `${data?.pins.length ?? 0} expériences dans cette zone`}
        </Text>
        {data?.truncated && (
          <Text style={[styles.truncated, { color: theme.price }]}>
            Zoome pour voir tous les résultats
          </Text>
        )}

        <View style={styles.pins}>
          {(data?.pins ?? []).slice(0, 12).map((pin) => (
            <View
              key={pin.offerId}
              style={[
                styles.pin,
                { backgroundColor: pin.isFree ? theme.success : theme.textPrimary },
              ]}
            >
              <Text style={[styles.pinLabel, { color: theme.background }]}>
                {formatMoney(pin.price, { freeLabel: '0 €', compactWholeAmounts: true })}
              </Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.actions}>
        <Button
          label="Rechercher dans cette zone"
          variant="secondary"
          onPress={() => handleViewportChange({ ...bounds })}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  heading: {
    fontSize: typography.title1.fontSize,
    fontWeight: '700',
    paddingHorizontal: spacing.base,
    marginBottom: spacing.base,
  },
  canvas: {
    flex: 1,
    margin: spacing.base,
    borderRadius: radius.xl,
    padding: spacing.base,
    gap: spacing.sm,
  },
  canvasNote: { fontSize: typography.footnote.fontSize },
  truncated: { fontSize: typography.footnote.fontSize, fontWeight: '600' },
  pins: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  pin: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  pinLabel: { fontSize: typography.caption.fontSize, fontWeight: '700' },
  actions: { padding: spacing.base },
});
