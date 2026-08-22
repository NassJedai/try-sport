import { afterAll, beforeAll, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { AuthenticatedUser } from '../src/common/auth/current-user.js';
import { AdminBrowseService } from '../src/modules/admin/admin-browse.service.js';
import { connect, describeIfDatabase, seedBookableSlot } from './integration-setup.js';

/**
 * Reproduit et corrige le defaut mesure par le chef de projet le 2026-08-22 :
 * `GET /v1/admin/payments` ne prenait qu'un `limit` plafonne a 100, trie par
 * date decroissante — sur une table qui en compte plus de 100, un statut rare
 * comme REFUNDED devient structurellement inatteignable. Voir
 * `admin-browse.controller.ts` (`paymentsQuerySchema`) et
 * `admin-browse.service.ts` (`AdminBrowseService.payments()`) pour le
 * correctif : un filtre `status` exact et une pagination par curseur
 * `(created_at, id)`.
 */

const ADMIN_ACTOR: AuthenticatedUser = {
  id: '00000000-0000-4000-8000-000000000002',
  email: 'admin-pagination-test@try.local',
  role: 'SUPER_ADMIN',
  memberships: [],
};

// Le plafond reel de la frontiere publique (admin-browse.controller.ts : `.max(100)`).
const MAX_ADMIN_PAGE = 100;

describeIfDatabase(
  'AdminBrowseService.payments — filtre de statut et pagination par curseur',
  () => {
    let db: Database;
    let close: () => Promise<void>;
    let browse: AdminBrowseService;

    beforeAll(() => {
      ({ db, close } = connect());
      browse = new AdminBrowseService(db);
    });

    afterAll(async () => {
      await close();
    });

    /**
     * Insere `rows.length` paiements distincts sur un creneau partage, chacun
     * avec sa propre reservation CONFIRMED et son propre utilisateur —
     * `reservations_user_slot_live_key` interdit a un meme utilisateur deux
     * reservations "vivantes" (CONFIRMED en fait partie) sur le meme creneau,
     * donc un utilisateur distinct par ligne evite d'avoir a jongler avec des
     * statuts de reservation non vivants juste pour la fixture.
     *
     * `createdAt` est impose explicitement sur `payments` : c'est l'ordre que
     * la pagination doit respecter, et le seul moyen de le controler sans
     * dependre de l'horloge reelle entre deux inserts.
     */
    async function seedPayments(
      slot: { slotId: string; offerId: string; venueId: string; businessId: string },
      rows: {
        status: (typeof schema.payments.$inferInsert)['status'];
        createdAt: Date;
        amount: number;
        platformFeeAmount: number;
        refundedAmount?: number;
        refundedPlatformFeeAmount?: number;
        refundedMerchantAmount?: number;
      }[],
    ): Promise<{ paymentIds: string[]; cleanup: () => Promise<void> }> {
      const suffix = Math.random().toString(36).slice(2, 10);
      const startAt = new Date(Date.now() + 7 * 86_400_000);
      const endAt = new Date(startAt.getTime() + 3_600_000);

      const users = await db
        .insert(schema.users)
        .values(
          rows.map((_, index) => ({
            email: `admin-page-${suffix}-${index}@try.local`,
            role: 'USER' as const,
          })),
        )
        .returning({ id: schema.users.id });

      const reservations = await db
        .insert(schema.reservations)
        .values(
          rows.map((row, index) => ({
            userId: users[index]!.id,
            slotId: slot.slotId,
            offerId: slot.offerId,
            venueId: slot.venueId,
            businessId: slot.businessId,
            status: 'CONFIRMED' as const,
            priceAmount: row.amount,
            currency: 'EUR' as const,
            trialRule: 'NO_RESTRICTION' as const,
            slotStartAt: startAt,
            slotEndAt: endAt,
            confirmedAt: row.createdAt,
          })),
        )
        .returning({ id: schema.reservations.id });

      const paymentRows = await db
        .insert(schema.payments)
        .values(
          rows.map((row, index) => ({
            reservationId: reservations[index]!.id,
            userId: users[index]!.id,
            businessId: slot.businessId,
            status: row.status,
            amount: row.amount,
            platformFeeAmount: row.platformFeeAmount,
            merchantAmount: row.amount - row.platformFeeAmount,
            refundedAmount: row.refundedAmount ?? 0,
            refundedPlatformFeeAmount: row.refundedPlatformFeeAmount ?? 0,
            refundedMerchantAmount: row.refundedMerchantAmount ?? 0,
            currency: 'EUR' as const,
            createdAt: row.createdAt,
          })),
        )
        .returning({ id: schema.payments.id });

      const paymentIds = paymentRows.map((row) => row.id);
      const reservationIds = reservations.map((row) => row.id);
      const userIds = users.map((row) => row.id);

      return {
        paymentIds,
        cleanup: async () => {
          await db.delete(schema.payments).where(inArray(schema.payments.id, paymentIds));
          await db.delete(schema.reservations).where(inArray(schema.reservations.id, reservationIds));
          await db.delete(schema.users).where(inArray(schema.users.id, userIds));
        },
      };
    }

    it('les paiements REFUNDED, enfouis au-dela de la page par defaut, redeviennent atteignables via le filtre de statut', async () => {
      const slot = await seedBookableSlot(db, { capacity: 500, priceAmount: 1000 });
      try {
        const t0 = new Date();
        // Strictement plus que MAX_ADMIN_PAGE : a eux seuls, ces paiements plus
        // recents occupent toute la page non filtree, quel que soit le reste
        // de la table.
        const FILLER_COUNT = MAX_ADMIN_PAGE + 5;

        const target = await seedPayments(slot, [
          {
            status: 'REFUNDED',
            createdAt: t0,
            amount: 1000,
            platformFeeAmount: 250,
            refundedAmount: 1000,
            refundedPlatformFeeAmount: 250,
            refundedMerchantAmount: 750,
          },
        ]);
        try {
          const fillers = await seedPayments(
            slot,
            Array.from({ length: FILLER_COUNT }, (_, index) => ({
              status: 'SUCCEEDED' as const,
              createdAt: new Date(t0.getTime() + (index + 1) * 1000),
              amount: 1000,
              platformFeeAmount: 250,
            })),
          );
          try {
            // Reproduit le defaut mesure : sans filtre, la page non filtree ne
            // contient jamais ce paiement REFUNDED.
            const unfiltered = await browse.payments(ADMIN_ACTOR, { limit: MAX_ADMIN_PAGE });
            expect(unfiltered.items.some((item) => item.id === target.paymentIds[0])).toBe(false);

            // Le correctif : le filtre de statut retire les 105 paiements
            // SUCCEEDED de la course, le REFUNDED redevient la premiere ligne
            // pertinente.
            const filtered = await browse.payments(ADMIN_ACTOR, {
              status: 'REFUNDED',
              limit: MAX_ADMIN_PAGE,
            });
            const row = filtered.items.find((item) => item.id === target.paymentIds[0]);
            expect(row).toBeDefined();
            expect(row?.status).toBe('REFUNDED');
            // Encaisse puis integralement rendu : un vrai zero, pas `null`.
            expect(row?.netPlatformFee).not.toBeNull();
            expect(row?.netPlatformFee?.amount).toBe(0);
          } finally {
            await fillers.cleanup();
          }
        } finally {
          await target.cleanup();
        }
      } finally {
        await slot.cleanup();
      }
    });

    it('le curseur traverse toutes les pages sans doublon ni trou, et `total` colle exactement au filtre', async () => {
      const slot = await seedBookableSlot(db, { capacity: 500, priceAmount: 1000 });
      try {
        // Ligne de base plutot que valeur absolue : la base d'integration est
        // partagee (seed de dev, autres suites), donc seul le delta introduit
        // par ce test est verifiable sans fragilite.
        const before = await browse.payments(ADMIN_ACTOR, { status: 'FAILED', limit: 1 });

        const t0 = new Date();
        const INSERTED = 5;
        const seed = await seedPayments(
          slot,
          Array.from({ length: INSERTED }, (_, index) => ({
            status: 'FAILED' as const,
            createdAt: new Date(t0.getTime() + index * 1000),
            amount: 1000,
            platformFeeAmount: 250,
          })),
        );
        try {
          const collected: string[] = [];
          let cursor: string | null = null;
          let total = -1;
          let guard = 0;

          do {
            const page = await browse.payments(ADMIN_ACTOR, {
              status: 'FAILED',
              limit: 2,
              ...(cursor ? { cursor } : {}),
            });
            total = page.total;
            collected.push(...page.items.map((item) => item.id));
            cursor = page.nextCursor;
            guard += 1;
          } while (cursor !== null && guard < 100);

          expect(total).toBe(before.total + INSERTED);
          expect(new Set(collected).size).toBe(collected.length); // pas de doublon entre pages
          expect(collected.length).toBe(total); // pas de trou : chaque ligne du total est bien apparue
          for (const id of seed.paymentIds) {
            expect(collected).toContain(id);
          }
        } finally {
          await seed.cleanup();
        }
      } finally {
        await slot.cleanup();
      }
    });
  },
);
