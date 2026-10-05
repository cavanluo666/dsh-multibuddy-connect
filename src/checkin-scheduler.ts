/**
 * Startup check-in orchestration for daily benefits (UTC+8).
 *
 * This fork runs check-in ON DSH STARTUP rather than on a wall-clock timer:
 * - JsonFileCheckInStore persists checkin records and up to 30 history log rows to checkin-status.json
 * - One sweep per process start claims today's benefit for every enabled variant
 * - Already-claimed days are skipped, so restarts never double-claim
 *
 * @module dsh-workbuddy-connect/checkin-scheduler
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WorkBuddyCheckInResult } from './checkin.ts'
import { getUtc8DateString } from './checkin.ts'
import { workbuddyPluginDataDir } from './paths.ts'

export interface VariantCheckInTarget {
  variantId: string
  /**
   * Claim today's benefit for this variant.
   */
  checkIn: (signal?: AbortSignal) => Promise<WorkBuddyCheckInResult>
  onClaimed?: () => void
}

export interface CheckInLogItem {
  id: string
  date: string
  timestamp: number
  status: 'claimed' | 'already-claimed' | 'no-campaign' | 'error'
  amount?: number | undefined
  message?: string | undefined
}

export interface CheckInRecord {
  lastDate: string
  lastAt: number
  status: 'claimed' | 'already-claimed' | 'no-campaign' | 'error'
  amount?: number | undefined
  message?: string | undefined
  logs?: CheckInLogItem[] | undefined
}

export interface CheckInStatusStore {
  read(variantId: string): CheckInRecord | undefined
  write(variantId: string, record: CheckInRecord): void
  clearLogs(variantId: string): void
}

export class JsonFileCheckInStore implements CheckInStatusStore {
  private readonly filePath: string

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(workbuddyPluginDataDir(), 'checkin-status.json')
  }

  private readAll(): Record<string, CheckInRecord> {
    try {
      if (!existsSync(this.filePath)) return {}
      const raw = readFileSync(this.filePath, 'utf-8')
      return JSON.parse(raw) as Record<string, CheckInRecord>
    } catch {
      return {}
    }
  }

  read(variantId: string): CheckInRecord | undefined {
    return this.readAll()[variantId]
  }

  clearLogs(variantId: string): void {
    try {
      const all = this.readAll()
      if (all[variantId]) {
        all[variantId] = {
          ...all[variantId],
          logs: [],
        }
        mkdirSync(dirname(this.filePath), { recursive: true })
        writeFileSync(this.filePath, JSON.stringify(all, null, 2), 'utf-8')
      }
    } catch {
      // Best-effort persistence
    }
  }

  write(variantId: string, record: CheckInRecord): void {
    try {
      const all = this.readAll()
      const existing = all[variantId]
      const existingLogs = existing?.logs ?? []
      const newLog: CheckInLogItem = {
        id: `${record.lastDate}-${record.lastAt}`,
        date: record.lastDate,
        timestamp: record.lastAt,
        status: record.status,
        ...record.amount === undefined ? {} : { amount: record.amount },
        ...record.message === undefined ? {} : { message: record.message },
      }
      const updatedLogs = [newLog, ...existingLogs.filter(l => l.id !== newLog.id)].slice(0, 30)
      all[variantId] = {
        ...record,
        logs: updatedLogs,
      }
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(all, null, 2), 'utf-8')
    } catch {
      // Best-effort persistence
    }
  }
}

export interface CheckInSchedulerOptions {
  targets: VariantCheckInTarget[]
  isEnabled: (variantId: string) => boolean
  store?: CheckInStatusStore | undefined
  onResult?: ((result: WorkBuddyCheckInResult) => void) | undefined
  now?: (() => number) | undefined
}

export class CheckInScheduler {
  private readonly targets: VariantCheckInTarget[]
  private readonly isEnabled: (variantId: string) => boolean
  private readonly store: CheckInStatusStore
  private readonly onResult: ((result: WorkBuddyCheckInResult) => void) | undefined
  private readonly now: () => number

  private readonly inFlight = new Set<string>()
  private disposed = false

  constructor(options: CheckInSchedulerOptions) {
    this.targets = options.targets
    this.isEnabled = options.isEnabled
    this.store = options.store ?? new JsonFileCheckInStore()
    this.onResult = options.onResult
    this.now = options.now ?? Date.now
  }

  /**
   * Claim today's benefit for every enabled variant. Called once per process
   * start (and again when the user flips a toggle on), never on a timer.
   */
  start(): void {
    if (this.disposed) return
    void this.sweepAll()
  }

  /**
   * Re-run the startup sweep. Kept as a separate name because the settings card
   * calls it after a toggle so enabling check-in takes effect without a restart.
   */
  catchUp(): void {
    if (this.disposed) return
    void this.sweepAll()
  }

  dispose(): void {
    this.disposed = true
  }

  async sweepAll(only?: string): Promise<void> {
    if (this.disposed) return
    const nowMs = this.now()
    const today = getUtc8DateString(nowMs)

    for (const target of this.targets) {
      if (only !== undefined && target.variantId !== only) continue
      if (!this.isEnabled(target.variantId)) continue
      if (this.inFlight.has(target.variantId)) continue
      this.inFlight.add(target.variantId)
      try {
        await this.sweepOne(target, nowMs, today)
      } finally {
        this.inFlight.delete(target.variantId)
      }
    }
  }

  private async sweepOne(
    target: VariantCheckInTarget,
    nowMs: number,
    today: string,
  ): Promise<void> {
    const record = this.store.read(target.variantId)
    const settledToday = record?.lastDate === today
      && (record.status === 'claimed' || record.status === 'already-claimed')

    // Today already claimed: nothing to do. A restart must never re-claim.
    if (settledToday) return

    let result: WorkBuddyCheckInResult
    try {
      result = await target.checkIn()
    } catch {
      return
    }

    try {
      if (result.status !== 'error') {
        this.store.write(target.variantId, {
          lastDate: result.date,
          lastAt: result.timestamp,
          status: result.status,
          amount: result.amount,
          message: result.message,
        })
        if (result.status === 'claimed') {
          target.onClaimed?.()
        }
      }
      this.onResult?.(result)
    } catch {
      // Ignored to protect loop
    }
  }
}
