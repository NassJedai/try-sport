import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing, typography } from '@try/design-tokens';
import { useTheme } from '@/theme';
import { Button } from '@/components/Button';
import { useLocation } from '@/hooks/use-location';
import { usePreferences } from '@/store/preferences';

/**
 * Location primer.
 *
 * The OS dialog is never raised cold. On iOS it can only be shown once, so a
 * denial here is permanent and pushes the user into the manual city fallback
 * forever. Explaining the benefit first is worth the extra screen.
 */
export default function LocationPrimerScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { request } = useLocation();
  const markSeen = usePreferences((state) => state.markLocationPrimerSeen);

  const handleAllow = async () => {
    markSeen();
    await request();
    // Whether granted or denied, discovery still works — the city centroid is
    // the fallback origin — so there is no dead end here.
    router.replace('/(tabs)');
  };

  const handleSkip = () => {
    markSeen();
    router.replace('/(tabs)');
  };

  return (
    <View
      style={[
        styles.fill,
        { backgroundColor: theme.background, paddingBottom: insets.bottom + spacing.xl },
      ]}
    >
      <View style={styles.body}>
        <Text style={styles.emoji} accessible={false}>
          📍
        </Text>
        <Text style={[styles.title, { color: theme.textPrimary }]} accessibilityRole="header">
          Trouve ce que tu peux essayer près de toi.
        </Text>
        <Text style={[styles.message, { color: theme.textSecondary }]}>
          Autorise ta localisation pour voir les expériences sportives disponibles autour de toi,
          classées par distance.
        </Text>
      </View>

      <View style={styles.actions}>
        <Button label="Autoriser la localisation" onPress={() => void handleAllow()} />
        <Button
          label="Choisir ma commune"
          variant="ghost"
          haptic="none"
          onPress={handleSkip}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'space-between' },
  body: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.xl, gap: spacing.base },
  emoji: { fontSize: 48 },
  title: {
    fontSize: typography.title1.fontSize,
    lineHeight: typography.title1.lineHeight,
    fontWeight: '700',
  },
  message: { fontSize: typography.body.fontSize, lineHeight: typography.body.lineHeight },
  actions: { paddingHorizontal: spacing.xl, gap: spacing.sm },
});
