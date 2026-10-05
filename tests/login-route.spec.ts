import { createServer, request as httpRequest, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createLoginKey, workBuddyLoginHandler, type WorkBuddyLoginRouteOptions } from '../src/login-route.ts'

/**
 * Offline tests for the sign-in route.
 *
 * Same two guards as the probe route, and for the same reasons: the loopback
 * Host/Origin check drops DNS-rebinding pages, and the in-process key proves the
 * caller was the same-origin card, since any local process can write
 * `Host: 127.0.0.1`. This route matters more than the probe one — it both holds
 * a pending OAuth attempt and writes a credential to disk.
 */

let server: Server | undefined

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() => resolve()))
    server = undefined
  }
})

/** Mount the handler on an ephemeral port and return its origin and key. */
async function mount(deps?: Partial<WorkBuddyLoginRouteOptions>): Promise<{ origin: string; key: string; calls: string[] }> {
  const key = createLoginKey()
  const calls: string[] = []
  const handler = workBuddyLoginHandler({
    begin: async () => {
      calls.push('begin')
      return { state: 'state-abc', url: 'https://copilot.tencent.com/login?state=state-abc' }
    },
    poll: async state => {
      calls.push(`poll:${state}`)
      return { status: 'pending', state }
    },
    logout: async () => { calls.push('logout') },
    importDocument: async document => {
      calls.push(`import:${document.length}`)
      return { uid: 'uid-imported', nickname: '小楚' }
    },
    ...deps,
  }, key)
  server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { origin: `http://127.0.0.1:${address.port}`, key, calls }
}

/** POST one sign-in action. */
async function post(
  origin: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(origin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/**
 * POST with full control over the request headers, including `Host`, which
 * `fetch` refuses to set. Needed to exercise the rebinding guard.
 */
async function postRaw(
  origin: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(origin)
  const payload = JSON.stringify(body)
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      path: '/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: response.statusCode ?? 0, body: text === '' ? {} : JSON.parse(text) as Record<string, unknown> })
      })
    })
    request.on('error', reject)
    request.end(payload)
  })
}

describe('sign-in route gate', () => {
  it('rejects anything but POST', async () => {
    const { origin, key } = await mount()
    const response = await fetch(origin, { headers: { 'X-WorkBuddy-Login-Key': key } })
    expect(response.status).toBe(405)
  })

  it('rejects a request whose Host is not loopback', async () => {
    const { origin, key } = await mount()
    // A DNS-rebinding page arrives addressed to the attacker's domain.
    const { status } = await postRaw(origin, { action: 'begin' }, { Host: 'evil.example', 'X-WorkBuddy-Login-Key': key })
    expect(status).toBe(403)
  })

  it('rejects a browser Origin that is not loopback', async () => {
    const { origin, key } = await mount()
    const { status } = await post(origin, { action: 'begin' }, { Origin: 'https://evil.example', 'X-WorkBuddy-Login-Key': key })
    expect(status).toBe(403)
  })

  it('rejects a caller that does not present the in-process key', async () => {
    const { origin, calls } = await mount()
    const missing = await post(origin, { action: 'begin' })
    const wrong = await post(origin, { action: 'begin' }, { 'X-WorkBuddy-Login-Key': 'not-the-key' })
    expect(missing.status).toBe(403)
    expect(wrong.status).toBe(403)
    // Neither attempt reached an operation.
    expect(calls).toEqual([])
  })

  it('accepts a same-origin request carrying the key', async () => {
    const { origin, key } = await mount()
    const { status } = await post(origin, { action: 'begin' }, { 'X-WorkBuddy-Login-Key': key })
    expect(status).toBe(200)
  })
})

describe('sign-in route actions', () => {
  it('starts an attempt and reports where to go', async () => {
    const { origin, key } = await mount()
    const { body } = await post(origin, { action: 'begin' }, { 'X-WorkBuddy-Login-Key': key })
    expect(body).toEqual({
      status: 'pending',
      state: 'state-abc',
      url: 'https://copilot.tencent.com/login?state=state-abc',
    })
  })

  it('passes a poll through to the attempt it names', async () => {
    const { origin, key, calls } = await mount()
    const { body } = await post(origin, { action: 'poll', state: 'state-abc' }, { 'X-WorkBuddy-Login-Key': key })
    expect(body).toEqual({ status: 'pending', state: 'state-abc' })
    expect(calls).toEqual(['poll:state-abc'])
  })

  it('reports a completed sign-in', async () => {
    const { origin, key } = await mount({
      poll: async () => ({ status: 'complete', nickname: '小楚' }),
    })
    const { body } = await post(origin, { action: 'poll', state: 'state-abc' }, { 'X-WorkBuddy-Login-Key': key })
    expect(body).toEqual({ status: 'complete', nickname: '小楚' })
  })

  it('signs out', async () => {
    const { origin, key, calls } = await mount()
    const { body } = await post(origin, { action: 'logout' }, { 'X-WorkBuddy-Login-Key': key })
    expect(body).toEqual({ status: 'signed-out' })
    expect(calls).toEqual(['logout'])
  })

  it('rejects a poll with no state', async () => {
    const { origin, key, calls } = await mount()
    const { status } = await post(origin, { action: 'poll' }, { 'X-WorkBuddy-Login-Key': key })
    expect(status).toBe(400)
    expect(calls).toEqual([])
  })

  it('rejects an unknown action', async () => {
    const { origin, key } = await mount()
    const { status } = await post(origin, { action: 'takeover' }, { 'X-WorkBuddy-Login-Key': key })
    expect(status).toBe(400)
  })

  it('rejects a body over the size ceiling', async () => {
    const { origin, key } = await mount()
    // The ceiling is generous enough for a credential document (a few KB) and
    // still bounded, so a runaway body cannot be buffered without limit.
    const { status } = await post(origin, { action: 'import', document: 'x'.repeat(70 * 1024) }, { 'X-WorkBuddy-Login-Key': key })
    expect(status).toBe(413)
  })

  it('accepts a credential document comfortably larger than a control payload', async () => {
    const { origin, key } = await mount()
    // A real workbuddy.json carries a ~1.3KB access token and a ~0.7KB refresh
    // token, so the ceiling has to sit well above the old few-dozen-byte control body.
    const document = JSON.stringify({
      auth: { accessToken: 'a'.repeat(2000), refreshToken: 'r'.repeat(1000), expiresAt: 1_794_051_445, domain: 'copilot.tencent.com' },
      account: { uid: 'uid-imported' },
    })
    const { status } = await post(origin, { action: 'import', document }, { 'X-WorkBuddy-Login-Key': key })
    expect(status).toBe(200)
  })

  it('adopts a supplied credential document', async () => {
    const { origin, key, calls } = await mount()
    const document = JSON.stringify({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: 1_794_051_445, domain: 'copilot.tencent.com' },
      account: { uid: 'uid-imported', nickname: '小楚' },
    })
    const { status, body } = await post(origin, { action: 'import', document }, { 'X-WorkBuddy-Login-Key': key })
    expect(status).toBe(200)
    expect(body).toEqual({ status: 'imported', uid: 'uid-imported', nickname: '小楚' })
    // The document reaches the operation verbatim; the host is what parses it.
    expect(calls).toEqual([`import:${document.length}`])
  })

  it('rejects an import with no document', async () => {
    const { origin, key, calls } = await mount()
    const { status } = await post(origin, { action: 'import' }, { 'X-WorkBuddy-Login-Key': key })
    expect(status).toBe(400)
    expect(calls).toEqual([])
  })

  it('reports a refused import as a result, not as a transport error', async () => {
    const { origin, key } = await mount({
      importDocument: async () => { throw new Error('that document belongs to WorkBuddy (CN), not WorkBuddy AI') },
    })
    const { status, body } = await post(origin, { action: 'import', document: '{}' }, { 'X-WorkBuddy-Login-Key': key })
    expect(status).toBe(200)
    expect(body).toEqual({ status: 'failed', message: 'that document belongs to WorkBuddy (CN), not WorkBuddy AI' })
  })
})

describe('sign-in route failure reporting', () => {
  it('answers a failed operation as a result, not as a transport error', async () => {
    const { origin, key } = await mount({
      begin: async () => { throw new Error('auth state failed (http 502)') },
    })
    const { status, body } = await post(origin, { action: 'begin' }, { 'X-WorkBuddy-Login-Key': key })
    // The card renders the reason; a 5xx would be indistinguishable from the
    // host being unreachable.
    expect(status).toBe(200)
    expect(body).toEqual({ status: 'failed', message: 'auth state failed (http 502)' })
  })

  it('never carries a token-like string to the browser', async () => {
    const { origin, key } = await mount({
      poll: async () => {
        throw new Error('upstream rejected access_token=SECRETVALUE for Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature')
      },
    })
    const { body } = await post(origin, { action: 'poll', state: 'state-abc' }, { 'X-WorkBuddy-Login-Key': key })
    const message = String(body['message'])
    expect(message).not.toContain('SECRETVALUE')
    expect(message).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(message).toContain('[redacted')
  })
})
