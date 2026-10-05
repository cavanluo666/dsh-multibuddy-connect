import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import { registerUsageRoute } from '../src/usage-route.ts'
import {
  WORKBUDDY_USAGE_ACTION_PATH,
  WORKBUDDY_USAGE_PATH,
} from '../src/usage-paths.ts'
import type { UsageService } from '../src/usage/service.ts'

/**
 * WHY THIS FILE EXISTS.
 *
 * The first version of the usage route reached for `webServer.get()` and
 * `webServer.post()` — methods the Host's webServer service does not have.
 * Because both were optional calls, nothing threw: no route was mounted, and
 * the dashboard's fetch came back **404**. The build passed, the type check
 * passed, and the whole test suite passed, because nothing anywhere asserted
 * that the routes had actually been REGISTERED.
 *
 * These tests assert the registration contract itself and then drive the
 * handlers over real HTTP, so a repeat — wrong API, wrong path, missing method
 * check — fails here instead of in a browser.
 */

/** One captured registration. */
interface CapturedRoute {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void
}

/**
 * A stand-in for the Host's webServer service that records what was registered.
 *
 * Deliberately exposes ONLY `register` — the real service's shape. A stub that
 * also happened to have `.get` would have let the original buggy call site
 * "work" in the test while failing in production, which is worse than no test.
 */
function fakeContext(): { ctx: Context; routes: Map<string, CapturedRoute>; disposers: (() => void)[] } {
  const routes = new Map<string, CapturedRoute>()
  const disposers: (() => void)[] = []
  const ctx = {
    webServer: {
      register(route: CapturedRoute): () => void {
        routes.set(route.path, route)
        const dispose = (): void => {
          routes.delete(route.path)
        }
        return dispose
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

/** A service stub carrying only what the routes touch. */
function fakeService(overrides: Partial<UsageService> = {}): UsageService {
  const service = {
    async document() {
      return {
        fromDay: '2026-03-01',
        toDay: '2026-03-30',
        accounts: [],
        days: [],
        backends: [],
        windowTotals: { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        windowCalls: 0,
        todayTotals: { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        anyQuota: false,
        hasHistory: false,
        actionKey: 'the-key',
        windowDays: 30,
      }
    },
    actionKey: () => 'the-key',
    async refreshQuotas() { return 2 },
    async clearLedger() {},
    setWindowDays(_days: number) {},
    ...overrides,
  } as unknown as UsageService
  return service
}

describe('usage route registration', () => {
  it('mounts BOTH paths on the webServer service', () => {
    // The assertion that the original 404 would have failed: the routes must go
    // through `webServer.register`, which is the service's only mounting API.
    const { ctx, routes } = fakeContext()
    registerUsageRoute(ctx, { service: () => fakeService() })
    expect(routes.has(WORKBUDDY_USAGE_PATH)).toBe(true)
    expect(routes.has(WORKBUDDY_USAGE_ACTION_PATH)).toBe(true)
    expect(routes.get(WORKBUDDY_USAGE_PATH)?.kind).toBe('exact')
    expect(routes.get(WORKBUDDY_USAGE_ACTION_PATH)?.kind).toBe('exact')
  })

  it('honours path overrides', () => {
    const { ctx, routes } = fakeContext()
    registerUsageRoute(ctx, {
      service: () => fakeService(),
      path: '/plugins/custom/usage',
      actionPath: '/plugins/custom/usage/action',
    })
    expect(routes.has('/plugins/custom/usage')).toBe(true)
    expect(routes.has('/plugins/custom/usage/action')).toBe(true)
  })

  it('unmounts both routes when the fiber unwinds', () => {
    const { ctx, routes, disposers } = fakeContext()
    registerUsageRoute(ctx, { service: () => fakeService() })
    expect(routes.size).toBe(2)
    for (const dispose of disposers) dispose()
    expect(routes.size).toBe(0)
  })
})

describe('usage routes over real HTTP', () => {
  let server: Server & { closeAllConnections?: () => void }
  let port: number
  let routes: Map<string, CapturedRoute>

  /** Serve the captured routes exactly as the Host's web server would. */
  async function mount(): Promise<void> {
    server = createServer((req, res) => {
      const route = routes.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
      if (route === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      route.handler(req, res)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    port = typeof address === 'object' && address !== null ? address.port : 0
  }

  function url(path: string): string {
    return `http://127.0.0.1:${port}${path}`
  }

  beforeEach(async () => {
    const fake = fakeContext()
    routes = fake.routes
    registerUsageRoute(fake.ctx, { service: () => fakeService() })
    await mount()
  })

  afterEach(async () => {
    // `fetch` keeps connections alive, and a bare `close()` waits for them — the
    // suite hung here rather than failing. Closing idle sockets first makes the
    // teardown deterministic.
    server.closeAllConnections?.()
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  })

  it('serves the usage document on GET', async () => {
    // End to end: this is the request the dashboard makes, and the one that
    // returned 404 while everything else was green.
    const response = await fetch(url(WORKBUDDY_USAGE_PATH))
    expect(response.status).toBe(200)
    const body = await response.json() as { windowDays: number; actionKey: string }
    expect(body.windowDays).toBe(30)
    expect(body.actionKey).toBe('the-key')
  })

  it('refuses a non-loopback Host', async () => {
    // Driven through the handler, not `fetch`: the WHATWG fetch spec lists Host
    // as a forbidden header and silently drops an override, so an HTTP-level
    // test of this rule would pass no matter what the guard did — it would be
    // asserting the transport, not the security check.
    const captured = routes.get(WORKBUDDY_USAGE_PATH)
    expect(captured).toBeDefined()
    const response = fakeResponse()
    captured!.handler(fakeRequest('GET', 'evil.example.com'), response.res)
    await response.settled()
    expect(response.status()).toBe(403)
  })

  it('refuses an off-loopback Origin', async () => {
    const captured = routes.get(WORKBUDDY_USAGE_PATH)
    const response = fakeResponse()
    const request = { method: 'GET', headers: { host: '127.0.0.1', origin: 'https://evil.example.com' } } as unknown as IncomingMessage
    captured!.handler(request, response.res)
    await response.settled()
    expect(response.status()).toBe(403)
  })

  it('refuses a POST on the read route', async () => {
    const response = await fetch(url(WORKBUDDY_USAGE_PATH), { method: 'POST' })
    expect(response.status).toBe(405)
  })

  it('refuses a GET on the write route', async () => {
    const response = await fetch(url(WORKBUDDY_USAGE_ACTION_PATH))
    expect(response.status).toBe(405)
  })

  it('refuses a write with no key', async () => {
    const response = await fetch(url(WORKBUDDY_USAGE_ACTION_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'refresh-quotas' }),
    })
    expect(response.status).toBe(403)
  })

  it('refuses a write with the wrong key', async () => {
    const response = await fetch(url(WORKBUDDY_USAGE_ACTION_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workbuddy-key': 'not-the-key' },
      body: JSON.stringify({ action: 'refresh-quotas' }),
    })
    expect(response.status).toBe(403)
  })

  it('accepts a write with the key', async () => {
    const response = await fetch(url(WORKBUDDY_USAGE_ACTION_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workbuddy-key': 'the-key' },
      body: JSON.stringify({ action: 'refresh-quotas' }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; message?: string }
    expect(body.ok).toBe(true)
    expect(body.message).toContain('2')
  })

  it('rejects an unknown action', async () => {
    const response = await fetch(url(WORKBUDDY_USAGE_ACTION_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workbuddy-key': 'the-key' },
      body: JSON.stringify({ action: 'delete-everything' }),
    })
    expect(response.status).toBe(400)
  })

  it('answers 503 rather than 404 while the service is still starting', async () => {
    // The route exists before the ledger has loaded. A 404 here would tell the
    // user the plugin is not mounted, which is the wrong diagnosis.
    //
    // Driven through the handler directly rather than over HTTP: the condition
    // is "the service getter returns undefined", and standing up a second
    // server just to observe it would test the harness more than the route.
    const { ctx, routes: fresh } = fakeContext()
    registerUsageRoute(ctx, { service: () => undefined })
    const captured = fresh.get(WORKBUDDY_USAGE_PATH)
    expect(captured).toBeDefined()
    const response = fakeResponse()
    captured!.handler(fakeRequest('GET'), response.res)
    await response.settled()
    expect(response.status()).toBe(503)
  })
})

/**
 * A minimal request stand-in for driving a handler without a socket.
 *
 * Only the fields the route reads are present; a fuller fake would hide which
 * inputs the handler actually depends on.
 */
function fakeRequest(method: string, host = '127.0.0.1'): IncomingMessage {
  return { method, headers: { host } } as unknown as IncomingMessage
}

/** A response stand-in that records the status and resolves when ended. */
function fakeResponse(): { res: ServerResponse; status: () => number; settled: () => Promise<void> } {
  let code = 0
  let done = (): void => {}
  const settled = new Promise<void>(resolve => { done = resolve })
  const res = {
    writeHead(status: number) { code = status },
    end() { done() },
    setHeader() {},
  } as unknown as ServerResponse
  return { res, status: () => code, settled: () => settled }
}
