import { missingVenueSubmissionRequirements } from '@try/contracts';
import type { BusinessVenueDto } from '@try/contracts';
import { schema } from '@try/database';

type VenueRow = typeof schema.venues.$inferSelect;

/**
 * Construit la vue « propriétaire » d'un lieu à partir de la ligne brute et de
 * ce qui ne vit pas sur `venues` : le numéro de TVA (sur `businesses`), et les
 * compteurs/`categoryIds` résolus par des requêtes séparées.
 *
 * Fonction pure, sans dépendance à la base ni au conteneur NestJS : elle vit
 * ici, dans le dossier `business/`, pour être partagée entre `BusinessService`
 * (liste) et `OnboardingService` (mise à jour) sans que l'un importe le
 * service de l'autre.
 */
export function toBusinessVenueDto(input: {
  venue: VenueRow;
  vatNumber: string | null;
  offerCount: number;
  imageCount: number;
  categoryIds: string[];
}): BusinessVenueDto {
  const { venue, vatNumber, offerCount, imageCount, categoryIds } = input;

  return {
    id: venue.id,
    name: venue.name,
    status: venue.status,
    rejectedReason: venue.rejectedReason,

    addressLine: venue.addressLine,
    postalCode: venue.postalCode,
    cityId: venue.cityId,
    districtId: venue.districtId,
    categoryIds,

    offerCount,
    imageCount,
    missingRequirements: missingVenueSubmissionRequirements({
      offerCount,
      imageCount,
      description: venue.description,
      vatNumber,
    }),

    description: venue.description,
    latitude: venue.latitude,
    longitude: venue.longitude,
    timeZone: venue.timeZone,
    phone: venue.phone,
    website: venue.website,
    instagram: venue.instagram,
    amenities: venue.amenities,
    languages: venue.languages as BusinessVenueDto['languages'],
    openingHours: venue.openingHours,

    createdAt: venue.createdAt.toISOString(),
  };
}
