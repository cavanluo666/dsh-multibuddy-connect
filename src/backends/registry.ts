/**
 * The multi-account credential registry: one file per backend holding THAT
 * backend's accounts, keyed by backend-local account id.
 *
 * Why a registry rather than "one credential file per backend". The merge
 * brings backends whose account models disagree:
 *
 *  - Command Code configures an `accounts` dictionary and mints one bearer
 *    key per entry;
 *  - Trae and Qoder expose two regions that are separately signed in;
 *  - the desktop-adoption backends (Qoder, Trae, MiMo, Loomy, CodeBuddy)
 *    have exactly one slot, because the slot belongs to another program.
 *
 * Storing "the one credential" would force every backend into the narrowest
 * of those models. Instead every backend keeps N accounts under its own
 * `accounts` map, and `multiAccount: false` in the descriptor means N is
 * pinned to 1 — a restriction the UI enforces, not one the storage imposes.
 *
 * Isolation is the whole point, so the layout makes it structural rather than
 * conventional: accounts live in separate files per backend, and each
 * account's secret material carries its own provenance. A bug that confuses
 * two accounts cannot silently overwrite one with the other, because it would
 * have to address the wrong file by name first.
 *
 * The WorkBuddy variants do NOT use this registry. They keep their own
 * `.workbuddy-auth.json` / `.workbuddy-ai-auth.json` files and their
 * `WorkBuddyCredentialStore`, because that store predates the merge and is
 * the compatibility anchor. Unifying them would mean rewriting the one part
 * of this plugin that is known to work; the registry is additive.
 *
 * @module dsh-workbuddy-connect/backends/registry
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { workbuddyPluginDataDir } from '../auth.ts'
import type { BackendId } from './types.ts'

/**
 * On-disk format version.
 *
 * Bumped only for a layout change a reader must know about. An unknown version
 * is refused rather than guessed at: misreading a credential file as a newer
 * layout is how a user gets silently signed out.
 */
const REGISTRY_FORMAT_VERSION = 1

/**
 * One stored account.
 *
 * `secret` is the backend's own opaque credential document. The registry
 * deliberately does not model what is inside it: each backend's credential
 * shape differs too much (a bearer token, a cookie jar, a DPAPI-decrypted
 * blob, a whole token list), and normalising them into one vocabulary would
 * either lose fields or invent a lowest common denominator. The backend that
 * wrote it is the backend that reads it.
 */
export interface StoredAccount {
  /** Backend-local stable id. */
  id: string
  /** Human label for pickers. */
  label: string
  /** Masked identity detail safe to render, when the backend has one. */
  detail?: string
  /** The backend's opaque credential document. */
  secret: unknown
  /** When this account was last written, epoch ms. */
  updatedAtMs: number
}

/** One backend's stored account set. */
interface BackendAccountFile {
  version: number
  backendId: string
  accounts: StoredAccount[]
}

/**
 * Where one backend's accounts live.
 *
 * Same data-directory root as the WorkBuddy credentials, and for the same
 * reason: a credential is secret material, not configuration, so it must stay
 * outside the rebuildable `config/` tree and survive "wipe the caches".
 *
 * @param backendId - the backend whose file to name.
 * @returns the absolute path of that backend's account file.
 */
export function backendAccountsPath(backendId: BackendId): string {
  return join(workbuddyPluginDataDir(), `.backend-${sanitize(backendId)}-accounts.json`)
}

/**
 * Reduce a backend id to something safe to put in a filename.
 *
 * Backend ids are authored constants and should already be filename-safe, but
 * a descriptor is data — a third-party backend is data this plugin does not
 * control — so the reduction must be defensive rather than cosmetic.
 *
 * Two classes of character are rejected, for different reasons:
 *
 *  - Anything outside `[A-Za-z0-9_-]` becomes `_`. This removes the path
 *    separators outright, so a write can never land outside the data directory.
 *  - A DOT becomes `_` too. Allowing dots would let the id `..` survive into
 *    the filename, and `.backend-..-accounts.json` is exactly the shape that
 *    confuses a human (and some tooling) into reading a traversal. Since no
 *    real backend id needs a dot, dropping them removes the entire class
 *    rather than trying to special-case the dangerous members.
 *
 * The result is additionally collapsed of runs and trimmed of edge
 * underscores, so `../../evil` yields the readable stem `evil`.
 *
 * @param id - the raw backend id.
 * @returns a filename-safe stem; never empty.
 */
function sanitize(id: string): string {
  const reduced = id.replace(/[^A-Za-z0-9_-]/gu, '_').replace(/_+/gu, '_').replace(/^_+|_+$/gu, '')
  return reduced === '' ? 'backend' : reduced
}

/**
 * The multi-account registry.
 *
 * Every method is explicit about which backend it addresses, so no call can
 * accidentally read one backend's accounts under another's name.
 */
export class BackendAccountRegistry {
/**
 * Cache of parsed files, keyed by backend id; invalidated on write.
 *
 * Each entry records whether a file actually backed it. Caching the ABSENCE of
 * a file is useful — it keeps a never-configured backend from hitting the disk
 * on every render — but it means `cache.has()` cannot answer "is there a
 * file?", because a cached empty result looks identical to a cached real one.
 * The `existed` flag is what tells them apart, and it is the difference
 * between consulting an environment variable and not.
 */
  private readonly cache = new Map<BackendId, { file: BackendAccountFile; existed: boolean }>()

  /**
   * Read one backend's accounts.
   *
   * A missing file is an empty set, not an error: a backend whose desktop app
   * is installed but never signed in has simply never written one. A file that
   * exists but does not parse is ALSO an empty set — with the version check
   * applied first — because a corrupt credential file must degrade to
   * "signed out" (recoverable by signing in again) rather than throw during
   * plugin startup and take every other backend down with it.
   *
   * @param backendId - the backend to read.
   * @returns its stored accounts, in file order.
   */
  async list(backendId: BackendId): Promise<readonly StoredAccount[]> {
    const cached = this.cache.get(backendId)
    if (cached !== undefined) return cached.file.accounts
    const { file, existed } = await this.read(backendId)
    this.cache.set(backendId, { file, existed })
    return file.accounts
  }

  /**
   * Whether this backend has EVER been written to.
   *
   * Distinct from "has accounts": a user who configured accounts and then
   * deleted every one of them leaves a file with an empty list, and that is a
   * deliberate state which must not be mistaken for "never configured" — the
   * difference decides whether an environment variable is still consulted as a
   * fallback, and getting it backwards resurrects an account the user removed.
   *
   * @param backendId - the backend to test.
   * @returns true when a file exists for this backend.
   */
  async hasStored(backendId: BackendId): Promise<boolean> {
    const cached = this.cache.get(backendId)
    // A cached entry is authoritative only about what was READ, not about what
    // exists — but the flag it carries was captured at read time and no write
    // has happened since (a write replaces the entry), so it can be trusted.
    if (cached !== undefined) return cached.existed
    try {
      await readFile(backendAccountsPath(backendId), 'utf8')
      return true
    } catch {
      return false
    }
  }

  /** Read one account, or undefined when this backend has no such id. */
  async get(backendId: BackendId, accountId: string): Promise<StoredAccount | undefined> {
    const accounts = await this.list(backendId)
    return accounts.find(account => account.id === accountId)
  }

  /**
   * Insert or replace one account, preserving the order of the others.
   *
   * Order is meaning, not incidental: the account list renders top-to-bottom
   * and the FIRST account is the default a new session uses, so a replace must
   * not silently promote a different account to the front.
   *
   * @param backendId - the backend to write.
   * @param account - the account to store; its id is the merge key.
   */
  async put(backendId: BackendId, account: StoredAccount): Promise<void> {
    const { file } = await this.read(backendId)
    const index = file.accounts.findIndex(existing => existing.id === account.id)
    const next = { ...account, updatedAtMs: Date.now() }
    if (index >= 0) file.accounts[index] = next
    else file.accounts.push(next)
    await this.write(backendId, file)
  }

  /** Remove one account; a no-op when the id is unknown. */
  async remove(backendId: BackendId, accountId: string): Promise<void> {
    const { file } = await this.read(backendId)
    const next = file.accounts.filter(account => account.id !== accountId)
    if (next.length === file.accounts.length) return
    file.accounts = next
    await this.write(backendId, file)
  }

  /** Drop the in-memory cache for one backend, or all of them. */
  invalidate(backendId?: BackendId): void {
    if (backendId === undefined) this.cache.clear()
    else this.cache.delete(backendId)
  }

  /**
   * Read and validate one backend's file, without consulting the cache.
   *
   * Reports whether a file actually backed the result, which the cache needs
   * and the file's CONTENTS cannot express: an absent file and a file holding
   * an empty list both parse to zero accounts, but only one of them means the
   * user has ever configured this backend.
   *
   * @param backendId - the backend to read.
   * @returns the parsed file plus whether one existed.
   */
  private async read(backendId: BackendId): Promise<{ file: BackendAccountFile; existed: boolean }> {
    const empty: BackendAccountFile = { version: REGISTRY_FORMAT_VERSION, backendId, accounts: [] }
    let text: string
    try {
      text = await readFile(backendAccountsPath(backendId), 'utf8')
    } catch {
      return { file: empty, existed: false }
    }
    // Past this point a file existed. A file that does not PARSE is still
    // "existed": the user configured something and the content is broken, which
    // must not silently re-enable the environment fallback the way "never
    // configured" does.
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { file: empty, existed: true }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { file: empty, existed: true }
    const document = parsed as Record<string, unknown>
    // Version first: a newer layout read as this one would silently drop
    // fields, so refusing is the honest outcome. The caller then sees "no
    // accounts" and the backend re-resolves from its real source.
    if (document['version'] !== REGISTRY_FORMAT_VERSION) return { file: empty, existed: true }
    const raw = document['accounts']
    if (!Array.isArray(raw)) return { file: empty, existed: true }
    const accounts: StoredAccount[] = []
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      const id = typeof record['id'] === 'string' ? record['id'] : undefined
      const label = typeof record['label'] === 'string' ? record['label'] : undefined
      if (id === undefined || id === '' || label === undefined) continue
      accounts.push({
        id,
        label,
        ...(typeof record['detail'] === 'string' ? { detail: record['detail'] } : {}),
        secret: record['secret'],
        updatedAtMs: typeof record['updatedAtMs'] === 'number' ? record['updatedAtMs'] : 0,
      })
    }
    return { file: { version: REGISTRY_FORMAT_VERSION, backendId, accounts }, existed: true }
  }

  /** Persist one backend's file and refresh the cache. */
  private async write(backendId: BackendId, file: BackendAccountFile): Promise<void> {
    const path = backendAccountsPath(backendId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(file, undefined, 2), 'utf8')
    // A write always leaves a file behind, so this entry is known to exist even
    // when it holds zero accounts.
    this.cache.set(backendId, { file, existed: true })
  }
}

/**
 * Mask a secret for display: keep a short prefix and suffix so a user can
 * confirm WHICH credential they are looking at, and nothing more.
 *
 * The point is identification, not partial disclosure: `sk-ab…9f2c` lets a
 * human match this row against the key they pasted, while revealing too little
 * to be worth stealing. A short secret is masked entirely rather than shown,
 * since a 6-character value has no room for a safe window.
 *
 * @param secret - the raw secret.
 * @returns a display-safe rendering.
 */
export function maskSecret(secret: string): string {
  if (secret.length <= 12) return '•'.repeat(Math.max(4, secret.length))
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`
}
