import { z } from 'zod';
import { createBusinessSchema, partialUpdateOf } from '@try/contracts';

/**
 * Mise à jour partielle d'un établissement — raison sociale, numéro de TVA,
 * contact. Champs contractuels et de facturation, pas d'exploitation
 * courante : voir `BusinessService.updateBusiness` pour l'arbitrage OWNER.
 *
 * Construit ici et non dans `@try/contracts` : aucun `updateBusinessSchema`
 * n'existe côté contrats pour ce lot, et ce n'est pas mon territoire — signalé
 * à `contracts-guardian` dans le rapport plutôt que créé sur place. Bâti à
 * partir des briques exportées (`createBusinessSchema`, `partialUpdateOf`),
 * comme le reste de l'inscription autonome (`updateVenueSchema`,
 * `updateOfferSchema`).
 *
 * Deux écarts volontaires par rapport à `partialUpdateOf(createBusinessSchema)`
 * pris tel quel :
 *
 * - `name` est omis. Ce PATCH ne touche jamais au nom commercial : le slug en
 *   dérive, et la synchronisation des titres d'offres du lot 1
 *   (`onboarding.service.ts`, `syncOfferTitlesWithVenueName`) est branchée sur
 *   le renommage d'un *lieu*, pas d'un établissement. Mélanger les deux est le
 *   piège explicitement signalé pour ce lot.
 *
 * - `contactPhone` gagne `.nullable()`. `createBusinessSchema.contactPhone`
 *   est optionnel mais pas nullable — à la création, « absent » suffit. Un
 *   gérant qui a renseigné un numéro doit en revanche pouvoir l'effacer
 *   explicitement ensuite ; la colonne `businesses.contact_phone` est nullable,
 *   le schéma de création ne l'exprimait simplement pas parce que la création
 *   n'en avait pas besoin.
 *
 * `countryCode` reste dans la forme acceptée, volontairement : il n'est pas
 * omis en silence. `BusinessService.updateBusiness` le refuse explicitement
 * avec un 400 s'il est présent dans le corps — même traitement que `currency`
 * dans `updateOfferSchema` (`onboarding.service.ts`, `updateOffer`) : un
 * gérant qui envoie un champ qu'il croit avoir changé doit apprendre que ça
 * n'a pas été pris en compte, pas le découvrir plus tard sur une facture. Le
 * code pays réel se déduit du numéro de TVA validé (`vatCountryOf()`, dans
 * `BusinessService.updateBusiness`), jamais du corps de la requête — Invariant
 * 2 : le client ne décide de rien qui compte.
 *
 * `legalName` et `vatNumber` restent exactement la forme de
 * `createBusinessSchema` : optionnels, non nullables. Effacer un numéro de TVA
 * ou une raison sociale déjà enregistrés n'est pas un besoin de ce lot — voir
 * le commentaire sur la fusion de `vatNumber` dans `BusinessService.updateBusiness`.
 */
export const updateBusinessSchema = partialUpdateOf(createBusinessSchema)
  .omit({ name: true })
  .extend({
    contactPhone: createBusinessSchema.shape.contactPhone.nullable(),
  });
export type UpdateBusinessDto = z.infer<typeof updateBusinessSchema>;
