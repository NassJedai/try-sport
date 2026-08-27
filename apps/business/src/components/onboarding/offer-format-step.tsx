'use client';

import type { CancellationPolicy, ExperienceType, Locale, OfferStatus, SkillLevel, TrialRule } from '@try/contracts';
import { canEditOfferField, offerEditRefusalReason, offerTrialConfigurationIsCoherent } from '@try/contracts';
import { CapacityStepper } from './capacity-stepper';
import {
  CANCELLATION_POLICY_OPTIONS,
  DURATION_OPTIONS_MINUTES,
  EXPERIENCE_TYPE_OPTIONS,
  LANGUAGE_OPTIONS,
  SKILL_LEVEL_OPTIONS,
  TRIAL_RULE_OPTIONS,
} from '@/lib/onboarding/constants';
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
  trialRule,
  onTrialRuleChange,
  skillLevel,
  onSkillLevelChange,
  languages,
  onLanguagesChange,
  cancellationPolicy,
  onCancellationPolicyChange,
  /**
   * Statut de l'offre en cours d'édition — `null` en création, où
   * `trialRule` est toujours modifiable (l'assistant crée en `DRAFT`). Une
   * offre `ACTIVE`/`PAUSED`/`PENDING_APPROVAL` gèle ce champ : voir
   * `editable-fields.ts`. Aujourd'hui l'assistant ne peut de toute façon pas
   * rouvrir une offre dans cet état (`resolveResumePoint` redirige vers le
   * tableau de bord avant) — ce garde-fou est une seconde ligne de défense,
   * pas la première.
   */
  offerStatus,
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
  trialRule: TrialRule;
  onTrialRuleChange: (value: TrialRule) => void;
  skillLevel: SkillLevel;
  onSkillLevelChange: (value: SkillLevel) => void;
  languages: Locale[];
  onLanguagesChange: (value: Locale[]) => void;
  cancellationPolicy: CancellationPolicy;
  onCancellationPolicyChange: (value: CancellationPolicy) => void;
  offerStatus?: OfferStatus | null;
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

  const trialRuleLocked = Boolean(offerStatus) && !canEditOfferField(offerStatus as OfferStatus, 'trialRule');
  const trialRuleLockReason = offerStatus ? offerEditRefusalReason(offerStatus) : null;

  /**
   * Vérifiée côté client avant l'envoi, avec la même fonction que le serveur
   * (`offerTrialConfigurationIsCoherent`) : une offre à tarif découverte ne
   * peut pas être « sans limite », sinon l'essai devient une réduction
   * permanente. Le serveur refuserait de toute façon (400, `path:
   * ['trialRule']`) — mais laisser partir la requête pour se la faire
   * retourner est précisément ce que ce lot doit éviter.
   */
  const trialConfigCoherent = offerTrialConfigurationIsCoherent({ experienceType, trialRule });

  const toggleLanguage = (value: Locale) => {
    const already = languages.includes(value);
    if (already) {
      // Au moins une langue reste sélectionnée — le schéma serveur refuse un
      // tableau vide, autant ne pas produire un état qu'on sait invalide.
      if (languages.length === 1) return;
      onLanguagesChange(languages.filter((l) => l !== value));
    } else {
      onLanguagesChange([...languages, value]);
    }
  };

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
        <legend className="text-sm font-semibold">Qui a droit à ce tarif ?</legend>
        <p className="mt-1 text-sm text-text-secondary">
          Une fois utilisé, un client bascule sur ton tarif normal — TRIALYA est une plateforme de
          découverte, pas de bons plans permanents. Toi seul choisis dans quelle mesure.
        </p>
        {trialRuleLocked && trialRuleLockReason && (
          <p role="alert" className="mt-2 rounded-card bg-surface-muted p-3 text-sm text-text-secondary">
            {trialRuleLockReason}
          </p>
        )}
        <div className="mt-2 flex flex-col gap-2">
          {TRIAL_RULE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={trialRuleLocked}
              onClick={() => onTrialRuleChange(option.value)}
              aria-pressed={trialRule === option.value}
              className={`flex min-h-12 items-center justify-between rounded-card border-2 px-4 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                trialRule === option.value
                  ? 'border-accent bg-accent-subtle'
                  : 'border-border bg-surface'
              }`}
            >
              <span>
                <span className="block font-semibold">{option.label}</span>
                <span className="block text-sm text-text-secondary">{option.hint}</span>
              </span>
              {trialRule === option.value && (
                <span className="text-accent-text" aria-hidden>
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
        {!trialConfigCoherent && (
          <p role="alert" className="mt-2 text-sm text-danger">
            « Pas de limite » n’est possible que sur une offre au tarif normal — choisis « Un essai par
            salle », « par offre » ou « dans toutes mes salles » tant que cette offre a un tarif
            découverte.
          </p>
        )}
        <FieldErrorText message={fieldErrors.trialRule?.[0]} />
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

      <details className="rounded-card border border-border">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">
          Options avancées <span className="font-normal text-text-secondary">(facultatif)</span>
        </summary>
        <div className="flex flex-col gap-5 border-t border-border p-4">
          <fieldset>
            <legend className="text-sm font-semibold">Niveau</legend>
            <p className="mt-1 text-sm text-text-secondary">
              « Tous niveaux » convient à la plupart des séances découverte — change-le seulement si
              cette offre en particulier suppose une base.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {SKILL_LEVEL_OPTIONS.map((option) => (
                <PillToggle
                  key={option.value}
                  pressed={skillLevel === option.value}
                  onClick={() => onSkillLevelChange(option.value)}
                >
                  {option.label}
                </PillToggle>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-sm font-semibold">Langues du cours</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {LANGUAGE_OPTIONS.map((option) => (
                <PillToggle
                  key={option.value}
                  pressed={languages.includes(option.value)}
                  onClick={() => toggleLanguage(option.value)}
                >
                  {option.label}
                </PillToggle>
              ))}
            </div>
            <FieldErrorText message={fieldErrors.languages?.[0]} />
          </fieldset>

          <fieldset>
            <legend className="text-sm font-semibold">Politique d’annulation</legend>
            <div className="mt-2 flex flex-col gap-2">
              {CANCELLATION_POLICY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onCancellationPolicyChange(option.value)}
                  aria-pressed={cancellationPolicy === option.value}
                  className={`min-h-11 rounded-card border-2 px-4 py-2 text-left text-sm transition ${
                    cancellationPolicy === option.value
                      ? 'border-accent bg-accent-subtle'
                      : 'border-border bg-surface text-text-secondary'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      </details>

      <StickyCta>
        <button
          type="submit"
          disabled={isPending || !priceLooksValid || !trialConfigCoherent}
          className="min-h-12 w-full rounded-card bg-accent font-semibold text-on-accent disabled:opacity-50"
        >
          {isPending ? '…' : ctaLabel}
        </button>
      </StickyCta>
    </form>
  );
}
