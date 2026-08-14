import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing } from '@try/design-tokens';
import { useTheme } from '@/theme';
import { EmptyState } from '@/components/States';

export default function FavoritesScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.fill, { backgroundColor: theme.background, paddingTop: insets.top + spacing.base }]}>
      <EmptyState
        emoji="♥"
        title="Aucun favori"
        message="Enregistre les expériences qui t’intéressent pour les retrouver ici."
        actionLabel="Explorer"
        onAction={() => router.push('/(tabs)')}
      />
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
