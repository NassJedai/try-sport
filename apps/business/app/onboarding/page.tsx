'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, queryKeys } from '@try/api-client';
import type { UpdateBusinessInput } from '@try/api-client';
import type { ExperienceType } from '@try/contracts';
import { parseDecimalToMinor, toDecimalString, zonedDayKey } from '@try/utils';
import { api, apiClient, tokenStore } from '@/lib/api';
import {
  clearOnboardingDraft,
  loadOnboardingDraft,
  saveOnboardingDraft,
  type OnboardingDraft,
} from '@/lib/onboarding/draft';
import { resolveResumePoint } from '@/lib/onboarding/resume';
import { DEFAULT_OFFER_CAPACITY, type Step, type WizardStep } from '@/lib/onboarding/constants';
import { diffOfferPatch, diffVenuePatch } from '@/lib/onboarding/diff';
import { fieldError, fieldErrorsFrom, generalErrorMessage } from '@/lib/onboarding/field-errors';
import type { CategoryOption, DistrictOption } from '@/lib/onboarding/types';
import { WizardProgress } from '@/components/onboarding/wizard-progress';
import { BusinessStep } from '@/components/onboarding/business-step';
import { VenueLocationStep } from '@/components/onboarding/venue-location-step';
import { VenueActivitiesStep } from '@/components/onboarding/venue-activities-step';
import { OfferBasicsStep } from '@/components/onboarding/offer-basics-step';
import { OfferFormatStep } from '@/components/onboarding/offer-format-step';
import { ScheduleStep } from '@/components/onboarding/schedule-step';
import { CompleteDossierStep } from '@/components/onboarding/complete-dossier-step';
import { ReviewStep } from '@/components/onboarding/review-step';
import { DoneStep } from '@/components/onboarding/done-step';
import { PendingStep } from '@/components/onboarding/pending-step';

interface ReferenceData {
  cities: {
    id: string;
    name: string;
    districts: { id: string; name: string; latitude: number; longitude: number }[];
  }[];
  categories: { id: string; slug: string; name: string }[];
}

const DEFAULT_TIME_ZONE = 'Europe/Brussels';
// Centroïde de Bruxelles-ville : filet de sécurité si aucune commune n'est
// encore sélectionnée au moment de l'appel (le bouton est alors désactivé).
const FALLBACK_LATITUDE = 50.8467;
const FALLBACK_LONGITUDE = 4.3525;

/**
 * L'assistant d'inscription d'un établissement.
 *
 * Huit écrans courts plutôt qu'un long formulaire : chaque étape crée
 * réellement l'objet côté serveur avant de passer à la suivante — fermer
 * l'onglet en cours de route ne perd rien, on reprend où le serveur dit qu'on
 * en est (voir `lib/onboarding/resume.ts`). Le `localStorage` ne porte que la
 * saisie pas encore envoyée (voir `lib/onboarding/draft.ts`) ; les
 * identifiants se redérivent toujours du serveur au montage.
 *
 * Option B (arbitrage produit) : photo, description du lieu et TVA sont
 * obligatoires pour *soumettre* à modération, jamais pour *créer*. Le gérant
 * crée établissement + lieu + offre + planning en quelques minutes, puis
 * complète — l'écran 7 et le bouton d'envoi de l'écran 8 portent cette
 * règle, pas les écrans de création.
 */
export default function OnboardingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>('loading');
  const [resumed, setResumed] = useState(false);

  // Identifiants dérivés du serveur — jamais du localStorage.
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [venueId, setVenueId] = useState<string | null>(null);
  const [offerId, setOfferId] = useState<string | null>(null);

  const [venueEditing, setVenueEditing] = useState(false);
  const [offerEditing, setOfferEditing] = useState(false);
  const [totalSlotsCreated, setTotalSlotsCreated] = useState(0);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  const handleMutationError = (err: unknown) => {
    setFieldErrors(fieldErrorsFrom(err));
    setGeneralError(generalErrorMessage(err));
  };
  const clearErrors = () => {
    setFieldErrors({});
    setGeneralError(null);
  };

  // Brouillon restauré une seule fois au montage — voir lib/onboarding/draft.ts.
  const [draft, setDraft] = useState<OnboardingDraft>(() => loadOnboardingDraft());
  const updateDraft = (patch: Partial<OnboardingDraft>) =>
    setDraft((current) => {
      const next = { ...current, ...patch };
      saveOnboardingDraft(next);
      return next;
    });
  function withDraft<K extends keyof OnboardingDraft>(
    key: K,
    setState: (value: NonNullable<OnboardingDraft[K]>) => void,
  ) {
    return (value: NonNullable<OnboardingDraft[K]>) => {
      setState(value);
      updateDraft({ [key]: value } as Partial<OnboardingDraft>);
    };
  }

  /* ------------------------------------------------------------------ */
  /* Données de référence + session                                      */
  /* ------------------------------------------------------------------ */

  const reference = useQuery({
    queryKey: ['reference'],
    queryFn: () => apiClient.get<ReferenceData>('/v1/reference'),
    staleTime: 3_600_000,
  });

  const viewer = useQuery({ queryKey: queryKeys.viewer, queryFn: () => api.auth.me(), retry: false });

  /**
   * `businessId` (l'état local ci-dessus) et non une valeur dérivée de
   * `viewer.data` : juste après `POST /businesses`, le jeton vient d'être
   * rafraîchi mais `viewer` ne s'actualise qu'au prochain rendu. Clé sur
   * `viewer.data.businessMemberships[0]` aurait laissé ces deux requêtes
   * désactivées pendant toute la création du lieu, et l'écran 7 se serait
   * affiché vide (`venue` toujours `null`).
   */
  const venuesQuery = useQuery({
    queryKey: [...queryKeys.business.all, businessId, 'venues'],
    queryFn: () => api.business.venues(businessId as string),
    enabled: Boolean(businessId),
  });

  const offersQuery = useQuery({
    queryKey: [...queryKeys.business.all, businessId, 'offers'],
    queryFn: () => api.business.offers(businessId as string),
    enabled: Boolean(businessId),
  });

  // L'assistant ne connaît qu'un seul lieu : le premier créé. Les lieux
  // suivants se gèrent depuis le tableau de bord, pas depuis cet assistant.
  const venue = venuesQuery.data?.items[0] ?? null;
  const offerSummary = offersQuery.data?.items.find((o) => o.venueId === venue?.id) ?? null;
  const activeOfferId = offerId ?? offerSummary?.id ?? null;

  // La liste métier (`GET .../offers`) ne porte ni description, ni catégorie,
  // ni type d'expérience, ni prix habituel : la fiche complète vient d'ici.
  const offerDetailQuery = useQuery({
    queryKey: queryKeys.offers.detail(activeOfferId ?? ''),
    queryFn: () => api.offers.detail(activeOfferId as string),
    enabled: Boolean(activeOfferId),
  });

  /**
   * Le nombre de créneaux déjà programmés pour cette offre. `totalSlotsCreated`
   * (compteur local, alimenté par la réponse de `POST /schedules`) ne connaît
   * que ce qui a été créé *pendant cette session* — un gérant qui revient sur
   * l'écran 8 après avoir fermé l'onglet verrait « 0 séance » alors que des
   * créneaux existent déjà. Cette requête sert de vérité de secours.
   */
  const slotsQuery = useQuery({
    queryKey: [...queryKeys.business.all, businessId, 'slots'],
    queryFn: () => api.business.slots(businessId as string, 30),
    enabled: Boolean(businessId) && (step === 'review' || step === 'complete-dossier'),
  });
  const offerSlotsCount = activeOfferId
    ? (slotsQuery.data?.items.filter((s) => s.offerId === activeOfferId).length ?? null)
    : null;

  const allDistricts: DistrictOption[] = useMemo(
    () =>
      (reference.data?.cities ?? []).flatMap((city) =>
        city.districts.map((d) => ({
          id: d.id,
          name: d.name,
          cityId: city.id,
          latitude: d.latitude,
          longitude: d.longitude,
        })),
      ),
    [reference.data],
  );
  const cityNameById = useMemo(
    () => Object.fromEntries((reference.data?.cities ?? []).map((c) => [c.id, c.name])),
    [reference.data],
  );
  const showCityName = (reference.data?.cities.length ?? 0) > 1;
  const allCategories: CategoryOption[] = reference.data?.categories ?? [];

  /* ------------------------------------------------------------------ */
  /* Écran 1 — l'établissement                                          */
  /* ------------------------------------------------------------------ */
  const [businessName, setBusinessName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [editingEmail, setEditingEmail] = useState(false);

  useEffect(() => {
    if (viewer.data?.email && !contactEmail) setContactEmail(viewer.data.email);
  }, [viewer.data?.email, contactEmail]);

  const createBusiness = useMutation({
    mutationFn: () =>
      apiClient.post<{ businessId: string }>('/v1/businesses', {
        name: businessName,
        contactEmail,
      }),
    onSuccess: async (result) => {
      clearErrors();
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
      setStep('venue-location');
    },
    onError: handleMutationError,
  });

  /* ------------------------------------------------------------------ */
  /* Écrans 2 & 3 — le lieu                                              */
  /* ------------------------------------------------------------------ */
  const [venueName, setVenueName] = useState(draft.venueName ?? '');
  const [addressLine, setAddressLine] = useState(draft.addressLine ?? '');
  const [postalCode, setPostalCode] = useState(draft.postalCode ?? '');
  const [districtId, setDistrictId] = useState(draft.districtId ?? '');
  const [categoryIds, setCategoryIds] = useState<string[]>(draft.categoryIds ?? []);

  const selectedDistrict = allDistricts.find((d) => d.id === districtId) ?? null;

  const createVenue = useMutation({
    mutationFn: () =>
      apiClient.post<{ venueId: string }>(`/v1/businesses/${businessId}/venues`, {
        name: venueName,
        addressLine,
        postalCode,
        cityId: selectedDistrict?.cityId,
        districtId: districtId || undefined,
        /**
         * Position approximative : le centroïde de la commune choisie. Demander
         * des coordonnées GPS à un gérant est une impasse — la position fine
         * s'ajustera avec le géocodage de l'adresse (à venir).
         */
        latitude: selectedDistrict?.latitude ?? FALLBACK_LATITUDE,
        longitude: selectedDistrict?.longitude ?? FALLBACK_LONGITUDE,
        categoryIds,
      }),
    onSuccess: (result) => {
      clearErrors();
      setVenueId(result.venueId);
      updateDraft({
        venueName: undefined,
        addressLine: undefined,
        postalCode: undefined,
        districtId: undefined,
        categoryIds: undefined,
      });
      // Sans ce rafraîchissement, `venue` (dérivé de cette liste) reste `null`
      // jusqu'à la prochaine navigation — et l'écran 7, qui exige `venue` pour
      // s'afficher, resterait vide.
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.business.all, businessId, 'venues'] });
      setStep('offer-basics');
    },
    onError: handleMutationError,
  });

  const updateVenueMutation = useMutation({
    mutationFn: (patch: ReturnType<typeof diffVenuePatch>) =>
      api.business.updateVenue(venueId as string, patch),
    onSuccess: () => {
      clearErrors();
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.business.all, businessId, 'venues'] });
      setVenueEditing(false);
      setStep('review');
    },
    onError: handleMutationError,
  });

  const handleVenueActivitiesSubmit = () => {
    if (venueEditing && venue) {
      const patch = diffVenuePatch(venue, {
        name: venueName,
        addressLine,
        postalCode,
        cityId: selectedDistrict?.cityId ?? venue.cityId,
        districtId,
        latitude: selectedDistrict?.latitude ?? venue.latitude,
        longitude: selectedDistrict?.longitude ?? venue.longitude,
        categoryIds,
      });
      if (Object.keys(patch).length === 0) {
        setVenueEditing(false);
        setStep('review');
        return;
      }
      updateVenueMutation.mutate(patch);
    } else {
      createVenue.mutate();
    }
  };

  const startEditVenue = () => {
    if (!venue) return;
    setVenueName(venue.name);
    setAddressLine(venue.addressLine);
    setPostalCode(venue.postalCode);
    setDistrictId(venue.districtId ?? '');
    setCategoryIds(venue.categoryIds);
    setVenueEditing(true);
    clearErrors();
    setStep('venue-location');
  };

  /* ------------------------------------------------------------------ */
  /* Écrans 4 & 5 — la première offre                                    */
  /* ------------------------------------------------------------------ */
  const [offerTitle, setOfferTitle] = useState(draft.offerTitle ?? '');
  const [offerDescription, setOfferDescription] = useState(draft.offerDescription ?? '');
  const [offerCategoryId, setOfferCategoryId] = useState(draft.offerCategoryId ?? '');
  const [experienceType, setExperienceType] = useState<ExperienceType>(draft.experienceType ?? 'FREE_TRIAL');
  const [experienceTypeTouched, setExperienceTypeTouched] = useState(false);
  const [isPaid, setIsPaid] = useState(draft.isPaid ?? false);
  const [price, setPrice] = useState(draft.price ?? '0');
  const [referencePrice, setReferencePrice] = useState(draft.referencePrice ?? '');
  const [duration, setDuration] = useState(draft.duration ?? '60');
  const [capacity, setCapacity] = useState(draft.capacity ?? DEFAULT_OFFER_CAPACITY);

  const venueCategoryOptions = allCategories.filter((c) => categoryIds.includes(c.id));

  const handleTogglePaid = (paid: boolean) => {
    setIsPaid(paid);
    updateDraft({ isPaid: paid });
    if (!paid) {
      setPrice('0');
      updateDraft({ price: '0' });
    } else if (price.trim() === '0' || price.trim() === '') {
      setPrice('');
      updateDraft({ price: '' });
    }
    if (!experienceTypeTouched) {
      const next: ExperienceType = paid ? 'DISCOVERY_PRICE' : 'FREE_TRIAL';
      setExperienceType(next);
      updateDraft({ experienceType: next });
    }
  };

  const handleExperienceTypeChange = (value: ExperienceType) => {
    setExperienceTypeTouched(true);
    setExperienceType(value);
    updateDraft({ experienceType: value });
  };

  function parseOfferPrices(): { priceAmount: number; referenceAmount: number | null } {
    try {
      const priceAmount = parseDecimalToMinor(price || '0', 'EUR').amount;
      const referenceAmount = referencePrice.trim()
        ? parseDecimalToMinor(referencePrice, 'EUR').amount
        : null;
      return { priceAmount, referenceAmount };
    } catch {
      throw new Error('Le prix doit être un nombre valide, par exemple 8 ou 8,50.');
    }
  }

  const createOffer = useMutation({
    mutationFn: () => {
      const { priceAmount, referenceAmount } = parseOfferPrices();
      return apiClient.post<{ offerId: string }>('/v1/offers', {
        venueId,
        categoryId: offerCategoryId || categoryIds[0],
        title: offerTitle,
        description: offerDescription,
        experienceType,
        priceAmount,
        referencePriceAmount: referenceAmount,
        durationMinutes: Number(duration),
        capacity,
      });
    },
    onSuccess: (result) => {
      clearErrors();
      setOfferId(result.offerId);
      updateDraft({
        offerTitle: undefined,
        offerDescription: undefined,
        offerCategoryId: undefined,
        experienceType: undefined,
        isPaid: undefined,
        price: undefined,
        referencePrice: undefined,
        duration: undefined,
      });
      // `offerSummary` (dérivé de cette liste) sert à décider, à l'écran 8, si
      // l'offre doit encore être soumise (`status === 'DRAFT'`) — sans ce
      // rafraîchissement il resterait `null` et la soumission serait sautée en
      // silence.
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.business.all, businessId, 'offers'] });
      setStep('schedule');
    },
    onError: handleMutationError,
  });

  const updateOfferMutation = useMutation({
    mutationFn: (patch: ReturnType<typeof diffOfferPatch>) =>
      api.business.updateOffer(activeOfferId as string, patch),
    onSuccess: () => {
      clearErrors();
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.business.all, businessId, 'offers'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.offers.detail(activeOfferId ?? '') });
      setOfferEditing(false);
      setStep('review');
    },
    onError: handleMutationError,
  });

  const handleOfferFormatSubmit = () => {
    if (offerEditing && offerDetailQuery.data) {
      let priceAmount: number;
      let referenceAmount: number | null;
      try {
        ({ priceAmount, referenceAmount } = parseOfferPrices());
      } catch (err) {
        handleMutationError(err);
        return;
      }
      const patch = diffOfferPatch(offerDetailQuery.data, {
        title: offerTitle,
        description: offerDescription,
        categoryId: offerCategoryId || categoryIds[0] || '',
        experienceType,
        priceAmount,
        referencePriceAmount: referenceAmount,
        durationMinutes: Number(duration),
        capacity,
      });
      if (Object.keys(patch).length === 0) {
        setOfferEditing(false);
        setStep('review');
        return;
      }
      updateOfferMutation.mutate(patch);
    } else {
      createOffer.mutate();
    }
  };

  const startEditOffer = () => {
    const detail = offerDetailQuery.data;
    if (!detail) return;
    setOfferTitle(detail.title);
    setOfferDescription(detail.description);
    setOfferCategoryId(detail.category.id);
    setExperienceType(detail.experienceType);
    setExperienceTypeTouched(true); // une correction ne doit pas re-choisir le type à la place du gérant
    setIsPaid(detail.price.amount > 0);
    setPrice(toDecimalString(detail.price));
    setReferencePrice(detail.referencePrice ? toDecimalString(detail.referencePrice) : '');
    setDuration(String(detail.durationMinutes));
    setCapacity(detail.capacity);
    setOfferEditing(true);
    clearErrors();
    setStep('offer-basics');
  };

  /* ------------------------------------------------------------------ */
  /* Écran 6 — les créneaux                                              */
  /* ------------------------------------------------------------------ */
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(draft.daysOfWeek ?? []);
  const [times, setTimes] = useState<string[]>(draft.times?.length ? draft.times : ['19:00']);

  const toggleDay = (day: number) => {
    const next = daysOfWeek.includes(day) ? daysOfWeek.filter((d) => d !== day) : [...daysOfWeek, day];
    setDaysOfWeek(next);
    updateDraft({ daysOfWeek: next });
  };

  const createSchedules = useMutation({
    mutationFn: async () => {
      const validFrom = zonedDayKey(new Date(), DEFAULT_TIME_ZONE);
      let created = 0;
      for (const time of times) {
        // Séquentiel et non parallèle : chaque appel est un point de reprise,
        // et une erreur au deuxième horaire ne doit pas laisser le premier
        // dans un état ambigu.
        const result = await apiClient.post<{ scheduleId: string; slotsCreated: number }>(
          '/v1/schedules',
          {
            offerId: activeOfferId,
            daysOfWeek,
            startTime: time,
            capacity,
            validFrom,
          },
        );
        created += result.slotsCreated;
      }
      return created;
    },
    onSuccess: (created) => {
      clearErrors();
      setTotalSlotsCreated((current) => current + created);
      updateDraft({ daysOfWeek: undefined, times: undefined });
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.business.all, businessId, 'slots'] });
      setStep('complete-dossier');
    },
    onError: handleMutationError,
  });

  /* ------------------------------------------------------------------ */
  /* Écran 7 — compléter le dossier                                      */
  /* ------------------------------------------------------------------ */
  const [venueDescription, setVenueDescription] = useState(draft.venueDescription ?? '');
  const [venueDescriptionSavedValue, setVenueDescriptionSavedValue] = useState<string | null>(null);
  const [legalName, setLegalName] = useState(draft.legalName ?? '');
  const [vatNumber, setVatNumber] = useState(draft.vatNumber ?? '');
  const [legalNameSavedValue, setLegalNameSavedValue] = useState<string | null>(null);
  const [vatNumberSavedValue, setVatNumberSavedValue] = useState<string | null>(null);

  useEffect(() => {
    // Reprise directe sur l'écran 7 : la description déjà enregistrée côté
    // serveur prend le pas sur un brouillon local plus ancien.
    if (venue?.description && venueDescription === '') {
      setVenueDescription(venue.description);
      setVenueDescriptionSavedValue(venue.description);
    }
  }, [venue?.description, venueDescription]);

  const saveVenueDescription = useMutation({
    mutationFn: () => api.business.updateVenue(venueId as string, { description: venueDescription }),
    onSuccess: () => {
      clearErrors();
      setVenueDescriptionSavedValue(venueDescription);
      updateDraft({ venueDescription: undefined });
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.business.all, businessId, 'venues'] });
    },
    onError: handleMutationError,
  });

  /**
   * La raison sociale et la TVA ne vivent pas sur `venuesQuery` (qui n'expose
   * que `missingRequirements`, pas les valeurs) mais sur l'établissement —
   * `GET /v1/businesses/:businessId`. Chargée seulement à partir de l'écran 7,
   * comme `slotsQuery` plus haut : aucun écran antérieur n'en a besoin.
   */
  const businessDetailQuery = useQuery({
    queryKey: [...queryKeys.business.all, businessId, 'detail'],
    queryFn: () => api.business.get(businessId as string),
    enabled: Boolean(businessId) && (step === 'complete-dossier' || step === 'review'),
  });

  useEffect(() => {
    // Même logique que la description ci-dessus : ce qui est déjà enregistré
    // côté serveur prend le pas sur un brouillon local plus ancien, une seule
    // fois, sans écraser une saisie en cours.
    if (businessDetailQuery.data?.legalName && legalName === '') {
      setLegalName(businessDetailQuery.data.legalName);
      setLegalNameSavedValue(businessDetailQuery.data.legalName);
    }
    if (businessDetailQuery.data?.vatNumber && vatNumber === '') {
      setVatNumber(businessDetailQuery.data.vatNumber);
      setVatNumberSavedValue(businessDetailQuery.data.vatNumber);
    }
  }, [businessDetailQuery.data?.legalName, businessDetailQuery.data?.vatNumber, legalName, vatNumber]);

  const saveBusinessIdentity = useMutation({
    mutationFn: () => {
      const trimmedLegalName = legalName.trim();
      const trimmedVat = vatNumber.trim();
      const body: UpdateBusinessInput = {};
      // Jamais `countryCode` : il se déduit du numéro de TVA côté serveur, et
      // l'envoyer déclenche un 400 explicite (`BusinessService.updateBusiness`).
      if (trimmedLegalName) body.legalName = trimmedLegalName;
      if (trimmedVat) body.vatNumber = trimmedVat;
      return api.business.update(businessId as string, body);
    },
    onSuccess: (result) => {
      clearErrors();
      /**
       * Le serveur normalise la TVA (« be 0417.497.106 » devient
       * « BE0417497106 ») — on réaffiche ce qu'il a retenu, jamais la saisie
       * brute, sinon le gérant croit que sa saisie n'a pas été prise en compte.
       */
      setLegalName(result.legalName ?? '');
      setLegalNameSavedValue(result.legalName ?? '');
      setVatNumber(result.vatNumber ?? '');
      setVatNumberSavedValue(result.vatNumber ?? '');
      updateDraft({ legalName: undefined, vatNumber: undefined });
      // `missingRequirements` (dérivé de la liste des lieux, pas de cette
      // réponse) doit perdre VALID_VAT_NUMBER ici — sans ce rafraîchissement le
      // bouton d'envoi de l'écran 8 resterait désactivé malgré une TVA
      // enregistrée avec succès.
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.business.all, businessId, 'venues'] });
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.business.all, businessId, 'detail'] });
    },
    onError: (err) => {
      // `PATCH /v1/businesses/:id` est réservé au propriétaire
      // (`BusinessService.updateBusiness`) : un gérant secondaire (MANAGER)
      // reçoit un FORBIDDEN générique — sans ce message dédié, il croirait le
      // produit cassé plutôt que comprendre qu'il faut le compte propriétaire.
      if (err instanceof ApiError && err.code === 'FORBIDDEN') {
        setFieldErrors({});
        setGeneralError(
          'Seul le compte propriétaire de l’établissement peut enregistrer la raison sociale et le numéro de TVA. Demande-lui de s’en charger, ou connecte-toi avec son compte.',
        );
        return;
      }
      handleMutationError(err);
    },
  });

  const refreshVenueCounters = () =>
    void queryClient.invalidateQueries({ queryKey: [...queryKeys.business.all, businessId, 'venues'] });

  /* ------------------------------------------------------------------ */
  /* Écran 8 — vérifier et envoyer                                       */
  /* ------------------------------------------------------------------ */
  const submitDossier = useMutation({
    mutationFn: async () => {
      if (venue && (venue.status === 'DRAFT' || venue.status === 'REJECTED')) {
        await apiClient.post(`/v1/venues/${venue.id}/submit`);
      }
      if (activeOfferId && (offerSummary?.status === 'DRAFT' || offerSummary?.status === 'REJECTED')) {
        await apiClient.post(`/v1/offers/${activeOfferId}/submit`);
      }
    },
    onSuccess: () => {
      clearErrors();
      clearOnboardingDraft();
      setStep('done');
    },
    onError: handleMutationError,
  });

  /* ------------------------------------------------------------------ */
  /* Reprise — dérivée du serveur au montage, jamais du localStorage      */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (resumed) return;
    if (viewer.isLoading) return;
    if (viewer.isError) {
      setResumed(true);
      return;
    }
    if (!viewer.data) return;
    if (viewer.data.businessMemberships.length === 0) {
      setStep('business');
      setResumed(true);
      return;
    }

    setBusinessId(viewer.data.businessMemberships[0]?.businessId ?? null);

    if (venuesQuery.isLoading || offersQuery.isLoading) return;
    if (!venuesQuery.data || !offersQuery.data) return;

    const point = resolveResumePoint({
      viewer: viewer.data,
      venues: venuesQuery.data.items,
      offers: offersQuery.data.items,
    });

    const firstVenue = venuesQuery.data.items[0];
    const matchingOffer = firstVenue
      ? offersQuery.data.items.find((o) => o.venueId === firstVenue.id)
      : undefined;

    switch (point) {
      case 'business':
        setStep('business');
        break;
      case 'venue-location':
        setStep('venue-location');
        break;
      case 'offer-basics':
        if (firstVenue) {
          setVenueId(firstVenue.id);
          setCategoryIds(firstVenue.categoryIds);
        }
        setStep('offer-basics');
        break;
      case 'complete-dossier':
        if (firstVenue) {
          setVenueId(firstVenue.id);
          setCategoryIds(firstVenue.categoryIds);
        }
        if (matchingOffer) {
          setOfferId(matchingOffer.id);
          // Repris pour que « Ajouter des créneaux », plus loin, propose la
          // capacité réelle de l'offre plutôt qu'un brouillon local périmé.
          setCapacity(matchingOffer.capacity);
        }
        setStep('complete-dossier');
        break;
      case 'review':
        if (firstVenue) {
          setVenueId(firstVenue.id);
          setCategoryIds(firstVenue.categoryIds);
        }
        if (matchingOffer) {
          setOfferId(matchingOffer.id);
          setCapacity(matchingOffer.capacity);
        }
        setStep('review');
        break;
      case 'pending':
        setStep('pending');
        break;
      case 'redirect-dashboard':
        router.replace('/');
        break;
    }
    setResumed(true);
  }, [
    resumed,
    viewer.isLoading,
    viewer.isError,
    viewer.data,
    venuesQuery.isLoading,
    venuesQuery.data,
    offersQuery.isLoading,
    offersQuery.data,
  ]);

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

  if (step === 'loading' || !resumed) {
    return (
      <main className="mx-auto max-w-xl p-6 lg:p-10">
        <div className="h-8 w-2/3 animate-pulse rounded-card bg-surface-muted" aria-hidden />
        <div className="mt-4 h-40 animate-pulse rounded-card bg-surface-muted" aria-hidden />
        <p className="sr-only">Chargement de ton dossier…</p>
      </main>
    );
  }

  const isWizardStep = step !== 'pending' && step !== 'done';

  return (
    <main className="mx-auto max-w-xl p-6 pb-28 lg:p-10">
      {isWizardStep && <WizardProgress step={step as WizardStep} />}

      {generalError && (
        <p role="alert" className="mt-4 rounded-card bg-danger-subtle p-3 text-sm text-danger">
          {generalError}
        </p>
      )}

      {step === 'business' && (
        <BusinessStep
          businessName={businessName}
          onBusinessNameChange={setBusinessName}
          contactEmail={contactEmail}
          onContactEmailChange={setContactEmail}
          editingEmail={editingEmail}
          onToggleEditingEmail={() => setEditingEmail(true)}
          viewerReady={viewer.isSuccess}
          fieldErrors={fieldErrors}
          onSubmit={() => createBusiness.mutate()}
          isPending={createBusiness.isPending}
        />
      )}

      {step === 'venue-location' && (
        <VenueLocationStep
          venueName={venueName}
          onVenueNameChange={withDraft('venueName', setVenueName)}
          addressLine={addressLine}
          onAddressLineChange={withDraft('addressLine', setAddressLine)}
          postalCode={postalCode}
          onPostalCodeChange={withDraft('postalCode', setPostalCode)}
          districtId={districtId}
          onDistrictIdChange={withDraft('districtId', setDistrictId)}
          districts={allDistricts}
          showCityName={showCityName}
          cityNameById={cityNameById}
          fieldErrors={fieldErrors}
          onCancel={
            venueEditing
              ? () => {
                  setVenueEditing(false);
                  clearErrors();
                  setStep('review');
                }
              : undefined
          }
          onContinue={() => setStep('venue-activities')}
          ctaLabel="Continuer"
        />
      )}

      {step === 'venue-activities' && (
        <VenueActivitiesStep
          categories={allCategories}
          categoryIds={categoryIds}
          onToggleCategory={(id) => {
            const next = categoryIds.includes(id)
              ? categoryIds.filter((c) => c !== id)
              : [...categoryIds, id];
            setCategoryIds(next);
            updateDraft({ categoryIds: next });
          }}
          fieldErrors={fieldErrors}
          onBack={() => setStep('venue-location')}
          onSubmit={handleVenueActivitiesSubmit}
          isPending={createVenue.isPending || updateVenueMutation.isPending}
          ctaLabel={venueEditing ? 'Enregistrer les modifications' : 'Continuer'}
        />
      )}

      {step === 'offer-basics' && (
        <OfferBasicsStep
          venueBanner={!offerEditing && venue ? `Ton lieu « ${venue.name} » est déjà enregistré.` : null}
          title={offerTitle}
          onTitleChange={withDraft('offerTitle', setOfferTitle)}
          description={offerDescription}
          onDescriptionChange={withDraft('offerDescription', setOfferDescription)}
          categories={venueCategoryOptions}
          categoryId={offerCategoryId || categoryIds[0] || ''}
          onCategoryIdChange={withDraft('offerCategoryId', setOfferCategoryId)}
          fieldErrors={fieldErrors}
          onCancel={
            offerEditing
              ? () => {
                  setOfferEditing(false);
                  clearErrors();
                  setStep('review');
                }
              : undefined
          }
          onContinue={() => setStep('offer-format')}
          ctaLabel="Continuer"
        />
      )}

      {step === 'offer-format' && (
        <OfferFormatStep
          experienceType={experienceType}
          onExperienceTypeChange={handleExperienceTypeChange}
          isPaid={isPaid}
          onTogglePaid={handleTogglePaid}
          price={price}
          onPriceChange={withDraft('price', setPrice)}
          referencePrice={referencePrice}
          onReferencePriceChange={withDraft('referencePrice', setReferencePrice)}
          duration={duration}
          onDurationChange={withDraft('duration', setDuration)}
          capacity={capacity}
          onCapacityChange={withDraft('capacity', setCapacity)}
          fieldErrors={fieldErrors}
          onBack={() => setStep('offer-basics')}
          onSubmit={handleOfferFormatSubmit}
          isPending={createOffer.isPending || updateOfferMutation.isPending}
          ctaLabel={offerEditing ? 'Enregistrer les modifications' : 'Continuer'}
        />
      )}

      {step === 'schedule' && (
        <ScheduleStep
          daysOfWeek={daysOfWeek}
          onToggleDay={toggleDay}
          times={times}
          onTimeChange={(index, value) => {
            const next = times.map((t, i) => (i === index ? value : t));
            setTimes(next);
            updateDraft({ times: next });
          }}
          onAddTime={() => {
            const last = times[times.length - 1] ?? '19:00';
            const next = [...times, last];
            setTimes(next);
            updateDraft({ times: next });
          }}
          onRemoveTime={(index) => {
            const next = times.filter((_, i) => i !== index);
            setTimes(next);
            updateDraft({ times: next });
          }}
          capacity={capacity}
          scheduleError={fieldError(fieldErrors, 'daysOfWeek') ?? fieldError(fieldErrors, 'startTime')}
          onSubmit={() => createSchedules.mutate()}
          isPending={createSchedules.isPending}
          ctaLabel="Continuer"
        />
      )}

      {step === 'complete-dossier' && venueId && venue && (
        <CompleteDossierStep
          venueId={venueId}
          missingRequirements={venue.missingRequirements}
          description={venueDescription}
          onDescriptionChange={withDraft('venueDescription', setVenueDescription)}
          onSaveDescription={() => saveVenueDescription.mutate()}
          isSavingDescription={saveVenueDescription.isPending}
          descriptionSaved={venueDescriptionSavedValue === venueDescription}
          onPhotosChanged={refreshVenueCounters}
          fieldErrors={fieldErrors}
          legalName={legalName}
          onLegalNameChange={withDraft('legalName', setLegalName)}
          vatNumber={vatNumber}
          onVatNumberChange={withDraft('vatNumber', setVatNumber)}
          onSaveIdentity={() => saveBusinessIdentity.mutate()}
          isSavingIdentity={saveBusinessIdentity.isPending}
          // Deux notions distinctes, longtemps confondues ici : « rien à
          // enregistrer » désactive le bouton, « un enregistrement a réussi »
          // affiche la coche. Sans le premier terme, un gérant arrivant sur un
          // dossier vierge lisait « Enregistré ✓ » juste sous la ligne
          // « Renseigne le numéro de TVA » — deux champs vides des deux côtés
          // étant trivialement « identiques ». Constaté en navigateur sur un
          // compte neuf le 22 août 2026.
          //
          // Le `?? ''` reste nécessaire par ailleurs : un champ jamais
          // renseigné (`null` côté serveur) et un champ local encore vide ne
          // sont pas « changés » l'un par rapport à l'autre, sans quoi le
          // bouton resterait actif indéfiniment.
          identitySaved={
            Boolean(vatNumberSavedValue) &&
            (legalNameSavedValue ?? '') === legalName &&
            (vatNumberSavedValue ?? '') === vatNumber
          }
          onContinue={() => setStep('review')}
        />
      )}

      {step === 'review' && venue && offerDetailQuery.data && (
        <ReviewStep
          businessName={
            viewer.data?.businessMemberships.find((m) => m.businessId === businessId)?.businessName ??
            businessName
          }
          contactEmail={contactEmail || viewer.data?.email || ''}
          venue={venue}
          districtName={allDistricts.find((d) => d.id === venue.districtId)?.name ?? null}
          categoryNames={venue.categoryIds
            .map((id) => allCategories.find((c) => c.id === id)?.name)
            .filter((n): n is string => Boolean(n))}
          offer={{
            title: offerDetailQuery.data.title,
            description: offerDetailQuery.data.description,
            experienceType: offerDetailQuery.data.experienceType,
            priceAmount: offerDetailQuery.data.price.amount,
            referencePriceAmount: offerDetailQuery.data.referencePrice?.amount ?? null,
            durationMinutes: offerDetailQuery.data.durationMinutes,
            capacity: offerDetailQuery.data.capacity,
            rejectedReason: offerSummary?.rejectedReason ?? null,
          }}
          slotsCreated={totalSlotsCreated || offerSlotsCount}
          onEditVenue={startEditVenue}
          onEditOffer={startEditOffer}
          onAddSchedule={() => setStep('schedule')}
          onSubmit={() => submitDossier.mutate()}
          isSubmitting={submitDossier.isPending}
          submitError={generalError}
        />
      )}

      {step === 'pending' && <PendingStep contactEmail={contactEmail || viewer.data?.email || ''} />}

      {step === 'done' && (
        <DoneStep
          venueName={venue?.name ?? venueName}
          offerTitle={offerDetailQuery.data?.title ?? offerTitle}
          slotsCreated={totalSlotsCreated || offerSlotsCount || 0}
          contactEmail={contactEmail || viewer.data?.email || ''}
        />
      )}
    </main>
  );
}
