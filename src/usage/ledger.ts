/**
 * The local usage ledger: per-day, per-account token accounting.
 *
 * WHY THIS EXISTS. The usage dashboard is meant to answer "what have I spent",
 * and the honest answer is that almost none of the merged backends will tell
 * us. Qoder, Trae, MiMo, Loomy and CodeBuddy are subscription products whose
 * endpoints expose a remaining balance at best; the OpenCode pair hides behind
 * a child runtime. Only the harness-native meter knows token counts — and it
 * knows them per SESSION, not per backend account, and not retained across
 * days.
 *
 * So the plugin keeps its own ledger. The harness reports the four token
 * buckets this plugin folds in, and the ledger attributes them to the account
 * that was actually serving the session at the time.
 *
 * THE ATTRIBUTION PROBLEM, and why the API looks like this. A token count
 * arrives without saying which account produced it. The ledger therefore does
 * NOT guess from content or timing: the caller must name the (backend,
 * account) pair explicitly, and the shell derives that pair from the session's
 * routed model — the one place where the truth actually lives. An unattributed
 * count is DROPPED rather than filed under a default account, because a wrong
 * attribution silently corrupts the very comparison the user opened the page
 * to make.
 *
 * LAYOUT. One row per (day, backend, account). Days are the ledger's grain
 * because that is the granularity the dashboard charts and the format the user
 * asked for; a finer grain would only be aggregated back down, and a coarser
 * one could not be re-sliced. Rows are pruned by age so the file stays bounded
 * on a machine that has been running for months.
 *
 * @module dsh-workbuddy-connect/usage/ledger
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { workbuddyPluginDataDir } from '../auth.ts'
import type { BackendId } from '../backends/types.ts'

/** On-disk format version; an unknown version is refused, not guessed at. */
const LEDGER_FORMAT_VERSION = 1

/**
 * How long a daily row is kept.
 *
 * 400 days, not 365: a user comparing "this month against the same month last
 * year" needs the previous year's row to still exist on the first day of the
 * month, and 365 would have pruned it exactly one day too early.
 */
const RETENTION_DAYS = 400

/**
 * The four disjoint token buckets the harness reports.
 *
 * Mirrors `TokenUsageProjection` from `@deepseek-ai/dsh-token-meter`
 * structurally, and is redeclared rather than imported so the ledger stays a
 * pure data module with no harness dependency — which is what lets its tests
 * run in plain Node.
 *
 * Reasoning tokens are already inside `output`, and are deliberately NOT a
 * fifth bucket: counting them twice is the classic way a usage page overstates
 * spend by a third.
 */
export interface TokenBuckets {
  uncachedInput: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One daily row: the tokens one account spent on one day. */
export interface LedgerRow {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string
  backendId: BackendId
  accountId: string
  tokens: TokenBuckets
  /** How many model calls contributed, for an average-cost read. */
  calls: number
}

/** The whole ledger, as persisted. */
interface LedgerFile {
  version: number
  rows: LedgerRow[]
}

/**
 * The local calendar day of a timestamp.
 *
 * LOCAL, not UTC, and that is a deliberate choice with a visible consequence:
 * a token spent at 23:30 belongs to the day the user experienced it, not to
 * the next UTC day. A UTC ledger would show a user in UTC+8 an hour of their
 * evening activity filed under tomorrow.
 *
 * @param atMs - the timestamp.
 * @returns `YYYY-MM-DD` in the machine's local timezone.
 */
export function localDay(atMs: number): string {
  const date = new Date(atMs)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Zero buckets, for accumulating into. */
function zeroBuckets(): TokenBuckets {
  return { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/** Sum of a bucket set — the figure the dashboard shows as "total tokens". */
export function totalTokens(tokens: TokenBuckets): number {
  return tokens.uncachedInput + tokens.output + tokens.cacheRead + tokens.cacheWrite
}

/**
 * Where the ledger file lives.
 *
 * Data-directory root beside the credentials, but this is NOT secret material —
 * it is usage metadata. It lives here anyway because it is user state that must
 * survive a cache wipe: deleting token history because someone cleared a
 * model catalog would be a surprise.
 */
export function usageLedgerPath(): string {
  return join(workbuddyPluginDataDir(), '.usage-ledger.json')
}

/**
 * The usage ledger.
 *
 * Writes are batched in memory and flushed explicitly. A flush per model call
 * would rewrite the whole file on every turn — the ledger holds up to 400 days
 * of rows — and every one of those writes is a chance to be interrupted
 * mid-file.
 */
export class UsageLedger {
  private rows: LedgerRow[] = []
  private loaded = false
  /** Whether anything changed since the last successful flush. */
  private dirty = false

  /** Read the file once; subsequent calls use the in-memory rows. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let text: string
    try {
      text = await readFile(usageLedgerPath(), 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // A corrupt ledger starts empty rather than throwing: losing usage
      // history is a lesser harm than a plugin that will not start.
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    const document = parsed as Record<string, unknown>
    if (document['version'] !== LEDGER_FORMAT_VERSION) return
    const raw = document['rows']
    if (!Array.isArray(raw)) return
    for (const entry of raw) {
      const row = parseRow(entry)
      if (row !== undefined) this.rows.push(row)
    }
  }

  /**
   * Add one model call's tokens to an account's day.
   *
   * `backendId` and `accountId` are REQUIRED and never defaulted — see the
   * module note on attribution. A caller that does not know which account
   * served a call must not record it at all.
   *
   * @param backendId - the backend that served the call.
   * @param accountId - the account within that backend.
   * @param tokens - the four buckets reported for the call.
   * @param atMs - when the call happened; defaults to now.
   */
  record(backendId: BackendId, accountId: string, tokens: Partial<TokenBuckets>, atMs: number = Date.now()): void {
    if (backendId === '' || accountId === '') return
    const day = localDay(atMs)
    const row = this.rows.find(candidate =>
      candidate.day === day && candidate.backendId === backendId && candidate.accountId === accountId)
    const target = row ?? this.push({ day, backendId, accountId, tokens: zeroBuckets(), calls: 0 })
    target.tokens.uncachedInput += tokens.uncachedInput ?? 0
    target.tokens.output += tokens.output ?? 0
    target.tokens.cacheRead += tokens.cacheRead ?? 0
    target.tokens.cacheWrite += tokens.cacheWrite ?? 0
    target.calls += 1
    this.dirty = true
  }

  /** Every row, oldest first. */
  all(): readonly LedgerRow[] {
    return this.rows
  }

  /**
   * Rows within a day range, inclusive.
   *
   * @param fromDay - `YYYY-MM-DD` lower bound, inclusive.
   * @param toDay - `YYYY-MM-DD` upper bound, inclusive; omitted means today.
   */
  range(fromDay: string, toDay: string = localDay(Date.now())): readonly LedgerRow[] {
    return this.rows.filter(row => row.day >= fromDay && row.day <= toDay)
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  }

  /** Persist, after pruning rows past the retention window. */
  async flush(): Promise<void> {
    if (!this.dirty && this.loaded) return
    const cutoff = localDay(Date.now() - RETENTION_DAYS * 86_400_000)
    this.rows = this.rows.filter(row => row.day >= cutoff)
    const file: LedgerFile = { version: LEDGER_FORMAT_VERSION, rows: this.rows }
    const path = usageLedgerPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(file), 'utf8')
    this.dirty = false
  }

  /** Drop every row, in memory and on disk. */
  async clear(): Promise<void> {
    this.rows = []
    this.dirty = true
    await this.flush()
  }

  private push(row: LedgerRow): LedgerRow {
    this.rows.push(row)
    return row
  }
}

/** Validate one persisted row; undefined when unusable. */
function parseRow(entry: unknown): LedgerRow | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  const day = record['day']
  const backendId = record['backendId']
  const accountId = record['accountId']
  if (typeof day !== 'string' || typeof backendId !== 'string' || typeof accountId !== 'string') return undefined
  if (day === '' || backendId === '' || accountId === '') return undefined
  const rawTokens = record['tokens']
  if (typeof rawTokens !== 'object' || rawTokens === null) return undefined
  const tokens = rawTokens as Record<string, unknown>
  const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
  return {
    day,
    backendId,
    accountId,
    tokens: {
      uncachedInput: number(tokens['uncachedInput']),
      output: number(tokens['output']),
      cacheRead: number(tokens['cacheRead']),
      cacheWrite: number(tokens['cacheWrite']),
    },
    calls: number(record['calls']),
  }
}

/**
 * Fold rows into per-day totals across every account.
 *
 * `from`/`to` are filled in even for days with no activity, because a chart
 * that skips empty days draws a misleading continuous line across a week the
 * user was away.
 *
 * @param rows - ledger rows to fold.
 * @param fromDay - inclusive lower bound.
 * @param toDay - inclusive upper bound.
 * @returns one point per calendar day in range, oldest first.
 */
export function dailySeries(rows: readonly LedgerRow[], fromDay: string, toDay: string): readonly { day: string; tokens: TokenBuckets; calls: number }[] {
  const byDay = new Map<string, { tokens: TokenBuckets; calls: number }>()
  for (const row of rows) {
    if (row.day < fromDay || row.day > toDay) continue
    const entry = byDay.get(row.day) ?? { tokens: zeroBuckets(), calls: 0 }
    entry.tokens.uncachedInput += row.tokens.uncachedInput
    entry.tokens.output += row.tokens.output
    entry.tokens.cacheRead += row.tokens.cacheRead
    entry.tokens.cacheWrite += row.tokens.cacheWrite
    entry.calls += row.calls
    byDay.set(row.day, entry)
  }
  const out: { day: string; tokens: TokenBuckets; calls: number }[] = []
  for (let cursor = fromDay; cursor <= toDay; cursor = nextDay(cursor)) {
    const entry = byDay.get(cursor)
    out.push({ day: cursor, tokens: entry?.tokens ?? zeroBuckets(), calls: entry?.calls ?? 0 })
  }
  return out
}

/**
 * The next calendar day.
 *
 * Walks through UTC deliberately: this is pure date arithmetic on a
 * `YYYY-MM-DD` label, and a local-time walk would repeat or skip a day across
 * a daylight-saving transition.
 */
function nextDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  const next = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + 1))
  const y = next.getUTCFullYear()
  const m = String(next.getUTCMonth() + 1).padStart(2, '0')
  const d = String(next.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
