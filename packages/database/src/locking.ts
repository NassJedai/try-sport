import { sql } from 'drizzle-orm';
import type { Executor } from './client.js';

/**
 * Transaction-scoped advisory locks.
 *
 * Capacity is protected by a conditional UPDATE plus a CHECK constraint, which
 * needs no lock. Trial eligibility is different: it is a rule *across rows*
 * ("has this user already tried this venue?"), and a read-then-write check is
 * racy under READ COMMITTED — two simultaneous requests can both read "no prior
 * trial" and both insert.
 *
 * Serialising on (user, venue) is cheaper and far less surprising than pushing the
 * whole transaction to SERIALIZABLE isolation, which would force the entire
 * booking path to handle serialisation failures. The lock is released
 * automatically when the transaction ends, including on rollback.
 */
export async function acquireTrialEligibilityLock(
  executor: Executor,
  userId: string,
  venueId: string,
): Promise<void> {
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trial:${userId}:${venueId}`}, 0))`,
  );
}

/**
 * Guards operations that must not run concurrently for one business, such as
 * expanding a recurring schedule into slots.
 */
export async function acquireBusinessLock(
  executor: Executor,
  businessId: string,
  purpose: string,
): Promise<void> {
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${purpose}:${businessId}`}, 0))`,
  );
}

/**
 * Non-blocking variant for background jobs: returns false instead of waiting, so
 * a second worker skips work already in progress rather than queueing behind it.
 */
export async function tryAcquireLock(executor: Executor, key: string): Promise<boolean> {
  const result = await executor.execute<{ acquired: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS acquired`,
  );
  const rows = result as unknown as { acquired: boolean }[];
  return rows[0]?.acquired === true;
}
