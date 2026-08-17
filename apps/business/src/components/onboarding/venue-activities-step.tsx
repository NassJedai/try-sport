'use client';

import type { CategoryOption } from '@/lib/onboarding/types';
import { FieldErrorText } from './field-error-text';
import { PillToggle } from './pill-toggle';
import { StickyCta } from './sticky-cta';

const MAX_CATEGORIES = 10;

export function VenueActivitiesStep({
  categories,
  categoryIds,
  onToggleCategory,
  fieldErrors,
  onBack,
  onSubmit,
  isPending,
  ctaLabel = 'Continuer',
}: {
  categories: CategoryOption[];
  categoryIds: string[];
  onToggleCategory: (id: string) => void;
  fieldErrors: Record<string, string[]>;
  onBack: () => void;
  onSubmit: () => void;
  isPending: boolean;
  ctaLabel?: string;
}) {
  const atMax = categoryIds.length >= MAX_CATEGORIES;

  return (
    <form
      className="mt-8 flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <button
        type="button"
        onClick={onBack}
        className="self-start text-sm font-semibold text-text-secondary hover:underline"
      >
        ← Retour
      </button>
      <h1 className="text-3xl font-bold">Ce qu’on pratique chez toi</h1>
      <p className="text-text-secondary">
        Choisis jusqu’à {MAX_CATEGORIES} activités. Tu pourras en ajouter d’autres plus tard.
      </p>

      <fieldset>
        <legend className="sr-only">Activités proposées</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {categories.map((c) => {
            const pressed = categoryIds.includes(c.id);
            return (
              <PillToggle
                key={c.id}
                pressed={pressed}
                disabled={!pressed && atMax}
                onClick={() => onToggleCategory(c.id)}
              >
                {c.name}
              </PillToggle>
            );
          })}
        </div>
        {atMax && (
          <p className="mt-2 text-sm text-text-secondary">
            Maximum atteint ({MAX_CATEGORIES}) — retire une activité pour en choisir une autre.
          </p>
        )}
        <FieldErrorText message={fieldErrors.categoryIds?.[0]} />
      </fieldset>

      <StickyCta>
        <button
          type="submit"
          disabled={isPending || categoryIds.length === 0}
          className="min-h-12 w-full rounded-card bg-accent font-semibold text-on-accent disabled:opacity-50"
        >
          {isPending ? '…' : ctaLabel}
        </button>
      </StickyCta>
    </form>
  );
}
