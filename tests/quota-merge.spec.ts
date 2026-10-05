import { describe, expect, it } from 'vitest'
import { clampPercent, mergeCreditAccounts, visibleQuotaGroups } from '../src/client/quota-merge.ts'
import type { QuotaGroup } from '../src/client/quota-merge.ts'
import type { WorkBuddyWebCreditAccount } from '../src/status-paths.ts'

/**
 * The sidebar card's merge layer: same-named packages sharing an expiry must
 * collapse into one summed row, while any difference in expiry keeps them
 * apart. These cases pin the rules the user ruled on: missing figures count
 * as 0, unlimited is sticky, and undated never merges with dated.
 */
const acct = (
  packageName: string,
  remain: number,
  size: number,
  extra: Partial<WorkBuddyWebCreditAccount> = {},
): WorkBuddyWebCreditAccount => ({ packageName, remain, size, ...extra })

describe('mergeCreditAccounts', () => {
  it('keeps distinct packages apart', () => {
    const groups = mergeCreditAccounts([acct('A包', 100, 200), acct('B包', 50, 100)])
    expect(groups).toHaveLength(2)
    expect(groups.map(g => g.packageName).sort()).toEqual(['A包', 'B包'])
  })

  it('sums same name + same expiry, keeping the expiry', () => {
    const groups = mergeCreditAccounts([
      acct('专业版', 300, 500, { packageEndTime: '2026-03-01 00:00:00' }),
      acct('专业版', 200, 500, { packageEndTime: '2026-03-01 00:00:00' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.remain).toBe(500)
    expect(groups[0]?.size).toBe(1000)
    expect(groups[0]?.packageEndTime).toBe('2026-03-01 00:00:00')
  })

  it('merges same name with different expiry (name is the key)', () => {
    // The user's correction: stacked purchase batches of one package whose
    // cycle deadlines differ by seconds must still be ONE overview row.
    const groups = mergeCreditAccounts([
      acct('专业版', 300, 500, { packageEndTime: '2026-04-01 00:00:00' }),
      acct('专业版', 200, 500, { packageEndTime: '2026-03-01 00:00:00' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.remain).toBe(500)
    expect(groups[0]?.size).toBe(1000)
    // The EARLIEST deadline travels with the group (operationally meaningful).
    expect(groups[0]?.packageEndTime).toBe('2026-03-01 00:00:00')
  })

  it('merges dated with undated packages of one name, keeping the date', () => {
    const groups = mergeCreditAccounts([
      acct('专业版', 300, 500, { packageEndTime: '2026-03-01 00:00:00' }),
      acct('专业版', 200, 500),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.packageEndTime).toBe('2026-03-01 00:00:00')
  })

  it('counts missing figures as 0 in the sum', () => {
    const groups = mergeCreditAccounts([
      acct('专业版', 300, 500, { packageEndTime: '2026-03-01 00:00:00' }),
      acct('专业版', 100, 0, { packageEndTime: '2026-03-01 00:00:00' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.remain).toBe(400)
    expect(groups[0]?.size).toBe(500)
  })

  it('makes the whole group unlimited when any member is', () => {
    const groups = mergeCreditAccounts([
      acct('企业包', 0, 0, { unlimited: true, packageEndTime: '2026-03-01 00:00:00' }),
      acct('企业包', 100, 200, { packageEndTime: '2026-03-01 00:00:00' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.unlimited).toBe(true)
  })

  it('preserves first-seen order', () => {
    const groups = mergeCreditAccounts([acct('B包', 1, 2), acct('A包', 3, 4), acct('B包', 5, 6)])
    expect(groups.map(g => g.packageName)).toEqual(['B包', 'A包'])
  })

  it('yields empty groups for empty input', () => {
    expect(mergeCreditAccounts([])).toEqual([])
  })
})

describe('visibleQuotaGroups', () => {
  const group = (over: Partial<QuotaGroup>): QuotaGroup => ({
    packageName: 'P',
    packageEndTime: undefined,
    remain: 100,
    size: 200,
    unlimited: false,
    ...over,
  })

  it('hides an exhausted group when others have credit', () => {
    const groups = [group({ packageName: '用完', remain: 0, size: 100 }), group({ packageName: '有量', remain: 50, size: 100 })]
    expect(visibleQuotaGroups(groups).map(g => g.packageName)).toEqual(['有量'])
  })

  it('hides an exhausted DATED group even when everything is exhausted', () => {
    const groups = [
      group({ packageName: '过期', remain: 0, size: 100, packageEndTime: '2026-01-01 00:00:00' }),
      group({ packageName: '过期2', remain: 0, size: 100, packageEndTime: '2026-02-01 00:00:00' }),
    ]
    expect(visibleQuotaGroups(groups)).toEqual([])
  })

  it('shows an exhausted UNDATED group when everything is exhausted', () => {
    const groups = [
      group({ packageName: '过期', remain: 0, size: 100, packageEndTime: '2026-01-01 00:00:00' }),
      group({ packageName: '常驻', remain: 0, size: 100 }),
    ]
    expect(visibleQuotaGroups(groups).map(g => g.packageName)).toEqual(['常驻'])
  })

  it('always renders unlimited groups', () => {
    const groups = [group({ packageName: '企业', remain: 0, size: 0, unlimited: true })]
    expect(visibleQuotaGroups(groups)).toHaveLength(1)
  })

  it('renders everything when nothing is exhausted', () => {
    const groups = [group({ packageName: 'A' }), group({ packageName: 'B', packageEndTime: '2026-05-01 00:00:00' })]
    expect(visibleQuotaGroups(groups)).toHaveLength(2)
  })
})

describe('clampPercent', () => {
  it('refuses a non-positive denominator', () => {
    expect(clampPercent(50, 0)).toBeUndefined()
  })
  it('clamps into [0, 100]', () => {
    expect(clampPercent(0, 100)).toBe(0)
    expect(clampPercent(150, 100)).toBe(100)
    expect(clampPercent(-10, 100)).toBe(0)
    expect(clampPercent(50, 100)).toBe(50)
  })
})
