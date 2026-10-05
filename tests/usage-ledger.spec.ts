import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dailySeries, localDay, totalTokens, UsageLedger } from '../src/usage/ledger.ts'

describe('usage ledger', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'usage-ledger-'))
    previous = process.env['DSH_WORKBUDDY_DATA_DIR']
    process.env['DSH_WORKBUDDY_DATA_DIR'] = dir
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env['DSH_WORKBUDDY_DATA_DIR']
    else process.env['DSH_WORKBUDDY_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  })

  it('returns zero buckets for an account with no history', async () => {
    const ledger = new UsageLedger()
    await ledger.load()
    expect(ledger.all()).toEqual([])
  })

  it('accumulates repeated calls into one row', async () => {
    const ledger = new UsageLedger()
    await ledger.load()
    const at = Date.parse('2026-03-04T10:00:00')
    ledger.record('qoder-cn', 'primary', { uncachedInput: 100, output: 20 }, at)
    ledger.record('qoder-cn', 'primary', { uncachedInput: 50, output: 5 }, at)
    const rows = ledger.all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tokens.uncachedInput).toBe(150)
    expect(rows[0]?.tokens.output).toBe(25)
    expect(rows[0]?.calls).toBe(2)
  })

  it('keeps accounts apart within one backend', async () => {
    const ledger = new UsageLedger()
    await ledger.load()
    const at = Date.parse('2026-03-04T10:00:00')
    ledger.record('commandcode', 'work', { uncachedInput: 100 }, at)
    ledger.record('commandcode', 'personal', { uncachedInput: 7 }, at)
    const rows = ledger.all()
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.accountId === 'work')?.tokens.uncachedInput).toBe(100)
    expect(rows.find(r => r.accountId === 'personal')?.tokens.uncachedInput).toBe(7)
  })

  it('drops an unattributed call rather than filing it under a default', async () => {
    const ledger = new UsageLedger()
    await ledger.load()
    ledger.record('', 'someone', { uncachedInput: 999 })
    ledger.record('qoder-cn', '', { uncachedInput: 999 })
    expect(ledger.all()).toEqual([])
  })

  it('survives a write, a reload and a corrupt file', async () => {
    const ledger = new UsageLedger()
    await ledger.load()
    const at = Date.parse('2026-03-04T10:00:00')
    ledger.record('cline', 'default', { uncachedInput: 42, output: 8 }, at)
    await ledger.flush()

    const reloaded = new UsageLedger()
    await reloaded.load()
    expect(reloaded.all()).toHaveLength(1)
    expect(reloaded.all()[0]?.tokens.uncachedInput).toBe(42)

    const { writeFile } = await import('node:fs/promises')
    const { usageLedgerPath } = await import('../src/usage/ledger.ts')
    await writeFile(usageLedgerPath(), '{ not json', 'utf8')
    const broken = new UsageLedger()
    await broken.load()
    expect(broken.all()).toEqual([])
  })

  it('filters a range inclusively and sorts by day', async () => {
    const ledger = new UsageLedger()
    await ledger.load()
    ledger.record('mimo', 'default', { output: 1 }, Date.parse('2026-03-01T12:00:00'))
    ledger.record('mimo', 'default', { output: 2 }, Date.parse('2026-03-05T12:00:00'))
    ledger.record('mimo', 'default', { output: 4 }, Date.parse('2026-03-09T12:00:00'))
    const rows = ledger.range('2026-03-01', '2026-03-05')
    expect(rows.map(r => r.day)).toEqual(['2026-03-01', '2026-03-05'])
  })

  it('fills empty days in a daily series', () => {
    const rows = [
      { day: '2026-03-01', backendId: 'a', accountId: 'x', tokens: { uncachedInput: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, calls: 1 },
      { day: '2026-03-03', backendId: 'a', accountId: 'x', tokens: { uncachedInput: 30, output: 0, cacheRead: 0, cacheWrite: 0 }, calls: 1 },
    ]
    const series = dailySeries(rows, '2026-03-01', '2026-03-03')
    expect(series.map(point => point.day)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03'])
    expect(totalTokens(series[1]!.tokens)).toBe(0)
    expect(totalTokens(series[2]!.tokens)).toBe(30)
  })

  it('derives a local day label', () => {
    const at = new Date(2026, 2, 4, 23, 30).getTime()
    expect(localDay(at)).toBe('2026-03-04')
  })

  it('clears every row on request', async () => {
    const ledger = new UsageLedger()
    await ledger.load()
    ledger.record('loomy', 'default', { output: 5 })
    await ledger.flush()
    await ledger.clear()
    expect(ledger.all()).toEqual([])
    const reloaded = new UsageLedger()
    await reloaded.load()
    expect(reloaded.all()).toEqual([])
  })
})
