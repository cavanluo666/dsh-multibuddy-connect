import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFailover, type AttemptOutcome } from '../src/pool-failover.ts'
import { WorkBuddyAccountPool } from '../src/pool.ts'

describe('withFailover', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'failover-'))
    previous = process.env['DSH_WORKBUDDY_DATA_DIR']
    process.env['DSH_WORKBUDDY_DATA_DIR'] = dir
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env['DSH_WORKBUDDY_DATA_DIR']
    else process.env['DSH_WORKBUDDY_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  })

  async function poolOf(...ids: string[]): Promise<WorkBuddyAccountPool> {
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    for (const id of ids) pool.upsert({ id, label: id, path: '/x/' + id })
    return pool
  }

  const ok = <T>(value: T): AttemptOutcome<T> => ({ ok: true, value })

  it('returns the first success without trying the rest', async () => {
    const pool = await poolOf('a', 'b', 'c')
    const seen: string[] = []
    const result = await withFailover({
      pool,
      attempt: async record => { seen.push(record.id); return ok(record.id) },
    })
    expect(result.value).toBe('a')
    expect(seen).toEqual(['a'])
  })

  it('moves to the next account when one is throttled', async () => {
    // The whole point: one account rate-limited, the next one serves.
    const pool = await poolOf('a', 'b')
    const seen: string[] = []
    const result = await withFailover({
      pool,
      attempt: async record => {
        seen.push(record.id)
        if (record.id === 'a') return { ok: false, kind: 'soft_rate', message: 'slow down', status: 429 }
        return ok('served-by-b')
      },
    })
    expect(result.value).toBe('served-by-b')
    expect(seen).toEqual(['a', 'b'])
    expect(result.tried).toEqual(['a', 'b'])
  })

  it('cools the throttled account so the NEXT request skips it', async () => {
    const pool = await poolOf('a', 'b')
    const first: string[] = []
    await withFailover({
      pool,
      attempt: async record => {
        first.push(record.id)
        if (record.id === 'a') return { ok: false, kind: 'soft_rate', message: 'x', status: 429 }
        return ok(1)
      },
    })
    expect(first).toEqual(['a', 'b'])
    const second: string[] = []
    await withFailover({
      pool,
      attempt: async record => { second.push(record.id); return ok(2) },
    })
    // 'a' is cooling, so only 'b' is tried.
    expect(second).toEqual(['b'])
  })

  it('tries each account AT MOST ONCE', async () => {
    const pool = await poolOf('a', 'b')
    const seen: string[] = []
    await withFailover({
      pool,
      attempt: async record => { seen.push(record.id); return { ok: false, kind: 'soft_rate', message: 'x', status: 429 } },
    })
    expect(seen).toEqual(['a', 'b'])
  })

  it('STOPS at the first non-account failure', async () => {
    // A 500 is the service's problem; walking the pool would repeat it N times.
    const pool = await poolOf('a', 'b', 'c')
    const seen: string[] = []
    const result = await withFailover({
      pool,
      attempt: async record => { seen.push(record.id); return { ok: false, kind: 'server', message: 'boom', status: 500 } },
    })
    expect(seen).toEqual(['a'])
    expect(result.failure?.kind).toBe('server')
  })

  it('reports the last failure when every account is throttled', async () => {
    const pool = await poolOf('a', 'b')
    const result = await withFailover({
      pool,
      attempt: async record => ({ ok: false, kind: 'soft_rate', message: 'rate ' + record.id, status: 429 }),
    })
    expect(result.value).toBeUndefined()
    expect(result.tried).toEqual(['a', 'b'])
    expect(result.failure?.message).toBe('rate b')
    expect(result.failure?.accountId).toBe('b')
  })

  it('returns no failure when there was nothing to try', async () => {
    const pool = await poolOf()
    const result = await withFailover({ pool, attempt: async () => ok(1) })
    expect(result.tried).toEqual([])
    expect(result.failure).toBeUndefined()
  })

  it('skips an account that needs a fresh sign-in', async () => {
    const pool = await poolOf('a', 'b')
    pool.report('a', 'session_dead', Date.now())
    const seen: string[] = []
    await withFailover({ pool, attempt: async record => { seen.push(record.id); return ok(1) } })
    expect(seen).toEqual(['b'])
  })

  it('advances past an account that is out of credit', async () => {
    const pool = await poolOf('a', 'b')
    const seen: string[] = []
    const result = await withFailover({
      pool,
      attempt: async record => {
        seen.push(record.id)
        if (record.id === 'a') return { ok: false, kind: 'hard_credit', message: 'no credit', status: 402 }
        return ok('b')
      },
    })
    expect(seen).toEqual(['a', 'b'])
    expect(result.value).toBe('b')
  })

  it('lets a thrown error propagate rather than treating it as an account fault', async () => {
    // A caller that throws is describing a local or programmer fault, not an
    // account condition the pool could route around.
    const pool = await poolOf('a', 'b')
    await expect(withFailover({
      pool,
      attempt: async () => { throw new Error('local fault') },
    })).rejects.toThrow('local fault')
  })

  it('survives a throwing diagnostic hook', async () => {
    const pool = await poolOf('a')
    const result = await withFailover({
      pool,
      attempt: async () => ok('fine'),
      onAttempt: () => { throw new Error('hook blew up') },
    })
    expect(result.value).toBe('fine')
  })

  it('uses an injected clock', async () => {
    const pool = await poolOf('a', 'b')
    let fake = 1_000_000
    await withFailover({
      pool,
      now: () => fake,
      attempt: async record => record.id === 'a'
        ? { ok: false, kind: 'soft_rate', message: 'x', status: 429 }
        : ok(1),
    })
    const cooled = pool.all()[0]!.cooldownUntilMs
    expect(cooled).toBe(fake + 60_000)
  })
})
