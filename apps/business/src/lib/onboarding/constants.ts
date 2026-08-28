import type { CancellationPolicy, Locale, SkillLevel, TrialRule, ExperienceType } from '@try/contracts';
import { CANCELLATION_POLICY_DEFINITIONS, EXPERIENCE_TYPE_LABELS_FR } from '@try/contracts';

/**
 * Lundi → dimanche à l'écran — un gérant lit sa semaine ainsi, pas en commençant
 * par dimanche. La valeur envoyée au serveur reste `0 = dimanche`, comme
 * `Date#getDay()` et comme `recurringScheduleSchema` l'attendent : seul l'ordre
 * d'affichage change, jamais la valeur.
 */
export const DAY_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: 'Lun' },
  { value: 2, label: 'Mar' },
  { value: 3, label: 'Mer' },
  { value: 4, label: 'Jeu' },
  { value: 5, label: 'Ven' },
  { value: 6, label: 'Sam' },
  { value: 0, label: 'Dim' },
];

/** Choix fermé plutôt qu'un champ libre : une durée fausse (« 6000 min ») ne se tape plus par erreur. */
export const DURATION_OPTIONS_MINUTES = [30, 45, 60, 75, 90, 120] as const;

export const DEFAULT_OFFER_CAPACITY = 10;
export const MIN_OFFER_CAPACITY = 1;
export const MAX_OFFER_CAPACITY = 500;

/**
 * Options d'écran pour les sept types d'expérience. Le libellé de chacune
 * vient de `EXPERIENCE_TYPE_LABELS_FR` (`@try/contracts`), pas d'un texte posé
 * ici en dur : cette table le dit elle-même dans son commentaire — « Vocabulaire
 * repris mot pour mot de `EXPERIENCE_TYPE_OPTIONS` » — et jusqu'ici cette
 * promesse ne tenait que par une recopie manuelle jamais vérifiée, un
 * renommage d'un côté pouvait diverger de l'autre sans qu'aucun test ne le
 * voie. Seul le *hint* — qui vend le format plutôt que de le nommer — reste
 * propre à cet écran.
 *
 * Avant ce chantier, seuls `FREE_TRIAL` et `DISCOVERY_PRICE` étaient jamais
 * envoyés (déduits du prix) — les cinq autres valeurs du contrat étaient
 * inatteignables depuis cet assistant.
 */
export const EXPERIENCE_TYPE_OPTIONS: { value: ExperienceType; label: string; hint: string }[] = [
  { value: 'FREE_TRIAL', label: EXPERIENCE_TYPE_LABELS_FR.FREE_TRIAL, hint: 'La séance découverte ne coûte rien.' },
  {
    value: 'DISCOVERY_PRICE',
    label: EXPERIENCE_TYPE_LABELS_FR.DISCOVERY_PRICE,
    hint: 'Un tarif réduit pour la toute première séance.',
  },
  {
    value: 'DISCOVERY_PACK',
    label: EXPERIENCE_TYPE_LABELS_FR.DISCOVERY_PACK,
    hint: 'Plusieurs séances à tarif réduit.',
  },
  {
    value: 'INITIATION',
    label: EXPERIENCE_TYPE_LABELS_FR.INITIATION,
    hint: 'Une introduction encadrée à l’activité.',
  },
  { value: 'DAY_PASS', label: EXPERIENCE_TYPE_LABELS_FR.DAY_PASS, hint: 'Accès libre à la salle pour une journée.' },
  {
    value: 'BEGINNER_CLASS',
    label: EXPERIENCE_TYPE_LABELS_FR.BEGINNER_CLASS,
    hint: 'Un cours pensé pour les nouveaux venus.',
  },
  {
    value: 'PREMIUM_EXPERIENCE',
    label: EXPERIENCE_TYPE_LABELS_FR.PREMIUM_EXPERIENCE,
    hint: 'Une séance haut de gamme.',
  },
];

/**
 * Qui a droit au tarif découverte, dans les mots d'un gérant — pas dans ceux du
 * schéma. `ONE_TRIAL_PER_VENUE` en tête : c'est `DEFAULT_TRIAL_RULE` côté
 * contrat, et l'ordre d'affichage suit l'ordre de préférence, pas
 * `TRIAL_RULES`.
 *
 * Le cas `NO_RESTRICTION` porte son avertissement dans son propre texte plutôt
 * que dans un message d'erreur à part : un gérant qui lit « réservé aux offres
 * au tarif normal » avant de cliquer n'a pas besoin d'être repris après coup.
 * La validation stricte (`offerTrialConfigurationIsCoherent`) reste appliquée
 * dans `OfferFormatStep`, pour le cas où il clique quand même.
 */
export const TRIAL_RULE_OPTIONS: { value: TrialRule; label: string; hint: string }[] = [
  {
    value: 'ONE_TRIAL_PER_VENUE',
    label: 'Un essai par salle',
    hint: 'Le tarif découverte ne se réserve qu’une fois dans ce lieu. Le choix habituel : un client qui revient plus tard paie le tarif normal, mais peut essayer une autre de tes salles s’il en existe une autre.',
  },
  {
    value: 'ONE_TRIAL_PER_BUSINESS',
    label: 'Un seul essai, dans toutes mes salles',
    hint: 'Si tu gères plusieurs adresses, un même client ne profite du tarif découverte qu’une seule fois au total, quelle que soit la salle choisie.',
  },
  {
    value: 'ONE_TRIAL_PER_OFFER',
    label: 'Un essai par offre',
    hint: 'Un même client peut essayer chacune de tes offres découverte une fois — utile si elles couvrent des activités bien différentes.',
  },
  {
    value: 'NO_RESTRICTION',
    label: 'Pas de limite',
    hint: 'Un même client peut réserver ce tarif autant de fois qu’il veut. Réservé aux offres au tarif normal — impossible à combiner avec un essai gratuit ou un prix découverte.',
  },
];

/** Quatre niveaux, en langage courant — le serveur ne connaît que la valeur `SkillLevel`. */
export const SKILL_LEVEL_OPTIONS: { value: SkillLevel; label: string }[] = [
  { value: 'ALL_LEVELS', label: 'Tous niveaux' },
  { value: 'BEGINNER', label: 'Débutant' },
  { value: 'INTERMEDIATE', label: 'Intermédiaire' },
  { value: 'ADVANCED', label: 'Avancé' },
];

/** Les trois langues supportées par la plateforme — un multi-choix, jamais vide (voir schéma serveur). */
export const LANGUAGE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'fr', label: 'Français' },
  { value: 'nl', label: 'Néerlandais' },
  { value: 'en', label: 'Anglais' },
];

/** Réutilise le texte déjà validé côté contrat plutôt que d'en écrire un second, divergent à terme. */
export const CANCELLATION_POLICY_OPTIONS: { value: CancellationPolicy; label: string }[] = [
  { value: 'FLEXIBLE', label: CANCELLATION_POLICY_DEFINITIONS.FLEXIBLE.labelFr },
  { value: 'STANDARD', label: CANCELLATION_POLICY_DEFINITIONS.STANDARD.labelFr },
  { value: 'STRICT', label: CANCELLATION_POLICY_DEFINITIONS.STRICT.labelFr },
];

/** Les huit écrans que crée réellement l'assistant, dans l'ordre — sert à la barre de progression. */
export const WIZARD_STEPS = [
  'business',
  'venue-location',
  'venue-activities',
  'offer-basics',
  'offer-format',
  'schedule',
  'complete-dossier',
  'review',
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export type Step = WizardStep | 'loading' | 'pending' | 'done';
