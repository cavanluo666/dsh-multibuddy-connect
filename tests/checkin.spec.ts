import { describe, expect, it, vi } from 'vitest'
import {
  WorkBuddyCheckInService,
  getUtc8DateString,
  type WorkBuddyCheckInResult,
} from '../src/checkin.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import {
  CheckInScheduler,
  type CheckInStatusStore,
  type CheckInRecord,
} from '../src/checkin-scheduler.ts'

describe('WorkBuddyCheckInService', () => {
  const fakeCredentialCN: WorkBuddyCredential = {
    accessToken: 'test-cn-token',
    refreshToken: 'test-cn-refresh',
    expiresAtMs: Date.now() + 3600_000,
    domain: 'workbuddy.cn',
    uid: 'user-123',
    source: 'login',
  }

  const fakeCredentialAI: WorkBuddyCredential = {
    accessToken: 'test-ai-token',
    refreshToken: 'test-ai-refresh',
    expiresAtMs: Date.now() + 3600_000,
    domain: 'workbuddy.ai',
    uid: 'user-456',
    source: 'login',
  }

  it('rejects with error result when credential has no token', async () => {
    const service = new WorkBuddyCheckInService()
    const result = await service.checkIn('workbuddy', undefined)
    expect(result.status).toBe('error')
    expect(result.message).toContain('No access token')
  })

  it('claims daily benefit when CN endpoint returns code 0 with credit', async () => {
    let capturedHeaders: Record<string, string> | undefined
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>
      return new Response(JSON.stringify({
        code: 0,
        msg: 'ok',
        data: { credit: 50 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const service = new WorkBuddyCheckInService({ fetch: mockFetch })
    const result = await service.checkIn('workbuddy', fakeCredentialCN)

    expect(result.status).toBe('claimed')
    expect(result.amount).toBe(50)
    expect(capturedHeaders?.['Authorization']).toBe('Bearer test-cn-token')
    expect(capturedHeaders?.['Origin']).toBe('https://www.workbuddy.cn')
    expect(capturedHeaders?.['Referer']).toBe('https://www.workbuddy.cn/profile/growth-center')
    // The same client UA the login and catalog paths send (the official
    // client's own token), never an invented browser one.
    expect(capturedHeaders?.['User-Agent']).toBe('CLI/2.63.2 CodeBuddy/2.63.2')
  })

  it('detects already-claimed when HTTP 400 and code 10001', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({
        code: 10001,
        msg: '今天已签到，请明天再来',
      }), { status: 400, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const service = new WorkBuddyCheckInService({ fetch: mockFetch })
    const result = await service.checkIn('workbuddy', fakeCredentialCN)

    expect(result.status).toBe('already-claimed')
    expect(result.message).toContain('今天已签到')
  })

  it('detects already-claimed when message contains 已签到 even on other status code', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({
        code: 10002,
        msg: '今日已签到',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const service = new WorkBuddyCheckInService({ fetch: mockFetch })
    const result = await service.checkIn('workbuddy', fakeCredentialCN)

    expect(result.status).toBe('already-claimed')
  })

  it('calls global endpoint with appropriate headers for international variant', async () => {
    let capturedUrl: string | undefined
    let capturedHeaders: Record<string, string> | undefined
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedHeaders = init?.headers as Record<string, string>
      return new Response(JSON.stringify({
        code: 0,
        msg: 'ok',
        data: { credit: 100 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const service = new WorkBuddyCheckInService({ fetch: mockFetch })
    const result = await service.checkIn('workbuddy-ai', fakeCredentialAI)

    expect(result.status).toBe('claimed')
    expect(result.amount).toBe(100)
    expect(capturedUrl).toBe('https://www.workbuddy.ai/v2/billing/meter/daily-checkin')
    expect(capturedHeaders?.['X-Domain']).toBe('www.workbuddy.ai')
    expect(capturedHeaders?.['X-No-Enterprise-Id']).toBe('1')
    expect(capturedHeaders?.['Accept-Language']).toBe('en-US')
  })

  it('returns error on HTTP 500 or transport error', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response('Server Error', { status: 500 })
    }) as unknown as typeof fetch

    const service = new WorkBuddyCheckInService({ fetch: mockFetch })
    const result = await service.checkIn('workbuddy', fakeCredentialCN)

    expect(result.status).toBe('error')
  })
})

describe('CheckInScheduler', () => {
  function createMockStore(initial?: Record<string, CheckInRecord>): CheckInStatusStore {
    const records = new Map<string, CheckInRecord>(Object.entries(initial ?? {}))
    return {
      read: vi.fn(variantId => records.get(variantId)),
      write: vi.fn((variantId, record) => { records.set(variantId, record) }),
      clearLogs: vi.fn(variantId => {
        const existing = records.get(variantId)
        if (existing) records.set(variantId, { ...existing, logs: [] })
      }),
    }
  }

  it('claims on startup regardless of the wall-clock time of day', async () => {
    const store = createMockStore()
    // 09:30 UTC+8 — a time the old timer would have skipped.
    const simulatedNow = new Date('2026-09-22T01:30:00.000Z').getTime()
    const checkInFn = vi.fn(async () => ({
      variantId: 'workbuddy',
      date: getUtc8DateString(simulatedNow),
      timestamp: simulatedNow,
      status: 'claimed' as const,
      amount: 100,
    }))

    const scheduler = new CheckInScheduler({
      targets: [{ variantId: 'workbuddy', checkIn: checkInFn }],
      isEnabled: () => true,
      store,
      now: () => simulatedNow,
    })

    scheduler.start()
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(checkInFn).toHaveBeenCalledTimes(1)
    expect(store.write).toHaveBeenCalledWith('workbuddy', expect.objectContaining({
      status: 'claimed',
      amount: 100,
    }))

    scheduler.dispose()
  })

  it('does not re-claim when today is already settled', async () => {
    const today = getUtc8DateString()
    const store = createMockStore({
      workbuddy: { lastDate: today, lastAt: Date.now(), status: 'claimed', amount: 100 },
    })
    const checkInFn = vi.fn(async () => ({
      variantId: 'workbuddy',
      date: today,
      timestamp: Date.now(),
      status: 'claimed' as const,
    }))

    const scheduler = new CheckInScheduler({
      targets: [{ variantId: 'workbuddy', checkIn: checkInFn }],
      isEnabled: () => true,
      store,
    })

    scheduler.start()
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(checkInFn).not.toHaveBeenCalled()
    scheduler.dispose()
  })

  it('skips variants whose auto check-in toggle is off', async () => {
    const store = createMockStore()
    const checkInFn = vi.fn(async () => ({
      variantId: 'workbuddy',
      date: getUtc8DateString(),
      timestamp: Date.now(),
      status: 'claimed' as const,
    }))

    const scheduler = new CheckInScheduler({
      targets: [{ variantId: 'workbuddy', checkIn: checkInFn }],
      isEnabled: () => false,
      store,
    })

    scheduler.start()
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(checkInFn).not.toHaveBeenCalled()
    scheduler.dispose()
  })
})
