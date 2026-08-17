import type { AppConfig } from '@try/config';

/**
 * Liens vers le tableau de bord business, construits ici et nulle part
 * ailleurs.
 *
 * Trois appelants en ont besoin — l'écouteur de décisions de modération, la
 * relance J+1/J+3, et l'alerte admin — et aucun n'a de raison de connaître le
 * détail du routing du tableau de bord. Un seul endroit à corriger le jour
 * où ce routing change.
 *
 * HYPOTHÈSE À CONFIRMER : `apps/business` était encore en cours de
 * construction en parallèle de ce chantier (une seule page `/onboarding` à
 * plat, sans routing par id, au moment où ces liens ont été écrits). Si le
 * nom du paramètre de requête change côté frontend, ce sont ces deux
 * fonctions qu'il faut corriger — rien d'autre ne recompose ces URLs.
 */

export function venueCompletionUrl(config: Pick<AppConfig, 'BUSINESS_PUBLIC_URL'>, venueId: string): string {
  return `${config.BUSINESS_PUBLIC_URL}/onboarding?venueId=${venueId}`;
}

export function offerCompletionUrl(config: Pick<AppConfig, 'BUSINESS_PUBLIC_URL'>, offerId: string): string {
  return `${config.BUSINESS_PUBLIC_URL}/offers?offerId=${offerId}`;
}
