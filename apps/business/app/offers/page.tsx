'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import type { BusinessSlotDto } from '@try/contracts';
import { formatMoney } from '@try/utils';
import { api } from '@/lib/api';
import { useBusinessId, useBusinessRole } from '@/lib/use-business';

/**
 * Offres & planning — l'outil d'exploitation du gérant.
 *
 * Deux gestes seulement, mais les deux dont une salle a besoin chaque semaine :
 * mettre une offre en pause (l'été, un coach absent) et annuler un créneau
 * (fermeture exceptionnelle). Tout le reste — création, modification profonde —
 * passe par l'inscription ou par le support, tant que le volume ne justifie pas
 * un éditeur complet.
 */

const OFFER_STATUS_LABELS: Record<string, { label: string; tone: string }> = {
  ACTIVE: { label: 'En ligne', tone: 'bg-green-100 text-green-800' },
  PAUSED: { label: 'En pause', tone: 'bg-amber-100 text-amber-800' },
  PENDING_APPROVAL: { label: 'En vérification', tone: 'bg-blue-100 text-blue-800' },
  DRAFT: { label: 'Brouillon', tone: 'bg-surface-muted text-ink-500' },
  REJECTED: { label: 'Refusée', tone: 'bg-red-100 text-red-800' },
  ARCHIVED: { label: 'Archivée', tone: 'bg-surface-muted text-ink-500' },
};

export default function OffersPage() {
  const businessId = useBusinessId();
  const role = useBusinessRole();
  const queryClient = useQueryClient();

  // STAFF consulte ; seuls MANAGER et OWNER coupent des séances ou des offres.
  // Le serveur re-vérifie de toute façon — cacher le bouton évite juste de
  // proposer un geste qui finirait en erreur 403.
  const canMutate = role === 'OWNER' || role === 'MANAGER';

  const offersQuery = useQuery({
    queryKey: [...queryKeys.business.all, businessId, 'offers'],
    queryFn: () => api.business.offers(businessId as string),
    enabled: Boolean(businessId),
  });

  const slotsQuery = useQuery({
    queryKey: [...queryKeys.business.all, businessId, 'slots'],
    queryFn: () => api.business.slots(businessId as string, 7),
    enabled: Boolean(businessId),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.business.all });
  };

  const pauseMutation = useMutation({
    mutationFn: (input: { offerId: string; paused: boolean }) =>
      api.business.setOfferPaused(input.offerId, input.paused),
    onSuccess: invalidate,
  });

  const cancelMutation = useMutation({
    mutationFn: (input: { slotId: string; reason: string }) =>
      api.business.cancelSlot(input.slotId, input.reason),
    onSuccess: invalidate,
  });

  if (!businessId) return null;

  const offers = offersQuery.data?.items ?? [];
  const slots = slotsQuery.data?.items ?? [];

  return (
    <main className="mx-auto max-w-6xl p-6 lg:p-10">
      <nav className="mb-6 flex gap-4 text-sm font-semibold" aria-label="Sections">
        <a href="/" className="text-ink-500 hover:text-ink-900">
          ← Tableau de bord
        </a>
        <a href="/leads" className="text-ink-500 hover:text-ink-900">
          Prospects
        </a>
      </nav>

      <h1 className="text-3xl font-bold">Offres & planning</h1>
      <p className="mt-1 text-ink-500">
        Mets une offre en pause ou annule une séance — les personnes inscrites sont prévenues et
        récupèrent leur essai.
      </p>

      <section aria-labelledby="offers-title" className="mt-8">
        <h2 id="offers-title" className="text-xl font-bold">
          Tes offres
        </h2>

        {offersQuery.isLoading ? (
          <div className="mt-4 h-24 animate-pulse rounded-[--radius-card] bg-surface-muted" aria-hidden />
        ) : offers.length === 0 ? (
          <p className="mt-4 text-ink-500">
            Aucune offre pour l’instant.{' '}
            <a href="/onboarding" className="font-semibold text-accent">
              Inscris ton établissement
            </a>{' '}
            pour en créer une.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {offers.map((offer) => {
              const badge = OFFER_STATUS_LABELS[offer.status] ?? {
                label: offer.status,
                tone: 'bg-surface-muted text-ink-500',
              };

              return (
                <li
                  key={offer.id}
                  className="flex flex-wrap items-center justify-between gap-4 rounded-[--radius-card] bg-surface p-5 shadow-sm"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">{offer.title}</h3>
                      <span className={`rounded-[--radius-pill] px-2.5 py-0.5 text-xs font-semibold ${badge.tone}`}>
                        {badge.label}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-ink-500">
                      {offer.venueName} · {offer.durationMinutes} min ·{' '}
                      {offer.priceAmount === 0
                        ? 'gratuit'
                        : formatMoney({ amount: offer.priceAmount, currency: 'EUR' })}{' '}
                      · {offer.upcomingSlots} créneau{offer.upcomingSlots > 1 ? 'x' : ''} à venir
                    </p>
                    {offer.status === 'REJECTED' && offer.rejectedReason && (
                      <p className="mt-1 text-sm text-red-700">Motif : {offer.rejectedReason}</p>
                    )}
                  </div>

                  {canMutate && (offer.status === 'ACTIVE' || offer.status === 'PAUSED') && (
                    <button
                      type="button"
                      disabled={pauseMutation.isPending}
                      onClick={() =>
                        pauseMutation.mutate({ offerId: offer.id, paused: offer.status === 'ACTIVE' })
                      }
                      className="min-h-11 rounded-[--radius-card] border border-ink-200 px-4 text-sm font-semibold hover:bg-surface-muted disabled:opacity-50"
                    >
                      {offer.status === 'ACTIVE' ? 'Mettre en pause' : 'Remettre en ligne'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="slots-title" className="mt-10">
        <h2 id="slots-title" className="text-xl font-bold">
          Les 7 prochains jours
        </h2>

        {slotsQuery.isLoading ? (
          <div className="mt-4 h-24 animate-pulse rounded-[--radius-card] bg-surface-muted" aria-hidden />
        ) : slots.length === 0 ? (
          <p className="mt-4 text-ink-500">Aucune séance planifiée sur les 7 prochains jours.</p>
        ) : (
          <SlotTable slots={slots} canMutate={canMutate} onCancel={cancelMutation} />
        )}
      </section>
    </main>
  );
}

function SlotTable({
  slots,
  canMutate,
  onCancel,
}: {
  slots: BusinessSlotDto[];
  canMutate: boolean;
  onCancel: { mutate: (input: { slotId: string; reason: string }) => void; isPending: boolean };
}) {
  // L'annulation demande un motif : il part dans le message aux inscrits, et un
  // e-mail « votre séance est annulée » sans raison fait fuir un futur client.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const formatter = new Intl.DateTimeFormat('fr-BE', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Brussels',
  });

  return (
    <div className="mt-4 overflow-x-auto rounded-[--radius-card] bg-surface shadow-sm">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Créneaux des 7 prochains jours et leur remplissage</caption>
        <thead>
          <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
            <th scope="col" className="px-4 py-3">Quand</th>
            <th scope="col" className="px-4 py-3">Séance</th>
            <th scope="col" className="px-4 py-3">Remplissage</th>
            <th scope="col" className="px-4 py-3">Statut</th>
            {canMutate && <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {slots.map((slot) => {
            const cancelled = slot.status === 'CANCELLED';

            return (
              <tr key={slot.id} className={`border-b border-ink-50 ${cancelled ? 'opacity-50' : ''}`}>
                <td className="whitespace-nowrap px-4 py-3 font-medium tabular-nums">
                  {formatter.format(new Date(slot.startAt))}
                </td>
                <td className="px-4 py-3">
                  {slot.offerTitle}
                  <span className="block text-xs text-ink-400">{slot.venueName}</span>
                </td>
                <td className="px-4 py-3 tabular-nums">
                  {slot.reservedCount}/{slot.capacity}
                </td>
                <td className="px-4 py-3">
                  {cancelled ? 'Annulé' : slot.status === 'FULL' ? 'Complet' : 'Ouvert'}
                </td>
                {canMutate && (
                  <td className="px-4 py-3 text-right">
                    {!cancelled && confirming !== slot.id && (
                      <button
                        type="button"
                        onClick={() => {
                          setConfirming(slot.id);
                          setReason('');
                        }}
                        className="font-semibold text-red-700 hover:underline"
                      >
                        Annuler
                      </button>
                    )}
                    {confirming === slot.id && (
                      <form
                        className="flex items-center justify-end gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          onCancel.mutate({ slotId: slot.id, reason });
                          setConfirming(null);
                        }}
                      >
                        <label className="sr-only" htmlFor={`reason-${slot.id}`}>
                          Motif de l’annulation
                        </label>
                        <input
                          id={`reason-${slot.id}`}
                          value={reason}
                          onChange={(event) => setReason(event.target.value)}
                          required
                          minLength={3}
                          placeholder="Motif (envoyé aux inscrits)"
                          className="w-56 rounded border border-ink-200 px-2 py-1.5"
                        />
                        {slot.reservedCount > 0 && (
                          <span className="text-xs text-ink-500">
                            {slot.reservedCount} inscrit{slot.reservedCount > 1 ? 's' : ''} prévenu
                            {slot.reservedCount > 1 ? 's' : ''}
                          </span>
                        )}
                        <button
                          type="submit"
                          disabled={onCancel.isPending}
                          className="rounded bg-red-700 px-3 py-1.5 font-semibold text-white disabled:opacity-50"
                        >
                          Confirmer
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirming(null)}
                          className="text-ink-500 hover:underline"
                        >
                          Garder
                        </button>
                      </form>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
