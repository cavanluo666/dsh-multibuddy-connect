import { describe, expect, it } from 'vitest'
import {
  LOGIN_PENDING_CODE,
  WorkBuddyLoginClient,
  normalizeLoginRegion,
  resolveLoginRegion,
  type WorkBuddyLoginAttempt,
} from '../src/login.ts'

/**
 * Offline tests for the device-authorization login client.
 *
 * The upstream is stubbed, so these pin the wire contract the two realms are
 * known to require: the state is issued by one host, the browser visit is
 * reported by another call against the *same* cookie jar, and a not-yet-finished
 * login arrives as a business code rather than as an HTTP failure.
 */

const STATE = 'state-abc'

/** One recorded outbound request. */
interface Call {
  url: string
  method: string
  headers: Record<string, string>
}

/** A stub transport that answers by URL shape and records every call. */
function transport(routes: readonly ((url: string) => Response | undefined)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input)
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value
    }
    calls.push({ url, method: init?.method ?? 'GET', headers })
    for (const route of routes) {
      const response = route(url)
      if (response !== undefined) return response
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch
  return { fetch: impl, calls }
}

function envelope(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

/** The `auth/state` answer, optionally setting the gateway's routing cookie. */
function authState(authUrl = `https://copilot.tencent.com/login?state=${STATE}`, cookie?: string): Response {
  return envelope(
    { code: 0, msg: 'OK', data: { state: STATE, authUrl } },
    200,
    cookie === undefined ? {} : { 'Set-Cookie': cookie },
  )
}

/** The `auth/token` answer while the human has not finished. */
function tokenPending(): Response {
  return envelope({ code: LOGIN_PENDING_CODE, msg: '11217:login ing...' })
}

/** The `auth/token` answer once the browser half finished. */
function tokenComplete(domain = 'copilot.tencent.com'): Response {
  return envelope({
    code: 0,
    msg: 'OK',
    data: { accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200, domain },
  })
}

function account(uid = 'uid-1'): Response {
  return envelope({ code: 0, msg: 'OK', data: { uid, enterpriseId: 'ent-1', nickname: '小楚' } })
}

describe('login client', () => {
  it('issues an attempt against the CN realm and returns the URL to open', async () => {
    const { fetch: stub, calls } = transport([url => url.includes('/v2/plugin/auth/state') ? authState() : undefined])
    const attempt = await new WorkBuddyLoginClient(stub).begin('cn')

    expect(attempt).toMatchObject({ state: STATE, region: 'cn' })
    expect(attempt.authUrl).toContain('/login?state=')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI')
    expect(calls[0]!.method).toBe('POST')
    // The CN deployment serves the API host but requires the site's own origin.
    expect(calls[0]!.headers['origin']).toBe('https://www.codebuddy.cn')
    expect(calls[0]!.headers['referer']).toBe('https://www.codebuddy.cn/')
  })

  it('issues an attempt against the international realm on its own host', async () => {
    const { fetch: stub, calls } = transport([url => url.includes('/v2/plugin/auth/state')
      ? authState(`https://www.workbuddy.ai/login?state=${STATE}`)
      : undefined])
    await new WorkBuddyLoginClient(stub).begin('global')

    expect(calls[0]!.url).toBe('https://www.workbuddy.ai/v2/plugin/auth/state?platform=CLI')
    expect(calls[0]!.headers['origin']).toBe('https://www.workbuddy.ai')
  })

  it('reuses the state cookie issued at begin on every later poll', async () => {
    const { fetch: stub, calls } = transport([
      url => url.includes('/v2/plugin/auth/state') ? authState(undefined, 'tgw_l7_route=routing-value; Path=/; Secure') : undefined,
      url => tokenPending(),
    ])
    const client = new WorkBuddyLoginClient(stub)
    const attempt = await client.begin('cn')
    await client.poll(attempt)

    const poll = calls.at(-1)!
    expect(poll.url).toBe(`https://copilot.tencent.com/v2/plugin/auth/token?state=${STATE}`)
    // Without the routing cookie the gateway cannot correlate this poll with the
    // browser visit, so its absence is a real defect rather than a detail.
    expect(poll.headers['cookie']).toContain('tgw_l7_route=routing-value')
  })

  it('reports an unfinished login as pending, not as a failure', async () => {
    const { fetch: stub } = transport([
      url => url.includes('/v2/plugin/auth/state') ? authState() : undefined,
      () => tokenPending(),
    ])
    const client = new WorkBuddyLoginClient(stub)
    const attempt = await client.begin('cn')
    await expect(client.poll(attempt)).resolves.toEqual({ status: 'pending' })
  })

  it('treats a gateway refusal of a not-yet-finished poll as pending', async () => {
    const { fetch: stub } = transport([
      url => url.includes('/v2/plugin/auth/state') ? authState() : undefined,
      // The gateway rejects the token call with 401 until the browser half is done.
      () => envelope({ code: 401, msg: 'unauthorized' }, 401),
    ])
    const client = new WorkBuddyLoginClient(stub)
    const attempt = await client.begin('cn')
    await expect(client.poll(attempt)).resolves.toEqual({ status: 'pending' })
  })

  it('returns the token bundle and the account once the browser finishes', async () => {
    const { fetch: stub } = transport([
      url => url.includes('/v2/plugin/auth/state') ? authState() : undefined,
      url => url.includes('/v2/plugin/auth/token') ? tokenComplete() : undefined,
      url => url.includes('/v2/plugin/login/account') ? account() : undefined,
    ])
    const client = new WorkBuddyLoginClient(stub)
    const attempt = await client.begin('cn')
    const outcome = await client.poll(attempt)

    expect(outcome).toEqual({
      status: 'complete',
      tokens: { accessToken: 'at-1', refreshToken: 'rt-1', expiresInSec: 7200, domain: 'copilot.tencent.com' },
      account: { uid: 'uid-1', enterpriseId: 'ent-1', nickname: '小楚' },
    })
  })

  it('keeps a usable credential when the account lookup fails', async () => {
    const { fetch: stub } = transport([
      url => url.includes('/v2/plugin/auth/state') ? authState() : undefined,
      url => url.includes('/v2/plugin/auth/token') ? tokenComplete() : undefined,
      // The identity only improves the display name; losing it must not discard
      // a token bundle that already works.
      () => envelope({ code: 500, msg: 'boom' }, 500),
    ])
    const client = new WorkBuddyLoginClient(stub)
    const attempt = await client.begin('cn')
    const outcome = await client.poll(attempt)

    expect(outcome.status).toBe('complete')
    expect(outcome.status === 'complete' ? outcome.account : undefined).toEqual({ uid: '' })
  })

  it('surfaces a server failure at the token endpoint as an error', async () => {
    const { fetch: stub } = transport([
      url => url.includes('/v2/plugin/auth/state') ? authState() : undefined,
      () => envelope({ code: 500, msg: 'boom' }, 503),
    ])
    const client = new WorkBuddyLoginClient(stub)
    const attempt = await client.begin('cn')
    // Retrying an outage as "pending" would hide it behind a spinner that never
    // resolves, so it has to throw.
    await expect(client.poll(attempt)).rejects.toThrow(/token endpoint failed/)
  })

  it('rejects a state reply that carries no URL', async () => {
    const { fetch: stub } = transport([() => envelope({ code: 0, msg: 'OK', data: { state: STATE } })])
    await expect(new WorkBuddyLoginClient(stub).begin('cn')).rejects.toThrow(/no state or authUrl/)
  })

  it('forgets an attempt on request, so its cookie jar is released', async () => {
    const { fetch: stub } = transport([url => url.includes('/v2/plugin/auth/state') ? authState() : undefined])
    const client = new WorkBuddyLoginClient(stub)
    const attempt = await client.begin('cn')
    expect(client.pendingCount()).toBe(1)
    client.forget(attempt.state)
    expect(client.pendingCount()).toBe(0)
  })
})

describe('login realm resolution', () => {
  it('folds an unrecognised realm spelling onto CN', () => {
    for (const value of [undefined, '', 'cn', 'CN', 'nonsense']) {
      expect(normalizeLoginRegion(value)).toBe('cn')
    }
    expect(normalizeLoginRegion('global')).toBe('global')
    expect(normalizeLoginRegion(' GLOBAL ')).toBe('global')
  })

  it('keeps the realm the attempt was started against when the domain is silent', () => {
    // An empty domain reads as CN everywhere else, so trusting it here would
    // turn an international login into a CN one.
    expect(resolveLoginRegion('global', '')).toBe('global')
    expect(resolveLoginRegion('cn', '')).toBe('cn')
  })

  it('follows the domain the upstream actually issued the credential for', () => {
    expect(resolveLoginRegion('cn', 'www.workbuddy.ai')).toBe('global')
    expect(resolveLoginRegion('global', 'copilot.tencent.com')).toBe('cn')
    expect(resolveLoginRegion('cn', 'www.codebuddy.cn')).toBe('cn')
  })
})

describe('login attempt descriptor', () => {
  it('carries the realm so a poll targets the host that issued the state', () => {
    const attempt: WorkBuddyLoginAttempt = { state: STATE, authUrl: 'https://example.test/login', region: 'global' }
    expect(attempt.region).toBe('global')
  })
})
