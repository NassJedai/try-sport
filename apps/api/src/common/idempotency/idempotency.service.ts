import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { Clock } from '@try/utils';
import { DATABASE } from '../database.module.js';
import { CLOCK } from '../clock.js';
import { ApiException } from '../errors/api-exception.js';
import { CryptoService } from '../crypto.service.js';

/** How long a completed response stays replayable. */
const RETENTION_HOURS = 24;

export interface IdempotentOutcome<T> {
  replayed: boolean;
  result: T;
}

/**
 * Exactly-once semantics for mutating endpoints.
 *
 * The guarantee comes from the unique index on (user, endpoint, key): the first
 * request wins the INSERT, and any concurrent duplicate collides. That is what
 * makes a double tap on "Réserver" — or a mobile client retrying after a dropped
 * connection — produce one booking and one charge rather than two.
 *
 * Reusing a key with a *different* body is rejected rather than replayed: it
 * means a client bug, and silently returning someone else's booking would be worse.
 */
@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly crypto: CryptoService,
  ) {}

  async execute<T>(
    input: {
      key: string | undefined;
      userId: string;
      endpoint: string;
      payload: unknown;
    },
    operation: () => Promise<T>,
  ): Promise<IdempotentOutcome<T>> {
    // No key: the caller accepts at-least-once. Booking endpoints require one.
    const key = input.key;
    if (!key) {
      return { replayed: false, result: await operation() };
    }

    const now = this.clock.now();
    const requestHash = this.crypto.fingerprint(input.payload);
    const expiresAt = new Date(now.getTime() + RETENTION_HOURS * 3_600_000);

    const inserted = await this.db
      .insert(schema.idempotencyKeys)
      .values({
        key,
        userId: input.userId,
        endpoint: input.endpoint,
        requestHash,
        lockedAt: now,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: schema.idempotencyKeys.id });

    if (inserted.length === 0) {
      return {
        replayed: true,
        result: await this.resolveExisting<T>({ ...input, key }, requestHash),
      };
    }

    const record = inserted[0];
    if (!record) throw new ApiException('INTERNAL_ERROR');

    try {
      const result = await operation();

      await this.db
        .update(schema.idempotencyKeys)
        .set({
          statusCode: 200,
          responseBody: result as Record<string, unknown>,
          completedAt: this.clock.now(),
        })
        .where(eq(schema.idempotencyKeys.id, record.id));

      return { replayed: false, result };
    } catch (error) {
      /**
       * A failed attempt releases its key so the user can genuinely retry.
       * Keeping it would turn a transient failure into a permanently poisoned key
       * — the user would tap "Réserver" again and get the original error forever.
       */
      await this.db
        .delete(schema.idempotencyKeys)
        .where(eq(schema.idempotencyKeys.id, record.id));
      throw error;
    }
  }

  private async resolveExisting<T>(
    input: { key: string; userId: string; endpoint: string },
    requestHash: string,
  ): Promise<T> {
    const [existing] = await this.db
      .select()
      .from(schema.idempotencyKeys)
      .where(
        and(
          eq(schema.idempotencyKeys.key, input.key),
          eq(schema.idempotencyKeys.userId, input.userId),
          eq(schema.idempotencyKeys.endpoint, input.endpoint),
        ),
      )
      .limit(1);

    if (!existing) {
      // The row vanished between the conflict and this read: the original attempt
      // failed and cleaned up. Treat it as a fresh request rather than an error.
      throw new ApiException('CONFLICT', 'Réessaie ta réservation.');
    }

    if (existing.requestHash !== requestHash) {
      throw new ApiException('IDEMPOTENCY_KEY_REUSED');
    }

    if (!existing.completedAt || existing.responseBody === null) {
      // The first attempt is still running. Asking the client to retry is safer
      // than blocking a connection until it finishes.
      throw new ApiException(
        'CONFLICT',
        'Ta demande est en cours de traitement. Patiente un instant.',
      );
    }

    return existing.responseBody as T;
  }

  /** Invoked by the cleanup job; keeps the table from growing without bound. */
  async purgeExpired(): Promise<number> {
    const result = await this.db
      .delete(schema.idempotencyKeys)
      .where(lt(schema.idempotencyKeys.expiresAt, this.clock.now()))
      .returning({ id: schema.idempotencyKeys.id });
    return result.length;
  }

  static requireKey(header: string | string[] | undefined): string {
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || value.length < 8 || value.length > 255) {
      throw new ApiException(
        'VALIDATION_FAILED',
        'En-tête Idempotency-Key requis (8 à 255 caractères).',
        { 'idempotency-key': ['required'] },
      );
    }
    return value;
  }
}

export { sql };
