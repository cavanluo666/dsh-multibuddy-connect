/**
 * Wiring: turn the stored account registry into the per-backend account lists
 * that api-key backends expect.
 *
 * WHY THIS IS A SEPARATE MODULE. The backends are leaf modules — they are
 * given their accounts and do not read the registry themselves, which keeps
 * each one testable without a filesystem and stops nine modules from each
 * inventing their own read/cache/error policy for the same file. The cost of
 * that choice is this adapter layer, which is the single place that knows both
 * the registry's shape and each backend's expectations.
 *
 * THE SEMANTIC THAT MATTERS, and the one most easily got wrong: a registry
 * with zero accounts is NOT the same fact as "no registry was consulted".
 *
 *  - Zero accounts means the user has configured none, so the backend should
 *    fall back to its environment variable (a developer's `CLINE_API_KEY`).
 *  - A NON-EMPTY list means the user deliberately configured accounts, and the
 *    environment variable must then be IGNORED. Honouring both would make a
 *    deleted account reappear from the environment on the next restart —
 *    "I removed it and it came back" is the kind of bug nobody can explain by
 *    looking at the UI.
 *
 * Hence this module passes `undefined` for the empty case and the list
 * otherwise, and never an empty array. That distinction is the whole point of
 * the module existing rather than each call site inlining a map.
 *
 * @module dsh-workbuddy-connect/backends/wiring
 */

import { BackendAccountRegistry, type StoredAccount } from './registry.ts'
import type { BackendId } from './types.ts'

/** One account handed to an api-key backend. */
export interface SeedAccount {
  id: string
  label: string
  secret: string
}

/**
 * Read one backend's accounts and shape them for injection.
 *
 * A stored secret that is not a string is DROPPED rather than coerced. These
 * documents are written by this plugin, so a non-string means either a
 * hand-edited file or a future format; either way, sending `[object Object]`
 * as an API key would produce a confusing upstream auth failure instead of a
 * missing account the user can see and fix.
 *
 * @param registry - the account registry.
 * @param backendId - the backend to read.
 * @returns the seed list, or `undefined` when none are configured (see the
 *   module note — this is NOT the same as an empty list).
 */
export async function seedsFor(registry: BackendAccountRegistry, backendId: BackendId): Promise<readonly SeedAccount[] | undefined> {
  const stored = await registry.list(backendId)
  const seeds: SeedAccount[] = []
  for (const account of stored) {
    const seed = toSeed(account)
    if (seed !== undefined) seeds.push(seed)
  }
  // NOT CONFIGURED YET vs CONFIGURED TO NOTHING. The environment variable must
  // stay in play only in the first case. The test is whether the registry has
  // ever been WRITTEN for this backend, not how many usable rows it holds:
  // a user who deleted their last account leaves an empty list, and re-reading
  // the environment there would resurrect an account they removed — while a
  // user who has never opened the card has no file at all and must still get
  // their CLINE_API_KEY. Row count cannot tell those apart; the write can.
  if (seeds.length > 0) return seeds
  return await registry.hasStored(backendId) ? [] : undefined
}

/** Shape one stored account, or undefined when its secret is unusable. */
function toSeed(account: StoredAccount): SeedAccount | undefined {
  const secret = typeof account.secret === 'string' ? account.secret.trim() : undefined
  if (secret === undefined || secret === '') return undefined
  return { id: account.id, label: account.label, secret }
}

/**
 * The registry instance the shell shares with its backends.
 *
 * One instance per plugin start, not per backend: the registry caches parsed
 * files, and nine instances would mean nine copies of every account list in
 * memory and nine chances for one to go stale after a write.
 */
export function createRegistry(): BackendAccountRegistry {
  return new BackendAccountRegistry()
}
