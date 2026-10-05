/**
 * WorkBuddy device-authorization login, for both realms.
 *
 * The desktop apps and the official CLI both sign in through a two-step
 * endpoint pair on the same host that serves chat: `auth/state` issues a
 * pending `state` plus the browser URL the human must open, and `auth/token`
 * reports the outcome of that browser visit. Nothing here reads a file the
 * desktop app wrote — this is the plugin obtaining its own credential.
 *
 * Two details are load-bearing:
 *
 * - **One cookie jar per attempt.** The CN gateway tags the `auth/state`
 *   response with a routing cookie and correlates the browser's completion
 *   with the state it issued, so the state request and every later poll must
 *   present the same jar. A shared jar would let two concurrent logins (the
 *   CN and international cards) answer for each other.
 * - **A pending login is not an error.** `auth/token` answers HTTP 200 with
 *   business code 11217 while the human has not finished, so the envelope's
 *   code — not the HTTP status — decides pending from complete.
 *
 * @module dsh-workbuddy-connect/login
 */

import type { WorkBuddyRegion } from './upstream.ts'
import { regionOf } from './upstream.ts'

/** Upstream host per realm; both serve the identical plugin login paths. */
const LOGIN_BASE: Record<WorkBuddyRegion, string> = {
  cn: 'https://copilot.tencent.com',
  global: 'https://www.workbuddy.ai',
}

/**
 * Origin and Referer per realm. They are not the same host as the API: the CN
 * deployment serves `copilot.tencent.com` for the `codebuddy.cn` site, and the
 * gateway rejects a request whose Origin does not match the realm it targets.
 */
const LOGIN_ORIGIN: Record<WorkBuddyRegion, string> = {
  cn: 'https://www.codebuddy.cn',
  global: 'https://www.workbuddy.ai',
}

/** CLI identity the login endpoints expect; unrelated to the chat User-Agent. */
const LOGIN_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** Login round trips are interactive; a slow one is dead, not merely slow. */
const LOGIN_TIMEOUT_MS = 30_000

/** Business code `auth/token` returns while the browser half is unfinished. */
export const LOGIN_PENDING_CODE = 11217

/** Path of the state issuer, relative to the realm's base URL. */
const AUTH_STATE_PATH = '/v2/plugin/auth/state?platform=CLI'

/** Poll and account paths; both take the state as a query parameter. */
function authTokenPath(state: string): string {
  return `/v2/plugin/auth/token?state=${encodeURIComponent(state)}`
}
function loginAccountPath(state: string): string {
  return `/v2/plugin/login/account?state=${encodeURIComponent(state)}`
}

/** One issued login attempt: what to open, and what to poll with. */
export interface WorkBuddyLoginAttempt {
  state: string
  /** Browser URL the human opens to approve the sign-in. */
  authUrl: string
  region: WorkBuddyRegion
}

/** The token bundle `auth/token` returns once the browser half is finished. */
export interface WorkBuddyLoginTokens {
  accessToken: string
  refreshToken: string
  expiresInSec: number
  domain: string
}

/** The account identity `login/account` adds to a finished attempt. */
export interface WorkBuddyLoginAccount {
  uid: string
  enterpriseId?: string
  nickname?: string
}

/** Outcome of one poll. */
export type WorkBuddyLoginPoll =
  | { status: 'pending' }
  | { status: 'complete'; tokens: WorkBuddyLoginTokens; account: WorkBuddyLoginAccount }

/** A minimal cookie jar, scoped to one login attempt. */
class LoginCookieJar {
  private readonly cookies = new Map<string, string>()

  /** Record every cookie the response set, last write winning per name. */
  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';', 1)[0] ?? ''
      const separator = pair.indexOf('=')
      if (separator <= 0) continue
      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()
      if (name !== '') this.cookies.set(name, value)
    }
  }

  /** The Cookie header for this attempt, or undefined when it holds nothing. */
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

/** One upstream `{code,msg,data}` reply, decoded tolerantly. */
interface Envelope {
  code: number
  msg: string
  data: unknown
}

/**
 * Read an upstream envelope. A body that is not JSON, or not an object, is
 * reported with its HTTP status so a proxy or gateway page is distinguishable
 * from a real answer.
 */
async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy login: upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`workbuddy login: upstream returned an unexpected document (http ${response.status})`)
  }
  const document = parsed as Record<string, unknown>
  return {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Normalize a realm spelling, folding anything unrecognised onto CN so a
 * missing or mistyped value behaves like the deployment the plugin shipped for.
 */
export function normalizeLoginRegion(region: string | undefined): WorkBuddyRegion {
  return region?.trim().toLowerCase() === 'global' ? 'global' : 'cn'
}

/**
 * The realm a finished login belongs to: the realm the attempt was started
 * against, falling back to what the returned domain says when the attempt
 * carried none. The domain fallback exists because the upstream may answer a
 * login with a credential for the domain it redirected to.
 */
export function resolveLoginRegion(region: WorkBuddyRegion, domain: string): WorkBuddyRegion {
  const fromDomain = regionOf(domain)
  // An empty domain reads as CN, so only a domain that positively names the
  // other realm may override the realm the attempt was started against.
  return domain.trim() === '' ? region : fromDomain
}

/**
 * The login client. One instance serves both cards; each attempt owns its own
 * cookie jar, keyed by the state it issued.
 */
export class WorkBuddyLoginClient {
  private readonly jars = new Map<string, LoginCookieJar>()

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** Request headers for one realm, carrying the attempt's cookies when it has any. */
  private headers(region: WorkBuddyRegion, jar?: LoginCookieJar): Record<string, string> {
    const origin = LOGIN_ORIGIN[region]
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': origin,
      'Referer': `${origin}/`,
      'User-Agent': LOGIN_USER_AGENT,
      ...jar?.header() === undefined ? {} : { 'Cookie': jar.header() as string },
    }
  }

  /**
   * Issue one attempt: obtain the state and the URL the human must open.
   *
   * The response's cookies are retained under the returned state, because the
   * poll that finishes this attempt has to present them.
   */
  async begin(region: WorkBuddyRegion): Promise<WorkBuddyLoginAttempt> {
    const jar = new LoginCookieJar()
    const response = await this.fetchImpl(`${LOGIN_BASE[region]}${AUTH_STATE_PATH}`, {
      method: 'POST',
      headers: this.headers(region),
      body: '{}',
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    })
    jar.absorb(response)
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) {
      throw new Error(`workbuddy login: auth state failed (http ${response.status}, code ${envelope.code}): ${envelope.msg.slice(0, 160)}`)
    }
    const data = isObject(envelope.data) ? envelope.data : {}
    const state = optionalString(data['state'])
    const authUrl = optionalString(data['authUrl'])
    if (state === undefined || authUrl === undefined) {
      throw new Error('workbuddy login: auth state reply carried no state or authUrl')
    }
    this.jars.set(state, jar)
    return { state, authUrl, region }
  }

  /** Drop a finished or abandoned attempt's jar. */
  forget(state: string): void {
    this.jars.delete(state)
  }

  /** How many attempts currently hold a jar; diagnostics and tests. */
  pendingCount(): number {
    return this.jars.size
  }

  /**
   * Poll one attempt once. The caller drives the cadence.
   *
   * `pending` covers both "the human has not finished" (business code 11217)
   * and "the gateway refused this poll yet" (a 4xx while the browser half is
   * still open) — the latter is what the CN endpoint answers before the
   * browser visit completes. A transport failure, or a 5xx, is a real error
   * and is thrown: retrying those as pending would hide an outage behind a
   * spinner that never resolves.
   */
  async poll(attempt: WorkBuddyLoginAttempt): Promise<WorkBuddyLoginPoll> {
    const jar = this.jars.get(attempt.state)
    const response = await this.fetchImpl(
      `${LOGIN_BASE[attempt.region]}${authTokenPath(attempt.state)}`,
      { method: 'GET', headers: this.headers(attempt.region, jar), signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS) },
    )
    jar?.absorb(response)
    if (response.status >= 500) {
      throw new Error(`workbuddy login: token endpoint failed (http ${response.status})`)
    }
    if (response.status >= 400) return { status: 'pending' }
    const envelope = await readEnvelope(response)
    if (envelope.code === LOGIN_PENDING_CODE) return { status: 'pending' }
    if (envelope.code !== 0) return { status: 'pending' }
    const data = isObject(envelope.data) ? envelope.data : {}
    const accessToken = optionalString(data['accessToken'])
    if (accessToken === undefined) return { status: 'pending' }
    const tokens: WorkBuddyLoginTokens = {
      accessToken,
      refreshToken: optionalString(data['refreshToken']) ?? '',
      expiresInSec: typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0 ? data['expiresIn'] : 0,
      domain: optionalString(data['domain']) ?? '',
    }
    return { status: 'complete', tokens, account: await this.fetchAccount(attempt, tokens.accessToken, jar) }
  }

  /**
   * Read the account identity for a finished attempt.
   *
   * Best effort by design: the token bundle is what makes the credential
   * usable, and the identity only improves the display name and the
   * `X-User-Id` header. A failure here must not discard a working login.
   */
  private async fetchAccount(
    attempt: WorkBuddyLoginAttempt,
    accessToken: string,
    jar: LoginCookieJar | undefined,
  ): Promise<WorkBuddyLoginAccount> {
    try {
      const response = await this.fetchImpl(
        `${LOGIN_BASE[attempt.region]}${loginAccountPath(attempt.state)}`,
        {
          method: 'GET',
          headers: { ...this.headers(attempt.region, jar), 'Authorization': `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
        },
      )
      jar?.absorb(response)
      if (!response.ok) return { uid: '' }
      const envelope = await readEnvelope(response)
      const data = isObject(envelope.data) ? envelope.data : {}
      const enterpriseId = optionalString(data['enterpriseId'])
      const nickname = optionalString(data['nickname'])
      return {
        uid: optionalString(data['uid']) ?? '',
        ...enterpriseId === undefined ? {} : { enterpriseId },
        ...nickname === undefined ? {} : { nickname },
      }
    } catch {
      // Best effort: see above. The credential is already usable.
      return { uid: '' }
    }
  }
}
