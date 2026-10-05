import { describe, expect, it } from 'vitest'
import {
  CODEBUDDY_DESCRIPTOR,
  createCodeBuddyBackend,
  isExpired,
  maskId,
  parseCodeBuddyAuth,
  parseCodeBuddyModels,
} from '../src/backends/codebuddy.ts'

describe('CodeBuddy descriptor', () => {
  it('declares a single-account desktop backend with no balance endpoint', () => {
    expect(CODEBUDDY_DESCRIPTOR.id).toBe('codebuddy')
    expect(CODEBUDDY_DESCRIPTOR.authKind).toBe('desktop-adoption')
    // The desktop client holds one login slot.
    expect(CODEBUDDY_DESCRIPTOR.multiAccount).toBe(false)
    // A finding, not a default: the original implementation has exactly two
    // endpoints — chat completions and a token refresh — and quota surfaces
    // only as a mid-request error code. There is no balance to read.
    expect(CODEBUDDY_DESCRIPTOR.reportsQuota).toBe(false)
  })
})

describe('parseCodeBuddyAuth', () => {
  const valid = JSON.stringify({
    auth: { accessToken: 'tok-1', expiresAt: 1_800_000_000_000, domain: 'copilot.tencent.com' },
    account: { uid: 'u-1', nickname: 'Alice' },
  })

  it('reads a well-formed credential', () => {
    const credential = parseCodeBuddyAuth(valid)
    expect(credential?.accessToken).toBe('tok-1')
    expect(credential?.expiresAt).toBe(1_800_000_000_000)
  })

  it('tolerates a leading BOM', () => {
    // Some desktop builds write with a BOM; JSON.parse rejects it, and the
    // account would silently vanish rather than fail loudly.
    expect(parseCodeBuddyAuth('\uFEFF' + valid)?.accessToken).toBe('tok-1')
  })

  it('rejects a document with no access token', () => {
    expect(parseCodeBuddyAuth(JSON.stringify({ auth: { expiresAt: 1 } }))).toBeUndefined()
    expect(parseCodeBuddyAuth(JSON.stringify({ auth: {} }))).toBeUndefined()
  })

  it('rejects an empty or malformed token', () => {
    expect(parseCodeBuddyAuth(JSON.stringify({ auth: { accessToken: '   ' } }))).toBeUndefined()
  })

  it('rejects malformed JSON and non-objects', () => {
    expect(parseCodeBuddyAuth('{ nope')).toBeUndefined()
    expect(parseCodeBuddyAuth('[]')).toBeUndefined()
    expect(parseCodeBuddyAuth('null')).toBeUndefined()
  })

  it('carries a missing expiry as zero, meaning unknown', () => {
    const credential = parseCodeBuddyAuth(JSON.stringify({ auth: { accessToken: 't' } }))
    expect(credential?.expiresAt).toBe(0)
  })
})

describe('isExpired', () => {
  const now = 1_800_000_000_000

  it('treats an UNSTATED expiry as unknown, not as expired', () => {
    // Reporting a token with no expiry as spent would lock out a working
    // account, which is worse than trying and failing once.
    expect(isExpired({ accessToken: 't', expiresAt: 0 } as never, now)).toBe(false)
  })

  it('reports a passed expiry as expired', () => {
    expect(isExpired({ accessToken: 't', expiresAt: now - 1000 } as never, now)).toBe(true)
  })

  it('reports an expiry that is about to pass as expired', () => {
    // The margin exists so a request is not sent with a token that expires
    // mid-flight.
    expect(isExpired({ accessToken: 't', expiresAt: now + 1000 } as never, now)).toBe(true)
  })

  it('reports a comfortably future expiry as live', () => {
    expect(isExpired({ accessToken: 't', expiresAt: now + 3_600_000 } as never, now)).toBe(false)
  })
})

describe('maskId', () => {
  it('keeps a short prefix and suffix so a row can be matched by eye', () => {
    const masked = maskId('abcdefghijklmnop')
    expect(masked).toContain('abc')
    expect(masked).toContain('nop')
    expect(masked).not.toBe('abcdefghijklmnop')
  })

  it('masks a short id entirely', () => {
    expect(maskId('abc')).not.toContain('abc')
  })
})

describe('parseCodeBuddyModels', () => {
  it('returns undefined for an unrecognised manifest shape', () => {
    // undefined (not []) is what lets the caller keep the built-in fallback.
    expect(parseCodeBuddyModels(null)).toBeUndefined()
    expect(parseCodeBuddyModels({})).toBeUndefined()
  })
})

describe('CodeBuddy backend states', () => {
  it('resolves to a reportable state without throwing', async () => {
    const state = await createCodeBuddyBackend().current()
    expect(['ready', 'signed-out', 'unavailable', 'failed']).toContain(state.state)
  })

  it('declines to report a balance rather than inventing one', async () => {
    expect((await createCodeBuddyBackend().readQuota('whatever')).kind).toBe('unavailable')
  })
})
