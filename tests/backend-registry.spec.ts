import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendAccountRegistry, backendAccountsPath, maskSecret } from '../src/backends/registry.ts'

describe('backend account registry', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'backend-registry-'))
    previous = process.env['DSH_WORKBUDDY_DATA_DIR']
    process.env['DSH_WORKBUDDY_DATA_DIR'] = dir
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env['DSH_WORKBUDDY_DATA_DIR']
    else process.env['DSH_WORKBUDDY_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  })

  it('reports an empty set for a backend that never wrote', async () => {
    const registry = new BackendAccountRegistry()
    expect(await registry.list('qoder-cn')).toEqual([])
    expect(await registry.get('qoder-cn', 'anything')).toBeUndefined()
  })

  it('keeps two accounts of one backend apart', async () => {
    const registry = new BackendAccountRegistry()
    await registry.put('commandcode', { id: 'work', label: 'Work key', secret: { key: 'sk-work' }, updatedAtMs: 0 })
    await registry.put('commandcode', { id: 'personal', label: 'Personal key', secret: { key: 'sk-personal' }, updatedAtMs: 0 })
    const accounts = await registry.list('commandcode')
    expect(accounts).toHaveLength(2)
    expect((await registry.get('commandcode', 'work'))?.secret).toEqual({ key: 'sk-work' })
    expect((await registry.get('commandcode', 'personal'))?.secret).toEqual({ key: 'sk-personal' })
  })

  it('writes one file per backend, so accounts cannot cross backends', async () => {
    const registry = new BackendAccountRegistry()
    await registry.put('cline', { id: 'default', label: 'Cline', secret: { key: 'a' }, updatedAtMs: 0 })
    await registry.put('loomy', { id: 'default', label: 'Loomy', secret: { key: 'b' }, updatedAtMs: 0 })
    const files = await readdir(dir)
    expect(files.some(name => name.includes('cline'))).toBe(true)
    expect(files.some(name => name.includes('loomy'))).toBe(true)
    // Same account id in both backends must not collide.
    expect((await registry.get('cline', 'default'))?.secret).toEqual({ key: 'a' })
    expect((await registry.get('loomy', 'default'))?.secret).toEqual({ key: 'b' })
  })

  it('replaces in place, preserving the order of the other accounts', async () => {
    const registry = new BackendAccountRegistry()
    await registry.put('trae', { id: 'cn', label: 'Trae CN', secret: 1, updatedAtMs: 0 })
    await registry.put('trae', { id: 'global', label: 'Trae Global', secret: 2, updatedAtMs: 0 })
    await registry.put('trae', { id: 'cn', label: 'Trae CN (updated)', secret: 3, updatedAtMs: 0 })
    const accounts = await registry.list('trae')
    expect(accounts.map(a => a.id)).toEqual(['cn', 'global'])
    expect(accounts[0]?.label).toBe('Trae CN (updated)')
  })

  it('survives a restart', async () => {
    const first = new BackendAccountRegistry()
    await first.put('mimo', { id: 'default', label: 'MiMo', detail: '138****8888', secret: { cookie: 'x' }, updatedAtMs: 0 })
    const second = new BackendAccountRegistry()
    expect(await second.list('mimo')).toHaveLength(1)
    expect((await second.get('mimo', 'default'))?.detail).toBe('138****8888')
  })

  it('removes one account and leaves the rest', async () => {
    const registry = new BackendAccountRegistry()
    await registry.put('qoder', { id: 'a', label: 'A', secret: 1, updatedAtMs: 0 })
    await registry.put('qoder', { id: 'b', label: 'B', secret: 2, updatedAtMs: 0 })
    await registry.remove('qoder', 'a')
    expect((await registry.list('qoder')).map(a => a.id)).toEqual(['b'])
    // Removing an unknown id is a no-op, not an error.
    await registry.remove('qoder', 'nope')
    expect(await registry.list('qoder')).toHaveLength(1)
  })

  it('treats a corrupt file as signed out rather than throwing', async () => {
    await writeFile(backendAccountsPath('broken'), '{ not json', 'utf8')
    const registry = new BackendAccountRegistry()
    expect(await registry.list('broken')).toEqual([])
  })

  it('refuses a future format version instead of misreading it', async () => {
    await writeFile(backendAccountsPath('future'), JSON.stringify({
      version: 99,
      backendId: 'future',
      accounts: [{ id: 'x', label: 'X', secret: 's', updatedAtMs: 0 }],
    }), 'utf8')
    const registry = new BackendAccountRegistry()
    expect(await registry.list('future')).toEqual([])
  })

  it('skips malformed rows in an otherwise valid file', async () => {
    await writeFile(backendAccountsPath('mixed'), JSON.stringify({
      version: 1,
      backendId: 'mixed',
      accounts: [
        { id: 'good', label: 'Good', secret: 1, updatedAtMs: 0 },
        { id: '', label: 'No id', secret: 2, updatedAtMs: 0 },
        { label: 'No id field', secret: 3, updatedAtMs: 0 },
        null,
      ],
    }), 'utf8')
    const registry = new BackendAccountRegistry()
    expect((await registry.list('mixed')).map(a => a.id)).toEqual(['good'])
  })

  it('sanitizes a backend id into a safe filename', () => {
    const path = backendAccountsPath('../../evil')
    expect(path).not.toContain('..')
    expect(path).toContain('evil')
  })
})

describe('maskSecret', () => {
  it('shows a short prefix and suffix for a long secret', () => {
    expect(maskSecret('sk-abcdefghijklmnop')).toBe('sk-a…mnop')
  })

  it('masks a short secret entirely', () => {
    expect(maskSecret('short')).toBe('•••••')
  })
})
