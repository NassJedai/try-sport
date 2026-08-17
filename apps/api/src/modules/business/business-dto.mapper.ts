import type { BusinessStatus } from '@try/contracts';
import { schema } from '@try/database';

type BusinessRow = typeof schema.businesses.$inferSelect;

/**
 * Vue « propriétaire » d'un établissement.
 *
 * Réponse de `GET /v1/businesses/:businessId` et de
 * `PATCH /v1/businesses/:businessId` — l'interface doit pouvoir relire ce
 * qu'elle vient d'écrire, en particulier la TVA sur l'écran de complétion.
 *
 * Pas de `BusinessDetailDto` dans `@try/contracts` aujourd'hui : construit ici
 * pour la même raison que `updateBusinessSchema`
 * (`update-business.schema.ts`) — signalé à `contracts-guardian` plutôt que
 * créé sur place.
 *
 * Champ à champ, c'est *le sous-ensemble modifiable* (`legalName`,
 * `vatNumber`, `countryCode`, `contactEmail`, `contactPhone`) et son contexte
 * minimal (`id`, `name`, `status`, `createdAt`) — pas la ligne entière : la
 * commission (`commissionBasisPoints`), le modèle de facturation et
 * l'identifiant Stripe n'ont rien à faire dans une réponse au gérant, pour la
 * même raison qu'ils ne sont jamais acceptés en écriture
 * (`onboarding.service.ts`, commentaire sur `createBusiness`).
 */
export interface BusinessDetailDto {
  id: string;
  name: string;
  status: BusinessStatus;
  legalName: string | null;
  vatNumber: string | null;
  countryCode: string;
  contactEmail: string;
  contactPhone: string | null;
  createdAt: string;
}

export function toBusinessDetailDto(business: BusinessRow): BusinessDetailDto {
  return {
    id: business.id,
    name: business.name,
    status: business.status,
    legalName: business.legalName,
    vatNumber: business.vatNumber,
    countryCode: business.countryCode,
    contactEmail: business.contactEmail,
    contactPhone: business.contactPhone,
    createdAt: business.createdAt.toISOString(),
  };
}
