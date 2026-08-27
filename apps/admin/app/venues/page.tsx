'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '@try/api-client';
import { REJECTION_REASON_MIN_LENGTH } from '@try/contracts';
import type { OfferStatus, VenueStatus } from '@try/contracts';
import { api } from '@/lib/api';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Suspendre un lieu, le réintégrer, mettre une offre en pause.
 *
 * L'API accepte `SUSPEND` / `REINSTATE` (lieu) et `PAUSE` (offre) depuis
 * longtemps (`admin.controller.ts`) ; rien dans la console ne les envoyait.
 * `/moderation` ne peut pas être ce point d'entrée : sa file ne contient que
 * des dossiers `PENDING_APPROVAL`, et la machine à états
 * (`@try/contracts/moderation-state-machine.ts`) n'autorise `SUSPEND` que
 * depuis `ACTIVE`/`PAUSED`, jamais depuis `PENDING_APPROVAL` — un bouton
 * « Suspendre » posé là échouerait à chaque clic.
 *
 * Trouver *quel* lieu suspendre demanderait de parcourir les lieux actifs, et
 * cette vue n'existe nulle part côté API : ni `GET /v1/admin/venues` (seul
 * `/v1/admin/venues/incomplete` existe, filtré aux dossiers à compléter — pas
 * un usage général), ni `queue()` (`admin.controller.ts:42`, sans paramètre
 * de statut), ni la route business (`business.controller.ts:81..90`, qui
 * exige une appartenance `STAFF` qu'un compte admin n'a pas). Les trois
 * options envisagées — vue « salles actives », filtre sur la file, action
 * depuis une fiche de salle — demandent donc toutes une route qui n'existe
 * pas aujourd'hui et qui n'est pas de mon ressort (`apps/api`).
 *
 * Recommandation : un `GET /v1/admin/venues?status=&q=`, sur le modèle exact
 * de `GET /v1/admin/users` déjà en place, remplacerait ce panneau par une
 * vraie liste cherchable. En attendant, ce panneau opère par identifiant —
 * obtenu via une réservation, un ticket support ou l'URL publique du lieu —
 * ce qui reste honnête : aucune route n'est inventée, seules les deux
 * décisions déjà acceptées par le serveur sont exposées.
 */
export default function VenuesPage() {
  return (
    <main className="mx-auto max-w-3xl p-6 lg:p-10">
      <a href="/" className="text-sm text-text-secondary underline">← Vue d’ensemble</a>
      <h1 className="mt-2 text-3xl font-bold">Lieux & offres</h1>
      <p className="mt-1 text-text-secondary">
        Suspendre un lieu actif, le réintégrer, ou mettre une offre en pause — par identifiant.
      </p>
      <p className="mt-4 rounded-card bg-accent-subtle p-4 text-sm text-accent-text">
        Pas encore de recherche par nom ou par ville ici : cette vue attend un endpoint de liste
        côté API. Il faut donc l’identifiant du lieu ou de l’offre — celui de la fiche publique,
        d’un ticket support, ou d’une ligne dans « Réservations ».
      </p>

      <VenueDecisionPanel />
      <OfferDecisionPanel />
    </main>
  );
}

function VenueDecisionPanel() {
  const [venueId, setVenueId] = useState('');
  const [decision, setDecision] = useState<'SUSPEND' | 'REINSTATE'>('SUSPEND');
  const [reason, setReason] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; message: string } | null>(null);

  const mutation = useMutation({
    mutationFn: (input: { venueId: string; decision: 'SUSPEND' | 'REINSTATE'; reason?: string }) =>
      api.admin.decideVenue(input.venueId, { decision: input.decision, reason: input.reason }),
    onSuccess: (result: { status: VenueStatus }) => {
      setFeedback({ tone: 'ok', message: `Lieu ${venueId} → ${result.status}` });
      setReason('');
    },
    onError: (error) => {
      setFeedback({
        tone: 'error',
        message: error instanceof ApiError ? error.message : 'La décision a échoué.',
      });
    },
  });

  const validId = UUID_PATTERN.test(venueId.trim());
  const reasonOk = decision !== 'SUSPEND' || reason.trim().length >= REJECTION_REASON_MIN_LENGTH;
  const canSubmit = validId && reasonOk && !mutation.isPending;

  return (
    <section aria-labelledby="venue-title" className="mt-8 rounded-card bg-surface p-5 shadow-sm">
      <h2 id="venue-title" className="text-lg font-bold">Lieu</h2>

      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          mutation.mutate({
            venueId: venueId.trim(),
            decision,
            reason: decision === 'SUSPEND' ? reason.trim() : undefined,
          });
        }}
      >
        <div>
          <label htmlFor="venue-id" className="text-sm font-semibold">Identifiant du lieu</label>
          <input
            id="venue-id"
            value={venueId}
            onChange={(event) => setVenueId(event.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            className="mt-1 min-h-11 w-full rounded-card border border-border bg-surface px-3 font-mono text-sm"
          />
          {venueId.length > 0 && !validId && (
            <p className="mt-1 text-xs text-danger">Attendu : un UUID.</p>
          )}
        </div>

        <div role="radiogroup" aria-label="Décision" className="flex gap-2">
          <button
            type="button"
            role="radio"
            aria-checked={decision === 'SUSPEND'}
            onClick={() => setDecision('SUSPEND')}
            className={`min-h-11 rounded-pill px-4 text-sm font-semibold ${decision === 'SUSPEND' ? 'bg-danger-subtle text-danger' : 'bg-surface-muted text-text-secondary'}`}
          >
            Suspendre
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={decision === 'REINSTATE'}
            onClick={() => setDecision('REINSTATE')}
            className={`min-h-11 rounded-pill px-4 text-sm font-semibold ${decision === 'REINSTATE' ? 'bg-success-subtle text-success' : 'bg-surface-muted text-text-secondary'}`}
          >
            Réactiver
          </button>
        </div>

        {decision === 'SUSPEND' && (
          <div>
            <p className="rounded-card bg-danger-subtle p-3 text-sm text-danger">
              Toutes les offres actives de ce lieu passeront automatiquement en pause, tout de
              suite — pas d’écran de confirmation supplémentaire côté serveur.
            </p>
            <label htmlFor="venue-reason" className="mt-3 block text-sm font-semibold">
              Motif (transmis à l’établissement)
            </label>
            <textarea
              id="venue-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={REJECTION_REASON_MIN_LENGTH}
              required
              rows={3}
              placeholder="Ex. : plaintes répétées de clients sur l’hygiène du lieu."
              className="mt-1 w-full rounded-card border border-border bg-surface px-3 py-2 text-sm"
            />
            {reason.length > 0 && !reasonOk && (
              <p className="mt-1 text-xs text-danger">
                Minimum {REJECTION_REASON_MIN_LENGTH} caractères.
              </p>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="min-h-11 rounded-card bg-accent px-5 font-semibold text-on-accent disabled:opacity-50"
        >
          {mutation.isPending ? 'Envoi…' : decision === 'SUSPEND' ? 'Suspendre le lieu' : 'Réactiver le lieu'}
        </button>
      </form>

      {feedback && (
        <p
          role="status"
          className={`mt-4 rounded-card p-3 text-sm font-medium ${feedback.tone === 'ok' ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'}`}
        >
          {feedback.message}
        </p>
      )}
    </section>
  );
}

function OfferDecisionPanel() {
  const [offerId, setOfferId] = useState('');
  const [reason, setReason] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; message: string } | null>(null);

  const mutation = useMutation({
    mutationFn: (input: { offerId: string; reason: string }) =>
      api.admin.decideOffer(input.offerId, {
        decision: 'PAUSE',
        reason: input.reason || undefined,
      }),
    onSuccess: (result: { status: OfferStatus }) => {
      setFeedback({ tone: 'ok', message: `Offre ${offerId} → ${result.status}` });
      setReason('');
    },
    onError: (error) => {
      setFeedback({
        tone: 'error',
        message: error instanceof ApiError ? error.message : 'La mise en pause a échoué.',
      });
    },
  });

  const validId = UUID_PATTERN.test(offerId.trim());

  return (
    <section aria-labelledby="offer-title" className="mt-6 rounded-card bg-surface p-5 shadow-sm">
      <h2 id="offer-title" className="text-lg font-bold">Offre</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Retire une offre active de la découverte, sans toucher aux réservations déjà prises.
      </p>

      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!validId || mutation.isPending) return;
          mutation.mutate({ offerId: offerId.trim(), reason: reason.trim() });
        }}
      >
        <div>
          <label htmlFor="offer-id" className="text-sm font-semibold">Identifiant de l’offre</label>
          <input
            id="offer-id"
            value={offerId}
            onChange={(event) => setOfferId(event.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            className="mt-1 min-h-11 w-full rounded-card border border-border bg-surface px-3 font-mono text-sm"
          />
          {offerId.length > 0 && !validId && (
            <p className="mt-1 text-xs text-danger">Attendu : un UUID.</p>
          )}
        </div>

        <div>
          <label htmlFor="offer-reason" className="text-sm font-semibold">Motif (optionnel, interne)</label>
          <input
            id="offer-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Ex. : coach indisponible pour la saison."
            className="mt-1 min-h-11 w-full rounded-card border border-border bg-surface px-3 text-sm"
          />
        </div>

        <button
          type="submit"
          disabled={!validId || mutation.isPending}
          className="min-h-11 rounded-card border border-border px-5 font-semibold text-danger disabled:opacity-50"
        >
          {mutation.isPending ? 'Envoi…' : 'Mettre en pause'}
        </button>
      </form>

      {feedback && (
        <p
          role="status"
          className={`mt-4 rounded-card p-3 text-sm font-medium ${feedback.tone === 'ok' ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'}`}
        >
          {feedback.message}
        </p>
      )}
    </section>
  );
}
