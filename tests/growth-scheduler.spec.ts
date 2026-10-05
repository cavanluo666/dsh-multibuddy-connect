import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrowthScheduler, growthLedgerPath, type GrowthTarget } from '../src/growth-scheduler.ts'
import { WorkBuddyGrowthClient } from '../src/growth.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'tok', refreshToken: 'ref', expiresAtMs: Date.now() + 3_600_000,
  domain: 'www.codebuddy.cn', uid: 'u-1', source: 'login',
}

/** A task board with one claimable and one unenrolled task. */
const BOARD = { code: 0, data: { tasks: [
  { task_code: 'a', title: 'A', reward_credit: 300, reward_energy: 5, accept_status: 'not_accepted', locked: false, has_reward: true, progress: null },
  { task_code: 'b', title: 'B', reward_credit: 100, reward_energy: 5, accept_status: 'accepted', locked: false, has_reward: true, progress: 1 },
] } }

/** A scripted client that records every call. */
function scriptedClient(handler: (url: string, init: RequestInit | undefined) => unknown): { client: WorkBuddyGrowthClient; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push(String(url))
    return new Response(JSON.stringify(handler(String(url), init)), { status: 200 })
  }) as unknown as typeof fetch
  return { client: new WorkBuddyGrowthClient(fetchImpl), calls }
}

describe('GrowthScheduler', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'growth-'))
    previous = process.env['DSH_WORKBUDDY_DATA_DIR']
    process.env['DSH_WORKBUDDY_DATA_DIR'] = dir
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env['DSH_WORKBUDDY_DATA_DIR']
    else process.env['DSH_WORKBUDDY_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  })

  function target(id = 'u-1', label = 'Alice'): GrowthTarget {
    return { id, label, credential: async () => CREDENTIAL }
  }

  function scheduler(options: { enabled?: boolean; client?: WorkBuddyGrowthClient; targets?: GrowthTarget[]; now?: () => number } = {}) {
    const s = new GrowthScheduler({
      targets: () => options.targets ?? [target()],
      isEnabled: () => options.enabled !== false,
      ...(options.client === undefined ? {} : { client: options.client }),
      ...(options.now === undefined ? {} : { now: options.now }),
      sleep: async () => {},
    })
    return s
  }

  it('does NOTHING when automation is off', async () => {
    // The property that protects a user with other work on this plugin: off
    // means zero upstream calls, not merely zero claims.
    const { client, calls } = scriptedClient(() => BOARD)
    const s = scheduler({ enabled: false, client })
    expect(await s.sweep()).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('still runs when a user asks, even with automation off', async () => {
    const { client } = scriptedClient(url => url.includes('/accept') ? { code: 0, data: { results: [] } } : url.includes('/claim') ? { code: 0, data: { credit: 100, energy: 5 } } : BOARD)
    const s = scheduler({ enabled: false, client })
    const summary = await s.sweep(true)
    expect(summary).toBeDefined()
    expect(summary?.manual).toBe(true)
  })

  it('enrols unenrolled tasks and claims the claimable one', async () => {
    const { client, calls } = scriptedClient(url =>
      // The accept verdict rides INSIDE the envelope; a board with no results
      // means the upstream enrolled nothing.
      url.includes('/accept') ? { code: 0, data: { results: [{ task_code: 'a', status: 'ok' }] } }
      : url.includes('/claim') ? { code: 0, data: { credit: 100, energy: 5 } }
      : BOARD)
    const s = scheduler({ client })
    const summary = await s.sweep()
    expect(summary?.accounts[0]?.accepted).toBe(1)
    expect(summary?.credit).toBe(100)
    expect(calls.some(u => u.includes('/tasks/accept'))).toBe(true)
    expect(calls.some(u => u.includes('/claim'))).toBe(true)
  })

  it('runs an account ONCE a day, then leaves it alone', async () => {
    const { client, calls } = scriptedClient(url => url.includes('/accept') ? { code: 0, data: { results: [] } } : url.includes('/claim') ? { code: 0, data: {} } : BOARD)
    const s = scheduler({ client })
    await s.sweep()
    const afterFirst = calls.length
    expect(s.alreadyRanToday('u-1')).toBe(true)
    expect(await s.sweep()).toBeUndefined()
    expect(calls.length).toBe(afterFirst)
  })

  it('runs again on a NEW day', async () => {
    const { client } = scriptedClient(url => url.includes('/accept') ? { code: 0, data: { results: [] } } : url.includes('/claim') ? { code: 0, data: {} } : BOARD)
    let now = new Date(2026, 2, 4, 10, 0).getTime()
    const s = scheduler({ client, now: () => now })
    await s.sweep()
    expect(s.alreadyRanToday('u-1')).toBe(true)
    now = new Date(2026, 2, 5, 10, 0).getTime()
    expect(s.alreadyRanToday('u-1')).toBe(false)
    expect(await s.sweep()).toBeDefined()
  })

  it('a machine off for a week runs ONCE, not seven times', async () => {
    // The ledger records the day, not a counter.
    const { client } = scriptedClient(url => url.includes('/accept') ? { code: 0, data: { results: [] } } : url.includes('/claim') ? { code: 0, data: {} } : BOARD)
    let now = new Date(2026, 2, 4, 10, 0).getTime()
    const s = scheduler({ client, now: () => now })
    await s.sweep()
    now = new Date(2026, 2, 11, 10, 0).getTime()
    await s.sweep()
    expect(s.alreadyRanToday('u-1')).toBe(true)
    expect(await s.sweep()).toBeUndefined()
  })

  it('SURVIVES a network failure without throwing', async () => {
    // It runs on a timer beside a live server; a throw would be an unhandled
    // rejection, and this module must never be able to disturb the plugin.
    const fetchImpl = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    const s = scheduler({ client: new WorkBuddyGrowthClient(fetchImpl) })
    const summary = await s.sweep()
    expect(summary?.accounts[0]?.error).toBe('offline')
    expect(summary?.credit).toBe(0)
  })

  it('keeps going when ONE account fails', async () => {
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      if (call === 1) throw new Error('first account down')
      return new Response(JSON.stringify({ code: 0, data: { tasks: [] } }), { status: 200 })
    }) as unknown as typeof fetch
    const s = scheduler({
      client: new WorkBuddyGrowthClient(fetchImpl),
      targets: [target('a', 'A'), target('b', 'B')],
    })
    const summary = await s.sweep()
    expect(summary?.accounts).toHaveLength(2)
    expect(summary?.accounts[0]?.error).toBe('first account down')
    expect(summary?.accounts[1]?.error).toBeUndefined()
  })

  it("records a credential failure as that account's error", async () => {
    const { client } = scriptedClient(() => BOARD)
    const s = scheduler({ client, targets: [{ id: 'x', label: 'X', credential: async () => { throw new Error('no credential') } }] })
    const summary = await s.sweep()
    expect(summary?.accounts[0]?.error).toBe('no credential')
  })

  it('does not start a second pass while one is running', async () => {
    const { client } = scriptedClient(url => url.includes('/accept') ? { code: 0, data: { results: [] } } : url.includes('/claim') ? { code: 0, data: {} } : BOARD)
    const s = scheduler({ client })
    const first = s.sweep()
    const second = await s.sweep()
    expect(second).toBeUndefined()
    await first
  })

  it('persists the day so a restart does not re-run', async () => {
    const { client } = scriptedClient(url => url.includes('/accept') ? { code: 0, data: { results: [] } } : url.includes('/claim') ? { code: 0, data: {} } : BOARD)
    const now = new Date(2026, 2, 4, 10, 0).getTime()
    await scheduler({ client, now: () => now }).sweep()

    const fresh = scheduler({ client, now: () => now })
    expect(await fresh.sweep()).toBeUndefined()
  })

  it('treats a corrupt ledger as an empty one', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(growthLedgerPath(), '{ not json', 'utf8')
    const { client } = scriptedClient(url => url.includes('/accept') ? { code: 0, data: { results: [] } } : url.includes('/claim') ? { code: 0, data: {} } : BOARD)
    const s = scheduler({ client })
    expect(await s.sweep()).toBeDefined()
  })

  it('reports failures from a partial claim pass', async () => {
    // TWO claimable tasks, so the pass has one failure and one success to keep
    // apart — with a single task there is no partial pass to observe.
    const TWO_CLAIMABLE = { code: 0, data: { tasks: [
      { task_code: 'a', title: 'A', reward_credit: 50, reward_energy: 1, accept_status: 'accepted', locked: false, has_reward: true, progress: 1 },
      { task_code: 'b', title: 'B', reward_credit: 50, reward_energy: 1, accept_status: 'accepted', locked: false, has_reward: true, progress: 1 },
    ] } }
    let n = 0
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/accept')) return new Response(JSON.stringify({ code: 0, data: { results: [] } }), { status: 200 })
      if (u.includes('/claim')) { n += 1; return new Response(JSON.stringify(n === 1 ? { code: 9, msg: 'nope' } : { code: 0, data: { credit: 50 } }), { status: 200 }) }
      return new Response(JSON.stringify(TWO_CLAIMABLE), { status: 200 })
    }) as unknown as typeof fetch
    const s = scheduler({ client: new WorkBuddyGrowthClient(fetchImpl) })
    const summary = await s.sweep()
    expect(summary?.accounts[0]?.failures.length).toBeGreaterThan(0)
    expect(summary?.credit).toBe(50)
  })
})
