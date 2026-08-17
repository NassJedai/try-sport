'use client';

import type { DistrictOption } from '@/lib/onboarding/types';
import { FieldErrorText } from './field-error-text';
import { StickyCta } from './sticky-cta';

export function VenueLocationStep({
  venueName,
  onVenueNameChange,
  addressLine,
  onAddressLineChange,
  postalCode,
  onPostalCodeChange,
  districtId,
  onDistrictIdChange,
  districts,
  showCityName,
  cityNameById,
  fieldErrors,
  onCancel,
  onContinue,
  ctaLabel = 'Continuer',
}: {
  venueName: string;
  onVenueNameChange: (value: string) => void;
  addressLine: string;
  onAddressLineChange: (value: string) => void;
  postalCode: string;
  onPostalCodeChange: (value: string) => void;
  districtId: string;
  onDistrictIdChange: (value: string) => void;
  districts: DistrictOption[];
  /** Vrai seulement si plusieurs villes sont actives — Bruxelles seule aujourd'hui. */
  showCityName: boolean;
  cityNameById: Record<string, string>;
  fieldErrors: Record<string, string[]>;
  onCancel?: () => void;
  onContinue: () => void;
  ctaLabel?: string;
}) {
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
      <h1 className="text-3xl font-bold">Où ça se passe</h1>
      <p className="text-text-secondary">Là où les clients viendront essayer.</p>

      <div>
        <label htmlFor="vname" className="text-sm font-semibold">
          Nom du lieu
        </label>
        <input
          id="vname"
          value={venueName}
          onChange={(event) => onVenueNameChange(event.target.value)}
          required
          minLength={2}
          autoComplete="organization"
          placeholder="Studio Exemple Ixelles"
          className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4"
        />
        <FieldErrorText message={fieldErrors.name?.[0]} />
      </div>

      <div>
        <label htmlFor="vaddr" className="text-sm font-semibold">
          Adresse
        </label>
        <input
          id="vaddr"
          value={addressLine}
          onChange={(event) => onAddressLineChange(event.target.value)}
          required
          minLength={4}
          autoComplete="street-address"
          placeholder="Rue de la Paix 10"
          className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4"
        />
        <FieldErrorText message={fieldErrors.addressLine?.[0]} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="vcp" className="text-sm font-semibold">
            Code postal
          </label>
          <input
            id="vcp"
            value={postalCode}
            onChange={(event) => onPostalCodeChange(event.target.value)}
            required
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={12}
            placeholder="1050"
            className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4"
          />
          <FieldErrorText message={fieldErrors.postalCode?.[0]} />
        </div>
        <div>
          <label htmlFor="vdistrict" className="text-sm font-semibold">
            Commune
          </label>
          <select
            id="vdistrict"
            value={districtId}
            onChange={(event) => onDistrictIdChange(event.target.value)}
            required
            autoComplete="address-level2"
            className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-3"
          >
            <option value="">Choisir…</option>
            {districts.map((d) => (
              <option key={d.id} value={d.id}>
                {showCityName ? `${d.name} (${cityNameById[d.cityId] ?? ''})` : d.name}
              </option>
            ))}
          </select>
          <FieldErrorText message={fieldErrors.districtId?.[0] ?? fieldErrors.cityId?.[0]} />
        </div>
      </div>

      <StickyCta>
        <button
          type="submit"
          disabled={
            venueName.trim().length < 2 ||
            addressLine.trim().length < 4 ||
            !postalCode.trim() ||
            !districtId
          }
          className="min-h-12 w-full rounded-card bg-accent font-semibold text-on-accent disabled:opacity-50"
        >
          {ctaLabel}
        </button>
      </StickyCta>
    </form>
  );
}
