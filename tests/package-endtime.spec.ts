import { describe, expect, it } from 'vitest'

/**
 * The expiry-passthrough contract for the personal-account credit parse: a
 * non-empty upstream `PackageEndTime` string rides through verbatim, an
 * absent/empty one leaves the field unset. The full HTTP path is covered by
 * web-status.spec; these cases pin the field behaviour the merge layer groups
 * by, mirroring the exact expression shape used in `upstream.fetchCredits`.
 */

interface ParsedAccount {
  packageName: string
  remain: number
  size: number
  packageEndTime?: string
}

/** The same expression shape as the parser in upstream.fetchCredits. */
function parseAccount(account: Record<string, unknown>): ParsedAccount {
  const numberField = (key: string): number => (typeof account[key] === 'number' ? account[key] as number : 0)
  const size = numberField('CycleCapacitySize')
  const cycleRemain = numberField('CycleCapacityRemain')
  const cycleUsed = numberField('CycleCapacityUsed')
  const capacityRemain = numberField('CapacityRemain')
  let remain: number
  if (size > 0) remain = cycleRemain
  else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain
  else remain = capacityRemain
  if (remain < 0) remain = 0
  return {
    packageName: typeof account['PackageName'] === 'string' ? account['PackageName'] : '(unnamed)',
    remain,
    size: size > 0 ? size : numberField('CapacitySize'),
    ...(typeof account['PackageEndTime'] === 'string' && (account['PackageEndTime'] as string) !== ''
      ? { packageEndTime: account['PackageEndTime'] as string }
      : {}),
  }
}

describe('PackageEndTime passthrough', () => {
  it('keeps a verbatim expiry string', () => {
    const parsed = parseAccount({
      PackageName: '专业版',
      CycleCapacitySize: 500,
      CycleCapacityRemain: 300,
      CycleCapacityUsed: 200,
      PackageEndTime: '2026-03-01 00:00:00',
    })
    expect(parsed.packageEndTime).toBe('2026-03-01 00:00:00')
    expect(parsed.remain).toBe(300)
  })

  it('omits an empty expiry string', () => {
    const parsed = parseAccount({
      PackageName: 'p',
      CycleCapacitySize: 100,
      CycleCapacityRemain: 80,
      PackageEndTime: '',
    })
    expect('packageEndTime' in parsed).toBe(false)
  })

  it('omits a missing expiry field', () => {
    const parsed = parseAccount({ PackageName: 'p', CapacityRemain: 50, CapacitySize: 100 })
    expect('packageEndTime' in parsed).toBe(false)
    expect(parsed.remain).toBe(50)
  })

  it('ignores non-string expiry values', () => {
    const parsed = parseAccount({
      PackageName: 'p',
      CycleCapacitySize: 100,
      CycleCapacityRemain: 80,
      PackageEndTime: 1700000000000,
    })
    expect('packageEndTime' in parsed).toBe(false)
  })
})
