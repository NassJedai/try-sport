'use client';

import type { BusinessVenueDto, ExperienceType, VenueSubmissionRequirement } from '@try/contracts';
import {
  VENUE_SUBMISSION_REQUIREMENT_ACTIONS_FR,
  VENUE_SUBMISSION_REQUIREMENT_SCOPES,
} from '@try/contracts';
import { formatMoney } from '@try/utils';
import { EXPERIENCE_TYPE_OPTIONS } from '@/lib/onboarding/constants';
import { StickyCta } from './sticky-cta';

export interface ReviewOfferSummary {
  title: string;
  description: string;
  experienceType: ExperienceType;
  priceAmount: number;
  referencePriceAmount: number | null;
  durationMinutes: number;
  capacity: number;
  rejectedReason: string | null;
}

export function ReviewStep({
  businessName,
  contactEmail,
  venue,
  districtName,
  categoryNames,
  offer,
  slotsCreated,
  onEditVenue,
  onEditOffer,
  onAddSchedule,
  onSubmit,
  isSubmitting,
  submitError,
}: {
  businessName: string;
  contactEmail: string;
  venue: BusinessVenueDto;
  districtName: string | null;
  categoryNames: string[];
  offer: ReviewOfferSummary;
  slotsCreated: number | null;
  onEditVenue: () => void;
  onEditOffer: () => void;
  onAddSchedule: () => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  submitError: string | null;
}) {
  const missing = venue.missingRequirements;
  const ready = missing.length === 0;
  const rejectionReason = venue.rejectedReason ?? offer.rejectedReason;
  const experienceLabel =
    EXPERIENCE_TYPE_OPTIONS.find((option) => option.value === offer.experienceType)?.label ??
    offer.experienceType;

  return (
    <div className="mt-8 flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold">Vérifie et envoie</h1>
        <p className="mt-1 text-text-secondary">
          Un dernier coup d’œil avant l’envoi à l’équipe TRIALYA — réponse sous 48h.
        </p>
      </div>

      {rejectionReason && (
        <p role="alert" className="rounded-card bg-danger-subtle p-4 text-sm text-danger">
          <strong className="block font-semibold">TRIALYA a demandé une correction :</strong>
          {rejectionReason}
        </p>
      )}

      <section className="rounded-card bg-surface p-4 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-tertiary">Établissement</h2>
        <p className="mt-1 font-semibold">{businessName}</p>
        <p className="text-sm text-text-secondary">{contactEmail}</p>
      </section>

      <section className="rounded-card bg-surface p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-tertiary">Lieu</h2>
          <button type="button" onClick={onEditVenue} className="text-sm font-semibold text-accent-text underline">
            Modifier
          </button>
        </div>
        <p className="mt-1 font-semibold">{venue.name}</p>
        <p className="text-sm text-text-secondary">
          {venue.addressLine}, {venue.postalCode} {districtName ?? ''}
        </p>
        <p className="text-sm text-text-secondary">{categoryNames.join(' · ') || 'Aucune activité'}</p>
        <p className="mt-1 text-sm text-text-secondary">
          {venue.description ? venue.description : 'Aucune description pour l’instant'}
        </p>
        <p className="mt-1 text-sm text-text-secondary">
          {venue.imageCount} photo{venue.imageCount > 1 ? 's' : ''}
        </p>
      </section>

      <section className="rounded-card bg-surface p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-tertiary">Offre découverte</h2>
          <button type="button" onClick={onEditOffer} className="text-sm font-semibold text-accent-text underline">
            Modifier
          </button>
        </div>
        <p className="mt-1 font-semibold">{offer.title}</p>
        <p className="text-sm text-text-secondary">
          {experienceLabel} ·{' '}
          {offer.priceAmount === 0
            ? 'gratuit'
            : formatMoney({ amount: offer.priceAmount, currency: 'EUR' })}
          {offer.referencePriceAmount ? (
            <>
              {' '}
              <span className="line-through">
                {formatMoney({ amount: offer.referencePriceAmount, currency: 'EUR' })}
              </span>
            </>
          ) : null}{' '}
          · {offer.durationMinutes} min · {offer.capacity} places
        </p>
        <p className="mt-1 text-sm text-text-secondary">{offer.description}</p>
      </section>

      <section className="rounded-card bg-surface p-4 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-tertiary">Créneaux</h2>
        {slotsCreated && slotsCreated > 0 ? (
          <p className="mt-1 text-sm text-text-secondary">
            {slotsCreated} séance{slotsCreated > 1 ? 's' : ''} programmée{slotsCreated > 1 ? 's' : ''} sur
            les 30 prochains jours.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-danger">Aucun créneau programmé — personne ne pourra réserver.</p>
            <button
              type="button"
              onClick={onAddSchedule}
              className="mt-2 text-sm font-semibold text-accent-text underline"
            >
              Ajouter des créneaux
            </button>
          </>
        )}
      </section>

      {!ready && (
        <section aria-labelledby="missing-title" className="rounded-card bg-warning-subtle p-4">
          <h2 id="missing-title" className="font-semibold text-warning">
            Il reste à compléter avant l’envoi
          </h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-warning">
            {missing.map((requirement: VenueSubmissionRequirement) => (
              <li key={requirement}>
                • {VENUE_SUBMISSION_REQUIREMENT_ACTIONS_FR[requirement]}
                {VENUE_SUBMISSION_REQUIREMENT_SCOPES[requirement] === 'BUSINESS' && (
                  <span className="block text-xs">
                    (bientôt disponible depuis cet assistant — contacte le support en attendant)
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {submitError && (
        <p role="alert" className="rounded-card bg-danger-subtle p-3 text-sm text-danger">
          {submitError}
        </p>
      )}

      <StickyCta>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!ready || isSubmitting}
          className="min-h-12 w-full rounded-card bg-accent font-semibold text-on-accent disabled:opacity-50"
        >
          {isSubmitting ? 'Envoi…' : rejectionReason ? 'Renvoyer à TRIALYA' : 'Envoyer à TRIALYA'}
        </button>
        {!ready && (
          <p className="mt-2 text-center text-xs text-text-tertiary">
            Complète le dossier ci-dessus pour activer l’envoi.
          </p>
        )}
      </StickyCta>
    </div>
  );
}
