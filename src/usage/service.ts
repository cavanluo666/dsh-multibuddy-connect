/**
 * The host-side usage service: assembles the dashboard document from the
 * ledger and every backend's live balance.
 *
 * Sits between three things that know nothing about each other — the backends
 * (which report quota in their own vocabulary), the ledger (which knows tokens
 * but not products), and the browser (which wants one document). Its whole job
 * is to join them without letting either side's assumptions leak into the
 * other.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never invents a figure. A backend that
 * cannot report a balance contributes an `unavailable` reading, and an account
 * with no ledger history contributes zeros. Both are distinct from missing
 * data, and the page renders them differently.
 *
 * @module dsh-workbuddy-connect/usage/service
 */

import type { BackendAdapter, BackendId, QuotaReading } from '../backends/types.ts'
import type { BackendLoadFailure } from '../backends/catalog.ts'
import { UsageLedger } from './ledger.ts'
import { buildUsageSummary, DEFAULT_WINDOW_DAYS, type UsageAccountInput } from './summary.ts'
import type { UsageWebDocument } from '../usage-paths.ts'

/** Constructor options for the service. */
export interface UsageServiceOptions {
  /** The backends to report on; the same instances the shell registered. */
  backends: () => readonly BackendAdapter[]
  /** Backends that failed to build, reported rather than hidden. */
  failures?: () => readonly BackendLoadFailure[]
  /** The ledger to read. */
  ledger: UsageLedger
  /**
   * The in-process action key handed to the browser with the document.
   *
   * A function rather than a value because the shell mints it once per process
   * and the service is rebuilt on every settings write; capturing it here would
   * pin a stale key after the first reload.
   */
  actionKey: () => string
}

/**
 * What is known about one account's balance.
 *
 * Keeps the last GOOD reading and the last FAILURE separately rather than
 * collapsing them into one slot. The two answer different questions — "how much
 * do I have" and "is my data current" — and a single field forces the page to
 * choose between showing a stale number as if it were fresh, or hiding a number
 * the user can still act on. With both, the page shows the last known balance
 * AND marks it stale with the reason.
 */
interface CachedQuota {
  /** The last reading that actually succeeded, if any. */
  lastGood?: { reading: QuotaReading; fetchedAtMs: number }
  /** The last failure, cleared by any later success. */
  lastError?: { message: string; failedAtMs: number }
}

/**
 * Attach a staleness notice to a reading without losing its figure.
 *
 * Only the balance arm can carry the note: it is the only reading whose value
 * survives as a plain number the page renders beside the warning. A packages
 * reading is left untouched — its bars are already labelled with their own
 * fetch time — and the other two arms carry no figure to keep.
 *
 * @param reading - the last good reading.
 * @param reason - why the latest refresh failed.
 * @returns the reading, annotated when it can be.
 */
function withStaleNote(reading: QuotaReading, reason: string): QuotaReading {
  if (reading.kind !== 'balance') return reading
  return { ...reading, staleReason: reason }
}

/**
 * Decide what to report for one account from its cached state.
 *
 * Three cases, and the distinction matters to the page:
 *
 *  - nothing cached yet: report nothing, so the row says "not read yet"
 *    rather than "zero";
 *  - only a failure ever: report the error, because there is no figure to show
 *    and pretending otherwise would render an empty balance;
 *  - a good reading, with or without an outstanding failure: report the
 *    FIGURE, annotated with the failure when there is one. Losing the number
 *    to a transient error is the behaviour that makes a dashboard useless.
 *
 * @param cached - this account's cached state.
 * @returns the reading to publish, or undefined to publish none.
 */
function effectiveReading(cached: CachedQuota | undefined): { reading: QuotaReading; fetchedAtMs: number } | undefined {
  if (cached?.lastGood === undefined) {
    if (cached?.lastError === undefined) return undefined
    return {
      reading: { kind: 'error', message: cached.lastError.message },
      fetchedAtMs: cached.lastError.failedAtMs,
    }
  }
  if (cached.lastError === undefined) {
    return { reading: cached.lastGood.reading, fetchedAtMs: cached.lastGood.fetchedAtMs }
  }
  return {
    reading: withStaleNote(cached.lastGood.reading, cached.lastError.message),
    fetchedAtMs: cached.lastGood.fetchedAtMs,
  }
}

export class UsageService {
  /** Last good quota per `backendId\u0000accountId`, for the refresh path. */
  private readonly quotaCache = new Map<string, CachedQuota>()
  /** The dashboard window, in days. */
  private windowDays = DEFAULT_WINDOW_DAYS

  constructor(private readonly options: UsageServiceOptions) {}

  /**
   * The in-process key authorizing writes on this service's routes.
   *
   * Exposed rather than kept private because the route must compare the
   * presented header against the SAME key the document handed the browser. If
   * the route minted its own, every write would 403 while the page showed a
   * correctly-rendered dashboard — a failure mode that looks like a UI bug.
   */
  actionKey(): string {
    return this.options.actionKey()
  }

  /** The current window size in days. */
  currentWindowDays(): number {
    return this.windowDays
  }

  /**
   * Set the window, clamped to a sane range.
   *
   * The clamp is not cosmetic: the document materialises one point per day, and
   * an unclamped value from a crafted request would allocate an array of
   * millions and hang the host. One year is the useful maximum.
   */
  setWindowDays(days: number): void {
    if (!Number.isFinite(days)) return
    this.windowDays = Math.min(3650, Math.max(1, Math.floor(days)))
  }

  /**
   * Build the dashboard document.
   *
   * Reads cached quota rather than fetching, so a page load never blocks on a
   * slow vendor endpoint. {@link refreshQuotas} is the explicit way to fetch.
   *
   * @param nowMs - the moment to build for; injected for tests.
   * @returns the document the browser renders.
   */
  async document(nowMs: number = Date.now()): Promise<UsageWebDocument> {
    const inputs: UsageAccountInput[] = []
    for (const backend of this.options.backends()) {
      const availability = await backend.current()
      if (availability.state !== 'ready') continue
      for (const account of availability.accounts) {
        const cached = this.quotaCache.get(`${backend.descriptor.id}\u0000${account.id}`)
        const effective = effectiveReading(cached)
        inputs.push({
          backendId: backend.descriptor.id,
          backendName: backend.descriptor.displayName,
          authKind: backend.descriptor.authKind,
          accountId: account.id,
          accountLabel: account.label,
          ...(account.detail === undefined ? {} : { accountDetail: account.detail }),
          usable: account.usable,
          ...(account.reason === undefined ? {} : { reason: account.reason }),
          ...(effective === undefined ? {} : { quota: effective.reading, quotaFetchedAtMs: effective.fetchedAtMs }),
        })
      }
    }
    const rows = this.options.ledger.all()
    const summary = buildUsageSummary(inputs, rows, { windowDays: this.windowDays, nowMs })
    const failures = this.options.failures?.() ?? []
    return {
      fromDay: summary.fromDay,
      toDay: summary.toDay,
      accounts: summary.accounts.map(account => ({
        backendId: account.backendId,
        backendName: account.backendName,
        authKind: account.authKind,
        accountId: account.accountId,
        accountLabel: account.accountLabel,
        ...(account.accountDetail === undefined ? {} : { accountDetail: account.accountDetail }),
        usable: account.usable,
        ...(account.reason === undefined ? {} : { reason: account.reason }),
        ...(account.quota === undefined ? {} : { quota: account.quota }),
        ...(account.quotaFetchedAtMs === undefined ? {} : { quotaFetchedAtMs: account.quotaFetchedAtMs }),
        windowTokens: account.windowTokens,
        todayTokens: account.todayTokens,
        windowCalls: account.windowCalls,
      })),
      days: summary.days.map(day => ({ day: day.day, tokens: day.tokens, calls: day.calls })),
      backends: summary.backends.map(total => ({
        backendId: total.backendId,
        backendName: total.backendName,
        windowTokens: total.windowTokens,
        windowCalls: total.windowCalls,
        share: total.share,
      })),
      windowTotals: summary.windowTotals,
      windowCalls: summary.windowCalls,
      todayTotals: summary.todayTotals,
      anyQuota: summary.anyQuota,
      hasHistory: summary.hasHistory,
      ...(failures.length === 0 ? {} : { failures }),
      actionKey: this.options.actionKey(),
      windowDays: this.windowDays,
    }
  }

  /**
   * Re-read every ready account's balance.
   *
   * Sequential rather than concurrent on purpose: these are different vendors'
   * endpoints, several are rate-limited, and a burst of simultaneous requests
   * from one user action is the pattern that gets a client throttled. The page
   * waits for one refresh, not for nine parallel ones.
   *
   * A failure for one account leaves its previous reading in place — a transient
   * network error must not blank a balance that was correct a minute ago.
   *
   * @returns how many accounts were read successfully.
   */
  async refreshQuotas(): Promise<number> {
    let succeeded = 0
    for (const backend of this.options.backends()) {
      const availability = await backend.current()
      if (availability.state !== 'ready') continue
      for (const account of availability.accounts) {
        const key = `${backend.descriptor.id}\u0000${account.id}`
        const now = Date.now()
        const reading = await backend.readQuota(account.id)
        const entry = this.quotaCache.get(key) ?? {}
        if (reading.kind === 'error') {
          // The failure is recorded WITHOUT discarding the last good figure, so
          // the page keeps showing a balance the user can still act on while
          // saying plainly that the refresh did not land.
          entry.lastError = { message: reading.message, failedAtMs: now }
          this.quotaCache.set(key, entry)
          continue
        }
        entry.lastGood = { reading, fetchedAtMs: now }
        // A success clears the outstanding error: the staleness is over.
        delete entry.lastError
        this.quotaCache.set(key, entry)
        succeeded += 1
      }
    }
    return succeeded
  }

  /** Drop the locally metered history. */
  async clearLedger(): Promise<void> {
    await this.options.ledger.clear()
  }

  /** Seed the cache from a reading taken elsewhere, for tests and warm starts. */
  seedQuota(backendId: BackendId, accountId: string, reading: QuotaReading, fetchedAtMs: number = Date.now()): void {
    this.quotaCache.set(`${backendId}\u0000${accountId}`, { lastGood: { reading, fetchedAtMs } })
  }
}
