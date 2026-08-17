import { ApiError } from '@try/api-client';

/**
 * `VALIDATION_FAILED` porte un `details` indexé par chemin de champ
 * (`{ name: ["..."], contactEmail: ["..."] }`). Jusqu'ici l'assistant ne
 * gardait que `.message` et l'affichait en haut de l'écran — hors du cadre sur
 * mobile, et impossible à relier au bon champ sur un formulaire de dix
 * entrées. Cette fonction retrouve le message d'un champ donné pour
 * l'afficher juste sous lui.
 */
export function fieldErrorsFrom(error: unknown): Record<string, string[]> {
  if (error instanceof ApiError && error.details) return error.details;
  return {};
}

export function fieldError(errors: Record<string, string[]>, field: string): string | null {
  return errors[field]?.[0] ?? null;
}

/** Le message général à afficher quand l'erreur n'est pas (ou pas seulement) une erreur de champ. */
export function generalErrorMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) {
    // Une erreur locale (ex. un prix qui ne se laisse pas convertir en
    // centimes) porte déjà un message utile — pas la peine de l'écraser par
    // un texte générique.
    return error instanceof Error ? error.message : null;
  }
  // Les erreurs de champ sont déjà affichées sous chaque input ; inutile de
  // répéter le même message générique au-dessus du formulaire.
  if (error.code === 'VALIDATION_FAILED' && error.details) return null;
  return error.message;
}
