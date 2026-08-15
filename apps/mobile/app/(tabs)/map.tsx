import { useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, type Region } from 'react-native-maps';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import { formatMoney } from '@try/utils';
import { radius, shadows, spacing, typography } from '@try/design-tokens';
import { api } from '@/api/client';
import { useTheme } from '@/theme';
import { usePreferences } from '@/store/preferences';

/**
 * La carte, la vraie.
 *
 * Apple Plans via react-native-maps — fourni par Expo Go, zéro clé, zéro build
 * natif (l'ADR-002 visait Mapbox, qui en exigeait un ; ce n'était plus une
 * raison de montrer des épingles posées sur un fond gris). Le contrat de
 * données ne change pas : requêtes par zone visible, débouncées, plafonnées et
 * signalées quand elles tronquent.
 */
const DEBOUNCE_MS = 400;

export default function MapScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const coordinates = usePreferences((state) => state.coordinates);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Le centre de Bruxelles tant que la position de l'utilisateur est inconnue.
  const center = coordinates ?? { latitude: 50.8467, longitude: 4.3525 };
  const [bounds, setBounds] = useState({
    minLatitude: center.latitude - 0.03,
    maxLatitude: center.latitude + 0.03,
    minLongitude: center.longitude - 0.05,
    maxLongitude: center.longitude + 0.05,
  });

  /**
   * Le viewport devient une requête après une pause, jamais pendant le geste :
   * interroger à chaque frame d'un déplacement enverrait des dizaines de
   * requêtes par seconde et ferait bégayer la carte sur les téléphones qui
   * peuvent le moins se le permettre.
   */
  const handleRegionChange = useCallback((region: Region) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setBounds({
        minLatitude: region.latitude - region.latitudeDelta / 2,
        maxLatitude: region.latitude + region.latitudeDelta / 2,
        minLongitude: region.longitude - region.longitudeDelta / 2,
        maxLongitude: region.longitude + region.longitudeDelta / 2,
      });
    }, DEBOUNCE_MS);
  }, []);

  const { data } = useQuery({
    queryKey: queryKeys.discovery.map(bounds),
    queryFn: () => api.discovery.map({ bounds }),
  });

  return (
    <View style={styles.fill}>
      <MapView
        style={StyleSheet.absoluteFill}
        initialRegion={{
          latitude: center.latitude,
          longitude: center.longitude,
          latitudeDelta: 0.06,
          longitudeDelta: 0.1,
        }}
        onRegionChangeComplete={handleRegionChange}
        showsUserLocation
        // Les commerces tiers sur le fond de carte sont du bruit ici : on vend
        // NOS lieux, pas les points d'intérêt d'Apple.
        showsPointsOfInterest={false}
        accessibilityLabel="Carte des expériences autour de toi"
      >
        {(data?.pins ?? []).map((pin) => (
          <Marker
            key={pin.offerId}
            coordinate={pin.coordinates}
            // Vue custom : la pastille de prix EST le marqueur, comme Airbnb.
            // tracksViewChanges coûte cher ; le contenu d'une pastille ne
            // change jamais après le premier rendu.
            tracksViewChanges={false}
            onPress={() => router.push(`/offer/${pin.offerId}` as never)}
            accessibilityLabel={`Offre à ${formatMoney(pin.price, { freeLabel: 'gratuit' })}`}
          >
            <View
              style={[
                styles.pin,
                { backgroundColor: pin.isFree ? theme.success : theme.textPrimary },
                shadows.md,
              ]}
            >
              <Text style={[styles.pinLabel, { color: theme.background }]}>
                {formatMoney(pin.price, { freeLabel: '0 €', compactWholeAmounts: true })}
              </Text>
            </View>
          </Marker>
        ))}
      </MapView>

      {/* Bandeau d'état par-dessus la carte, sous l'encoche. */}
      <View
        style={[
          styles.banner,
          { backgroundColor: theme.backgroundElevated, top: insets.top + spacing.sm },
          shadows.md,
        ]}
      >
        <Text style={[styles.bannerText, { color: theme.textPrimary }]}>
          {data ? `${data.pins.length} expériences dans cette zone` : 'Chargement des lieux…'}
        </Text>
        {data?.truncated && (
          <Text style={[styles.bannerHint, { color: theme.price }]}>
            Zoome pour voir tous les résultats
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  banner: {
    position: 'absolute',
    alignSelf: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    gap: 2,
  },
  bannerText: { fontSize: typography.footnote.fontSize, fontWeight: '600' },
  bannerHint: { fontSize: typography.caption.fontSize, fontWeight: '600' },
  pin: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  pinLabel: { fontSize: typography.caption.fontSize, fontWeight: '700' },
});
