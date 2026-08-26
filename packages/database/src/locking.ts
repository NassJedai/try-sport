import { sql } from 'drizzle-orm';
import type { Executor } from './client.js';

/**
 * Transaction-scoped advisory locks.
 *
 * Capacity is protected by a conditional UPDATE plus a CHECK constraint, which
 * needs no lock. Trial eligibility is different: it is a rule *across rows*
 * ("has this user already tried this business?"), and a read-then-write check is
 * racy under READ COMMITTED — two simultaneous requests can both read "no prior
 * trial" and both insert.
 *
 * Serialised on (user, business), not (user, venue): a business's trial rule
 * (`packages/contracts/src/trial-eligibility.ts`) can be scoped as broad as
 * "one trial across the whole business", and a business can have several
 * venues. Locking per venue let two simultaneous bookings on two different
 * venues of the *same* business both read an empty history and both insert —
 * this was a real bug (fixed 2026-08-26), not a hypothetical. Business is the
 * widest scope any trial rule can span, so locking there is always correct
 * for the narrower rules too (per venue, per offer) — it just serialises a
 * little more than a per-venue lock strictly needs to, which is cheap.
 *
 * Serialising on (user, business) is cheaper and far less surprising than
 * pushing the whole transaction to SERIALIZABLE isolation, which would force
 * the entire booking path to handle serialisation failures. The lock is
 * released automatically when the transaction ends, including on rollback.
 *
 * This lock is the primary defence. `trial_history` also carries three
 * partial unique indexes (migration 0007) as a storage-level backstop, on the
 * same principle as the capacity CHECK constraint: a regression here should
 * hit the database, not just silently pass code review.
 */
export async function acquireTrialEligibilityLock(
  executor: Executor,
  userId: string,
  businessId: string,
): Promise<void> {
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trial:${userId}:${businessId}`}, 0))`,
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
