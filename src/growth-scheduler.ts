/**
 * Daily growth automation: accept the day's tasks, collect what is collectable,
 * and remember that it was done.
 *
 * ISOLATION IS THE DESIGN. Every upstream call goes through
 * {@link WorkBuddyGrowthClient}, and every call site is wrapped so a failure
 * becomes a recorded result rather than a thrown error. Nothing here touches the
 * shim, the catalog, the credential pool or the adapter — a bug in this module
 * can cost a reward, and cannot interrupt a conversation. That matters because
 * other work runs against this plugin.
 *
 * ONCE PER ACCOUNT PER DAY. The upstream is idempotent for both accept and
 * claim, so a repeat is not dangerous — it is merely wasteful, and against a
 * rate-limited gift endpoint waste is what gets an account throttled. The ledger
 * therefore records the DAY, not the moment: a second sweep on the same day does
 * nothing, and a new day starts fresh.
 *
 * WHAT IT CANNOT DO. Most tasks require real product use (send five chats,
 * create a canvas, summon an expert). Automation can enrol in them and collect
 * their reward the moment it is earned, but it cannot earn it — a task that
 * needs activity stays in progress until the user does the activity.
 *
 * @module dsh-multibuddy-connect/growth-scheduler
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { workbuddyPluginDataDir } from './paths.ts'
import { WorkBuddyGrowthClient, type GrowthBoard, type GrowthClaimSummary } from './growth.ts'
import type { WorkBuddyCredential } from './auth.ts'

/** How often the automation re-checks, once a day has been started. */
export const GROWTH_TICK_MS = 60 * 60_000

/**
 * Pause between accounts.
 *
 * These are write calls against a gift endpoint shared by every account, and a
 * burst across a pool is exactly the pattern that gets them all throttled — which
 * the pool would then answer by cooling every account down.
 */
const ACCOUNT_GAP_MS = 800

/** What one account's run produced. */
export interface GrowthAccountResult {
  accountId: string
  label: string
  /** Tasks newly enrolled in this run. */
  accepted: number
  /** Rewards collected in this run. */
  claimed: number
  credit: number
  energy: number
  /** Tasks still waiting on real activity. */
  inProgress: number
  /** Claims still available but not collected. */
  claimable: number
  failures: readonly string[]
  /** Set when the whole account failed (a dead credential, a network fault). */
  error?: string
}

/** The whole run's outcome. */
export interface GrowthRunSummary {
  ranAtMs: number
  accounts: readonly GrowthAccountResult[]
  credit: number
  energy: number
  /** Whether the run was started by hand rather than by the timer. */
  manual: boolean
}

/** One account the automation can act for. */
export interface GrowthTarget {
  id: string
  label: string
  /** Resolve the credential at call time, so a refresh is picked up. */
  credential: () => Promise<WorkBuddyCredential>
}

/** Persisted ledger: which day each account was last run. */
interface GrowthLedgerFile {
  version: number
  /** account id to the local day it was last automated. */
  days: Record<string, string>
}

/** Constructor dependencies. */
export interface GrowthSchedulerOptions {
  /** The accounts to act for; re-read per run so the pool's changes apply. */
  targets: () => readonly GrowthTarget[]
  /** Whether automation is switched on. */
  isEnabled: () => boolean
  /** The client; injected so tests need no network. */
  client?: WorkBuddyGrowthClient
  /** Notified after each run, for the card. */
  onRun?: (summary: GrowthRunSummary) => void
  /** Injected clock. */
  now?: () => number
  /** Injected sleep, so tests do not wait. */
  sleep?: (ms: number) => Promise<void>
}

/** The local calendar day, matching the ledger's grain. */
function localDay(atMs: number): string {
  const date = new Date(atMs)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return date.getFullYear() + '-' + month + '-' + day
}

/** Where the automation ledger lives. */
export function growthLedgerPath(): string {
  return join(workbuddyPluginDataDir(), '.workbuddy-growth-ledger.json')
}

/**
 * The daily automation.
 *
 * The ledger is keyed by DAY rather than by a boolean, so a machine that was off
 * for a week does not run seven times on the day it returns.
 */
export class GrowthScheduler {
  private readonly client: WorkBuddyGrowthClient
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private days: Record<string, string> = {}
  private loaded = false
  private timer: NodeJS.Timeout | undefined
  private disposed = false
  /** Guards against a manual run overlapping the timer's. */
  private running = false
  /** The most recent run, for the card. */
  private lastRun: GrowthRunSummary | undefined

  constructor(private readonly options: GrowthSchedulerOptions) {
    this.client = options.client ?? new WorkBuddyGrowthClient()
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms) }))
  }

  /** Start the hourly check. */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => { void this.sweep() }, GROWTH_TICK_MS)
    // A timer must never hold the process open: this runs beside a live server.
    this.timer.unref?.()
  }

  /** Stop the timer. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** The most recent run, when there has been one. */
  lastSummary(): GrowthRunSummary | undefined {
    return this.lastRun
  }

  /**
   * Whether this account has already been automated today.
   *
   * @param id - the account id.
   * @returns true when today's run is done.
   */
  alreadyRanToday(id: string): boolean {
    return this.days[id] === localDay(this.now())
  }

  /**
   * Run one pass, unless it is off, already running, or already done today.
   *
   * Every failure is contained: one account failing leaves the others to run,
   * and the whole pass never throws.
   *
   * @param manual - true when a user pressed the button, which bypasses the
   *   once-a-day rule so the button always does something observable.
   * @returns the run, or undefined when nothing ran.
   */
  async sweep(manual = false): Promise<GrowthRunSummary | undefined> {
    if (this.disposed) return undefined
    if (!this.options.isEnabled() && !manual) return undefined
    if (this.running) return undefined
    this.running = true
    try {
      await this.load()
      const targets = this.options.targets()
      const results: GrowthAccountResult[] = []
      let credit = 0
      let energy = 0
      for (const target of targets) {
        if (this.disposed) break
        // The daily rule applies to the TIMER only: a user pressing the button
        // is asking for a fresh check, and claiming nothing new is a valid,
        // observable answer.
        if (!manual && this.alreadyRanToday(target.id)) continue
        const result = await this.runAccount(target)
        results.push(result)
        credit += result.credit
        energy += result.energy
        this.days[target.id] = localDay(this.now())
        if (targets.length > 1) await this.sleep(ACCOUNT_GAP_MS)
      }
      // Nothing ran: every account was skipped (already done today, or the pool is
      // empty). Reported as "no run" rather than as an empty summary, because a
      // summary with no accounts would tell the card a pass just happened and
      // found nothing — the opposite of what occurred.
      if (results.length === 0) return undefined
      await this.flush()
      const summary: GrowthRunSummary = {
        ranAtMs: this.now(),
        accounts: results,
        credit,
        energy,
        manual,
      }
      this.lastRun = summary
      try {
        this.options.onRun?.(summary)
      } catch {
        // A notification hook must never fail the run it reports on.
      }
      return summary
    } catch {
      // The pass is best-effort and must never propagate: it runs on a timer
      // beside a live server.
      return undefined
    } finally {
      this.running = false
    }
  }

  /** Run one account: enrol, then collect. */
  private async runAccount(target: GrowthTarget): Promise<GrowthAccountResult> {
    const base: GrowthAccountResult = {
      accountId: target.id,
      label: target.label,
      accepted: 0,
      claimed: 0,
      credit: 0,
      energy: 0,
      inProgress: 0,
      claimable: 0,
      failures: [],
    }
    let credential: WorkBuddyCredential
    try {
      credential = await target.credential()
    } catch (error: unknown) {
      return { ...base, error: error instanceof Error ? error.message : String(error) }
    }
    let board: GrowthBoard
    try {
      board = await this.client.listTasks(credential)
    } catch (error: unknown) {
      return { ...base, error: error instanceof Error ? error.message : String(error) }
    }
    const failures: string[] = []
    // Enrol first: an accepted task starts counting progress, so a user who then
    // uses the product earns the reward without ever opening this card.
    const toAccept = board.tasks.filter(task => task.status === 'not_accepted').map(task => task.code)
    let accepted = 0
    if (toAccept.length > 0) {
      try {
        await this.client.acceptTasks(credential, toAccept)
        accepted = toAccept.length
      } catch (error: unknown) {
        failures.push('accept: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    // Re-read rather than assume: accepting can expose rewards immediately, and
    // the second read also settles tasks whose progress landed in between.
    let after: GrowthBoard = board
    if (accepted > 0) {
      try {
        after = await this.client.listTasks(credential)
      } catch {
        // Keep the first read: accepting succeeded, which is the part that had a
        // side effect.
      }
    }
    const toClaim = after.tasks.filter(task => task.status === 'claimable').map(task => task.code)
    let summary: GrowthClaimSummary | undefined
    if (toClaim.length > 0) {
      try {
        summary = await this.client.claimAll(credential, toClaim)
      } catch (error: unknown) {
        failures.push('claim: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    const claimedTasks = summary?.claimed.filter(claim => !claim.alreadyClaimed).length ?? 0
    return {
      ...base,
      accepted,
      claimed: claimedTasks,
      credit: summary?.credit ?? 0,
      energy: summary?.energy ?? 0,
      inProgress: after.tasks.filter(task => task.status === 'in_progress').length,
      claimable: after.tasks.filter(task => task.status === 'claimable').length,
      failures: [...failures, ...(summary?.failures.map(f => f.code + ': ' + f.message) ?? [])],
    }
  }

  /** Read the ledger once. */
  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(growthLedgerPath(), 'utf8')) as GrowthLedgerFile
      if (typeof parsed !== 'object' || parsed === null || parsed.version !== 1) return
      if (typeof parsed.days === 'object' && parsed.days !== null) this.days = parsed.days
    } catch {
      // A missing or unreadable ledger means nothing ran today, which is the
      // safe direction: the worst outcome is one redundant idempotent pass.
    }
  }

  /** Persist the ledger. */
  private async flush(): Promise<void> {
    try {
      const path = growthLedgerPath()
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const document: GrowthLedgerFile = { version: 1, days: this.days }
      await writeFileAtomic(path, JSON.stringify(document, undefined, 2), {
        mode: 0o600,
        dirMode: 0o700,
      })
    } catch {
      // Losing the ledger costs one redundant pass, never a broken run.
    }
  }
}
