/**
 * The multi-backend configuration wire contract, shared by the host and the
 * browser half.
 *
 * Lives beside `status-paths.ts` and `usage-paths.ts` for the reason both of
 * those do: the two halves are bundled independently, so a route named in one
 * place and spelled differently in the other fails only at runtime, in a
 * browser, for the user.
 *
 * WHAT THIS SURFACE IS FOR, and the one thing it must not do. The merged
 * backends differ in whether the plugin can configure them at all:
 *
 *  - an `api-key` backend (Cline, Command Code) can genuinely be configured
 *    here — the plugin owns the credential, so it can add, list and remove
 *    accounts;
 *  - a `desktop-adoption` backend (Trae, Qoder, CodeBuddy, MiMo, Loomy) reads
 *    ANOTHER application's single login slot. There is nothing to write, so the
 *    card reports status and guidance and offers no "add account" control — a
 *    button with nothing behind it is worse than no button;
 *  - a `managed-runtime` backend (OpenCode) reports whether its runtime is
 *    prepared.
 *
 * `configurable` carries that distinction to the browser so the UI can render
 * the difference rather than guess it from `authKind`.
 *
 * SECRETS NEVER TRAVEL BACK. The host sends `secretMasked` (a short prefix and
 * suffix, for identifying which key is which) and never the stored value. The
 * browser may only SEND a new secret when adding or replacing one.
 *
 * @module dsh-multibuddy-connect/backends-paths
 */

/** Same-origin route serving the backend catalogue and its account status. */
export const WORKBUDDY_BACKENDS_PATH = '/plugins/dsh-workbuddy-connect/backends'

/**
 * Same-origin route accepting configuration writes.
 *
 * Separate from the read route for the same reason the usage action route is:
 * a state-changing endpoint must not be reachable through the unauthenticated
 * GET a page can be tricked into issuing. It therefore also requires the
 * in-process key the document hands the browser.
 */
export const WORKBUDDY_BACKENDS_ACTION_PATH = '/plugins/dsh-workbuddy-connect/backends/action'

/** How a backend obtains credentials; mirrors the host-side vocabulary. */
export type BackendsWebAuthKind =
  | 'device-code'
  | 'api-key'
  | 'desktop-adoption'
  | 'managed-runtime'

/** One account, as the browser may see it. */
export interface BackendsWebAccount {
  /** Backend-local id; the key for add/remove. */
  id: string
  /** Human label. */
  label: string
  /** Masked identity detail, when the backend has one. */
  detail?: string
  /** Whether the credential is currently usable. */
  usable: boolean
  /** Why it is unusable, when it is. */
  reason?: string
}

/** One stored account of a configurable backend. */
export interface BackendsWebStoredAccount {
  id: string
  label: string
  /** The secret with everything but a short prefix and suffix replaced. */
  secretMasked: string
  updatedAtMs: number
}

/** One backend's row in the configuration card. */
export interface BackendsWebEntry {
  id: string
  displayName: string
  description?: string
  /** Vendor name, for grouping and the section subtitle. */
  vendor?: string
  authKind: BackendsWebAuthKind
  /** Whether several independent accounts can exist for this backend. */
  multiAccount: boolean
  /** Whether the backend can report a remaining balance. */
  reportsQuota: boolean
  /**
   * Whether this plugin can WRITE accounts for the backend.
   *
   * False for desktop-adoption and managed-runtime backends, where the
   * credential belongs to another program. The card uses this to decide
   * between an account manager and a status line, so it never renders a
   * control that cannot work.
   */
  configurable: boolean
  /** Resolved availability: `ready`, `signed-out`, `unavailable`, `failed`. */
  state: 'ready' | 'signed-out' | 'unavailable' | 'failed'
  /** Actionable instruction for `unavailable`. */
  hint?: string
  /** Failure detail for `failed`. */
  message?: string
  /** Accounts discovered from the credential source (read-only view). */
  accounts: readonly BackendsWebAccount[]
  /** Accounts this plugin stores, for `configurable` backends only. */
  stored: readonly BackendsWebStoredAccount[]
  /**
   * The environment variable consulted when no account is configured.
   *
   * Shown so a user who already exports it understands why the backend works
   * without any configuration, and does not create a duplicate account.
   */
  envHint?: string
}

/** One backend that could not be constructed at all. */
export interface BackendsWebFailure {
  id: string
  message: string
}

/** The document the configuration card renders. */
export interface BackendsWebDocument {
  backends: readonly BackendsWebEntry[]
  /**
   * Backends whose module failed to load or construct.
   *
   * Carried separately from `backends` because there is no descriptor to
   * describe them with — the entry never got far enough to have one. Reporting
   * them is still the right thing: a group that silently does not appear is
   * indistinguishable from one that was never merged in.
   */
  failures?: readonly BackendsWebFailure[]
  /**
   * In-process key authorizing writes. Travels with the document for the same
   * reason the probe and login keys do: the card is same-origin and already had
   * to pass the loopback guard, and the key is never persisted.
   */
  actionKey?: string
}

/** One write the action route accepts. */
export interface BackendsWebAction {
  /**
   * `add-account` stores (or replaces) an account;
   * `remove-account` drops one;
   * `refresh` re-resolves every backend's accounts.
   */
  action: 'add-account' | 'remove-account' | 'refresh'
  /** Target backend; required for the two account actions. */
  backendId?: string
  /** Target account id; required for `remove-account`. */
  accountId?: string
  /** Display label for a new account; defaults to the backend's own name. */
  label?: string
  /** The secret itself; required for `add-account`. */
  secret?: string
}

/** The route's answer to a write. */
export interface BackendsWebActionResult {
  ok: boolean
  message?: string
}
