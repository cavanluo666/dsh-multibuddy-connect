/**
 * The usage dashboard's wire contract, shared by the host and the browser half.
 *
 * Lives beside `status-paths.ts` and for the same reason: the two halves are
 * built independently, so a route named in one place and spelled differently in
 * the other fails only at runtime, in a browser, for the user. Both halves
 * import these literals instead.
 *
 * The types here are structurally identical to `usage/summary.ts` on purpose
 * rather than imported from it. That module is host-side and pulls in the
 * filesystem through the ledger; this one must stay free of Node built-ins so
 * the browser bundle can include it. The duplication is one direction only —
 * the host builds a document that satisfies THIS shape — and is checked by the
 * host-side type test rather than by a shared import that would drag Node into
 * the browser.
 *
 * @module dsh-workbuddy-connect/usage-paths
 */

/** Same-origin route serving the usage dashboard document. */
export const WORKBUDDY_USAGE_PATH = '/plugins/dsh-workbuddy-connect/usage'

/**
 * Same-origin route accepting usage-dashboard writes.
 *
 * Separate from the read route for the reason the probe route is separate from
 * the status route: `POST` here mutates state (refreshing quotas, clearing the
 * ledger), and a state-changing action must not be reachable by the same
 * unauthenticated GET a page can be tricked into issuing.
 */
export const WORKBUDDY_USAGE_ACTION_PATH = '/plugins/dsh-workbuddy-connect/usage/action'

/** The four disjoint token buckets, mirrored for the browser. */
export interface UsageWebTokens {
  uncachedInput: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * One account row, as rendered.
 *
 * `quota` carries the same discriminated union the host uses, so a row that
 * cannot report a balance says so instead of rendering as an empty bar.
 */
export interface UsageWebAccount {
  backendId: string
  backendName: string
  authKind: 'device-code' | 'api-key' | 'desktop-adoption' | 'managed-runtime'
  accountId: string
  accountLabel: string
  accountDetail?: string
  usable: boolean
  reason?: string
  quota?: UsageWebQuota
  quotaFetchedAtMs?: number
  windowTokens: UsageWebTokens
  todayTokens: UsageWebTokens
  windowCalls: number
}

/** One quota reading, as rendered. */
export type UsageWebQuota =
  | {
    kind: 'packages'
    total: number
    totalSize?: number
    unlimited?: true
    cycleResetTime?: string
    packages: readonly {
      packageName: string
      remain: number
      size: number
      unlimited?: true
      packageEndTime?: string
    }[]
  }
  | { kind: 'balance'; remain: number; unit: string; size?: number; resetAt?: string; staleReason?: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'error'; message: string }

/** One point on the daily chart. */
export interface UsageWebDay {
  day: string
  tokens: UsageWebTokens
  calls: number
}

/** One backend's roll-up. */
export interface UsageWebBackendTotal {
  backendId: string
  backendName: string
  windowTokens: UsageWebTokens
  windowCalls: number
  share: number
}

/** One backend that failed to build, shown so the user knows which one. */
export interface UsageWebFailure {
  id: string
  message: string
}

/** The whole document the usage page renders. */
export interface UsageWebDocument {
  /** Window bounds, inclusive, as `YYYY-MM-DD`. */
  fromDay: string
  toDay: string
  accounts: readonly UsageWebAccount[]
  days: readonly UsageWebDay[]
  backends: readonly UsageWebBackendTotal[]
  windowTotals: UsageWebTokens
  windowCalls: number
  todayTotals: UsageWebTokens
  anyQuota: boolean
  hasHistory: boolean
  /** Backends that could not be started, so a missing group is explained. */
  failures?: readonly UsageWebFailure[]
  /**
   * In-process key authorizing writes. Travels with the document for the same
   * reason the probe and login keys do: the card is same-origin and already
   * passed the loopback guard, and the key is never persisted.
   */
  actionKey?: string
  /** The window the document was built for, so the UI can offer to change it. */
  windowDays: number
}

/** One write the usage route accepts. */
export interface UsageWebAction {
  /**
   * `refresh-quotas` re-reads every account's balance;
   * `clear-ledger` drops the locally metered history;
   * `set-window` changes the dashboard's day range.
   */
  action: 'refresh-quotas' | 'clear-ledger' | 'set-window'
  /** Requested window size in days; required for `set-window`. */
  windowDays?: number
}

/** The route's answer to a write. */
export interface UsageWebActionResult {
  ok: boolean
  message?: string
}

/** Window sizes the UI offers. */
export const USAGE_WINDOW_CHOICES: readonly number[] = [7, 30, 90, 365]
