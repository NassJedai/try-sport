import { memo, useCallback } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { motion, radius, spacing, touchTarget, typography } from '@try/design-tokens';
import { useTheme } from '@/theme';
import { useReducedMotion } from '@/theme/motion';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'medium' | 'large';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  icon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
  /** Reserved for genuinely destructive or celebratory actions. */
  haptic?: 'light' | 'medium' | 'success' | 'none';
}

export const Button = memo(function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'large',
  disabled = false,
  loading = false,
  fullWidth = true,
  icon,
  style,
  accessibilityHint,
  haptic = 'light',
}: ButtonProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePressIn = useCallback(() => {
    if (!reducedMotion) scale.value = withSpring(0.97, motion.springSnappy);
  }, [reducedMotion, scale]);

  const handlePressOut = useCallback(() => {
    if (!reducedMotion) scale.value = withSpring(1, motion.springSnappy);
  }, [reducedMotion, scale]);

  const handlePress = useCallback(() => {
    // Haptics respect the OS setting automatically; no extra gate needed.
    if (haptic === 'light') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else if (haptic === 'medium') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else if (haptic === 'success')
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onPress();
  }, [haptic, onPress]);

  const palette = {
    primary: { background: theme.accent, text: theme.onAccent, border: 'transparent' },
    secondary: { background: theme.surfaceMuted, text: theme.textPrimary, border: 'transparent' },
    ghost: { background: 'transparent', text: theme.textPrimary, border: theme.border },
    danger: { background: theme.danger, text: '#FFFFFF', border: 'transparent' },
  }[variant];

  const isInteractive = !disabled && !loading;

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      // Announces the disabled/busy state to screen readers rather than just
      // dimming it visually.
      accessibilityState={{ disabled: !isInteractive, busy: loading }}
      disabled={!isInteractive}
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[
        styles.base,
        {
          backgroundColor: palette.background,
          borderColor: palette.border,
          minHeight: size === 'large' ? touchTarget.minimum + 8 : touchTarget.minimum,
          opacity: isInteractive ? 1 : 0.5,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
          paddingHorizontal: fullWidth ? spacing.lg : spacing.xl,
        },
        animatedStyle,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.text} />
      ) : (
        <View style={styles.content}>
          {icon}
          <Text style={[styles.label, { color: palette.text }]} numberOfLines={1}>
            {label}
          </Text>
        </View>
      )}
    </AnimatedPressable>
  );
});

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.lg,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  label: {
    fontSize: typography.bodyStrong.fontSize,
    lineHeight: typography.bodyStrong.lineHeight,
    fontWeight: '600',
  },
});
