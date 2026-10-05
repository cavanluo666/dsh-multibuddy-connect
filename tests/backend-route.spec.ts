import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import {
  accountIdFromLabel,
  applyBackendsAction,
  backendsActionRoute,
  backendsDocumentRoute,
  buildBackendsDocument,
  isConfigurable,
  parseBackendsAction,
  registerBackendsRoute,
} from '../src/backends/route.ts'
import { BackendAccountRegistry } from '../src/backends/registry.ts'
import { BaseBackendAdapter, type BackendImpl } from '../src/backends/base.ts'
import type { BackendDescriptor } from '../src/backends/types.ts'
import { WORKBUDDY_BACKENDS_ACTION_PATH, WORKBUDDY_BACKENDS_PATH } from '../src/backends-paths.ts'

/**
 * WHY THIS FILE EXISTS.
 *
 * The backend configuration routes are the ONLY way an api-key backend's
 * account is ever created — the registry has no other writer. A silent failure
 * here means a user types a key, is told it saved, and gets a backend that
 * never authenticates. So the registration contract, the document shape, and
 * every write path are all pinned here.
 */

function descriptor(id: string, overrides: Partial<BackendDescriptor> = {}): BackendDescriptor {
  return {
    id,
    displayName: id.toUpperCase(),
    authKind: 'api-key',
    multiAccount: true,
    reportsQuota: false,
    reportsTokenUsage: false,
    settingsNs: 'llm-' + id,
    ...overrides,
  }
}

function backend(desc: BackendDescriptor, impl: Partial<BackendImpl>): BaseBackendAdapter {
  return new (class extends BaseBackendAdapter {})(desc, {
    discover: async () => [],
    ...impl,
  } as BackendImpl)
}

interface CapturedRoute {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void
}

function fakeContext(): { ctx: Context; routes: Map<string, CapturedRoute>; disposers: (() => void)[] } {
  const routes = new Map<string, CapturedRoute>()
  const disposers: (() => void)[] = []
  const ctx = {
    webServer: {
      register(route: CapturedRoute): () => void {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    effect(callback: () => (() => void) | undefined): () => void {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
  } as unknown as Context
  return { ctx, routes, disposers }
}

function fakeRequest(method: string, host = '127.0.0.1'): IncomingMessage {
  return { method, headers: { host } } as unknown as IncomingMessage
}

function fakeResponse(): { res: ServerResponse; status: () => number; body: () => unknown; settled: () => Promise<void> } {
  let code = 0
  let payload = ''
  let done = (): void => {}
  const settled = new Promise<void>(resolve => { done = resolve })
  const res = {
    writeHead(status: number) { code = status },
    end(chunk?: unknown) { if (typeof chunk === 'string') payload = chunk; done() },
    setHeader() {},
  } as unknown as ServerResponse
  return {
    res,
    status: () => code,
    body: () => payload === '' ? undefined : JSON.parse(payload),
    settled: () => settled,
  }
}

describe('accountIdFromLabel', () => {
  it('slugs a Latin label', () => {
    expect(accountIdFromLabel('Work Key')).toBe('work-key')
  })

  it('keeps non-Latin labels intact', () => {
    // No transliteration: the id only ever appears in JSON and a log line, and
    // mangling a user's label would make the stored account unrecognisable.
    expect(accountIdFromLabel('工作')).toBe('工作')
  })

  it('falls back rather than producing an empty id', () => {
    expect(accountIdFromLabel('   ')).toBe('default')
    expect(accountIdFromLabel('!!!')).toBe('default')
  })
})

describe('isConfigurable', () => {
  it('is true only for api-key backends', () => {
    expect(isConfigurable('api-key')).toBe(true)
    // These read ANOTHER application's credential; a write control would have
    // nothing behind it.
    expect(isConfigurable('desktop-adoption')).toBe(false)
    expect(isConfigurable('managed-runtime')).toBe(false)
    expect(isConfigurable('device-code')).toBe(false)
  })
})

describe('parseBackendsAction', () => {
  it('accepts refresh', () => {
    expect(parseBackendsAction('{"action":"refresh"}')).toEqual({ action: 'refresh' })
  })

  it('accepts add-account with a secret', () => {
    const parsed = parseBackendsAction('{"action":"add-account","backendId":"cline","label":"Work","secret":" sk-1 "}')
    expect(parsed).toEqual({ action: 'add-account', backendId: 'cline', label: 'Work', secret: 'sk-1' })
  })

  it('refuses add-account without a secret', () => {
    expect(parseBackendsAction('{"action":"add-account","backendId":"cline"}')).toBeUndefined()
    expect(parseBackendsAction('{"action":"add-account","backendId":"cline","secret":"   "}')).toBeUndefined()
  })

  it('refuses remove-account without both ids', () => {
    expect(parseBackendsAction('{"action":"remove-account","backendId":"cline"}')).toBeUndefined()
    expect(parseBackendsAction('{"action":"remove-account","accountId":"work"}')).toBeUndefined()
  })

  it('refuses an unknown action and malformed input', () => {
    expect(parseBackendsAction('{"action":"nuke"}')).toBeUndefined()
    expect(parseBackendsAction('{ nope')).toBeUndefined()
    expect(parseBackendsAction('[]')).toBeUndefined()
  })
})

describe('buildBackendsDocument', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'backend-route-'))
    previous = process.env['DSH_WORKBUDDY_DATA_DIR']
    process.env['DSH_WORKBUDDY_DATA_DIR'] = dir
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env['DSH_WORKBUDDY_DATA_DIR']
    else process.env['DSH_WORKBUDDY_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  })

  function options(backends: BaseBackendAdapter[], registry = new BackendAccountRegistry(), failures: { id: string; message: string }[] = []) {
    return {
      registry: () => registry,
      backends: () => backends,
      failures: () => failures,
      actionKey: () => 'the-key',
    }
  }

  it('describes every backend with its auth kind and configurability', async () => {
    const doc = await buildBackendsDocument(options([
      backend(descriptor('cline'), { discover: async () => [] }),
      backend(descriptor('trae', { authKind: 'desktop-adoption', multiAccount: true }), { discover: async () => [] }),
    ]))
    expect(doc.backends.map(b => b.id)).toEqual(['cline', 'trae'])
    expect(doc.backends[0]!.configurable).toBe(true)
    expect(doc.backends[1]!.configurable).toBe(false)
    expect(doc.actionKey).toBe('the-key')
  })

  it('NEVER sends a stored secret, only a masked form', async () => {
    const registry = new BackendAccountRegistry()
    await registry.put('cline', { id: 'work', label: 'Work', secret: 'sk-super-secret-value', updatedAtMs: 0 })
    const doc = await buildBackendsDocument(options([backend(descriptor('cline'), { discover: async () => [] })], registry))
    const serialised = JSON.stringify(doc)
    expect(serialised).not.toContain('sk-super-secret-value')
    expect(doc.backends[0]!.stored[0]!.secretMasked).toContain('…')
  })

  it('omits stored accounts for a backend that cannot be configured', async () => {
    const registry = new BackendAccountRegistry()
    await registry.put('trae', { id: 'x', label: 'X', secret: 'tok', updatedAtMs: 0 })
    const doc = await buildBackendsDocument(options(
      [backend(descriptor('trae', { authKind: 'desktop-adoption' }), { discover: async () => [] })], registry))
    expect(doc.backends[0]!.stored).toEqual([])
  })

  it('carries discovered accounts for a ready backend', async () => {
    const doc = await buildBackendsDocument(options([
      backend(descriptor('mimo', { authKind: 'desktop-adoption' }), {
        discover: async () => [{ id: 'u1', label: 'Xiaomi', detail: '138****8888' }],
      }),
    ]))
    expect(doc.backends[0]!.accounts).toHaveLength(1)
    expect(doc.backends[0]!.accounts[0]!.label).toBe('Xiaomi')
    expect(doc.backends[0]!.state).toBe('ready')
  })

  it('reports a backend failure separately, since it has no descriptor', async () => {
    const doc = await buildBackendsDocument(options([], new BackendAccountRegistry(), [{ id: 'qoder', message: 'boom' }]))
    expect(doc.failures).toEqual([{ id: 'qoder', message: 'boom' }])
  })

  it('omits the failures key entirely when there are none', async () => {
    const doc = await buildBackendsDocument(options([]))
    expect('failures' in doc).toBe(false)
  })
})

describe('applyBackendsAction', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'backend-action-'))
    previous = process.env['DSH_WORKBUDDY_DATA_DIR']
    process.env['DSH_WORKBUDDY_DATA_DIR'] = dir
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env['DSH_WORKBUDDY_DATA_DIR']
    else process.env['DSH_WORKBUDDY_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  })

  it('stores an account and triggers a reload', async () => {
    const registry = new BackendAccountRegistry()
    let reloads = 0
    const result = await applyBackendsAction({
      registry: () => registry,
      backends: () => [backend(descriptor('cline'), { discover: async () => [] })],
      actionKey: () => 'k',
      reload: async () => { reloads += 1 },
    }, { action: 'add-account', backendId: 'cline', label: 'Work', secret: 'sk-1' })
    expect(result.ok).toBe(true)
    expect(reloads).toBe(1)
    const stored = await registry.list('cline')
    expect(stored).toHaveLength(1)
    expect(stored[0]!.secret).toBe('sk-1')
  })

  it('replaces rather than duplicates when the same label is added twice', async () => {
    const registry = new BackendAccountRegistry()
    const base = {
      registry: () => registry,
      backends: () => [backend(descriptor('cline'), { discover: async () => [] })],
      actionKey: () => 'k',
    }
    await applyBackendsAction(base, { action: 'add-account', backendId: 'cline', label: 'Work', secret: 'sk-1' })
    await applyBackendsAction(base, { action: 'add-account', backendId: 'cline', label: 'Work', secret: 'sk-2' })
    const stored = await registry.list('cline')
    expect(stored).toHaveLength(1)
    expect(stored[0]!.secret).toBe('sk-2')
  })

  it('removes an account', async () => {
    const registry = new BackendAccountRegistry()
    await registry.put('cline', { id: 'work', label: 'Work', secret: 'sk-1', updatedAtMs: 0 })
    const result = await applyBackendsAction({
      registry: () => registry,
      backends: () => [backend(descriptor('cline'), { discover: async () => [] })],
      actionKey: () => 'k',
    }, { action: 'remove-account', backendId: 'cline', accountId: 'work' })
    expect(result.ok).toBe(true)
    expect(await registry.list('cline')).toEqual([])
  })

  it('REFUSES to store an account for a backend it cannot configure', async () => {
    // The route is reachable by anything holding the key, so the refusal has to
    // live here rather than only in the UI.
    const registry = new BackendAccountRegistry()
    const result = await applyBackendsAction({
      registry: () => registry,
      backends: () => [backend(descriptor('trae', { authKind: 'desktop-adoption' }), { discover: async () => [] })],
      actionKey: () => 'k',
    }, { action: 'add-account', backendId: 'trae', label: 'X', secret: 'tok' })
    expect(result.ok).toBe(false)
    expect(await registry.list('trae')).toEqual([])
  })

  it('reports an unknown backend instead of silently succeeding', async () => {
    const result = await applyBackendsAction({
      registry: () => new BackendAccountRegistry(),
      backends: () => [],
      actionKey: () => 'k',
    }, { action: 'add-account', backendId: 'nope', label: 'X', secret: 's' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('nope')
  })
})

describe('backend configuration routes over real HTTP', () => {
  let server: Server & { closeAllConnections?: () => void }
  let port: number
  let routes: Map<string, CapturedRoute>
  let registry: BackendAccountRegistry

  async function mount(): Promise<void> {
    server = createServer((req, res) => {
      const route = routes.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
      if (route === undefined) { res.writeHead(404); res.end(); return }
      route.handler(req, res)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    port = typeof address === 'object' && address !== null ? address.port : 0
  }

  function url(path: string): string {
    return 'http://127.0.0.1:' + String(port) + path
  }

  beforeEach(async () => {
    registry = new BackendAccountRegistry()
    const fake = fakeContext()
    routes = fake.routes
    registerBackendsRoute(fake.ctx, {
      registry: () => registry,
      backends: () => [backend(descriptor('cline'), { discover: async () => [] })],
      actionKey: () => 'the-key',
    })
    await mount()
  })

  afterEach(async () => {
    server.closeAllConnections?.()
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  })

  it('mounts both paths on the webServer service', () => {
    expect(routes.has(WORKBUDDY_BACKENDS_PATH)).toBe(true)
    expect(routes.has(WORKBUDDY_BACKENDS_ACTION_PATH)).toBe(true)
  })

  it('serves the document on GET', async () => {
    const response = await fetch(url(WORKBUDDY_BACKENDS_PATH))
    expect(response.status).toBe(200)
    const body = await response.json() as { backends: { id: string }[]; actionKey: string }
    expect(body.backends.map(b => b.id)).toEqual(['cline'])
    expect(body.actionKey).toBe('the-key')
  })

  it('refuses a non-loopback Host', async () => {
    const captured = routes.get(WORKBUDDY_BACKENDS_PATH)!
    const response = fakeResponse()
    captured.handler(fakeRequest('GET', 'evil.example.com'), response.res)
    await response.settled()
    expect(response.status()).toBe(403)
  })

  it('refuses a write with no key', async () => {
    const response = await fetch(url(WORKBUDDY_BACKENDS_ACTION_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'refresh' }),
    })
    expect(response.status).toBe(403)
  })

  it('accepts a write with the key and stores the account', async () => {
    const response = await fetch(url(WORKBUDDY_BACKENDS_ACTION_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workbuddy-key': 'the-key' },
      body: JSON.stringify({ action: 'add-account', backendId: 'cline', label: 'Work', secret: 'sk-1' }),
    })
    expect(response.status).toBe(200)
    const stored = await registry.list('cline')
    expect(stored[0]!.secret).toBe('sk-1')
  })

  it('refuses a wrong method', async () => {
    const response = await fetch(url(WORKBUDDY_BACKENDS_PATH), { method: 'POST' })
    expect(response.status).toBe(405)
    const write = await fetch(url(WORKBUDDY_BACKENDS_ACTION_PATH))
    expect(write.status).toBe(405)
  })
})
