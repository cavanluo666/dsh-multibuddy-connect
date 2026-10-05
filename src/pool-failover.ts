/**
 * Failover across a WorkBuddy account pool.
 *
 * This is the piece the user asked for: send the request, and if the account
 * that served it is throttled or out of credit, try the next one — without the
 * caller knowing a pool exists.
 *
 * WHAT IT IS NOT. It is not a generic retry loop. A retry loop would re-send on
 * every failure, including the ones where the next account fails identically
 * (see \`isAccountScoped\`), and it would re-send the SAME attempt twice on one
 * account. The rules here are deliberately narrower:
 *
 *  1. Every account is tried AT MOST ONCE per request. A second attempt on a
 *     throttled account is a wasted round trip, and on a streaming endpoint it
 *     is also a second chance to emit partial output.
 *  2. Only account-scoped failures advance the walk. Anything else returns
 *     immediately, because the pool cannot fix it.
 *  3. When every account has been tried, the LAST failure is returned with the
 *     number of accounts attempted, so the user can tell \"throttled on all
 *     three\" from \"throttled, and I have only one account\".
 *
 * The attempt callback is supplied by the caller and owns the actual request;
 * this module owns only the decision of when to stop.
 *
 * @module dsh-multibuddy-connect/pool-failover
 */

import { isAccountScoped, type PooledAccountRecord, type WorkBuddyAccountPool } from './pool.ts'
import type { UpstreamErrorKind } from './upstream.ts'

/** What one attempt produced, in the vocabulary the pool understands. */
export type AttemptOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; kind: UpstreamErrorKind; message: string; status: number }

/** The result of walking the pool. */
export interface FailoverResult<T> {
  /** The successful value, when some account served the request. */
  value?: T
  /** Every account that was tried, in order. */
  tried: readonly string[]
  /** The last failure, when nothing succeeded. */
  failure?: { kind: UpstreamErrorKind; message: string; status: number; accountId: string }
}

/** Constructor options. */
export interface FailoverOptions<T> {
  /** The pool supplying candidates. */
  pool: WorkBuddyAccountPool
  /**
   * Perform the request against one account.
   *
   * Must not throw for an upstream failure — it reports one through
   * {@link AttemptOutcome}. A THROWN error is treated as fatal and propagates,
   * because a caller that throws is describing a programmer error or a local
   * fault (a missing file, a bad argument), not an account condition.
   */
  attempt: (record: PooledAccountRecord) => Promise<AttemptOutcome<T>>
  /** Injected clock, so tests need no timers. */
  now?: () => number
  /**
   * Called after each attempt with its outcome, for logging or diagnostics.
   * Never allowed to break the walk.
   */
  onAttempt?: (record: PooledAccountRecord, outcome: AttemptOutcome<T>) => void
}

/**
 * Try each available account until one succeeds.
 *
 * @param options - the pool and the attempt callback.
 * @returns the first success, or the last failure with the accounts tried.
 */
export async function withFailover<T>(options: FailoverOptions<T>): Promise<FailoverResult<T>> {
  const { pool } = options
  const now = options.now ?? Date.now
  const tried: string[] = []
  let last: FailoverResult<T>['failure']

  // Snapshot the candidates ONCE. Re-reading availability between attempts
  // would let a cooldown applied by this very walk change the set it is walking,
  // which is how a pool ends up skipping an account it never tried.
  const candidates = pool.available(now())

  for (const record of candidates) {
    tried.push(record.id)
    const outcome = await options.attempt(record)
    try {
      options.onAttempt?.(record, outcome)
    } catch {
      // A diagnostic hook must never break the request it observes.
    }
    if (outcome.ok) {
      pool.report(record.id, 'ok', now())
      await pool.flush()
      return { value: outcome.value, tried }
    }
    pool.report(record.id, outcome.kind, now())
    last = { kind: outcome.kind, message: outcome.message, status: outcome.status, accountId: record.id }
    if (!isAccountScoped(outcome.kind)) {
      // The pool cannot help: every other account would fail the same way, so
      // walking it would multiply one error by the pool size.
      await pool.flush()
      return { tried, failure: last }
    }
  }

  await pool.flush()
  return last === undefined ? { tried } : { tried, failure: last }
}
