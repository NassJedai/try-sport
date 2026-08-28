import type {
  BusinessVenueDto,
  CancellationPolicy,
  ExperienceType,
  Locale,
  OfferDetailDto,
  SkillLevel,
  TrialRule,
  UpdateOfferDto,
  UpdateVenueDto,
} from '@try/contracts';

/**
 * Construit les `PATCH` partiels envoyés depuis l'écran de récapitulatif.
 *
 * Règle absolue rappelée par le lot 1 : une clé absente veut dire « ne change
 * rien ». Envoyer le formulaire complet écraserait des champs que le gérant
 * n'a pas ouverts — ces deux fonctions ne renvoient donc que les clés dont la
 * valeur a effectivement changé par rapport à ce que le serveur a répondu.
 */

function changed(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) !== JSON.stringify(b);
  return a !== b;
}

export interface VenueFormValues {
  name: string;
  addressLine: string;
  postalCode: string;
  cityId: string;
  districtId: string;
  latitude: number;
  longitude: number;
  categoryIds: string[];
}

export function diffVenuePatch(
  original: BusinessVenueDto,
  next: VenueFormValues,
): Partial<UpdateVenueDto> {
  const patch: Partial<UpdateVenueDto> = {};

  if (changed(original.name, next.name)) patch.name = next.name;
  if (changed(original.addressLine, next.addressLine)) patch.addressLine = next.addressLine;
  if (changed(original.postalCode, next.postalCode)) patch.postalCode = next.postalCode;
  if (changed(original.cityId, next.cityId)) patch.cityId = next.cityId;

  // Commune et coordonnées voyagent ensemble : changer l'une sans l'autre
  // laisserait le centroïde d'une commune sur une salle qui a déménagé dans
  // une autre.
  if (changed(original.districtId ?? '', next.districtId)) {
    patch.districtId = next.districtId || undefined;
    patch.latitude = next.latitude;
    patch.longitude = next.longitude;
  }

  if (changed(original.categoryIds, next.categoryIds)) patch.categoryIds = next.categoryIds;

  return patch;
}

export interface OfferFormValues {
  title: string;
  description: string;
  categoryId: string;
  experienceType: ExperienceType;
  priceAmount: number;
  /**
   * `undefined` — pas `null` — veut dire « le champ prix habituel n'est pas
   * rendu dans l'état courant du formulaire » : `OfferEditForm` cache ses deux
   * champs de prix quand l'offre est « Gratuit » (`{isPaid && (…)}`), et
   * `null` est déjà pris (« champ vide, pas de prix barré », un choix
   * explicite du gérant quand le champ EST visible). Voir le commentaire de
   * `diffOfferPatch` plus bas pour le bug que cette distinction corrige.
   */
  referencePriceAmount: number | null | undefined;
  durationMinutes: number;
  capacity: number;
  trialRule: TrialRule;
  skillLevel: SkillLevel;
  languages: Locale[];
  cancellationPolicy: CancellationPolicy;
}

/**
 * `original` vient de `GET /v1/offers/:id` (`OfferDetailDto`) et non de la liste
 * `GET /v1/businesses/:id/offers` : cette dernière n'expose ni description, ni
 * catégorie, ni type d'expérience, ni prix habituel — de quoi comparer un
 * sous-ensemble des champs et effacer les autres en silence.
 *
 * Root cause d'un bug constaté sur une offre ACTIVE gratuite (`priceAmount: 0`)
 * portant un prix barré en base (`referencePriceAmount: 2200` — la fiche
 * publique affiche « 19 € barré → Gratuit », un état produit normal). Le
 * gérant ouvre l'édition, ne touche que le titre, enregistre : `isPaid` étant
 * faux, `OfferEditForm` ne rend ni le champ prix découverte ni le champ prix
 * habituel, et calculait leur validation à `{ amount: null, error: null }` —
 * la même valeur qu'un champ vide *visible* que le gérant aurait délibérément
 * effacé. `diffOfferPatch` comparait ce `null` à l'original (`2200`), voyait
 * une différence, et envoyait `referencePriceAmount: null` : le prix barré
 * disparaissait de la base sans qu'aucun geste du gérant ne l'ait demandé.
 *
 * La règle qui corrige ça à la racine, pas en pansement : un champ de prix
 * n'entre dans le patch que si (a) il était rendu dans cet état du formulaire
 * — signalé par `undefined`, jamais `null` — et (b) sa valeur parsée diffère
 * de l'originale. `priceAmount` n'a pas besoin de cette même garde : contrairement
 * au prix habituel, sa valeur reste bien définie même quand son champ de saisie
 * est masqué — le bouton « Gratuit », toujours visible, la fixe alors à `0` de
 * façon déterministe, ce qui est le comportement voulu (Payant → Gratuit doit
 * bien envoyer `priceAmount: 0`).
 */
export function diffOfferPatch(
  original: OfferDetailDto,
  next: OfferFormValues,
): Partial<UpdateOfferDto> {
  const patch: Partial<UpdateOfferDto> = {};

  if (changed(original.title, next.title)) patch.title = next.title;
  if (changed(original.description, next.description)) patch.description = next.description;
  if (changed(original.category.id, next.categoryId)) patch.categoryId = next.categoryId;
  if (changed(original.experienceType, next.experienceType)) patch.experienceType = next.experienceType;
  if (changed(original.price.amount, next.priceAmount)) patch.priceAmount = next.priceAmount;
  if (next.referencePriceAmount !== undefined) {
    if (changed(original.referencePrice?.amount ?? null, next.referencePriceAmount)) {
      patch.referencePriceAmount = next.referencePriceAmount;
    }
  }
  if (changed(original.durationMinutes, next.durationMinutes)) patch.durationMinutes = next.durationMinutes;
  if (changed(original.capacity, next.capacity)) patch.capacity = next.capacity;
  if (changed(original.trialRule, next.trialRule)) patch.trialRule = next.trialRule;
  if (changed(original.skillLevel, next.skillLevel)) patch.skillLevel = next.skillLevel;
  if (changed(original.languages, next.languages)) patch.languages = next.languages;
  if (changed(original.cancellationPolicy, next.cancellationPolicy)) {
    patch.cancellationPolicy = next.cancellationPolicy;
  }

  return patch;
}
