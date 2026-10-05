import { describe, expect, it } from 'vitest'
import { buildUsageSummary } from '../src/usage/summary.ts'
import { totalTokens, type LedgerRow } from '../src/usage/ledger.ts'
import type { UsageAccountInput } from '../src/usage/summary.ts'

/** A fixed "now" so the window is deterministic. */
const NOW = new Date(2026, 2, 10, 12, 0).getTime()

function row(day: string, backendId: string, accountId: string, input: number, output = 0, calls = 1): LedgerRow {
  return { day, backendId, accountId, tokens: { uncachedInput: input, output, cacheRead: 0, cacheWrite: 0 }, calls }
}

function account(overrides: Partial<UsageAccountInput> & { backendId: string; accountId: string }): UsageAccountInput {
  return {
    backendName: overrides.backendId,
    authKind: 'desktop-adoption',
    accountLabel: overrides.accountId,
    usable: true,
    ...overrides,
  }
}

describe('buildUsageSummary', () => {
  it('produces an empty but well-formed document with no accounts', () => {
    const summary = buildUsageSummary([], [], { nowMs: NOW })
    expect(summary.accounts).toEqual([])
    expect(summary.windowTotals).toEqual({ uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(summary.anyQuota).toBe(false)
    expect(summary.hasHistory).toBe(false)
  })

  it('spans exactly the requested number of days, inclusive of today', () => {
    const summary = buildUsageSummary([], [], { windowDays: 30, nowMs: NOW })
    expect(summary.days).toHaveLength(30)
    expect(summary.fromDay).toBe('2026-02-09')
    expect(summary.toDay).toBe('2026-03-10')
  })

  it('folds only the window into window totals but keeps today separate', () => {
    const rows = [
      row('2026-03-10', 'cline', 'default', 100, 10),
      row('2026-03-09', 'cline', 'default', 50, 5),
      row('2025-01-01', 'cline', 'default', 9999, 9999),
    ]
    const summary = buildUsageSummary([account({ backendId: 'cline', accountId: 'default' })], rows, { windowDays: 30, nowMs: NOW })
    const entry = summary.accounts[0]!
    expect(entry.windowTokens.uncachedInput).toBe(150)
    expect(entry.todayTokens.uncachedInput).toBe(100)
    expect(summary.windowTotals.uncachedInput).toBe(150)
    expect(summary.todayTotals.uncachedInput).toBe(100)
    expect(summary.hasHistory).toBe(true)
  })

  it('keeps accounts of the same backend apart', () => {
    const rows = [
      row('2026-03-10', 'commandcode', 'work', 300),
      row('2026-03-10', 'commandcode', 'personal', 7),
    ]
    const summary = buildUsageSummary([
      account({ backendId: 'commandcode', accountId: 'work' }),
      account({ backendId: 'commandcode', accountId: 'personal' }),
    ], rows, { nowMs: NOW })
    expect(summary.accounts[0]!.windowTokens.uncachedInput).toBe(300)
    expect(summary.accounts[1]!.windowTokens.uncachedInput).toBe(7)
  })

  it('does not leak one backend\'s tokens into another with the same account id', () => {
    const rows = [
      row('2026-03-10', 'mimo', 'default', 111),
      row('2026-03-10', 'loomy', 'default', 222),
    ]
    const summary = buildUsageSummary([
      account({ backendId: 'mimo', accountId: 'default' }),
      account({ backendId: 'loomy', accountId: 'default' }),
    ], rows, { nowMs: NOW })
    expect(summary.accounts[0]!.windowTokens.uncachedInput).toBe(111)
    expect(summary.accounts[1]!.windowTokens.uncachedInput).toBe(222)
    expect(summary.windowTotals.uncachedInput).toBe(333)
  })

  it('reports per-backend shares that sum to 1', () => {
    const rows = [
      row('2026-03-10', 'a', 'x', 75),
      row('2026-03-10', 'b', 'y', 25),
    ]
    const summary = buildUsageSummary([
      account({ backendId: 'a', accountId: 'x' }),
      account({ backendId: 'b', accountId: 'y' }),
    ], rows, { nowMs: NOW })
    expect(summary.backends).toHaveLength(2)
    expect(summary.backends[0]!.share).toBeCloseTo(0.75)
    expect(summary.backends[1]!.share).toBeCloseTo(0.25)
  })

  it('gives a zero share rather than NaN when nothing was spent', () => {
    const summary = buildUsageSummary([account({ backendId: 'a', accountId: 'x' })], [], { nowMs: NOW })
    expect(summary.backends[0]!.share).toBe(0)
    expect(Number.isNaN(summary.backends[0]!.share)).toBe(false)
  })

  it('agrees between the chart days and the account folds', () => {
    const rows = [
      row('2026-03-10', 'a', 'x', 10),
      row('2026-03-10', 'b', 'y', 20),
      row('2026-03-09', 'a', 'x', 5),
    ]
    const summary = buildUsageSummary([
      account({ backendId: 'a', accountId: 'x' }),
      account({ backendId: 'b', accountId: 'y' }),
    ], rows, { nowMs: NOW })
    const chartTotal = summary.days.reduce((sum, day) => sum + totalTokens(day.tokens), 0)
    const accountTotal = summary.accounts.reduce((sum, entry) => sum + totalTokens(entry.windowTokens), 0)
    expect(chartTotal).toBe(accountTotal)
    expect(chartTotal).toBe(totalTokens(summary.windowTotals))
  })

  it('distinguishes "no quota reported" from "zero quota"', () => {
    const withQuota = buildUsageSummary([
      account({ backendId: 'a', accountId: 'x', quota: { kind: 'balance', remain: 0, unit: '积分' } }),
      account({ backendId: 'b', accountId: 'y', quota: { kind: 'unavailable', reason: '无计费接口' } }),
    ], [], { nowMs: NOW })
    expect(withQuota.accounts[0]!.quota?.kind).toBe('balance')
    expect(withQuota.accounts[1]!.quota?.kind).toBe('unavailable')
    expect(withQuota.anyQuota).toBe(true)
  })

  it('reports anyQuota false when every backend is unavailable', () => {
    const summary = buildUsageSummary([
      account({ backendId: 'a', accountId: 'x', quota: { kind: 'unavailable', reason: 'r' } }),
    ], [], { nowMs: NOW })
    expect(summary.anyQuota).toBe(false)
  })

  it('carries an unusable account through with its reason', () => {
    const summary = buildUsageSummary([
      account({ backendId: 'qoder-cn', accountId: 'default', usable: false, reason: '凭据已过期' }),
    ], [], { nowMs: NOW })
    expect(summary.accounts[0]!.usable).toBe(false)
    expect(summary.accounts[0]!.reason).toBe('凭据已过期')
  })

  it('counts calls separately from tokens', () => {
    const rows = [
      row('2026-03-10', 'a', 'x', 10, 1, 3),
      row('2026-03-09', 'a', 'x', 10, 1, 2),
    ]
    const summary = buildUsageSummary([account({ backendId: 'a', accountId: 'x' })], rows, { nowMs: NOW })
    expect(summary.windowCalls).toBe(5)
    expect(summary.accounts[0]!.windowCalls).toBe(5)
  })
})
