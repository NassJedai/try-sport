'use client';

import { DAY_OPTIONS } from '@/lib/onboarding/constants';
import { PillToggle } from './pill-toggle';
import { StickyCta } from './sticky-cta';

export function ScheduleStep({
  daysOfWeek,
  onToggleDay,
  times,
  onTimeChange,
  onAddTime,
  onRemoveTime,
  capacity,
  scheduleError,
  onSubmit,
  isPending,
  ctaLabel = 'Continuer',
}: {
  daysOfWeek: number[];
  onToggleDay: (day: number) => void;
  times: string[];
  onTimeChange: (index: number, value: string) => void;
  onAddTime: () => void;
  onRemoveTime: (index: number) => void;
  capacity: number;
  scheduleError: string | null;
  onSubmit: () => void;
  isPending: boolean;
  ctaLabel?: string;
}) {
  return (
    <form
      className="mt-8 flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <h1 className="text-3xl font-bold">Quand as-tu des séances ?</h1>
      <p className="text-text-secondary">
        Les créneaux des 30 prochains jours seront créés automatiquement, {capacity} place
        {capacity > 1 ? 's' : ''} chacun.
      </p>

      <fieldset>
        <legend className="text-sm font-semibold">Jours</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {DAY_OPTIONS.map(({ value, label }) => (
            <PillToggle key={value} pressed={daysOfWeek.includes(value)} onClick={() => onToggleDay(value)}>
              {label}
            </PillToggle>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-semibold">Heure de début</legend>
        <div className="mt-2 flex flex-col gap-2">
          {times.map((time, index) => (
            <div key={index} className="flex items-center gap-2">
              <label className="sr-only" htmlFor={`stime-${index}`}>
                Heure de début {index + 1}
              </label>
              <input
                id={`stime-${index}`}
                type="time"
                value={time}
                onChange={(event) => onTimeChange(index, event.target.value)}
                required
                className="min-h-12 w-40 rounded-card border border-border bg-surface px-4"
              />
              {times.length > 1 && (
                <button
                  type="button"
                  onClick={() => onRemoveTime(index)}
                  aria-label={`Retirer l’heure ${time}`}
                  className="flex h-11 w-11 items-center justify-center rounded-card border border-border text-lg font-bold text-text-secondary"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={onAddTime}
          className="mt-2 min-h-11 self-start text-sm font-semibold text-accent-text underline"
        >
          + Ajouter une autre heure
        </button>
      </fieldset>

      {scheduleError && (
        <p role="alert" className="rounded-card bg-danger-subtle p-3 text-sm text-danger">
          {scheduleError}
        </p>
      )}

      <StickyCta>
        <button
          type="submit"
          disabled={isPending || daysOfWeek.length === 0}
          className="min-h-12 w-full rounded-card bg-accent font-semibold text-on-accent disabled:opacity-50"
        >
          {isPending ? 'Création des créneaux…' : ctaLabel}
        </button>
      </StickyCta>
    </form>
  );
}
