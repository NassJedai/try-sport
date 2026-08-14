import { StyleSheet, Text, View } from 'react-native';
import { ApiError } from '@try/api-client';
import { spacing, typography } from '@try/design-tokens';
import { useTheme } from '@/theme';
import { Button } from './Button';

/**
 * Every screen in TRY must handle loading, empty, error and offline. These are
 * the shared implementations so the treatment is consistent and no screen
 * improvises its own dead end.
 */

interface EmptyStateProps {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  emoji?: string;
}

export function EmptyState({ title, message, actionLabel, onAction, emoji }: EmptyStateProps) {
  const theme = useTheme();

  return (
    <View style={styles.container} accessibilityRole="summary">
      {emoji && (
        <Text style={styles.emoji} accessible={false}>
          {emoji}
        </Text>
      )}
      <Text style={[styles.title, { color: theme.textPrimary }]}>{title}</Text>
      <Text style={[styles.message, { color: theme.textSecondary }]}>{message}</Text>
      {actionLabel && onAction && (
        <Button label={actionLabel} onPress={onAction} variant="secondary" fullWidth={false} />
      )}
    </View>
  );
}

/**
 * Error copy follows one rule: say what happened, say what it means for the
 * user's money, say what to do next. A raw status code is never shown.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const theme = useTheme();

  const isOffline = error instanceof ApiError && error.status === 0;
  const message =
    error instanceof ApiError
      ? error.message
      : 'Une erreur est survenue de notre côté. Aucune action n’a été effectuée.';

  return (
    <View style={styles.container} accessibilityRole="alert">
      <Text style={styles.emoji} accessible={false}>
        {isOffline ? '📡' : '⚠️'}
      </Text>
      <Text style={[styles.title, { color: theme.textPrimary }]}>
        {isOffline ? 'Pas de connexion' : 'Quelque chose n’a pas fonctionné'}
      </Text>
      <Text style={[styles.message, { color: theme.textSecondary }]}>{message}</Text>
      {onRetry && (
        <Button label="Réessayer" onPress={onRetry} variant="secondary" fullWidth={false} />
      )}
    </View>
  );
}

/** Non-blocking banner: cached content stays visible and usable behind it. */
export function OfflineBanner() {
  const theme = useTheme();

  return (
    <View
      style={[styles.banner, { backgroundColor: theme.warningSubtle }]}
      accessibilityRole="alert"
    >
      <Text style={[styles.bannerText, { color: theme.warning }]}>
        Hors ligne — tu vois les dernières données enregistrées.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
    gap: spacing.md,
  },
  emoji: { fontSize: 40 },
  title: {
    fontSize: typography.title2.fontSize,
    lineHeight: typography.title2.lineHeight,
    fontWeight: '700',
    textAlign: 'center',
  },
  message: {
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
    textAlign: 'center',
    maxWidth: 320,
  },
  banner: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  bannerText: { fontSize: typography.footnote.fontSize, fontWeight: '600' },
});
