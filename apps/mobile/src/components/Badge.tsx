import { StyleSheet, Text, View } from 'react-native';
import type { OfferBadge } from '@try/contracts';
import { radius, spacing, typography } from '@try/design-tokens';
import { useTheme } from '@/theme';

const LABELS: Record<OfferBadge, string> = {
  FREE: 'GRATUIT',
  NEW: 'NOUVEAU',
  POPULAR: 'POPULAIRE',
  DISCOVERY_PRICE: 'PRIX DÉCOUVERTE',
};

export function Badge({ kind }: { kind: OfferBadge }) {
  const theme = useTheme();

  /**
   * Filled tiers with their own on-colours, never a hardcoded white. `success`
   * and `price` are *text* colours — dark enough to read on a pale page, which
   * left white on them at 1.7:1 and 2.3:1 in the dark theme.
   */
  const colors: Record<OfferBadge, { background: string; text: string }> = {
    FREE: { background: theme.successSurface, text: theme.onSuccess },
    NEW: { background: theme.accent, text: theme.onAccent },
    POPULAR: { background: theme.textPrimary, text: theme.background },
    DISCOVERY_PRICE: { background: theme.priceSurface, text: theme.onPrice },
  };

  const palette = colors[kind];

  return (
    <View style={[styles.badge, { backgroundColor: palette.background }]}>
      {/* Decorative: the card's accessibility label already carries the price. */}
      <Text style={[styles.label, { color: palette.text }]} accessible={false}>
        {LABELS[kind]}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
  },
  label: {
    fontSize: typography.overline.fontSize,
    fontWeight: '700',
    letterSpacing: typography.overline.letterSpacing,
  },
});
