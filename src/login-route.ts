/**
 * Sign-in route: starts, polls, and ends one variant's login.
 *
 * The state-changing endpoints the plugin exposes share one guard shape — a
 * loopback Host and Origin, plus the in-process key the card receives with its
 * status document — because loopback alone is *not* authentication: any local
 * process can address `127.0.0.1`, and this route both holds a pending OAuth
 * attempt and writes a credential to disk.
 *
 * The realm is never taken from the request. It is fixed by the route the
 * browser called (one route per variant), so a card for one product can never
 * be steered into signing in against the other's upstream.
 *
 * @module dsh-workbuddy-connect/login-route
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { WORKBUDDY_LOGIN_PATH } from './status-paths.ts'
import type { WorkBuddyWebLoginRequest, WorkBuddyWebLoginResult } from './status-paths.ts'

/** Largest control body accepted; an imported credential document is larger. */
const MAX_BODY_BYTES = 64 * 1024

/** Constructor dependencies. */
export interface WorkBuddyLoginRouteOptions {
  /**
   * Start an attempt for this variant's realm.
   *
   * @returns the state to poll and the URL the human must open.
   */
  begin: () => Promise<{ state: string; url: string }>
  /**
   * Poll one attempt. Resolving to a completed credential means it has already
   * been persisted; the route never sees token material.
   *
   * @param state - the attempt to poll.
   */
  poll: (state: string) => Promise<WorkBuddyWebLoginResult>
  /** Remove the stored credential. */
  logout: () => Promise<void>
  /**
   * Adopt a credential document the user supplied.
   *
   * @param document - the document's text, exactly as the browser read it.
   * @returns a summary of the adopted credential, without its secrets.
   */
  importDocument: (document: string) => Promise<{ uid?: string; nickname?: string }>
  /**
   * Route path to mount. Defaults to the CN variant's path so existing callers
   * and tests keep their behaviour; the international variant passes its own.
   */
  path?: string
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

/** Parse and shape-check a login request; unknown fields are ignored, not trusted. */
function parseRequest(text: string): WorkBuddyWebLoginRequest | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const wrapped = parsed as Record<string, unknown>
  const action = wrapped['action']
  if (action === 'begin' || action === 'logout') return { action }
  if (action === 'poll') {
    const state = wrapped['state']
    if (typeof state !== 'string' || state.trim() === '') return undefined
    return { action: 'poll', state: state.trim() }
  }
  if (action === 'import') {
    const document = wrapped['document']
    if (typeof document !== 'string' || document.trim() === '') return undefined
    return { action: 'import', document }
  }
  return undefined
}

/**
 * Strip token-like content from a message before it reaches the browser.
 *
 * The route reports failures to a same-origin card, and an upstream error body
 * is the one input here that is not the plugin's own prose. Belt-and-braces:
 * everything this route produces is already a summary, and this keeps a future
 * one from carrying a credential across.
 */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

/**
 * The sign-in route's handler, extracted so tests can mount it on a bare server
 * with a known key.
 *
 * @param deps - the login operations for one variant.
 * @param key - the in-process control key this route requires.
 * @returns the Node request handler.
 */
export function workBuddyLoginHandler(
  deps: WorkBuddyLoginRouteOptions,
  key: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (!keyMatches(key, req.headers['x-workbuddy-login-key'] as string | undefined)) {
      json(res, 403, { error: 'invalid-login-key' })
      return
    }
    const body = await readBody(req)
    if (body === undefined) {
      json(res, 413, { error: 'body too large' })
      return
    }
    const request = parseRequest(body)
    if (request === undefined) {
      json(res, 400, { error: 'invalid action' })
      return
    }
    try {
      if (request.action === 'begin') {
        const attempt = await deps.begin()
        json(res, 200, { status: 'pending', state: attempt.state, url: attempt.url } satisfies WorkBuddyWebLoginResult)
        return
      }
      if (request.action === 'logout') {
        await deps.logout()
        json(res, 200, { status: 'signed-out' } satisfies WorkBuddyWebLoginResult)
        return
      }
      if (request.action === 'import') {
        const adopted = await deps.importDocument(request.document as string)
        json(res, 200, {
          status: 'imported',
          ...adopted.uid === undefined ? {} : { uid: adopted.uid },
          ...adopted.nickname === undefined ? {} : { nickname: adopted.nickname },
        } satisfies WorkBuddyWebLoginResult)
        return
      }
      json(res, 200, await deps.poll(request.state as string))
    } catch (error: unknown) {
      json(res, 200, { status: 'failed', message: safeMessage(error) } satisfies WorkBuddyWebLoginResult)
    }
  }
}

/** Mint the per-process sign-in control key. */
export function createLoginKey(): string {
  return randomBytes(24).toString('hex')
}

/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined || presented.length !== expected.length) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Mount the POST sign-in route on an optional webServer context. */
export function registerWorkBuddyLoginRoute(
  ctx: Context,
  deps: WorkBuddyLoginRouteOptions,
  key: string,
): void {
  const path = deps.path ?? WORKBUDDY_LOGIN_PATH
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path,
      handler: workBuddyLoginHandler(deps, key),
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddy-connect: login route')
}
