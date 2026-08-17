import { isValidVatNumber } from './vat-number.js';

/**
 * La complétude d'un dossier de lieu, avant modération.
 *
 * Règle métier : **aucune salle n'est visible en ligne sans photo, sans
 * description et sans numéro de TVA valide** — et la vérification par TRIALYA ne
 * démarre qu'une fois le dossier complet.
 *
 * La contrainte porte sur la *soumission*, pas sur la création. Un gérant crée
 * son établissement, son lieu et sa première offre en quelques minutes avec des
 * champs facultatifs, puis complète. Les schémas de création restent donc
 * permissifs — `createBusinessSchema.vatNumber` et `createVenueSchema.description`
 * sont optionnels — et c'est cette porte-ci qui est stricte. Les deux moitiés de
 * la règle sont volontairement séparées ; ne pas les rapprocher en rendant un
 * champ obligatoire à la création, ce serait ramener le formulaire de dix minutes
 * qu'on vient d'écarter.
 *
 * Quatre consommateurs partagent cette liste, et trois doivent l'énumérer :
 * l'assistant d'inscription (« il te reste à… »), `submitVenue` côté API (refus
 * motivé), la vue admin des salles inscrites mais incomplètes, et le job de
 * rappel à J+1 / J+3. C'est la raison pour laquelle elle vit ici : dupliquée,
 * elle finirait par afficher « dossier complet » sur un écran que la soumission
 * refuse.
 *
 * Cette règle ne dit rien du *statut* : « le dossier est-il complet » et « ce
 * statut autorise-t-il une soumission » sont deux questions distinctes, la
 * seconde étant celle de `moderation-state-machine.ts`. `submitVenue` pose les
 * deux.
 */

export const VENUE_SUBMISSION_REQUIREMENTS = [
  'AT_LEAST_ONE_OFFER',
  'VENUE_DESCRIPTION',
  'AT_LEAST_ONE_PHOTO',
  'VALID_VAT_NUMBER',
] as const;
export type VenueSubmissionRequirement = (typeof VENUE_SUBMISSION_REQUIREMENTS)[number];

/**
 * Une description plus courte que ça n'est pas une description.
 *
 * Le même plancher est appliqué par `createVenueSchema` quand une description
 * est fournie : sans cela un gérant pourrait enregistrer « Salle de sport » puis
 * s'entendre dire que sa description manque, ce qui est incompréhensible.
 */
export const VENUE_DESCRIPTION_MIN_LENGTH = 20;

/** Une photo au minimum. Nommé pour que passer à trois soit une ligne. */
export const VENUE_MIN_IMAGE_COUNT = 1;

/** Ce qu'un lieu doit avoir sous la main pour répondre à la question. */
export interface VenueSubmissionState {
  /** Offres rattachées au lieu, tous statuts confondus. */
  readonly offerCount: number;
  /** Photos du lieu. */
  readonly imageCount: number;
  readonly description: string | null;
  /** Le numéro de TVA de l'établissement porteur, tel qu'il est stocké. */
  readonly vatNumber: string | null;
}

/**
 * L'inventaire des manques, dans l'ordre où on les présente à un humain.
 *
 * Un tableau vide veut dire « complet ». L'ordre est celui de
 * `VENUE_SUBMISSION_REQUIREMENTS`, donc stable : l'écran de complétion et
 * l'e-mail de rappel énumèrent la même chose dans le même ordre.
 */
export function missingVenueSubmissionRequirements(
  state: VenueSubmissionState,
): VenueSubmissionRequirement[] {
  const missing: VenueSubmissionRequirement[] = [];

  // Un lieu sans rien à réserver ferait perdre son temps au modérateur. Cette
  // règle préexiste à l'inventaire (elle valait déjà un 409 à la soumission) et
  // le rejoint : « pourquoi je ne peux pas soumettre » doit avoir une seule
  // réponse, au même endroit, sinon la vue admin des dossiers incomplets
  // annoncerait complet un lieu qui n'a aucune offre.
  if (state.offerCount < 1) missing.push('AT_LEAST_ONE_OFFER');

  if ((state.description ?? '').trim().length < VENUE_DESCRIPTION_MIN_LENGTH) {
    missing.push('VENUE_DESCRIPTION');
  }

  if (state.imageCount < VENUE_MIN_IMAGE_COUNT) missing.push('AT_LEAST_ONE_PHOTO');

  // Valide, pas seulement présent : un numéro faux finirait sur une facture.
  // La validation vit dans `vat-number.ts` et vérifie la clé de contrôle.
  if (!isValidVatNumber(state.vatNumber)) missing.push('VALID_VAT_NUMBER');

  return missing;
}

export function isVenueSubmissionReady(state: VenueSubmissionState): boolean {
  return missingVenueSubmissionRequirements(state).length === 0;
}

/**
 * Libellés courts, pour une liste ou une pastille — vue admin, récapitulatif.
 *
 * Un `Record` exhaustif : ajouter une exigence sans écrire ce qu'un humain en
 * lit casse le build, ce qui vaut mieux qu'une ligne vide dans un e-mail de
 * rappel.
 */
export const VENUE_SUBMISSION_REQUIREMENT_LABELS_FR: Record<VenueSubmissionRequirement, string> = {
  AT_LEAST_ONE_OFFER: 'Aucune offre',
  VENUE_DESCRIPTION: 'Description manquante',
  AT_LEAST_ONE_PHOTO: 'Aucune photo',
  VALID_VAT_NUMBER: 'Numéro de TVA manquant ou invalide',
};

/** Ce qu'on demande au gérant de faire — assistant d'inscription, e-mail de rappel. */
export const VENUE_SUBMISSION_REQUIREMENT_ACTIONS_FR: Record<VenueSubmissionRequirement, string> = {
  AT_LEAST_ONE_OFFER: 'Crée au moins une offre d’essai pour ce lieu.',
  VENUE_DESCRIPTION: `Décris ton lieu en quelques phrases (${VENUE_DESCRIPTION_MIN_LENGTH} caractères minimum).`,
  AT_LEAST_ONE_PHOTO: 'Ajoute au moins une photo de ton lieu.',
  VALID_VAT_NUMBER: 'Renseigne le numéro de TVA de ton établissement.',
};

/**
 * Où le gérant doit aller corriger. Le manque n'est pas toujours sur le lieu :
 * la TVA vit sur l'établissement, l'offre sur elle-même. Sans cette table,
 * chaque écran redevinerait la route et l'e-mail de rappel pointerait au hasard.
 */
export const VENUE_SUBMISSION_REQUIREMENT_SCOPES: Record<
  VenueSubmissionRequirement,
  'BUSINESS' | 'VENUE' | 'OFFER'
> = {
  AT_LEAST_ONE_OFFER: 'OFFER',
  VENUE_DESCRIPTION: 'VENUE',
  AT_LEAST_ONE_PHOTO: 'VENUE',
  VALID_VAT_NUMBER: 'BUSINESS',
};
