'use client';

import type { ExperienceType } from '@try/contracts';

const DRAFT_KEY = 'try.business.onboarding.draft';

/**
 * Ce que l'assistant d'inscription garde côté client entre deux visites : de la
 * saisie pas encore envoyée au serveur, rien d'autre.
 *
 * Volontairement aucun identifiant ici (`businessId`, `venueId`, `offerId`) :
 * ceux-là se redérivent toujours du serveur au montage (voir `resume.ts`). Un
 * blob de brouillon périmé — vieux d'une semaine, écrit par une autre session —
 * ne peut donc jamais faire boucler l'écran sur un identifiant qui n'existe
 * plus. Il ne fait que réafficher ce que le gérant avait commencé à taper.
 */
export interface OnboardingDraft {
  venueName?: string;
  addressLine?: string;
  postalCode?: string;
  districtId?: string;
  categoryIds?: string[];
  offerTitle?: string;
  offerDescription?: string;
  offerCategoryId?: string;
  experienceType?: ExperienceType;
  isPaid?: boolean;
  price?: string;
  referencePrice?: string;
  duration?: string;
  capacity?: number;
  daysOfWeek?: number[];
  times?: string[];
  venueDescription?: string;
  legalName?: string;
  vatNumber?: string;
}

export function loadOnboardingDraft(): OnboardingDraft {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as OnboardingDraft) : {};
  } catch {
    // Un blob corrompu ne doit pas empêcher l'inscription : on repart à vide
    // plutôt que de faire planter le montage de la page.
    return {};
  }
}

export function saveOnboardingDraft(draft: OnboardingDraft): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

export function clearOnboardingDraft(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(DRAFT_KEY);
}
