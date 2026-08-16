import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import { radius, spacing, typography } from '@try/design-tokens';
import { api } from '@/api/client';
import { useTheme } from '@/theme';
import { Button } from '@/components/Button';
import { Skeleton } from '@/components/Skeleton';

/**
 * Interest selection. This is the only personalisation signal available before a
 * user has any history, and it drives the "Pour toi" rail on the home screen.
 */
export default function InterestsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.discovery.home({}),
    queryFn: () => api.discovery.home({}),
  });

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <View style={[styles.fill, { backgroundColor: theme.background, paddingTop: insets.top + spacing.xl }]}>
      <Text style={[styles.title, { color: theme.textPrimary }]} accessibilityRole="header">
        Qu’aimerais-tu essayer ?
      </Text>
      <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
        Choisis ce qui t’intéresse. Tu pourras changer d’avis à tout moment.
      </Text>

      <ScrollView contentContainerStyle={styles.chips}>
        {isLoading
          ? Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} width={110} height={44} borderRadius={radius.pill} />
            ))
          : (data?.categories ?? []).map((category) => {
              const isSelected = selected.has(category.id);
              return (
                <Pressable
                  key={category.id}
                  onPress={() => toggle(category.id)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected }}
                  accessibilityLabel={category.name}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: isSelected ? theme.accent : theme.surfaceMuted,
                      borderColor: isSelected ? theme.accentText : theme.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.chipLabel,
                      { color: isSelected ? theme.onAccent : theme.textPrimary },
                    ]}
                  >
                    {category.name}
                  </Text>
                </Pressable>
              );
            })}
      </ScrollView>

      <View style={[styles.actions, { paddingBottom: insets.bottom + spacing.base }]}>
        <Button
          label={selected.size === 0 ? 'Choisis au moins une activité' : 'Continuer'}
          disabled={selected.size === 0}
          onPress={() => router.push('/(onboarding)/location')}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  title: {
    fontSize: typography.title1.fontSize,
    lineHeight: typography.title1.lineHeight,
    fontWeight: '700',
    paddingHorizontal: spacing.xl,
  },
  subtitle: {
    fontSize: typography.body.fontSize,
    paddingHorizontal: spacing.xl,
    marginTop: spacing.sm,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    padding: spacing.xl,
  },
  chip: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    minHeight: 48,
    justifyContent: 'center',
  },
  chipLabel: { fontSize: typography.callout.fontSize, fontWeight: '600' },
  actions: { paddingHorizontal: spacing.xl },
});
