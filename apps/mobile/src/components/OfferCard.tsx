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
      <View style={styles.imageWrapper}>
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
          {offer.venue.name}
          {offer.venue.districtName ? ` · ${offer.venue.districtName}` : ''}
          {offer.distanceMeters !== null ? ` · ${formatDistance(offer.distanceMeters)}` : ''}
        </Text>

        <View style={styles.footer}>
          <View style={styles.priceRow}>
            {/* Reference price first, struck through: "28 € → 10 €" reads as a
                discovery price rather than a discount sticker. */}
            {offer.referencePrice && (
              <Text style={[styles.referencePrice, { color: theme.textTertiary }]}>
                {formatMoney(offer.referencePrice, { compactWholeAmounts: true })}
              </Text>
            )}
            <Text
              style={[
                styles.price,
                { color: isFree ? theme.success : theme.price },
              ]}
            >
              {priceLabel}
            </Text>
          </View>

          {offer.averageRating !== null && (
            <Rating value={offer.averageRating} count={offer.reviewCount} compact />
          )}
        </View>

        {offer.nextSlotAt && (
          <Text style={[styles.nextSlot, { color: theme.textTertiary }]}>
            Prochain créneau · {formatTimeInZone(new Date(offer.nextSlotAt), offer.venue.timeZone)}
          </Text>
        )}
      </View>
    </AnimatedPressable>
  );
});

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  imageWrapper: { position: 'relative' },
  image: { width: '100%', aspectRatio: 3 / 2 },
  badges: {
    position: 'absolute',
    top: spacing.md,
    left: spacing.md,
    flexDirection: 'row',
    gap: spacing.xs,
  },
  body: { padding: spacing.base, gap: spacing.xs },
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
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  referencePrice: {
    fontSize: typography.footnote.fontSize,
    textDecorationLine: 'line-through',
  },
  price: {
    fontSize: typography.title3.fontSize,
    fontWeight: '700',
  },
  nextSlot: {
    fontSize: typography.caption.fontSize,
    marginTop: spacing.xxs,
  },
});
