/**
 * The usage dashboard's host routes: one read, one write.
 *
 * Security follows the plugin's existing control-route pattern exactly, for the
 * same reasons documented in `probe-route.ts`:
 *
 *  1. The GET is protected by the loopback Host/Origin guard, which stops a
 *     DNS-rebinding page from reading the user's usage history.
 *  2. The POST adds the in-process key, because loopback alone is not
 *     authentication — any local process can forge `Host: 127.0.0.1`, and this
 *     route can spend the user's credit by refreshing quotas against nine
 *     different vendors. A caller that cannot present the key does not get to
 *     trigger that.
 *
 * The read route never accepts parameters that reach the filesystem or the
 * network: the window comes from the service's own state, not from the query
 * string, so a crafted URL cannot make the host allocate a million-point chart
 * or read an arbitrary path.
 *
 * @module dsh-workbuddy-connect/usage-route
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { WORKBUDDY_USAGE_ACTION_PATH, WORKBUDDY_USAGE_PATH } from './usage-paths.ts'
import type { UsageWebActionResult, UsageWebDocument } from './usage-paths.ts'
import type { UsageService } from './usage/service.ts'

/** Largest control body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES = 4096

/** Constructor dependencies. */
export interface UsageRouteOptions {
  /**
   * The service building the document, or undefined while it is still being
   * assembled.
   *
   * A getter rather than a value because registration happens as soon as the
   * webServer service is available, while the service itself is built by an
   * asynchronous startup step that loads the ledger. Resolving per request is
   * what lets the route exist from the first moment without either blocking
   * startup on the filesystem or pinning a stale service across a fiber
   * reload.
   */
  service: () => UsageService | undefined
  /** Route path for the read document; defaults to the plugin's own. */
  path?: string
  /** Route path for the write action; defaults to the plugin's own. */
  actionPath?: string
}

/** Mint the per-process action key. */
export function createUsageKey(): string {
  return randomBytes(24).toString('hex')
}

/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined || presented.length !== expected.length) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Read the request body with a hard ceiling. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Whether this request may reach the read route at all. */
function readable(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

/** Parse and shape-check a write request; unknown fields are ignored. */
export function parseUsageAction(text: string): { action: 'refresh-quotas' | 'clear-ledger' | 'set-window'; windowDays?: number } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const wrapped = parsed as Record<string, unknown>
  const action = wrapped['action']
  if (action === 'refresh-quotas') return { action }
  if (action === 'clear-ledger') return { action }
  if (action === 'set-window') {
    const windowDays = wrapped['windowDays']
    if (typeof windowDays !== 'number' || !Number.isFinite(windowDays)) return undefined
    return { action, windowDays }
  }
  return undefined
}

/**
 * The read handler, exposed for tests.
 *
 * @param service - the usage service.
 * @param res - the response to write.
 */
export async function usageDocumentHandler(service: UsageService, res: ServerResponse): Promise<void> {
  try {
    const document: UsageWebDocument = await service.document()
    json(res, 200, document)
  } catch (error: unknown) {
    // The page must still render something rather than a blank screen, so a
    // build failure is reported as a message it can show.
    json(res, 500, { message: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Mount both usage routes on the host's web server.
 *
 * Follows the plugin's existing route convention exactly, because deviating
 * from it fails SILENTLY: routes are registered through
 * `ctx.webServer.register({ kind, path, handler })`, and the handler owns the
 * method check. The first version of this function instead reached for
 * `webServer.get()` / `webServer.post()` — methods that do not exist on that
 * service — so every call was an optional call on undefined, no route was ever
 * mounted, and the browser's fetch came back 404 while the build, the types,
 * and the tests all stayed green. Nothing but a real request could reveal it.
 *
 * Registration is wrapped in `ctx.effect` so the disposer runs when the fiber
 * unwinds. The caller must already have injected `webServer`, which is what
 * makes `ctx.webServer` resolvable here.
 *
 * @param ctx - a context that has injected the webServer service.
 * @param options - the service getter and optional path overrides.
 */
export function registerUsageRoute(ctx: Context, options: UsageRouteOptions): void {
  const readPath = options.path ?? WORKBUDDY_USAGE_PATH
  const writePath = options.actionPath ?? WORKBUDDY_USAGE_ACTION_PATH

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: readPath,
      handler: usageDocumentRoute(options),
    })
    return () => {
      dispose()
    }
  }, 'dsh-multibuddy-connect: usage document route')

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: writePath,
      handler: usageActionRoute(options),
    })
    return () => {
      dispose()
    }
  }, 'dsh-multibuddy-connect: usage action route')
}

/**
 * The read route's handler.
 *
 * Owns the method check because the web server dispatches by PATH alone — a
 * POST to this path must be refused here rather than by the router.
 *
 * @param options - the service getter.
 * @returns the node request handler.
 */
export function usageDocumentRoute(options: UsageRouteOptions): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async (): Promise<void> => {
      if (req.method !== 'GET') {
        json(res, 405, { message: 'method not allowed' })
        return
      }
      if (!readable(req)) {
        json(res, 403, { message: 'forbidden' })
        return
      }
      const service = options.service()
      if (service === undefined) {
        // The route exists before the ledger has finished loading. Saying so is
        // better than a 404, which the page would report as "the plugin is not
        // mounted" — a wrong diagnosis while startup is still in flight.
        json(res, 503, { message: 'usage service is still starting' })
        return
      }
      await usageDocumentHandler(service, res)
    })()
  }
}

/**
 * The write route's handler.
 *
 * Two guards besides the method check, because a state-changing route must not
 * be reachable by the same unauthenticated GET a page can be tricked into
 * issuing: the loopback Host/Origin pair, then the in-process key the document
 * handed the browser.
 *
 * @param options - the service getter.
 * @returns the node request handler.
 */
export function usageActionRoute(options: UsageRouteOptions): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async (): Promise<void> => {
      if (req.method !== 'POST') {
        json(res, 405, { message: 'method not allowed' })
        return
      }
      if (!readable(req)) {
        json(res, 403, { message: 'forbidden' })
        return
      }
      const service = options.service()
      if (service === undefined) {
        json(res, 503, { message: 'usage service is still starting' })
        return
      }
      const presented = req.headers['x-workbuddy-key']
      if (!keyMatches(service.actionKey(), Array.isArray(presented) ? presented[0] : presented)) {
        json(res, 403, { message: 'forbidden' })
        return
      }
      const body = await readBody(req)
      if (body === undefined) {
        json(res, 413, { message: 'payload too large' })
        return
      }
      const action = parseUsageAction(body)
      if (action === undefined) {
        json(res, 400, { message: 'unknown action' })
        return
      }
      let result: UsageWebActionResult
      try {
        if (action.action === 'refresh-quotas') {
          const count = await service.refreshQuotas()
          result = { ok: true, message: `已刷新 ${count} 个账号的额度` }
        } else if (action.action === 'clear-ledger') {
          await service.clearLedger()
          result = { ok: true, message: '已清空本地用量记录' }
        } else {
          service.setWindowDays(action.windowDays ?? 30)
          result = { ok: true }
        }
      } catch (error: unknown) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
      json(res, result.ok ? 200 : 500, result)
    })()
  }
}
