import { describe, expect, it } from 'vitest'
import { BaseBackendAdapter, BackendUnavailable, messageOf, type BackendImpl } from '../src/backends/base.ts'
import type { BackendDescriptor } from '../src/backends/types.ts'

const DESCRIPTOR: BackendDescriptor = {
  id: 'probe',
  displayName: 'Probe',
  authKind: 'desktop-adoption',
  multiAccount: false,
  reportsQuota: true,
  reportsTokenUsage: false,
  settingsNs: 'llm-probe',
}

function adapter(impl: Partial<BackendImpl>, overrides: Partial<BackendDescriptor> = {}): BaseBackendAdapter {
  return new (class extends BaseBackendAdapter {})({ ...DESCRIPTOR, ...overrides }, {
    discover: async () => [],
    ...impl,
  } as BackendImpl)
}

describe('BaseBackendAdapter', () => {
  it('reports ready with accounts when discovery finds some', async () => {
    const backend = adapter({ discover: async () => [{ id: 'u1', label: 'User', detail: '138****8888' }] })
    const state = await backend.resolveAccounts()
    expect(state.state).toBe('ready')
    if (state.state !== 'ready') throw new Error('unreachable')
    expect(state.accounts).toEqual([{ id: 'u1', label: 'User', detail: '138****8888', usable: true }])
  })

  it('turns an empty discovery into signed-out rather than an error', async () => {
    const backend = adapter({ discover: async () => [] })
    expect(await backend.resolveAccounts()).toEqual({ state: 'signed-out' })
  })

  it('reports a missing prerequisite as unavailable, keeping the hint', async () => {
    const backend = adapter({ discover: async () => { throw new BackendUnavailable('请先安装客户端') } })
    expect(await backend.resolveAccounts()).toEqual({ state: 'unavailable', hint: '请先安装客户端' })
  })

  it('contains an unexpected fault as failed instead of throwing', async () => {
    const backend = adapter({ discover: async () => { throw new Error('boom') } })
    const state = await backend.resolveAccounts()
    expect(state).toEqual({ state: 'failed', message: 'boom' })
  })

  it('never throws even for a non-Error rejection', async () => {
    const backend = adapter({ discover: async () => { throw 'plain string' } })
    expect(await backend.resolveAccounts()).toEqual({ state: 'failed', message: 'plain string' })
  })

  it('caches the resolution until forced', async () => {
    let calls = 0
    const backend = adapter({ discover: async () => { calls += 1; return [] } })
    await backend.resolveAccounts()
    await backend.resolveAccounts()
    expect(calls).toBe(1)
    await backend.resolveAccounts(true)
    expect(calls).toBe(2)
  })

  it('exposes the accounts it resolved', async () => {
    const backend = adapter({ discover: async () => [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })
    await backend.resolveAccounts()
    expect(backend.knownAccounts().map(a => a.id)).toEqual(['a', 'b'])
  })

  it('drops known accounts when the backend becomes signed out', async () => {
    let found = [{ id: 'a', label: 'A' }]
    const backend = adapter({ discover: async () => found })
    await backend.resolveAccounts()
    expect(backend.knownAccounts()).toHaveLength(1)
    found = []
    await backend.resolveAccounts(true)
    expect(backend.knownAccounts()).toEqual([])
  })

  it('declares unavailable for a backend without a billing endpoint, without calling it', async () => {
    let called = false
    const backend = adapter({ quota: async () => { called = true; return { kind: 'unavailable', reason: 'x' } } }, { reportsQuota: false })
    const reading = await backend.readQuota('a')
    expect(reading.kind).toBe('unavailable')
    expect(called).toBe(false)
  })

  it('turns a quota failure into an error reading, not an exception', async () => {
    const backend = adapter({ quota: async () => { throw new Error('network down') } })
    const reading = await backend.readQuota('a')
    expect(reading).toEqual({ kind: 'error', message: 'network down' })
  })

  it('passes a good quota reading through', async () => {
    const backend = adapter({ quota: async () => ({ kind: 'balance', remain: 42, unit: '积分' }) })
    expect(await backend.readQuota('a')).toEqual({ kind: 'balance', remain: 42, unit: '积分' })
  })

  it('degrades an unreadable model list to an empty roster', async () => {
    const backend = adapter({ models: async () => { throw new Error('bad json') } })
    expect(await backend.listModels('a')).toEqual([])
  })

  it('returns an empty roster when the backend declares no models', async () => {
    expect(await adapter({}).listModels('a')).toEqual([])
  })

  it('disposes its own resources and forgets cached state', async () => {
    let disposed = false
    const backend = adapter({
      discover: async () => [{ id: 'a', label: 'A' }],
      dispose: async () => { disposed = true },
    })
    await backend.resolveAccounts()
    await backend.dispose()
    expect(disposed).toBe(true)
    expect(backend.knownAccounts()).toEqual([])
  })

  it('marks an account unusable with its reason', async () => {
    const backend = adapter({ discover: async () => [{ id: 'a', label: 'A', usable: false, reason: '凭据已过期' }] })
    const state = await backend.resolveAccounts()
    if (state.state !== 'ready') throw new Error('unreachable')
    expect(state.accounts[0]!.usable).toBe(false)
    expect(state.accounts[0]!.reason).toBe('凭据已过期')
  })
})

describe('messageOf', () => {
  it('reads an Error, a string, and anything else', () => {
    expect(messageOf(new Error('e'))).toBe('e')
    expect(messageOf('s')).toBe('s')
    expect(messageOf(42)).toBe('42')
  })
})
