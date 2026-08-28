import type { ExperienceType, OfferStatus, VenueStatus } from './enums.js';
import type { UpdateVenueDto } from './schemas/business.js';
import type { UpdateOfferDto } from './schemas/offers.js';

/**
 * Qui peut changer quoi, et quand — la classification des champs d'un lieu et
 * d'une offre selon ce que la modération surveille.
 *
 * Règle métier, en une phrase : **rien de ce que la modération surveille ne
 * bouge pendant qu'un admin l'examine ; une fois en ligne, le lieu garde ses
 * catégories et sa description validées tandis que son identité et le contenu
 * de ses offres redeviennent modifiables — chaque changement prévenant l'admin
 * après coup ; l'exploitation courante ne concerne personne d'autre que le
 * gérant.**
 *
 * Quatre classes de champs, parce que quatre comportements distincts :
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
 *   description, titre, durée, **règle d'essai**. Examiné avant la mise en
 *   ligne, et intouchable pendant l'examen. Ce qu'un statut *en ligne* en fait
 *   diverge depuis le 2026-08-28 : toujours gelé sur un lieu, désormais notifié
 *   sur une offre. La divergence est assumée et son motif — l'instantané de prix
 *   pris par la réservation — est écrit au-dessus d'`OFFER_EDIT_POLICY`. La
 *   classe dit « ceci est examiné », c'est la table du statut qui dit ce qu'il
 *   advient d'une modification.
 * - `LOCKED` — la devise d'une offre, et elle seule aujourd'hui. Refusé dans
 *   **tous** les statuts, sans exception ni table à consulter : ce n'est pas une
 *   question de modération mais de cohérence des données. Un champ verrouillé
 *   ne se corrige pas, il se remplace — on crée un nouvel objet. Voir
 *   `LOCKED_OFFER_FIELDS` et `offerFieldEditDecision`.
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

export const FIELD_CLASSES = ['FREE', 'IDENTITY', 'MODERATED', 'LOCKED'] as const;
export type FieldClass = (typeof FIELD_CLASSES)[number];

/**
 * Un lieu n'a rien de verrouillé : même son fuseau horaire se corrige, à charge
 * pour la notification admin de rattraper les créneaux déjà posés. `LOCKED` est
 * donc exclu de sa classification — classer un champ de lieu ainsi sera une
 * erreur de compilation tant que `VENUE_EDIT_POLICY` n'aura pas décidé ce qu'un
 * verrou signifie côté lieu.
 */
type VenueFieldClass = Exclude<FieldClass, 'LOCKED'>;

/**
 * Un lieu a les trois autres classes.
 *
 * `Record<keyof UpdateVenueDto, …>` : la table est exhaustive **par
 * construction**. Ajouter un champ à `createVenueSchema` sans décider s'il est
 * libre, identitaire ou modéré casse la compilation. Un champ non classé serait
 * autrement un champ modifiable en silence dans tous les statuts.
 */
const VENUE_FIELD_CLASS: Record<keyof UpdateVenueDto, VenueFieldClass> = {
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
 * Une offre a trois classes : libre, modérée, verrouillée.
 *
 * Aucun champ d'offre n'est `IDENTITY` : l'arbitrage portait sur le nom et
 * l'adresse d'une salle, pas sur son catalogue. Le type exclut `IDENTITY`
 * exprès — classer un champ d'offre ainsi sera une erreur de compilation
 * jusqu'à ce que la ligne correspondante soit ajoutée à `OFFER_EDIT_POLICY`,
 * plutôt qu'une réponse silencieuse et probablement fausse.
 */
type OfferFieldClass = Exclude<FieldClass, 'IDENTITY'>;

/**
 * Les classes que le statut arbitre — `LOCKED` n'en fait pas partie.
 *
 * C'est ce qui rend « refusé dans les six statuts » impossible à défaire par
 * inadvertance : un champ verrouillé n'a **pas de ligne** dans
 * `OFFER_EDIT_POLICY`, donc pas de case où quelqu'un pourrait un jour écrire
 * `ALLOWED`. Le verrou tient en une ligne de `offerFieldEditDecision`, et un
 * septième statut d'offre le porterait sans que personne n'ait à y penser.
 */
type OfferPolicyFieldClass = Exclude<OfferFieldClass, 'LOCKED'>;

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
   * **Verrouillée, et non modérée.** Passer une offre de `EUR` à `CHF` sans
   * retoucher `priceAmount` ni `referencePriceAmount` reprice l'offre en
   * silence : les montants sont des unités mineures entières, rien ne les
   * reconvertit, et une séance à 2500 devient une séance à 25 CHF. Ce n'est pas
   * un abus qu'un modérateur pourrait juger après coup, c'est une incohérence
   * de données — d'où le refus dans les six statuts, brouillon compris. La
   * seule issue est une nouvelle offre.
   *
   * Elle a été `MODERATED` jusqu'au 2026-08-28, ce qui suffisait tant que
   * `MODERATED` valait `FORBIDDEN` en ligne. Le desserrage du 2026-08-28 a fait
   * mentir la table : `canEditOfferField('ACTIVE', 'currency')` répondait `true`
   * alors que `OnboardingService.updateOffer` refusait — et refuse toujours — la
   * devise en toutes circonstances. La table dit désormais ce que le service
   * applique.
   *
   * Cette classe **remplace** la garde du service comme source de vérité, elle
   * ne la supprime pas : le refus en amont de la transaction reste le chemin qui
   * produit le bon message (`OFFER_LOCKED_FIELD_REASON`), là où le verdict
   * générique parlerait d'un champ « non reconnu ».
   */
  currency: 'LOCKED',
  skillLevel: 'FREE',
  capacity: 'FREE',
  languages: 'FREE',
  amenities: 'FREE',
  whatToBring: 'FREE',
  conditions: 'FREE',
  cancellationPolicy: 'FREE',
  /**
   * Modérée depuis le 2026-08-26, elle était libre. Ce n'est pas un réglage
   * d'exploitation : `trialRule` décide *qui* a droit au tarif affiché et
   * combien de fois. Passer une offre validée de « un essai par lieu » à
   * « aucune restriction » transforme après coup une séance découverte en
   * réduction permanente — le même abus que remonter le prix, dans l'autre sens,
   * et sur le champ que la modération n'avait justement pas vu changer.
   *
   * La contrepartie est posée à la création : une offre à tarif découverte ne
   * peut pas naître en `NO_RESTRICTION` (`offerTrialConfigurationIsCoherent`).
   *
   * Depuis le 2026-08-28 elle n'est plus gelée en ligne mais notifiée, et cette
   * contrepartie ne tient donc plus toute seule : c'est au service de rejouer
   * `offerTrialConfigurationIsCoherent` sur les valeurs **fusionnées** avec la
   * ligne existante avant d'écrire, exactement comme il rejoue déjà
   * `referencePriceAmount >= priceAmount`. Le schéma ne peut pas s'en charger —
   * un PATCH qui ne porte que `trialRule` n'a pas le type d'expérience sous la
   * main (voir `updateOfferSchema`). Sans ce rappel, un `FREE_TRIAL` en ligne
   * peut passer en `NO_RESTRICTION` et rendre la séance offerte répétable à
   * l'infini : l'alerte admin arriverait, mais après les séances.
   */
  trialRule: 'MODERATED',
};

/**
 * Ce que chaque statut de **lieu** autorise, classe par classe. Les offres ont
 * leur propre table juste dessous, et depuis le 2026-08-28 elles n'en disent
 * plus la même chose sur `MODERATED` en ligne.
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
const VENUE_EDIT_POLICY: Record<VenueStatus, Record<VenueFieldClass, EditDecision>> = {
  DRAFT: { FREE: 'ALLOWED', IDENTITY: 'ALLOWED', MODERATED: 'ALLOWED' },
  REJECTED: { FREE: 'ALLOWED', IDENTITY: 'ALLOWED', MODERATED: 'ALLOWED' },
  PENDING_APPROVAL: { FREE: 'ALLOWED', IDENTITY: 'FORBIDDEN', MODERATED: 'FORBIDDEN' },
  ACTIVE: { FREE: 'ALLOWED', IDENTITY: 'NOTIFY_ADMIN', MODERATED: 'FORBIDDEN' },
  PAUSED: { FREE: 'ALLOWED', IDENTITY: 'NOTIFY_ADMIN', MODERATED: 'FORBIDDEN' },
  SUSPENDED: { FREE: 'FORBIDDEN', IDENTITY: 'FORBIDDEN', MODERATED: 'FORBIDDEN' },
  ARCHIVED: { FREE: 'FORBIDDEN', IDENTITY: 'FORBIDDEN', MODERATED: 'FORBIDDEN' },
};

/**
 * Ce que chaque statut d'offre autorise. Une offre ne connaît pas `SUSPENDED` :
 * suspendre une salle met ses offres en pause.
 *
 * | Statut              | FREE     | MODERATED     |
 * | ------------------- | -------- | ------------- |
 * | `DRAFT`             | autorisé | autorisé      |
 * | `REJECTED`          | autorisé | autorisé      |
 * | `PENDING_APPROVAL`  | autorisé | refusé        |
 * | `ACTIVE` / `PAUSED` | autorisé | notifie admin |
 * | `ARCHIVED`          | refusé   | refusé        |
 *
 * **`ACTIVE` et `PAUSED` sont passés de `FORBIDDEN` à `NOTIFY_ADMIN` le
 * 2026-08-28.** L'offre s'aligne sur la fiche de lieu, qui traite déjà ainsi ses
 * champs identitaires. Le gel était la dernière impasse du parcours gérant :
 * une faute de frappe dans une description, un prix devenu faux, et la seule
 * issue était le support — sur une plateforme qui promet au gérant de tenir son
 * catalogue lui-même.
 *
 * **Ce qui rend ce desserrage tenable, et c'est la seule raison :
 * `reservations.priceAmount` est un instantané**, copié au moment de la
 * réservation (`packages/database/src/schema/booking.ts`). Le prix de l'offre
 * n'est jamais relu pour une réservation déjà prise : un gérant qui remonte son
 * tarif ne déplace pas un euro déjà engagé, ni ce que paie le client, ni la
 * commission calculée dessus. Sans cet instantané, cette ligne serait une
 * réécriture rétroactive de montants et le gel devrait rester.
 *
 * L'abus reste possible — faire valider une séance à 5 € puis la republier à
 * 45 €, ou desserrer `trialRule` une fois en ligne — mais il cesse d'être
 * invisible : chaque écriture alerte l'admin, qui dispose déjà de la
 * suspension. On échange une prévention absolue contre une détection
 * systématique, parce que la prévention absolue coûtait un ticket de support
 * par correction légitime.
 *
 * `PENDING_APPROVAL` ne bouge pas : un dossier ne se réécrit pas sous les yeux
 * du modérateur qui l'examine. Le gérant qui veut corriger le retire de la file
 * (`PENDING_APPROVAL → DRAFT`). `ARCHIVED` ne bouge pas non plus : une offre
 * archivée n'est plus un objet vivant.
 *
 * **Cette table ne dit rien de `currency`, et c'est le point.** La devise est
 * `LOCKED` depuis le 2026-08-28 : elle n'a pas de colonne ici, donc aucun
 * statut ne peut l'autoriser (voir `OfferPolicyFieldClass` et son commentaire
 * dans `OFFER_FIELD_CLASS`). Le refus inconditionnel qu'applique
 * `OnboardingService.updateOffer` a désormais sa source de vérité dans ce
 * fichier plutôt que dans le service seul.
 *
 * **Une garde vit encore hors de cette table et ne doit pas être supprimée au
 * motif qu'elle la couvrirait** : le rappel de
 * `offerTrialConfigurationIsCoherent` sur les valeurs fusionnées (voir
 * `trialRule`). Elle porte ce que `NOTIFY_ADMIN` ne porte pas : une
 * incohérence, contrairement à un abus, ne se rattrape pas après coup.
 *
 * **Déclencheur d'un réexamen** : le jour où un montant serait relu sur l'offre
 * au moment de l'encaissement plutôt que copié à la réservation, l'instantané
 * ne protégerait plus rien et `MODERATED` devrait redevenir `FORBIDDEN` ici.
 */
const OFFER_EDIT_POLICY: Record<OfferStatus, Record<OfferPolicyFieldClass, EditDecision>> = {
  DRAFT: { FREE: 'ALLOWED', MODERATED: 'ALLOWED' },
  REJECTED: { FREE: 'ALLOWED', MODERATED: 'ALLOWED' },
  PENDING_APPROVAL: { FREE: 'ALLOWED', MODERATED: 'FORBIDDEN' },
  ACTIVE: { FREE: 'ALLOWED', MODERATED: 'NOTIFY_ADMIN' },
  PAUSED: { FREE: 'ALLOWED', MODERATED: 'NOTIFY_ADMIN' },
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

/**
 * Pourquoi **ce statut** refuse — jamais pourquoi un champ donné refuse.
 *
 * Depuis le 2026-08-28, une offre en ligne ne refuse plus aucun champ *modéré*.
 * `ACTIVE` et `PAUSED` gardent pourtant une phrase, et il faut savoir laquelle :
 * **une phrase de dernier recours, pas un cas utilisateur.** Le seul refus que
 * le statut y produise encore vise une clé que la classification ne connaît pas
 * (voir `FieldEditVerdict.forbidden`) — or `updateOfferSchema` est un objet Zod,
 * qui *retire* les clés inconnues à la frontière HTTP. Aucune n'atteint donc
 * `reviewOfferFieldEdits` par un client réel, et un gérant ne lira jamais cette
 * phrase en manipulant le tableau de bord. Elle est là par défense en
 * profondeur, pour le jour où quelque chose contournerait le schéma — un appel
 * interne, un test, un point d'entrée futur qui oublierait le pipe de
 * validation : un refus doit toujours porter une phrase, un `CONFLICT` muet est
 * ce que ce fichier interdit depuis le début.
 *
 * L'autre refus qui traverse une offre en ligne ne vient pas du statut : c'est
 * un champ verrouillé — la devise — refusé dans tous les statuts, brouillon
 * compris, et porteur de sa propre phrase (`OFFER_LOCKED_FIELD_REASON`). Celui-là
 * est bel et bien atteignable, `currency` étant une clé connue du schéma. D'où
 * `offerEditRefusalMessage`, qui choisit entre les deux : `DRAFT` et `REJECTED`
 * rendent `null` ici alors qu'ils refusent la devise, et un appelant qui ne
 * lirait que cette table y renverrait un refus muet.
 *
 * Laisser l'ancienne phrase (« contacte le support ») enverrait par ailleurs le
 * gérant demander une modification qu'il a désormais le droit de faire
 * lui-même.
 */
const OFFER_REFUSAL_REASON: Record<OfferStatus, string | null> = {
  DRAFT: null,
  REJECTED: null,
  PENDING_APPROVAL:
    'Cette offre est en cours d’examen. Retire-la de la file d’attente pour modifier son prix, son titre ou sa description.',
  ACTIVE:
    'Cette demande contient un champ que TRIALYA ne reconnaît pas : rien n’a été enregistré. Recharge la page et réessaie, puis contacte le support si le problème persiste.',
  PAUSED:
    'Cette demande contient un champ que TRIALYA ne reconnaît pas : rien n’a été enregistré. Recharge la page et réessaie, puis contacte le support si le problème persiste.',
  ARCHIVED: 'Cette offre est archivée et ne peut plus être modifiée.',
};

export type VenueField = keyof UpdateVenueDto;
export type OfferField = keyof UpdateOfferDto;

export function venueFieldClass(field: VenueField): VenueFieldClass {
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

/**
 * Même contrat que `venueFieldEditDecision`, avec un verrou en amont de la
 * table : un champ `LOCKED` répond `FORBIDDEN` sans consulter le statut. Le
 * `switch` du statut ne peut donc pas se tromper sur la devise, et n'a pas
 * l'occasion d'essayer.
 */
export function offerFieldEditDecision(status: OfferStatus, field: OfferField): EditDecision {
  const fieldClass = OFFER_FIELD_CLASS[field];
  if (fieldClass === 'LOCKED') return 'FORBIDDEN';
  return OFFER_EDIT_POLICY[status][fieldClass];
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
 * Les champs examinés par la modération **et** modifiables un jour — donc
 * sensibles sans être verrouillés.
 *
 * C'est cette liste, et non `SENSITIVE_OFFER_FIELDS`, que doit énumérer un
 * écran qui annonce « voici ce que tu peux corriger, l'équipe en sera
 * informée » : y laisser la devise promettrait au gérant une modification que
 * le serveur refuse.
 */
export const MODERATED_OFFER_FIELDS = fieldsOfClass(
  OFFER_FIELD_CLASS,
  (fieldClass) => fieldClass === 'MODERATED',
);

/**
 * Les champs qu'aucun statut ne rouvre — la devise, et elle seule aujourd'hui.
 *
 * Source de vérité unique du refus, pour le service comme pour les écrans :
 * l'API refuse ces clés avant même d'ouvrir sa transaction, le tableau de bord
 * les affiche en lecture seule. Personne ne réécrit la liste de son côté.
 */
export const LOCKED_OFFER_FIELDS = fieldsOfClass(
  OFFER_FIELD_CLASS,
  (fieldClass) => fieldClass === 'LOCKED',
);

/** « Ce champ ne se corrige jamais » — vrai quel que soit le statut de l'offre. */
export function isLockedOfferField(field: OfferField): boolean {
  return OFFER_FIELD_CLASS[field] === 'LOCKED';
}

/**
 * La phrase à renvoyer au gérant qui tente de modifier un champ verrouillé.
 *
 * Distincte de `offerEditRefusalReason(status)`, qui explique un refus dû au
 * *statut* : ici le statut n'y est pour rien, et dire « cette offre est en
 * cours d'examen » à propos d'une devise serait faux. Texte repris mot pour mot
 * de `OnboardingService.updateOffer` pour que le partage se fasse sans changer
 * ce que lit le gérant.
 */
export const OFFER_LOCKED_FIELD_REASON =
  'La devise ne peut pas être modifiée après la création de l’offre. Crée une nouvelle offre si elle doit changer.';

/**
 * Le nom de chaque champ d'offre, en français, tel qu'on le montre à un humain.
 *
 * `Record<OfferField, string>` : exhaustif par construction, comme la
 * classification juste au-dessus. Un champ ajouté à `updateOfferSchema` sans
 * libellé casse la compilation plutôt que d'apparaître sous son nom technique
 * (« referencePriceAmount ») dans une alerte admin ou un bandeau gérant.
 *
 * Partagé parce que deux consommateurs l'écrivaient chacun de leur côté :
 * l'alerte admin de `moderation-lifecycle.listener.ts` (« Prix de la séance
 * découverte : « 5,00 € » → « 45,00 € » ») et le bandeau de l'écran d'édition
 * d'offre du tableau de bord, qui énumérait les champs modérés en prose. Deux
 * listes qui disent la même chose finissent par ne plus la dire pareil.
 *
 * Ce sont des libellés de champ, pas des valeurs : `trialRule` s'appelle ici
 * « Règle d'essai », et le libellé de *sa valeur* (« Un essai par salle ») reste
 * au consommateur qui l'affiche.
 */
export const OFFER_FIELD_LABELS_FR: Record<OfferField, string> = {
  title: 'Titre de l’offre',
  description: 'Description',
  categoryId: 'Catégorie',
  experienceType: 'Type d’expérience',
  priceAmount: 'Prix de la séance découverte',
  referencePriceAmount: 'Prix habituel (prix barré)',
  currency: 'Devise',
  durationMinutes: 'Durée de la séance',
  trialRule: 'Règle d’essai',
  skillLevel: 'Niveau',
  capacity: 'Places par séance',
  languages: 'Langues du cours',
  amenities: 'Équipements',
  whatToBring: 'À apporter',
  conditions: 'Conditions particulières',
  cancellationPolicy: 'Politique d’annulation',
};

/** Le libellé d'un champ d'offre, ou son nom technique si la clé est inconnue. */
export function offerFieldLabelFr(field: string): string {
  return field in OFFER_FIELD_LABELS_FR ? OFFER_FIELD_LABELS_FR[field as OfferField] : field;
}

/**
 * Le nom de chaque **valeur** de `experienceType`, en français.
 *
 * Voisin de `OFFER_FIELD_LABELS_FR` et distinct de lui : celui-là nomme le champ
 * (« Type d'expérience »), celui-ci nomme la valeur choisie (« Essai gratuit »).
 * Les deux se lisent dans la même phrase d'alerte admin — « Type d'expérience :
 * « Essai gratuit » → « Prix découverte » » — et c'est pour cette phrase qu'ils
 * vivent côte à côte.
 *
 * `Record<ExperienceType, string>` : exhaustif par construction. Un huitième
 * type ajouté à `EXPERIENCE_TYPES` casse la compilation ici plutôt que
 * d'apparaître sous son nom technique (« PREMIUM_EXPERIENCE ») dans une alerte
 * ou sur un écran. C'est la deuxième garde d'exhaustivité de cet enum, après la
 * table `CARRIES_DISCOVERY_PRICE` de `trial-eligibility.ts` — l'une dit ce que
 * le type coûte, l'autre comment il se nomme.
 *
 * Vocabulaire repris mot pour mot de `EXPERIENCE_TYPE_OPTIONS`
 * (`apps/business/src/lib/onboarding/constants.ts`), l'écran où le gérant
 * choisit son format : une alerte qui nommerait le format autrement que l'écran
 * qui l'a proposé ne décrirait plus le clic qui l'a produite. Les *hints* de cet
 * écran restent là-bas — ils vendent le format, ils ne le nomment pas.
 */
export const EXPERIENCE_TYPE_LABELS_FR: Record<ExperienceType, string> = {
  FREE_TRIAL: 'Essai gratuit',
  DISCOVERY_PRICE: 'Prix découverte',
  DISCOVERY_PACK: 'Pack découverte',
  INITIATION: 'Séance d’initiation',
  DAY_PASS: 'Pass journée',
  BEGINNER_CLASS: 'Cours débutant',
  PREMIUM_EXPERIENCE: 'Expérience premium',
};

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

/**
 * La phrase à renvoyer pour un verdict entier — celle que l'API met dans son
 * `CONFLICT` et que le tableau de bord affiche.
 *
 * Un champ verrouillé prime sur le statut : « la devise ne se change pas » est
 * exact dans les six statuts, là où la phrase du statut parlerait d'un dossier
 * en cours d'examen ou d'un champ non reconnu. Sans ce choix, un refus de
 * devise sur un brouillon serait muet (`OFFER_REFUSAL_REASON.DRAFT` vaut
 * `null`).
 */
export function offerEditRefusalMessage(
  status: OfferStatus,
  forbiddenFields: Iterable<string>,
): string | null {
  for (const field of forbiddenFields) {
    if (field in OFFER_FIELD_CLASS && isLockedOfferField(field as OfferField)) {
      return OFFER_LOCKED_FIELD_REASON;
    }
  }
  return offerEditRefusalReason(status);
}
