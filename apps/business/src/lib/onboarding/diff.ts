import type { BusinessVenueDto, ExperienceType, OfferDetailDto, UpdateOfferDto, UpdateVenueDto } from '@try/contracts';

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
  referencePriceAmount: number | null;
  durationMinutes: number;
  capacity: number;
}

/**
 * `original` vient de `GET /v1/offers/:id` (`OfferDetailDto`) et non de la liste
 * `GET /v1/businesses/:id/offers` : cette dernière n'expose ni description, ni
 * catégorie, ni type d'expérience, ni prix habituel — de quoi comparer un
 * sous-ensemble des champs et effacer les autres en silence.
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
  if (changed(original.referencePrice?.amount ?? null, next.referencePriceAmount)) {
    patch.referencePriceAmount = next.referencePriceAmount;
  }
  if (changed(original.durationMinutes, next.durationMinutes)) patch.durationMinutes = next.durationMinutes;
  if (changed(original.capacity, next.capacity)) patch.capacity = next.capacity;

  return patch;
}
