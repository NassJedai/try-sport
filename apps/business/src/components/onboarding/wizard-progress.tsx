import { WIZARD_STEPS, type WizardStep } from '@/lib/onboarding/constants';

const STEP_TITLES: Record<WizardStep, string> = {
  business: 'Ton établissement',
  'venue-location': 'Où ça se passe',
  'venue-activities': 'Ce qu’on pratique chez toi',
  'offer-basics': 'Ton offre découverte',
  'offer-format': 'Le format de la séance',
  schedule: 'Quand as-tu des séances ?',
  'complete-dossier': 'Complète ton dossier',
  review: 'Vérifie et envoie',
};

/**
 * Huit segments, un par écran que l'assistant crée réellement (voir
 * `WIZARD_STEPS`). Les segments faits et à faire utilisent `bg-accent-text` et
 * non `bg-accent` : le lime est un jeton d'aplat, posé sur lui-même il ne se
 * distingue pas du segment inactif.
 */
export function WizardProgress({ step }: { step: WizardStep }) {
  const index = WIZARD_STEPS.indexOf(step);

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
        Inscription · étape {index + 1} sur {WIZARD_STEPS.length} · {STEP_TITLES[step]}
      </p>
      <div className="mt-2 flex gap-1" aria-hidden>
        {WIZARD_STEPS.map((s, i) => (
          <div
            key={s}
            className={`h-1.5 flex-1 rounded-full ${i <= index ? 'bg-accent-text' : 'bg-surface-muted'}`}
          />
        ))}
      </div>
    </div>
  );
}
