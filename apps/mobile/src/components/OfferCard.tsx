import { memo, useCallback } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { queryKeys } from '@try/api-client';
import type { OfferCardDto } from '@try/contracts';
import { formatDistance, formatMoney, formatTimeInZone } from '@try/utils';
import { motion, radius, shadows, spacing, typography } from '@try/design-tokens';
import { api } from '@/api/client';
import { useTheme } from '@/theme';
import { useReducedMotion } from '@/theme/motion';
import { Badge } from './Badge';
import { Rating } from './Rating';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface OfferCardProps {
  offer: OfferCardDto;
  /** Analytics context: which rail this impression came from. */
  section?: string;
  position?: number;
}

export const OfferCard = memo(function OfferCard({ offer }: OfferCardProps) {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const reducedMotion = useReducedMotion();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  /**
   * Warm the detail cache on press-in, ~100 ms before navigation commits.
   * By the time the screen mounts the request is usually already in flight, so
   * the detail view hydrates without a visible loading state.
   */
  const prefetch = useCallback(() => {
    void queryClient.prefetchQuery({
      queryKey: queryKeys.offers.detail(offer.id),
      queryFn: () => api.offers.detail(offer.id),
      staleTime: 30_000,
    });
    if (!reducedMotion) scale.value = withSpring(0.98, motion.springSnappy);
  }, [offer.id, queryClient, reducedMotion, scale]);

  const handlePressOut = useCallback(() => {
    if (!reducedMotion) scale.value = withSpring(1, motion.springSnappy);
  }, [reducedMotion, scale]);

  const handlePress = useCallback(() => {
    /**
     * Seed the detail cache with what this card already knows, so the next screen
     * paints the image, title, price and venue immediately and fills in the rest.
     * This is what removes the white loading flash between list and detail.
     */
    queryClient.setQueryData(queryKeys.offers.detail(offer.id), (existing: unknown) => existing);
    router.push({ pathname: '/offer/[id]', params: { id: offer.id } });
  }, [offer.id, queryClient, router]);

  const isFree = offer.price.amount === 0;
  const priceLabel = formatMoney(offer.price, { freeLabel: 'Gratuit', compactWholeAmounts: true });

  const accessibilityLabel = [
    offer.title,
    offer.venue.name,
    offer.venue.districtName,
    offer.distanceMeters !== null ? formatDistance(offer.distanceMeters) : null,
    `${offer.durationMinutes} minutes`,
    priceLabel,
    offer.averageRating !== null ? `noté ${offer.averageRating.toFixed(1)} sur 5` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Ouvre le détail de l'offre"
      onPress={handlePress}
      onPressIn={prefetch}
      onPressOut={handlePressOut}
      style={[
        styles.card,
        { backgroundColor: theme.surface, borderColor: theme.border },
        shadows.sm,
        animatedStyle,
      ]}
    >
      {/* Colonne image : largeur proportionnelle, pas un ratio fixe — c'est le
          contenu texte qui fixe la hauteur de la carte (voir `body`), l'image
          s'étire dessus via `alignSelf: 'stretch'` (comportement Yoga standard
          pour une image qui doit épouser la hauteur d'une rangée flex). */}
      <View style={styles.imageColumn}>
        {offer.image ? (
          <Image
            // Thumbnail variant: a feed must never pull a full-resolution original.
            source={{ uri: offer.image.thumbnail }}
            style={styles.image}
            resizeMode="cover"
            accessible={false}
          />
        ) : (
          <View style={[styles.image, { backgroundColor: theme.surfaceMuted }]} />
        )}

        {offer.badges.length > 0 && (
          // Empilés verticalement : la colonne image est étroite désormais,
          // deux badges côte à côte (ex. « NOUVEAU » + « PRIX DÉCOUVERTE »)
          // n'y tiendraient pas sur une largeur d'iPhone SE.
          <View style={styles.badges}>
            {offer.badges.slice(0, 2).map((badge) => (
              <Badge key={badge} kind={badge} />
            ))}
          </View>
        )}
      </View>

      <View style={styles.body}>
        <Text style={[styles.title, { color: theme.textPrimary }]} numberOfLines={2}>
          {offer.title}
        </Text>

        <Text style={[styles.venue, { color: theme.textSecondary }]} numberOfLines={1}>
          📍 {offer.venue.name}
          {offer.venue.districtName ? ` · ${offer.venue.districtName}` : ''}
          {offer.distanceMeters !== null ? ` · ${formatDistance(offer.distanceMeters)}` : ''}
        </Text>

        {offer.averageRating !== null && (
          <Rating value={offer.averageRating} count={offer.reviewCount} compact />
        )}

        <View style={styles.footer}>
          <Text style={[styles.duration, { color: theme.textTertiary }]} numberOfLines={1}>
            🕐 {offer.durationMinutes} min
          </Text>

          <View style={styles.priceColumn}>
            {/* Reference price first, struck through: "28 € → 10 €" reads as a
                discovery price rather than a discount sticker. */}
            {offer.referencePrice && (
              <Text style={[styles.referencePrice, { color: theme.textTertiary }]}>
                {formatMoney(offer.referencePrice, { compactWholeAmounts: true })}
              </Text>
            )}
            {/* Le prix est un badge plein, comme dans la maquette — mais avec
                les teintes `price`/`success` du design system, pas le lime de
                la charte : voir le commentaire de `signal700` dans
                @try/design-tokens sur la distinction volontaire prix/accent. */}
            <View
              style={[
                styles.priceBadge,
                { backgroundColor: isFree ? theme.successSurface : theme.priceSurface },
              ]}
            >
              <Text
                style={[styles.price, { color: isFree ? theme.onSuccess : theme.onPrice }]}
                numberOfLines={1}
              >
                {priceLabel}
              </Text>
            </View>
          </View>
        </View>

        {offer.nextSlotAt && (
          <Text style={[styles.nextSlot, { color: theme.textTertiary }]} numberOfLines={1}>
            Prochain créneau · {formatTimeInZone(new Date(offer.nextSlotAt), offer.venue.timeZone)}
          </Text>
        )}
      </View>
    </AnimatedPressable>
  );
});

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  imageColumn: { position: 'relative', width: '38%' },
  /**
   * Absolue, pas `height: '100%'` : un pourcentage de hauteur dans une colonne
   * dont la hauteur vient d'`alignItems: 'stretch'` est irrésoluble au premier
   * passage de mesure — l'image retombe alors sur la taille intrinsèque du
   * bitmap chargé et c'est ELLE qui fixe la hauteur de la carte (constaté sur
   * l'accueil : carte étirée sur tout l'écran). En absolu, l'image ne
   * participe plus à la mesure : la hauteur de la carte vient du texte, et
   * l'image épouse la colonne après coup.
   */
  image: { ...StyleSheet.absoluteFillObject },
  badges: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: spacing.xs,
  },
  body: { flex: 1, padding: spacing.base, gap: spacing.xxs },
  title: {
    fontSize: typography.title3.fontSize,
    lineHeight: typography.title3.lineHeight,
    fontWeight: '600',
  },
  venue: {
    fontSize: typography.footnote.fontSize,
    lineHeight: typography.footnote.lineHeight,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
    gap: spacing.sm,
  },
  duration: {
    flex: 1,
    fontSize: typography.footnote.fontSize,
  },
  priceColumn: { alignItems: 'flex-end', gap: spacing.xxs },
  referencePrice: {
    fontSize: typography.footnote.fontSize,
    textDecorationLine: 'line-through',
  },
  priceBadge: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
  },
  price: {
    fontSize: typography.callout.fontSize,
    fontWeight: '700',
  },
  nextSlot: {
    fontSize: typography.caption.fontSize,
    marginTop: spacing.xxs,
  },
});
