import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '@try/api-client';
import { spacing, radius, typography } from '@try/design-tokens';
import { api, tokenStore } from '@/api/client';
import { useTheme } from '@/theme';
import { Button } from '@/components/Button';

/**
 * Passwordless sign-in.
 *
 * Two steps, no password to forget or reuse. The API deliberately reports the
 * same success whether or not the address has an account, so this screen must
 * not imply otherwise.
 */
export default function SignInScreen() {
  const theme = useTheme();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');

  const requestOtp = useMutation({
    mutationFn: () => api.auth.requestOtp(email.trim().toLowerCase()),
    onSuccess: () => setStep('code'),
  });

  const verifyOtp = useMutation({
    mutationFn: () => api.auth.verifyOtp({ email: email.trim().toLowerCase(), code }),
    onSuccess: async (session) => {
      await tokenStore.setTokens(session.tokens);
      router.replace(session.viewer.onboardingCompletedAt ? '/(tabs)' : '/(onboarding)/interests');
    },
  });

  const error = requestOtp.error ?? verifyOtp.error;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.fill, { backgroundColor: theme.background }]}
    >
      <View style={styles.body}>
        <Text style={[styles.title, { color: theme.textPrimary }]} accessibilityRole="header">
          {step === 'email' ? 'Connecte-toi' : 'Ton code'}
        </Text>
        <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
          {step === 'email'
            ? 'On t’envoie un code à 6 chiffres. Pas de mot de passe à retenir.'
            : `Code envoyé à ${email}. Il expire dans 10 minutes.`}
        </Text>

        {step === 'email' ? (
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="ton@email.be"
            placeholderTextColor={theme.textTertiary}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            textContentType="emailAddress"
            accessibilityLabel="Adresse e-mail"
            style={[styles.input, { color: theme.textPrimary, backgroundColor: theme.surfaceMuted }]}
          />
        ) : (
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="123456"
            placeholderTextColor={theme.textTertiary}
            keyboardType="number-pad"
            maxLength={6}
            // Lets iOS and Android offer the code straight from the SMS/email.
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            accessibilityLabel="Code à six chiffres"
            style={[
              styles.input,
              styles.codeInput,
              { color: theme.textPrimary, backgroundColor: theme.surfaceMuted },
            ]}
          />
        )}

        {error && (
          <Text style={[styles.error, { color: theme.danger }]} accessibilityRole="alert">
            {error instanceof ApiError ? error.message : 'Une erreur est survenue.'}
          </Text>
        )}

        <Button
          label={step === 'email' ? 'Recevoir mon code' : 'Se connecter'}
          onPress={() => (step === 'email' ? requestOtp.mutate() : verifyOtp.mutate())}
          loading={requestOtp.isPending || verifyOtp.isPending}
          disabled={step === 'email' ? email.length < 5 : code.length !== 6}
        />

        {step === 'code' && (
          <Button
            label="Modifier l’adresse"
            variant="ghost"
            haptic="none"
            onPress={() => {
              setStep('email');
              setCode('');
            }}
          />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'center' },
  body: { padding: spacing.xl, gap: spacing.base },
  title: { fontSize: typography.display.fontSize, fontWeight: '700' },
  subtitle: { fontSize: typography.body.fontSize, lineHeight: typography.body.lineHeight },
  input: {
    borderRadius: radius.lg,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.base,
    fontSize: typography.body.fontSize,
    minHeight: 56,
  },
  codeInput: { fontSize: 28, letterSpacing: 8, textAlign: 'center', fontWeight: '700' },
  error: { fontSize: typography.footnote.fontSize, fontWeight: '600' },
});
