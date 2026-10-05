/**
 * The account pool: several WorkBuddy sign-ins of ONE product, with automatic
 * failover when one of them is throttled or out of credit.
 *
 * WHY A POOL RATHER THAN A BIGGER STORE. \`WorkBuddyCredentialStore\` holds
 * exactly one credential and is the compatibility anchor of this plugin; every
 * card, route and catalog path already goes through it. Rather than teach it to
 * hold N credentials — which would touch all of those — the pool OWNS N stores,
 * one per account, and each keeps the single-account semantics it already has
 * (its own file, its own single-flight refresh, its own realm check). The pool
 * adds only the two things that are genuinely new: WHICH account serves a
 * request, and WHEN an account has to sit out.
 *
 * WHY FAILOVER IS NOT NAIVE RETRY. Only some upstream failures mean \"try
 * another account\":
 *
 *  - \`soft_rate\` and \`hard_credit\` are per-ACCOUNT conditions, so another
 *    account can genuinely succeed;
 *  - \`session_dead\` needs a fresh sign-in, so the account is parked until the
 *    user does that;
 *  - \`server\`, \`client\` and \`activation_required\` are NOT account conditions.
 *    Retrying them on every account multiplies one failure by the pool size and
 *    makes the user wait through N identical errors — the failure has to be
 *    returned as-is on the first occurrence.
 *
 * The classification already exists (\`classifyUpstreamError\`); this module only
 * decides what each class MEANS for pool membership.
 *
 * @module dsh-multibuddy-connect/pool
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { workbuddyPluginDataDir } from './paths.ts'
import type { WorkBuddyCredential } from './auth.ts'
import type { UpstreamErrorKind } from './upstream.ts'

/** On-disk pool format; readers refuse anything else rather than guess. */
const POOL_FORMAT_VERSION = 1

/**
 * How long one account sits out after a failure class.
 *
 * A rate limit is usually seconds-to-minutes, so the base is deliberately
 * short: parking a healthy account for an hour because it hit one 429 turns a
 * brief throttle into an outage. Repeat offenders back off (see
 * {@link cooldownMsFor}), which is what stops a genuinely bad account from
 * being retried every minute forever.
 */
const SOFT_RATE_BASE_MS = 60_000

/** Ceiling for the exponential backoff, so a parked account is still retried. */
const SOFT_RATE_MAX_MS = 30 * 60_000

/**
 * How long an exhausted account sits out when the upstream states no reset.
 *
 * A credit refusal means \"not until the next billing cycle\", and inventing a
 * precise reset time would be worse than admitting the granularity: the account
 * is parked for a day and the next request after that probes it again.
 */
const HARD_CREDIT_FALLBACK_MS = 24 * 60 * 60_000

/** One account's pool bookkeeping, as persisted. */
export interface PooledAccountRecord {
  /** Stable identity (`uid:enterpriseId`); the merge key across restarts. */
  id: string
  /** Human label shown in the card. */
  label: string
  /** Where this account's credential file lives. */
  path: string
  /** Period during which this account is skipped, epoch ms (0 = available). */
  cooldownUntilMs: number
  /** Why it is cooling, for the card. */
  cooldownReason?: string
  /** Consecutive rate-limit hits, driving the backoff. */
  rateLimitHits: number
  /** Set when the credential needs a fresh sign-in before it can be used. */
  needsSignIn?: boolean
  /** Last time this account served a request successfully, epoch ms. */
  lastSuccessAtMs?: number
}

/** The persisted pool document. */
interface PoolDocument {
  version: number
  accounts: PooledAccountRecord[]
  /** The account to try first, when it is available. */
  activeId?: string
}

/**
 * Where one account's credential lives.
 *
 * Derived from the pool's base file name so the FIRST account keeps the
 * historical path exactly: an existing single-account install must keep reading
 * the file it already wrote, or the upgrade would look like a sign-out.
 *
 * @param baseFilename - the variant's own credential filename.
 * @param slot - 0 for the original file, 1+ for added accounts.
 * @returns the absolute path for that slot.
 */
export function poolAccountPath(baseFilename: string, slot: number): string {
  const dir = workbuddyPluginDataDir()
  if (slot === 0) return join(dir, baseFilename)
  const dot = baseFilename.lastIndexOf('.')
  const stem = dot === -1 ? baseFilename : baseFilename.slice(0, dot)
  const ext = dot === -1 ? '' : baseFilename.slice(dot)
  return join(dir, stem + '-a' + String(slot + 1) + ext)
}

/** The pool's own bookkeeping file, beside the credentials it tracks. */
export function poolStatePath(baseFilename: string): string {
  const dot = baseFilename.lastIndexOf('.')
  const stem = dot === -1 ? baseFilename : baseFilename.slice(0, dot)
  return join(workbuddyPluginDataDir(), stem + '-pool.json')
}

/**
 * Whether a failure class means \"try another account\".
 *
 * The three that do are per-account conditions. Everything else is a property
 * of the REQUEST or the SERVICE, so walking the pool would repeat one failure N
 * times and delay the error the user needs to see.
 *
 * @param kind - the classified upstream failure.
 * @returns true when another account may succeed.
 */
export function isAccountScoped(kind: UpstreamErrorKind): boolean {
  return kind === 'soft_rate' || kind === 'hard_credit' || kind === 'session_dead'
}

/**
 * The cooldown for one failure, given how many times this account has already
 * been rate-limited in a row.
 *
 * Exponential with a ceiling: the first throttle costs a minute, and an account
 * that keeps being throttled is parked progressively longer instead of being
 * retried every minute forever.
 *
 * @param kind - the failure class.
 * @param rateLimitHits - consecutive rate-limit hits, including this one.
 * @returns how long to park the account, in milliseconds.
 */
export function cooldownMsFor(kind: UpstreamErrorKind, rateLimitHits: number): number {
  if (kind === 'soft_rate') {
    const step = Math.max(0, rateLimitHits - 1)
    return Math.min(SOFT_RATE_MAX_MS, SOFT_RATE_BASE_MS * Math.pow(2, step))
  }
  if (kind === 'hard_credit') return HARD_CREDIT_FALLBACK_MS
  // A dead session does not recover on its own; the card asks for a sign-in.
  return Number.POSITIVE_INFINITY
}

/**
 * The pool's live state for one product variant.
 *
 * Credential STORAGE is not this class's business — the caller supplies the
 * stores, one per account, because only the shell knows how to build them (they
 * need the variant and the refresh function). The pool owns selection, cooldown
 * accounting, and persistence of the bookkeeping beside those credentials.
 */
export class WorkBuddyAccountPool {
  private records: PooledAccountRecord[] = []
  private activeId: string | undefined
  private loaded = false
  private dirty = false

  constructor(private readonly baseFilename: string) {}

  /** Read the pool file once; a missing or unreadable file starts empty. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let text: string
    try {
      text = await readFile(poolStatePath(this.baseFilename), 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    const document = parsed as Record<string, unknown>
    if (document['version'] !== POOL_FORMAT_VERSION) return
    const raw = document['accounts']
    if (!Array.isArray(raw)) return
    for (const entry of raw) {
      const record = parseRecord(entry)
      if (record !== undefined) this.records.push(record)
    }
    const active = document['activeId']
    if (typeof active === 'string' && active !== '') this.activeId = active
  }

  /** Every tracked account, in stable order. */
  all(): readonly PooledAccountRecord[] {
    return this.records
  }

  /** The account the pool prefers, when it is usable. */
  active(): PooledAccountRecord | undefined {
    return this.records.find(record => record.id === this.activeId)
  }

  /**
   * Record one account, merging with what is already known.
   *
   * Cooldown state is CARRIED OVER rather than reset: a discovery pass runs on
   * every catalog refresh, and letting it clear a cooldown would put a
   * throttled account straight back into rotation.
   *
   * @param record - the account's identity and location.
   */
  upsert(record: Omit<PooledAccountRecord, 'cooldownUntilMs' | 'rateLimitHits'> & Partial<PooledAccountRecord>): void {
    const existing = this.records.find(candidate => candidate.id === record.id)
    if (existing === undefined) {
      this.records.push({
        cooldownUntilMs: 0,
        rateLimitHits: 0,
        ...record,
      })
    } else {
      existing.label = record.label
      existing.path = record.path
    }
    this.activeId ??= record.id
    this.dirty = true
  }

  /** Drop one account; a no-op when the id is unknown. */
  remove(id: string): void {
    const before = this.records.length
    this.records = this.records.filter(record => record.id !== id)
    if (this.records.length === before) return
    if (this.activeId === id) this.activeId = this.records[0]?.id
    this.dirty = true
  }

  /** Mark which account the pool should prefer. */
  setActive(id: string): void {
    if (!this.records.some(record => record.id === id)) return
    this.activeId = id
    this.dirty = true
  }

  /**
   * Accounts that may serve a request right now, best first.
   *
   * The active account leads so a healthy preference is honoured, and the rest
   * follow in insertion order — which is the order the user signed them in, and
   * therefore the order they would expect.
   *
   * @param now - current time; injected so tests need no clock.
   * @returns the usable accounts, in the order they should be tried.
   */
  available(now: number): readonly PooledAccountRecord[] {
    const usable = this.records.filter(record =>
      record.needsSignIn !== true && record.cooldownUntilMs <= now)
    const preferred = usable.filter(record => record.id === this.activeId)
    const rest = usable.filter(record => record.id !== this.activeId)
    return [...preferred, ...rest]
  }

  /**
   * Apply one request outcome to an account.
   *
   * Success CLEARS the rate-limit streak: the counter exists to lengthen the
   * backoff of an account that keeps failing, so an account that just worked
   * must start from the short cooldown again.
   *
   * @param id - the account that served the attempt.
   * @param outcome - the classified result, or \`ok\` for a success.
   * @param now - current time.
   * @returns the account's state after the update.
   */
  report(id: string, outcome: UpstreamErrorKind | 'ok', now: number): PooledAccountRecord | undefined {
    const record = this.records.find(candidate => candidate.id === id)
    if (record === undefined) return undefined
    if (outcome === 'ok') {
      record.cooldownUntilMs = 0
      delete record.cooldownReason
      record.rateLimitHits = 0
      delete record.needsSignIn
      record.lastSuccessAtMs = now
      this.dirty = true
      return record
    }
    if (!isAccountScoped(outcome)) return record
    if (outcome === 'session_dead') {
      record.needsSignIn = true
      delete record.cooldownReason
      record.cooldownUntilMs = 0
      this.dirty = true
      return record
    }
    record.rateLimitHits = outcome === 'soft_rate' ? record.rateLimitHits + 1 : record.rateLimitHits
    const cooldown = cooldownMsFor(outcome, record.rateLimitHits)
    record.cooldownReason = outcome
    record.cooldownUntilMs = Number.isFinite(cooldown) ? now + cooldown : Number.MAX_SAFE_INTEGER
    this.dirty = true
    return record
  }

  /** Persist the bookkeeping, when anything changed. */
  async flush(): Promise<void> {
    if (!this.dirty) return
    const document: PoolDocument = {
      version: POOL_FORMAT_VERSION,
      accounts: this.records,
      ...(this.activeId === undefined ? {} : { activeId: this.activeId }),
    }
    const path = poolStatePath(this.baseFilename)
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFileAtomic(path, JSON.stringify(document, undefined, 2) + '\n', {
        mode: 0o600,
        dirMode: 0o700,
      })
      this.dirty = false
    } catch {
      // A failed bookkeeping write must not fail the request that triggered it:
      // the cost is a cooldown that does not survive a restart, not a broken
      // answer.
    }
  }
}

/** Validate one persisted record; undefined when unusable. */
function parseRecord(entry: unknown): PooledAccountRecord | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : undefined
  const path = typeof record['path'] === 'string' ? record['path'] : undefined
  if (id === undefined || id === '' || path === undefined || path === '') return undefined
  const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
  return {
    id,
    label: typeof record['label'] === 'string' && record['label'] !== '' ? record['label'] : id,
    path,
    cooldownUntilMs: number(record['cooldownUntilMs']),
    ...(typeof record['cooldownReason'] === 'string' ? { cooldownReason: record['cooldownReason'] } : {}),
    rateLimitHits: number(record['rateLimitHits']),
    ...(record['needsSignIn'] === true ? { needsSignIn: true } : {}),
    ...(typeof record['lastSuccessAtMs'] === 'number' ? { lastSuccessAtMs: record['lastSuccessAtMs'] } : {}),
  }
}
