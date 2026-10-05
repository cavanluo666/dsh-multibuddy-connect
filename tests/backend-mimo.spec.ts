import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMiMoBackend,
  MIMO_DESCRIPTOR,
  parseMiMoQuota,
  parseOwnMiMoCredential,
  credentialFromCookies,
} from '../src/backends/mimo.ts'

describe('MiMo descriptor', () => {
  it('declares itself a single-account desktop backend that reports quota', () => {
    expect(MIMO_DESCRIPTOR.id).toBe('mimo')
    expect(MIMO_DESCRIPTOR.authKind).toBe('desktop-adoption')
    // The Xiaomi desktop app holds one passport slot; pretending otherwise
    // would offer an "add account" control with nothing to write to.
    expect(MIMO_DESCRIPTOR.multiAccount).toBe(false)
    expect(MIMO_DESCRIPTOR.reportsQuota).toBe(true)
  })
})

describe('parseOwnMiMoCredential', () => {
  it('accepts a document carrying all three cookies', () => {
    const parsed = parseOwnMiMoCredential(JSON.stringify({
      passToken: 'pt', cUserId: 'cu', userId: 'u',
    }))
    expect(parsed?.passToken).toBe('pt')
    expect(parsed?.source).toBe('plugin')
  })

  it('rejects a document without a pass token', () => {
    // The other two cookies cannot mint a session alone, so a credential
    // missing passToken would create an account that fails every request.
    expect(parseOwnMiMoCredential(JSON.stringify({ cUserId: 'cu', userId: 'u' }))).toBeUndefined()
  })

  it('rejects malformed JSON and non-objects', () => {
    expect(parseOwnMiMoCredential('{ nope')).toBeUndefined()
    expect(parseOwnMiMoCredential('[]')).toBeUndefined()
    expect(parseOwnMiMoCredential('null')).toBeUndefined()
  })
})

describe('credentialFromCookies', () => {
  it('prefers the account.xiaomi.com rows', () => {
    const credential = credentialFromCookies([
      { host: 'other.xiaomi.com', name: 'passToken', value: 'wrong' },
      { host: 'account.xiaomi.com', name: 'passToken', value: 'right' },
      { host: 'account.xiaomi.com', name: 'cUserId', value: 'cu' },
      { host: 'account.xiaomi.com', name: 'userId', value: 'u' },
    ])
    expect(credential?.passToken).toBe('right')
    expect(credential?.source).toBe('desktop')
  })

  it('returns undefined when no pass token is present', () => {
    expect(credentialFromCookies([{ host: 'a', name: 'analytics', value: 'x' }])).toBeUndefined()
  })

  it('returns undefined for an empty jar', () => {
    expect(credentialFromCookies([])).toBeUndefined()
  })
})

describe('parseMiMoQuota', () => {
  it('reads percent as REMAINING, not used', () => {
    // Inverting these two would flip the entire dashboard, so the direction is
    // pinned by a test rather than left to a comment.
    expect(parseMiMoQuota({ data: { percent: 99.8 } })?.remainPercent).toBe(99.8)
  })

  it('accepts a bare object without the envelope', () => {
    expect(parseMiMoQuota({ percent: 42 })?.remainPercent).toBe(42)
  })

  it('clamps out-of-range values', () => {
    expect(parseMiMoQuota({ percent: 150 })?.remainPercent).toBe(100)
    expect(parseMiMoQuota({ percent: -5 })?.remainPercent).toBe(0)
  })

  it('converts a numeric resetAt from seconds to an ISO instant', () => {
    const quota = parseMiMoQuota({ percent: 50, resetAt: 1_800_000_000 })
    expect(quota?.resetAt).toBe(new Date(1_800_000_000 * 1000).toISOString())
  })

  it('accepts a string resetDate verbatim', () => {
    expect(parseMiMoQuota({ percent: 50, resetDate: '2026-04-01' })?.resetAt).toBe('2026-04-01')
  })

  it('returns undefined without a usable percent', () => {
    expect(parseMiMoQuota({})).toBeUndefined()
    expect(parseMiMoQuota({ percent: 'lots' })).toBeUndefined()
    expect(parseMiMoQuota(null)).toBeUndefined()
  })
})

describe('MiMo backend states', () => {
  let dir: string
  let previousAuth: string | undefined
  let previousDir: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mimo-'))
    previousAuth = process.env['MIMO_AUTH_FILE']
    previousDir = process.env['DSH_WORKBUDDY_DATA_DIR']
    process.env['DSH_WORKBUDDY_DATA_DIR'] = dir
    // Point both the plugin credential and the desktop cookie DB at paths that
    // do not exist, so discovery finds nothing at all.
    process.env['MIMO_AUTH_FILE'] = join(dir, 'absent-auth.json')
    process.env['MIMO_COOKIE_DB'] = join(dir, 'absent-cookies')
  })

  afterEach(async () => {
    for (const [key, value] of [['MIMO_AUTH_FILE', previousAuth], ['DSH_WORKBUDDY_DATA_DIR', previousDir]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    delete process.env['MIMO_COOKIE_DB']
    await rm(dir, { recursive: true, force: true })
  })

  it('reports unavailable with an actionable hint when MiMo is absent entirely', async () => {
    const state = await createMiMoBackend().resolveAccounts()
    expect(state.state).toBe('unavailable')
    if (state.state !== 'unavailable') throw new Error('unreachable')
    expect(state.hint.length).toBeGreaterThan(0)
  })

  it('reports ready with one account when the plugin credential file is valid', async () => {
    const path = join(dir, 'auth.json')
    await writeFile(path, JSON.stringify({ passToken: 'pt', cUserId: 'cu', userId: 'u' }), 'utf8')
    process.env['MIMO_AUTH_FILE'] = path
    const state = await createMiMoBackend().resolveAccounts()
    expect(state.state).toBe('ready')
    if (state.state !== 'ready') throw new Error('unreachable')
    expect(state.accounts).toHaveLength(1)
    expect(state.accounts[0]!.usable).toBe(true)
  })

  it('reports signed-out — not unavailable — when the credential file exists but is unusable', async () => {
    const path = join(dir, 'auth.json')
    await writeFile(path, JSON.stringify({ cUserId: 'cu' }), 'utf8')
    process.env['MIMO_AUTH_FILE'] = path
    // A broken credential is recoverable by signing in again, so it must not be
    // reported as a missing prerequisite.
    expect((await createMiMoBackend().resolveAccounts()).state).toBe('signed-out')
  })
})
