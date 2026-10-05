/**
 * Several sign-ins of ONE WorkBuddy product, exposed to the rest of the plugin
 * as if there were only one.
 *
 * THE COMPATIBILITY TRICK, and why it matters. Twelve call sites already do
 * \`runtime.store.current()\`, \`runtime.store.reresolve()\` and so on, and every
 * one of them means \"the account in effect\". Teaching all of them about a pool
 * would be a wide, risky change to the plugin's most load-bearing path. Instead
 * this manager OWNS N credential stores and hands the shell a \`store\` that
 * IS the active account's store, so those call sites keep working unchanged and
 * keep meaning exactly what they meant.
 *
 * The pool itself (cooldowns, selection order, failover) lives in \`pool.ts\`.
 * This module is the bridge: it maps pool records onto real stores, and it owns
 * the two operations a pool cannot perform on its own — ADDING an account (by
 * writing a new credential file) and REMOVING one.
 *
 * FIRST SLOT KEEPS THE HISTORICAL PATH. Account 0 lives at the variant's own
 * credential file, so an existing single-account install is already account 0
 * and an upgrade is not a sign-out.
 *
 * @module dsh-multibuddy-connect/account-manager
 */

import { WorkBuddyCredentialStore, type WorkBuddyCredential, type WorkBuddyStoreOptions } from './auth.ts'
import { WorkBuddyAccountPool, poolAccountPath, type PooledAccountRecord } from './pool.ts'
import type { WorkBuddyVariant } from './variants.ts'

/** How one credential store is built; supplied by the shell. */
export interface AccountManagerOptions {
  /** The variant these accounts belong to. */
  variant: WorkBuddyVariant
  /**
   * Performs the upstream token refresh, shared by every account.
   *
   * One refresher for the whole pool: it takes the credential as an argument, so
   * nothing about it is per-account.
   */
  refresh: WorkBuddyStoreOptions['refresh']
}

/** One account: its pool bookkeeping plus the store that holds its credential. */
export interface PooledAccount {
  record: PooledAccountRecord
  store: WorkBuddyCredentialStore
}

/**
 * The account set for one variant.
 *
 * Not a \`WorkBuddyCredentialStore\` subclass: the shell needs BOTH faces — the
 * pool (for failover and the card) and a store-shaped object (for the twelve
 * existing call sites) — and composition is how both can exist without either
 * pretending to be the other.
 */
export class WorkBuddyAccountManager {
  private readonly pool: WorkBuddyAccountPool
  private readonly accounts = new Map<string, PooledAccount>()
  private loaded = false

  constructor(private readonly options: AccountManagerOptions) {
    this.pool = new WorkBuddyAccountPool(options.variant.ownFilename)
  }

  /** The pool, for failover and the configuration card. */
  accountPool(): WorkBuddyAccountPool {
    return this.pool
  }

  /** Build a store for one slot, pointed at that slot's credential file. */
  private storeFor(slot: number): WorkBuddyCredentialStore {
    return new WorkBuddyCredentialStore({
      variant: this.options.variant,
      ownPath: poolAccountPath(this.options.variant.ownFilename, slot),
      refresh: this.options.refresh,
    })
  }

  /**
   * Discover the accounts already on disk and register them with the pool.
   *
   * Slots are probed in order until one is missing. Contiguous numbering is
   * what makes removal safe: slot N+1 is only ever read after slot N, so a gap
   * left by a deletion means the later slots are renumbered on the next
   * add rather than read at a stale position.
   *
   * @returns the accounts now known, in slot order.
   */
  async load(): Promise<readonly PooledAccount[]> {
    if (this.loaded) return this.all()
    this.loaded = true
    await this.pool.load()
    for (let slot = 0; slot < 64; slot += 1) {
      const store = this.storeFor(slot)
      let credential: WorkBuddyCredential | undefined
      try {
        credential = await store.current()
      } catch {
        // A credential for the OTHER realm throws here. It is not an account of
        // this variant, so it is skipped rather than reported as a failure.
        credential = undefined
      }
      if (credential === undefined) {
        // Slot 0 may legitimately be absent while later slots exist (the user
        // removed the first account); only stop once a run of empty slots shows
        // the numbering has ended.
        if (slot > 0 && !this.accounts.has(String(slot - 1))) break
        continue
      }
      const id = identityOf(credential)
      const account: PooledAccount = {
        record: freshRecord(id, labelOf(credential, this.options.variant), store.ownAuthPath()),
        store,
      }
      this.accounts.set(id, account)
      this.pool.upsert(account.record)
    }
    return this.all()
  }

  /** Every known account, in slot order. */
  all(): readonly PooledAccount[] {
    return [...this.accounts.values()]
  }

  /** Look one up by pool id. */
  get(id: string): PooledAccount | undefined {
    return this.accounts.get(id)
  }

  /**
   * The store the rest of the plugin should treat as \"the account\".
   *
   * Falls back to slot 0's store when no account has been discovered yet, so a
   * fresh install still has something to sign in to.
   */
  activeStore(): WorkBuddyCredentialStore {
    const active = this.pool.active()
    if (active !== undefined) {
      const account = this.accounts.get(active.id)
      if (account !== undefined) return account.store
    }
    return this.accounts.values().next().value?.store ?? this.storeFor(0)
  }

  /**
   * Add a fresh sign-in, or refresh an existing one.
   *
   * Keyed by IDENTITY, not by slot: signing the same account in again must
   * update it in place rather than create a duplicate that shares its quota.
   *
   * @param credential - the credential the sign-in produced.
   * @returns the account it belongs to.
   */
  async add(credential: WorkBuddyCredential): Promise<PooledAccount> {
    await this.load()
    const id = identityOf(credential)
    const existing = this.accounts.get(id)
    if (existing !== undefined) {
      // Same account, fresh token: overwrite the file it already owns.
      const reloaded = this.storeForSlotOf(existing)
      await reloaded.save(credential)
      // The store instance is replaced so a cached credential cannot outlive
      // the token it was read from, and the LABEL is re-derived because the
      // upstream nickname is part of what a sign-in refreshes — keeping the
      // stored one means a rename on the provider's side never reaches the card.
      const replaced: PooledAccount = {
        record: { ...existing.record, label: labelOf(credential, this.options.variant) },
        store: reloaded,
      }
      this.accounts.set(id, replaced)
      this.pool.upsert(replaced.record)
      await this.pool.flush()
      return replaced
    }
    const slot = this.nextSlot()
    const store = this.storeFor(slot)
    await store.save(credential)
    const account: PooledAccount = {
      record: freshRecord(id, labelOf(credential, this.options.variant), store.ownAuthPath()),
      store,
    }
    this.accounts.set(id, account)
    this.pool.upsert(account.record)
    await this.pool.flush()
    return account
  }

  /**
   * Forget one account and delete its credential file.
   *
   * @param id - the pool id to remove.
   */
  async remove(id: string): Promise<void> {
    const account = this.accounts.get(id)
    if (account === undefined) return
    try {
      await account.store.logout()
    } catch {
      // A credential file that is already gone is the state being asked for.
    }
    this.accounts.delete(id)
    this.pool.remove(id)
    await this.pool.flush()
  }

  /** Persist pool bookkeeping; safe to call on every request outcome. */
  async flush(): Promise<void> {
    await this.pool.flush()
  }

  /** Which slot an existing account occupies, by comparing file paths. */
  private storeForSlotOf(account: PooledAccount): WorkBuddyCredentialStore {
    const path = account.store.ownAuthPath()
    for (let slot = 0; slot < 64; slot += 1) {
      const candidate = this.storeFor(slot)
      if (candidate.ownAuthPath() === path) return candidate
    }
    return this.storeFor(0)
  }

  /** The next free slot: one past the highest occupied. */
  private nextSlot(): number {
    let highest = -1
    for (const account of this.accounts.values()) {
      for (let slot = 0; slot < 64; slot += 1) {
        if (this.storeFor(slot).ownAuthPath() === account.store.ownAuthPath()) {
          if (slot > highest) highest = slot
          break
        }
      }
    }
    return highest + 1
  }
}

/**
 * The stable identity of one account, matching the shell's own identity key.
 *
 * uid plus enterpriseId, because one person can belong to several enterprises
 * and each is a separately billed account.
 *
 * @param credential - the credential.
 * @returns the identity string.
 */
export function identityOf(credential: Pick<WorkBuddyCredential, 'uid' | 'enterpriseId'>): string {
  return credential.uid + ':' + (credential.enterpriseId ?? '')
}

/**
 * A brand-new pool record for an account just discovered or added.
 *
 * Cooldown state starts clean because this describes an account the pool has not
 * yet seen; an account it HAS seen keeps its state through
 * {@link WorkBuddyAccountPool.upsert}, which merges rather than replaces.
 *
 * @param id - the account identity.
 * @param label - the display label.
 * @param path - that account's credential file.
 * @returns a record with no cooldown applied.
 */
function freshRecord(id: string, label: string, path: string): PooledAccountRecord {
  return { id, label, path, cooldownUntilMs: 0, rateLimitHits: 0 }
}

/** A display label: the nickname when the upstream gave one. */
function labelOf(credential: WorkBuddyCredential, variant: WorkBuddyVariant): string {
  const nickname = credential.nickname
  if (nickname !== undefined && nickname !== '') return nickname
  return variant.displayName
}
