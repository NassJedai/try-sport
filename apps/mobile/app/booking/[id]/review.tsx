import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, queryKeys } from '@try/api-client';
import type { ContinuationAnswer } from '@try/contracts';
import { radius, spacing, typography } from '@try/design-tokens';
import { apiClient } from '@/api/client';
import { useTheme } from '@/theme';
import { Button } from '@/components/Button';

const CONTINUATION_OPTIONS: { value: ContinuationAnswer; label: string; hint: string }[] = [
  { value: 'YES', label: 'Oui', hint: 'Le lieu te recontactera' },
  { value: 'MAYBE', label: 'Peut-être', hint: 'Tu gardes la main' },
  { value: 'NO', label: 'Non', hint: 'On ne te relancera pas' },
];

/**
 * The post-experience screen.
 *
 * Rating and the continuation question are on one screen and submit together:
 * split across two steps, most people would answer the first and abandon the
 * second — and the second is the one that creates a qualified lead.
 */
export default function ReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [continuation, setContinuation] = useState<ContinuationAnswer | null>(null);
  const [shareWithVenue, setShareWithVenue] = useState(true);

  const submit = useMutation({
    mutationFn: () =>
      apiClient.post<{ reviewId: string }>(`/v1/bookings/${id}/review`, {
        rating,
        comment: comment.trim() || undefined,
        continuation: continuation ?? undefined,
        shareWithVenue,
      }),
    onSuccess: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void queryClient.invalidateQueries({ queryKey: queryKeys.bookings.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.offers.all });
      router.back();
    },
  });

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={{
        padding: spacing.xl,
        paddingTop: insets.top + spacing.xl,
        paddingBottom: insets.bottom + spacing.xxl,
        gap: spacing.xl,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: spacing.sm }}>
        <Text style={[styles.title, { color: theme.textPrimary }]} accessibilityRole="header">
          Comment s’est passée ton expérience ?
        </Text>
        <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
          Ton avis aide les autres à choisir.
        </Text>
      </View>

      <View
        style={styles.stars}
        accessibilityRole="radiogroup"
        accessibilityLabel="Note de 1 à 5 étoiles"
      >
        {[1, 2, 3, 4, 5].map((value) => (
          <Pressable
            key={value}
            onPress={() => {
              setRating(value);
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: rating === value }}
            accessibilityLabel={`${value} étoile${value > 1 ? 's' : ''}`}
            // Generous hit area: these are the primary control on the screen.
            hitSlop={8}
            style={styles.star}
          >
            {/*
              La note est portée par la forme du glyphe, pas par sa couleur.

              Pleine et vide étant le même ★ à deux teintes, la note reposait
              entièrement sur l'écart entre ces deux teintes — et cet écart ne
              peut pas exister : allumée et éteinte doivent toutes deux se
              détacher d'une page claire, donc partager sa plage de luminance,
              donc se ressembler. ★ contre ☆ règle la question indépendamment
              du thème et de la vision des couleurs.
            */}
            <Text
              style={{
                fontSize: 40,
                color: value <= rating ? theme.accentText : theme.borderStrong,
              }}
            >
              {value <= rating ? '★' : '☆'}
            </Text>
          </Pressable>
        ))}
      </View>

      <TextInput
        value={comment}
        onChangeText={setComment}
        placeholder="Un mot sur ta séance ? (facultatif)"
        placeholderTextColor={theme.textTertiary}
        multiline
        maxLength={2000}
        accessibilityLabel="Commentaire facultatif"
        style={[
          styles.input,
          { backgroundColor: theme.surfaceMuted, color: theme.textPrimary },
        ]}
      />

      <View style={{ gap: spacing.md }}>
        <Text style={[styles.question, { color: theme.textPrimary }]} accessibilityRole="header">
          Tu aimerais continuer ?
        </Text>

        <View style={styles.options} accessibilityRole="radiogroup">
          {CONTINUATION_OPTIONS.map((option) => {
            const isSelected = continuation === option.value;
            return (
              <Pressable
                key={option.value}
                onPress={() => setContinuation(option.value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={`${option.label}. ${option.hint}`}
                style={[
                  styles.option,
                  {
                    backgroundColor: isSelected ? theme.accent : theme.surfaceMuted,
                    // Le contour est ce qui détache l'option sélectionnée de la
                    // page : en lime sur lime il n'y a plus de bord du tout.
                    borderColor: isSelected ? theme.accentText : theme.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.optionLabel,
                    { color: isSelected ? theme.onAccent : theme.textPrimary },
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {continuation && (
          <Text style={[styles.hint, { color: theme.textTertiary }]}>
            {CONTINUATION_OPTIONS.find((option) => option.value === continuation)?.hint}
          </Text>
        )}
      </View>

      {/* Consent is explicit and reversible before submitting. The venue only
          receives contact details when this is on. */}
      {continuation === 'YES' && (
        <View style={[styles.consent, { backgroundColor: theme.surfaceMuted }]}>
          <View style={{ flex: 1, gap: spacing.xxs }}>
            <Text style={[styles.consentLabel, { color: theme.textPrimary }]}>
              Partager mon contact avec le lieu
            </Text>
            <Text style={[styles.hint, { color: theme.textSecondary }]}>
              Pour qu’il puisse te proposer la suite. Tu peux refuser.
            </Text>
          </View>
          <Switch
            value={shareWithVenue}
            onValueChange={setShareWithVenue}
            accessibilityLabel="Partager mon contact avec le lieu"
          />
        </View>
      )}

      {submit.isError && (
        <Text style={[styles.error, { color: theme.danger }]} accessibilityRole="alert">
          {submit.error instanceof ApiError
            ? submit.error.message
            : 'Ton avis n’a pas pu être envoyé. Réessaie dans quelques instants.'}
        </Text>
      )}

      <Button
        label="Envoyer mon avis"
        onPress={() => submit.mutate()}
        disabled={rating === 0}
        loading={submit.isPending}
        haptic="none"
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: typography.title1.fontSize,
    lineHeight: typography.title1.lineHeight,
    fontWeight: '700',
  },
  subtitle: { fontSize: typography.body.fontSize },
  stars: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm },
  star: { padding: spacing.xs, minHeight: 56, minWidth: 56, alignItems: 'center' },
  input: {
    borderRadius: radius.lg,
    padding: spacing.base,
    minHeight: 110,
    textAlignVertical: 'top',
    fontSize: typography.body.fontSize,
  },
  question: { fontSize: typography.title3.fontSize, fontWeight: '700' },
  options: { flexDirection: 'row', gap: spacing.sm },
  option: {
    flex: 1,
    paddingVertical: spacing.base,
    borderRadius: radius.lg,
    borderWidth: 1,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
  },
  optionLabel: { fontSize: typography.bodyStrong.fontSize, fontWeight: '600' },
  hint: { fontSize: typography.footnote.fontSize },
  consent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.base,
    padding: spacing.base,
    borderRadius: radius.lg,
  },
  consentLabel: { fontSize: typography.bodyStrong.fontSize, fontWeight: '600' },
  error: { fontSize: typography.footnote.fontSize, fontWeight: '600' },
});
