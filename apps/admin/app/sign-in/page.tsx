'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '@try/api-client';
import { api, tokenStore } from '@/lib/api';

/**
 * Passwordless sign-in for venue staff.
 *
 * Same mechanism as the consumer app: an emailed one-time code, no password to
 * be reused or leaked. The API reports the same success for unknown addresses,
 * so this screen must not imply whether an account exists.
 */
export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');

  const requestCode = useMutation({
    mutationFn: () => api.auth.requestOtp(email.trim().toLowerCase()),
    onSuccess: () => setStep('code'),
  });

  const verify = useMutation({
    mutationFn: () => api.auth.verifyOtp({ email: email.trim().toLowerCase(), code }),
    onSuccess: async (session) => {
      await tokenStore.setTokens(session.tokens);
      router.push('/');
      // The dashboard reads the viewer through TanStack Query; a refresh
      // guarantees it sees the new token rather than a cached anonymous state.
      router.refresh();
    },
  });

  const error = requestCode.error ?? verify.error;
  const pending = requestCode.isPending || verify.isPending;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <h1 className="text-3xl font-bold">
        {step === 'email' ? 'Console TRY' : 'Ton code'}
      </h1>
      <p className="mt-2 text-ink-500">
        {step === 'email'
          ? 'On t’envoie un code à 6 chiffres. Pas de mot de passe à retenir.'
          : `Code envoyé à ${email}. Il expire dans 10 minutes.`}
      </p>

      <form
        className="mt-8 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (step === 'email') requestCode.mutate();
          else verify.mutate();
        }}
      >
        {step === 'email' ? (
          <>
            <label htmlFor="email" className="sr-only">
              Adresse e-mail
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="admin@try.local"
              autoComplete="email"
              required
              className="min-h-12 rounded-card border border-border bg-surface px-4"
            />
          </>
        ) : (
          <>
            <label htmlFor="code" className="sr-only">
              Code à six chiffres
            </label>
            <input
              id="code"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              autoComplete="one-time-code"
              required
              className="min-h-12 rounded-card border border-border bg-surface px-4 text-center text-2xl font-bold tracking-[0.4em]"
            />
          </>
        )}

        {error && (
          <p role="alert" className="rounded-card bg-danger-subtle p-3 text-sm text-danger">
            {error instanceof ApiError ? error.message : 'Une erreur est survenue.'}
          </p>
        )}

        <button
          type="submit"
          disabled={pending || (step === 'email' ? email.length < 5 : code.length !== 6)}
          className="min-h-12 rounded-card bg-accent px-5 font-semibold text-white disabled:opacity-50"
        >
          {pending ? '…' : step === 'email' ? 'Recevoir mon code' : 'Se connecter'}
        </button>

        {step === 'code' && (
          <button
            type="button"
            onClick={() => {
              setStep('email');
              setCode('');
            }}
            className="min-h-12 text-sm font-semibold text-ink-500 underline"
          >
            Modifier l’adresse
          </button>
        )}
      </form>

      <p className="mt-8 text-xs text-ink-400">
        Accès réservé à l’équipe TRY.
      </p>
    </main>
  );
}
