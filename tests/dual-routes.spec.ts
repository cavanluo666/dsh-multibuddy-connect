import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKBUDDY_DATA_DIR_ENV, WorkBuddyCredentialStore } from '../src/auth.ts'
import { WorkBuddyCatalog, FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS } from '../src/catalog.ts'
import { workBuddyProbeHandler } from '../src/probe-route.ts'
import { workBuddyStatusHandler } from '../src/web-status.ts'
import { AI_VARIANT, CN_VARIANT, type WorkBuddyVariant } from '../src/variants.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'

/**
 * Both variants' routes, mounted side by side on one server the way the plugin
 * mounts them. These are integration tests: they exercise the real handlers, the
 * real path constants, and the real loopback guards, so a route parameterized
 * onto the wrong variant — or a guard lost while parameterizing — fails here
 * rather than only on a live install.
 *
 * No network: `fetchCredits` is a stub, so the test never spends credit or reads
 * the developer's real sign-in.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

function credentialDocument(domain: string): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain },
    account: { uid: 'uid-1', nickname: 'nick', enterpriseId: 'ent-1' },
  })
}

/** Raw request with full header control (fetch forbids overriding Host). */
function requestOnce(options: {
  port: number
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1',
      port: options.port,
      method: options.method,
      path: options.path,
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    outgoing.on('error', reject)
    if (options.body !== undefined) outgoing.write(options.body)
    outgoing.end()
  })
}

interface Mounted {
  port: number
  close: () => Promise<void>
}

/** Mount both variants' status and probe routes, as `apply()` does. */
async function mount(variant: WorkBuddyVariant, options: {
  catalog: WorkBuddyCatalog
  probeKey?: string
  /** Supply a refresh handler, as `apply()` does for a real variant. */
  refresh?: boolean
}): Promise<Mounted> {
  const store = new WorkBuddyCredentialStore({
    variant,
    refresh: async credential => ({ accessToken: credential.accessToken }),
  })
  const client = {
    fetchCredits: async () => ({ total: variant.id === 'workbuddy-ai' ? 350 : 4663, accounts: [] }),
  } as unknown as WorkBuddyUpstreamClient
  const handler = workBuddyStatusHandler({
    path: variant.statusPath,
    store,
    client,
    models: () => options.catalog.current(),
    catalog: () => ({ source: 'fallback' }),
    probe: () => ({ consent: true, running: false, candidates: [], results: [] }),
    ...options.probeKey === undefined ? {} : { probeKey: options.probeKey },
  })
  const probes = new Map<string, number>()
  const probeHandler = workBuddyProbeHandler({
    path: variant.probePath,
    probe: async modelId => { probes.set(modelId, (probes.get(modelId) ?? 0) + 1); return { state: 'ok' } },
    clear: () => { probes.clear() },
    ...options.refresh === true
      ? { refresh: async () => ({ state: 'refreshed', reason: `${options.catalog.current().length} models` }) }
      : {},
  }, options.probeKey ?? '')
  // One server per variant, both routes on it, matching the plugin's layout.
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (path === variant.statusPath) void handler(req, res)
    else if (path === variant.probePath) void probeHandler(req, res)
    else { res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"no such route"}') }
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const mounted: Mounted = {
    port,
    close: () => new Promise<void>(resolve => { server.close(() => { resolve() }) }),
  }
  CLEANUP.push(mounted.close)
  return mounted
}

/**
 * A temporary Harness home, stubbed as `$DSH_HOME` for the case that asks for it.
 *
 * Every credential these cases rely on lives inside such a home: a variant's
 * store reads exactly one file, `$DSH_HOME/<ownFilename>`, and nothing outside
 * it — so a case that never writes one is signed out, and none of them can read
 * a real sign-in from the machine running the tests.
 */
async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-routes-'))
  CLEANUP.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', root)
  // The plugin keeps its files in a per-profile folder; point that at the same
  // temporary root so `grantCredential` writes where the store reads.
  vi.stubEnv(WORKBUDDY_DATA_DIR_ENV, root)
  return root
}

/** Serve one variant a signed-in credential it owns. */
async function grantCredential(variant: WorkBuddyVariant, domain: string): Promise<void> {
  const root = await tempHome()
  await writeFile(join(root, variant.ownFilename), credentialDocument(domain))
}

describe('per-variant route mount', () => {
  it('serves each variant its own identity, credits, and models', async () => {
    // One Harness home holding both variants' own credential files: the CN
    // variant writes `.workbuddy-auth.json`, the international one
    // `.workbuddy-ai-auth.json`, and neither may read the other's.
    const root = await tempHome()
    await writeFile(join(root, CN_VARIANT.ownFilename), credentialDocument('copilot.tencent.com'))
    await writeFile(join(root, AI_VARIANT.ownFilename), credentialDocument('www.workbuddy.ai'))

    const cnCatalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_MODELS)
    const aiCatalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_AI_MODELS)
    const cn = await mount(CN_VARIANT, { catalog: cnCatalog, probeKey: 'key-cn' })
    const ai = await mount(AI_VARIANT, { catalog: aiCatalog, probeKey: 'key-ai' })

    const cnBody = JSON.parse((await requestOnce({
      port: cn.port, method: 'GET', path: CN_VARIANT.statusPath,
      headers: { host: `127.0.0.1:${cn.port}`, accept: 'application/json' },
    })).body) as Record<string, unknown>
    const aiBody = JSON.parse((await requestOnce({
      port: ai.port, method: 'GET', path: AI_VARIANT.statusPath,
      headers: { host: `127.0.0.1:${ai.port}`, accept: 'application/json' },
    })).body) as Record<string, unknown>

    expect(cnBody['status']).toBe('signed-in')
    expect(aiBody['status']).toBe('signed-in')
    expect(cnBody['domain']).toBe('copilot.tencent.com')
    expect(aiBody['domain']).toBe('www.workbuddy.ai')
    // Separate balances: the whole reason the cards are separate.
    expect(cnBody['credits']).toMatchObject({ total: 4663 })
    expect(aiBody['credits']).toMatchObject({ total: 350 })

    // Disjoint rosters, each served through its own catalog.
    const cnModels = (cnBody['models'] as { id: string }[]).map(model => model.id)
    const aiModels = (aiBody['models'] as { id: string }[]).map(model => model.id)
    expect(cnModels).toContain('minimax-m3')
    expect(aiModels).toContain('gpt-5.6-luna')
    expect(cnModels).not.toContain('gpt-5.6-luna')
    expect(aiModels).not.toContain('minimax-m3')
  })

  it('answers 404 on the other variants path, so the routes stay distinct', async () => {
    const cnCatalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_MODELS)
    const cn = await mount(CN_VARIANT, { catalog: cnCatalog })
    // The AI path is not mounted on this server; a shared path constant would
    // make this succeed and cross the two cards' state.
    const response = await requestOnce({
      port: cn.port, method: 'GET', path: AI_VARIANT.statusPath,
      headers: { host: `127.0.0.1:${cn.port}` },
    })
    expect(response.status).toBe(404)
  })

  it('hides every model when the catalog is gated off', async () => {
    const catalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_AI_MODELS)
    const server = await mount(AI_VARIANT, { catalog })
    catalog.setVisible(false)
    const signed = JSON.parse((await requestOnce({
      port: server.port, method: 'GET', path: AI_VARIANT.statusPath,
      headers: { host: `127.0.0.1:${server.port}` },
    })).body) as Record<string, unknown>
    // Nothing to pick: the group is hidden even though the card still answers.
    expect(signed['models']).toBeUndefined()
  })

  it('keeps the loopback guards on both variants routes', async () => {
    const catalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_AI_MODELS)
    await grantCredential(AI_VARIANT, 'www.workbuddy.ai')
    const server = await mount(AI_VARIANT, { catalog, probeKey: 'key-ai' })

    // A DNS-rebinding page addresses the request to its own domain.
    const rebound = await requestOnce({
      port: server.port, method: 'GET', path: AI_VARIANT.statusPath,
      headers: { host: 'evil.example.com' },
    })
    expect(rebound.status).toBe(403)

    // A cross-origin browser Origin is refused too.
    const crossOrigin = await requestOnce({
      port: server.port, method: 'GET', path: AI_VARIANT.statusPath,
      headers: { host: `127.0.0.1:${server.port}`, origin: 'https://evil.example.com' },
    })
    expect(crossOrigin.status).toBe(403)

    // And the probe route needs the in-process key, on the AI path as well.
    const noKey = await requestOnce({
      port: server.port, method: 'POST', path: AI_VARIANT.probePath,
      headers: { host: `127.0.0.1:${server.port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'probe', model: 'hy3' }),
    })
    expect(noKey.status).toBe(403)

    const wrongKey = await requestOnce({
      port: server.port, method: 'POST', path: AI_VARIANT.probePath,
      headers: {
        host: `127.0.0.1:${server.port}`,
        'content-type': 'application/json',
        'x-workbuddy-probe-key': 'key-cn',
      },
      body: JSON.stringify({ action: 'probe', model: 'hy3' }),
    })
    // The CN card's key must not authorize the AI route.
    expect(wrongKey.status).toBe(403)

    const ok = await requestOnce({
      port: server.port, method: 'POST', path: AI_VARIANT.probePath,
      headers: {
        host: `127.0.0.1:${server.port}`,
        'content-type': 'application/json',
        'x-workbuddy-probe-key': 'key-ai',
      },
      body: JSON.stringify({ action: 'probe', model: 'hy3' }),
    })
    expect(ok.status).toBe(200)
  })

  it('never serves a credential belonging to the other product', async () => {
    // A WorkBuddy (CN) credential sitting in the *international* variant's own
    // credential file: one file per variant is the whole layout, so this is the
    // only way the two products' stored credentials can be crossed, and it is
    // exactly what copying one product's file over the other's produces.
    await grantCredential(AI_VARIANT, 'copilot.tencent.com')
    const server = await mount(AI_VARIANT, { catalog: new WorkBuddyCatalog(FALLBACK_WORKBUDDY_AI_MODELS) })
    const body = JSON.parse((await requestOnce({
      port: server.port, method: 'GET', path: AI_VARIANT.statusPath,
      headers: { host: `127.0.0.1:${server.port}` },
    })).body) as Record<string, unknown>
    // Signed out with an explanation rather than signed in as the wrong product.
    expect(body['status']).toBe('signed-out')
    // The reason names the file that is wrong and the realm it actually holds:
    // a test that only matched a generic message would accept a silent sign-out.
    expect(String(body['reason'])).toContain(AI_VARIANT.ownFilename)
    expect(String(body['reason'])).toMatch(/WorkBuddy \(CN\)/)
  })

  it('reports where the served model list came from', async () => {
    const catalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_AI_MODELS)
    // Provenance rides the *signed-in* document, so this case needs a credential
    // of its own: the store reads `$DSH_HOME/.workbuddy-ai-auth.json`, and
    // without one for a temporary home the answer would depend on whether this
    // machine happened to be signed in already.
    await grantCredential(AI_VARIANT, 'www.workbuddy.ai')
    const server = await mount(AI_VARIANT, { catalog })
    const body = JSON.parse((await requestOnce({
      port: server.port, method: 'GET', path: AI_VARIANT.statusPath,
      headers: { host: `127.0.0.1:${server.port}` },
    })).body) as Record<string, unknown>
    // Pin that the stubbed credential really signed the card in: `catalog` is
    // omitted entirely on the signed-out branch, so a broken fixture would make
    // the provenance assertion below fail for the wrong reason.
    expect(body['status']).toBe('signed-in')
    // Without provenance a stale list is indistinguishable from a fresh one.
    expect(body['catalog']).toMatchObject({ source: 'fallback' })
  })

  it('gates the refresh action behind the same in-process key as probing', async () => {
    const catalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_AI_MODELS)
    const server = await mount(AI_VARIANT, { catalog, probeKey: 'key-ai', refresh: true })
    const post = (headers: Record<string, string>) => requestOnce({
      port: server.port, method: 'POST', path: AI_VARIANT.probePath,
      headers: { host: `127.0.0.1:${server.port}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ action: 'refresh' }),
    })
    // A refresh spends an upstream request, so it is a write: unauthenticated
    // callers are refused exactly like an unauthenticated probe.
    expect((await post({})).status).toBe(403)
    const ok = await post({ 'x-workbuddy-probe-key': 'key-ai' })
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body)).toMatchObject({ state: 'refreshed' })
  })

  it('answers 404 for refresh when the mount supplies no handler', async () => {
    // A route without a refresh handler must say so rather than silently
    // reporting success.
    const server = await mount(AI_VARIANT, {
      catalog: new WorkBuddyCatalog(FALLBACK_WORKBUDDY_AI_MODELS),
      probeKey: 'key-ai',
    })
    const response = await requestOnce({
      port: server.port, method: 'POST', path: AI_VARIANT.probePath,
      headers: {
        host: `127.0.0.1:${server.port}`,
        'content-type': 'application/json',
        'x-workbuddy-probe-key': 'key-ai',
      },
      body: JSON.stringify({ action: 'refresh' }),
    })
    expect(response.status).toBe(404)
  })
})
