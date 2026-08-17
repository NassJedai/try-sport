import type { BusinessOfferDto, BusinessVenueDto, ViewerDto } from '@try/contracts';

/**
 * Où atterrit un gérant qui rouvre l'assistant, dérivé du serveur — jamais du
 * `localStorage` (voir `draft.ts`) et jamais d'une question posée à l'utilisateur :
 * un gérant non technique ne peut pas répondre à « as-tu déjà créé un lieu ? ».
 *
 * Volontairement grossier : ce n'est pas une machine à états complète, juste la
 * table de reprise donnée par le produit. `'redirect-dashboard'` n'est pas un
 * écran de l'assistant — c'est le signal que son travail est fait et que la
 * suite se passe dans « Offres & planning ».
 */
export type ResumePoint =
  | 'business'
  | 'venue-location'
  | 'offer-basics'
  | 'complete-dossier'
  | 'review'
  | 'pending'
  | 'redirect-dashboard';

export function resolveResumePoint(input: {
  viewer: ViewerDto;
  venues: readonly BusinessVenueDto[];
  offers: readonly BusinessOfferDto[];
}): ResumePoint {
  if (input.viewer.businessMemberships.length === 0) return 'business';

  // L'assistant ne connaît qu'un lieu à la fois — le premier créé. Les lieux
  // suivants se gèrent depuis le tableau de bord, pas depuis cet assistant.
  const venue = input.venues[0];
  if (!venue) return 'venue-location';

  if (venue.status === 'REJECTED') return 'review'; // motif en tête, voir review-step
  if (venue.status === 'PENDING_APPROVAL') return 'pending';
  if (venue.status === 'DRAFT') {
    if (venue.offerCount === 0) return 'offer-basics';
    // Dossier incomplet ou complet : dans les deux cas l'écran 7 est la bonne
    // porte, et affiche lui-même les manques en tête s'il y en a.
    return 'complete-dossier';
  }

  // Le lieu est ACTIVE ou PAUSED : il est déjà passé en ligne au moins une fois,
  // ce qui est précisément l'objectif de cet assistant.
  const offer = input.offers.find((item) => item.venueId === venue.id);
  if (offer?.status === 'ACTIVE') return 'redirect-dashboard';
  if (offer?.status === 'REJECTED') return 'review';
  if (offer?.status === 'PENDING_APPROVAL') return 'pending';

  // Rien de bloquant pour l'assistant : la suite (nouvelle offre, planning,
  // photos) se passe depuis le tableau de bord.
  return 'redirect-dashboard';
}
