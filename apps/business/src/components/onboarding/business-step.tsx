'use client';

import { FieldErrorText } from './field-error-text';
import { StickyCta } from './sticky-cta';

export function BusinessStep({
  businessName,
  onBusinessNameChange,
  contactEmail,
  onContactEmailChange,
  editingEmail,
  onToggleEditingEmail,
  viewerReady,
  fieldErrors,
  onSubmit,
  isPending,
}: {
  businessName: string;
  onBusinessNameChange: (value: string) => void;
  contactEmail: string;
  onContactEmailChange: (value: string) => void;
  editingEmail: boolean;
  onToggleEditingEmail: () => void;
  /** Faux tant que `auth.me()` n'a pas répondu : sans ça `contactEmail` part vide, 400 sans cause visible. */
  viewerReady: boolean;
  fieldErrors: Record<string, string[]>;
  onSubmit: () => void;
  isPending: boolean;
}) {
  return (
    <form
      className="mt-8 flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <h1 className="text-3xl font-bold">Ton établissement</h1>
      <p className="text-text-secondary">Le nom sous lequel les clients te connaîtront.</p>

      <div>
        <label htmlFor="bname" className="text-sm font-semibold">
          Nom de l’établissement
        </label>
        <input
          id="bname"
          value={businessName}
          onChange={(event) => onBusinessNameChange(event.target.value)}
          placeholder="Studio Exemple"
          autoComplete="organization"
          required
          minLength={2}
          className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4"
        />
        <FieldErrorText message={fieldErrors.name?.[0]} />
      </div>

      <div>
        <span className="text-sm font-semibold">Adresse de contact</span>
        {editingEmail ? (
          <>
            <label htmlFor="bemail" className="sr-only">
              Adresse e-mail de contact
            </label>
            <input
              id="bemail"
              type="email"
              value={contactEmail}
              onChange={(event) => onContactEmailChange(event.target.value)}
              autoComplete="email"
              required
              className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4"
            />
          </>
        ) : (
          <p className="mt-1 flex flex-wrap items-center gap-2">
            <span className="text-text-secondary">{contactEmail || '…'}</span>
            <button
              type="button"
              onClick={onToggleEditingEmail}
              className="text-sm font-semibold text-accent-text underline"
            >
              Modifier
            </button>
          </p>
        )}
        <FieldErrorText message={fieldErrors.contactEmail?.[0]} />
      </div>

      <StickyCta>
        <button
          type="submit"
          disabled={isPending || !viewerReady || businessName.trim().length < 2 || !contactEmail.trim()}
          className="min-h-12 w-full rounded-card bg-accent font-semibold text-on-accent disabled:opacity-50"
        >
          {isPending ? '…' : 'Continuer'}
        </button>
      </StickyCta>
    </form>
  );
}
