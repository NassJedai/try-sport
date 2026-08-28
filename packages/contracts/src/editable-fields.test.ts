import { describe, expect, it } from 'vitest';
import {
  canEditOfferField,
  canEditVenueField,
  EXPERIENCE_TYPE_LABELS_FR,
  FREE_OFFER_FIELDS,
  FREE_VENUE_FIELDS,
  isLockedOfferField,
  isSensitiveOfferField,
  isSensitiveVenueField,
  LOCKED_OFFER_FIELDS,
  MODERATED_OFFER_FIELDS,
  OFFER_FIELD_LABELS_FR,
  OFFER_LOCKED_FIELD_REASON,
  offerEditRefusalMessage,
  offerEditRefusalReason,
  offerFieldClass,
  offerFieldEditDecision,
  offerFieldLabelFr,
  reviewOfferFieldEdits,
  reviewVenueFieldEdits,
  SENSITIVE_OFFER_FIELDS,
  SENSITIVE_VENUE_FIELDS,
  venueEditRefusalReason,
  venueFieldClass,
  venueFieldEditDecision,
  type EditDecision,
  type OfferField,
  type VenueField,
} from './editable-fields.js';
import { EXPERIENCE_TYPES, OFFER_STATUSES, VENUE_STATUSES, type OfferStatus } from './enums.js';
import { updateOfferSchema } from './schemas/offers.js';

describe('classification des champs', () => {
  it('range le contact et l’exploitation courante en libre', () => {
    // Aucun modérateur n'a jamais validé un numéro de téléphone.
    for (const field of ['phone', 'website', 'instagram', 'amenities', 'languages', 'openingHours'] as const) {
      expect(venueFieldClass(field)).toBe('FREE');
      expect(isSensitiveVenueField(field)).toBe(false);
    }
    for (const field of ['capacity', 'skillLevel', 'whatToBring', 'conditions', 'cancellationPolicy'] as const) {
      expect(offerFieldClass(field)).toBe('FREE');
      expect(isSensitiveOfferField(field)).toBe(false);
    }
  });

  it('range le nom, l’adresse et la géolocalisation en identité', () => {
    for (const field of ['name', 'addressLine', 'postalCode', 'cityId', 'districtId', 'latitude', 'longitude', 'timeZone'] as const) {
      expect(venueFieldClass(field)).toBe('IDENTITY');
      expect(isSensitiveVenueField(field)).toBe(true);
    }
  });

  it('range le prix, les catégories et le type d’expérience en modéré', () => {
    // Le cœur de la règle : ce qui est vendu est gelé une fois validé.
    expect(offerFieldClass('priceAmount')).toBe('MODERATED');
    expect(offerFieldClass('referencePriceAmount')).toBe('MODERATED');
    expect(offerFieldClass('experienceType')).toBe('MODERATED');
    expect(offerFieldClass('categoryId')).toBe('MODERATED');
    /**
     * `trialRule` était classé `FREE` jusqu'au 2026-08-26 : ce test décrivait
     * donc la règle inverse, et la règle a changé — ce n'est pas un test
     * affaibli pour faire passer du code. Motif : la règle d'essai décide qui a
     * droit au tarif affiché et combien de fois. Passer une offre en ligne de
     * « un essai par lieu » à « aucune restriction » transforme après coup une
     * séance découverte en réduction permanente, sans qu'aucun modérateur ne
     * voie passer quoi que ce soit. C'est le même abus que remonter le prix,
     * pris par l'autre bout.
     */
    expect(offerFieldClass('trialRule')).toBe('MODERATED');
    expect(isSensitiveOfferField('trialRule')).toBe(true);
    expect(venueFieldClass('categoryIds')).toBe('MODERATED');
    expect(venueFieldClass('description')).toBe('MODERATED');
  });

  it('classe tous les champs modifiables, sans en oublier un', () => {
    // Le typage l'impose déjà (Record<keyof UpdateVenueDto, …>) ; ce test le
    // rend visible à l'exécution et fixe le nombre de champs classés.
    expect([...SENSITIVE_VENUE_FIELDS, ...FREE_VENUE_FIELDS].sort()).toEqual(
      [
        'addressLine',
        'amenities',
        'categoryIds',
        'cityId',
        'description',
        'districtId',
        'instagram',
        'languages',
        'latitude',
        'longitude',
        'name',
        'openingHours',
        'phone',
        'postalCode',
        'timeZone',
        'website',
      ].sort(),
    );
    expect([...SENSITIVE_OFFER_FIELDS, ...FREE_OFFER_FIELDS].sort()).toEqual(
      [
        'amenities',
        'cancellationPolicy',
        'capacity',
        'categoryId',
        'conditions',
        'currency',
        'description',
        'durationMinutes',
        'experienceType',
        'languages',
        'priceAmount',
        'referencePriceAmount',
        'skillLevel',
        'title',
        'trialRule',
        'whatToBring',
      ].sort(),
    );
  });
});

/**
 * La devise ne se change jamais, dans aucun statut.
 *
 * Ce bloc affirmait `currency → MODERATED` jusqu'au 2026-08-28, ce qui revenait
 * à dire `NOTIFY_ADMIN` sur une offre en ligne depuis le desserrage du même
 * jour. C'était faux : `OnboardingService.updateOffer` refusait — et refuse
 * toujours — la devise en toutes circonstances, et la table promettait donc au
 * tableau de bord une modification que le serveur rejette. Ces assertions
 * décrivaient un état intermédiaire du lot, pas une règle.
 *
 * La règle, en une phrase : **changer la devise sans retoucher les montants
 * reprice l'offre en silence, donc la devise d'une offre créée ne se modifie
 * plus — la seule issue est une nouvelle offre.**
 */
describe('la devise d’une offre est verrouillée', () => {
  it('est classée à part, ni libre ni modérée', () => {
    expect(offerFieldClass('currency')).toBe('LOCKED');
    expect(isLockedOfferField('currency')).toBe(true);
    // Verrouillée reste sensible : ce n'est pas de l'exploitation courante.
    expect(isSensitiveOfferField('currency')).toBe(true);
    expect([...LOCKED_OFFER_FIELDS]).toEqual(['currency']);
    expect([...MODERATED_OFFER_FIELDS]).not.toContain('currency');
    for (const field of MODERATED_OFFER_FIELDS) {
      expect(isLockedOfferField(field)).toBe(false);
    }
  });

  it('est refusée dans les six statuts, brouillon compris', () => {
    // Exhaustif par construction : un septième statut d'offre passerait ici
    // sans qu'on ait à y penser, puisque `LOCKED` n'a pas de ligne dans
    // `OFFER_EDIT_POLICY`.
    for (const status of OFFER_STATUSES) {
      expect(offerFieldEditDecision(status, 'currency')).toBe('FORBIDDEN');
      expect(canEditOfferField(status, 'currency')).toBe(false);
    }
  });

  it('tombe dans les refusés d’un verdict, jamais dans les notifiés', () => {
    // Ce que le service lit pour décider d'écrire : la devise ne doit jamais
    // atteindre l'UPDATE, ni partir en alerte admin comme un abus rattrapable.
    for (const status of OFFER_STATUSES) {
      const verdict = reviewOfferFieldEdits(status, ['currency', 'capacity']);
      expect(verdict.forbidden).toContain('currency');
      expect(verdict.notifyAdmin).not.toContain('currency');
      expect(verdict.allowed).not.toContain('currency');
    }
    // Sur une offre en ligne, elle est même le seul refus d'un tel PATCH : la
    // capacité passe, la devise non, et rien ne part en alerte.
    expect(reviewOfferFieldEdits('ACTIVE', ['currency', 'capacity'])).toEqual({
      allowed: ['capacity'],
      notifyAdmin: [],
      forbidden: ['currency'],
    });
  });

  it('explique son refus par le champ, pas par le statut', () => {
    // Sur un brouillon, la phrase du statut est nulle — le refus serait muet
    // sans la phrase du champ verrouillé.
    expect(offerEditRefusalReason('DRAFT')).toBeNull();
    expect(offerEditRefusalMessage('DRAFT', ['currency'])).toBe(OFFER_LOCKED_FIELD_REASON);
    // Et elle prime sur la phrase du statut partout ailleurs : « cette offre
    // est en cours d'examen » serait faux, la devise ne rouvrira pas après.
    for (const status of OFFER_STATUSES) {
      expect(offerEditRefusalMessage(status, ['currency'])).toBe(OFFER_LOCKED_FIELD_REASON);
    }
    // Sans champ verrouillé dans le verdict, on retombe sur le statut.
    expect(offerEditRefusalMessage('PENDING_APPROVAL', ['priceAmount'])).toBe(
      offerEditRefusalReason('PENDING_APPROVAL'),
    );
    expect(offerEditRefusalMessage('DRAFT', [])).toBeNull();
  });
});

describe('un lieu refusé peut être corrigé', () => {
  it('ouvre tous ses champs, sensibles compris', () => {
    // L'impasse que ce chantier existe pour lever : sans cela, le gérant n'a
    // d'autre issue que de recréer son lieu, doublon compris.
    for (const field of [...SENSITIVE_VENUE_FIELDS, ...FREE_VENUE_FIELDS]) {
      expect(venueFieldEditDecision('REJECTED', field)).toBe('ALLOWED');
    }
    // Tout sauf le verrouillé : un refus de modération n'a jamais porté sur la
    // devise, et la corriger repricerait l'offre au lieu de la corriger.
    for (const field of [...MODERATED_OFFER_FIELDS, ...FREE_OFFER_FIELDS]) {
      expect(offerFieldEditDecision('REJECTED', field)).toBe('ALLOWED');
    }
  });

  it('ouvre tout autant en brouillon', () => {
    for (const field of [...SENSITIVE_VENUE_FIELDS, ...FREE_VENUE_FIELDS]) {
      expect(venueFieldEditDecision('DRAFT', field)).toBe('ALLOWED');
    }
  });
});

describe('un dossier en cours d’examen ne bouge pas', () => {
  it('gèle le fond et laisse le contact ouvert', () => {
    expect(venueFieldEditDecision('PENDING_APPROVAL', 'name')).toBe('FORBIDDEN');
    expect(venueFieldEditDecision('PENDING_APPROVAL', 'addressLine')).toBe('FORBIDDEN');
    expect(venueFieldEditDecision('PENDING_APPROVAL', 'description')).toBe('FORBIDDEN');
    expect(venueFieldEditDecision('PENDING_APPROVAL', 'phone')).toBe('ALLOWED');
    expect(offerFieldEditDecision('PENDING_APPROVAL', 'priceAmount')).toBe('FORBIDDEN');
    expect(offerFieldEditDecision('PENDING_APPROVAL', 'capacity')).toBe('ALLOWED');
  });
});

describe('une salle en ligne', () => {
  it('change de nom et d’adresse librement, mais prévient l’admin', () => {
    for (const status of ['ACTIVE', 'PAUSED'] as const) {
      for (const field of ['name', 'addressLine', 'postalCode', 'cityId', 'districtId', 'latitude', 'longitude', 'timeZone'] as const) {
        expect(venueFieldEditDecision(status, field)).toBe('NOTIFY_ADMIN');
        // NOTIFY_ADMIN est un oui : l'écriture passe.
        expect(canEditVenueField(status, field)).toBe(true);
      }
    }
  });

  it('ne se recatégorise pas', () => {
    expect(venueFieldEditDecision('ACTIVE', 'categoryIds')).toBe('FORBIDDEN');
  });

  it('garde ses horaires et son téléphone sous son seul contrôle', () => {
    expect(venueFieldEditDecision('ACTIVE', 'openingHours')).toBe('ALLOWED');
    expect(venueFieldEditDecision('ACTIVE', 'phone')).toBe('ALLOWED');
  });
});

/**
 * Ce bloc affirmait la règle INVERSE jusqu'au 2026-08-28 : les champs modérés
 * d'une offre `ACTIVE`/`PAUSED` étaient `FORBIDDEN`, prix compris. La règle a
 * changé — décision du fondateur, pas un test assoupli pour faire passer du
 * code.
 *
 * Motif : le gel était la dernière impasse du parcours gérant (aucune
 * correction possible sans le support), et il n'était pas ce qui protège
 * l'argent — c'est `reservations.priceAmount`, instantané copié au moment de la
 * réservation, qui empêche une modification de prix de réécrire un montant déjà
 * engagé. L'abus (republier à 45 € une séance validée à 5 €) devient visible au
 * lieu d'être impossible, et la plateforme suspend.
 */
describe('une offre en ligne', () => {
  it('corrige son prix, mais l’admin est prévenu à chaque fois', () => {
    for (const status of ['ACTIVE', 'PAUSED'] as const) {
      for (const field of ['priceAmount', 'referencePriceAmount'] as const) {
        expect(offerFieldEditDecision(status, field)).toBe('NOTIFY_ADMIN');
      }
      // NOTIFY_ADMIN est un oui : l'écriture passe, et l'alerte part après.
      expect(canEditOfferField(status, 'priceAmount')).toBe(true);
      // La devise, elle, ne suit pas ses deux voisines : voir le bloc
      // « la devise d'une offre est verrouillée » plus haut.
      expect(offerFieldEditDecision(status, 'currency')).toBe('FORBIDDEN');
    }
  });

  it('corrige aussi son titre, sa description, sa catégorie, son type et sa durée', () => {
    for (const status of ['ACTIVE', 'PAUSED'] as const) {
      for (const field of [
        'title',
        'description',
        'categoryId',
        'experienceType',
        'durationMinutes',
      ] as const) {
        expect(offerFieldEditDecision(status, field)).toBe('NOTIFY_ADMIN');
      }
    }
  });

  it('ne desserre pas son allocation d’essai en silence', () => {
    // `trialRule` suit ses camarades modérés : desserrer l'allocation d'une
    // offre en ligne transforme après coup une séance découverte en réduction
    // permanente. Ce n'est plus interdit, ce n'est jamais silencieux.
    for (const status of ['ACTIVE', 'PAUSED'] as const) {
      expect(offerFieldEditDecision(status, 'trialRule')).toBe('NOTIFY_ADMIN');
      expect(canEditOfferField(status, 'trialRule')).toBe(true);
    }
    // Sous les yeux du modérateur, en revanche, rien ne bouge.
    expect(offerFieldEditDecision('PENDING_APPROVAL', 'trialRule')).toBe('FORBIDDEN');
    expect(canEditOfferField('PENDING_APPROVAL', 'trialRule')).toBe(false);
    // Et elle reste librement corrigeable là où le dossier n'est pas figé.
    expect(offerFieldEditDecision('DRAFT', 'trialRule')).toBe('ALLOWED');
    expect(offerFieldEditDecision('REJECTED', 'trialRule')).toBe('ALLOWED');
  });

  it('garde son exploitation courante sous le seul contrôle du gérant', () => {
    // Un champ libre reste `ALLOWED` : le desserrage ne doit pas noyer l'admin
    // sous les changements de capacité.
    for (const status of ['ACTIVE', 'PAUSED'] as const) {
      for (const field of FREE_OFFER_FIELDS) {
        expect(offerFieldEditDecision(status, field)).toBe('ALLOWED');
      }
    }
  });
});

describe('une suspension ne se contourne pas en éditant', () => {
  it('gèle absolument tout, y compris le téléphone', () => {
    for (const field of [...SENSITIVE_VENUE_FIELDS, ...FREE_VENUE_FIELDS]) {
      expect(venueFieldEditDecision('SUSPENDED', field)).toBe('FORBIDDEN');
      expect(venueFieldEditDecision('ARCHIVED', field)).toBe('FORBIDDEN');
      expect(canEditVenueField('SUSPENDED', field)).toBe(false);
    }
    for (const field of [...SENSITIVE_OFFER_FIELDS, ...FREE_OFFER_FIELDS]) {
      expect(offerFieldEditDecision('ARCHIVED', field)).toBe('FORBIDDEN');
    }
  });
});

describe('verdict sur une demande entière', () => {
  it('sépare ce qui passe, ce qui notifie et ce qui est refusé', () => {
    const verdict = reviewVenueFieldEdits('ACTIVE', ['phone', 'name', 'categoryIds']);
    expect(verdict).toEqual({
      allowed: ['phone'],
      notifyAdmin: ['name'],
      forbidden: ['categoryIds'],
    });
  });

  it('refuse une clé inconnue plutôt que de l’ignorer', () => {
    // Le refus est le défaut. Une clé que la classification ne connaît pas ne
    // doit pas passer par une porte ouverte.
    const verdict = reviewVenueFieldEdits('DRAFT', ['name', 'commissionBasisPoints']);
    expect(verdict.forbidden).toEqual(['commissionBasisPoints']);
    expect(verdict.allowed).toEqual(['name']);
  });

  it('ne refuse rien sur un lieu refusé, quelle que soit la demande', () => {
    const verdict = reviewVenueFieldEdits('REJECTED', [
      'name',
      'addressLine',
      'categoryIds',
      'description',
      'phone',
    ]);
    expect(verdict.forbidden).toEqual([]);
    expect(verdict.notifyAdmin).toEqual([]);
    expect(verdict.allowed).toHaveLength(5);
  });

  it('accepte une demande vide sans rien décider', () => {
    expect(reviewVenueFieldEdits('SUSPENDED', [])).toEqual({
      allowed: [],
      notifyAdmin: [],
      forbidden: [],
    });
  });

  it('tient sur une offre', () => {
    // Le prix d'une offre en ligne n'est plus refusé depuis le 2026-08-28 : il
    // passe, et il alerte. C'est ce verdict exact que le service lit pour
    // décider d'écrire puis de notifier.
    const verdict = reviewOfferFieldEdits('ACTIVE', ['capacity', 'priceAmount']);
    expect(verdict.allowed).toEqual(['capacity']);
    expect(verdict.notifyAdmin).toEqual(['priceAmount']);
    expect(verdict.forbidden).toEqual([]);
  });

  it('refuse une clé inconnue sur une offre, dans tous les statuts', () => {
    // Le seul refus que le *statut* produise encore sur ACTIVE/PAUSED, et la
    // raison pour laquelle `offerEditRefusalReason` n'y est pas nulle. Il n'est
    // pas atteignable par un client réel : `updateOfferSchema` est un objet Zod
    // et retire les clés inconnues à la frontière HTTP (assertion ci-dessous).
    // Ce que ce test décrit est donc une défense en profondeur — le refus reste
    // le défaut si un appelant contourne un jour le schéma.
    for (const status of OFFER_STATUSES) {
      expect(reviewOfferFieldEdits(status, ['commissionBasisPoints']).forbidden).toEqual([
        'commissionBasisPoints',
      ]);
    }

    // La raison exacte pour laquelle le cas ci-dessus n'arrive pas par HTTP,
    // vérifiée plutôt qu'affirmée en commentaire : le jour où ce schéma
    // laisserait passer les clés inconnues, ce test tombe et les commentaires
    // de `OFFER_REFUSAL_REASON` redeviennent faux dans l'autre sens.
    expect(updateOfferSchema.parse({ commissionBasisPoints: 2500, capacity: 12 })).toEqual({
      capacity: 12,
    });
  });
});

describe('cohérence de la table', () => {
  it('donne une décision pour chaque couple statut × champ', () => {
    for (const status of VENUE_STATUSES) {
      for (const field of [...SENSITIVE_VENUE_FIELDS, ...FREE_VENUE_FIELDS] as VenueField[]) {
        expect(['ALLOWED', 'NOTIFY_ADMIN', 'FORBIDDEN']).toContain(
          venueFieldEditDecision(status, field),
        );
      }
    }
    for (const status of OFFER_STATUSES) {
      for (const field of [...SENSITIVE_OFFER_FIELDS, ...FREE_OFFER_FIELDS] as OfferField[]) {
        expect(['ALLOWED', 'NOTIFY_ADMIN', 'FORBIDDEN']).toContain(
          offerFieldEditDecision(status, field),
        );
      }
    }
  });

  it('explique tout refus, et n’explique rien quand il n’y a rien à refuser', () => {
    for (const status of VENUE_STATUSES) {
      const refuses = [...SENSITIVE_VENUE_FIELDS, ...FREE_VENUE_FIELDS].some(
        (field) => venueFieldEditDecision(status, field) === 'FORBIDDEN',
      );
      expect(venueEditRefusalReason(status) === null).toBe(!refuses);
    }
  });

  it('explique tout refus sur une offre, y compris celui d’une clé inconnue', () => {
    /**
     * La forme « une phrase si et seulement si un champ est refusé » ne tient
     * plus côté offre : `ACTIVE`/`PAUSED` ne refusent plus aucun champ modéré,
     * et les six statuts refusent la devise. L'équivalence est donc remplacée
     * par une table déclarée statut par statut — même forme que
     * `decisionAttendue` ci-dessous, et même garantie : un septième statut
     * d'offre ne compile pas tant que personne n'a dit s'il doit une phrase au
     * gérant.
     *
     * Ce que la table déclare : une phrase dès qu'un *statut* ferme quelque
     * chose au gérant (examen en cours, offre archivée), plus `ACTIVE`/`PAUSED`
     * où la phrase n'est qu'un **dernier recours**. Le seul refus que le statut
     * y produise encore vise une clé inconnue, et `updateOfferSchema` — objet
     * Zod, qui retire les clés inconnues — rend ce cas inatteignable par un
     * client réel. La phrase est exigée ici parce qu'un refus sans phrase est un
     * `CONFLICT` muet, jamais parce qu'un gérant la lira.
     *
     * `DRAFT` et `REJECTED` n'en doivent aucune — ils n'interdisent rien au
     * gérant — et le refus de la devise qui les traverse quand même est
     * expliqué par `offerEditRefusalMessage`, vérifié plus haut.
     */
    const phraseAttendue: Record<OfferStatus, boolean> = {
      DRAFT: false,
      REJECTED: false,
      PENDING_APPROVAL: true,
      ACTIVE: true,
      PAUSED: true,
      ARCHIVED: true,
    };

    for (const status of OFFER_STATUSES) {
      expect(offerEditRefusalReason(status) !== null).toBe(phraseAttendue[status]);

      // Et l'invariante de fond, jamais codée en dur : quel que soit le statut,
      // un refus atteignable par `reviewOfferFieldEdits` a une phrase. Un
      // CONFLICT muet est ce que ce fichier a toujours interdit.
      const refuses = [...SENSITIVE_OFFER_FIELDS, ...FREE_OFFER_FIELDS, 'commissionBasisPoints'];
      const verdict = reviewOfferFieldEdits(status, refuses);
      expect(verdict.forbidden.length).toBeGreaterThan(0);
      expect(offerEditRefusalMessage(status, verdict.forbidden)).not.toBeNull();
    }
  });

  it('traite tous les champs modérés d’une offre de la même façon, statut par statut', () => {
    /**
     * Ce test disait « aucun champ modéré n'est modifiable sur une offre
     * publiée ». Il est tombé le 2026-08-28 en faisant exactement le travail
     * que son commentaire annonçait : la règle a changé sous lui
     * (`ACTIVE`/`PAUSED` passent à `NOTIFY_ADMIN`), le code n'a pas dérivé.
     *
     * Réécrit dans la même forme — une invariante sur TOUS les champs modérés,
     * jamais un cas par champ — et durci : il fixe désormais la décision
     * attendue pour les six statuts. La table `Record<OfferStatus, …>` est
     * exhaustive par construction, donc un nouveau statut d'offre ne peut pas
     * échapper à cette affirmation, et le prochain desserrage silencieux tombe
     * ici quel que soit le statut qu'il touche.
     *
     * Il parcourt `MODERATED_OFFER_FIELDS` et non `SENSITIVE_OFFER_FIELDS`
     * depuis le 2026-08-28 : la devise est sensible sans être modérée, et son
     * sort — `FORBIDDEN` partout — est affirmé par le bloc « la devise d'une
     * offre est verrouillée ».
     */
    const decisionAttendue: Record<OfferStatus, EditDecision> = {
      DRAFT: 'ALLOWED',
      REJECTED: 'ALLOWED',
      PENDING_APPROVAL: 'FORBIDDEN',
      ACTIVE: 'NOTIFY_ADMIN',
      PAUSED: 'NOTIFY_ADMIN',
      ARCHIVED: 'FORBIDDEN',
    };
    for (const field of MODERATED_OFFER_FIELDS) {
      for (const status of OFFER_STATUSES) {
        expect(offerFieldEditDecision(status, field)).toBe(decisionAttendue[status]);
      }
    }
  });

  it('ne notifie l’admin que sur une offre en ligne', () => {
    // Jumeau du test de lieu ci-dessous, et deuxième déclencheur de la nouvelle
    // règle : une notification qui partirait de PENDING_APPROVAL voudrait dire
    // qu'un dossier bouge sous le modérateur ; une qui ne partirait plus
    // d'ACTIVE voudrait dire qu'un gérant réécrit son catalogue en ligne sans
    // que personne l'apprenne.
    for (const status of OFFER_STATUSES) {
      const notifie = [...SENSITIVE_OFFER_FIELDS, ...FREE_OFFER_FIELDS].some(
        (field) => offerFieldEditDecision(status, field) === 'NOTIFY_ADMIN',
      );
      expect(notifie).toBe(status === 'ACTIVE' || status === 'PAUSED');
    }
  });

  it('n’alerte jamais l’admin sur l’exploitation courante d’une offre', () => {
    // Le garde-fou du desserrage : si un champ libre se mettait à notifier,
    // l'admin recevrait une alerte à chaque changement de capacité et
    // cesserait de les lire. C'est ainsi qu'une alerte utile meurt.
    for (const status of OFFER_STATUSES) {
      for (const field of FREE_OFFER_FIELDS) {
        expect(offerFieldEditDecision(status, field)).not.toBe('NOTIFY_ADMIN');
      }
    }
  });

  it('ne notifie l’admin que sur une salle en ligne', () => {
    for (const status of VENUE_STATUSES) {
      const notifies = [...SENSITIVE_VENUE_FIELDS, ...FREE_VENUE_FIELDS].some(
        (field) => venueFieldEditDecision(status, field) === 'NOTIFY_ADMIN',
      );
      expect(notifies).toBe(status === 'ACTIVE' || status === 'PAUSED');
    }
  });
});

/**
 * Les libellés partagés existent parce qu'ils étaient écrits deux fois : dans
 * l'alerte admin (`moderation-lifecycle.listener.ts`) et dans le bandeau de
 * l'écran d'édition d'offre du tableau de bord, qui énumérait les champs
 * modifiables en prose. Deux listes qui disent la même chose finissent par ne
 * plus la dire pareil — celle du bandeau ne mentionnait déjà pas la devise.
 */
describe('libellés FR des champs d’offre', () => {
  it('nomme chaque champ modifiable, sans en oublier un', () => {
    // `Record<OfferField, string>` l'impose déjà à la compilation ; ce test le
    // rend visible à l'exécution et interdit le nom technique comme libellé.
    for (const field of [...SENSITIVE_OFFER_FIELDS, ...FREE_OFFER_FIELDS] as OfferField[]) {
      expect(OFFER_FIELD_LABELS_FR[field].trim().length).toBeGreaterThan(0);
      expect(OFFER_FIELD_LABELS_FR[field]).not.toBe(field);
    }
  });

  it('garde mot pour mot les libellés que l’alerte admin envoie déjà', () => {
    // Ces chaînes sont assertées telles quelles par
    // `apps/api/test/moderation-lifecycle.integration.test.ts` : partager la
    // table ne doit rien changer à ce que l'admin reçoit.
    expect(OFFER_FIELD_LABELS_FR.priceAmount).toBe('Prix de la séance découverte');
    expect(OFFER_FIELD_LABELS_FR.referencePriceAmount).toBe('Prix habituel (prix barré)');
    expect(OFFER_FIELD_LABELS_FR.trialRule).toBe('Règle d’essai');
    expect(OFFER_FIELD_LABELS_FR.experienceType).toBe('Type d’expérience');
    expect(OFFER_FIELD_LABELS_FR.durationMinutes).toBe('Durée de la séance');
  });

  it('retombe sur le nom technique plutôt que sur rien pour une clé inconnue', () => {
    // Le listener reçoit des `field` typés `string` (payload d'événement) :
    // une clé inconnue doit rester lisible, pas produire « undefined ».
    expect(offerFieldLabelFr('priceAmount')).toBe('Prix de la séance découverte');
    expect(offerFieldLabelFr('commissionBasisPoints')).toBe('commissionBasisPoints');
  });
});

/**
 * Même motif que les libellés de champs, un cran plus bas : le champ
 * `experienceType` avait un nom français partagé, mais ses sept *valeurs*
 * n'en avaient pas. L'alerte admin affichait donc « Type d'expérience :
 * « FREE_TRIAL » → « DISCOVERY_PRICE » », alors que le gérant venait de
 * cliquer sur « Essai gratuit » puis « Prix découverte ».
 */
describe('libellés FR des types d’expérience', () => {
  it('nomme les sept types, sans laisser passer un nom technique', () => {
    // `Record<ExperienceType, string>` l'impose à la compilation ; cette boucle
    // le rend visible à l'exécution et interdit « FREE_TRIAL » comme libellé.
    for (const experienceType of EXPERIENCE_TYPES) {
      expect(EXPERIENCE_TYPE_LABELS_FR[experienceType].trim().length).toBeGreaterThan(0);
      expect(EXPERIENCE_TYPE_LABELS_FR[experienceType]).not.toBe(experienceType);
    }
    expect(Object.keys(EXPERIENCE_TYPE_LABELS_FR)).toHaveLength(EXPERIENCE_TYPES.length);
  });

  it('reprend mot pour mot le vocabulaire déjà affiché au gérant', () => {
    // Ces sept chaînes sont celles de `EXPERIENCE_TYPE_OPTIONS`
    // (`apps/business/src/lib/onboarding/constants.ts`) : partager la table ne
    // doit rien changer à ce que le gérant a lu avant de choisir.
    expect(EXPERIENCE_TYPE_LABELS_FR.FREE_TRIAL).toBe('Essai gratuit');
    expect(EXPERIENCE_TYPE_LABELS_FR.DISCOVERY_PRICE).toBe('Prix découverte');
    expect(EXPERIENCE_TYPE_LABELS_FR.DISCOVERY_PACK).toBe('Pack découverte');
    expect(EXPERIENCE_TYPE_LABELS_FR.INITIATION).toBe('Séance d’initiation');
    expect(EXPERIENCE_TYPE_LABELS_FR.DAY_PASS).toBe('Pass journée');
    expect(EXPERIENCE_TYPE_LABELS_FR.BEGINNER_CLASS).toBe('Cours débutant');
    expect(EXPERIENCE_TYPE_LABELS_FR.PREMIUM_EXPERIENCE).toBe('Expérience premium');
  });
});
