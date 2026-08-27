import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { Clock } from '@try/utils';
import type { Logger } from '@try/logger';
import type { AppConfig } from '@try/config';
import { ApiException } from '../src/common/errors/api-exception.js';
import { CryptoService } from '../src/common/crypto.service.js';
import type { AuthenticatedUser } from '../src/common/auth/current-user.js';
import { DomainEvents } from '../src/modules/events/domain-events.js';
import { AuditService } from '../src/modules/admin/audit.service.js';
import { BookingService } from '../src/modules/bookings/booking.service.js';
import { PaymentService } from '../src/modules/payments/payment.service.js';
import { RefundLedgerService } from '../src/modules/payments/refund-ledger.service.js';
import type {
  CheckoutSessionResult,
  PaymentProvider,
  ProviderRefund,
  RefundOutcome,
  VerifiedWebhookEvent,
} from '../src/modules/payments/payment-provider.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import type { NotificationService } from '../src/modules/notifications/notification.service.js';
import { AccountService } from '../src/modules/users/account.service.js';
import { connect, createTestUser, describeIfDatabase, seedBookableSlot } from './integration-setup.js';

/**
 * `AccountService.deleteAccount` — suppression de compte (règle App Store
 * 5.1.1(v), droit à l'effacement RGPD). Voir la doc du service pour ce qui
 * est effacé, anonymisé, ou conservé.
 *
 * Le fil conducteur de cette suite est celui posé par le chef de projet :
 * l'argent reste juste (réservation/paiement/trial_history intacts), et
 * l'essai ne se recharge pas (réinscription à la même adresse -> même
 * compte -> même historique -> toujours bloqué).
 */

const PEPPER = 'erasure-pepper-for-tests-'.repeat(2).slice(0, 40);

function fakeLogger(): Logger {
  const noop = (): void => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop };
  return { ...logger, child: () => logger } as unknown as Logger;
}

const config = {
  CHECKIN_TOKEN_SECRET: 'checkin-secret-'.repeat(3).slice(0, 40),
  EMAIL_ERASURE_PEPPER: PEPPER,
  JWT_SECRET: 'jwt-secret-'.repeat(4).slice(0, 40),
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_DAYS: 60,
} as AppConfig;

let refundCounter = 0;
function providerRefund(overrides: Partial<ProviderRefund> = {}): ProviderRefund {
  refundCounter += 1;
  return {
    providerRefundId: `re_delete_${refundCounter}_${Math.random().toString(36).slice(2, 8)}`,
    providerIntentId: null,
    providerChargeId: null,
    amountMinor: 100,
    currency: 'EUR',
    status: 'SUCCEEDED',
    reason: null,
    failureReason: null,
    occurredAt: new Date(),
    ...overrides,
  };
}

class FakeProvider implements PaymentProvider {
  constructor(private readonly refundOutcome?: RefundOutcome) {}

  createCheckoutSession(): Promise<CheckoutSessionResult> {
    return Promise.reject(new Error('createCheckoutSession not used in this test'));
  }

  cancelIntent(): Promise<void> {
    return Promise.resolve();
  }

  async refund(): Promise<RefundOutcome> {
    if (!this.refundOutcome) throw new Error('refund() not configured for this test');
    return this.refundOutcome;
  }

  listRefunds(): Promise<ProviderRefund[]> {
    return Promise.resolve([]);
  }

  verifyWebhook(): VerifiedWebhookEvent {
    throw new Error('verifyWebhook not used in this test');
  }

  interpret(): VerifiedWebhookEvent {
    throw new Error('interpret not used in this test');
  }
}

describeIfDatabase('AccountService.deleteAccount — suppression de compte', () => {
  let db: Database;
  let close: () => Promise<void>;
  const clock: Clock = { now: () => new Date() };
  const crypto = new CryptoService(config);
  const notificationsStub = {
    sendAccountDeletionConfirmation: async () => {},
    sendLoginCode: async () => {},
  } as unknown as NotificationService;
  const pending: Array<() => Promise<void>> = [];

  beforeAll(() => {
    ({ db, close } = connect());
  });

  afterEach(async () => {
    while (pending.length > 0) await pending.pop()!();
  });

  afterAll(async () => {
    await close();
  });

  function services(refundOutcome?: RefundOutcome): {
    account: AccountService;
    auth: AuthService;
    bookings: BookingService;
    audit: AuditService;
  } {
    const events = new DomainEvents(fakeLogger());
    const audit = new AuditService(db);
    const ledger = new RefundLedgerService(db, clock, fakeLogger(), events);
    const provider = new FakeProvider(refundOutcome);
    const payments = new PaymentService(db, provider, clock, fakeLogger(), events, ledger);
    const bookings = new BookingService(db, clock, fakeLogger(), crypto, payments, events, audit);
    const account = new AccountService(
      db,
      clock,
      fakeLogger(),
      crypto,
      bookings,
      notificationsStub,
      events,
      audit,
    );
    const auth = new AuthService(
      db,
      clock,
      config,
      fakeLogger(),
      crypto,
      // TokenService n'est pas exercé par verifyOtp au-delà de la signature du
      // jeton d'accès — une fabrique minimale suffit sans importer le module.
      {
        issueAccessToken: () => ({ token: 'fake-access-token', expiresIn: 900 }),
        generateRefreshToken: () => Math.random().toString(36).slice(2),
      } as never,
      notificationsStub,
    );
    return { account, auth, bookings, audit };
  }

  function actorFor(user: { id: string; email: string }, role: AuthenticatedUser['role'] = 'USER'): AuthenticatedUser {
    return { id: user.id, email: user.email, role, memberships: [] };
  }

  async function insertOtp(email: string, code: string): Promise<void> {
    await db.insert(schema.otpCodes).values({
      email,
      codeHash: crypto.hashToken(code),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    pending.push(async () => {
      await db.delete(schema.otpCodes).where(eq(schema.otpCodes.email, email));
    });
  }

  it('anonymise le compte et efface la donnée personnelle, en laissant intacts réservation, paiement et historique d’essai', async () => {
    const user = await createTestUser(db);
    await db
      .update(schema.profiles)
      .set({ firstName: 'Camille' })
      .where(eq(schema.profiles.userId, user.id));

    const seed = await seedBookableSlot(db, { capacity: 5, priceAmount: 1000 });
    const [reservation] = await db
      .insert(schema.reservations)
      .values({
        userId: user.id,
        slotId: seed.slotId,
        offerId: seed.offerId,
        venueId: seed.venueId,
        businessId: seed.businessId,
        status: 'COMPLETED',
        priceAmount: 1000,
        trialRule: 'ONE_TRIAL_PER_VENUE',
        slotStartAt: new Date(Date.now() - 7 * 86_400_000),
        slotEndAt: new Date(Date.now() - 7 * 86_400_000 + 3_600_000),
        completedAt: new Date(Date.now() - 7 * 86_400_000 + 3_600_000),
      })
      .returning();
    const [payment] = await db
      .insert(schema.payments)
      .values({
        reservationId: reservation!.id,
        userId: user.id,
        businessId: seed.businessId,
        status: 'SUCCEEDED',
        provider: 'STRIPE',
        providerPaymentIntentId: `pi_del_${reservation!.id}`,
        amount: 1000,
        platformFeeAmount: 250,
        merchantAmount: 750,
        currency: 'EUR',
      })
      .returning();
    await db.insert(schema.trialHistory).values({
      userId: user.id,
      businessId: seed.businessId,
      venueId: seed.venueId,
      offerId: seed.offerId,
      reservationId: reservation!.id,
      reservedAt: new Date(Date.now() - 7 * 86_400_000),
      completedAt: new Date(Date.now() - 7 * 86_400_000 + 3_600_000),
      status: 'COMPLETED',
      trialRule: 'ONE_TRIAL_PER_VENUE',
    });
    await db.insert(schema.favorites).values({ userId: user.id, offerId: seed.offerId });
    await db.insert(schema.pushTokens).values({
      userId: user.id,
      token: `push-${user.id}`,
      platform: 'IOS',
    });
    await db.insert(schema.notifications).values({
      userId: user.id,
      type: 'TEST',
      title: 'Test',
      body: 'Test',
    });

    pending.push(async () => {
      await db.delete(schema.auditLogs).where(eq(schema.auditLogs.entityId, user.id));
    });
    pending.push(async () => {
      await db.delete(schema.trialHistory).where(eq(schema.trialHistory.reservationId, reservation!.id));
      await db.delete(schema.payments).where(eq(schema.payments.id, payment!.id));
      await db.delete(schema.reservations).where(eq(schema.reservations.id, reservation!.id));
      await seed.cleanup();
      await db.delete(schema.users).where(eq(schema.users.id, user.id));
    });

    const { account } = services();
    const result = await account.deleteAccount(actorFor(user));
    expect(result.deletedAt).toBeTruthy();

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(row!.email).toBe(`erased+${user.id}@erased.try.invalid`);
    expect(row!.email).not.toBe(user.email);
    expect(row!.anonymizedAt).not.toBeNull();
    expect(row!.emailHash).toBe(crypto.hashErasedEmail(user.email));

    const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, user.id));
    expect(profile).toBeUndefined();
    const favs = await db.select().from(schema.favorites).where(eq(schema.favorites.userId, user.id));
    expect(favs).toHaveLength(0);
    const pushes = await db.select().from(schema.pushTokens).where(eq(schema.pushTokens.userId, user.id));
    expect(pushes).toHaveLength(0);
    const notifs = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, user.id));
    expect(notifs).toHaveLength(0);

    // L'argent reste juste : réservation, paiement et historique d'essai
    // intacts, toujours rattachés à la même ligne users (anonymisée).
    const [reservationRow] = await db
      .select()
      .from(schema.reservations)
      .where(eq(schema.reservations.id, reservation!.id));
    expect(reservationRow!.status).toBe('COMPLETED');
    expect(reservationRow!.userId).toBe(user.id);

    const [paymentRow] = await db.select().from(schema.payments).where(eq(schema.payments.id, payment!.id));
    expect(paymentRow).toMatchObject({ status: 'SUCCEEDED', amount: 1000, platformFeeAmount: 250, merchantAmount: 750 });

    const [trialRow] = await db
      .select()
      .from(schema.trialHistory)
      .where(eq(schema.trialHistory.reservationId, reservation!.id));
    expect(trialRow!.status).toBe('COMPLETED');

    const [auditRow] = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.entityId, user.id), eq(schema.auditLogs.action, 'user.self_delete')));
    expect(auditRow).toMatchObject({ actorId: user.id, actorType: 'USER' });
  });

  it('annule et rembourse une réservation payante encore active ; une réservation déjà terminée n’est pas touchée', async () => {
    const user = await createTestUser(db);
    const seed = await seedBookableSlot(db, { capacity: 5, priceAmount: 2000 });

    const [live] = await db
      .insert(schema.reservations)
      .values({
        userId: user.id,
        slotId: seed.slotId,
        offerId: seed.offerId,
        venueId: seed.venueId,
        businessId: seed.businessId,
        status: 'CONFIRMED',
        priceAmount: 2000,
        trialRule: 'NO_RESTRICTION',
        slotStartAt: new Date(Date.now() + 7 * 86_400_000),
        slotEndAt: new Date(Date.now() + 7 * 86_400_000 + 3_600_000),
      })
      .returning();
    await db.update(schema.slots).set({ reservedCount: 1 }).where(eq(schema.slots.id, seed.slotId));
    const [payment] = await db
      .insert(schema.payments)
      .values({
        reservationId: live!.id,
        userId: user.id,
        businessId: seed.businessId,
        status: 'SUCCEEDED',
        provider: 'STRIPE',
        providerPaymentIntentId: `pi_live_${live!.id}`,
        amount: 2000,
        platformFeeAmount: 500,
        merchantAmount: 1500,
        currency: 'EUR',
      })
      .returning();

    // Déjà terminée, sur un second créneau : ne doit pas bouger. Un second
    // créneau est nécessaire — l'index partiel sur (user_id, slot_id) refuse
    // deux réservations "vivantes" (CHECKED_IN y compris) pour le même
    // créneau, même utilisateur.
    const [pastSlot] = await db
      .insert(schema.slots)
      .values({
        offerId: seed.offerId,
        venueId: seed.venueId,
        startAt: new Date(Date.now() - 86_400_000),
        endAt: new Date(Date.now() - 86_400_000 + 3_600_000),
        capacity: 5,
        reservedCount: 1,
        status: 'OPEN',
      })
      .returning();
    const [past] = await db
      .insert(schema.reservations)
      .values({
        userId: user.id,
        slotId: pastSlot!.id,
        offerId: seed.offerId,
        venueId: seed.venueId,
        businessId: seed.businessId,
        status: 'CHECKED_IN',
        priceAmount: 0,
        trialRule: 'NO_RESTRICTION',
        slotStartAt: new Date(Date.now() - 86_400_000),
        slotEndAt: new Date(Date.now() - 86_400_000 + 3_600_000),
        checkedInAt: new Date(Date.now() - 86_400_000 + 1_800_000),
      })
      .returning();

    pending.push(async () => {
      await db.delete(schema.auditLogs).where(eq(schema.auditLogs.entityId, user.id));
      await db.delete(schema.refunds).where(eq(schema.refunds.paymentId, payment!.id));
      await db.delete(schema.payments).where(eq(schema.payments.id, payment!.id));
      await db.delete(schema.reservations).where(eq(schema.reservations.id, live!.id));
      await db.delete(schema.reservations).where(eq(schema.reservations.id, past!.id));
      await db.delete(schema.slots).where(eq(schema.slots.id, pastSlot!.id));
      await seed.cleanup();
      await db.delete(schema.users).where(eq(schema.users.id, user.id));
    });

    const refund = providerRefund({ amountMinor: 2000 });
    const { account } = services({ kind: 'CREATED', refund });

    await account.deleteAccount(actorFor(user));

    const [liveRow] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, live!.id));
    expect(liveRow!.status).toBe('CANCELLED_USER');

    const [slotRow] = await db.select().from(schema.slots).where(eq(schema.slots.id, seed.slotId));
    expect(slotRow!.reservedCount).toBe(0);

    const [paymentRow] = await db.select().from(schema.payments).where(eq(schema.payments.id, payment!.id));
    expect(paymentRow!.status).toBe('REFUNDED');
    expect(paymentRow!.refundedAmount).toBe(2000);

    const [pastRow] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, past!.id));
    expect(pastRow!.status).toBe('CHECKED_IN');
  });

  it('l’essai ne se recharge pas : une réinscription à la même adresse retombe sur le même compte, toujours bloqué par trial_history', async () => {
    const email = `trial-recharge-${Math.random().toString(36).slice(2)}@try.local`;
    const [user] = await db.insert(schema.users).values({ email, role: 'USER' }).returning();
    await db.insert(schema.profiles).values({ userId: user!.id });

    const seed = await seedBookableSlot(db, { capacity: 5, trialRule: 'ONE_TRIAL_PER_VENUE' });
    const [consumed] = await db
      .insert(schema.reservations)
      .values({
        userId: user!.id,
        slotId: seed.slotId,
        offerId: seed.offerId,
        venueId: seed.venueId,
        businessId: seed.businessId,
        status: 'COMPLETED',
        priceAmount: 0,
        trialRule: 'ONE_TRIAL_PER_VENUE',
        slotStartAt: new Date(Date.now() - 7 * 86_400_000),
        slotEndAt: new Date(Date.now() - 7 * 86_400_000 + 3_600_000),
        completedAt: new Date(Date.now() - 7 * 86_400_000 + 3_600_000),
      })
      .returning();
    await db.insert(schema.trialHistory).values({
      userId: user!.id,
      businessId: seed.businessId,
      venueId: seed.venueId,
      offerId: seed.offerId,
      reservationId: consumed!.id,
      reservedAt: new Date(Date.now() - 7 * 86_400_000),
      completedAt: new Date(Date.now() - 7 * 86_400_000 + 3_600_000),
      status: 'COMPLETED',
      trialRule: 'ONE_TRIAL_PER_VENUE',
    });
    // Un second créneau du MÊME lieu : c'est celui qu'une réinscription
    // tentera de réserver, pour prouver le blocage via le vrai chemin de
    // réservation plutôt qu'une lecture directe de trial_history.
    const [slot2] = await db
      .insert(schema.slots)
      .values({
        offerId: seed.offerId,
        venueId: seed.venueId,
        startAt: new Date(Date.now() + 14 * 86_400_000),
        endAt: new Date(Date.now() + 14 * 86_400_000 + 3_600_000),
        capacity: 5,
        reservedCount: 0,
        status: 'OPEN',
      })
      .returning();

    pending.push(async () => {
      await db.delete(schema.auditLogs).where(eq(schema.auditLogs.entityId, user!.id));
      await db.delete(schema.reservations).where(eq(schema.reservations.slotId, slot2!.id));
      await db.delete(schema.slots).where(eq(schema.slots.id, slot2!.id));
      await db.delete(schema.trialHistory).where(eq(schema.trialHistory.reservationId, consumed!.id));
      await db.delete(schema.reservations).where(eq(schema.reservations.id, consumed!.id));
      await seed.cleanup();
      await db.delete(schema.users).where(eq(schema.users.id, user!.id));
    });

    const { account, auth } = services();
    await account.deleteAccount(actorFor(user!));

    const [anonymized] = await db.select().from(schema.users).where(eq(schema.users.id, user!.id));
    expect(anonymized!.anonymizedAt).not.toBeNull();

    // Réinscription à la MÊME adresse, comme un utilisateur qui recrée un
    // compte pour retrouver son essai gratuit.
    await insertOtp(email, '123456');
    const session = await auth.verifyOtp({ email, code: '123456' });

    // Toujours le même compte, pas un nouveau — sans quoi trial_history ne
    // le protégerait plus.
    expect(session.viewer.id).toBe(user!.id);
    expect(session.isNewUser).toBe(true);

    const [reactivated] = await db.select().from(schema.users).where(eq(schema.users.id, user!.id));
    expect(reactivated!.email).toBe(email);
    expect(reactivated!.anonymizedAt).toBeNull();

    // Une seule ligne users porte cette adresse — pas une seconde, vierge.
    const rowsWithEmail = await db.select().from(schema.users).where(eq(schema.users.email, email));
    expect(rowsWithEmail).toHaveLength(1);

    const { bookings } = services();
    await expect(
      bookings.create({ userId: reactivated!.id, dto: { slotId: slot2!.id } }),
    ).rejects.toMatchObject({ code: 'TRIAL_NOT_ELIGIBLE' });
  });

  it('double suppression : la deuxième est un no-op idempotent, sans second geste audité', async () => {
    const user = await createTestUser(db);
    pending.push(async () => {
      await db.delete(schema.auditLogs).where(eq(schema.auditLogs.entityId, user.id));
      await db.delete(schema.users).where(eq(schema.users.id, user.id));
    });

    const { account } = services();
    const first = await account.deleteAccount(actorFor(user));
    const second = await account.deleteAccount(actorFor(user));
    expect(second.deletedAt).toBe(first.deletedAt);

    const auditRows = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.entityId, user.id), eq(schema.auditLogs.action, 'user.self_delete')));
    expect(auditRows).toHaveLength(1);
  });

  it('refuse la suppression de l’unique propriétaire d’un établissement, l’accepte une fois un second propriétaire ajouté', async () => {
    const owner = await createTestUser(db);
    const seed = await seedBookableSlot(db, { capacity: 5 });
    await db
      .insert(schema.businessMembers)
      .values({ businessId: seed.businessId, userId: owner.id, role: 'OWNER' });

    pending.push(async () => {
      await db.delete(schema.auditLogs).where(eq(schema.auditLogs.entityId, owner.id));
      await db.delete(schema.businessMembers).where(eq(schema.businessMembers.businessId, seed.businessId));
      await seed.cleanup();
      await db.delete(schema.users).where(eq(schema.users.id, owner.id));
    });

    const { account } = services();

    const error: unknown = await account.deleteAccount(actorFor(owner)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('CONFLICT');

    const [stillActive] = await db.select().from(schema.users).where(eq(schema.users.id, owner.id));
    expect(stillActive!.anonymizedAt).toBeNull();

    const secondOwner = await createTestUser(db);
    pending.push(async () => {
      await db.delete(schema.businessMembers).where(eq(schema.businessMembers.userId, secondOwner.id));
      await db.delete(schema.users).where(eq(schema.users.id, secondOwner.id));
    });
    await db
      .insert(schema.businessMembers)
      .values({ businessId: seed.businessId, userId: secondOwner.id, role: 'OWNER' });

    await account.deleteAccount(actorFor(owner));
    const [nowAnonymized] = await db.select().from(schema.users).where(eq(schema.users.id, owner.id));
    expect(nowAnonymized!.anonymizedAt).not.toBeNull();

    const membership = await db
      .select()
      .from(schema.businessMembers)
      .where(and(eq(schema.businessMembers.businessId, seed.businessId), eq(schema.businessMembers.userId, owner.id)));
    expect(membership).toHaveLength(0);
  });

  it('refuse la suppression d’un compte ADMIN/SUPER_ADMIN depuis cet endpoint', async () => {
    const admin = await createTestUser(db);
    await db.update(schema.users).set({ role: 'SUPER_ADMIN' }).where(eq(schema.users.id, admin.id));
    pending.push(async () => {
      await db.delete(schema.users).where(eq(schema.users.id, admin.id));
    });

    const { account } = services();
    const error: unknown = await account
      .deleteAccount(actorFor(admin, 'SUPER_ADMIN'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('FORBIDDEN');

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, admin.id));
    expect(row!.anonymizedAt).toBeNull();
  });
});
