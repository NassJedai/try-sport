import type { ExperienceType } from '@try/contracts';

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
 * Libellés d'écran pour les sept types d'expérience — pure présentation, pas une
 * règle métier : le serveur ne se soucie que de la valeur `ExperienceType`
 * choisie, jamais de son libellé français.
 *
 * Avant ce chantier, seuls `FREE_TRIAL` et `DISCOVERY_PRICE` étaient jamais
 * envoyés (déduits du prix) — les cinq autres valeurs du contrat étaient
 * inatteignables depuis cet assistant.
 */
export const EXPERIENCE_TYPE_OPTIONS: { value: ExperienceType; label: string; hint: string }[] = [
  { value: 'FREE_TRIAL', label: 'Essai gratuit', hint: 'La séance découverte ne coûte rien.' },
  {
    value: 'DISCOVERY_PRICE',
    label: 'Prix découverte',
    hint: 'Un tarif réduit pour la toute première séance.',
  },
  { value: 'DISCOVERY_PACK', label: 'Pack découverte', hint: 'Plusieurs séances à tarif réduit.' },
  { value: 'INITIATION', label: 'Séance d’initiation', hint: 'Une introduction encadrée à l’activité.' },
  { value: 'DAY_PASS', label: 'Pass journée', hint: 'Accès libre à la salle pour une journée.' },
  { value: 'BEGINNER_CLASS', label: 'Cours débutant', hint: 'Un cours pensé pour les nouveaux venus.' },
  { value: 'PREMIUM_EXPERIENCE', label: 'Expérience premium', hint: 'Une séance haut de gamme.' },
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
