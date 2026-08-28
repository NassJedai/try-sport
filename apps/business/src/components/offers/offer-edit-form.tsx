'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@try/api-client';
import type {
  BusinessOfferDto,
  CancellationPolicy,
  ExperienceType,
  Locale,
  OfferDetailDto,
  OfferField,
  OfferStatus,
  SkillLevel,
  TrialRule,
} from '@try/contracts';
import {
  DEFAULT_CANCELLATION_POLICY,
  DEFAULT_TRIAL_RULE,
  INCOHERENT_TRIAL_RULE_MESSAGE,
  MODERATED_OFFER_FIELDS,
  canEditOfferField,
  offerEditRefusalReason,
  offerFieldEditDecision,
  offerFieldLabelFr,
  offerTrialConfigurationIsCoherent,
} from '@try/contracts';
import { toDecimalString } from '@try/utils';
import { api } from '@/lib/api';
import { diffOfferPatch } from '@/lib/onboarding/diff';
import { fieldErrorsFrom, generalErrorMessage } from '@/lib/onboarding/field-errors';
import {
  CANCELLATION_POLICY_OPTIONS,
  DURATION_OPTIONS_MINUTES,
  EXPERIENCE_TYPE_OPTIONS,
  LANGUAGE_OPTIONS,
  SKILL_LEVEL_OPTIONS,
  TRIAL_RULE_OPTIONS,
} from '@/lib/onboarding/constants';
import {
  anyPriceFieldHasError,
  validateOptionalPriceField,
  validateRequiredPositivePriceField,
} from '@/lib/onboarding/price-field';
import { CapacityStepper } from '@/components/onboarding/capacity-stepper';
import { FieldErrorText } from '@/components/onboarding/field-error-text';
import { PillToggle } from '@/components/onboarding/pill-toggle';
import type { CategoryOption } from '@/lib/onboarding/types';

/**
 * Le même texte que le serveur (`onboarding.service.ts`, `updateOffer`) : la
 * revalidation client n'est qu'un confort qui évite un aller-retour, jamais la
 * seule barrière — le serveur garde le dernier mot avec le même message.
 */
const REFERENCE_PRICE_TOO_LOW_MESSAGE = 'Le prix habituel doit être supérieur ou égal au prix découverte.';

/**
 * La phrase du bandeau « en ligne, modification notifiée » — dérivée du
 * contrat plutôt qu'écrite en dur, pour ne jamais tomber en retard dessus (le
 * bandeau énumérait ses champs à la main jusqu'ici).
 *
 * Prend la liste des champs en paramètre plutôt que de fixer
 * `MODERATED_OFFER_FIELDS` en dur : ce bandeau ne doit annoncer que les
 * champs que *ce rendu* du formulaire affiche réellement — huit champs
 * modérés existent dans l'absolu, mais une offre gratuite ne montre pas les
 * deux champs de prix, et un lieu mono-catégorie ne montre pas le sélecteur
 * de catégorie. Annoncer les huit sans regarder l'état courant promettait une
 * correction que l'écran ne propose même pas. Voir l'appel dans
 * `OfferEditForm`, qui filtre `MODERATED_OFFER_FIELDS` sur `isPaid` et
 * `categoryOptions.length` avant de passer la liste ici.
 *
 * `MODERATED_OFFER_FIELDS`, pas `SENSITIVE_OFFER_FIELDS`, reste la bonne liste
 * de départ à filtrer : ce dernier inclut la devise, verrouillée dans tous
 * les statuts (`LOCKED_OFFER_FIELDS`) — la lister ici promettrait une
 * modification que le serveur refuse. Voir le commentaire de
 * `MODERATED_OFFER_FIELDS` dans `editable-fields.ts`, qui le dit
 * explicitement.
 */
function moderatedFieldsLabelListFr(fields: readonly OfferField[]): string {
  return new Intl.ListFormat('fr-BE', { type: 'conjunction' }).format(
    fields.map((field) => {
      const label = offerFieldLabelFr(field);
      return label.charAt(0).toLocaleLowerCase('fr-BE') + label.slice(1);
    }),
  );
}

/**
 * L'édition d'une offre déjà créée, depuis le tableau de bord — la dernière
 * impasse du parcours gérant avant ce chantier : jusqu'ici, corriger une
 * offre après sa création n'était possible que via l'assistant d'inscription,
 * et seulement tant qu'elle n'était pas encore en ligne.
 *
 * Chaque champ dérive son verrou de `editable-fields.ts` (`canEditOfferField`,
 * `offerFieldEditDecision`) plutôt que de coder ici quel champ est modéré :
 * la liste des champs verrouillés a changé une fois déjà (2026-08-28, gel →
 * notification) et changera sans doute encore.
 *
 * Deux `<fieldset disabled>` plutôt qu'un `disabled` répété sur chaque champ :
 * un `<fieldset>` HTML désactive tous les contrôles qu'il contient — boutons,
 * `<select>`, `<textarea>` compris — sans que chaque composant (`PillToggle`,
 * `CapacityStepper`…) ait besoin d'une prop `disabled` dédiée, et les
 * variantes `disabled:` de Tailwind déjà posées sur ces composants
 * s'appliquent telles quelles.
 */
export function OfferEditForm({
  offerId,
  offer,
  categories,
  onClose,
  onSaved,
}: {
  offerId: string;
  /**
   * La ligne de cette offre telle que renvoyée par `GET .../offers` — porte la
   * devise et le prix habituel **brut**, non filtré pour l'affichage public.
   * `GET /v1/offers/:id` (`detailQuery` ci-dessous) reste la source pour tout
   * le reste (description, catégorie, type d'expérience…) : deux DTO, deux
   * usages, voir le commentaire de `businessOfferSchema.referencePriceAmount`.
   */
  offer: BusinessOfferDto;
  /** Catégories du lieu de cette offre — déjà filtrées par l'appelant. */
  categories: CategoryOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();

  const detailQuery = useQuery({
    queryKey: queryKeys.offers.detail(offerId),
    // La liste métier (`GET .../offers`) ne porte ni description, ni
    // catégorie, ni type d'expérience, ni prix habituel — la fiche complète
    // vient de `GET /v1/offers/:id`, comme dans l'assistant d'inscription.
    queryFn: () => api.offers.detail(offerId),
  });

  const [hydrated, setHydrated] = useState(false);
  // Figé au même instant que l'hydratation ci-dessous (même garde `hydrated`),
  // et non recalculé à chaque rendu depuis `detailQuery.data` / `offer` : ces
  // deux requêtes restent vivantes pendant que le panneau est ouvert
  // (`refetchOnWindowFocus`, `staleTime: 30_000`) et peuvent changer sous un
  // formulaire déjà rempli — un collègue qui modifie le prix depuis un autre
  // poste pendant que ce panneau est ouvert. Comparer le diff à une base qui a
  // bougé sous un formulaire figé enverrait un changement que le gérant n'a
  // jamais tapé. Le formulaire et sa base de comparaison doivent rester le
  // même instantané.
  const [originalForDiff, setOriginalForDiff] = useState<OfferDetailDto | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [experienceType, setExperienceType] = useState<ExperienceType>('FREE_TRIAL');
  const [isPaid, setIsPaid] = useState(false);
  const [price, setPrice] = useState('0');
  const [referencePrice, setReferencePrice] = useState('');
  const [duration, setDuration] = useState('60');
  const [capacity, setCapacity] = useState(1);
  const [trialRule, setTrialRule] = useState<TrialRule>(DEFAULT_TRIAL_RULE);
  const [skillLevel, setSkillLevel] = useState<SkillLevel>('ALL_LEVELS');
  const [languages, setLanguages] = useState<Locale[]>(['fr']);
  const [cancellationPolicy, setCancellationPolicy] = useState<CancellationPolicy>(DEFAULT_CANCELLATION_POLICY);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  // Une seule hydratation : sans le garde `hydrated`, un `invalidateQueries`
  // déclenché ailleurs (ou par cette mutation elle-même juste avant la
  // fermeture) republierait les valeurs serveur par-dessus une saisie encore
  // en cours.
  useEffect(() => {
    const detail = detailQuery.data;
    if (!detail || hydrated) return;
    setTitle(detail.title);
    setDescription(detail.description);
    setCategoryId(detail.category.id);
    setExperienceType(detail.experienceType);
    setIsPaid(offer.priceAmount > 0);
    // Prix et prix habituel s'hydratent depuis `offer` (`BusinessOfferDto`),
    // pas depuis `detail.price` / `detail.referencePrice` : ce dernier est
    // filtré pour l'affichage public (`offer.service.ts` le met à `null` dès
    // qu'il n'est pas strictement supérieur au prix). Un prix barré stocké
    // égal au prix découverte était donc invisible dans ce formulaire — ni
    // corrigeable, ni effaçable. `offer.referencePriceAmount` est la valeur
    // brute, telle qu'en base.
    setPrice(toDecimalString({ amount: offer.priceAmount, currency: offer.currency }));
    setReferencePrice(
      offer.referencePriceAmount !== null
        ? toDecimalString({ amount: offer.referencePriceAmount, currency: offer.currency })
        : '',
    );
    setDuration(String(detail.durationMinutes));
    setCapacity(detail.capacity);
    setTrialRule(detail.trialRule);
    setSkillLevel(detail.skillLevel);
    setLanguages(detail.languages);
    setCancellationPolicy(detail.cancellationPolicy);
    // Même source que l'hydratation des champs `price` / `referencePrice`
    // ci-dessus (`offer`, pas `detail.price` / `detail.referencePrice`) et
    // prise au même instant : voir le commentaire de `originalForDiff` plus
    // haut.
    setOriginalForDiff({
      ...detail,
      price: { amount: offer.priceAmount, currency: offer.currency },
      referencePrice:
        offer.referencePriceAmount !== null
          ? { amount: offer.referencePriceAmount, currency: offer.currency }
          : null,
    });
    setHydrated(true);
  }, [detailQuery.data, hydrated, offer]);

  const updateMutation = useMutation({
    mutationFn: (patch: ReturnType<typeof diffOfferPatch>) => api.business.updateOffer(offerId, patch),
    onSuccess: () => {
      setFieldErrors({});
      setGeneralError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.offers.detail(offerId) });
      onSaved();
    },
    onError: (err) => {
      setFieldErrors(fieldErrorsFrom(err));
      setGeneralError(generalErrorMessage(err));
    },
  });

  if (detailQuery.isLoading || !hydrated) {
    return <div className="mt-4 h-64 animate-pulse rounded-card bg-surface-muted" aria-hidden />;
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <div className="mt-4 rounded-card bg-danger-subtle p-4 text-sm text-danger">
        Impossible de charger cette offre.{' '}
        <button type="button" onClick={() => void detailQuery.refetch()} className="font-semibold underline">
          Réessayer
        </button>
      </div>
    );
  }

  const detail = detailQuery.data;
  const status: OfferStatus = detail.status;
  // `offer.currency`, pas `detail.price.currency` : les deux valent la même
  // chose aujourd'hui (`priceAmount` n'est pas filtré), mais `offer` est la
  // source de vérité pour tout ce qui touche l'argent brut de cette offre —
  // un seul endroit à changer le jour où ça cesserait d'être vrai.
  const currency = offer.currency;

  const locked = (field: OfferField): boolean => !canEditOfferField(status, field);

  // Tous les champs `MODERATED` d'une offre partagent la même décision pour un
  // statut donné (`OFFER_EDIT_POLICY[status].MODERATED` est une valeur unique,
  // pas une par champ) : interroger « title » suffit à connaître le sort de
  // toute la section, sans supposer que title serait traité différemment des
  // sept autres champs modérés.
  const moderatedDecision = offerFieldEditDecision(status, 'title');
  const moderatedRefusalReason = offerEditRefusalReason(status);
  // Même raisonnement côté champs libres : « skillLevel » représente la classe
  // FREE dans son ensemble pour ce statut.
  const freeDecision = offerFieldEditDecision(status, 'skillLevel');
  const nothingEditable = moderatedDecision === 'FORBIDDEN' && freeDecision === 'FORBIDDEN';

  const categoryOptions = categories.some((c) => c.id === detail.category.id)
    ? categories
    : [{ id: detail.category.id, name: detail.category.name }, ...categories];

  // Le sélecteur de catégorie ne s'affiche que si le lieu a plus d'une
  // activité déclarée (voir le `categoryOptions.length > 1` sur le rendu
  // plus bas), et les deux champs de prix seulement si l'offre est payante
  // (`{isPaid && (…)}` sur le rendu du prix) : le bandeau doit filtrer les
  // huit champs modérés sur les deux mêmes conditions, pas les énumérer tous.
  const visibleModeratedFields = MODERATED_OFFER_FIELDS.filter((field) => {
    if (field === 'categoryId') return categoryOptions.length > 1;
    if (field === 'priceAmount' || field === 'referencePriceAmount') return isPaid;
    return true;
  });
  const moderatedFieldsListFr = moderatedFieldsLabelListFr(visibleModeratedFields);

  const toggleLanguage = (value: Locale) => {
    const already = languages.includes(value);
    if (already) {
      // Au moins une langue reste sélectionnée — le schéma serveur refuse un
      // tableau vide.
      if (languages.length === 1) return;
      setLanguages(languages.filter((l) => l !== value));
    } else {
      setLanguages([...languages, value]);
    }
  };

  const handleTogglePaid = (paid: boolean) => {
    setIsPaid(paid);
    if (!paid) {
      setPrice('0');
    } else if (price.trim() === '0' || price.trim() === '') {
      setPrice('');
    }
    // Contrairement à la création, on ne réassigne jamais `experienceType` ici :
    // corriger un prix ne doit pas choisir un type d'expérience à la place du
    // gérant qui l'a déjà validé une fois (même logique que
    // `experienceTypeTouched` dans l'assistant).
  };

  // Un prix strictement positif est demandé côté saisie quand « Payant » est
  // choisi ; le serveur l'accepterait techniquement mais ça n'a pas de sens
  // pour le gérant. La seule autorité sur ce qu'est un prix valide est
  // `parseDecimalToMinor`, via `validateRequiredPositivePriceField` — plus de
  // `Number(price.replace(',', '.')) > 0` maison, qui ne remplaçait que la
  // première virgule d'une saisie comme « 1,234,50 » et grisait le bouton
  // sans un mot d'explication.
  const priceValidation = isPaid ? validateRequiredPositivePriceField(price, currency) : { amount: 0, error: null };
  const priceLooksValid = !isPaid || priceValidation.amount !== null;

  const referencePriceValidation = isPaid ? validateOptionalPriceField(referencePrice, currency) : { amount: null, error: null };
  const referencePriceTooLow =
    referencePriceValidation.amount !== null &&
    priceValidation.amount !== null &&
    referencePriceValidation.amount < priceValidation.amount;

  // `priceLooksValid` ne couvre que le prix découverte (requis) : une erreur
  // sur le prix habituel (facultatif) laisse `referencePriceValidation.amount`
  // à `null` — la même valeur qu'un champ vide, qui *veut dire* « pas de prix
  // barré » — et ne fait donc rien échouer côté `priceLooksValid`. Sans ce
  // garde-fou séparé, une saisie illisible comme « 1,234,50 » dans le prix
  // habituel enverrait `referencePriceAmount: null` au serveur, effaçant un
  // prix barré déjà en base sans que le gérant l'ait demandé. Voir
  // `anyPriceFieldHasError` et son test dans `price-field.test.ts`.
  const amountFieldsHaveError = anyPriceFieldHasError(priceValidation, referencePriceValidation);

  const trialConfigCoherent = offerTrialConfigurationIsCoherent({ experienceType, trialRule });

  const canSubmit =
    !nothingEditable &&
    priceLooksValid &&
    !amountFieldsHaveError &&
    !referencePriceTooLow &&
    trialConfigCoherent &&
    !updateMutation.isPending;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    // `canSubmit` a déjà vérifié `priceLooksValid`, `!amountFieldsHaveError`
    // et `!referencePriceTooLow` : `priceValidation.amount` et
    // `referencePriceValidation.amount` sont donc fiables ici, sans nouvelle
    // conversion ni nouveau `try/catch` — la seule conversion vit dans
    // `price-field.ts`.
    if (!canSubmit) return;

    // `originalForDiff` est l'instantané figé à l'hydratation (voir sa
    // déclaration plus haut) : jamais recalculé ici depuis `detail` / `offer`,
    // qui restent des requêtes vivantes tant que ce panneau est ouvert. `!` est
    // sûr : `hydrated` est vrai à ce stade (rendu bloqué par le garde
    // plus haut sinon) et les deux états sont posés dans le même effet.
    const original = originalForDiff!;

    const patch = diffOfferPatch(original, {
      title,
      description,
      categoryId: categoryId || detail.category.id,
      experienceType,
      priceAmount: priceValidation.amount ?? 0,
      // `undefined`, pas la valeur de `referencePriceValidation.amount`, tant
      // que le champ n'est pas rendu (`isPaid` faux) : voir le commentaire de
      // `OfferFormValues.referencePriceAmount` et de `diffOfferPatch` dans
      // `diff.ts` pour le bug qu'un `null` ici provoquait — un prix barré
      // effacé sans geste du gérant sur une offre gratuite.
      referencePriceAmount: isPaid ? referencePriceValidation.amount : undefined,
      durationMinutes: Number(duration),
      capacity,
      trialRule,
      skillLevel,
      languages,
      cancellationPolicy,
    });

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    setFieldErrors({});
    setGeneralError(null);
    updateMutation.mutate(patch);
  };

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-5 border-t border-ink-100 pt-4">
      {moderatedDecision === 'FORBIDDEN' && moderatedRefusalReason && (
        <p role="alert" className="rounded-card bg-surface-muted p-3 text-sm text-text-secondary">
          {moderatedRefusalReason}
        </p>
      )}
      {moderatedDecision === 'NOTIFY_ADMIN' && (
        <p role="status" className="rounded-card bg-accent-subtle p-3 text-sm text-accent-text">
          Cette offre est en ligne : tu peux corriger {moderatedFieldsListFr} sans attendre de
          nouvelle validation. Chaque changement est simplement signalé à l’équipe TRIALYA après coup.
        </p>
      )}

      <fieldset disabled={locked('title')} className="flex flex-col gap-5 disabled:opacity-60">
        <div>
          <label htmlFor={`edit-title-${offerId}`} className="text-sm font-semibold">
            Titre de l’offre
          </label>
          <input
            id={`edit-title-${offerId}`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            minLength={3}
            className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4"
          />
          <FieldErrorText message={fieldErrors.title?.[0]} />
        </div>

        <div>
          <label htmlFor={`edit-description-${offerId}`} className="text-sm font-semibold">
            Description
          </label>
          <textarea
            id={`edit-description-${offerId}`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            required
            rows={4}
            className="mt-1 w-full rounded-card border border-border bg-surface p-4"
          />
          <FieldErrorText message={fieldErrors.description?.[0]} />
        </div>

        {categoryOptions.length > 1 && (
          <div>
            <label htmlFor={`edit-category-${offerId}`} className="text-sm font-semibold">
              Catégorie
            </label>
            <select
              id={`edit-category-${offerId}`}
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-3"
            >
              {categoryOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <FieldErrorText message={fieldErrors.categoryId?.[0]} />
          </div>
        )}

        <div>
          <span className="text-sm font-semibold">Type d’offre</span>
          <div className="mt-2 flex flex-col gap-2">
            {EXPERIENCE_TYPE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setExperienceType(option.value)}
                aria-pressed={experienceType === option.value}
                className={`flex min-h-12 items-center justify-between rounded-card border-2 px-4 py-2 text-left transition disabled:cursor-not-allowed ${
                  experienceType === option.value ? 'border-accent bg-accent-subtle' : 'border-border bg-surface'
                }`}
              >
                <span>
                  <span className="block font-semibold">{option.label}</span>
                  <span className="block text-sm text-text-secondary">{option.hint}</span>
                </span>
                {experienceType === option.value && (
                  <span className="text-accent-text" aria-hidden>
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
          <FieldErrorText message={fieldErrors.experienceType?.[0]} />
        </div>

        <div>
          <span className="text-sm font-semibold">Prix de la séance découverte</span>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => handleTogglePaid(false)}
              aria-pressed={!isPaid}
              className={`min-h-14 rounded-card border-2 text-base font-semibold transition disabled:cursor-not-allowed ${
                !isPaid ? 'border-accent bg-accent-subtle text-accent-text' : 'border-border text-text-secondary'
              }`}
            >
              Gratuit
            </button>
            <button
              type="button"
              onClick={() => handleTogglePaid(true)}
              aria-pressed={isPaid}
              className={`min-h-14 rounded-card border-2 text-base font-semibold transition disabled:cursor-not-allowed ${
                isPaid ? 'border-accent bg-accent-subtle text-accent-text' : 'border-border text-text-secondary'
              }`}
            >
              Payant
            </button>
          </div>

          {isPaid && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`edit-price-${offerId}`} className="text-sm font-semibold">
                  Prix découverte ({currency})
                </label>
                <input
                  id={`edit-price-${offerId}`}
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                  inputMode="decimal"
                  className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4"
                />
                <FieldErrorText message={fieldErrors.priceAmount?.[0] ?? priceValidation.error ?? undefined} />
              </div>
              <div>
                <label htmlFor={`edit-refprice-${offerId}`} className="text-sm font-semibold">
                  Prix habituel ({currency})
                </label>
                <input
                  id={`edit-refprice-${offerId}`}
                  value={referencePrice}
                  onChange={(event) => setReferencePrice(event.target.value)}
                  inputMode="decimal"
                  placeholder="facultatif"
                  className="mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-4"
                />
                <FieldErrorText
                  message={
                    fieldErrors.referencePriceAmount?.[0] ??
                    referencePriceValidation.error ??
                    (referencePriceTooLow ? REFERENCE_PRICE_TOO_LOW_MESSAGE : undefined)
                  }
                />
              </div>
            </div>
          )}
        </div>

        <div>
          <span className="text-sm font-semibold">Durée</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {DURATION_OPTIONS_MINUTES.map((minutes) => (
              <PillToggle key={minutes} pressed={duration === String(minutes)} onClick={() => setDuration(String(minutes))}>
                {minutes} min
              </PillToggle>
            ))}
          </div>
          <FieldErrorText message={fieldErrors.durationMinutes?.[0]} />
        </div>

        <div>
          <span className="text-sm font-semibold">Qui a droit à ce tarif ?</span>
          <div className="mt-2 flex flex-col gap-2">
            {TRIAL_RULE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setTrialRule(option.value)}
                aria-pressed={trialRule === option.value}
                className={`flex min-h-12 items-center justify-between rounded-card border-2 px-4 py-2 text-left transition disabled:cursor-not-allowed ${
                  trialRule === option.value ? 'border-accent bg-accent-subtle' : 'border-border bg-surface'
                }`}
              >
                <span>
                  <span className="block font-semibold">{option.label}</span>
                  <span className="block text-sm text-text-secondary">{option.hint}</span>
                </span>
                {trialRule === option.value && (
                  <span className="text-accent-text" aria-hidden>
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
          {!trialConfigCoherent && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {INCOHERENT_TRIAL_RULE_MESSAGE}
            </p>
          )}
          <FieldErrorText message={fieldErrors.trialRule?.[0]} />
        </div>
      </fieldset>

      <fieldset disabled={locked('skillLevel')} className="flex flex-col gap-5 border-t border-ink-100 pt-4 disabled:opacity-60">
        <div>
          <span className="text-sm font-semibold">Niveau</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {SKILL_LEVEL_OPTIONS.map((option) => (
              <PillToggle key={option.value} pressed={skillLevel === option.value} onClick={() => setSkillLevel(option.value)}>
                {option.label}
              </PillToggle>
            ))}
          </div>
        </div>

        <CapacityStepper value={capacity} onChange={setCapacity} label="Places par séance" />
        <FieldErrorText message={fieldErrors.capacity?.[0]} />

        <div>
          <span className="text-sm font-semibold">Langues du cours</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {LANGUAGE_OPTIONS.map((option) => (
              <PillToggle key={option.value} pressed={languages.includes(option.value)} onClick={() => toggleLanguage(option.value)}>
                {option.label}
              </PillToggle>
            ))}
          </div>
          <FieldErrorText message={fieldErrors.languages?.[0]} />
        </div>

        <div>
          <span className="text-sm font-semibold">Politique d’annulation</span>
          <div className="mt-2 flex flex-col gap-2">
            {CANCELLATION_POLICY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setCancellationPolicy(option.value)}
                aria-pressed={cancellationPolicy === option.value}
                className={`min-h-11 rounded-card border-2 px-4 py-2 text-left text-sm transition disabled:cursor-not-allowed ${
                  cancellationPolicy === option.value ? 'border-accent bg-accent-subtle' : 'border-border bg-surface text-text-secondary'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </fieldset>

      {generalError && (
        <p role="alert" className="text-sm text-danger">
          {generalError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {!nothingEditable && (
          <button
            type="submit"
            disabled={!canSubmit}
            className="min-h-11 rounded-card bg-accent px-5 text-sm font-semibold text-on-accent disabled:opacity-50"
          >
            {updateMutation.isPending ? '…' : 'Enregistrer les modifications'}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 rounded-card border border-ink-200 px-4 text-sm font-semibold hover:bg-surface-muted"
        >
          {nothingEditable ? 'Fermer' : 'Annuler'}
        </button>
      </div>
    </form>
  );
}
