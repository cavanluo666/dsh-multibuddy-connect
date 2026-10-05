/**
 * The multi-backend descriptor: one row per third-party product this plugin
 * serves, and the seam every backend adapter implements.
 *
 * The plugin started life as WorkBuddy-only, with two rows in
 * `WORKBUDDY_VARIANTS` that differed in realm, endpoint, and display identity.
 * Merging nine unrelated products in does NOT mean teaching that descriptor
 * nine dialects: the WorkBuddy variants keep their own shape (they are the
 * compatibility anchor and are untouched), and every third-party backend is
 * described HERE instead.
 *
 * The split is deliberate. A WorkBuddy variant can assume a plugin-owned
 * credential file, a device-authorization sign-in, and the shared WorkBuddy
 * upstream client. A merged backend can assume NONE of those: it may read a
 * desktop app's read-only login state (Qoder, Trae, MiMo, Loomy, CodeBuddy),
 * take an API key (Command Code, Cline), or own no credential at all and
 * manage a child runtime instead (the OpenCode pair). What they genuinely
 * share is the *shape of the job*:
 *
 *   1. resolve zero or more accounts,
 *   2. report each account's remaining quota/credit for the usage dashboard,
 *   3. hand the harness a model roster.
 *
 * Those three become {@link BackendAdapter}. Everything else — wire protocol,
 * credential decryption, catalog discovery — stays inside the backend's own
 * directory under `backends/`, so a backend can be upgraded or even dropped
 * without the host shell noticing.
 *
 * @module dsh-workbuddy-connect/backends/types
 */

/** Stable backend id; also the DSH provider id and the route prefix. */
export type BackendId = string

/**
 * How a backend obtains its credentials, which is what decides whether the
 * generic sign-in card can drive it.
 *
 * The distinction is not cosmetic. `device-code` and `api-key` can be started
 * from the browser card because the plugin owns the whole exchange; the other
 * two are read from a third-party application and can only ever be reported,
 * never initiated — a fact the UI must state rather than offer a dead button
 * for.
 */
export type BackendAuthKind =
  /**
   * An OAuth-style device/browser authorization this plugin performs itself.
   * The only kind where "sign in" is a real action the card can start.
   */
  | 'device-code'
  /** A bearer key the user supplies (environment variable or pasted value). */
  | 'api-key'
  /**
   * Read-only adoption of a desktop application's stored login state.
   *
   * The plugin never writes to the application and cannot start a sign-in:
   * the user must sign in *in the app*, then the plugin picks the state up.
   * This is the majority kind after the merge, which is why the card wording
   * matters — a "sign in" button here would be a lie.
   */
  | 'desktop-adoption'
  /**
   * No plugin-owned credential: the backend manages its own runtime/session.
   */
  | 'managed-runtime'

/** Which product a backend belongs to, for grouping in the UI. */
export interface BackendBrand {
  /** Vendor name as users know it, e.g. 讯飞, 小米. */
  vendor?: string
  /** Product line, when a vendor ships several, e.g. `Qoder CN`. */
  product?: string
}

/**
 * One backend's static description.
 *
 * Static means "known before any credential is read". Anything that requires
 * I/O belongs to the runtime state instead, so the shell can render a complete
 * catalogue of backends — including ones that are not installed — without
 * touching a disk or a network.
 */
export interface BackendDescriptor {
  /** Provider id registered with DSH, e.g. `qoder-cn`. */
  id: BackendId
  /** Heading in the model picker and the settings card, e.g. `Qoder CN`. */
  displayName: string
  /** One line shown under the heading in the backend list. */
  description?: string
  brand?: BackendBrand
  /** How this backend's credentials come to exist; drives the card's controls. */
  authKind: BackendAuthKind
  /**
   * Whether one installation can hold SEVERAL independent accounts.
   *
   * True only where the backend's own credential model supports it (Command
   * Code's `accounts` dictionary, Trae's token list, Qoder's two regions).
   * For the desktop-adoption backends this is false and cannot be made true:
   * the source is another application's single login slot, so "add account"
   * would have nothing to write to. Reporting it honestly is what keeps the
   * usage dashboard from offering an impossible affordance.
   */
  multiAccount: boolean
  /**
   * Whether this backend can report remaining quota/credit.
   *
   * False for backends whose upstream exposes no billing endpoint at all; the
   * usage dashboard then shows the account with an explicit "not reportable"
   * state rather than a zero that reads as "nothing left".
   */
  reportsQuota: boolean
  /**
   * Whether this backend reports token-level usage of its own.
   *
   * Almost always false — only the harness-native meters do — which is exactly
   * why the plugin keeps its own ledger (see `usage/ledger.ts`). Recorded here
   * so the dashboard can mark a figure as upstream-reported or locally metered.
   */
  reportsTokenUsage: boolean
  /** Settings namespace this backend's card writes to. */
  settingsNs: string
  /** Whether the backend needs a child process / download to function. */
  managesRuntime?: boolean
}

/** A backend's availability, determined at startup. */
export type BackendAvailability =
  /** Usable now; at least one account resolved. */
  | { state: 'ready'; accounts: readonly BackendAccount[] }
  /** Installed and supported, but no account is signed in yet. */
  | { state: 'signed-out'; hint?: string }
  /**
   * The prerequisite is absent — the desktop app is not installed, or the
   * runtime could not be prepared. `hint` is the actionable instruction.
   */
  | { state: 'unavailable'; hint: string }
  /** Startup failed; contained so it cannot take the plugin down. */
  | { state: 'failed'; message: string }

/**
 * One resolved account belonging to a backend.
 *
 * An account is identified by `id` within its backend, and the pair
 * `(backendId, id)` is the key every other structure uses — the ledger, the
 * quota cache, and the UI selection all agree on it.
 */
export interface BackendAccount {
  /** Backend-local stable id, e.g. a uid or a configured account name. */
  id: string
  /** Human label for pickers, e.g. a nickname or a masked phone number. */
  label: string
  /** Masked/derived identity detail, safe to render. */
  detail?: string
  /** Whether this account's credential is currently usable. */
  usable: boolean
  /** Why it is unusable, when it is. */
  reason?: string
}

/**
 * One quota reading.
 *
 * Modelled on WorkBuddy's own credit document so the existing bar renderer
 * (and its merge/visibility rules in `client/quota-merge.ts`) applies
 * unchanged: a backend that reports packages reports them as packages, and one
 * that reports a single figure reports one package.
 */
export type QuotaReading =
  /** Per-package credit, the WorkBuddy-shaped reading. */
  | {
    kind: 'packages'
    total: number
    totalSize?: number
    unlimited?: true
    cycleResetTime?: string
    packages: readonly QuotaPackage[]
  }
  /** A single scalar balance with its own unit (credits, points, CNY). */
  | {
    kind: 'balance'
    /** Remaining amount. */
    remain: number
    /** Unit shown next to the figure. */
    unit: string
    /** The period's original grant, when the backend states one. */
    size?: number
    resetAt?: string
    /**
     * Why the latest refresh failed while this figure is still the last known
     * good one.
     *
     * Set by the usage service rather than by a backend: a backend reports one
     * reading, and only the service knows that a NEWER attempt failed. The page
     * renders the figure and this note together — hiding the number would lose
     * information the user can act on, and hiding the note would present a
     * stale balance as current.
     */
    staleReason?: string
  }
  /** The backend has no billing endpoint; the UI says so instead of showing 0. */
  | { kind: 'unavailable'; reason: string }
  /** Reading it failed this time; the previous good reading may still show. */
  | { kind: 'error'; message: string }

/** One package inside a `packages` reading. */
export interface QuotaPackage {
  packageName: string
  remain: number
  size: number
  unlimited?: true
  packageEndTime?: string
}

/** One model a backend offers, in the shell's neutral vocabulary. */
export interface BackendModelInfo {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  supportsImages?: boolean
  /** Reasoning-effort ids this model accepts, when the backend declares any. */
  efforts?: readonly string[]
  /** Billing convenience fact, e.g. `x0.79`, 免费. */
  rate?: string
}

/**
 * Remaining quota for one account, as the dashboard shows it.
 *
 * Carries the reading AND its provenance: a figure whose backend cannot report
 * quota must render as "not reportable" rather than as the zero it would
 * otherwise be mistaken for.
 */
export interface BackendQuota {
  backendId: BackendId
  accountId: string
  /** When this reading was taken, epoch ms. */
  fetchedAtMs: number
  reading: QuotaReading
}

/**
 * The seam a merged backend implements.
 *
 * Deliberately small. A backend owns its credentials, its catalog, and its
 * upstream transport; the shell owns registration, the usage ledger, and the
 * UI. Nothing here mentions WorkBuddy, and nothing in WorkBuddy's own variant
 * path was changed to accommodate it.
 */
export interface BackendAdapter {
  readonly descriptor: BackendDescriptor
  /**
   * Resolve the accounts currently available, without mutating anything.
   *
   * Called at startup and on every manual refresh. Must NOT throw for the
   * ordinary "nothing is signed in" case — return `signed-out` instead, since
   * a missing desktop login is a normal state, not a failure.
   */
  resolveAccounts(): Promise<BackendAvailability>
  /**
   * The accounts as they stand right now, resolving once if never read.
   *
   * Distinct from {@link resolveAccounts} because the two answer different
   * questions: `resolveAccounts` is "go and find out", `current` is "tell me
   * what you already know". Consumers that render — the usage dashboard, the
   * settings card — want the cheap one: a page load must not re-probe nine
   * vendor filesystems on every request. The base class satisfies it by
   * caching; another implementation is free to answer however it likes.
   */
  current(): Promise<BackendAvailability>
  /** Read one account's remaining quota; `unavailable` when not supported. */
  readQuota(accountId: string): Promise<QuotaReading>
  /**
   * The model roster this backend currently serves for one account.
   *
   * Empty is a legitimate answer — it means the backend registers the provider
   * but shows no models (the sign-in-after-startup case).
   */
  listModels(accountId: string): Promise<readonly BackendModelInfo[]>
  /** Release anything the adapter holds (child processes, shims, watchers). */
  dispose?(): Promise<void>
}
