import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { radius, spacing } from '@try/design-tokens';
import { useTheme } from '@/theme';
import { useReducedMotion } from '@/theme/motion';

interface SkeletonProps {
  width?: number | `${number}%`;
  height?: number;
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Skeletons rather than spinners.
 *
 * A spinner says "wait"; a skeleton says "here is what is coming", keeps layout
 * stable, and removes the content jump that makes an app feel cheap. The pulse
 * runs on the UI thread via Reanimated, so it keeps animating even while the JS
 * thread is busy parsing the response it is waiting for.
 */
export function Skeleton({ width = '100%', height = 16, borderRadius, style }: SkeletonProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(0.6);

  useEffect(() => {
    if (reducedMotion) {
      opacity.value = 0.6;
      return;
    }
    opacity.value = withRepeat(withTiming(1, { duration: 800 }), -1, true);
  }, [opacity, reducedMotion]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      accessibilityRole="progressbar"
      accessibilityLabel="Chargement"
      style={[
        {
          width,
          height,
          borderRadius: borderRadius ?? radius.sm,
          backgroundColor: theme.skeleton,
        },
        animatedStyle,
        style,
      ]}
    />
  );
}

/** Mirrors OfferCard's layout exactly, so nothing shifts when real data lands. */
export function OfferCardSkeleton() {
  return (
    <View style={styles.card}>
      <Skeleton height={180} borderRadius={radius.lg} />
      <View style={styles.body}>
        <Skeleton width="70%" height={18} />
        <Skeleton width="45%" height={14} />
        <Skeleton width="35%" height={20} />
      </View>
    </View>
  );
}

export function SectionSkeleton() {
  return (
    <View style={styles.section}>
      <Skeleton width="40%" height={22} style={{ marginBottom: spacing.md }} />
      <OfferCardSkeleton />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.md },
  body: { gap: spacing.sm },
  section: { paddingHorizontal: spacing.base, marginBottom: spacing.xxl },
});
