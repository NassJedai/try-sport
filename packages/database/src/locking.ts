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
 * Serialises everything that resolves *which* `users` row an email address
 * belongs to: creating a brand-new account, reactivating one that was
 * anonymised by `AccountService.deleteAccount`, and the deletion itself.
 *
 * Without this, a signup and a deletion racing on the same address is a
 * genuine read-then-write hazard, in both directions — `AuthService.
 * findOrCreateUser` could read "no active account" for an address whose
 * deletion has not committed yet and insert a second, duplicate row (a plain
 * account-creation race, always latent here, now closed as a side effect);
 * or `AccountService.deleteAccount` could anonymise a row while a concurrent
 * signup is mid-flight against the same address, leaving one half of that
 * signup's writes pointed at a row that is being erased under it.
 *
 * Keyed on the plaintext address, not on a user id: the two call sites are
 * resolving *from* an address (a signup has no id yet; a deletion's
 * reactivation counterpart looks the row up by a hash of the address, never
 * by id), so the address is the only key both sides can compute upfront.
 * Both callers pass the address normalised the same way it is stored
 * (`emailSchema` — lowercase, trimmed) at the boundary that first receives
 * it, so the two lock keys agree for the same real-world address.
 */
export async function acquireIdentityLock(executor: Executor, email: string): Promise<void> {
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity:${email.trim().toLowerCase()}`}, 0))`,
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
