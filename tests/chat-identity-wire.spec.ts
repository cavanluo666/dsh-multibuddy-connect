import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { ChatIdentity } from '../src/client-identity.ts'

/**
 * Outbound wire pin for the phase-1 chat identity (plan §3, 阶段一离线检查):
 * capture the exact `(url, init)` the client hands to `fetch` and assert that
 * chat and probe present the desktop UA while everything else — the shared
 * header family, the body shapes, refresh, catalog, and billing — stays
 * byte-for-byte what it has always been.
 */

const CN: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: 0,
  domain: 'www.codebuddy.cn', uid: 'uid-1', source: 'login',
}
const GLOBAL: WorkBuddyCredential = { ...CN, domain: 'www.workbuddy.ai' }

/** Deterministic identity so assertions never depend on the machine's Apps. */
const IDENTITY: ChatIdentity = { clientVersion: '5.5.6', cliVersion: '2.137.1' }

function client(): WorkBuddyUpstreamClient {
  return new WorkBuddyUpstreamClient({ resolveChatIdentity: async () => IDENTITY })
}

function fakeResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: () => Promise.resolve(body) } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Stub fetch and return a probe for the last (url, init) pair it received. */
function captureFetch(body: string, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => fakeResponse(body, ok, status))
  vi.stubGlobal('fetch', fetchMock)
  return {
    last: () => {
      expect(fetchMock).toHaveBeenCalled()
      return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as unknown as [string, RequestInit]
    },
  }
}

describe('chatStream identity', () => {
  it('presents the CN desktop UA and the CN header family', async () => {
    const wire = captureFetch('{}')
    const result = await client().chatStream(CN, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    expect(result.ok).toBe(true)
    const [url, init] = wire.last()
    expect(url).toBe('https://copilot.tencent.com/v2/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1')
    // The shared family: transport conventions, the gate header every API call
    // carries, and the locale the CN deployment expects.
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest')
    expect(headers['Origin']).toBe('https://www.codebuddy.cn')
    expect(headers['Referer']).toBe('https://www.codebuddy.cn/')
    expect(headers['X-CodeBuddy-Request']).toBe('1')
    expect(headers['Accept-Language']).toBe('zh-CN')
    expect(headers['Content-Type']).toBe('application/json')
    // Chat streams, so it declares the event-stream type the shared default does not.
    expect(headers['Accept']).toBe('application/json, text/event-stream')
    // CN keeps the account's own declarations; this fixture has no enterprise,
    // so the X-No-* convention states that explicitly.
    expect(headers['X-User-Id']).toBe('uid-1')
    expect(headers['X-No-Enterprise-Id']).toBe('1')
    expect(headers['X-Enterprise-Id']).toBeUndefined()
    expect(headers['X-Domain']).toBe('www.codebuddy.cn')
    expect(headers['Authorization']).toBe('Bearer at')
    // 安全红线：refresh token 绝不出现在 chat 请求里。
    expect(headers['X-Refresh-Token']).toBeUndefined()
    // Usage attribution, so the upstream does not record an anonymous gateway call.
    expect(headers['X-Agent-Purpose']).toBe('conversation')
    expect(headers['X-Product']).toBe('WorkBuddy')
    expect(headers['X-IDE-Name']).toBe('WorkBuddy')
    expect(headers['X-IDE-Version']).toBe('2.63.2')
    // Device identifiers are derived from the uid, so they are stable and account-scoped.
    expect(headers['X-Machine-ID']).toMatch(/^[0-9a-f]{36}$/)
    expect(headers['X-Session-ID']).toMatch(/^[0-9a-f]{36}$/)
    expect(headers['X-Machine-ID']).not.toBe(headers['X-Session-ID'])
  })

  it('adds an account-scoped cache key to the body it forwards', async () => {
    const wire = captureFetch('{}')
    await client().chatStream(CN, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    const body = JSON.parse(wire.last()[1].body as string) as Record<string, unknown>
    expect(body['model']).toBe('m')
    // The key carries the account segment, so two accounts can never collide on
    // one cache entry.
    expect(String(body['prompt_cache_key'])).toMatch(/^wb2a-uid-1-[0-9a-f]{32}$/)
    // The CN path forwards the body the shim already normalized; it does not
    // re-normalize, so the streaming fields are the shim's business, not this
    // client's.
    expect(body['stream']).toBeUndefined()
    expect((body['messages'] as unknown[]).length).toBe(1)
  })

  it('does not overwrite a caller-supplied cache key', async () => {
    const wire = captureFetch('{}')
    await client().chatStream(CN, JSON.stringify({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      prompt_cache_key: 'caller-key',
    }))
    const body = JSON.parse(wire.last()[1].body as string) as Record<string, unknown>
    expect(body['prompt_cache_key']).toBe('caller-key')
  })

  it('names the international product in the UA and still prepends the first system message', async () => {
    const wire = captureFetch('{}')
    const result = await client().chatStream(GLOBAL, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    expect(result.ok).toBe(true)
    const [url, init] = wire.last()
    // The international deployment routes chat through its console path.
    expect(url).toBe('https://www.workbuddy.ai/console/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy AI/5.5.6 CLI/2.137.1')
    expect(headers['Accept-Language']).toBe('en-US')
    // The international gateway is told this is a personal international client
    // whichever host issued the login: no enterprise, and its own fixed domain.
    expect(headers['X-No-Enterprise-Id']).toBe('1')
    expect(headers['X-Enterprise-Id']).toBeUndefined()
    expect(headers['X-Domain']).toBe('www.workbuddy.ai')
    const body = JSON.parse(init.body as string) as { messages: { role: string }[] }
    expect(body.messages[0]?.role).toBe('system')
    expect(body.messages[1]?.role).toBe('user')
  })

  it('falls back to the shared chat path when the console path is not routed', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      calls.push(url)
      return url.includes('/console/chat/completions')
        ? fakeResponse('not found', false, 404)
        : fakeResponse('{}', true, 200)
    }))
    const result = await client().chatStream(GLOBAL, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    expect(result.ok).toBe(true)
    expect(calls).toEqual([
      'https://www.workbuddy.ai/console/chat/completions',
      'https://www.workbuddy.ai/v2/chat/completions',
    ])
  })

  it('does not retry a CN chat call on another path', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      calls.push(String(input))
      return fakeResponse('not found', false, 404)
    }))
    const result = await client().chatStream(CN, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    expect(result.ok).toBe(false)
    expect(calls).toEqual(['https://copilot.tencent.com/v2/chat/completions'])
  })
})

describe('probeEffort identity', () => {
  it('shares the chat identity rule — same UA family, CN probe shape', async () => {
    const wire = captureFetch('{"code":11150,"msg":"no"}', false, 400)
    await client().probeEffort(CN, 'model-x', 'low', new AbortController().signal)
    const [, init] = wire.last()
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1')
    const body = JSON.parse(init.body as string) as {
      messages: { role: string }[]; max_tokens: number; reasoning_effort: string
    }
    expect(body.messages[0]?.role).toBe('user')
    expect(body.max_tokens).toBe(1)
    expect(body.reasoning_effort).toBe('low')
  })

  it('uses the international UA with the probe-only system and token floor', async () => {
    const wire = captureFetch('{"code":11150,"msg":"no"}', false, 400)
    await client().probeEffort(GLOBAL, 'model-x', undefined, new AbortController().signal)
    const [, init] = wire.last()
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy AI/5.5.6 CLI/2.137.1')
    const body = JSON.parse(init.body as string) as { messages: { role: string }[]; max_tokens: number }
    expect(body.messages[0]?.role).toBe('system')
    expect(body.max_tokens).toBe(16)
    expect('reasoning_effort' in body).toBe(false)
  })

  it('still constructs chat and probe requests, in the desktop fallback form, when the resolver throws', async () => {
    const throwing = new WorkBuddyUpstreamClient({
      resolveChatIdentity: async () => {
        throw new Error('boom')
      },
    })
    const chatWire = captureFetch('{}')
    const chat = await throwing.chatStream(CN, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    expect(chat.ok).toBe(true)
    expect((chatWire.last()[1].headers as Record<string, string>)['User-Agent'])
      .toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6')

    const probeWire = captureFetch('{"code":11150,"msg":"no"}', false, 400)
    const probe = await throwing.probeEffort(GLOBAL, 'model-x', 'low', new AbortController().signal)
    expect(probe.status).toBe(400)
    expect((probeWire.last()[1].headers as Record<string, string>)['User-Agent'])
      .toBe('WorkBuddy/5.5.2 WorkBuddy AI/5.5.2')
  })
})

describe('unchanged paths (regression pin)', () => {
  it('refresh keeps the CLI-form UA, the plugin refresh source, and the shared family', async () => {
    const wire = captureFetch(JSON.stringify({ code: 0, msg: 'ok', data: { accessToken: 'next' } }))
    await client().refreshToken(CN)
    const [url, init] = wire.last()
    expect(url).toBe('https://copilot.tencent.com/v2/plugin/auth/token/refresh')
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('CLI/2.63.2 CodeBuddy/2.63.2')
    // The official client's own refresh channel identifier.
    expect(headers['X-Auth-Refresh-Source']).toBe('plugin')
    expect(headers['X-Refresh-Token']).toBe('rt')
    expect(headers['Origin']).toBe('https://www.codebuddy.cn')
    expect(headers['X-CodeBuddy-Request']).toBe('1')
    expect(headers['Accept-Language']).toBe('zh-CN')
    // The refresh path is not a chat request, so it carries no gate-only chat headers.
    expect(headers['X-Agent-Purpose']).toBeUndefined()
  })

  it('CN catalog keeps the CLI-form UA', async () => {
    const wire = captureFetch(JSON.stringify({
      code: 0, msg: 'ok',
      data: { models: [{ id: 'm', name: 'M', maxInputTokens: 100, maxOutputTokens: 10 }], agents: [{ name: 'cli', models: ['m'] }] },
    }))
    await client().fetchModels(CN)
    const [url, init] = wire.last()
    expect(url).toBe('https://copilot.tencent.com/console/enterprises/personal/models')
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('CLI/2.63.2 CodeBuddy/2.63.2')
  })

  it('international catalog keeps the no-space App-form UA', async () => {
    const wire = captureFetch(JSON.stringify({
      code: 0, msg: 'ok',
      data: { models: [{ id: 'm', name: 'M', maxInputTokens: 100, maxOutputTokens: 10 }], agents: [{ name: 'cli', models: ['m'] }] },
    }))
    const intlClient = new WorkBuddyUpstreamClient({
      resolveAppVersion: async () => ({ version: '5.5.2', source: 'installed', bundle: '/x' }),
      resolveChatIdentity: async () => IDENTITY,
    })
    await intlClient.fetchModels(GLOBAL)
    const [url, init] = wire.last()
    expect(url).toBe('https://www.workbuddy.ai/v3/config')
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('WorkBuddyAI/5.5.2')
  })

  it('billing carries its own identity, locale, and gate header', async () => {
    const wire = captureFetch(JSON.stringify({
      code: 0, msg: 'ok',
      data: { Response: { Data: { Accounts: [] } } },
    }))
    await client().fetchCredits(CN)
    const [url, init] = wire.last()
    expect(url).toBe('https://www.codebuddy.cn/v2/billing/meter/get-user-resource')
    const headers = init.headers as Record<string, string>
    // The billing path does not share the chat headers, so it states its own:
    // an unidentified billing call is the anomaly the official client never makes.
    expect(headers['User-Agent']).toBe('CLI/2.63.2 CodeBuddy/2.63.2')
    expect(headers['X-CodeBuddy-Request']).toBe('1')
    expect(headers['Accept-Language']).toBe('zh-CN')
    expect(headers['X-User-Id']).toBe('uid-1')
    expect(headers['X-Machine-ID']).toMatch(/^[0-9a-f]{36}$/)
  })

  it('falls back to the versioned billing path when the international one is not routed', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      calls.push(url)
      return url.includes('/v2/billing/')
        ? fakeResponse(JSON.stringify({ code: 0, msg: 'ok', data: { Response: { Data: { Accounts: [] } } } }), true, 200)
        : fakeResponse('not found', false, 404)
    }))
    await client().fetchCredits(GLOBAL)
    expect(calls).toEqual([
      'https://www.workbuddy.ai/billing/meter/get-user-resource',
      'https://www.workbuddy.ai/v2/billing/meter/get-user-resource',
    ])
  })
})
