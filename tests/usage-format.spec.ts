import { describe, expect, it } from 'vitest'
import {
  accountState,
  barHeightPercent,
  chartCeiling,
  formatFetchedAt,
  formatNumber,
  formatTokens,
  quotaFraction,
  quotaSummary,
  shortDay,
  tokensTotal,
} from '../src/client/usage-format.ts'
import type { UsageWebAccount, UsageWebDay, UsageWebTokens } from '../src/usage-paths.ts'

function tokens(partial: Partial<UsageWebTokens> = {}): UsageWebTokens {
  return { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...partial }
}

function account(partial: Partial<UsageWebAccount> = {}): UsageWebAccount {
  return {
    backendId: 'cline',
    backendName: 'Cline',
    authKind: 'api-key',
    accountId: 'default',
    accountLabel: 'Default',
    usable: true,
    windowTokens: tokens(),
    todayTokens: tokens(),
    windowCalls: 0,
    ...partial,
  }
}

describe('formatTokens', () => {
  it('rounds DOWN so a figure is never inflated', () => {
    // An inflated usage figure reads as overspend, which is the direction that
    // matters on a billing-adjacent page.
    expect(formatTokens(1999)).toBe('1.9K')
    expect(formatTokens(1_999_999)).toBe('1.9M')
  })

  it('shows small counts verbatim', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('does not promote a value before it reaches the unit', () => {
    expect(formatTokens(999_999)).toBe('999.9K')
    expect(formatTokens(1_000_000)).toBe('1M')
  })

  it('treats a non-finite or negative value as nothing', () => {
    expect(formatTokens(Number.NaN)).toBe('0')
    expect(formatTokens(-5)).toBe('0')
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0')
  })
})

describe('tokensTotal', () => {
  it('sums all four buckets', () => {
    expect(tokensTotal(tokens({ uncachedInput: 1, output: 2, cacheRead: 3, cacheWrite: 4 }))).toBe(10)
  })
})

describe('chartCeiling', () => {
  it('returns the tallest day', () => {
    const days: UsageWebDay[] = [
      { day: '2026-03-01', tokens: tokens({ uncachedInput: 10 }), calls: 1 },
      { day: '2026-03-02', tokens: tokens({ uncachedInput: 50 }), calls: 1 },
    ]
    expect(chartCeiling(days)).toBe(50)
  })

  it('never returns zero, so an empty chart cannot divide by zero', () => {
    expect(chartCeiling([])).toBe(1)
    expect(chartCeiling([{ day: '2026-03-01', tokens: tokens(), calls: 0 }])).toBe(1)
  })
})

describe('barHeightPercent', () => {
  it('scales against the ceiling', () => {
    expect(barHeightPercent(tokens({ uncachedInput: 25 }), 100)).toBe(25)
  })

  it('gives an empty day zero height, not a sliver', () => {
    expect(barHeightPercent(tokens(), 100)).toBe(0)
  })

  it('never renders a non-empty day as invisible', () => {
    // Without a floor, one token beside a million rounds to a 0px bar and reads
    // as "nothing happened" — the one error a usage chart must not make.
    expect(barHeightPercent(tokens({ uncachedInput: 1 }), 1_000_000)).toBeGreaterThanOrEqual(2)
  })

  it('never exceeds full height', () => {
    expect(barHeightPercent(tokens({ uncachedInput: 500 }), 100)).toBe(100)
  })
})

describe('shortDay', () => {
  it('drops the year', () => {
    expect(shortDay('2026-03-04')).toBe('03-04')
  })

  it('passes an unexpected shape through unchanged', () => {
    expect(shortDay('nonsense')).toBe('nonsense')
  })
})

describe('quotaFraction', () => {
  it('is undefined when there is no reading at all', () => {
    expect(quotaFraction(undefined)).toBeUndefined()
  })

  it('is undefined for a backend that cannot report quota', () => {
    // Rendering an empty bar here would state "you have nothing left", which is
    // different from "we cannot find out".
    expect(quotaFraction({ kind: 'unavailable', reason: 'x' })).toBeUndefined()
  })

  it('is undefined for an errored reading', () => {
    expect(quotaFraction({ kind: 'error', message: 'x' })).toBeUndefined()
  })

  it('is undefined for an unlimited package set', () => {
    expect(quotaFraction({ kind: 'packages', total: 5, unlimited: true, packages: [] })).toBeUndefined()
  })

  it('is undefined when the denominator is absent or zero', () => {
    expect(quotaFraction({ kind: 'balance', remain: 5, unit: '积分' })).toBeUndefined()
    expect(quotaFraction({ kind: 'balance', remain: 5, unit: '积分', size: 0 })).toBeUndefined()
  })

  it('computes a fraction for a balance', () => {
    expect(quotaFraction({ kind: 'balance', remain: 25, unit: '积分', size: 100 })).toBe(0.25)
  })

  it('clamps a balance that exceeds its own total', () => {
    expect(quotaFraction({ kind: 'balance', remain: 150, unit: '积分', size: 100 })).toBe(1)
  })

  it('distinguishes a real zero from an unknown', () => {
    // 0 is a legitimate reading meaning "nothing left"; it must survive.
    expect(quotaFraction({ kind: 'balance', remain: 0, unit: '积分', size: 100 })).toBe(0)
  })
})

describe('quotaSummary', () => {
  it('never returns an empty string, whatever the reading', () => {
    // A blank cell reads as a rendering bug rather than as missing data.
    for (const quota of [
      undefined,
      { kind: 'unavailable', reason: 'x' } as const,
      { kind: 'error', message: 'x' } as const,
      { kind: 'balance', remain: 5, unit: '积分' } as const,
      { kind: 'packages', total: 5, totalSize: 10, packages: [] } as const,
    ]) {
      expect(quotaSummary(quota).length).toBeGreaterThan(0)
    }
  })

  it('says a backend does not report quota instead of showing zero', () => {
    expect(quotaSummary({ kind: 'unavailable', reason: 'x' })).toBe('不提供额度查询')
  })

  it('states an unavailable reading before it has been fetched', () => {
    expect(quotaSummary(undefined)).toBe('尚未读取')
  })

  it('renders a balance with its unit', () => {
    expect(quotaSummary({ kind: 'balance', remain: 1234, unit: '积分' })).toBe('1,234 积分')
  })

  it('shows both sides of a package total', () => {
    expect(quotaSummary({ kind: 'packages', total: 30, totalSize: 100, packages: [] })).toBe('30 / 100')
  })

  it('says unlimited when that is the truth', () => {
    expect(quotaSummary({ kind: 'packages', total: 0, unlimited: true, packages: [] })).toBe('不限量')
  })
})

describe('formatNumber', () => {
  it('groups thousands', () => {
    expect(formatNumber(1234567)).toBe('1,234,567')
  })

  it('keeps one decimal', () => {
    expect(formatNumber(12.34)).toBe('12.3')
  })

  it('reports an unusable value as a dash rather than NaN', () => {
    expect(formatNumber(Number.NaN)).toBe('—')
  })
})

describe('accountState', () => {
  it('flags an unusable account with its reason', () => {
    const state = accountState(account({ usable: false, reason: '凭据已过期' }))
    expect(state.tone).toBe('error')
    expect(state.label).toBe('凭据已过期')
  })

  it('marks a stale balance as a warning, not as normal', () => {
    // The figure survives a failed refresh, so the row must say so.
    const state = accountState(account({ quota: { kind: 'balance', remain: 5, unit: 'x', staleReason: 'offline' } }))
    expect(state.tone).toBe('warn')
  })

  it('says a backend without quota is fine, just limited', () => {
    const state = accountState(account({ quota: { kind: 'unavailable', reason: 'r' } }))
    expect(state.tone).toBe('muted')
  })

  it('reports a healthy account as normal', () => {
    expect(accountState(account({ quota: { kind: 'balance', remain: 5, unit: 'x' } })).tone).toBe('ok')
  })
})

describe('formatFetchedAt', () => {
  const now = new Date(2026, 2, 10, 15, 0).getTime()

  it('shows a time alone for today', () => {
    expect(formatFetchedAt(new Date(2026, 2, 10, 9, 5).getTime(), now)).toBe('09:05')
  })

  it('includes the date for an earlier day', () => {
    expect(formatFetchedAt(new Date(2026, 2, 8, 9, 5).getTime(), now)).toBe('03-08 09:05')
  })

  it('is undefined when there is no reading', () => {
    expect(formatFetchedAt(undefined, now)).toBeUndefined()
    expect(formatFetchedAt(Number.NaN, now)).toBeUndefined()
  })
})
