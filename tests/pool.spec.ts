import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cooldownMsFor,
  isAccountScoped,
  poolAccountPath,
  poolStatePath,
  WorkBuddyAccountPool,
} from '../src/pool.ts'

describe('isAccountScoped', () => {
  it('is true only for failures another account could avoid', () => {
    // These are per-ACCOUNT conditions.
    expect(isAccountScoped('soft_rate')).toBe(true)
    expect(isAccountScoped('hard_credit')).toBe(true)
    expect(isAccountScoped('session_dead')).toBe(true)
  })

  it('is false for failures of the request or the service', () => {
    // Walking the pool on these multiplies one failure by the pool size and
    // delays the error the user needs to see.
    expect(isAccountScoped('server')).toBe(false)
    expect(isAccountScoped('client')).toBe(false)
    expect(isAccountScoped('not_found')).toBe(false)
    expect(isAccountScoped('activation_required')).toBe(false)
  })
})

describe('cooldownMsFor', () => {
  it('starts short for a first rate limit', () => {
    // Parking a healthy account for an hour over one 429 turns a brief throttle
    // into an outage.
    expect(cooldownMsFor('soft_rate', 1)).toBe(60_000)
  })

  it('backs off exponentially for repeat offenders', () => {
    expect(cooldownMsFor('soft_rate', 2)).toBe(120_000)
    expect(cooldownMsFor('soft_rate', 3)).toBe(240_000)
  })

  it('has a ceiling, so a parked account is still retried', () => {
    expect(cooldownMsFor('soft_rate', 50)).toBe(30 * 60_000)
  })

  it('parks an exhausted account for a day', () => {
    expect(cooldownMsFor('hard_credit', 1)).toBe(24 * 60 * 60_000)
  })

  it('parks a dead session indefinitely', () => {
    // It cannot recover on its own; the card asks for a sign-in.
    expect(cooldownMsFor('session_dead', 1)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('pool paths', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pool-paths-'))
    previous = process.env['DSH_WORKBUDDY_DATA_DIR']
    process.env['DSH_WORKBUDDY_DATA_DIR'] = dir
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env['DSH_WORKBUDDY_DATA_DIR']
    else process.env['DSH_WORKBUDDY_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  })

  it('keeps the FIRST account at the historical path', () => {
    // An upgrade must not look like a sign-out.
    expect(poolAccountPath('.workbuddy-auth.json', 0)).toBe(join(dir, '.workbuddy-auth.json'))
  })

  it('gives added accounts distinct paths beside it', () => {
    const second = poolAccountPath('.workbuddy-auth.json', 1)
    expect(second).not.toBe(join(dir, '.workbuddy-auth.json'))
    expect(second).toContain('workbuddy-auth-a2')
    expect(poolAccountPath('.workbuddy-auth.json', 2)).not.toBe(second)
  })

  it('handles a filename with no extension', () => {
    expect(poolAccountPath('creds', 1)).toContain('creds-a2')
  })
})

describe('WorkBuddyAccountPool', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pool-'))
    previous = process.env['DSH_WORKBUDDY_DATA_DIR']
    process.env['DSH_WORKBUDDY_DATA_DIR'] = dir
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env['DSH_WORKBUDDY_DATA_DIR']
    else process.env['DSH_WORKBUDDY_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  })

  function account(id: string, label = id, path = '/x/' + id) {
    return { id, label, path }
  }

  it('starts empty', async () => {
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    expect(pool.all()).toEqual([])
    expect(pool.active()).toBeUndefined()
  })

  it('makes the first added account active', async () => {
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    pool.upsert(account('a'))
    pool.upsert(account('b'))
    expect(pool.active()?.id).toBe('a')
  })

  it('lists available accounts with the active one first', async () => {
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    pool.upsert(account('a'))
    pool.upsert(account('b'))
    pool.upsert(account('c'))
    pool.setActive('c')
    expect(pool.available(Date.now()).map(r => r.id)).toEqual(['c', 'a', 'b'])
  })

  it('drops a cooled account from the available set', async () => {
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    pool.upsert(account('a'))
    pool.upsert(account('b'))
    const now = Date.now()
    pool.report('a', 'soft_rate', now)
    expect(pool.available(now).map(r => r.id)).toEqual(['b'])
  })

  it('returns a cooled account once its cooldown lapses', async () => {
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    pool.upsert(account('a'))
    const now = Date.now()
    pool.report('a', 'soft_rate', now)
    expect(pool.available(now + 60_001).map(r => r.id)).toEqual(['a'])
  })

  it('lengthens the cooldown for an account that keeps failing', async () => {
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    pool.upsert(account('a'))
    const now = Date.now()
    pool.report('a', 'soft_rate', now)
    const first = pool.all()[0]!.cooldownUntilMs
    pool.report('a', 'soft_rate', now)
    const second = pool.all()[0]!.cooldownUntilMs
    expect(second - now).toBeGreaterThan(first - now)
  })

  it('RESETS the streak on success, so the next throttle is short again', async () => {
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    pool.upsert(account('a'))
    const now = Date.now()
    pool.report('a', 'soft_rate', now)
    pool.report('a', 'soft_rate', now)
    expect(pool.all()[0]!.rateLimitHits).toBe(2)
    pool.report('a', 'ok', now)
    expect(pool.all()[0]!.rateLimitHits).toBe(0)
    expect(pool.all()[0]!.cooldownUntilMs).toBe(0)
    expect(pool.all()[0]!.lastSuccessAtMs).toBe(now)
  })

  it('parks an account whose session died, and asks for a sign-in', async () => {
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    pool.upsert(account('a'))
    pool.upsert(account('b'))
    const now = Date.now()
    pool.report('a', 'session_dead', now)
    expect(pool.all()[0]!.needsSignIn).toBe(true)
    // Excluded forever, not merely cooled.
    expect(pool.available(now + 365 * 24 * 60 * 60_000).map(r => r.id)).toEqual(['b'])
  })

  it('a successful sign-in clears the parked flag', async () => {
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    pool.upsert(account('a'))
    pool.report('a', 'session_dead', Date.now())
    pool.report('a', 'ok', Date.now())
    expect(pool.all()[0]!.needsSignIn).toBeUndefined()
  })

  it('does NOT cool an account for a failure every account would hit', async () => {
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    pool.upsert(account('a'))
    pool.upsert(account('b'))
    const now = Date.now()
    pool.report('a', 'server', now)
    // Both stay available: the failure was the service's, not this account's.
    expect(pool.available(now).map(r => r.id)).toEqual(['a', 'b'])
  })

  it('preserves cooldown state when discovery re-adds an account', async () => {
    // Discovery runs on every catalog refresh; letting it clear a cooldown
    // would put a throttled account straight back into rotation.
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    pool.upsert(account('a'))
    const now = Date.now()
    pool.report('a', 'soft_rate', now)
    pool.upsert(account('a', 'renamed'))
    expect(pool.available(now)).toEqual([])
    expect(pool.all()[0]!.label).toBe('renamed')
  })

  it('moves the active pointer when the active account is removed', async () => {
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    pool.upsert(account('a'))
    pool.upsert(account('b'))
    pool.remove('a')
    expect(pool.active()?.id).toBe('b')
  })

  it('ignores a setActive for an unknown account', async () => {
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    pool.upsert(account('a'))
    pool.setActive('nope')
    expect(pool.active()?.id).toBe('a')
  })

  it('survives a restart with its cooldowns intact', async () => {
    const first = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await first.load()
    first.upsert(account('a', 'Alice'))
    first.upsert(account('b', 'Bob'))
    const now = Date.now()
    first.report('a', 'soft_rate', now)
    first.setActive('b')
    await first.flush()

    const second = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await second.load()
    expect(second.all().map(r => r.label)).toEqual(['Alice', 'Bob'])
    expect(second.active()?.id).toBe('b')
    expect(second.all()[0]!.rateLimitHits).toBe(1)
    expect(second.available(now).map(r => r.id)).toEqual(['b'])
  })

  it('treats a corrupt pool file as empty rather than throwing', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(poolStatePath('.workbuddy-auth.json'), '{ not json', 'utf8')
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    expect(pool.all()).toEqual([])
  })

  it('refuses a future format version instead of misreading it', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(poolStatePath('.workbuddy-auth.json'), JSON.stringify({
      version: 99,
      accounts: [{ id: 'a', label: 'A', path: '/x' }],
    }), 'utf8')
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    expect(pool.all()).toEqual([])
  })

  it('skips malformed rows in an otherwise valid file', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(poolStatePath('.workbuddy-auth.json'), JSON.stringify({
      version: 1,
      accounts: [
        { id: 'good', label: 'Good', path: '/x' },
        { id: '', label: 'No id', path: '/y' },
        { id: 'no-path', label: 'No path' },
        null,
      ],
    }), 'utf8')
    const pool = new WorkBuddyAccountPool('.workbuddy-auth.json')
    await pool.load()
    expect(pool.all().map(r => r.id)).toEqual(['good'])
  })
})
