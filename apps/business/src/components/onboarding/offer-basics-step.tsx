'use client';

import type { CategoryOption } from '@/lib/onboarding/types';
import { FieldErrorText } from './field-error-text';
import { StickyCta } from './sticky-cta';

const MIN_DESCRIPTION_LENGTH = 20;

export function OfferBasicsStep({
  venueBanner,
  title,
  onTitleChange,
  description,
  onDescriptionChange,
  categories,
  categoryId,
  onCategoryIdChange,
  fieldErrors,
  onCancel,
  onContinue,
  ctaLabel = 'Continuer',
}: {
  /** « Ton lieu *X* est déjà enregistré » — affiché quand on reprend après la création du lieu. */
  venueBanner?: string | null;
  title: string;
  onTitleChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  categories: CategoryOption[];
  categoryId: string;
  onCategoryIdChange: (value: string) => void;
  fieldErrors: Record<string, string[]>;
  onCancel?: () => void;
  onContinue: () => void;
  ctaLabel?: string;
}) {
  const remaining = Math.max(0, MIN_DESCRIPTION_LENGTH - description.trim().length);

  return (
    <form
      className="mt-8 flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onContinue();
      }}
    >
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="self-start text-sm font-semibold text-text-secondary hover:underline"
        >
          ← Annuler la modification
        </button>
      )}

      {venueBanner && (
        <p className="rounded-card bg-accent-subtle p-3 text-sm text-accent-text">{venueBanner}</p>
      )}

      <h1 className="text-3xl font-bold">Ton offre découverte</h1>
      <p className="text-text-secondary">Ce que les nouveaux clients pourront essayer.</p>

      <div>
        <label htmlFor="otitle" className="text-sm font-semibold">
          Titre
        </label>
        <input
          id="otitle"
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          required
          minLength={3}
          placeholder="Première séance découverte"
          className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4"
        />
        <FieldErrorText message={fieldErrors.title?.[0]} />
      </div>

      <div>
        <label htmlFor="odesc" className="text-sm font-semibold">
          Description
        </label>
        <textarea
          id="odesc"
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          required
          rows={4}
          placeholder="Décris la séance : à quoi s’attendre, pour quel niveau, ce qui est fourni…"
          className="mt-1 w-full rounded-card border border-border bg-surface p-4"
        />
        <p className={`mt-1 text-sm ${remaining > 0 ? 'text-warning' : 'text-success'}`}>
          {remaining > 0
            ? `Encore ${remaining} caractère${remaining > 1 ? 's' : ''}.`
            : 'Longueur suffisante.'}
        </p>
        <FieldErrorText message={fieldErrors.description?.[0]} />
      </div>

      {categories.length > 1 && (
        <div>
          <label htmlFor="ocat" className="text-sm font-semibold">
            Catégorie de l’offre
          </label>
          <select
            id="ocat"
            value={categoryId}
            onChange={(event) => onCategoryIdChange(event.target.value)}
            className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-3"
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <FieldErrorText message={fieldErrors.categoryId?.[0]} />
        </div>
      )}

      <StickyCta>
        <button
          type="submit"
          disabled={title.trim().length < 3 || remaining > 0}
          className="min-h-12 w-full rounded-card bg-accent font-semibold text-on-accent disabled:opacity-50"
        >
          {ctaLabel}
        </button>
      </StickyCta>
    </form>
  );
}
