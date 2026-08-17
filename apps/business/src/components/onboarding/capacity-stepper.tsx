import { MAX_OFFER_CAPACITY, MIN_OFFER_CAPACITY } from '@/lib/onboarding/constants';

/**
 * Des places qui se comptent par pas plutôt qu'un champ libre : un gérant sur
 * son téléphone entre deux cours tape difficilement un nombre exact, et rien
 * ne l'empêcherait de taper une virgule ou un nombre à trois chiffres par
 * erreur.
 */
export function CapacityStepper({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (next: number) => void;
  label: string;
}) {
  return (
    <div>
      <span className="text-sm font-semibold">{label}</span>
      <div className="mt-1 flex items-center gap-3">
        <button
          type="button"
          onClick={() => onChange(Math.max(MIN_OFFER_CAPACITY, value - 1))}
          disabled={value <= MIN_OFFER_CAPACITY}
          aria-label="Une place de moins"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-card border border-border text-xl font-bold disabled:cursor-not-allowed disabled:opacity-40"
        >
          −
        </button>
        <output className="min-w-12 text-center text-2xl font-bold tabular-nums" aria-live="polite">
          {value}
        </output>
        <button
          type="button"
          onClick={() => onChange(Math.min(MAX_OFFER_CAPACITY, value + 1))}
          disabled={value >= MAX_OFFER_CAPACITY}
          aria-label="Une place de plus"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-card border border-border text-xl font-bold disabled:cursor-not-allowed disabled:opacity-40"
        >
          +
        </button>
        <span className="text-sm text-text-secondary">place{value > 1 ? 's' : ''} par séance</span>
      </div>
    </div>
  );
}
