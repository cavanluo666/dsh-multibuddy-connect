import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageService } from '../src/usage/service.ts'
import { UsageLedger } from '../src/usage/ledger.ts'
import { BaseBackendAdapter, BackendUnavailable, type BackendImpl } from '../src/backends/base.ts'
import type { BackendDescriptor, QuotaReading } from '../src/backends/types.ts'

function descriptor(id: string, overrides: Partial<BackendDescriptor> = {}): BackendDescriptor {
  return {
    id,
    displayName: id.toUpperCase(),
    authKind: 'desktop-adoption',
    multiAccount: false,
    reportsQuota: true,
    reportsTokenUsage: false,
    settingsNs: `llm-${id}`,
    ...overrides,
  }
}

function backend(desc: BackendDescriptor, impl: Partial<BackendImpl>): BaseBackendAdapter {
  return new (class extends BaseBackendAdapter {})(desc, {
    discover: async () => [],
    ...impl,
  } as BackendImpl)
}

describe('UsageService', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'usage-service-'))
    previous = process.env['DSH_WORKBUDDY_DATA_DIR']
    process.env['DSH_WORKBUDDY_DATA_DIR'] = dir
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env['DSH_WORKBUDDY_DATA_DIR']
    else process.env['DSH_WORKBUDDY_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  })

  function service(backends: BaseBackendAdapter[], ledger = new UsageLedger()): UsageService {
    return new UsageService({
      backends: () => backends,
      ledger,
      actionKey: () => 'test-key',
    })
  }

  it('lists one row per ready account, skipping signed-out backends', async () => {
    const ready = backend(descriptor('a'), { discover: async () => [{ id: 'u1', label: 'U1' }] })
    const out = backend(descriptor('b'), { discover: async () => [] })
    const doc = await service([ready, out]).document()
    expect(doc.accounts.map(a => a.backendId)).toEqual(['a'])
    expect(doc.actionKey).toBe('test-key')
  })

  it('carries an unavailable backend into the failures list', async () => {
    const svc = new UsageService({
      backends: () => [],
      failures: () => [{ id: 'qoder', message: 'boom' }],
      ledger: new UsageLedger(),
      actionKey: () => 'k',
    })
    const doc = await svc.document()
    expect(doc.failures).toEqual([{ id: 'qoder', message: 'boom' }])
  })

  it('omits the failures key entirely when there are none', async () => {
    const doc = await service([]).document()
    expect('failures' in doc).toBe(false)
  })

  it('reports no quota for an account that has not been refreshed', async () => {
    const one = backend(descriptor('a'), { discover: async () => [{ id: 'u1', label: 'U1' }] })
    const doc = await service([one]).document()
    expect(doc.accounts[0]!.quota).toBeUndefined()
    expect(doc.anyQuota).toBe(false)
  })

  it('fills the cache on refresh and then reports it', async () => {
    const one = backend(descriptor('a'), {
      discover: async () => [{ id: 'u1', label: 'U1' }],
      quota: async () => ({ kind: 'balance', remain: 10, unit: '积分' }),
    })
    const svc = service([one])
    const count = await svc.refreshQuotas()
    expect(count).toBe(1)
    const doc = await svc.document()
    expect(doc.accounts[0]!.quota).toEqual({ kind: 'balance', remain: 10, unit: '积分' })
    expect(doc.anyQuota).toBe(true)
  })

  it('keeps the last good figure but marks it stale when a refresh fails', async () => {
    let fail = false
    const one = backend(descriptor('a'), {
      discover: async () => [{ id: 'u1', label: 'U1' }],
      quota: async (): Promise<QuotaReading> => {
        if (fail) throw new Error('offline')
        return { kind: 'balance', remain: 5, unit: '积分' }
      },
    })
    const svc = service([one])
    await svc.refreshQuotas()
    fail = true
    await svc.refreshQuotas()
    const doc = await svc.document()
    // Both facts survive: the figure the user can act on, AND the news that it
    // is no longer current. Collapsing to either one alone loses information.
    expect(doc.accounts[0]!.quota).toEqual({
      kind: 'balance', remain: 5, unit: '积分', staleReason: 'offline',
    })
  })

  it('reports a bare error when no reading has ever succeeded', async () => {
    const one = backend(descriptor('a'), {
      discover: async () => [{ id: 'u1', label: 'U1' }],
      quota: async () => { throw new Error('offline') },
    })
    const svc = service([one])
    await svc.refreshQuotas()
    const doc = await svc.document()
    expect(doc.accounts[0]!.quota).toEqual({ kind: 'error', message: 'offline' })
  })

  it('clears the stale mark once a refresh succeeds again', async () => {
    let fail = false
    const one = backend(descriptor('a'), {
      discover: async () => [{ id: 'u1', label: 'U1' }],
      quota: async (): Promise<QuotaReading> => {
        if (fail) throw new Error('offline')
        return { kind: 'balance', remain: 9, unit: '积分' }
      },
    })
    const svc = service([one])
    await svc.refreshQuotas()
    fail = true
    await svc.refreshQuotas()
    fail = false
    await svc.refreshQuotas()
    const doc = await svc.document()
    expect(doc.accounts[0]!.quota).toEqual({ kind: 'balance', remain: 9, unit: '积分' })
  })

  it('counts only successful reads toward the refresh total', async () => {
    const good = backend(descriptor('a'), {
      discover: async () => [{ id: 'u1', label: 'U1' }],
      quota: async () => ({ kind: 'balance', remain: 1, unit: 'x' }),
    })
    const bad = backend(descriptor('b'), {
      discover: async () => [{ id: 'u2', label: 'U2' }],
      quota: async () => { throw new Error('nope') },
    })
    expect(await service([good, bad]).refreshQuotas()).toBe(1)
  })

  it('joins ledger tokens to the right account', async () => {
    const ledger = new UsageLedger()
    await ledger.load()
    const at = Date.now()
    ledger.record('a', 'u1', { uncachedInput: 100 }, at)
    ledger.record('b', 'u2', { uncachedInput: 7 }, at)
    const one = backend(descriptor('a'), { discover: async () => [{ id: 'u1', label: 'U1' }] })
    const two = backend(descriptor('b'), { discover: async () => [{ id: 'u2', label: 'U2' }] })
    const doc = await service([one, two], ledger).document(at)
    expect(doc.accounts[0]!.todayTokens.uncachedInput).toBe(100)
    expect(doc.accounts[1]!.todayTokens.uncachedInput).toBe(7)
    expect(doc.hasHistory).toBe(true)
  })

  it('clamps the window to a sane range', async () => {
    const svc = service([])
    svc.setWindowDays(0)
    expect(svc.currentWindowDays()).toBe(1)
    svc.setWindowDays(1e9)
    expect(svc.currentWindowDays()).toBe(3650)
    svc.setWindowDays(Number.NaN)
    expect(svc.currentWindowDays()).toBe(3650)
  })

  it('builds a document for the requested window', async () => {
    const svc = service([])
    svc.setWindowDays(7)
    const doc = await svc.document(new Date(2026, 2, 10).getTime())
    expect(doc.windowDays).toBe(7)
    expect(doc.days).toHaveLength(7)
  })

  it('clears the ledger through the service', async () => {
    const ledger = new UsageLedger()
    await ledger.load()
    ledger.record('a', 'u1', { output: 3 })
    const one = backend(descriptor('a'), { discover: async () => [{ id: 'u1', label: 'U1' }] })
    const svc = service([one], ledger)
    await svc.clearLedger()
    const doc = await svc.document()
    expect(doc.hasHistory).toBe(false)
  })

  it('skips backends that are unavailable or failed', async () => {
    const missing = backend(descriptor('a'), {
      discover: async () => { throw new BackendUnavailable('未安装') },
    })
    const broken = backend(descriptor('b'), {
      discover: async () => { throw new Error('boom') },
    })
    const doc = await service([missing, broken]).document()
    expect(doc.accounts).toEqual([])
    expect(await service([missing, broken]).refreshQuotas()).toBe(0)
  })
})
