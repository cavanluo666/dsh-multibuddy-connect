import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBackends } from '../src/backends/catalog.ts'
import { createRegistry } from '../src/backends/wiring.ts'

describe('backend catalogue integration', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'catalog-'))
    previous = process.env['DSH_WORKBUDDY_DATA_DIR']
    process.env['DSH_WORKBUDDY_DATA_DIR'] = dir
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env['DSH_WORKBUDDY_DATA_DIR']
    else process.env['DSH_WORKBUDDY_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  })

  it('builds every catalogued backend without throwing', async () => {
    const { backends, failures } = await loadBackends(createRegistry())
    expect(failures).toEqual([])
    expect(backends.map(b => b.descriptor.id)).toEqual([
      'loomy', 'mimo', 'cline', 'commandcode', 'trae', 'qoder', 'codebuddy', 'opencode',
    ])
  })

  it('resolves each backend containably, never throwing', async () => {
    const { backends } = await loadBackends(createRegistry())
    for (const backend of backends) {
      const state = await backend.current()
      // Any of the four states is fine; what matters is that none of them is a
      // thrown exception, because one bad backend must not stop the others.
      expect(['ready', 'signed-out', 'unavailable', 'failed']).toContain(state.state)
    }
  })

  it('gives every backend a distinct provider id and settings namespace', async () => {
    const { backends } = await loadBackends(createRegistry())
    const ids = backends.map(b => b.descriptor.id)
    expect(new Set(ids).size).toBe(ids.length)
    const namespaces = backends.map(b => b.descriptor.settingsNs)
    expect(new Set(namespaces).size).toBe(namespaces.length)
  })

  it('declares multi-account honestly, per the vendor model', async () => {
    const { backends } = await loadBackends(createRegistry())
    const byId = new Map(backends.map(b => [b.descriptor.id, b.descriptor]))
    // Single-login-slot desktop apps: "add account" would have nothing to write.
    expect(byId.get('loomy')?.multiAccount).toBe(false)
    expect(byId.get('mimo')?.multiAccount).toBe(false)
    expect(byId.get('codebuddy')?.multiAccount).toBe(false)
    // Key-based, or several independent installs.
    expect(byId.get('cline')?.multiAccount).toBe(true)
    expect(byId.get('commandcode')?.multiAccount).toBe(true)
    expect(byId.get('trae')?.multiAccount).toBe(true)
    expect(byId.get('qoder')?.multiAccount).toBe(true)
  })

  it('gives every backend a distinct display name', async () => {
    const { backends } = await loadBackends(createRegistry())
    const names = backends.map(b => b.descriptor.displayName)
    expect(new Set(names).size).toBe(names.length)
  })

  it('disposes cleanly', async () => {
    const { backends } = await loadBackends(createRegistry())
    for (const backend of backends) await backend.dispose?.()
  })
})
