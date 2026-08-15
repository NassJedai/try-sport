import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import { spacing, touchTarget, typography } from '@try/design-tokens';
import { api } from '@/api/client';
import { useTheme } from '@/theme';

/**
 * La cloche de l'accueil et sa pastille.
 *
 * `retry: false` et l'absence de tout affichage d'erreur sont volontaires :
 * être déconnecté est un état normal ici, et l'accueil doit rester utilisable
 * sans compte. Une cloche qui n'a rien à dire ne dit rien.
 *
 * Le compteur est rafraîchi à chaque retour sur l'écran plutôt que par un
 * sondage périodique : les rappels arrivent à l'heure du cours, pas à la
 * seconde, et un sondage réveillerait la radio du téléphone pour rien.
 */
export function NotificationBell() {
  const theme = useTheme();
  const router = useRouter();

  const { data } = useQuery({
    queryKey: queryKeys.notifications.list(true),
    queryFn: () => api.notifications.list(true),
    retry: false,
    staleTime: 60_000,
  });

  const unread = data?.unreadCount ?? 0;

  return (
    <Pressable
      onPress={() => router.push('/notifications')}
      accessibilityRole="button"
      accessibilityLabel={
        unread > 0 ? `Notifications, ${unread} non lues` : 'Notifications'
      }
      hitSlop={spacing.xs}
      style={styles.button}
    >
      <Text style={[styles.glyph, { color: theme.textPrimary }]}>🔔</Text>
      {unread > 0 && (
        <View style={[styles.badge, { backgroundColor: theme.accent }]}>
          <Text style={[styles.badgeLabel, { color: theme.onAccent }]} numberOfLines={1}>
            {/* Au-delà de 9, le nombre exact n'aide plus et déforme la pastille. */}
            {unread > 9 ? '9+' : unread}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: touchTarget.minimum,
    minHeight: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { fontSize: 22 },
  badge: {
    position: 'absolute',
    top: 4,
    right: 2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeLabel: { fontSize: typography.caption.fontSize, fontWeight: '700' },
});
