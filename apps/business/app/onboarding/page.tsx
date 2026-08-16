'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, queryKeys } from '@try/api-client';
import { parseDecimalToMinor } from '@try/utils';
import { api, apiClient, tokenStore } from '@/lib/api';

interface ReferenceData {
  cities: {
    id: string;
    name: string;
    districts: { id: string; name: string; latitude: number; longitude: number }[];
  }[];
  categories: { id: string; slug: string; name: string }[];
}

type Step = 'business' | 'venue' | 'offer' | 'schedule' | 'done';

const DAY_LABELS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

/**
 * L'assistant d'inscription d'un établissement.
 *
 * Quatre étapes courtes plutôt qu'un long formulaire : chaque étape crée
 * réellement l'objet côté serveur avant de passer à la suivante, donc fermer
 * l'onglet en cours de route ne perd rien — on reprend où on en était.
 *
 * Rien ici ne publie quoi que ce soit : la dernière étape soumet le lieu et
 * l'offre à la modération TRY, et l'écran final le dit clairement.
 */
export default function OnboardingPage() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('business');
  const [error, setError] = useState<string | null>(null);

  // Identifiants créés au fil des étapes.
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [venueId, setVenueId] = useState<string | null>(null);
  const [offerId, setOfferId] = useState<string | null>(null);

  const reference = useQuery({
    queryKey: ['reference'],
    queryFn: () => apiClient.get<ReferenceData>('/v1/reference'),
    staleTime: 3_600_000,
  });

  const viewer = useQuery({ queryKey: queryKeys.viewer, queryFn: () => api.auth.me(), retry: false });

  // Un membre existant saute la création d'entreprise.
  const existingBusinessId = viewer.data?.businessMemberships[0]?.businessId ?? null;
  if (existingBusinessId && !businessId) {
    setBusinessId(existingBusinessId);
    setStep('venue');
  }

  const fail = (err: unknown) =>
    setError(err instanceof ApiError ? err.message : 'Une erreur est survenue. Réessaie.');

  /* ------------------------------------------------------------------ */
  /* Étape 1 — l'entreprise                                              */
  /* ------------------------------------------------------------------ */
  const [businessName, setBusinessName] = useState('');

  const createBusiness = useMutation({
    mutationFn: () =>
      apiClient.post<{ businessId: string }>('/v1/businesses', {
        name: businessName,
        contactEmail: viewer.data?.email ?? '',
      }),
    onSuccess: async (result) => {
      setError(null);
      setBusinessId(result.businessId);

      /**
       * Le jeton de session embarque les rôles au moment de la connexion : il ne
       * sait pas encore que ce compte vient de devenir OWNER. On le rafraîchit
       * tout de suite, sinon la création du lieu — l'étape suivante — serait
       * refusée avec un 403 incompréhensible.
       */
      const refreshToken = tokenStore.getRefreshToken();
      if (refreshToken) {
        const session = await apiClient.post<{
          tokens: { accessToken: string; refreshToken: string; expiresIn: number };
        }>('/v1/auth/refresh', { refreshToken }, { anonymous: true });
        await tokenStore.setTokens(session.tokens);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.viewer });
      setStep('venue');
    },
    onError: fail,
  });

  /* ------------------------------------------------------------------ */
  /* Étape 2 — le lieu                                                   */
  /* ------------------------------------------------------------------ */
  const [venueName, setVenueName] = useState('');
  const [addressLine, setAddressLine] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [districtId, setDistrictId] = useState('');
  const [categoryIds, setCategoryIds] = useState<string[]>([]);

  const city = reference.data?.cities[0];
  const district = city?.districts.find((d) => d.id === districtId);

  const createVenue = useMutation({
    mutationFn: () =>
      apiClient.post<{ venueId: string }>(`/v1/businesses/${businessId}/venues`, {
        name: venueName,
        addressLine,
        postalCode,
        cityId: city?.id,
        districtId: districtId || undefined,
        /**
         * Position approximative : le centroïde de la commune choisie. Demander
         * des coordonnées GPS à un gérant est une impasse — la position fine
         * s'ajustera avec le géocodage de l'adresse (à venir).
         */
        latitude: district?.latitude ?? 50.8467,
        longitude: district?.longitude ?? 4.3525,
        categoryIds,
      }),
    onSuccess: (result) => {
      setError(null);
      setVenueId(result.venueId);
      setStep('offer');
    },
    onError: fail,
  });

  /* ------------------------------------------------------------------ */
  /* Étape 3 — la première offre                                         */
  /* ------------------------------------------------------------------ */
  const [offerTitle, setOfferTitle] = useState('');
  const [offerDescription, setOfferDescription] = useState('');
  const [price, setPrice] = useState('0');
  const [referencePrice, setReferencePrice] = useState('');
  const [duration, setDuration] = useState('60');
  const [capacity, setCapacity] = useState('10');
  const [offerCategoryId, setOfferCategoryId] = useState('');

  const createOffer = useMutation({
    mutationFn: () => {
      // Les prix voyagent en centimes ; la conversion refuse les imprécisions.
      const priceAmount = parseDecimalToMinor(price || '0', 'EUR').amount;
      const referenceAmount = referencePrice.trim()
        ? parseDecimalToMinor(referencePrice, 'EUR').amount
        : null;

      return apiClient.post<{ offerId: string }>('/v1/offers', {
        venueId,
        categoryId: offerCategoryId || categoryIds[0],
        title: offerTitle,
        description: offerDescription,
        experienceType: priceAmount === 0 ? 'FREE_TRIAL' : 'DISCOVERY_PRICE',
        priceAmount,
        referencePriceAmount: referenceAmount,
        durationMinutes: Number(duration),
        capacity: Number(capacity),
      });
    },
    onSuccess: (result) => {
      setError(null);
      setOfferId(result.offerId);
      setStep('schedule');
    },
    onError: fail,
  });

  /* ------------------------------------------------------------------ */
  /* Étape 4 — horaires récurrents puis soumission                       */
  /* ------------------------------------------------------------------ */
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const [startTime, setStartTime] = useState('19:00');

  const finish = useMutation({
    mutationFn: async () => {
      await apiClient.post('/v1/schedules', {
        offerId,
        daysOfWeek,
        startTime,
        capacity: Number(capacity),
        validFrom: new Date().toISOString().slice(0, 10),
      });
      // Lieu puis offre : l'ordre reflète la règle de modération (une offre ne
      // peut être approuvée que si son lieu l'est déjà).
      await apiClient.post(`/v1/venues/${venueId}/submit`);
      await apiClient.post(`/v1/offers/${offerId}/submit`);
    },
    onSuccess: () => {
      setError(null);
      setStep('done');
    },
    onError: fail,
  });

  const toggleDay = (day: number) =>
    setDaysOfWeek((current) =>
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day],
    );

  const toggleCategory = (id: string) =>
    setCategoryIds((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );

  /* ------------------------------------------------------------------ */

  if (viewer.isError) {
    return (
      <main className="mx-auto max-w-xl p-8 text-center">
        <h1 className="text-2xl font-bold">Connecte-toi d’abord</h1>
        <p className="mt-2 text-text-secondary">L’inscription de ton établissement prend cinq minutes.</p>
        <a
          href="/sign-in"
          className="mt-6 inline-block rounded-card bg-accent px-5 py-3 font-semibold text-on-accent"
        >
          Se connecter
        </a>
      </main>
    );
  }

  const stepIndex = ['business', 'venue', 'offer', 'schedule', 'done'].indexOf(step);

  return (
    <main className="mx-auto max-w-xl p-6 lg:p-10">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
        Inscription · étape {Math.min(stepIndex + 1, 4)} sur 4
      </p>
      <div className="mt-2 flex gap-1" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            // accent-text, pas accent : les segments faits et à faire ne se
            // distinguaient qu'à 1,03:1, soit une barre d'un seul tenant.
            className={`h-1.5 flex-1 rounded-full ${i <= stepIndex ? 'bg-accent-text' : 'bg-surface-muted'}`}
          />
        ))}
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-card bg-danger-subtle p-3 text-sm text-danger">
          {error}
        </p>
      )}

      {step === 'business' && (
        <form
          className="mt-8 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            createBusiness.mutate();
          }}
        >
          <h1 className="text-3xl font-bold">Ton établissement</h1>
          <p className="text-text-secondary">Le nom sous lequel les clients te connaîtront.</p>
          <label htmlFor="bname" className="sr-only">Nom de l’établissement</label>
          <input
            id="bname"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="Studio Exemple"
            required
            minLength={2}
            className="min-h-12 rounded-card border border-border bg-surface px-4"
          />
          <button
            type="submit"
            disabled={createBusiness.isPending || businessName.trim().length < 2}
            className="min-h-12 rounded-card bg-accent font-semibold text-on-accent disabled:opacity-50"
          >
            {createBusiness.isPending ? '…' : 'Continuer'}
          </button>
        </form>
      )}

      {step === 'venue' && (
        <form
          className="mt-8 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            createVenue.mutate();
          }}
        >
          <h1 className="text-3xl font-bold">Ton lieu</h1>
          <p className="text-text-secondary">Là où les clients viendront essayer.</p>

          <label htmlFor="vname" className="text-sm font-semibold">Nom du lieu</label>
          <input id="vname" value={venueName} onChange={(e) => setVenueName(e.target.value)} required minLength={2} placeholder="Studio Exemple Ixelles" className="min-h-12 rounded-card border border-border bg-surface px-4" />

          <label htmlFor="vaddr" className="text-sm font-semibold">Adresse</label>
          <input id="vaddr" value={addressLine} onChange={(e) => setAddressLine(e.target.value)} required minLength={4} placeholder="Rue de la Paix 10" className="min-h-12 rounded-card border border-border bg-surface px-4" />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="vcp" className="text-sm font-semibold">Code postal</label>
              <input id="vcp" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} required placeholder="1050" className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4" />
            </div>
            <div>
              <label htmlFor="vdistrict" className="text-sm font-semibold">Commune</label>
              <select id="vdistrict" value={districtId} onChange={(e) => setDistrictId(e.target.value)} required className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-3">
                <option value="">Choisir…</option>
                {city?.districts.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
          </div>

          <fieldset>
            <legend className="text-sm font-semibold">Activités proposées</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {reference.data?.categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleCategory(c.id)}
                  aria-pressed={categoryIds.includes(c.id)}
                  className={`min-h-11 rounded-pill px-4 text-sm font-semibold ${
                    categoryIds.includes(c.id) ? 'bg-accent text-on-accent' : 'bg-surface-muted text-text-secondary'
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </fieldset>

          <button
            type="submit"
            disabled={createVenue.isPending || categoryIds.length === 0 || !districtId}
            className="min-h-12 rounded-card bg-accent font-semibold text-on-accent disabled:opacity-50"
          >
            {createVenue.isPending ? '…' : 'Continuer'}
          </button>
        </form>
      )}

      {step === 'offer' && (
        <form
          className="mt-8 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            createOffer.mutate();
          }}
        >
          <h1 className="text-3xl font-bold">Ta première offre découverte</h1>
          <p className="text-text-secondary">Ce que les nouveaux clients pourront essayer.</p>

          <label htmlFor="otitle" className="text-sm font-semibold">Titre</label>
          <input id="otitle" value={offerTitle} onChange={(e) => setOfferTitle(e.target.value)} required minLength={3} placeholder="Première séance découverte" className="min-h-12 rounded-card border border-border bg-surface px-4" />

          <label htmlFor="odesc" className="text-sm font-semibold">Description</label>
          <textarea id="odesc" value={offerDescription} onChange={(e) => setOfferDescription(e.target.value)} required minLength={20} rows={3} placeholder="Décris la séance : à quoi s’attendre, pour quel niveau, ce qui est fourni…" className="rounded-card border border-border bg-surface p-4" />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="oprice" className="text-sm font-semibold">Prix découverte (€)</label>
              <input id="oprice" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="0 = gratuit" className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4" />
            </div>
            <div>
              <label htmlFor="orefprice" className="text-sm font-semibold">Prix habituel (€)</label>
              <input id="orefprice" value={referencePrice} onChange={(e) => setReferencePrice(e.target.value)} inputMode="decimal" placeholder="facultatif" className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4" />
            </div>
            <div>
              <label htmlFor="odur" className="text-sm font-semibold">Durée (minutes)</label>
              <input id="odur" value={duration} onChange={(e) => setDuration(e.target.value)} inputMode="numeric" required className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4" />
            </div>
            <div>
              <label htmlFor="ocap" className="text-sm font-semibold">Places par séance</label>
              <input id="ocap" value={capacity} onChange={(e) => setCapacity(e.target.value)} inputMode="numeric" required className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4" />
            </div>
          </div>

          {categoryIds.length > 1 && (
            <div>
              <label htmlFor="ocat" className="text-sm font-semibold">Catégorie de l’offre</label>
              <select id="ocat" value={offerCategoryId} onChange={(e) => setOfferCategoryId(e.target.value)} className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-3">
                {categoryIds.map((id) => {
                  const c = reference.data?.categories.find((x) => x.id === id);
                  return c ? <option key={id} value={id}>{c.name}</option> : null;
                })}
              </select>
            </div>
          )}

          <button
            type="submit"
            disabled={createOffer.isPending}
            className="min-h-12 rounded-card bg-accent font-semibold text-on-accent disabled:opacity-50"
          >
            {createOffer.isPending ? '…' : 'Continuer'}
          </button>
        </form>
      )}

      {step === 'schedule' && (
        <form
          className="mt-8 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            finish.mutate();
          }}
        >
          <h1 className="text-3xl font-bold">Tes créneaux</h1>
          <p className="text-text-secondary">
            Les jours et l’heure de la séance. Les créneaux des 30 prochains jours seront créés
            automatiquement.
          </p>

          <fieldset>
            <legend className="text-sm font-semibold">Jours</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {DAY_LABELS.map((label, day) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => toggleDay(day)}
                  aria-pressed={daysOfWeek.includes(day)}
                  className={`min-h-11 min-w-14 rounded-pill px-3 text-sm font-semibold ${
                    daysOfWeek.includes(day) ? 'bg-accent text-on-accent' : 'bg-surface-muted text-text-secondary'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          <label htmlFor="stime" className="text-sm font-semibold">Heure de début</label>
          <input id="stime" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required className="min-h-12 w-40 rounded-card border border-border bg-surface px-4" />

          <button
            type="submit"
            disabled={finish.isPending || daysOfWeek.length === 0}
            className="min-h-12 rounded-card bg-accent font-semibold text-on-accent disabled:opacity-50"
          >
            {finish.isPending ? 'Envoi…' : 'Soumettre à TRY'}
          </button>
        </form>
      )}

      {step === 'done' && (
        <div className="mt-10 rounded-card bg-success-subtle p-8 text-center">
          <p className="text-4xl" aria-hidden>✓</p>
          <h1 className="mt-2 text-2xl font-bold text-success">C’est envoyé</h1>
          <p className="mt-2 text-text-secondary">
            Ton lieu et ton offre sont en cours de vérification par l’équipe TRY. Tu recevras une
            réponse rapidement — en attendant, ton tableau de bord est prêt.
          </p>
          <a
            href="/"
            className="mt-6 inline-block rounded-card bg-accent px-5 py-3 font-semibold text-on-accent"
          >
            Voir mon tableau de bord
          </a>
        </div>
      )}
    </main>
  );
}
