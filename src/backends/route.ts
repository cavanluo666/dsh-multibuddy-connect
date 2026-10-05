/**
 * The backend configuration routes: one read, one write.
 *
 * These back the multi-backend settings card. The read route answers what every
 * merged backend is, whether it can be configured here, and what accounts it
 * currently has; the write route adds or removes an account.
 *
 * Security follows the plugin's existing control-route pattern exactly, for the
 * reasons documented in probe-route.ts: the GET is protected by the loopback
 * Host/Origin guard, and the POST additionally requires the in-process key,
 * because loopback alone is not authentication — any local process can forge
 * Host: 127.0.0.1, and this route writes credential material.
 *
 * SECRETS ARE WRITE-ONLY ACROSS THIS BOUNDARY. The document carries a MASKED
 * form of every stored secret so a user can tell which key is which, and never
 * the value itself. The only time a secret travels is when the browser sends a
 * new one to store.
 *
 * @module dsh-multibuddy-connect/backends/route
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { hostIsLoopback, originIsLoopback } from '../loopback.ts'
import {
  WORKBUDDY_BACKENDS_ACTION_PATH,
  WORKBUDDY_BACKENDS_PATH,
  type BackendsWebAccount,
  type BackendsWebAction,
  type BackendsWebActionResult,
  type BackendsWebDocument,
  type BackendsWebEntry,
  type BackendsWebFailure,
  type BackendsWebStoredAccount,
} from '../backends-paths.ts'
import { maskSecret, type BackendAccountRegistry } from './registry.ts'
import type { BackendAdapter } from './types.ts'

/** Largest control body accepted; these payloads carry one key at most. */
const MAX_BODY_BYTES = 8192

/** Constructor dependencies. */
export interface BackendsRouteOptions {
  /** The shared account registry. */
  registry: () => BackendAccountRegistry
  /** The live backend set. */
  backends: () => readonly BackendAdapter[]
  /** Backends that failed to construct, reported rather than hidden. */
  failures?: () => readonly { id: string; message: string }[]
  /** The in-process key authorizing writes. */
  actionKey: () => string
  /**
   * Rebuild the backend set after a write.
   *
   * Required because the api-key backends receive their account list at
   * CONSTRUCTION: storing a new account changes the registry, but the running
   * adapter is still holding the old list. Without a rebuild the new key would
   * be saved and silently unused — the user sees "saved" and nothing works.
   */
  reload?: () => Promise<void>
  /** Route path overrides. */
  path?: string
  actionPath?: string
}

/** Mint the per-process action key. */
export function createBackendsKey(): string {
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

/** Whether this request may reach the routes at all. */
function readable(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
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

/**
 * Whether this plugin can WRITE accounts for a backend.
 *
 * True only for api-key backends, where the credential is the plugin's own.
 * A desktop-adoption backend reads another application's single login slot and
 * a managed-runtime backend has no account at all, so offering a write control
 * for either would be a button with nothing behind it.
 *
 * @param authKind - the backend's credential model.
 * @returns true when account management is meaningful.
 */
export function isConfigurable(authKind: string): boolean {
  return authKind === 'api-key'
}

/**
 * Derive a stable account id from its display label.
 *
 * The label is the natural key: the card shows labels and nothing else, so
 * "add an account called Work" twice reads as an update rather than as a
 * duplicate the user never asked for. Non-Latin labels are kept as-is rather
 * than transliterated — the id only ever appears in JSON and in a log line.
 *
 * @param label - the user-supplied display label.
 * @returns a stable, non-empty id.
 */
export function accountIdFromLabel(label: string): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '-').replace(/^-+|-+$/gu, '')
  return slug === '' ? 'default' : slug
}

/**
 * Build the configuration document.
 *
 * @param options - the live backend set and registry.
 * @returns the document the card renders.
 */
export async function buildBackendsDocument(options: BackendsRouteOptions): Promise<BackendsWebDocument> {
  const registry = options.registry()
  const entries: BackendsWebEntry[] = []
  for (const backend of options.backends()) {
    const descriptor = backend.descriptor
    const configurable = isConfigurable(descriptor.authKind)
    const availability = await backend.current()
    const accounts: BackendsWebAccount[] = availability.state === 'ready'
      ? availability.accounts.map(account => ({
        id: account.id,
        label: account.label,
        ...(account.detail === undefined ? {} : { detail: account.detail }),
        usable: account.usable,
        ...(account.reason === undefined ? {} : { reason: account.reason }),
      }))
      : []
    let stored: BackendsWebStoredAccount[] = []
    if (configurable) {
      const rows = await registry.list(descriptor.id)
      stored = rows.map(row => ({
        id: row.id,
        label: row.label,
        // Masked here and never sent raw: the card only needs to let a user
        // tell which key is which.
        secretMasked: maskSecret(typeof row.secret === 'string' ? row.secret : ''),
        updatedAtMs: row.updatedAtMs,
      }))
    }
    entries.push({
      id: descriptor.id,
      displayName: descriptor.displayName,
      ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
      ...(descriptor.brand?.vendor === undefined ? {} : { vendor: descriptor.brand.vendor }),
      authKind: descriptor.authKind,
      multiAccount: descriptor.multiAccount,
      reportsQuota: descriptor.reportsQuota,
      configurable,
      state: availability.state,
      ...(availability.state === 'unavailable' && availability.hint !== undefined ? { hint: availability.hint } : {}),
      ...(availability.state === 'failed' ? { message: availability.message } : {}),
      accounts,
      stored,
      ...(descriptor.envHint === undefined ? {} : { envHint: descriptor.envHint }),
    })
  }
  const failures: BackendsWebFailure[] = (options.failures?.() ?? []).map(failure => ({
    id: failure.id,
    message: failure.message,
  }))
  return {
    backends: entries,
    ...(failures.length === 0 ? {} : { failures }),
    actionKey: options.actionKey(),
  }
}

/** Parse and shape-check a write request; unknown fields are ignored. */
export function parseBackendsAction(text: string): BackendsWebAction | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const wrapped = parsed as Record<string, unknown>
  const action = wrapped['action']
  const string = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  if (action === 'refresh') return { action }
  if (action === 'remove-account') {
    const backendId = string(wrapped['backendId'])
    const accountId = string(wrapped['accountId'])
    if (backendId === undefined || accountId === undefined) return undefined
    return { action, backendId, accountId }
  }
  if (action === 'add-account') {
    const backendId = string(wrapped['backendId'])
    const secret = typeof wrapped['secret'] === 'string' ? wrapped['secret'].trim() : ''
    if (backendId === undefined || secret === '') return undefined
    const label = string(wrapped['label'])
    const accountId = string(wrapped['accountId'])
    return {
      action,
      backendId,
      secret,
      ...(label === undefined ? {} : { label }),
      ...(accountId === undefined ? {} : { accountId }),
    }
  }
  return undefined
}

/**
 * Apply one write.
 *
 * Kept as a named export so it can be tested without an HTTP round trip.
 *
 * @param options - the live backend set and registry.
 * @param action - the validated action.
 * @returns the result the card shows.
 */
export async function applyBackendsAction(options: BackendsRouteOptions, action: BackendsWebAction): Promise<BackendsWebActionResult> {
  if (action.action === 'refresh') {
    await options.reload?.()
    return { ok: true, message: '已重新检测各后端账号' }
  }
  const backendId = action.backendId ?? ''
  const backend = options.backends().find(candidate => candidate.descriptor.id === backendId)
  if (backend === undefined) return { ok: false, message: '未找到后端 ' + backendId }
  if (!isConfigurable(backend.descriptor.authKind)) {
    // Refused explicitly rather than silently: this route is reachable by any
    // local process that has the key, and writing an account for a backend that
    // cannot use one would leave an orphan record nothing ever reads.
    return { ok: false, message: backend.descriptor.displayName + ' 的凭据来自其它应用，本插件不代为配置' }
  }
  const registry = options.registry()
  try {
    if (action.action === 'remove-account') {
      await registry.remove(backendId, action.accountId ?? '')
      registry.invalidate(backendId)
      await options.reload?.()
      return { ok: true, message: '已删除账号' }
    }
    const label = action.label ?? backend.descriptor.displayName
    const id = action.accountId ?? accountIdFromLabel(label)
    const secret = action.secret ?? ''
    if (secret === '') return { ok: false, message: '密钥不能为空' }
    await registry.put(backendId, { id, label, secret, updatedAtMs: Date.now() })
    registry.invalidate(backendId)
    await options.reload?.()
    return { ok: true, message: '已保存账号 ' + label }
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The read route's handler.
 *
 * @param options - the live backend set and registry.
 * @returns the node request handler.
 */
export function backendsDocumentRoute(options: BackendsRouteOptions): (req: IncomingMessage, res: ServerResponse) => void {
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
      try {
        json(res, 200, await buildBackendsDocument(options))
      } catch (error: unknown) {
        json(res, 500, { message: error instanceof Error ? error.message : String(error) })
      }
    })()
  }
}

/**
 * The write route's handler.
 *
 * @param options - the live backend set and registry.
 * @returns the node request handler.
 */
export function backendsActionRoute(options: BackendsRouteOptions): (req: IncomingMessage, res: ServerResponse) => void {
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
      const presented = req.headers['x-workbuddy-key']
      if (!keyMatches(options.actionKey(), Array.isArray(presented) ? presented[0] : presented)) {
        json(res, 403, { message: 'forbidden' })
        return
      }
      const body = await readBody(req)
      if (body === undefined) {
        json(res, 413, { message: 'payload too large' })
        return
      }
      const action = parseBackendsAction(body)
      if (action === undefined) {
        json(res, 400, { message: 'unknown action' })
        return
      }
      const result = await applyBackendsAction(options, action)
      json(res, result.ok ? 200 : 400, result)
    })()
  }
}

/**
 * Mount both configuration routes on the host's web server.
 *
 * Registration goes through ctx.webServer.register and is wrapped in
 * ctx.effect, matching every other route in this plugin — reaching for
 * non-existent helper methods on that service is a mistake this plugin has
 * already made once, and the failure mode is a silent 404 with green tests.
 *
 * @param ctx - a context that has injected the webServer service.
 * @param options - the live backend set and registry.
 */
export function registerBackendsRoute(ctx: Context, options: BackendsRouteOptions): void {
  const readPath = options.path ?? WORKBUDDY_BACKENDS_PATH
  const writePath = options.actionPath ?? WORKBUDDY_BACKENDS_ACTION_PATH

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: readPath,
      handler: backendsDocumentRoute(options),
    })
    return () => { dispose() }
  }, 'dsh-multibuddy-connect: backend configuration route')

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: writePath,
      handler: backendsActionRoute(options),
    })
    return () => { dispose() }
  }, 'dsh-multibuddy-connect: backend action route')
}
