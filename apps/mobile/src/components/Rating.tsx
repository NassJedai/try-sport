import { StyleSheet, Text, View } from 'react-native';
import { spacing, typography } from '@try/design-tokens';
import { useTheme } from '@/theme';

interface RatingProps {
  value: number;
  count?: number;
  compact?: boolean;
}

export function Rating({ value, count, compact = false }: RatingProps) {
  const theme = useTheme();

  return (
    <View
      style={styles.row}
      accessibilityRole="text"
      accessibilityLabel={`Note ${value.toFixed(1)} sur 5${count ? `, ${count} avis` : ''}`}
    >
      <Text style={[styles.star, { color: theme.textPrimary }]} accessible={false}>
        ★
      </Text>
      <Text style={[styles.value, { color: theme.textPrimary }]} accessible={false}>
        {value.toFixed(1)}
      </Text>
      {!compact && count !== undefined && (
        <Text style={[styles.count, { color: theme.textSecondary }]} accessible={false}>
          ({count})
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xxs },
  star: { fontSize: 14 },
  value: { fontSize: typography.footnote.fontSize, fontWeight: '600' },
  count: { fontSize: typography.footnote.fontSize },
});
