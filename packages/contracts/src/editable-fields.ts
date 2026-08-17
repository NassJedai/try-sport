import type { OfferStatus, VenueStatus } from './enums.js';
import type { UpdateVenueDto } from './schemas/business.js';
import type { UpdateOfferDto } from './schemas/offers.js';

/**
 * Qui peut changer quoi, et quand — la classification des champs d'un lieu et
 * d'une offre selon ce que la modération surveille.
 *
 * Règle métier, en une phrase : **la modération gèle ce qui est vendu ; ce qui
 * identifie la salle reste modifiable en ligne, mais chaque changement prévient
 * l'admin ; l'exploitation courante ne concerne personne d'autre que le gérant.**
 *
 * Trois classes de champs, parce que trois comportements distincts :
 *
 * - `FREE` — téléphone, site, réseaux, équipements, langues, horaires, capacité.
 *   Aucun modérateur n'a jamais validé un numéro de téléphone. Modifiable dans
 *   tous les statuts vivants.
 * - `IDENTITY` — nom, adresse, commune, coordonnées, fuseau. Modifiable en ligne
 *   **sans repasser par la modération**, mais **l'admin est notifié** de chaque
 *   changement. Une salle qui déménage ou change d'enseigne ne doit pas
 *   disparaître du catalogue le temps d'une re-validation ; en revanche la
 *   plateforme ne peut pas l'apprendre par hasard.
 * - `MODERATED` — prix, prix de référence, catégories, type d'expérience,
 *   description, titre, durée. Gelé une fois le dossier examiné. Passer une
 *   séance découverte de 5 € à 45 € après approbation est précisément l'abus que
 *   la modération existe pour empêcher.
 *
 * Cette règle vit ici parce que trois consommateurs l'appliquent : l'API (refus
 * d'écriture et déclenchement de la notification), le tableau de bord des salles
 * (griser un champ et dire pourquoi) et la console admin. Dupliquée, elle
 * finirait par laisser passer côté serveur ce que l'écran interdit — ou
 * l'inverse.
 *
 * Ce fichier ne touche pas à la machine à états et n'en a pas besoin : modifier
 * un champ ne change aucun statut. En particulier, éditer le nom d'une salle
 * `ACTIVE` ne la renvoie **pas** en `PENDING_APPROVAL` — la transition n'existe
 * pas, et c'est voulu : la contrepartie de l'édition libre est la notification,
 * pas une re-modération.
 */

export const EDIT_DECISIONS = ['ALLOWED', 'NOTIFY_ADMIN', 'FORBIDDEN'] as const;
export type EditDecision = (typeof EDIT_DECISIONS)[number];

export const FIELD_CLASSES = ['FREE', 'IDENTITY', 'MODERATED'] as const;
export type FieldClass = (typeof FIELD_CLASSES)[number];

/**
 * Un lieu a les trois classes.
 *
 * `Record<keyof UpdateVenueDto, …>` : la table est exhaustive **par
 * construction**. Ajouter un champ à `createVenueSchema` sans décider s'il est
 * libre, identitaire ou modéré casse la compilation. Un champ non classé serait
 * autrement un champ modifiable en silence dans tous les statuts.
 */
const VENUE_FIELD_CLASS: Record<keyof UpdateVenueDto, FieldClass> = {
  name: 'IDENTITY',
  addressLine: 'IDENTITY',
  postalCode: 'IDENTITY',
  cityId: 'IDENTITY',
  districtId: 'IDENTITY',
  latitude: 'IDENTITY',
  longitude: 'IDENTITY',
  /**
   * Le fuseau suit l'adresse : une salle qui déménage à l'étranger et garderait
   * `Europe/Brussels` afficherait ses cours à la mauvaise heure. Il voyage donc
   * avec le bloc adresse — et la notification admin est justement ce qui permet
   * de rattraper un changement de fuseau sur une salle qui a déjà des
   * réservations, puisqu'il déplace l'heure affichée de ses créneaux à venir.
   */
  timeZone: 'IDENTITY',
  /**
   * Modérée, et non identitaire : c'est le champ où l'on glisse un lien de
   * réservation concurrent, un numéro de téléphone ou une promesse que la salle
   * ne tient pas. C'est du contenu examiné, pas une coordonnée.
   */
  description: 'MODERATED',
  categoryIds: 'MODERATED',
  phone: 'FREE',
  website: 'FREE',
  instagram: 'FREE',
  amenities: 'FREE',
  languages: 'FREE',
  openingHours: 'FREE',
};

/**
 * Une offre n'a que deux classes en V1.
 *
 * Aucun champ d'offre n'est `IDENTITY` : l'arbitrage portait sur le nom et
 * l'adresse d'une salle, pas sur son catalogue. Le type est restreint à
 * `'FREE' | 'MODERATED'` exprès — classer un champ d'offre en `IDENTITY` sera
 * une erreur de compilation jusqu'à ce que la ligne correspondante soit ajoutée
 * à `OFFER_EDIT_POLICY`, plutôt qu'une réponse silencieuse et probablement
 * fausse.
 */
type OfferFieldClass = Extract<FieldClass, 'FREE' | 'MODERATED'>;

const OFFER_FIELD_CLASS: Record<keyof UpdateOfferDto, OfferFieldClass> = {
  title: 'MODERATED',
  description: 'MODERATED',
  categoryId: 'MODERATED',
  experienceType: 'MODERATED',
  /** L'argent. Le vecteur d'abus que toute cette classification protège. */
  priceAmount: 'MODERATED',
  referencePriceAmount: 'MODERATED',
  durationMinutes: 'MODERATED',
  /**
   * La devise est du prix : la changer sans toucher au montant reprice l'offre
   * en silence. Modérée par cohérence avec `priceAmount` — et de toute façon une
   * offre qui a déjà des réservations ne peut pas changer de devise.
   */
  currency: 'MODERATED',
  skillLevel: 'FREE',
  capacity: 'FREE',
  languages: 'FREE',
  amenities: 'FREE',
  whatToBring: 'FREE',
  conditions: 'FREE',
  cancellationPolicy: 'FREE',
  trialRule: 'FREE',
};

/**
 * Ce que chaque statut autorise, classe par classe.
 *
 * | Statut             | FREE      | IDENTITY      | MODERATED |
 * | ------------------ | --------- | ------------- | --------- |
 * | `DRAFT`            | autorisé  | autorisé      | autorisé  |
 * | `REJECTED`         | autorisé  | autorisé      | autorisé  |
 * | `PENDING_APPROVAL` | autorisé  | refusé        | refusé    |
 * | `ACTIVE` / `PAUSED`| autorisé  | notifie admin | refusé    |
 * | `SUSPENDED`        | refusé    | refusé        | refusé    |
 * | `ARCHIVED`         | refusé    | refusé        | refusé    |
 *
 * `REJECTED` ouvre tout : c'est l'objet du chantier. Un lieu refusé sans droit
 * de correction est une impasse, et le gérant n'a d'autre issue que de recréer
 * son lieu — ce qui laisse un doublon derrière lui.
 *
 * `PENDING_APPROVAL` gèle le fond : un dossier ne change pas sous les yeux du
 * modérateur qui l'examine. Le gérant qui veut corriger le retire de la file
 * (`PENDING_APPROVAL → DRAFT`, une transition qui existe déjà).
 *
 * `SUSPENDED` gèle tout, y compris le téléphone : une suspension est une
 * décision plateforme, elle ne se contourne pas en éditant.
 */
const VENUE_EDIT_POLICY: Record<VenueStatus, Record<FieldClass, EditDecision>> = {
  DRAFT: { FREE: 'ALLOWED', IDENTITY: 'ALLOWED', MODERATED: 'ALLOWED' },
  REJECTED: { FREE: 'ALLOWED', IDENTITY: 'ALLOWED', MODERATED: 'ALLOWED' },
  PENDING_APPROVAL: { FREE: 'ALLOWED', IDENTITY: 'FORBIDDEN', MODERATED: 'FORBIDDEN' },
  ACTIVE: { FREE: 'ALLOWED', IDENTITY: 'NOTIFY_ADMIN', MODERATED: 'FORBIDDEN' },
  PAUSED: { FREE: 'ALLOWED', IDENTITY: 'NOTIFY_ADMIN', MODERATED: 'FORBIDDEN' },
  SUSPENDED: { FREE: 'FORBIDDEN', IDENTITY: 'FORBIDDEN', MODERATED: 'FORBIDDEN' },
  ARCHIVED: { FREE: 'FORBIDDEN', IDENTITY: 'FORBIDDEN', MODERATED: 'FORBIDDEN' },
};

/** Une offre ne connaît pas `SUSPENDED` : suspendre une salle met ses offres en pause. */
const OFFER_EDIT_POLICY: Record<OfferStatus, Record<OfferFieldClass, EditDecision>> = {
  DRAFT: { FREE: 'ALLOWED', MODERATED: 'ALLOWED' },
  REJECTED: { FREE: 'ALLOWED', MODERATED: 'ALLOWED' },
  PENDING_APPROVAL: { FREE: 'ALLOWED', MODERATED: 'FORBIDDEN' },
  ACTIVE: { FREE: 'ALLOWED', MODERATED: 'FORBIDDEN' },
  PAUSED: { FREE: 'ALLOWED', MODERATED: 'FORBIDDEN' },
  ARCHIVED: { FREE: 'FORBIDDEN', MODERATED: 'FORBIDDEN' },
};

/**
 * Pourquoi c'est refusé, en français, pour le gérant.
 *
 * `null` quand le statut ne refuse rien. Un refus sans explication renvoie le
 * gérant au support, ce qui coûte plus cher que la phrase.
 */
const VENUE_REFUSAL_REASON: Record<VenueStatus, string | null> = {
  DRAFT: null,
  REJECTED: null,
  PENDING_APPROVAL:
    'Ce lieu est en cours d’examen. Retire-le de la file d’attente pour modifier ses informations principales.',
  ACTIVE:
    'Ce lieu est en ligne : son offre, ses prix et ses catégories ont été validés par TRIALYA. Contacte le support pour les faire évoluer.',
  PAUSED:
    'Ce lieu est en ligne : son offre, ses prix et ses catégories ont été validés par TRIALYA. Contacte le support pour les faire évoluer.',
  SUSPENDED: 'Ce lieu est suspendu par TRIALYA. Contacte le support avant toute modification.',
  ARCHIVED: 'Ce lieu est archivé et ne peut plus être modifié.',
};

const OFFER_REFUSAL_REASON: Record<OfferStatus, string | null> = {
  DRAFT: null,
  REJECTED: null,
  PENDING_APPROVAL:
    'Cette offre est en cours d’examen. Retire-la de la file d’attente pour modifier son prix, son titre ou sa description.',
  ACTIVE:
    'Cette offre est en ligne : son prix, son titre et sa description ont été validés par TRIALYA. Contacte le support pour les faire évoluer.',
  PAUSED:
    'Cette offre est en ligne : son prix, son titre et sa description ont été validés par TRIALYA. Contacte le support pour les faire évoluer.',
  ARCHIVED: 'Cette offre est archivée et ne peut plus être modifiée.',
};

export type VenueField = keyof UpdateVenueDto;
export type OfferField = keyof UpdateOfferDto;

export function venueFieldClass(field: VenueField): FieldClass {
  return VENUE_FIELD_CLASS[field];
}

export function offerFieldClass(field: OfferField): OfferFieldClass {
  return OFFER_FIELD_CLASS[field];
}

/**
 * « Ce champ est-il modifiable dans ce statut ? »
 *
 * `NOTIFY_ADMIN` est un oui : l'écriture passe, et l'admin doit être prévenu.
 * Un appelant qui traite la réponse comme un booléen doit donc comparer à
 * `'FORBIDDEN'`, jamais à `'ALLOWED'` — d'où `canEditVenueField` juste dessous,
 * qui évite la faute.
 */
export function venueFieldEditDecision(status: VenueStatus, field: VenueField): EditDecision {
  return VENUE_EDIT_POLICY[status][VENUE_FIELD_CLASS[field]];
}

export function offerFieldEditDecision(status: OfferStatus, field: OfferField): EditDecision {
  return OFFER_EDIT_POLICY[status][OFFER_FIELD_CLASS[field]];
}

export function canEditVenueField(status: VenueStatus, field: VenueField): boolean {
  return venueFieldEditDecision(status, field) !== 'FORBIDDEN';
}

export function canEditOfferField(status: OfferStatus, field: OfferField): boolean {
  return offerFieldEditDecision(status, field) !== 'FORBIDDEN';
}

/** Un champ examiné par la modération — identitaire ou modéré. Le vocabulaire du produit. */
export function isSensitiveVenueField(field: VenueField): boolean {
  return VENUE_FIELD_CLASS[field] !== 'FREE';
}

export function isSensitiveOfferField(field: OfferField): boolean {
  return OFFER_FIELD_CLASS[field] !== 'FREE';
}

function fieldsOfClass<TField extends string, TClass extends string>(
  table: Record<TField, TClass>,
  predicate: (fieldClass: TClass) => boolean,
): readonly TField[] {
  return (Object.keys(table) as TField[]).filter((field) => predicate(table[field]));
}

/** Listes prêtes pour une interface : quels champs verrouiller, lesquels laisser ouverts. */
export const SENSITIVE_VENUE_FIELDS = fieldsOfClass(
  VENUE_FIELD_CLASS,
  (fieldClass) => fieldClass !== 'FREE',
);
export const FREE_VENUE_FIELDS = fieldsOfClass(
  VENUE_FIELD_CLASS,
  (fieldClass) => fieldClass === 'FREE',
);
export const SENSITIVE_OFFER_FIELDS = fieldsOfClass(
  OFFER_FIELD_CLASS,
  (fieldClass) => fieldClass !== 'FREE',
);
export const FREE_OFFER_FIELDS = fieldsOfClass(
  OFFER_FIELD_CLASS,
  (fieldClass) => fieldClass === 'FREE',
);

/**
 * Le verdict sur une demande de modification entière.
 *
 * Ce que le service appelle une fois, avec les clés effectivement soumises : il
 * refuse si `forbidden` n'est pas vide, écrit sinon, et notifie l'admin si
 * `notifyAdmin` n'est pas vide.
 */
export interface FieldEditVerdict<TField extends string> {
  readonly allowed: readonly TField[];
  readonly notifyAdmin: readonly TField[];
  /**
   * Refusés — y compris les clés inconnues. Le refus est le défaut : un nom de
   * champ que la classification ne connaît pas ne doit pas passer par une porte
   * ouverte. En pratique Zod a déjà retiré les clés inconnues ; si l'une arrive
   * ici, c'est que quelque chose contourne le schéma.
   */
  readonly forbidden: readonly string[];
}

function review<TField extends string>(
  fields: Iterable<string>,
  classify: (field: string) => EditDecision | null,
): FieldEditVerdict<TField> {
  const allowed: TField[] = [];
  const notifyAdmin: TField[] = [];
  const forbidden: string[] = [];

  for (const field of fields) {
    switch (classify(field)) {
      case 'ALLOWED':
        allowed.push(field as TField);
        break;
      case 'NOTIFY_ADMIN':
        notifyAdmin.push(field as TField);
        break;
      default:
        forbidden.push(field);
    }
  }

  return { allowed, notifyAdmin, forbidden };
}

export function reviewVenueFieldEdits(
  status: VenueStatus,
  fields: Iterable<string>,
): FieldEditVerdict<VenueField> {
  return review<VenueField>(fields, (field) =>
    field in VENUE_FIELD_CLASS ? venueFieldEditDecision(status, field as VenueField) : null,
  );
}

export function reviewOfferFieldEdits(
  status: OfferStatus,
  fields: Iterable<string>,
): FieldEditVerdict<OfferField> {
  return review<OfferField>(fields, (field) =>
    field in OFFER_FIELD_CLASS ? offerFieldEditDecision(status, field as OfferField) : null,
  );
}

/** La phrase à renvoyer au gérant quand une modification est refusée. */
export function venueEditRefusalReason(status: VenueStatus): string | null {
  return VENUE_REFUSAL_REASON[status];
}

export function offerEditRefusalReason(status: OfferStatus): string | null {
  return OFFER_REFUSAL_REASON[status];
}
