'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import type { BusinessSlotDto, OfferStatus } from '@try/contracts';
import { formatDateInZone, formatMoney } from '@try/utils';
import { api, apiClient } from '@/lib/api';
import { useBusinessId, useBusinessRole } from '@/lib/use-business';
import { generalErrorMessage } from '@/lib/onboarding/field-errors';
import { PhotoManager } from '@/components/photo-manager';
import { OfferEditForm } from '@/components/offers/offer-edit-form';
import type { CategoryOption } from '@/lib/onboarding/types';

/**
 * Offres & planning — l'outil d'exploitation du gérant.
 *
 * Les gestes hebdomadaires : mettre une offre en pause (l'été, un coach absent),
 * annuler un créneau (fermeture exceptionnelle), et — depuis ce chantier —
 * corriger une offre déjà en ligne (« Modifier »), la dernière impasse du
 * parcours : jusqu'ici, une fois l'offre validée, seul le support pouvait
 * toucher à son prix, son titre ou sa description. `OfferEditForm` dérive
 * entièrement ce qui est modifiable de `editable-fields.ts` — rien n'est
 * codé en dur ici sur les champs verrouillés.
 */

/**
 * Les pastilles passent par les jetons plutôt que par la palette Tailwind par
 * défaut : ses `*-100` sont en OKLCH froid, posés sur des neutres chauds, et
 * personne ne vérifiait leur contraste.
 *
 * Les quatre teintes sémantiques sont asservies par tokens.test.ts, qui vérifie
 * chacune sur son propre lavis clair. Les deux états neutres ne le sont pas —
 * le test exclut `surfaceMuted` de ses surfaces sanctionnées — et prennent donc
 * `text-text-secondary`, qui tient 9,3:1.
 *
 * « En vérification » n'a pas de bleu à sa disposition — la palette n'en a pas —
 * et prend le lavis d'accent : c'est un état transitoire vers la mise en ligne,
 * pas une information neutre comme un brouillon.
 */
const OFFER_STATUS_LABELS: Record<OfferStatus, { label: string; tone: string }> = {
  ACTIVE: { label: 'En ligne', tone: 'bg-success-subtle text-success' },
  PAUSED: { label: 'En pause', tone: 'bg-warning-subtle text-warning' },
  PENDING_APPROVAL: { label: 'En vérification', tone: 'bg-accent-subtle text-accent-text' },
  DRAFT: { label: 'Brouillon', tone: 'bg-surface-muted text-text-secondary' },
  REJECTED: { label: 'Refusée', tone: 'bg-danger-subtle text-danger' },
  ARCHIVED: { label: 'Archivée', tone: 'bg-surface-muted text-text-secondary' },
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

  // Nécessaires pour l'édition d'une offre : la liste ci-dessus ne porte ni
  // catégorie ni description (voir `OfferEditForm`), et la sélection de
  // catégorie doit rester bornée aux activités déclarées par le lieu, pas à
  // tout le catalogue de la plateforme — même restriction que dans l'assistant
  // d'inscription (`onboarding/page.tsx`, `venueCategoryOptions`).
  const venuesQuery = useQuery({
    queryKey: [...queryKeys.business.all, businessId, 'venues'],
    queryFn: () => api.business.venues(businessId as string),
    enabled: Boolean(businessId),
  });
  const referenceQuery = useQuery({
    queryKey: ['reference'],
    queryFn: () => apiClient.get<{ categories: { id: string; name: string }[] }>('/v1/reference'),
    staleTime: 3_600_000,
  });

  const [editingOfferId, setEditingOfferId] = useState<string | null>(null);
  // L'offre pour laquelle un retrait de la file de modération est en cours de
  // confirmation — même style que `confirming` dans `SlotTable` pour
  // l'annulation d'un créneau : un geste qui déplace un statut se confirme
  // toujours en ligne, jamais au premier clic.
  const [confirmingWithdrawId, setConfirmingWithdrawId] = useState<string | null>(null);
  // Le message à afficher si le retrait échoue — ex. l'offre a été approuvée
  // par l'équipe TRIALYA entre l'ouverture de la confirmation et le clic sur
  // « Confirmer ». Réinitialisé à chaque ouverture ou fermeture de la
  // confirmation, pour ne jamais montrer l'échec d'une offre sur une autre.
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.business.all });
  };

  const pauseMutation = useMutation({
    mutationFn: (input: { offerId: string; paused: boolean }) =>
      api.business.setOfferPaused(input.offerId, input.paused),
    onSuccess: invalidate,
  });

  // Seule issue offerte au gérant quand une offre est bloquée en
  // `PENDING_APPROVAL` : le panneau d'édition le lui dit (« Retire-la de la
  // file d'attente pour modifier ») mais n'offrait jusqu'ici aucun moyen de le
  // faire. `PENDING_APPROVAL → DRAFT` existe déjà côté API
  // (`POST /v1/offers/:id/withdraw`, `OnboardingService.withdrawOffer`).
  const withdrawMutation = useMutation({
    mutationFn: (offerId: string) => api.business.withdrawOffer(offerId),
    onSuccess: (_result, offerId) => {
      setWithdrawError(null);
      invalidate();
      // Ciblé en plus de `invalidate()` : `queryKeys.offers.detail` vit sous
      // une racine différente (`'offers'`, pas `'business'`) et ne serait pas
      // rafraîchi sinon — un panneau d'édition resté ouvert sur cette offre
      // afficherait encore « en cours d'examen » après le retrait.
      void queryClient.invalidateQueries({ queryKey: queryKeys.offers.detail(offerId) });
      setConfirmingWithdrawId(null);
      setEditingOfferId((current) => (current === offerId ? null : current));
    },
    // Sans `onError`, un échec (l'offre a été approuvée entre l'ouverture de
    // la confirmation et le clic — elle n'est alors plus `PENDING_APPROVAL`,
    // et `OnboardingService.withdrawOffer` refuse la transition) laissait la
    // confirmation ouverte sans un mot : le gérant cliquait « Confirmer » dans
    // le vide. On affiche le message de l'API et on rafraîchit la liste,
    // parce que le statut a justement pu bouger — la case « Retirer de la
    // file d'attente » doit disparaître d'elle-même si l'offre n'est plus
    // `PENDING_APPROVAL`.
    onError: (err) => {
      setWithdrawError(generalErrorMessage(err) ?? 'Le retrait a échoué.');
      invalidate();
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (input: { slotId: string; reason: string }) =>
      api.business.cancelSlot(input.slotId, input.reason),
    onSuccess: invalidate,
  });

  if (!businessId) return null;

  const offers = offersQuery.data?.items ?? [];
  const slots = slotsQuery.data?.items ?? [];
  const allCategories = referenceQuery.data?.categories ?? [];
  const venues = venuesQuery.data?.items ?? [];

  function categoriesForVenue(venueId: string): CategoryOption[] {
    const venue = venues.find((v) => v.id === venueId);
    if (!venue) return allCategories;
    const filtered = allCategories.filter((c) => venue.categoryIds.includes(c.id));
    // Filet de sécurité : si les données de référence ou le lieu n'ont pas
    // encore chargé, mieux vaut proposer tout le catalogue qu'un menu vide.
    return filtered.length > 0 ? filtered : allCategories;
  }

  return (
    <main className="mx-auto max-w-6xl p-6 lg:p-10">
      <nav className="mb-6 flex gap-4 text-sm font-semibold" aria-label="Sections">
        <a href="/" className="text-text-secondary hover:text-ink-900">
          ← Tableau de bord
        </a>
        <a href="/leads" className="text-text-secondary hover:text-ink-900">
          Prospects
        </a>
      </nav>

      <h1 className="text-3xl font-bold">Offres & planning</h1>
      <p className="mt-1 text-text-secondary">
        Mets une offre en pause, annule une séance ou modifie une offre déjà en ligne — les personnes
        inscrites sont prévenues et récupèrent leur essai.
      </p>

      <section aria-labelledby="offers-title" className="mt-8">
        <h2 id="offers-title" className="text-xl font-bold">
          Tes offres
        </h2>

        {offersQuery.isLoading ? (
          <div className="mt-4 h-24 animate-pulse rounded-card bg-surface-muted" aria-hidden />
        ) : offers.length === 0 ? (
          <p className="mt-4 text-text-secondary">
            Aucune offre pour l’instant.{' '}
            <a href="/onboarding" className="font-semibold text-accent-text">
              Inscris ton établissement
            </a>{' '}
            pour en créer une.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {offers.map((offer) => {
              const badge = OFFER_STATUS_LABELS[offer.status] ?? {
                label: offer.status,
                tone: 'bg-surface-muted text-text-secondary',
              };

              const isEditing = editingOfferId === offer.id;

              return (
                <li key={offer.id} className="flex flex-col rounded-card bg-surface p-5 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold">{offer.title}</h3>
                        <span className={`rounded-pill px-2.5 py-0.5 text-xs font-semibold ${badge.tone}`}>
                          {badge.label}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-text-secondary">
                        {offer.venueName} · {offer.durationMinutes} min ·{' '}
                        {offer.priceAmount === 0
                          ? 'gratuit'
                          : formatMoney({ amount: offer.priceAmount, currency: offer.currency })}{' '}
                        · {offer.upcomingSlots} créneau{offer.upcomingSlots > 1 ? 'x' : ''} à venir
                      </p>
                      {offer.status === 'REJECTED' && offer.rejectedReason && (
                        <p className="mt-1 text-sm text-danger">Motif : {offer.rejectedReason}</p>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {canMutate && (offer.status === 'ACTIVE' || offer.status === 'PAUSED') && (
                        <button
                          type="button"
                          disabled={pauseMutation.isPending}
                          onClick={() =>
                            pauseMutation.mutate({ offerId: offer.id, paused: offer.status === 'ACTIVE' })
                          }
                          className="min-h-11 rounded-card border border-ink-200 px-4 text-sm font-semibold hover:bg-surface-muted disabled:opacity-50"
                        >
                          {offer.status === 'ACTIVE' ? 'Mettre en pause' : 'Remettre en ligne'}
                        </button>
                      )}
                      {/* PENDING_APPROVAL est une impasse sans ce bouton : le panneau
                          d'édition dit « retire-la de la file d'attente pour modifier »
                          mais rien ne le permettait jusqu'ici. Même geste que
                          `PENDING_APPROVAL → DRAFT` sur un lieu (`withdrawVenue`). */}
                      {canMutate && offer.status === 'PENDING_APPROVAL' && (
                        confirmingWithdrawId === offer.id ? (
                          <span className="flex flex-col gap-1.5">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="text-xs text-text-secondary">Retirer cette offre de la file ?</span>
                              <button
                                type="button"
                                disabled={withdrawMutation.isPending}
                                onClick={() => withdrawMutation.mutate(offer.id)}
                                className="min-h-11 rounded-card bg-danger-surface px-3 text-sm font-semibold text-on-danger disabled:opacity-50"
                              >
                                Confirmer
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setWithdrawError(null);
                                  setConfirmingWithdrawId(null);
                                }}
                                className="min-h-11 rounded-card border border-ink-200 px-3 text-sm font-semibold hover:bg-surface-muted"
                              >
                                Garder
                              </button>
                            </span>
                            {withdrawError && (
                              <span role="alert" className="text-xs text-danger">
                                {withdrawError}
                              </span>
                            )}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setWithdrawError(null);
                              setConfirmingWithdrawId(offer.id);
                            }}
                            className="min-h-11 rounded-card border border-ink-200 px-4 text-sm font-semibold hover:bg-surface-muted"
                          >
                            Retirer de la file d’attente
                          </button>
                        )
                      )}
                      {/* STAFF consulte : le bouton n'apparaît que pour MANAGER/OWNER, comme la
                          pause ci-dessus — le serveur (`assertRole(..., 'MANAGER')` dans
                          `updateOffer`) revérifie de toute façon. */}
                      {canMutate && (
                        <button
                          type="button"
                          onClick={() => setEditingOfferId(isEditing ? null : offer.id)}
                          aria-expanded={isEditing}
                          className="min-h-11 rounded-card border border-ink-200 px-4 text-sm font-semibold hover:bg-surface-muted"
                        >
                          {isEditing ? 'Fermer' : 'Modifier'}
                        </button>
                      )}
                    </div>
                  </div>

                  {isEditing && (
                    <OfferEditForm
                      key={offer.id}
                      offerId={offer.id}
                      offer={offer}
                      categories={categoriesForVenue(offer.venueId)}
                      onClose={() => setEditingOfferId(null)}
                      onSaved={() => {
                        invalidate();
                        setEditingOfferId(null);
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canMutate && offers.length > 0 && (
        <section aria-labelledby="photos-title" className="mt-10">
          <h2 id="photos-title" className="text-xl font-bold">
            Photos
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            C'est ce que les clients voient en premier dans l'app. JPEG, PNG ou WebP, 8 Mo max.
          </p>
          <div className="mt-4 space-y-6 rounded-card bg-surface p-5 shadow-sm">
            {[...new Map(offers.map((offer) => [offer.venueId, offer.venueName])).entries()].map(
              ([venueId, venueName]) => (
                <PhotoManager key={venueId} kind="venue" entityId={venueId} title={venueName} />
              ),
            )}
            {offers.map((offer) => (
              <PhotoManager
                key={offer.id}
                kind="offer"
                entityId={offer.id}
                title={`Offre « ${offer.title} »`}
              />
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="slots-title" className="mt-10">
        <h2 id="slots-title" className="text-xl font-bold">
          Les 7 prochains jours
        </h2>

        {slotsQuery.isLoading ? (
          <div className="mt-4 h-24 animate-pulse rounded-card bg-surface-muted" aria-hidden />
        ) : slots.length === 0 ? (
          <p className="mt-4 text-text-secondary">Aucune séance planifiée sur les 7 prochains jours.</p>
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

  // Chaque créneau porte le fuseau de son propre lieu : une salle qui gère
  // plusieurs adresses peut avoir des lignes dans des fuseaux différents dans
  // cette même table, donc le format se fait par ligne plutôt qu'avec une
  // instance d'`Intl.DateTimeFormat` partagée sur un fuseau figé.
  const formatWhen = (slot: BusinessSlotDto) =>
    formatDateInZone(new Date(slot.startAt), slot.venueTimeZone, 'fr-BE', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="mt-4 overflow-x-auto rounded-card bg-surface shadow-sm">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Créneaux des 7 prochains jours et leur remplissage</caption>
        <thead>
          <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-text-tertiary">
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
                  {formatWhen(slot)}
                </td>
                <td className="px-4 py-3">
                  {slot.offerTitle}
                  <span className="block text-xs text-text-tertiary">{slot.venueName}</span>
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
                        className="font-semibold text-danger hover:underline"
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
                          <span className="text-xs text-text-secondary">
                            {slot.reservedCount} inscrit{slot.reservedCount > 1 ? 's' : ''} prévenu
                            {slot.reservedCount > 1 ? 's' : ''}
                          </span>
                        )}
                        <button
                          type="submit"
                          disabled={onCancel.isPending}
                          className="rounded bg-danger-surface px-3 py-1.5 font-semibold text-on-danger disabled:opacity-50"
                        >
                          Confirmer
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirming(null)}
                          className="text-text-secondary hover:underline"
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
