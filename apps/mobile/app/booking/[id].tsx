import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import {
  BOOKING_PAYMENT_STATUS_LABELS_FR,
  isLiveReservationStatus,
  isOutstandingBookingPayment,
} from '@try/contracts';
import type { BookingDto } from '@try/contracts';
import { formatDateInZone, formatMoney, formatTimeInZone } from '@try/utils';
import { radius, spacing, typography } from '@try/design-tokens';
import { api } from '@/api/client';
import { useTheme } from '@/theme';
import { Button } from '@/components/Button';
import { Skeleton } from '@/components/Skeleton';
import { ErrorState } from '@/components/States';

/**
 * Un paiement `REQUIRES_PAYMENT`/`PROCESSING` ne redevient jamais actionnable
 * une fois la réservation elle-même sortie de son état vivant.
 *
 * `expirePaymentHolds` (apps/api/src/modules/jobs/lifecycle-jobs.service.ts)
 * fait passer la réservation à `EXPIRED` mais n'écrit jamais `payments.status`
 * — seul le PaymentIntent est annulé côté Stripe. Une réservation `EXPIRED`
 * peut donc très bien porter, en base, un paiement encore à
 * `REQUIRES_PAYMENT`. Sans ce garde-fou l'écran resterait bloqué sur « en
 * attente de confirmation » et continuerait de sonder le serveur toutes les 4
 * secondes indéfiniment, sur une place déjà relâchée à quelqu'un d'autre.
 */
function isPaymentActionable(booking: Pick<BookingDto, 'status' | 'payment'>): boolean {
  return isOutstandingBookingPayment(booking.payment.status) && isLiveReservationStatus(booking.status);
}

/**
 * La seule condition qui autorise le bandeau vert « C'est réservé » et
 * l'haptique de succès : gratuit (rien à payer) ou payé avec succès. Ni l'un
 * ni l'autre bandeau ne doit s'afficher sur la simple absence de paiement
 * "actionnable" — une réservation EXPIRED dont le paiement n'a jamais abouti
 * n'est ni "en attente" ni "réservée", et ne doit fêter ni l'un ni l'autre.
 */
function isPaymentSettledSuccessfully(booking: Pick<BookingDto, 'payment'>): boolean {
  return booking.payment.status === 'NOT_REQUIRED' || booking.payment.status === 'SUCCEEDED';
}

export default function BookingDetailScreen() {
  const { id, created, checkoutUrl } = useLocalSearchParams<{
    id: string;
    created?: string;
    /**
     * Présent une seule fois : juste après `POST /v1/bookings` pour une offre
     * payante (voir offer/[id].tsx). L'API ne le renvoie plus ensuite — relire
     * cette réservation plus tard (liste des réservations, redémarrage de
     * l'app) ne le fait pas réapparaître. Tant qu'il n'existe pas de route
     * pour ré-émettre une session de paiement sur une réservation existante,
     * un client qui a perdu cette valeur n'a aucun moyen de rouvrir la page
     * Stripe depuis l'app — voir le bandeau plus bas, qui le dit plutôt que
     * de le cacher.
     */
    checkoutUrl?: string;
  }>();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const justCreated = created === '1';
  const hasOpenedCheckout = useRef(false);
  const [reopening, setReopening] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.bookings.detail(id),
    queryFn: () => api.bookings.detail(id),
    /**
     * Tant que le paiement est en attente, on revient interroger le serveur
     * toutes les 4 secondes plutôt que d'attendre une action de l'utilisateur.
     * Le webhook Stripe (source de vérité — voir plus bas) peut arriver une
     * seconde après le retour du navigateur ou dix ; c'est cette relecture
     * périodique qui fait passer l'écran de « en attente » à « confirmée »,
     * jamais le retour de navigation lui-même. S'arrête dès que le paiement a
     * atteint un état terminal (payé, échoué, remboursé, gratuit...).
     */
    refetchInterval: (query) => {
      const booking = query.state.data;
      return booking && isPaymentActionable(booking) ? 4000 : false;
    },
  });

  const openCheckout = useCallback(
    async (url: string) => {
      setReopening(true);
      try {
        /**
         * `openAuthSessionAsync`, pas `openBrowserAsync` : c'est celle des deux
         * conçue pour un aller-retour avec redirection vers l'app — elle sait
         * reconnaître le retour sur `try://` (schéma déclaré dans app.json) et
         * résout sa promesse dès qu'il survient, plutôt que de laisser
         * l'utilisateur revenir manuellement à l'app.
         */
        await WebBrowser.openAuthSessionAsync(url, `try://booking/${id}/payment-return`);
      } catch {
        // Ignoré volontairement : que WebBrowser échoue à s'ouvrir ou que la
        // session se termine anormalement ne change rien à la marche à
        // suivre — le `finally` ci-dessous relit de toute façon l'état
        // serveur, seule source fiable.
      } finally {
        setReopening(false);
        /**
         * RÈGLE NON NÉGOCIABLE : quoi que rapporte ce retour — succès,
         * annulation, fermeture manuelle du navigateur, ou même une erreur du
         * WebBrowser lui-même — on n'en déduit RIEN sur l'état du paiement.
         * Un client peut payer puis fermer l'onglet sans revenir ; le lien
         * profond peut échouer côté OS. La seule source de vérité est le
         * webhook Stripe, déjà appliqué côté serveur au moment où on relit ici
         * — jamais ce que la navigation semble dire.
         */
        void refetch();
      }
    },
    [id, refetch],
  );

  useEffect(() => {
    if (!checkoutUrl || hasOpenedCheckout.current) return;
    hasOpenedCheckout.current = true;
    void openCheckout(checkoutUrl);
  }, [checkoutUrl, openCheckout]);

  const hasCelebrated = useRef(false);
  useEffect(() => {
    /**
     * A single success haptic on confirmation. Restrained on purpose — the
     * moment deserves acknowledgement, not confetti on every screen.
     *
     * Retardé tant que le paiement est en attente : une offre gratuite est
     * confirmée dès la création (NOT_REQUIRED n'est jamais "outstanding"), donc
     * ce parcours ne change pas de comportement. Une offre payante ne le
     * déclenche qu'une fois le poll ci-dessus ayant vu le paiement sortir de son
     * état transitoire — jamais au moment où l'écran s'ouvre sur un paiement pas
     * encore acté.
     */
    if (!justCreated || !data || hasCelebrated.current) return;
    if (!isPaymentSettledSuccessfully(data)) return;
    hasCelebrated.current = true;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [justCreated, data]);

  const cancel = useMutation({
    mutationFn: () => api.bookings.cancel(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.bookings.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.offers.all });
      router.back();
    },
  });

  if (isLoading) {
    return (
      <View style={[styles.fill, { backgroundColor: theme.background, padding: spacing.base }]}>
        <Skeleton height={120} />
        <Skeleton height={200} style={{ marginTop: spacing.base }} />
      </View>
    );
  }

  if (isError || !data) {
    return (
      <View style={[styles.fill, { backgroundColor: theme.background }]}>
        <ErrorState error={error} onRetry={() => void refetch()} />
      </View>
    );
  }

  const startAt = new Date(data.slot.startAt);
  const timeZone = data.venue.timeZone;
  const isConfirmed = data.status === 'CONFIRMED' || data.status === 'CHECKED_IN';
  const paymentOutstanding = isPaymentActionable(data);
  // Retentable seulement si la réservation tient encore la place : un statut
  // FAILED/CANCELLED sur une réservation qui n'est plus live (hold expiré,
  // annulée) n'a plus rien à réessayer — voir isPaymentActionable ci-dessus.
  const paymentFailed =
    isLiveReservationStatus(data.status) &&
    (data.payment.status === 'FAILED' || data.payment.status === 'CANCELLED');
  const isPaidOffer = data.price.amount > 0;

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={{
        paddingTop: insets.top + spacing.base,
        paddingBottom: insets.bottom + spacing.xxl,
        paddingHorizontal: spacing.base,
      }}
    >
      {/* Confirmation immédiate : seulement quand le paiement est réellement
          réglé. Pour une offre gratuite (NOT_REQUIRED), c'est vrai dès la
          création — ce parcours ne change pas. Pour une offre payante, ce
          bandeau attend le même signal que l'haptique ci-dessus : jamais
          affiché sur la foi du retour de navigation, seulement sur une
          relecture serveur qui confirme SUCCEEDED. */}
      {justCreated && isPaymentSettledSuccessfully(data) && (
        <View
          style={[styles.confirmation, { backgroundColor: theme.successSubtle }]}
          accessibilityRole="alert"
        >
          <Text style={styles.confirmationEmoji} accessible={false}>
            ✓
          </Text>
          <Text style={[styles.confirmationTitle, { color: theme.success }]}>
            C’est réservé
          </Text>
          <Text style={[styles.confirmationBody, { color: theme.textSecondary }]}>
            Tu recevras un rappel avant ta séance.
          </Text>
        </View>
      )}

      {/* Visible tant que le paiement n'a pas atteint un état terminal, pas
          seulement juste après la création : un client qui quitte l'app et
          revient depuis sa liste de réservations doit voir la même chose. */}
      {paymentOutstanding && (
        <View
          style={[styles.confirmation, { backgroundColor: theme.warningSubtle }]}
          accessibilityRole="alert"
        >
          <ActivityIndicator color={theme.warning} />
          <Text style={[styles.confirmationTitle, { color: theme.warning }]}>
            En attente de confirmation du paiement
          </Text>
          <Text style={[styles.confirmationBody, { color: theme.textSecondary }]}>
            {reopening
              ? 'Page de paiement ouverte…'
              : 'Cette page se met à jour automatiquement dès que le paiement est reçu — inutile de la rafraîchir.'}
            {'\n\n'}
            Le paiement reste possible pendant un temps limité après la
            réservation. Passé ce délai, la place est automatiquement relâchée
            et il faut réserver à nouveau.
          </Text>
          {checkoutUrl ? (
            <Button
              label="Ouvrir la page de paiement"
              variant="secondary"
              onPress={() => void openCheckout(checkoutUrl)}
              loading={reopening}
              haptic="light"
              style={{ marginTop: spacing.sm }}
            />
          ) : (
            <Text style={[styles.confirmationBody, { color: theme.textTertiary, marginTop: spacing.sm }]}>
              La page de paiement a été fermée et ne peut pas être rouverte
              depuis cet écran. Reviens dès que le paiement est passé pour voir
              ta réservation confirmée, ou annule-la ci-dessous pour libérer la
              place.
            </Text>
          )}
        </View>
      )}

      {paymentFailed && (
        <View
          style={[styles.confirmation, { backgroundColor: theme.dangerSubtle }]}
          accessibilityRole="alert"
        >
          <Text style={[styles.confirmationTitle, { color: theme.danger }]}>
            {BOOKING_PAYMENT_STATUS_LABELS_FR[data.payment.status]}
          </Text>
          <Text style={[styles.confirmationBody, { color: theme.textSecondary }]}>
            Aucune place n’est retenue pour ce paiement.
          </Text>
          {checkoutUrl && (
            <Button
              label="Réessayer le paiement"
              variant="secondary"
              onPress={() => void openCheckout(checkoutUrl)}
              loading={reopening}
              haptic="light"
              style={{ marginTop: spacing.sm }}
            />
          )}
        </View>
      )}

      <Text style={[styles.title, { color: theme.textPrimary }]} accessibilityRole="header">
        {data.offer.title}
      </Text>
      <Text style={[styles.venue, { color: theme.textSecondary }]}>{data.venue.name}</Text>

      <View style={[styles.card, { backgroundColor: theme.surfaceMuted }]}>
        <Row label="Quand" value={`${formatDateInZone(startAt, timeZone)} · ${formatTimeInZone(startAt, timeZone)}`} />
        <Row label="Où" value={`${data.venue.addressLine}, ${data.venue.cityName}`} />
        <Row label="Durée" value={`${data.offer.durationMinutes} min`} />
        <Row
          label="Prix"
          value={formatMoney(data.price, { freeLabel: 'Gratuit', compactWholeAmounts: true })}
        />
        <Row label="Statut" value={statusLabel(data.status)} />
        {isPaidOffer && (
          <Row label="Paiement" value={BOOKING_PAYMENT_STATUS_LABELS_FR[data.payment.status]} />
        )}
      </View>

      {data.checkIn && isConfirmed && (
        <View style={[styles.card, { backgroundColor: theme.accentSubtle }]}>
          <Text style={[styles.checkInTitle, { color: theme.textPrimary }]}>
            Ton code d’entrée
          </Text>
          <Text
            style={[styles.code, { color: theme.textPrimary }]}
            accessibilityLabel={`Code d'entrée ${data.checkIn.shortCode.split('').join(' ')}`}
          >
            {data.checkIn.shortCode}
          </Text>
          <Button
            label="Afficher le QR code"
            variant="secondary"
            onPress={() =>
              router.push({ pathname: '/booking/[id]/qr', params: { id: data.id } })
            }
          />
        </View>
      )}

      {data.cancellation.canCancel && (
        <View style={styles.cancelBlock}>
          <Text style={[styles.policy, { color: theme.textTertiary }]}>
            {data.cancellation.policyLabel}
            {!data.cancellation.refundable && data.price.amount > 0
              ? ' Passé ce délai, la séance n’est plus remboursée.'
              : ''}
          </Text>
          <Button
            label="Annuler ma réservation"
            variant="ghost"
            onPress={() => cancel.mutate()}
            loading={cancel.isPending}
            haptic="none"
          />
        </View>
      )}

      {data.review?.canReview && (
        <Button
          label="Laisser un avis"
          onPress={() => router.push({ pathname: '/booking/[id]/review', params: { id: data.id } })}
          style={{ marginTop: spacing.base }}
        />
      )}
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: theme.textTertiary }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: theme.textPrimary }]}>{value}</Text>
    </View>
  );
}

function statusLabel(status: string): string {
  return (
    {
      PENDING: 'En attente',
      PAYMENT_PENDING: 'Paiement en attente',
      CONFIRMED: 'Confirmée',
      CHECKED_IN: 'Enregistrée sur place',
      COMPLETED: 'Terminée',
      CANCELLED_USER: 'Annulée',
      CANCELLED_BUSINESS: 'Annulée par le lieu',
      NO_SHOW: 'Absence',
      REFUNDED: 'Remboursée',
      EXPIRED: 'Expirée',
    }[status] ?? status
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  confirmation: {
    borderRadius: radius.xl,
    padding: spacing.xl,
    alignItems: 'center',
    marginBottom: spacing.xl,
    gap: spacing.xs,
  },
  confirmationEmoji: { fontSize: 32 },
  confirmationTitle: { fontSize: typography.title2.fontSize, fontWeight: '700' },
  confirmationBody: { fontSize: typography.footnote.fontSize, textAlign: 'center' },
  title: {
    fontSize: typography.title1.fontSize,
    lineHeight: typography.title1.lineHeight,
    fontWeight: '700',
  },
  venue: { fontSize: typography.callout.fontSize, marginTop: spacing.xxs },
  card: {
    borderRadius: radius.lg,
    padding: spacing.base,
    marginTop: spacing.lg,
    gap: spacing.md,
  },
  row: { gap: spacing.xxs },
  rowLabel: { fontSize: typography.caption.fontSize, textTransform: 'uppercase' },
  rowValue: { fontSize: typography.body.fontSize, fontWeight: '500' },
  checkInTitle: { fontSize: typography.title3.fontSize, fontWeight: '700' },
  code: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 4,
    textAlign: 'center',
    marginVertical: spacing.md,
    fontVariant: ['tabular-nums'],
  },
  cancelBlock: { marginTop: spacing.xxl, gap: spacing.sm },
  policy: { fontSize: typography.footnote.fontSize, textAlign: 'center' },
});
