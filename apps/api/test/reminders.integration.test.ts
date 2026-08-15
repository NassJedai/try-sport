import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import { ReminderService } from '../src/modules/notifications/reminder.service.js';
import {
  NotificationService,
  type EmailMessage,
  type EmailTransport,
} from '../src/modules/notifications/notification.service.js';
import { NotificationController } from '../src/modules/notifications/notification.controller.js';
import { connect, createTestUser, describeIfDatabase, seedBookableSlot } from './integration-setup.js';

/**
 * Ce que ces tests protègent : un rappel part une fois, et il dit la vérité.
 *
 * Les deux se cassent silencieusement. Un doublon ne fait échouer aucune requête
 * — il arrive juste dans la boîte de quelqu'un. Un « Demain » envoyé deux heures
 * avant le cours passe tous les typecheck du monde. Seul un test qui rejoue le
 * job contre une vraie base attrape l'un et l'autre.
 */

/**
 * Transport qui compte au lieu d'envoyer.
 *
 * `to()` filtre par destinataire, et ce n'est pas de la coquetterie : le job
 * balaie toute la table, et la base de développement contient le seed. Compter
 * les envois totaux ferait dépendre le test de données qu'il n'a pas créées —
 * il passerait ou échouerait selon l'heure de la journée.
 */
class RecordingTransport implements EmailTransport {
  readonly sent: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  to(email: string): EmailMessage[] {
    return this.sent.filter((message) => message.to === email);
  }
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
} as unknown as Parameters<typeof buildService>[2];

function buildService(
  db: Database,
  transport: RecordingTransport,
  logger: never,
  now: Date,
): ReminderService {
  const notifications = new NotificationService(transport, logger, {
    EMAIL_FROM: 'test@try.local',
  } as never);

  // Horloge figée : « dans 3 heures » doit rester dans 3 heures pendant que le
  // test tourne, sinon la fenêtre choisie dépend de la vitesse de la machine.
  return new ReminderService(db, { now: () => now } as never, logger, notifications);
}

describeIfDatabase('rappels de séance', () => {
  let ctx: ReturnType<typeof connect>;

  /**
   * Le nettoyage est enregistré ici, pas appelé à la fin de chaque test.
   *
   * Un `await cleanup()` en dernière ligne ne s'exécute pas quand une assertion
   * échoue avant lui : les lignes restent, et comme le code pays d'un pays de
   * test tient sur deux caractères, les résidus finissent par faire échouer des
   * tests suivants qui n'ont rien à voir. C'est déjà arrivé — dix pays orphelins
   * traînaient dans la base de développement.
   */
  const pending: Array<() => Promise<void>> = [];

  beforeAll(() => {
    ctx = connect();
  });

  afterEach(async () => {
    while (pending.length > 0) {
      await pending.pop()!();
    }
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function bookConfirmed(startsInMinutes: number): Promise<{
    userId: string;
    email: string;
    reservationId: string;
  }> {
    const seed = await seedBookableSlot(ctx.db, { capacity: 5 });
    const user = await createTestUser(ctx.db);

    const startAt = new Date(Date.now() + startsInMinutes * 60_000);
    const [reservation] = await ctx.db
      .insert(schema.reservations)
      .values({
        userId: user.id,
        slotId: seed.slotId,
        offerId: seed.offerId,
        venueId: seed.venueId,
        businessId: seed.businessId,
        status: 'CONFIRMED',
        priceAmount: 0,
        trialRule: 'NO_RESTRICTION',
        slotStartAt: startAt,
        slotEndAt: new Date(startAt.getTime() + 3_600_000),
      })
      .returning({ id: schema.reservations.id });

    const cleanup = async (): Promise<void> => {
      await ctx.db.execute(
        sql`DELETE FROM notifications WHERE reservation_id = ${reservation!.id}`,
      );
      await seed.cleanup();
      await ctx.db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    };
    pending.push(cleanup);

    return { userId: user.id, email: user.email, reservationId: reservation!.id };
  }

  it('envoie le rappel une seule fois, même si le job rejoue', async () => {
    const booking = await bookConfirmed(3 * 60);
    const transport = new RecordingTransport();
    const service = buildService(ctx.db, transport, silentLogger as never, new Date());

    await service.sendDueReminders();
    // Le rejeu est le cas réel : redémarrage en plein tour, deuxième instance
    // d'API, fenêtre qui recouvre le tour précédent.
    await service.sendDueReminders();

    expect(transport.to(booking.email)).toHaveLength(1);

    const rows = await ctx.db.execute(
      sql`SELECT type FROM notifications WHERE reservation_id = ${booking.reservationId}`,
    );
    expect(rows).toHaveLength(1);

  });

  it('parle en heures, pas en jours, pour une séance dans 30 minutes', async () => {
    const booking = await bookConfirmed(30);
    const transport = new RecordingTransport();
    const service = buildService(ctx.db, transport, silentLogger as never, new Date());

    await service.sendDueReminders();

    const mine = transport.to(booking.email);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toContain('Dans 2 h');
    expect(mine[0]!.subject).not.toMatch(/Demain|Aujourd'hui/);

  });

  it('envoie les deux rappels à une séance lointaine, à mesure qu\'elle approche', async () => {
    const booking = await bookConfirmed(20 * 60);
    const transport = new RecordingTransport();
    const now = new Date();

    // Premier passage : la séance est dans 20 h, seul le rappel de la veille est dû.
    await buildService(ctx.db, transport, silentLogger as never, now).sendDueReminders();
    expect(transport.to(booking.email).map((m) => m.subject)).toEqual([
      expect.stringMatching(/^(Aujourd'hui|Demain) : /),
    ]);

    // 19 heures plus tard, la même réservation entre dans la fenêtre courte.
    const later = new Date(now.getTime() + 19 * 3_600_000);
    await buildService(ctx.db, transport, silentLogger as never, later).sendDueReminders();
    expect(transport.to(booking.email).map((m) => m.subject)).toEqual([
      expect.stringMatching(/^(Aujourd'hui|Demain) : /),
      expect.stringContaining('Dans 2 h'),
    ]);

  });

  /**
   * Le rappel doit arriver jusqu'à l'écran, pas seulement jusqu'à la table.
   *
   * Ce test existe parce que la liste renvoyait une erreur 400 en production
   * locale alors que le job, lui, fonctionnait : Drizzle rend des objets `Date`
   * et le contrat promet des chaînes ISO. Le job avait des tests, la lecture
   * n'en avait pas — et c'est la lecture que l'utilisateur voit.
   */
  it('rend le rappel lisible par l\x27app, dates au format ISO', async () => {
    const booking = await bookConfirmed(3 * 60);
    const transport = new RecordingTransport();
    await buildService(ctx.db, transport, silentLogger as never, new Date()).sendDueReminders();

    const controller = new NotificationController(ctx.db, { now: () => new Date() } as never);
    const page = await controller.list({ id: booking.userId } as never);

    expect(page.unreadCount).toBe(1);
    expect(page.items[0]!.title).toMatch(/^(Aujourd'hui|Demain) : /);
    // Une `Date` sérialisée par Nest passerait ici ; le schéma, lui, refuse.
    expect(typeof page.items[0]!.createdAt).toBe('string');
    expect(page.items[0]!.readAt).toBeNull();

    await controller.markRead({ id: booking.userId } as never, page.items[0]!.id);
    expect((await controller.list({ id: booking.userId } as never)).unreadCount).toBe(0);
  });

  /**
   * Un identifiant n'est pas une autorisation : connaître celui d'une
   * notification ne doit pas suffire à la marquer lue chez quelqu'un d'autre.
   */
  it('refuse de marquer lue la notification d\x27un autre compte', async () => {
    const booking = await bookConfirmed(3 * 60);
    const intruder = await createTestUser(ctx.db);
    pending.push(async () => {
      await ctx.db.execute(sql`DELETE FROM users WHERE id = ${intruder.id}`);
    });

    const transport = new RecordingTransport();
    await buildService(ctx.db, transport, silentLogger as never, new Date()).sendDueReminders();

    const controller = new NotificationController(ctx.db, { now: () => new Date() } as never);
    const mine = await controller.list({ id: booking.userId } as never);

    const result = await controller.markRead({ id: intruder.id } as never, mine.items[0]!.id);

    expect(result.ok).toBe(false);
    // Et elle est toujours non lue chez son propriétaire.
    expect((await controller.list({ id: booking.userId } as never)).unreadCount).toBe(1);
  });

  it('ne rappelle pas une séance annulée', async () => {
    const booking = await bookConfirmed(3 * 60);
    await ctx.db.execute(
      sql`UPDATE reservations SET status = 'CANCELLED_USER' WHERE id = ${booking.reservationId}`,
    );

    const transport = new RecordingTransport();
    const service = buildService(ctx.db, transport, silentLogger as never, new Date());

    await service.sendDueReminders();
    expect(transport.to(booking.email)).toHaveLength(0);

  });
});
