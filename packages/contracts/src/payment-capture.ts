import { PAYMENT_STATUSES } from './enums.js';
import type { PaymentStatus } from './enums.js';

/**
 * Ce que **notre base** a constaté de l'encaissement d'un paiement.
 *
 * Règle métier, en une phrase : **un encaissement n'existe pour TRIALYA que si
 * notre base l'a constaté ; tant qu'elle ne l'a pas vu, la séance ne compte ni
 * dans le chiffre d'affaires ni dans la commission, quoi que portent les
 * colonnes de la ligne.**
 *
 * Trois observations possibles, parce que trois situations distinctes :
 *
 * | Observation  | Statuts                                        | Ce que notre base sait |
 * | ------------ | ---------------------------------------------- | ---------------------- |
 * | `CAPTURED`   | `SUCCEEDED`, `PARTIALLY_REFUNDED`, `REFUNDED`   | l'argent est entré     |
 * | `IN_FLIGHT`  | `REQUIRES_PAYMENT`, `PROCESSING`                | la tentative est ouverte, l'issue inconnue |
 * | `STOPPED`    | `FAILED`, `CANCELLED`                          | la tentative s'est arrêtée sans encaissement constaté |
 *
 * `REFUNDED` et `PARTIALLY_REFUNDED` sont dans `CAPTURED` sans hésitation : le
 * brut a bien été encaissé, et c'est `refunded_amount` /
 * `refunded_platform_fee_amount` qui portent la part rendue. Les exclure ferait
 * disparaître d'un coup le GMV et la commission d'une séance réellement vendue,
 * au lieu de les faire baisser.
 *
 * ## Ce que ce vocabulaire ne dit pas
 *
 * Il répond « ce que **notre base** a constaté », **jamais** « ce que le
 * fournisseur détient ». Un `payment_intent.succeeded` perdu — webhook jamais
 * reçu, ou abandonné après `MAX_WEBHOOK_ATTEMPTS` — laisse le paiement en
 * `REQUIRES_PAYMENT` alors que Stripe a bien pris l'argent : localement, ce
 * paiement est **indiscernable d'un panier abandonné**. C'est une limite
 * assumée, pas un défaut à corriger ici. Ni `IN_FLIGHT` ni `STOPPED` n'affirment
 * que le fournisseur ne détient rien ; ils disent seulement que nous ne l'avons
 * pas vu. La seule chose qui lève le doute vient de l'extérieur — un
 * remboursement constaté, une réconciliation — et c'est exactement ce que fait
 * `refund-ledger.service.ts`, qui promeut le statut quand un remboursement
 * prouve après coup l'encaissement.
 *
 * Corollaire : `IN_FLIGHT` et `STOPPED` ne se distinguent que par ce que la
 * tentative est devenue **de notre point de vue**, jamais par une certitude sur
 * la caisse du fournisseur. C'est pourquoi les deux prédicats qui gouvernent
 * l'argent (`isCapturedPayment`, `hasNoObservedCapture`) restent binaires : ils
 * ne consultent que la première colonne du tableau.
 *
 * ## Pourquoi cette règle vit ici
 *
 * Elle était écrite trois fois dans `apps/api`, dont deux fois en dur, et les
 * trois copies se trompaient en sens opposés : la liste blanche
 * (`SETTLED_PAYMENT_STATUSES`, agrégats admin) traitait par défaut tout nouveau
 * statut comme non encaissé — elle **masquait** une commission due ; la liste
 * noire (`NEVER_CAPTURED_PAYMENT_STATUSES`, registre de remboursements) le
 * traitait par défaut comme encaissé — elle en **comptait** une qui n'existait
 * pas. Aucune compilation n'aurait prévenu. Le `Record` ci-dessous supprime ce
 * défaut par construction : ajouter un membre à `PAYMENT_STATUSES` sans se
 * prononcer sur son encaissement est une erreur de compilation. Même famille
 * que `editable-fields.ts`, et même leçon que le déclencheur Postgres retiré au
 * commit `3baddf2`, qui recopiait en SQL une liste protégée côté contrats et
 * par rien du tout en base.
 */

export const PAYMENT_CAPTURE_OBSERVATIONS = ['CAPTURED', 'IN_FLIGHT', 'STOPPED'] as const;
export type PaymentCaptureObservation = (typeof PAYMENT_CAPTURE_OBSERVATIONS)[number];

/**
 * La table. `Record<PaymentStatus, …>` : exhaustive **par construction**.
 *
 * Un statut ajouté à `PAYMENT_STATUSES` — `DISPUTED`, `CHARGEBACK`,
 * `REQUIRES_ACTION`, ou ce qu'un futur fournisseur introduira — casse la
 * compilation tant que sa ligne n'est pas écrite ici. C'est le seul endroit du
 * dépôt où répondre à la question, et donc le seul endroit où se tromper.
 */
const PAYMENT_CAPTURE: Record<PaymentStatus, PaymentCaptureObservation> = {
  /**
   * Le statut posé à la création du PaymentIntent, et le piège documenté
   * ci-dessus : c'est là que reste un paiement dont le webhook de succès s'est
   * perdu. `IN_FLIGHT` et non `STOPPED` — il ne dit rien de plus que « nous
   * n'avons pas vu la suite ».
   */
  REQUIRES_PAYMENT: 'IN_FLIGHT',
  /** Jamais écrit par `apps/api` aujourd'hui ; classé si un fournisseur l'introduit. */
  PROCESSING: 'IN_FLIGHT',
  SUCCEEDED: 'CAPTURED',
  /**
   * Un refus de carte constaté. `STOPPED` décrit la tentative, pas la caisse du
   * fournisseur : un client peut réessayer sur la même intention et voir ce
   * second succès se perdre à son tour. D'où `hasNoObservedCapture`, qui range
   * `FAILED` avec `IN_FLIGHT` dès qu'il s'agit d'argent.
   */
  FAILED: 'STOPPED',
  /** Jamais écrit par `apps/api` aujourd'hui non plus — `slots.status` est un autre enum. */
  CANCELLED: 'STOPPED',
  /** Le brut a été encaissé ; `refunded_amount` porte ce qui est reparti. */
  REFUNDED: 'CAPTURED',
  PARTIALLY_REFUNDED: 'CAPTURED',
};

export function paymentCaptureObservation(status: PaymentStatus): PaymentCaptureObservation {
  return PAYMENT_CAPTURE[status];
}

/**
 * « Notre base a-t-elle constaté un encaissement ? »
 *
 * Le seul ensemble où une commission a pu être générée, donc le seul filtre
 * légitime d'un agrégat d'argent (GMV, revenu plateforme, commission nette).
 */
export function isCapturedPayment(status: PaymentStatus): boolean {
  return PAYMENT_CAPTURE[status] === 'CAPTURED';
}

/**
 * Le complément strict de `isCapturedPayment` : aucune preuve d'encaissement
 * dans notre base, que la tentative soit encore ouverte ou arrêtée.
 *
 * Volontairement binaire : pour toute question d'argent, `IN_FLIGHT` et
 * `STOPPED` sont le même cas — nous n'avons rien vu. Un appelant qui aurait
 * besoin de les distinguer passe par `paymentCaptureObservation`.
 */
export function hasNoObservedCapture(status: PaymentStatus): boolean {
  return PAYMENT_CAPTURE[status] !== 'CAPTURED';
}

function statusesWhere(
  predicate: (observation: PaymentCaptureObservation) => boolean,
): readonly PaymentStatus[] {
  return PAYMENT_STATUSES.filter((status) => predicate(PAYMENT_CAPTURE[status]));
}

/** Encaissement constaté. Prêt pour un `inArray(...)`. */
export const CAPTURED_PAYMENT_STATUSES = statusesWhere((observation) => observation === 'CAPTURED');

/**
 * Le complément : tout ce qui n'est pas `CAPTURED`, `IN_FLIGHT` et `STOPPED`
 * confondus. Remplace la liste noire tenue à la main dans
 * `refund-ledger.service.ts` — même sens, mais dérivé de la même table que la
 * liste blanche, donc incapable de diverger d'elle.
 */
export const NEVER_CAPTURED_PAYMENT_STATUSES = statusesWhere(
  (observation) => observation !== 'CAPTURED',
);

/** Tentative encore ouverte, issue inconnue. */
export const IN_FLIGHT_PAYMENT_STATUSES = statusesWhere(
  (observation) => observation === 'IN_FLIGHT',
);

/** Tentative arrêtée sans encaissement constaté. */
export const STOPPED_PAYMENT_STATUSES = statusesWhere((observation) => observation === 'STOPPED');

/**
 * La même liste, prête à entrer dans du SQL brut là où l'agrégat n'est pas
 * construit avec le query builder : `IN (${sql.raw(CAPTURED_PAYMENT_STATUSES_SQL)})`.
 *
 * Sûr par construction, et pas par confiance : les valeurs sont celles de
 * `PAYMENT_STATUSES`, des constantes de compilation qui ne contiennent que des
 * majuscules et des blancs soulignés. Aucune entrée utilisateur ne traverse
 * jamais cette fonction — si un jour c'était le cas, il faudrait un paramètre
 * lié, pas un littéral.
 *
 * À n'utiliser que quand `inArray()` n'est pas disponible : le query builder
 * paramètre, ce littéral non.
 */
function sqlLiteralList(statuses: readonly PaymentStatus[]): string {
  return statuses.map((status) => `'${status}'`).join(', ');
}

export const CAPTURED_PAYMENT_STATUSES_SQL = sqlLiteralList(CAPTURED_PAYMENT_STATUSES);
export const NEVER_CAPTURED_PAYMENT_STATUSES_SQL = sqlLiteralList(NEVER_CAPTURED_PAYMENT_STATUSES);
