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
  /** The service building the document. */
  service: () => UsageService
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
 * Registers nothing when the web server service is absent — a headless profile
 * serves no browser, and refusing to start there would make the whole plugin
 * unusable over a feature the profile cannot use.
 *
 * @param ctx - the plugin context.
 * @param options - the service and optional path overrides.
 * @returns the release functions, one per mounted route.
 */
export function registerUsageRoute(ctx: Context, options: UsageRouteOptions): (() => void)[] {
  const webServer = ctx.get('webServer') as { get?: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => () => void; post?: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => () => void } | undefined
  if (webServer === undefined) return []
  const releases: (() => void)[] = []
  const readPath = options.path ?? WORKBUDDY_USAGE_PATH
  const writePath = options.actionPath ?? WORKBUDDY_USAGE_ACTION_PATH

  const readRelease = webServer.get?.(readPath, (req, res) => {
    if (!readable(req)) {
      json(res, 403, { message: 'forbidden' })
      return
    }
    void usageDocumentHandler(options.service(), res)
  })
  if (readRelease !== undefined) releases.push(readRelease)

  const writeRelease = webServer.post?.(writePath, (req, res) => {
    void (async (): Promise<void> => {
      if (!readable(req)) {
        json(res, 403, { message: 'forbidden' })
        return
      }
      const service = options.service()
      const key = service.actionKey()
      const presented = req.headers['x-workbuddy-key']
      if (!keyMatches(key, Array.isArray(presented) ? presented[0] : presented)) {
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
  })
  if (writeRelease !== undefined) releases.push(writeRelease)

  return releases
}
