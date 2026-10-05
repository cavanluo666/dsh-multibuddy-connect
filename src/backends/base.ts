/**
 * Shared scaffolding for the merged backends.
 *
 * Every backend differs in HOW it finds an account, but they agree on the
 * shape of the answer and on a set of failure rules that are easy to get wrong
 * once per backend. This module holds exactly those parts, so a backend file
 * is a description of its product rather than a repetition of the boilerplate.
 *
 * THE RULES ENCODED HERE, and why each one earns its place:
 *
 *  1. A missing prerequisite is NOT an error. "Loomy is not installed" is the
 *     state of most machines for most backends; reporting it as a failure would
 *     fill the log with alarming noise on every startup and bury the one
 *     backend that genuinely broke.
 *
 *  2. A backend's failure is CONTAINED. Nine backends now start with the
 *     plugin. If one throws — a corrupt credential, a vendor's format change —
 *     the other eight must still register, and the failure must be visible as
 *     THAT backend's state. Hence every resolve is wrapped.
 *
 *  3. Nothing here ever writes to a third-party application. The
 *     desktop-adoption backends read another program's files; the plugin's
 *     contract is that it only reads. A backend that wrote would break the
 *     application's own login, which is a far worse outcome than not working.
 *
 *  4. Accounts are never invented. A backend with no stored credential reports
 *     zero accounts, not a placeholder one. A phantom account would show up in
 *     the usage dashboard as a row that can never have usage.
 *
 * @module dsh-workbuddy-connect/backends/base
 */

import type { BackendAccount, BackendAdapter, BackendAvailability, BackendDescriptor, BackendModelInfo, BackendTransport, QuotaReading } from './types.ts'

/** Why a backend declared itself unavailable, in the user's terms. */
export interface UnavailableHint {
  /** One actionable sentence: what to install or sign in to. */
  hint: string
}

/**
 * A backend's product-specific half.
 *
 * Subclasses implement these four; {@link BaseBackendAdapter} supplies the
 * containment, the caching, and the account bookkeeping around them.
 */
export interface BackendImpl {
  /**
   * Find the accounts currently available.
   *
   * Return an empty array for "installed, but nobody is signed in" — the base
   * class turns that into `signed-out`. Throw ONLY for a genuine fault; throw
   * {@link BackendUnavailable} to report a missing prerequisite as the distinct
   * state it is.
   */
  discover(): Promise<readonly DiscoveredAccount[]>
  /** Read one account's quota; return `unavailable` when the vendor has none. */
  quota?(accountId: string): Promise<QuotaReading>
  /** The models this backend currently serves for one account. */
  models?(accountId: string): Promise<readonly BackendModelInfo[]>
  /**
   * The OpenAI-compatible transport, when this backend has one.
   *
   * Optional so a backend that cannot serve chat requests simply omits it; the
   * base class then answers undefined and the shell registers no provider for
   * it, rather than one that fails on the first message.
   */
  transport?(accountId: string): Promise<BackendTransport | undefined>
  /** Release held resources. */
  dispose?(): Promise<void>
}

/** One account a backend's `discover` found, before the base class wraps it. */
export interface DiscoveredAccount {
  id: string
  label: string
  detail?: string
  /** Defaults to true; set false when the credential is present but expired. */
  usable?: boolean
  reason?: string
}

/**
 * Thrown by a backend to report a missing prerequisite as `unavailable`
 * rather than `failed`.
 *
 * An exception rather than a return value because the check usually happens
 * deep inside a probe (a file that must exist for the parse to continue), and
 * threading an optional result back through every layer is the kind of
 * plumbing that gets skipped in one place and reports a wrong state.
 */
export class BackendUnavailable extends Error {
  constructor(readonly hint: string) {
    super(hint)
    this.name = 'BackendUnavailable'
  }
}

/**
 * The base class every merged backend extends.
 *
 * Holds the resolved availability so a caller can ask repeatedly (the card
 * re-renders, the dashboard refreshes) without re-reading the disk each time,
 * and exposes `refresh` for when a re-read is actually wanted.
 */
export abstract class BaseBackendAdapter implements BackendAdapter {
  /** Last resolved state; undefined until the first resolve. */
  private availability: BackendAvailability | undefined
  /** The accounts currently known, keyed by id, for quota/model lookups. */
  private accounts = new Map<string, BackendAccount>()

  constructor(
    readonly descriptor: BackendDescriptor,
    private readonly impl: BackendImpl,
  ) {}

  /**
   * Resolve accounts, containing every failure mode.
   *
   * Never throws: the shell starts all backends together and one bad backend
   * must not take the plugin down. The failure is reported as this backend's
   * own state instead.
   *
   * @param force - re-read from the source rather than answering from cache.
   */
  async resolveAccounts(force = false): Promise<BackendAvailability> {
    if (!force && this.availability !== undefined) return this.availability
    let next: BackendAvailability
    try {
      const discovered = await this.impl.discover()
      next = discovered.length === 0
        ? { state: 'signed-out' }
        : { state: 'ready', accounts: discovered.map(toAccount) }
    } catch (error: unknown) {
      if (error instanceof BackendUnavailable) {
        next = { state: 'unavailable', hint: error.hint }
      } else {
        next = { state: 'failed', message: messageOf(error) }
      }
    }
    this.availability = next
    this.accounts = new Map(next.state === 'ready' ? next.accounts.map(account => [account.id, account]) : [])
    return next
  }

  /** The cached availability, resolving once if it has never been read. */
  async current(): Promise<BackendAvailability> {
    return this.availability ?? this.resolveAccounts()
  }

  /** The accounts known from the last resolve. */
  knownAccounts(): readonly BackendAccount[] {
    return [...this.accounts.values()]
  }

  /**
   * Read one account's quota.
   *
   * A backend with no billing endpoint answers `unavailable` without being
   * asked — the descriptor already knows, and a per-call failure would be
   * reported as a transient error for what is a permanent property.
   */
  async readQuota(accountId: string): Promise<QuotaReading> {
    if (!this.descriptor.reportsQuota) {
      return { kind: 'unavailable', reason: `${this.descriptor.displayName} 不提供额度查询` }
    }
    if (this.impl.quota === undefined) {
      return { kind: 'unavailable', reason: `${this.descriptor.displayName} 不提供额度查询` }
    }
    try {
      return await this.impl.quota(accountId)
    } catch (error: unknown) {
      return { kind: 'error', message: messageOf(error) }
    }
  }

  /**
   * The backend's OpenAI-compatible transport, when it has one.
   *
   * Failures are contained the same way discovery is: a transport that cannot
   * be built leaves the backend unreachable rather than taking the plugin down,
   * and undefined tells the shell to register no provider.
   */
  async transport(accountId: string): Promise<BackendTransport | undefined> {
    if (this.impl.transport === undefined) return undefined
    try {
      const transport = await this.impl.transport(accountId)
      return transport === undefined ? undefined : transport
    } catch {
      return undefined
    }
  }

  /** List models, degrading to an empty roster rather than failing the card. */
  async listModels(accountId: string): Promise<readonly BackendModelInfo[]> {
    if (this.impl.models === undefined) return []
    try {
      return await this.impl.models(accountId)
    } catch {
      // An empty roster is how the shell shows "registered but nothing to
      // offer", which is also the honest answer when the catalog is unreadable.
      return []
    }
  }

  /** Release the backend's own resources, then drop cached state. */
  async dispose(): Promise<void> {
    try {
      await this.impl.dispose?.()
    } finally {
      this.availability = undefined
      this.accounts = new Map()
    }
  }
}

/** Wrap a discovered account into the public shape, defaulting `usable`. */
function toAccount(discovered: DiscoveredAccount): BackendAccount {
  return {
    id: discovered.id,
    label: discovered.label,
    ...(discovered.detail === undefined ? {} : { detail: discovered.detail }),
    usable: discovered.usable !== false,
    ...(discovered.reason === undefined ? {} : { reason: discovered.reason }),
  }
}

/** A readable message from an unknown thrown value. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}
