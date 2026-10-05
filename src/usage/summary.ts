/**
 * The usage aggregation layer: one document answering "what do I have and what
 * have I spent", across every backend and every account.
 *
 * This is the (a)+(b) join the dashboard renders. The two halves come from
 * different places and must NOT be conflated:
 *
 *  - (a) REMAINING quota is UPSTREAM truth, fetched per account from whatever
 *    billing endpoint the backend has. It is a snapshot with an age.
 *  - (b) SPENT tokens are LOCAL truth, folded from the ledger by this plugin.
 *
 * Keeping them apart in the document — two sections, two provenance notes —
 * is what stops the page from implying a relationship it cannot prove. The
 * plugin cannot convert one into the other: a subscription backend's "1200
 * credits left" and its "412k tokens today" are not two views of one quantity,
 * and a page that summed them would be inventing a number.
 *
 * The section types are plain data with no harness dependency, so the browser
 * half can consume them and the Node tests can build them without a host.
 *
 * @module dsh-workbuddy-connect/usage/summary
 */

import type { BackendAuthKind, BackendId, QuotaReading } from '../backends/types.ts'
import { dailySeries, localDay, totalTokens, type LedgerRow, type TokenBuckets } from './ledger.ts'

/** How far back the default window reaches. */
export const DEFAULT_WINDOW_DAYS = 30

/** One account's row in the dashboard. */
export interface UsageAccountRow {
  backendId: BackendId
  /** Backend display name, resolved by the caller so this module stays static. */
  backendName: string
  /** How this account's credential comes to exist; drives the row's controls. */
  authKind: BackendAuthKind
  accountId: string
  accountLabel: string
  accountDetail?: string
  /** Whether the credential is currently usable. */
  usable: boolean
  /** Why not, when it is not. */
  reason?: string
  /**
   * Remaining quota, or undefined when the backend reports none.
   *
   * Undefined is NOT zero: the row renders "不提供额度查询" rather than an empty
   * bar, because an empty bar means "you have nothing left" and would be a lie.
   */
  quota?: QuotaReading
  /** When the quota reading was taken, when there is one. */
  quotaFetchedAtMs?: number
  /** Locally metered tokens for this account over the window. */
  windowTokens: TokenBuckets
  /** Locally metered tokens for this account today. */
  todayTokens: TokenBuckets
  /** Model calls metered over the window. */
  windowCalls: number
}

/** One point on the daily chart. */
export interface UsageDayPoint {
  day: string
  tokens: TokenBuckets
  calls: number
}

/** One backend's roll-up, for the chart legend and the totals row. */
export interface UsageBackendTotal {
  backendId: BackendId
  backendName: string
  windowTokens: TokenBuckets
  windowCalls: number
  /** Share of the window's total tokens, 0–1; 0 when nothing was spent. */
  share: number
}

/** The whole dashboard document. */
export interface UsageSummary {
  /** Window bounds, inclusive, as `YYYY-MM-DD` labels. */
  fromDay: string
  toDay: string
  /** Every account across every backend, in backend registration order. */
  accounts: readonly UsageAccountRow[]
  /** Daily totals across all backends. */
  days: readonly UsageDayPoint[]
  /** Per-backend roll-up for the same window. */
  backends: readonly UsageBackendTotal[]
  /** Window totals across all backends. */
  windowTotals: TokenBuckets
  windowCalls: number
  /** Today's totals across all backends. */
  todayTotals: TokenBuckets
  /**
   * Whether ANY account reported a usable quota.
   *
   * Drives whether the quota section renders at all: a machine with only
   * locally metered backends should show the token charts and say plainly that
   * no backend reports a balance, instead of an empty section that reads as a
   * loading failure.
   */
  anyQuota: boolean
  /**
   * Whether the ledger has ever recorded anything.
   *
   * Separates "you have not used this yet" from "the page is broken", which a
   * zero-filled chart cannot distinguish on its own.
   */
  hasHistory: boolean
}

/** One account's inputs to {@link buildUsageSummary}. */
export interface UsageAccountInput {
  backendId: BackendId
  backendName: string
  authKind: BackendAuthKind
  accountId: string
  accountLabel: string
  accountDetail?: string
  usable: boolean
  reason?: string
  quota?: QuotaReading
  quotaFetchedAtMs?: number
}

/** Zero buckets. */
function zeroBuckets(): TokenBuckets {
  return { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/** Add one bucket set into another, in place. */
function addInto(target: TokenBuckets, source: TokenBuckets): void {
  target.uncachedInput += source.uncachedInput
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
}

/**
 * Fold one account's rows into window and today figures.
 *
 * `windowFrom` and `today` are passed in rather than recomputed so every row
 * in one document agrees on the window even if the build straddles midnight.
 */
function foldAccount(rows: readonly LedgerRow[], windowFrom: string, today: string): { window: TokenBuckets; today: TokenBuckets; calls: number } {
  const window = zeroBuckets()
  const todayBuckets = zeroBuckets()
  let calls = 0
  for (const row of rows) {
    if (row.day >= windowFrom) {
      addInto(window, row.tokens)
      calls += row.calls
    }
    if (row.day === today) addInto(todayBuckets, row.tokens)
  }
  return { window, today: todayBuckets, calls }
}

/**
 * Build the dashboard document.
 *
 * Pure: every input is passed in, nothing is read from disk or the network, and
 * the same inputs always produce the same document. That is what lets the whole
 * page be tested without a host, a browser, or a clock.
 *
 * @param accounts - one input per resolved account, in display order.
 * @param rows - the ledger's rows.
 * @param options - window size and a fixed "now" for tests.
 * @returns the assembled document.
 */
export function buildUsageSummary(
  accounts: readonly UsageAccountInput[],
  rows: readonly LedgerRow[],
  options: { windowDays?: number; nowMs?: number } = {},
): UsageSummary {
  const nowMs = options.nowMs ?? Date.now()
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS
  const today = localDay(nowMs)
  // windowDays - 1 so a 30-day window is 30 calendar days INCLUDING today,
  // which is what a user reading "最近 30 天" expects.
  const fromDay = localDay(nowMs - (windowDays - 1) * 86_400_000)

  const byAccount = new Map<string, LedgerRow[]>()
  for (const row of rows) {
    const key = `${row.backendId}\u0000${row.accountId}`
    const list = byAccount.get(key)
    if (list === undefined) byAccount.set(key, [row])
    else list.push(row)
  }

  const accountRows: UsageAccountRow[] = accounts.map(account => {
    const key = `${account.backendId}\u0000${account.accountId}`
    const folded = foldAccount(byAccount.get(key) ?? [], fromDay, today)
    return {
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
      windowTokens: folded.window,
      todayTokens: folded.today,
      windowCalls: folded.calls,
    }
  })

  const days = dailySeries(rows, fromDay, today)

  // Per-backend roll-up, derived from the ACCOUNT rows so the chart totals and
  // the table totals can never disagree — they are folds of one array.
  const backendOrder: BackendId[] = []
  const backendTotals = new Map<BackendId, UsageBackendTotal>()
  for (const row of accountRows) {
    let total = backendTotals.get(row.backendId)
    if (total === undefined) {
      total = {
        backendId: row.backendId,
        backendName: row.backendName,
        windowTokens: zeroBuckets(),
        windowCalls: 0,
        share: 0,
      }
      backendTotals.set(row.backendId, total)
      backendOrder.push(row.backendId)
    }
    addInto(total.windowTokens, row.windowTokens)
    total.windowCalls += row.windowCalls
  }

  const windowTotals = zeroBuckets()
  let windowCalls = 0
  const todayTotals = zeroBuckets()
  for (const day of days) addInto(windowTotals, day.tokens)
  for (const day of days) {
    if (day.day === today) addInto(todayTotals, day.tokens)
  }
  for (const row of accountRows) windowCalls += row.windowCalls

  const grandTotal = totalTokens(windowTotals)
  const backends = backendOrder.map(id => {
    const total = backendTotals.get(id)!
    return {
      ...total,
      share: grandTotal > 0 ? totalTokens(total.windowTokens) / grandTotal : 0,
    }
  })

  return {
    fromDay,
    toDay: today,
    accounts: accountRows,
    days,
    backends,
    windowTotals,
    windowCalls,
    todayTotals,
    anyQuota: accountRows.some(row => row.quota !== undefined && row.quota.kind !== 'unavailable'),
    hasHistory: rows.length > 0,
  }
}
