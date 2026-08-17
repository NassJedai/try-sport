'use client';

import { useState } from 'react';
import type { VenueSubmissionRequirement } from '@try/contracts';
import {
  VENUE_SUBMISSION_REQUIREMENT_ACTIONS_FR,
  VENUE_DESCRIPTION_MIN_LENGTH,
  validateVatNumber,
} from '@try/contracts';
import { PhotoManager } from '@/components/photo-manager';
import { FieldErrorText } from './field-error-text';
import { StickyCta } from './sticky-cta';

const DOSSIER_REQUIREMENTS: VenueSubmissionRequirement[] = [
  'AT_LEAST_ONE_PHOTO',
  'VENUE_DESCRIPTION',
  'VALID_VAT_NUMBER',
];

export function CompleteDossierStep({
  venueId,
  missingRequirements,
  description,
  onDescriptionChange,
  onSaveDescription,
  isSavingDescription,
  descriptionSaved,
  onPhotosChanged,
  fieldErrors,
  legalName,
  onLegalNameChange,
  vatNumber,
  onVatNumberChange,
  onContinue,
}: {
  venueId: string;
  missingRequirements: VenueSubmissionRequirement[];
  description: string;
  onDescriptionChange: (value: string) => void;
  onSaveDescription: () => void;
  isSavingDescription: boolean;
  /** Le compteur de photos vit dans une requête à part (`GET .../venues`) — sans ce
   * signal, uploader une photo ne rafraîchit pas la pastille « Aucune photo » ci-dessus. */
  onPhotosChanged: () => void;
  descriptionSaved: boolean;
  fieldErrors: Record<string, string[]>;
  legalName: string;
  onLegalNameChange: (value: string) => void;
  vatNumber: string;
  onVatNumberChange: (value: string) => void;
  onContinue: () => void;
}) {
  const [vatTouched, setVatTouched] = useState(false);
  const remaining = Math.max(0, VENUE_DESCRIPTION_MIN_LENGTH - description.trim().length);
  const descriptionChanged = remaining === 0; // le bouton « Enregistrer » se réactive après une modification
  const vatCheck = vatTouched && vatNumber.trim() ? validateVatNumber(vatNumber) : null;

  return (
    <div className="mt-8 flex flex-col gap-8">
      <div>
        <h1 className="text-3xl font-bold">Complète ton dossier</h1>
        <p className="mt-1 text-text-secondary">
          Aucune salle n’est visible sur TRIALYA sans photo, description et numéro de TVA — la
          vérification ne démarre qu’une fois le dossier complet. Tu peux quitter et revenir, rien n’est
          perdu.
        </p>
      </div>

      <ul className="flex flex-col gap-1 text-sm">
        {DOSSIER_REQUIREMENTS.map((requirement) => {
          const missing = missingRequirements.includes(requirement);
          return (
            <li key={requirement} className="flex items-center gap-2">
              <span aria-hidden className={missing ? 'text-text-tertiary' : 'text-success'}>
                {missing ? '○' : '✓'}
              </span>
              <span className={missing ? 'text-text-secondary' : 'text-success'}>
                {VENUE_SUBMISSION_REQUIREMENT_ACTIONS_FR[requirement]}
              </span>
            </li>
          );
        })}
      </ul>

      <section aria-labelledby="photos-title">
        <h2 id="photos-title" className="text-lg font-semibold">
          Photos
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          JPEG, PNG ou WebP, 8 Mo maximum par photo. Au moins une photo de ton lieu.
        </p>
        <div className="mt-3">
          <PhotoManager kind="venue" entityId={venueId} title="Photos du lieu" onChange={onPhotosChanged} />
        </div>
      </section>

      <section aria-labelledby="description-title">
        <h2 id="description-title" className="text-lg font-semibold">
          Description du lieu
        </h2>
        <label htmlFor="vdesc" className="sr-only">
          Description du lieu
        </label>
        <textarea
          id="vdesc"
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          rows={4}
          placeholder="Ce qui rend ta salle particulière : ambiance, équipements, accès…"
          className="mt-2 w-full rounded-card border border-border bg-surface p-4"
        />
        <p className={`mt-1 text-sm ${remaining > 0 ? 'text-warning' : 'text-success'}`}>
          {remaining > 0
            ? `Encore ${remaining} caractère${remaining > 1 ? 's' : ''}.`
            : 'Longueur suffisante.'}
        </p>
        <FieldErrorText message={fieldErrors.description?.[0]} />
        <button
          type="button"
          onClick={onSaveDescription}
          disabled={!descriptionChanged || isSavingDescription || descriptionSaved}
          className="mt-2 min-h-11 rounded-card border border-border px-4 text-sm font-semibold hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSavingDescription ? 'Enregistrement…' : descriptionSaved ? 'Enregistré ✓' : 'Enregistrer'}
        </button>
      </section>

      <section aria-labelledby="vat-title">
        <h2 id="vat-title" className="text-lg font-semibold">
          Numéro de TVA
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          Nécessaire pour la facturation entre TRIALYA et ton établissement.
        </p>

        <div className="mt-3 flex flex-col gap-3">
          <div>
            <label htmlFor="legalname" className="text-sm font-semibold">
              Raison sociale
            </label>
            <input
              id="legalname"
              value={legalName}
              onChange={(event) => onLegalNameChange(event.target.value)}
              placeholder="Studio Exemple SRL"
              autoComplete="organization"
              className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4"
            />
          </div>
          <div>
            <label htmlFor="vat" className="text-sm font-semibold">
              Numéro de TVA
            </label>
            <input
              id="vat"
              value={vatNumber}
              onChange={(event) => {
                setVatTouched(true);
                onVatNumberChange(event.target.value);
              }}
              placeholder="BE0123456749"
              className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4"
            />
            {vatCheck && (
              <p className={`mt-1 text-sm ${vatCheck.ok ? 'text-success' : 'text-danger'}`}>
                {vatCheck.ok ? 'Numéro valide.' : vatCheck.message}
              </p>
            )}
          </div>

          {/*
            Pas de bouton « Enregistrer » ici, volontairement : l'API n'expose
            aujourd'hui aucune route pour modifier le numéro de TVA ou la raison
            sociale d'un établissement après sa création (aucun
            `PATCH /v1/businesses/:id`). Le champ reste utilisable — la saisie est
            gardée sur cet appareil (`onboarding-draft`) — mais rien ne part au
            serveur tant que cette route n'existe pas. Voir le rapport de ce
            chantier : c'est le blocage principal du dossier.
          */}
          <p className="rounded-card bg-warning-subtle p-3 text-sm text-warning">
            L’enregistrement du numéro de TVA arrive très bientôt. En attendant, il reste noté sur cet
            appareil — tu n’as rien à retaper.
          </p>
        </div>
      </section>

      <StickyCta>
        <button
          type="button"
          onClick={onContinue}
          className="min-h-12 w-full rounded-card bg-accent font-semibold text-on-accent"
        >
          Continuer
        </button>
      </StickyCta>
    </div>
  );
}
