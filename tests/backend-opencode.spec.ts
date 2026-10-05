import { describe, expect, it } from 'vitest'
import {
  OPENCODE_DESCRIPTOR,
  createOpenCodeBackend,
  parseRuntimeFreeModels,
} from '../src/backends/opencode.ts'

describe('OpenCode descriptor', () => {
  it('declares a managed-runtime backend that needs no account', () => {
    expect(OPENCODE_DESCRIPTOR.id).toBe('opencode')
    expect(OPENCODE_DESCRIPTOR.authKind).toBe('managed-runtime')
    expect(OPENCODE_DESCRIPTOR.multiAccount).toBe(false)
    expect(OPENCODE_DESCRIPTOR.reportsQuota).toBe(false)
  })

  it('declares honestly that it manages a runtime', () => {
    // Consumers use this to explain why the backend may be "not ready" on a
    // machine where everything else works.
    expect(OPENCODE_DESCRIPTOR.managesRuntime).toBe(true)
  })
})

describe('parseRuntimeFreeModels', () => {
  /** One provider entry with the given models under the free provider id. */
  function provider(id: string, models: Record<string, unknown>): unknown {
    return { all: [{ id, models }] }
  }

  const freeModel = { cost: { input: 0, output: 0 }, status: 'active' }

  it('keeps a genuinely free model', () => {
    const models = parseRuntimeFreeModels(provider('opencode', { 'big-pickle': freeModel }))
    expect(models.map(m => m.id)).toEqual(['big-pickle'])
  })

  it('drops a paid model', () => {
    const models = parseRuntimeFreeModels(provider('opencode', {
      paid: { cost: { input: 1, output: 2 } },
    }))
    expect(models).toEqual([])
  })

  it('drops a model with NO cost block', () => {
    // Absent pricing means the vendor did not say. Guessing "free" would spend
    // the user's money on a route that never claimed to be free.
    const models = parseRuntimeFreeModels(provider('opencode', { unknown: { status: 'active' } }))
    expect(models).toEqual([])
  })

  it('drops a model with a non-zero cache cost', () => {
    const models = parseRuntimeFreeModels(provider('opencode', {
      cached: { cost: { input: 0, output: 0, cache: { read: 0.1 } } },
    }))
    expect(models).toEqual([])
  })

  it('drops a deprecated model', () => {
    const models = parseRuntimeFreeModels(provider('opencode', {
      gone: { ...freeModel, status: 'deprecated' },
    }))
    expect(models).toEqual([])
  })

  it('drops a model that produces no text', () => {
    const models = parseRuntimeFreeModels(provider('opencode', {
      blind: { ...freeModel, capabilities: { output: { text: false } } },
    }))
    expect(models).toEqual([])
  })

  it('ignores other providers on the same runtime', () => {
    // A runtime can be configured with several providers; only the free one is
    // this backend's business.
    const models = parseRuntimeFreeModels(provider('other-provider', { 'x': freeModel }))
    expect(models).toEqual([])
  })

  it('reads capacity and image support when declared', () => {
    const models = parseRuntimeFreeModels(provider('opencode', {
      rich: {
        ...freeModel,
        name: 'Rich Model',
        limit: { context: 200000, output: 8192 },
        capabilities: { input: { image: true } },
      },
    }))
    expect(models[0]).toMatchObject({
      id: 'rich',
      name: 'Rich Model',
      contextWindow: 200000,
      maxTokens: 8192,
      supportsImages: true,
    })
  })

  it('falls back to the id when no name is given', () => {
    const models = parseRuntimeFreeModels(provider('opencode', { 'bare-id': freeModel }))
    expect(models[0]!.name).toBe('bare-id')
  })

  it('sorts by id so a cached document is diff-stable', () => {
    const models = parseRuntimeFreeModels(provider('opencode', {
      zeta: freeModel,
      alpha: freeModel,
    }))
    expect(models.map(m => m.id)).toEqual(['alpha', 'zeta'])
  })

  it('returns nothing for a malformed payload', () => {
    expect(parseRuntimeFreeModels(null)).toEqual([])
    expect(parseRuntimeFreeModels({})).toEqual([])
    expect(parseRuntimeFreeModels({ all: 'nope' })).toEqual([])
    expect(parseRuntimeFreeModels({ all: [null, 'x', 42] })).toEqual([])
  })
})

describe('OpenCode backend states', () => {
  it('resolves to a reportable state without throwing', async () => {
    const state = await createOpenCodeBackend().current()
    expect(['ready', 'signed-out', 'unavailable', 'failed']).toContain(state.state)
  })

  it('resolves WITHOUT touching the network or spawning anything', async () => {
    // Discovery runs for every backend at startup; a 57 MB download or a child
    // process here would stall the whole plugin's boot.
    const started = Date.now()
    await createOpenCodeBackend().current()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('gives an actionable hint when nothing is prepared', async () => {
    const state = await createOpenCodeBackend().current()
    if (state.state === 'unavailable') {
      // The hint must name a real way forward, not just report the absence.
      expect(state.hint.length).toBeGreaterThan(20)
    }
  })

  it('declines to report a balance', async () => {
    expect((await createOpenCodeBackend().readQuota('local-runtime')).kind).toBe('unavailable')
  })
})
