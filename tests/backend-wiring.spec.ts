import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendAccountRegistry } from '../src/backends/registry.ts'
import { seedsFor } from '../src/backends/wiring.ts'

describe('seedsFor', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wiring-'))
    previous = process.env['DSH_WORKBUDDY_DATA_DIR']
    process.env['DSH_WORKBUDDY_DATA_DIR'] = dir
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env['DSH_WORKBUDDY_DATA_DIR']
    else process.env['DSH_WORKBUDDY_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  })

  it('returns undefined when the backend was never configured', async () => {
    // The environment variable must stay in play in this case: a developer who
    // exports CLINE_API_KEY should get a working provider without opening the card.
    expect(await seedsFor(new BackendAccountRegistry(), 'cline')).toBeUndefined()
  })

  it('returns the configured accounts', async () => {
    const registry = new BackendAccountRegistry()
    await registry.put('cline', { id: 'a', label: 'A', secret: 'sk-a', updatedAtMs: 0 })
    await registry.put('cline', { id: 'b', label: 'B', secret: 'sk-b', updatedAtMs: 0 })
    expect(await seedsFor(registry, 'cline')).toEqual([
      { id: 'a', label: 'A', secret: 'sk-a' },
      { id: 'b', label: 'B', secret: 'sk-b' },
    ])
  })

  it('returns an empty list — NOT undefined — after the last account is deleted', async () => {
    // The distinction this whole module exists for: a user who removes every
    // account must not have one resurrected from the environment on restart.
    const registry = new BackendAccountRegistry()
    await registry.put('cline', { id: 'a', label: 'A', secret: 'sk-a', updatedAtMs: 0 })
    await registry.remove('cline', 'a')
    expect(await seedsFor(registry, 'cline')).toEqual([])
  })

  it('drops an account whose secret is missing or not a string', async () => {
    const registry = new BackendAccountRegistry()
    await registry.put('cline', { id: 'good', label: 'Good', secret: 'sk-good', updatedAtMs: 0 })
    await registry.put('cline', { id: 'empty', label: 'Empty', secret: '   ', updatedAtMs: 0 })
    await registry.put('cline', { id: 'wrong', label: 'Wrong', secret: { nested: true }, updatedAtMs: 0 })
    const seeds = await seedsFor(registry, 'cline')
    expect(seeds?.map(seed => seed.id)).toEqual(['good'])
  })

  it('falls back to undefined when every configured row is unusable and nothing was ever valid', async () => {
    const registry = new BackendAccountRegistry()
    await registry.put('cline', { id: 'broken', label: 'Broken', secret: {}, updatedAtMs: 0 })
    // The file EXISTS, so this is "configured" — but no usable seed remains.
    // Answering undefined would re-enable the environment fallback the user
    // opted out of by configuring an account at all.
    expect(await seedsFor(registry, 'cline')).toEqual([])
  })

  it('keeps backends independent', async () => {
    const registry = new BackendAccountRegistry()
    await registry.put('cline', { id: 'c', label: 'C', secret: 'sk-c', updatedAtMs: 0 })
    expect(await seedsFor(registry, 'commandcode')).toBeUndefined()
    expect((await seedsFor(registry, 'cline'))?.map(s => s.id)).toEqual(['c'])
  })

  it('trims surrounding whitespace off a pasted key', async () => {
    // A key copied out of a web page routinely carries a trailing newline, and
    // an untrimmed value fails authentication with no visible cause.
    const registry = new BackendAccountRegistry()
    await registry.put('cline', { id: 'a', label: 'A', secret: '  sk-padded\n', updatedAtMs: 0 })
    expect((await seedsFor(registry, 'cline'))?.[0]?.secret).toBe('sk-padded')
  })
})

describe('BackendAccountRegistry.hasStored', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hasstored-'))
    previous = process.env['DSH_WORKBUDDY_DATA_DIR']
    process.env['DSH_WORKBUDDY_DATA_DIR'] = dir
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env['DSH_WORKBUDDY_DATA_DIR']
    else process.env['DSH_WORKBUDDY_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  })

  it('is false before anything is written', async () => {
    expect(await new BackendAccountRegistry().hasStored('cline')).toBe(false)
  })

  it('is true after a write, and stays true after the last account is removed', async () => {
    const registry = new BackendAccountRegistry()
    await registry.put('cline', { id: 'a', label: 'A', secret: 's', updatedAtMs: 0 })
    expect(await registry.hasStored('cline')).toBe(true)
    await registry.remove('cline', 'a')
    expect(await registry.hasStored('cline')).toBe(true)
  })
})
