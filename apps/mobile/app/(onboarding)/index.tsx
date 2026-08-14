import { useState } from 'react';
import { Dimensions, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing, typography } from '@try/design-tokens';
import { useTheme } from '@/theme';
import { Button } from '@/components/Button';

const { width } = Dimensions.get('window');

/**
 * Three slides, then a choice. Deliberately short: onboarding is a cost the user
 * pays before getting anything, so it earns its place only by setting up the
 * personalisation that follows.
 */
const SLIDES = [
  {
    title: 'TRY',
    body: 'Découvre de nouvelles façons de bouger.',
  },
  {
    title: 'Les meilleures expériences sportives autour de toi.',
    body: 'Pilates, boxe, padel, escalade — teste avant de t’engager.',
  },
  {
    title: 'Sans engagement.',
    body: 'Une première séance, à prix découverte ou offerte. Tu décides ensuite.',
  },
] as const;

export default function OnboardingIntroScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(0);

  return (
    <View
      style={[
        styles.fill,
        { backgroundColor: theme.background, paddingBottom: insets.bottom + spacing.xl },
      ]}
    >
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(event) =>
          setIndex(Math.round(event.nativeEvent.contentOffset.x / width))
        }
      >
        {SLIDES.map((slide) => (
          <View key={slide.title} style={[styles.slide, { width }]}>
            <Text style={[styles.title, { color: theme.textPrimary }]} accessibilityRole="header">
              {slide.title}
            </Text>
            <Text style={[styles.body, { color: theme.textSecondary }]}>{slide.body}</Text>
          </View>
        ))}
      </ScrollView>

      <View style={styles.dots} accessible={false}>
        {SLIDES.map((slide, slideIndex) => (
          <View
            key={slide.title}
            style={[
              styles.dot,
              {
                backgroundColor: slideIndex === index ? theme.accent : theme.border,
                width: slideIndex === index ? 24 : 8,
              },
            ]}
          />
        ))}
      </View>

      <View style={styles.actions}>
        <Button label="Commencer" onPress={() => router.push('/(auth)/sign-in')} />
        <Button
          label="Explorer sans compte"
          variant="ghost"
          haptic="none"
          // Browsing before signing up is deliberate: asking for an account
          // before showing value is the fastest way to lose someone.
          onPress={() => router.replace('/(tabs)')}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  slide: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.xl, gap: spacing.base },
  title: {
    fontSize: typography.display.fontSize,
    lineHeight: typography.display.lineHeight,
    fontWeight: '700',
  },
  body: { fontSize: typography.body.fontSize, lineHeight: typography.body.lineHeight },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm, marginBottom: spacing.xl },
  dot: { height: 8, borderRadius: 4 },
  actions: { paddingHorizontal: spacing.xl, gap: spacing.sm },
});
