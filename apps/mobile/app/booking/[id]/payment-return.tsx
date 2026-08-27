import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { spacing, typography } from '@try/design-tokens';
import { useTheme } from '@/theme';

/**
 * Cible du lien profond `try://booking/:id/payment-return?status=success|cancel`
 * construit côté serveur (`apps/api/src/modules/payments/payment.service.ts`,
 * `buildReturnUrls`).
 *
 * En pratique, ce retour est presque toujours capturé directement par la
 * promesse d'`openAuthSessionAsync` (`booking/[id].tsx`) sans que cet écran
 * n'ait le temps de s'afficher : l'`ASWebAuthenticationSession` intercepte la
 * redirection avant qu'elle ne déclenche le routage standard de l'app. Cette
 * route existe pour les cas où ça ne se passe pas ainsi — Android, qui n'a pas
 * cette API et repose sur les événements `Linking` (voir la source
 * d'`expo-web-browser`), ou un navigateur externe qui rouvre l'app par ce lien
 * plutôt que de rendre la main à la session d'auth.
 *
 * `status` est UNIQUEMENT un indice pour choisir l'animation immédiate — il
 * n'est jamais lu pour décider quoi que ce soit sur l'argent. La redirection
 * ci-dessous atterrit sur `/booking/[id]`, qui relit l'état serveur (et
 * sonde tant que le paiement est en attente) exactement comme si cet écran
 * n'avait jamais existé. Voir le commentaire de `openCheckout` dans
 * `booking/[id].tsx` pour la même règle, répétée là où elle compte le plus.
 */
export default function PaymentReturnScreen() {
  const { id } = useLocalSearchParams<{ id: string; status?: string }>();
  const theme = useTheme();
  const router = useRouter();

  useEffect(() => {
    router.replace({ pathname: '/booking/[id]', params: { id } });
  }, [id, router]);

  return (
    <View style={[styles.fill, { backgroundColor: theme.background }]}>
      <ActivityIndicator color={theme.accent} />
      <Text style={[styles.label, { color: theme.textSecondary }]}>
        Vérification de ton paiement…
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  label: { fontSize: typography.footnote.fontSize },
});
