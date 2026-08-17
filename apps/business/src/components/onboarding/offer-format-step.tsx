'use client';

import type { ExperienceType } from '@try/contracts';
import { CapacityStepper } from './capacity-stepper';
import { DURATION_OPTIONS_MINUTES, EXPERIENCE_TYPE_OPTIONS } from '@/lib/onboarding/constants';
import { FieldErrorText } from './field-error-text';
import { PillToggle } from './pill-toggle';
import { StickyCta } from './sticky-cta';

export function OfferFormatStep({
  experienceType,
  onExperienceTypeChange,
  isPaid,
  onTogglePaid,
  price,
  onPriceChange,
  referencePrice,
  onReferencePriceChange,
  duration,
  onDurationChange,
  capacity,
  onCapacityChange,
  fieldErrors,
  onBack,
  onSubmit,
  isPending,
  ctaLabel = 'Continuer',
}: {
  experienceType: ExperienceType;
  onExperienceTypeChange: (value: ExperienceType) => void;
  isPaid: boolean;
  onTogglePaid: (paid: boolean) => void;
  price: string;
  onPriceChange: (value: string) => void;
  referencePrice: string;
  onReferencePriceChange: (value: string) => void;
  duration: string;
  onDurationChange: (value: string) => void;
  capacity: number;
  onCapacityChange: (value: number) => void;
  fieldErrors: Record<string, string[]>;
  onBack: () => void;
  onSubmit: () => void;
  isPending: boolean;
  ctaLabel?: string;
}) {
  // Un prix strictement positif est demandé côté saisie quand « Payant » est
  // choisi ; 0€ payant n'a pas de sens pour l'utilisateur, même si le serveur
  // l'accepterait techniquement.
  const priceLooksValid = !isPaid || (price.trim() !== '' && Number(price.replace(',', '.')) > 0);

  return (
    <form
      className="mt-8 flex flex-col gap-5"
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
      <h1 className="text-3xl font-bold">Le format de la séance</h1>

      <fieldset>
        <legend className="text-sm font-semibold">Prix de la séance découverte</legend>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => onTogglePaid(false)}
            aria-pressed={!isPaid}
            className={`min-h-14 rounded-card border-2 text-base font-semibold transition ${
              !isPaid ? 'border-accent bg-accent-subtle text-accent-text' : 'border-border text-text-secondary'
            }`}
          >
            Gratuit
          </button>
          <button
            type="button"
            onClick={() => onTogglePaid(true)}
            aria-pressed={isPaid}
            className={`min-h-14 rounded-card border-2 text-base font-semibold transition ${
              isPaid ? 'border-accent bg-accent-subtle text-accent-text' : 'border-border text-text-secondary'
            }`}
          >
            Payant
          </button>
        </div>

        {isPaid && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="oprice" className="text-sm font-semibold">
                Prix découverte (€)
              </label>
              <input
                id="oprice"
                value={price}
                onChange={(event) => onPriceChange(event.target.value)}
                inputMode="decimal"
                placeholder="8"
                className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4"
              />
              <FieldErrorText message={fieldErrors.priceAmount?.[0]} />
            </div>
            <div>
              <label htmlFor="orefprice" className="text-sm font-semibold">
                Prix habituel (€)
              </label>
              <input
                id="orefprice"
                value={referencePrice}
                onChange={(event) => onReferencePriceChange(event.target.value)}
                inputMode="decimal"
                placeholder="facultatif"
                className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4"
              />
              <FieldErrorText message={fieldErrors.referencePriceAmount?.[0]} />
            </div>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend className="text-sm font-semibold">Type d’offre</legend>
        <p className="mt-1 text-sm text-text-secondary">
          Pré-sélectionné d’après le prix — change-le si un autre format correspond mieux.
        </p>
        <div className="mt-2 flex flex-col gap-2">
          {EXPERIENCE_TYPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onExperienceTypeChange(option.value)}
              aria-pressed={experienceType === option.value}
              className={`flex min-h-12 items-center justify-between rounded-card border-2 px-4 py-2 text-left transition ${
                experienceType === option.value
                  ? 'border-accent bg-accent-subtle'
                  : 'border-border bg-surface'
              }`}
            >
              <span>
                <span className="block font-semibold">{option.label}</span>
                <span className="block text-sm text-text-secondary">{option.hint}</span>
              </span>
              {experienceType === option.value && (
                <span className="text-accent-text" aria-hidden>
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
        <FieldErrorText message={fieldErrors.experienceType?.[0]} />
      </fieldset>

      <fieldset>
        <legend className="text-sm font-semibold">Durée</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {DURATION_OPTIONS_MINUTES.map((minutes) => (
            <PillToggle
              key={minutes}
              pressed={duration === String(minutes)}
              onClick={() => onDurationChange(String(minutes))}
            >
              {minutes} min
            </PillToggle>
          ))}
        </div>
        <FieldErrorText message={fieldErrors.durationMinutes?.[0]} />
      </fieldset>

      <CapacityStepper value={capacity} onChange={onCapacityChange} label="Places par séance" />
      <FieldErrorText message={fieldErrors.capacity?.[0]} />

      <StickyCta>
        <button
          type="submit"
          disabled={isPending || !priceLooksValid}
          className="min-h-12 w-full rounded-card bg-accent font-semibold text-on-accent disabled:opacity-50"
        >
          {isPending ? '…' : ctaLabel}
        </button>
      </StickyCta>
    </form>
  );
}
