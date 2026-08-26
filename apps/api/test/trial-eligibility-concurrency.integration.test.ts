import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Transaction } from '@try/database';
import { acquireTrialEligibilityLock } from '@try/database';
import { SystemClock } from '@try/utils';
import type { AppConfig } from '@try/config';
import { TRIAL_CONSUMING_STATUSES } from '@try/contracts';
import { BookingService, isUniqueViolation } from '../src/modules/bookings/booking.service.js';
import { CryptoService } from '../src/common/crypto.service.js';
import { DomainEvents } from '../src/modules/events/domain-events.js';
import type { PaymentService } from '../src/modules/payments/payment.service.js';
import {
  connect,
  createTestUser,
  describeIfDatabase,
  expectConstraint,
  seedBookableSlot,
} from './integration-setup.js';

/**
 * PREUVE RETRAVAILLÉE le 2026-08-26 après relecture contradictoire.
 *
 * La première version de ce fichier lançait `Promise.allSettled([service.
 * create(...), service.create(...)])` et espérait que deux vrais appels
 * réseau à `BookingService.create()` se chevauchent naturellement. Mesuré par
 * le relecteur : sur le code AVANT correctif (verrou par lieu), ce test
 * passait 5 fois sur 5 — pour la MAUVAISE raison. Les deux transactions ne se
 * chevauchaient jamais réellement : la première validait avant que la
 * seconde ne lise, et la seconde échouait via la vérification d'éligibilité
 * ORDINAIRE (séquentielle), pas via une course gagnée. Un test qui passe
 * avant et après le correctif ne prouve rien — exactement le piège déjà
 * documenté pour `domain-events-after-commit.integration.test.ts`
 * (`feedback_domain_event_race_test_needs_forced_hold`), qui s'applique ici
 * de façon encore plus flagrante (0/5, pas 4/5).
 *
 * Cette version FORCE le chevauchement au lieu de l'espérer, sur le modèle
 * du test à deux transactions manuellement orchestrées de
 * `feedback_fk_insert_implicit_lock_ordering` — pas sur celui de
 * `booking-concurrency.integration.test.ts` (`attemptClaim`), qui n'a rien à
 * forcer : un `UPDATE` conditionnel unique est intrinsèquement sérialisé par
 * le verrou de ligne Postgres, quel que soit l'entrelacement. Ici, la faille
 * est un « lire puis écrire » réparti sur plusieurs instructions — il n'y a
 * aucune atomicité à réutiliser, il faut construire l'entrelacement à la
 * main.
 *
 * Quatre scénarios isolent chaque mécanisme séparément, tous déterministes
 * (aucun ne dépend d'une course accidentelle) :
 *
 *   1. Verrou par LIEU + filet en base RETIRÉ → la course forcée fait passer
 *      les deux consommations. C'est le bug reproduit, à la demande.
 *   2. Verrou par ÉTABLISSEMENT + filet RETIRÉ → une seule consommation
 *      passe. Prouve que c'est le VERROU seul qui fait le travail, pas le
 *      filet.
 *   3. Filet seul, sans verrou ni concurrence → le deuxième INSERT direct
 *      est rejeté par l'index unique partiel.
 *   4. Tout restauré (verrou établissement + filet présent) → la course
 *      forcée reste neutralisée, comme en (2) — le filet n'est même pas
 *      sollicité, il agit en profondeur, pas en remplacement.
 *
 * Le filet est retiré/restauré avec `DROP INDEX` / `CREATE UNIQUE INDEX`
 * bruts, sûr uniquement parce que `vitest.integration.config.mts` fixe
 * `fileParallelism: false` — un seul fichier de test s'exécute à la fois
 * dans toute la suite, donc aucun autre test ne peut s'exécuter pendant que
 * l'index est temporairement absent.
 *
 * Un cinquième test, séquentiel (pas concurrent), exerce le vrai
 * `BookingService.create()` de bout en bout : utile comme test de
 * régression du chemin normal, mais il ne prouve PAS la garantie de
 * concurrence — seuls les scénarios 1-4 le font.
 */
describeIfDatabase('essai concurrence — portée établissement', () => {
  let ctx: ReturnType<typeof connect>;
  let slotA: Awaited<ReturnType<typeof seedBookableSlot>>;
  let slotB: Awaited<ReturnType<typeof seedBookableSlot>>;

  const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child(): typeof silentLogger {
      return silentLogger;
    },
  };

  beforeAll(async () => {
    ctx = connect();
    slotA = await seedBookableSlot(ctx.db, {
      capacity: 5,
      priceAmount: 0,
      trialRule: 'ONE_TRIAL_PER_BUSINESS',
    });
    slotB = await seedBookableSlot(ctx.db, {
      capacity: 5,
      priceAmount: 0,
      trialRule: 'ONE_TRIAL_PER_BUSINESS',
      existingBusiness: { businessId: slotA.businessId, cityId: slotA.cityId },
    });
    // Deux lieux, un seul établissement — la forme exacte du bug.
    expect(slotB.businessId).toBe(slotA.businessId);
    expect(slotB.venueId).not.toBe(slotA.venueId);
  });

  afterAll(async () => {
    await slotB.cleanup();
    await slotA.cleanup();
    await ctx.close();
  });

  // --- Mécanique de bas niveau : verrou et filet, isolés l'un de l'autre ---

  const BUSINESS_SCOPE_INDEX_NAME = 'trial_history_business_scope_key';
  const BUSINESS_SCOPE_INDEX_DDL = `
    CREATE UNIQUE INDEX IF NOT EXISTS "${BUSINESS_SCOPE_INDEX_NAME}"
      ON "trial_history" USING btree ("user_id", "business_id")
      WHERE trial_rule = 'ONE_TRIAL_PER_BUSINESS'
        AND status IN ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW')
  `;

  async function withoutBusinessScopeBackstop<T>(fn: () => Promise<T>): Promise<T> {
    await ctx.db.execute(sql.raw(`DROP INDEX IF EXISTS "${BUSINESS_SCOPE_INDEX_NAME}"`));
    try {
      return await fn();
    } finally {
      // IF NOT EXISTS : robuste si un run précédent a planté avant de restaurer.
      await ctx.db.execute(sql.raw(BUSINESS_SCOPE_INDEX_DDL));
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  type ReservationRef = { id: string; businessId: string; venueId: string; offerId: string };
  type AttemptOutcome = 'INSERTED' | 'REJECTED_ELIGIBILITY' | 'REJECTED_DB_BACKSTOP';

  /** Le même filtre que `assertTrialEligible` : uniquement (user, business, statut consommateur). */
  async function readConsuming(tx: Transaction, userId: string, businessId: string) {
    return tx
      .select({ id: schema.trialHistory.id })
      .from(schema.trialHistory)
      .where(
        and(
          eq(schema.trialHistory.userId, userId),
          eq(schema.trialHistory.businessId, businessId),
          inArray(schema.trialHistory.status, [...TRIAL_CONSUMING_STATUSES]),
        ),
      );
  }

  async function insertOrBackstop(
    tx: Transaction,
    userId: string,
    reservation: ReservationRef,
  ): Promise<AttemptOutcome> {
    try {
      await tx.insert(schema.trialHistory).values({
        userId,
        businessId: reservation.businessId,
        venueId: reservation.venueId,
        offerId: reservation.offerId,
        reservationId: reservation.id,
        reservedAt: new Date(),
        status: 'CONFIRMED',
        trialRule: 'ONE_TRIAL_PER_BUSINESS',
      });
      return 'INSERTED';
    } catch (error) {
      if (isUniqueViolation(error, BUSINESS_SCOPE_INDEX_NAME)) return 'REJECTED_DB_BACKSTOP';
      throw error;
    }
  }

  /**
   * Ouvre en premier : lit, PUIS signale à l'autre partie qu'elle peut lire à
   * son tour, PUIS reste délibérément « en vol » (ni commit ni rollback)
   * pendant `OVERLAP_WINDOW_MS` avant d'écrire — la fenêtre pendant laquelle
   * l'autre lecture, si elle n'est bloquée par aucun verrou partagé, voit
   * encore un historique vide.
   */
  const OVERLAP_WINDOW_MS = 200;
  async function attemptOpensFirst(params: {
    lockKey: string;
    userId: string;
    reservation: ReservationRef;
    signalReady: () => void;
  }): Promise<AttemptOutcome> {
    return ctx.db.transaction(async (tx) => {
      await acquireTrialEligibilityLock(tx, params.userId, params.lockKey);
      const existing = await readConsuming(tx, params.userId, params.reservation.businessId);
      params.signalReady();
      await sleep(OVERLAP_WINDOW_MS);
      if (existing.length > 0) return 'REJECTED_ELIGIBILITY';
      return insertOrBackstop(tx, params.userId, params.reservation);
    });
  }

  /** Attend le signal de la première avant de lire — jamais avant, pour ne pas lire trop tôt par chance. */
  async function attemptWaitsThenReads(params: {
    lockKey: string;
    userId: string;
    reservation: ReservationRef;
    waitFor: Promise<void>;
  }): Promise<AttemptOutcome> {
    return ctx.db.transaction(async (tx) => {
      await acquireTrialEligibilityLock(tx, params.userId, params.lockKey);
      await params.waitFor;
      const existing = await readConsuming(tx, params.userId, params.reservation.businessId);
      if (existing.length > 0) return 'REJECTED_ELIGIBILITY';
      return insertOrBackstop(tx, params.userId, params.reservation);
    });
  }

  /**
   * Aucun signal artificiel : utilisée uniquement quand les deux appels
   * partagent la MÊME clé de verrou. Postgres sérialise alors intégralement
   * les deux transactions lui-même (la seconde bloque sur
   * `pg_advisory_xact_lock` jusqu'au commit de la première) — c'est le
   * mécanisme réel, pas une simulation, et il n'y a aucun risque
   * d'interblocage puisque aucune des deux parties n'attend l'autre pour
   * autre chose que ce verrou.
   */
  async function attemptPlain(params: {
    lockKey: string;
    userId: string;
    reservation: ReservationRef;
  }): Promise<AttemptOutcome> {
    return ctx.db.transaction(async (tx) => {
      await acquireTrialEligibilityLock(tx, params.userId, params.lockKey);
      const existing = await readConsuming(tx, params.userId, params.reservation.businessId);
      if (existing.length > 0) return 'REJECTED_ELIGIBILITY';
      return insertOrBackstop(tx, params.userId, params.reservation);
    });
  }

  async function seedReservationPair(userId: string): Promise<{
    resA: ReservationRef;
    resB: ReservationRef;
    cleanup: () => Promise<void>;
  }> {
    const values = (slot: typeof slotA) => ({
      userId,
      slotId: slot.slotId,
      offerId: slot.offerId,
      venueId: slot.venueId,
      businessId: slot.businessId,
      status: 'CONFIRMED' as const,
      priceAmount: 0,
      trialRule: 'ONE_TRIAL_PER_BUSINESS' as const,
      slotStartAt: new Date(Date.now() + 7 * 86_400_000),
      slotEndAt: new Date(Date.now() + 7 * 86_400_000 + 3_600_000),
    });

    const [rowA] = await ctx.db
      .insert(schema.reservations)
      .values(values(slotA))
      .returning({ id: schema.reservations.id, businessId: schema.reservations.businessId });
    const [rowB] = await ctx.db
      .insert(schema.reservations)
      .values(values(slotB))
      .returning({ id: schema.reservations.id, businessId: schema.reservations.businessId });
    if (!rowA || !rowB) throw new Error('reservation pair insert failed');

    return {
      resA: { id: rowA.id, businessId: slotA.businessId, venueId: slotA.venueId, offerId: slotA.offerId },
      resB: { id: rowB.id, businessId: slotB.businessId, venueId: slotB.venueId, offerId: slotB.offerId },
      cleanup: async () => {
        await ctx.db.execute(sql`DELETE FROM trial_history WHERE reservation_id IN (${rowA.id}, ${rowB.id})`);
        await ctx.db.execute(sql`DELETE FROM reservations WHERE id IN (${rowA.id}, ${rowB.id})`);
      },
    };
  }

  async function countConsuming(businessId: string, userId: string): Promise<number> {
    const rows = await ctx.db
      .select({ id: schema.trialHistory.id })
      .from(schema.trialHistory)
      .where(
        and(
          eq(schema.trialHistory.userId, userId),
          eq(schema.trialHistory.businessId, businessId),
          inArray(schema.trialHistory.status, [...TRIAL_CONSUMING_STATUSES]),
        ),
      );
    return rows.length;
  }

  it(
    '(1/4) verrou par LIEU + filet retiré : la course forcée fait passer les deux consommations — bug reproduit',
    async () => {
      await withoutBusinessScopeBackstop(async () => {
        const user = await createTestUser(ctx.db);
        const { resA, resB, cleanup } = await seedReservationPair(user.id);
        const ready = deferred();

        try {
          const [outcomeA, outcomeB] = await Promise.all([
            attemptOpensFirst({
              lockKey: slotA.venueId,
              userId: user.id,
              reservation: resA,
              signalReady: ready.resolve,
            }),
            attemptWaitsThenReads({
              lockKey: slotB.venueId,
              userId: user.id,
              reservation: resB,
              waitFor: ready.promise,
            }),
          ]);

          expect([outcomeA, outcomeB].sort()).toEqual(['INSERTED', 'INSERTED']);
          expect(await countConsuming(resA.businessId, user.id)).toBe(2);
        } finally {
          await cleanup();
          await ctx.db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
        }
      });
    },
    10_000,
  );

  it(
    '(2/4) verrou par ÉTABLISSEMENT + filet retiré : une seule consommation passe — le verrou seul suffit',
    async () => {
      await withoutBusinessScopeBackstop(async () => {
        const user = await createTestUser(ctx.db);
        const { resA, resB, cleanup } = await seedReservationPair(user.id);
        const businessId = resA.businessId;

        try {
          const [outcomeA, outcomeB] = await Promise.all([
            attemptPlain({ lockKey: businessId, userId: user.id, reservation: resA }),
            attemptPlain({ lockKey: businessId, userId: user.id, reservation: resB }),
          ]);

          expect([outcomeA, outcomeB].sort()).toEqual(['INSERTED', 'REJECTED_ELIGIBILITY']);
          expect(await countConsuming(businessId, user.id)).toBe(1);
        } finally {
          await cleanup();
          await ctx.db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
        }
      });
    },
    10_000,
  );

  it('(3/4) filet en base seul, sans verrou ni concurrence : le deuxième INSERT direct est rejeté', async () => {
    const user = await createTestUser(ctx.db);
    const { resA, resB, cleanup } = await seedReservationPair(user.id);

    try {
      await ctx.db.insert(schema.trialHistory).values({
        userId: user.id,
        businessId: resA.businessId,
        venueId: resA.venueId,
        offerId: resA.offerId,
        reservationId: resA.id,
        reservedAt: new Date(),
        status: 'CONFIRMED',
        trialRule: 'ONE_TRIAL_PER_BUSINESS',
      });

      await expect(
        ctx.db.insert(schema.trialHistory).values({
          userId: user.id,
          businessId: resB.businessId,
          venueId: resB.venueId,
          offerId: resB.offerId,
          reservationId: resB.id,
          reservedAt: new Date(),
          status: 'CONFIRMED',
          trialRule: 'ONE_TRIAL_PER_BUSINESS',
        }),
      ).rejects.toSatisfy(expectConstraint(BUSINESS_SCOPE_INDEX_NAME));
    } finally {
      await cleanup();
      await ctx.db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    }
  });

  it('(4/4) tout restauré (verrou établissement + filet présent) : la course forcée reste neutralisée', async () => {
    const user = await createTestUser(ctx.db);
    const { resA, resB, cleanup } = await seedReservationPair(user.id);
    const businessId = resA.businessId;

    try {
      const [outcomeA, outcomeB] = await Promise.all([
        attemptPlain({ lockKey: businessId, userId: user.id, reservation: resA }),
        attemptPlain({ lockKey: businessId, userId: user.id, reservation: resB }),
      ]);

      expect([outcomeA, outcomeB].sort()).toEqual(['INSERTED', 'REJECTED_ELIGIBILITY']);
      expect(await countConsuming(businessId, user.id)).toBe(1);
    } finally {
      await cleanup();
      await ctx.db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    }
  });

  // --- Chemin réel, séquentiel : régression du cas normal, pas une preuve de concurrence ---

  it(
    "(régression) chemin réel séquentiel : BookingService.create() refuse la deuxième réservation " +
      '(ONE_TRIAL_PER_BUSINESS, hors course)',
    async () => {
      const user = await createTestUser(ctx.db);
      const service = new BookingService(
        ctx.db,
        new SystemClock(),
        silentLogger as never,
        new CryptoService({ CHECKIN_TOKEN_SECRET: 'integration-test-secret' } as AppConfig),
        {} as PaymentService,
        new DomainEvents(silentLogger as never),
      );

      try {
        const first = await service.create({ userId: user.id, dto: { slotId: slotA.slotId } });
        expect(first.status).toBe('CONFIRMED');

        await expect(
          service.create({ userId: user.id, dto: { slotId: slotB.slotId } }),
        ).rejects.toMatchObject({
          code: 'TRIAL_NOT_ELIGIBLE',
          context: { reason: 'ALREADY_TRIED_THIS_BUSINESS' },
        });
      } finally {
        await ctx.db.execute(sql`DELETE FROM trial_history WHERE user_id = ${user.id}`);
        await ctx.db.execute(sql`DELETE FROM reservations WHERE user_id = ${user.id}`);
        await ctx.db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
      }
    },
  );
});
