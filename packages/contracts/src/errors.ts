/**
 * Stable, machine-readable error codes. Clients branch on `code`, never on the
 * message — messages are copy and will be translated and reworded.
 *
 * Every message below follows the same rule: say what happened, say what it means
 * for the user's money, say what to do next. "500 Internal Server Error" is never
 * shown to a user.
 */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMITED',
  'IDEMPOTENCY_KEY_REUSED',
  'CONFLICT',

  'OFFER_NOT_BOOKABLE',
  'SLOT_NOT_BOOKABLE',
  'SLOT_FULL',
  'SLOT_IN_PAST',
  'DUPLICATE_BOOKING',
  'TRIAL_NOT_ELIGIBLE',
  'BOOKING_NOT_CANCELLABLE',
  'INVALID_STATE_TRANSITION',

  'PAYMENT_REQUIRED',
  'PAYMENT_FAILED',
  'REFUND_FAILED',

  'CHECKIN_CODE_INVALID',
  'CHECKIN_WRONG_VENUE',
  'CHECKIN_OUTSIDE_WINDOW',
  'CHECKIN_ALREADY_DONE',

  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  readonly code: ErrorCode;
  /** Human-readable, already localised by the API. */
  readonly message: string;
  /** Correlates a user report with server logs. */
  readonly requestId: string;
  /** Field-level detail for VALIDATION_FAILED. */
  readonly details?: Record<string, string[]>;
}

export const ERROR_MESSAGES_FR: Record<ErrorCode, string> = {
  VALIDATION_FAILED: 'Certaines informations sont incorrectes. Vérifie et réessaie.',
  UNAUTHENTICATED: 'Connecte-toi pour continuer.',
  FORBIDDEN: 'Tu n’as pas accès à cette ressource.',
  NOT_FOUND: 'Introuvable. Le contenu a peut-être été retiré.',
  RATE_LIMITED: 'Trop de tentatives. Réessaie dans quelques instants.',
  IDEMPOTENCY_KEY_REUSED:
    'Cette demande a déjà été traitée avec des données différentes. Recommence depuis le début.',
  CONFLICT: 'Cette action entre en conflit avec l’état actuel. Actualise et réessaie.',

  OFFER_NOT_BOOKABLE: 'Cette offre n’est plus disponible à la réservation.',
  SLOT_NOT_BOOKABLE: 'Ce créneau n’est plus disponible.',
  SLOT_FULL: 'Ce créneau vient d’être complet. Choisis un autre horaire.',
  SLOT_IN_PAST: 'Ce créneau est déjà passé.',
  DUPLICATE_BOOKING: 'Tu as déjà une réservation pour ce créneau.',
  TRIAL_NOT_ELIGIBLE: 'Tu as déjà profité d’une séance découverte ici.',
  BOOKING_NOT_CANCELLABLE: 'Cette réservation ne peut plus être annulée.',
  INVALID_STATE_TRANSITION: 'Cette action n’est pas possible pour cette réservation.',

  PAYMENT_REQUIRED: 'Un paiement est nécessaire pour confirmer cette réservation.',
  PAYMENT_FAILED:
    'Impossible de finaliser ta réservation. Aucun paiement n’a été débité. Réessaie dans quelques instants.',
  REFUND_FAILED: 'Le remboursement n’a pas pu être traité. Notre équipe a été prévenue.',

  CHECKIN_CODE_INVALID: 'Ce code n’est pas valide.',
  CHECKIN_WRONG_VENUE: 'Cette réservation concerne un autre lieu.',
  CHECKIN_OUTSIDE_WINDOW: 'Le check-in n’est pas encore ouvert pour cette séance.',
  CHECKIN_ALREADY_DONE: 'Ce participant a déjà été enregistré.',

  INTERNAL_ERROR:
    'Une erreur est survenue de notre côté. Aucune action n’a été effectuée. Réessaie dans quelques instants.',
  SERVICE_UNAVAILABLE: 'Service temporairement indisponible. Réessaie dans quelques instants.',
};

/** HTTP status per error code, so controllers never pick a status ad hoc. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  IDEMPOTENCY_KEY_REUSED: 409,
  CONFLICT: 409,

  OFFER_NOT_BOOKABLE: 409,
  SLOT_NOT_BOOKABLE: 409,
  SLOT_FULL: 409,
  SLOT_IN_PAST: 409,
  DUPLICATE_BOOKING: 409,
  TRIAL_NOT_ELIGIBLE: 403,
  BOOKING_NOT_CANCELLABLE: 409,
  INVALID_STATE_TRANSITION: 409,

  PAYMENT_REQUIRED: 402,
  PAYMENT_FAILED: 402,
  REFUND_FAILED: 500,

  CHECKIN_CODE_INVALID: 404,
  CHECKIN_WRONG_VENUE: 403,
  CHECKIN_OUTSIDE_WINDOW: 409,
  CHECKIN_ALREADY_DONE: 409,

  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};
