import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrowthScheduler, type GrowthTarget } from '../src/growth-scheduler.ts'
import { WorkBuddyGrowthClient } from '../src/growth.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'tok', refreshToken: 'ref', expiresAtMs: Date.now() + 3_600_000,
  domain: 'www.codebuddy.cn', uid: 'u-1', source: 'login',
}

/** A router that answers every growth endpoint from one table. */
function routed(overrides: Record<string, () => unknown> = {}): { client: WorkBuddyGrowthClient; calls: string[] } {
  const calls: string[] = []
  const routes: Record<string, () => unknown> = {
    '/tasks': () => ({ code: 0, data: { tasks: [] } }),
    '/activity/growth/streak': () => ({ code: 0, data: { streak: { days: 0 }, redemption_status: { tiers: [] }, makeup_cards: {} } }),
    '/activity/growth/lottery/summary': () => ({ code: 0, data: { chances: 0 } }),
    '/activity/growth/buddy/info': () => ({ code: 0, data: { buddy: {} } }),
    ...overrides,
  }
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    calls.push((init?.method ?? 'GET') + ' ' + u)
    // Longest match wins, so a specific route beats a shared prefix.
    const key = Object.keys(routes).filter(k => u.includes(k)).sort((a, b) => b.length - a.length)[0]
    if (key === undefined) return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    const body = routes[key]!()
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
  return { client: new WorkBuddyGrowthClient(fetchImpl), calls }
}

describe('growth automation: streak, lottery, buddy, travel', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'growth2-'))
    previous = process.env['DSH_WORKBUDDY_DATA_DIR']
    process.env['DSH_WORKBUDDY_DATA_DIR'] = dir
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env['DSH_WORKBUDDY_DATA_DIR']
    else process.env['DSH_WORKBUDDY_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  })

  function scheduler(client: WorkBuddyGrowthClient) {
    const target: GrowthTarget = { id: 'u-1', label: 'Alice', credential: async () => CREDENTIAL }
    return new GrowthScheduler({ targets: () => [target], isEnabled: () => true, client, sleep: async () => {} })
  }

  it('redeems only UNLOCKED streak tiers', async () => {
    const { client, calls } = routed({
      '/activity/growth/streak': () => ({ code: 0, data: {
        streak: { days: 20, month_total_days: 20, next_tier: '28d', next_tier_remaining: 8 },
        redemption_status: {
          tiers: [
            { tier: '7d', days: 7, credit: 0, energy: 2, chances: 1 },
            { tier: '14d', days: 14, credit: 50, energy: 3, chances: 1 },
            { tier: '28d', days: 28, credit: 150, energy: 5, chances: 1 },
          ],
          tier_7d_status: 'claimed',
          tier_14d_status: 'claimable',
          tier_28d_status: 'locked',
        },
        makeup_cards: { balance: 1 },
      } }),
    })
    const summary = await scheduler(client).sweep()
    expect(summary?.accounts[0]?.tiersRedeemed).toBe(1)
    expect(summary?.credit).toBe(50)
    const redeems = calls.filter(c => c.includes('/redeem'))
    expect(redeems).toHaveLength(1)
    expect(redeems[0]).toContain('POST')
  })

  it('never redeems a LOCKED tier', async () => {
    // A locked tier answers 403 from the redeem endpoint, which looks like a
    // real failure once stripped to an error.
    const { client, calls } = routed({
      '/activity/growth/streak': () => ({ code: 0, data: {
        streak: { days: 1 },
        redemption_status: { tiers: [{ tier: '7d', days: 7, credit: 10, energy: 1, chances: 1 }], tier_7d_status: 'locked' },
        makeup_cards: {},
      } }),
    })
    const summary = await scheduler(client).sweep()
    expect(summary?.accounts[0]?.tiersRedeemed).toBe(0)
    expect(calls.some(c => c.includes('/redeem'))).toBe(false)
  })

  it('draws the lottery once per available chance', async () => {
    let chances = 2
    const { client, calls } = routed({
      '/activity/growth/lottery/summary': () => ({ code: 0, data: { chances } }),
      '/activity/growth/lottery/draw': () => ({ code: 0, data: { credit: 5 } }),
    })
    const summary = await scheduler(client).sweep()
    expect(summary?.accounts[0]?.draws).toBe(2)
    expect(calls.filter(c => c.includes('/lottery/draw'))).toHaveLength(2)
  })

  it('does not draw when there are no chances', async () => {
    const { client, calls } = routed()
    await scheduler(client).sweep()
    expect(calls.some(c => c.includes('/lottery/draw'))).toBe(false)
  })

  it('stops drawing if one draw fails, rather than looping', async () => {
    // A failing draw endpoint with chances still reported would otherwise spin.
    let n = 0
    const { client } = routed({
      '/activity/growth/lottery/summary': () => ({ code: 0, data: { chances: 5 } }),
      '/activity/growth/lottery/draw': () => { n += 1; return { code: 9, msg: 'draw failed' } },
    })
    const summary = await scheduler(client).sweep()
    expect(n).toBe(1)
    expect(summary?.accounts[0]?.draws).toBe(0)
  })

  it('adopts a buddy when there is none', async () => {
    let adopted = false
    const { client, calls } = routed({
      '/activity/growth/buddy/info': () => ({ code: 0, data: { buddy: adopted ? { instance_id: 7, name: 'Panda' } : {} } }),
      '/activity/growth/buddy/first': () => { adopted = true; return { code: 0, data: {} } },
    })
    const summary = await scheduler(client).sweep()
    expect(summary?.accounts[0]?.buddyAdopted).toBe(true)
    expect(calls.some(c => c.includes('/buddy/agreement'))).toBe(true)
    expect(calls.some(c => c.includes('/buddy/first'))).toBe(true)
  })

  it('records a refused adoption as a failure, not as fatal', async () => {
    // Adoption is gated on having reported activity today; refusing is the
    // ordinary "not yet" and must not cost the rest of the pass.
    const { client } = routed({
      '/activity/growth/buddy/first': () => ({ code: 400, msg: 'first_buddy task not completed yet' }),
    })
    const summary = await scheduler(client).sweep()
    expect(summary?.accounts[0]?.buddyAdopted).toBe(false)
    expect(summary?.accounts[0]?.failures.some(f => f.includes('buddy'))).toBe(true)
    // The task pass still ran.
    expect(summary?.accounts[0]?.error).toBeUndefined()
  })

  it('claims an ARRIVED trip before departing a new one', async () => {
    // Departing while a reward waits would leave it uncollected.
    let claimed = false
    const { client, calls } = routed({
      '/activity/growth/buddy/info': () => ({ code: 0, data: { buddy: { instance_id: 7, name: 'P' } } }),
      '/activity/growth/buddy/travel/status': () => ({ code: 0, data: claimed
        ? { state: 'travelling', record_id: 0, daily_limit_reached: false }
        : { state: 'arrived', record_id: 42, reward_credit: 30 } }),
      '/activity/growth/buddy/travel/claim': () => { claimed = true; return { code: 0, data: { reward_credit: 30 } } },
    })
    const summary = await scheduler(client).sweep()
    expect(summary?.accounts[0]?.travelCredit).toBe(30)
    const claimAt = calls.findIndex(c => c.includes('/travel/claim'))
    const departAt = calls.findIndex(c => c.includes('/travel/depart'))
    expect(claimAt).toBeGreaterThanOrEqual(0)
    if (departAt >= 0) expect(claimAt).toBeLessThan(departAt)
  })

  it('departs when idle', async () => {
    const { client, calls } = routed({
      '/activity/growth/buddy/info': () => ({ code: 0, data: { buddy: { instance_id: 7, name: 'P' } } }),
      '/activity/growth/buddy/travel/status': () => ({ code: 0, data: { state: 'idle', daily_limit_reached: false } }),
    })
    await scheduler(client).sweep()
    expect(calls.some(c => c.includes('/travel/depart'))).toBe(true)
  })

  it('does not depart when the daily limit is reached', async () => {
    const { client, calls } = routed({
      '/activity/growth/buddy/info': () => ({ code: 0, data: { buddy: { instance_id: 7, name: 'P' } } }),
      '/activity/growth/buddy/travel/status': () => ({ code: 0, data: { state: 'idle', daily_limit_reached: true } }),
    })
    await scheduler(client).sweep()
    expect(calls.some(c => c.includes('/travel/depart'))).toBe(false)
  })

  it('keeps the task results when a LATER step fails', async () => {
    // The isolation that matters: the campaigns are separate, so one breaking
    // must not cost the user the rewards the others already collected.
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/activity/growth/streak')) return new Response(JSON.stringify({ code: 500, msg: 'streak down' }), { status: 200 })
      if (u.includes('/claim')) return new Response(JSON.stringify({ code: 0, data: { credit: 100, energy: 5 } }), { status: 200 })
      if (u.includes('/accept')) return new Response(JSON.stringify({ code: 0 }), { status: 200 })
      return new Response(JSON.stringify({ code: 0, data: { tasks: [
        { task_code: 'a', title: 'A', reward_credit: 100, reward_energy: 5, accept_status: 'accepted', locked: false, has_reward: true, progress: 1 },
      ] } }), { status: 200 })
    }) as unknown as typeof fetch
    const summary = await scheduler(new WorkBuddyGrowthClient(fetchImpl)).sweep()
    expect(summary?.credit).toBe(100)
    expect(summary?.accounts[0]?.failures.some(f => f.includes('streak'))).toBe(true)
  })
})
