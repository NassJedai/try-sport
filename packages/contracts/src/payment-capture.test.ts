import { describe, expect, it } from 'vitest';
import {
  CAPTURED_PAYMENT_STATUSES,
  CAPTURED_PAYMENT_STATUSES_SQL,
  hasNoObservedCapture,
  IN_FLIGHT_PAYMENT_STATUSES,
  isCapturedPayment,
  NEVER_CAPTURED_PAYMENT_STATUSES,
  NEVER_CAPTURED_PAYMENT_STATUSES_SQL,
  PAYMENT_CAPTURE_OBSERVATIONS,
  paymentCaptureObservation,
  STOPPED_PAYMENT_STATUSES,
  type PaymentCaptureObservation,
} from './payment-capture.js';
import { PAYMENT_STATUSES, type PaymentStatus } from './enums.js';

describe('ce que notre base a constaté de l’encaissement', () => {
  it('ne constate un encaissement que sur les trois statuts où l’argent est entré', () => {
    expect(isCapturedPayment('SUCCEEDED')).toBe(true);
    // Le brut a bien été encaissé : un remboursement fait baisser le GMV et la
    // commission, il ne les fait pas disparaître.
    expect(isCapturedPayment('PARTIALLY_REFUNDED')).toBe(true);
    expect(isCapturedPayment('REFUNDED')).toBe(true);

    expect(isCapturedPayment('REQUIRES_PAYMENT')).toBe(false);
    expect(isCapturedPayment('PROCESSING')).toBe(false);
    expect(isCapturedPayment('FAILED')).toBe(false);
    expect(isCapturedPayment('CANCELLED')).toBe(false);
  });

  it('distingue une tentative encore ouverte d’une tentative arrêtée', () => {
    expect(paymentCaptureObservation('REQUIRES_PAYMENT')).toBe('IN_FLIGHT');
    expect(paymentCaptureObservation('PROCESSING')).toBe('IN_FLIGHT');
    expect(paymentCaptureObservation('FAILED')).toBe('STOPPED');
    expect(paymentCaptureObservation('CANCELLED')).toBe('STOPPED');
    expect(paymentCaptureObservation('SUCCEEDED')).toBe('CAPTURED');
  });

  it('ne prétend rien sur ce que le fournisseur détient', () => {
    // Le `payment_intent.succeeded` perdu : Stripe a l'argent, notre base dit
    // REQUIRES_PAYMENT. Localement indiscernable d'un panier abandonné — les
    // deux répondent la même chose, et c'est la réponse honnête.
    const webhookPerdu: PaymentStatus = 'REQUIRES_PAYMENT';
    const panierAbandonne: PaymentStatus = 'REQUIRES_PAYMENT';
    expect(paymentCaptureObservation(webhookPerdu)).toBe(
      paymentCaptureObservation(panierAbandonne),
    );
    expect(isCapturedPayment(webhookPerdu)).toBe(false);

    // Un refus de carte n'est pas davantage une preuve d'absence : le client
    // peut réessayer sur la même intention et voir ce succès se perdre aussi.
    // `STOPPED` décrit la tentative, jamais la caisse du fournisseur — d'où le
    // fait que la question d'argent le range avec `IN_FLIGHT`.
    expect(hasNoObservedCapture('FAILED')).toBe(true);
    expect(hasNoObservedCapture('REQUIRES_PAYMENT')).toBe(true);
  });

  it('fait de `hasNoObservedCapture` le complément strict de `isCapturedPayment`', () => {
    // La règle qui manquait : les deux listes qui vivaient dans apps/api ne
    // pouvaient pas se contredire… tant que personne n'ajoutait un statut.
    for (const status of PAYMENT_STATUSES) {
      expect(hasNoObservedCapture(status)).toBe(!isCapturedPayment(status));
    }
  });
});

describe('listes dérivées', () => {
  it('partitionne PAYMENT_STATUSES sans trou ni recouvrement', () => {
    expect([...CAPTURED_PAYMENT_STATUSES, ...NEVER_CAPTURED_PAYMENT_STATUSES].sort()).toEqual(
      [...PAYMENT_STATUSES].sort(),
    );
    expect(
      [
        ...CAPTURED_PAYMENT_STATUSES,
        ...IN_FLIGHT_PAYMENT_STATUSES,
        ...STOPPED_PAYMENT_STATUSES,
      ].sort(),
    ).toEqual([...PAYMENT_STATUSES].sort());
  });

  it('reproduit exactement les trois ensembles qui vivaient dans apps/api', () => {
    // moderation.service.ts et admin-browse.service.ts (liste blanche)…
    expect([...CAPTURED_PAYMENT_STATUSES].sort()).toEqual([
      'PARTIALLY_REFUNDED',
      'REFUNDED',
      'SUCCEEDED',
    ]);
    // …et refund-ledger.service.ts (liste noire), désormais dérivée de la même
    // table plutôt que saisie en face.
    expect([...NEVER_CAPTURED_PAYMENT_STATUSES].sort()).toEqual([
      'CANCELLED',
      'FAILED',
      'PROCESSING',
      'REQUIRES_PAYMENT',
    ]);
  });

  it('donne une liste injectable dans du SQL brut, dérivée et non retapée', () => {
    expect(CAPTURED_PAYMENT_STATUSES_SQL).toBe("'SUCCEEDED', 'REFUNDED', 'PARTIALLY_REFUNDED'");
    expect(NEVER_CAPTURED_PAYMENT_STATUSES_SQL).toBe(
      "'REQUIRES_PAYMENT', 'PROCESSING', 'FAILED', 'CANCELLED'",
    );

    // Le littéral et le tableau ne peuvent pas diverger : l'un est fabriqué à
    // partir de l'autre. C'est tout l'objet de l'exercice.
    const quote = (statuses: readonly PaymentStatus[]) =>
      statuses.map((status) => `'${status}'`).join(', ');
    expect(CAPTURED_PAYMENT_STATUSES_SQL).toBe(quote(CAPTURED_PAYMENT_STATUSES));
    expect(NEVER_CAPTURED_PAYMENT_STATUSES_SQL).toBe(quote(NEVER_CAPTURED_PAYMENT_STATUSES));

    // Aucune valeur ne peut refermer la chaîne : ce sont des constantes du
    // contrat, jamais une entrée utilisateur.
    for (const status of PAYMENT_STATUSES) {
      expect(status).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe('garde d’exhaustivité', () => {
  it('classe les sept statuts de paiement, sans en oublier un', () => {
    // Le typage l'impose déjà ; ce test le rend visible à l'exécution et fixe
    // le nombre de statuts classés.
    expect(PAYMENT_STATUSES).toHaveLength(7);
    for (const status of PAYMENT_STATUSES) {
      expect(PAYMENT_CAPTURE_OBSERVATIONS).toContain(paymentCaptureObservation(status));
    }
  });

  it('refuse de compiler une table à laquelle il manque un statut', () => {
    // C'est `pnpm typecheck` qui exécute cette assertion : `@ts-expect-error`
    // échoue si l'erreur attendue ne se produit PAS. Autrement dit, le jour où
    // `Record<PaymentStatus, …>` cesserait d'exiger les sept lignes, ce test
    // deviendrait rouge — c'est la preuve que la garde est bien en place, et
    // pas seulement que la table est complète aujourd'hui.
    // @ts-expect-error il manque `PROCESSING` : ajouter un statut sans se
    // prononcer sur son encaissement doit casser la compilation, pas répondre
    // en silence.
    const tableIncomplete: Record<PaymentStatus, PaymentCaptureObservation> = {
      REQUIRES_PAYMENT: 'IN_FLIGHT',
      SUCCEEDED: 'CAPTURED',
      FAILED: 'STOPPED',
      CANCELLED: 'STOPPED',
      REFUNDED: 'CAPTURED',
      PARTIALLY_REFUNDED: 'CAPTURED',
    };

    expect(Object.keys(tableIncomplete)).toHaveLength(6);
  });
});
