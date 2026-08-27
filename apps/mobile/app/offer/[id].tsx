import { useCallback, useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, queryKeys } from '@try/api-client';
import type { SlotDto } from '@try/contracts';
import {
  formatDateInZone,
  formatDistance,
  formatMoney,
  formatTimeInZone,
  generateSecureToken,
} from '@try/utils';
import { radius, shadows, spacing, typography } from '@try/design-tokens';
import { api } from '@/api/client';
import { AVAILABILITY_QUERY_OPTIONS } from '@/api/query-client';
import { useTheme } from '@/theme';
import { Button } from '@/components/Button';
import { Skeleton } from '@/components/Skeleton';
import { ErrorState } from '@/components/States';
import { Rating } from '@/components/Rating';
import { useFavorite } from '@/hooks/use-favorite';

export default function OfferDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [selectedSlot, setSelectedSlot] = useState<SlotDto | null>(null);
  const favorite = useFavorite(id);

  const offerQuery = useQuery({
    queryKey: queryKeys.offers.detail(id),
    queryFn: () => api.offers.detail(id),
  });

  /**
   * Availability is fetched separately and treated as always stale: an offer's
   * description can be minutes old without harm, but a slot that filled up 30
   * seconds ago will send the user into a booking that fails.
   */
  const availabilityQuery = useQuery({
    queryKey: queryKeys.offers.availability(id),
    queryFn: () => api.offers.availability(id),
    ...AVAILABILITY_QUERY_OPTIONS,
  });

  /**
   * One idempotency key per selected slot.
   *
   * Stable across retries of the *same* intent — a dropped connection resolves to
   * the original booking rather than a second one — but a genuinely new choice of
   * slot gets a new key.
   */
  const idempotencyKey = useMemo(
    () => (selectedSlot ? `${id}:${selectedSlot.id}:${generateSecureToken(8)}` : null),
    [id, selectedSlot],
  );

  const booking = useMutation({
    mutationFn: () => {
      if (!selectedSlot || !idempotencyKey) throw new Error('No slot selected');
      return api.bookings.create({ slotId: selectedSlot.id }, idempotencyKey);
    },
    onSuccess: (result) => {
      // Availability and the bookings list are both now wrong; refetch rather
      // than patch, because the server also moved capacity counters.
      void queryClient.invalidateQueries({ queryKey: queryKeys.offers.availability(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.bookings.all });
      // La fiche elle-meme est perimee, pas seulement ses creneaux : reserver
      // consomme l'allocation d'essai cote serveur, donc `viewerEligibility`
      // vient de changer. Sans cette ligne, revenir en arriere affiche encore
      // « Reserver mon essai » sur une offre deja essayee — le staleTime de
      // 60 s (api/query-client.ts) tient la fiche pour fraiche puisqu'elle
      // vient d'etre chargee. Constate au simulateur le 22 aout.
      void queryClient.invalidateQueries({ queryKey: queryKeys.offers.detail(id) });

      router.push({
        pathname: '/booking/[id]',
        params: {
          id: result.reservationId,
          created: '1',
          // Nul pour une offre gratuite : le paramètre est alors simplement
          // absent, et l'écran de réservation garde son parcours actuel
          // (confirmation immédiate, code d'entrée). Pour une offre payante,
          // c'est la seule occasion de transmettre cette adresse — l'API ne
          // la renvoie qu'à la création, jamais sur une relecture ultérieure
          // de la réservation (voir le commentaire dans booking/[id].tsx).
          ...(result.checkoutUrl ? { checkoutUrl: result.checkoutUrl } : {}),
        },
      });
    },
  });

  /**
   * `viewerEligibility` n'est `null` que pour un appelant anonyme — c'est le
   * contrat même de l'API (`packages/contracts/src/schemas/offers.ts`) :
   * « Null for anonymous callers, who see the offer but are asked to sign in
   * at booking time. » Le mobile ne tenait pas cette promesse : rien
   * n'empêchait un visiteur de choisir un créneau et de taper « Réserver »,
   * pour buter sur un 401 de `POST /v1/bookings` (protégé, voir
   * booking.controller.ts) sans explication.
   */
  const isAnonymousViewer = offerQuery.data?.viewerEligibility === null;

  const handleBook = useCallback(() => {
    if (!selectedSlot) return;
    if (isAnonymousViewer) {
      router.push('/(auth)/sign-in');
      return;
    }
    booking.mutate();
  }, [booking, isAnonymousViewer, router, selectedSlot]);

  if (offerQuery.isLoading) return <OfferDetailSkeleton />;

  if (offerQuery.isError) {
    return (
      <View style={[styles.fill, { backgroundColor: theme.background }]}>
        <ErrorState error={offerQuery.error} onRetry={() => void offerQuery.refetch()} />
      </View>
    );
  }

  const offer = offerQuery.data;
  if (!offer) return null;

  const isFree = offer.price.amount === 0;
  const ineligible = offer.viewerEligibility?.eligible === false;
  const days = availabilityQuery.data?.days ?? [];
  const timeZone = offer.venue.timeZone;

  return (
    <View style={[styles.fill, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top, paddingBottom: 140 }}>
        <View>
          {offer.gallery[0] ? (
            <Image
              source={{ uri: offer.gallery[0].medium }}
              style={styles.hero}
              resizeMode="cover"
              accessible={false}
            />
          ) : (
            <View style={[styles.hero, { backgroundColor: theme.surfaceMuted }]} />
          )}

          {/* Optimistic: the heart fills on tap and rolls back only if the
              server rejects it. Safe here because favouriting costs nothing.
              POST /v1/favorites/:id est protégé (favorite.controller.ts) — un
              visiteur anonyme ne doit jamais voir le cœur se remplir puis se
              vider sans explication ; on l'envoie se connecter directement. */}
          <Pressable
            onPress={() =>
              isAnonymousViewer ? router.push('/(auth)/sign-in') : favorite.toggle(offer.isFavorite)
            }
            accessibilityRole="switch"
            accessibilityState={{ checked: offer.isFavorite }}
            accessibilityLabel={
              offer.isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'
            }
            hitSlop={12}
            style={[styles.favorite, { backgroundColor: theme.background }]}
          >
            <Text style={{ fontSize: 22, color: offer.isFavorite ? theme.danger : theme.textTertiary }}>
              {offer.isFavorite ? '♥' : '♡'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.body}>
          <Text style={[styles.title, { color: theme.textPrimary }]} accessibilityRole="header">
            {offer.title}
          </Text>

          <Pressable
            onPress={() =>
              router.push({ pathname: '/venue/[id]', params: { id: offer.venue.id } })
            }
            accessibilityRole="link"
            accessibilityLabel={`Voir ${offer.venue.name}`}
          >
            <Text style={[styles.venue, { color: theme.textSecondary }]}>
              {offer.venue.name}
              {offer.venue.districtName ? ` · ${offer.venue.districtName}` : ''}
              {offer.distanceMeters !== null ? ` · ${formatDistance(offer.distanceMeters)}` : ''}
            </Text>
          </Pressable>

          {offer.reviews.averageRating !== null && (
            <Rating value={offer.reviews.averageRating} count={offer.reviews.reviewCount} />
          )}

          <View style={styles.metaRow}>
            <Meta label="Durée" value={`${offer.durationMinutes} min`} />
            <Meta label="Niveau" value={skillLabel(offer.skillLevel)} />
            <Meta label="Places" value={`${offer.capacity} max`} />
          </View>

          <Text style={[styles.description, { color: theme.textPrimary }]}>
            {offer.description}
          </Text>

          {offer.whatToBring.length > 0 && (
            <Section title="À prévoir">
              {offer.whatToBring.map((item) => (
                <Text key={item} style={[styles.listItem, { color: theme.textSecondary }]}>
                  • {item}
                </Text>
              ))}
            </Section>
          )}

          {offer.amenities.length > 0 && (
            <Section title="Sur place">
              {offer.amenities.map((item) => (
                <Text key={item} style={[styles.listItem, { color: theme.textSecondary }]}>
                  • {item}
                </Text>
              ))}
            </Section>
          )}

          <Section title="Annulation">
            <Text style={[styles.listItem, { color: theme.textSecondary }]}>
              {offer.cancellationPolicyLabel}
            </Text>
          </Section>

          <Section title="Choisis ton créneau">
            {availabilityQuery.isLoading ? (
              <View style={{ gap: spacing.sm }}>
                <Skeleton height={44} />
                <Skeleton height={44} />
              </View>
            ) : days.length === 0 ? (
              <Text style={[styles.listItem, { color: theme.textSecondary }]}>
                Aucun créneau disponible pour le moment. Reviens bientôt.
              </Text>
            ) : (
              days.slice(0, 7).map((day) => (
                <View key={day.date} style={styles.day}>
                  <Text style={[styles.dayLabel, { color: theme.textPrimary }]}>
                    {formatDateInZone(new Date(`${day.date}T12:00:00Z`), timeZone)}
                  </Text>
                  <View style={styles.slots}>
                    {day.slots.map((slot) => {
                      const isSelected = selectedSlot?.id === slot.id;
                      return (
                        <Pressable
                          key={slot.id}
                          disabled={!slot.isBookable}
                          onPress={() => setSelectedSlot(slot)}
                          accessibilityRole="radio"
                          accessibilityState={{
                            selected: isSelected,
                            disabled: !slot.isBookable,
                          }}
                          accessibilityLabel={`${formatTimeInZone(new Date(slot.startAt), timeZone)}${
                            slot.isBookable
                              ? `, ${slot.remainingCapacity} places restantes`
                              : ', complet'
                          }`}
                          style={[
                            styles.slot,
                            {
                              backgroundColor: isSelected ? theme.accent : theme.surfaceMuted,
                              opacity: slot.isBookable ? 1 : 0.4,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.slotTime,
                              { color: isSelected ? theme.onAccent : theme.textPrimary },
                            ]}
                          >
                            {formatTimeInZone(new Date(slot.startAt), timeZone)}
                          </Text>
                          {slot.isBookable && slot.remainingCapacity <= 3 && (
                            <Text
                              style={[
                                styles.slotHint,
                                { color: isSelected ? theme.onAccent : theme.price },
                              ]}
                            >
                              {slot.remainingCapacity} restantes
                            </Text>
                          )}
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ))
            )}
          </Section>
        </View>
      </ScrollView>

      {/* Sticky CTA: the price and the action stay reachable at all times. */}
      <View
        style={[
          styles.cta,
          {
            backgroundColor: theme.backgroundElevated,
            borderTopColor: theme.border,
            paddingBottom: insets.bottom + spacing.md,
          },
          shadows.lg,
        ]}
      >
        {ineligible && offer.viewerEligibility?.message && (
          <Text style={[styles.ctaNote, { color: theme.textSecondary }]}>
            {offer.viewerEligibility.message}
          </Text>
        )}
        {booking.isError && !ineligible && (
          // Le bandeau d'inéligibilité rend la même information au présent ;
          // empiler l'erreur de la tentative par-dessus ne fait que troubler.
          <Text
            style={[styles.ctaNote, styles.ctaNoteError, { color: theme.danger }]}
            accessibilityRole="alert"
          >
            {booking.error instanceof ApiError
              ? booking.error.message
              : 'Impossible de finaliser ta réservation. Aucun paiement n’a été débité.'}
          </Text>
        )}
        <View style={styles.ctaRow}>
        <View style={styles.ctaPrice}>
          {offer.referencePrice && (
            <Text style={[styles.ctaReference, { color: theme.textTertiary }]}>
              {formatMoney(offer.referencePrice, { compactWholeAmounts: true })}
            </Text>
          )}
          <Text
            style={[styles.ctaAmount, { color: isFree ? theme.success : theme.textPrimary }]}
          >
            {formatMoney(offer.price, { freeLabel: 'Gratuit', compactWholeAmounts: true })}
          </Text>
        </View>

        <View style={styles.ctaButton}>
          <Button
            label={
              ineligible
                ? 'Déjà essayé'
                : !selectedSlot
                  ? 'Choisis un créneau'
                  : isAnonymousViewer
                    ? 'Se connecter pour réserver'
                    : 'Réserver mon essai'
            }
            onPress={handleBook}
            disabled={ineligible || !selectedSlot}
            loading={booking.isPending}
            haptic="medium"
            accessibilityHint={
              ineligible
                ? (offer.viewerEligibility?.message ?? undefined)
                : isAnonymousViewer
                  ? 'Ouvre l’écran de connexion pour finaliser ta réservation'
                  : 'Confirme ta réservation'
            }
          />
        </View>
        </View>
      </View>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.textPrimary }]} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.meta}>
      <Text style={[styles.metaLabel, { color: theme.textTertiary }]}>{label}</Text>
      <Text style={[styles.metaValue, { color: theme.textPrimary }]}>{value}</Text>
    </View>
  );
}

function OfferDetailSkeleton() {
  const theme = useTheme();
  return (
    <View style={[styles.fill, { backgroundColor: theme.background }]}>
      <Skeleton height={280} borderRadius={0} />
      <View style={styles.body}>
        <Skeleton width="80%" height={28} />
        <Skeleton width="50%" height={16} />
        <Skeleton width="100%" height={80} />
      </View>
    </View>
  );
}

function skillLabel(level: string): string {
  return (
    {
      ALL_LEVELS: 'Tous niveaux',
      BEGINNER: 'Débutant',
      INTERMEDIATE: 'Intermédiaire',
      ADVANCED: 'Avancé',
    }[level] ?? level
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hero: { width: '100%', aspectRatio: 4 / 3 },
  favorite: {
    position: 'absolute',
    top: spacing.xl,
    right: spacing.base,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { padding: spacing.base, gap: spacing.sm },
  title: {
    fontSize: typography.title1.fontSize,
    lineHeight: typography.title1.lineHeight,
    fontWeight: '700',
  },
  venue: { fontSize: typography.callout.fontSize },
  metaRow: { flexDirection: 'row', gap: spacing.xl, marginVertical: spacing.md },
  meta: { gap: spacing.xxs },
  metaLabel: { fontSize: typography.caption.fontSize, textTransform: 'uppercase' },
  metaValue: { fontSize: typography.bodyStrong.fontSize, fontWeight: '600' },
  description: {
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
  },
  section: { marginTop: spacing.xl, gap: spacing.sm },
  sectionTitle: {
    fontSize: typography.title3.fontSize,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  listItem: { fontSize: typography.body.fontSize, lineHeight: typography.body.lineHeight },
  day: { marginBottom: spacing.base },
  dayLabel: {
    fontSize: typography.bodyStrong.fontSize,
    fontWeight: '600',
    marginBottom: spacing.sm,
    textTransform: 'capitalize',
  },
  slots: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  slot: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    minWidth: 88,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotTime: { fontSize: typography.bodyStrong.fontSize, fontWeight: '600' },
  slotHint: { fontSize: typography.caption.fontSize, marginTop: spacing.xxs },
  cta: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.base,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  ctaPrice: { gap: spacing.xxs },
  ctaReference: { fontSize: typography.footnote.fontSize, textDecorationLine: 'line-through' },
  ctaAmount: { fontSize: typography.title2.fontSize, fontWeight: '700' },
  ctaButton: { flex: 1 },
  ctaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.base },
  // Dans le flux de la barre, jamais flottant : un message positionné en
  // absolu finissait superposé au contenu de la page.
  ctaNote: {
    fontSize: typography.footnote.fontSize,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  ctaNoteError: { fontWeight: '600' },
});
