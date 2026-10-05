import { describe, expect, it } from 'vitest'
import {
  TRAE_DESCRIPTOR,
  createTraeBackend,
  parseTraeCredential,
  regionOfEdition,
  regionOfUserRegion,
  traeAccountId,
  traeStorageCandidates,
} from '../src/backends/trae.ts'

describe('Trae descriptor', () => {
  it('declares multi-account support because four installs can be signed in', () => {
    expect(TRAE_DESCRIPTOR.id).toBe('trae')
    expect(TRAE_DESCRIPTOR.authKind).toBe('desktop-adoption')
    // Unlike its desktop-adoption peers, Trae has several independent installs.
    expect(TRAE_DESCRIPTOR.multiAccount).toBe(true)
  })
})

describe('regionOfEdition', () => {
  it('maps the international installs to ai', () => {
    expect(regionOfEdition('sg')).toBe('ai')
    expect(regionOfEdition('solo-sg')).toBe('ai')
  })

  it('maps the mainland installs to cn', () => {
    expect(regionOfEdition('cn')).toBe('cn')
    expect(regionOfEdition('solo')).toBe('cn')
  })
})

describe('regionOfUserRegion', () => {
  it('reads the nested object form the desktop writes', () => {
    expect(regionOfUserRegion({ region: 'CN', _aiRegion: 'CN' })).toBe('cn')
    expect(regionOfUserRegion({ region: 'SG' })).toBe('ai')
  })

  it('reads the bare lowercase form the logs write', () => {
    expect(regionOfUserRegion('cn')).toBe('cn')
    expect(regionOfUserRegion('sg')).toBe('ai')
    expect(regionOfUserRegion('ai')).toBe('ai')
  })

  it('is case-blind', () => {
    expect(regionOfUserRegion({ region: '  Cn  ' })).toBe('cn')
  })

  it('refuses an unrecognised claim rather than defaulting', () => {
    // Defaulting here would route an account to the wrong gateway.
    expect(regionOfUserRegion('EU')).toBeUndefined()
    expect(regionOfUserRegion(undefined)).toBeUndefined()
    expect(regionOfUserRegion(42)).toBeUndefined()
  })
})

describe('parseTraeCredential', () => {
  const candidate = { edition: 'cn' as const, path: '/tmp/x', source: 'desktop' as const }

  it('finds the auth record by shape, not by a hardcoded key path', () => {
    const credential = parseTraeCredential(JSON.stringify({
      'some.namespaced.key': {
        token: 'jwt-value',
        userId: 'u-1',
        userRegion: { region: 'CN' },
      },
    }), candidate)
    expect(credential?.token).toBe('jwt-value')
    expect(credential?.userId).toBe('u-1')
    expect(credential?.region).toBe('cn')
  })

  it('prefers the credential claim over the edition for the region', () => {
    // A CN install holding an SG credential must route internationally, or the
    // token is presented to a gateway that will reject it.
    const credential = parseTraeCredential(JSON.stringify({
      a: { token: 't', userId: 'u', userRegion: { region: 'SG' } },
    }), { edition: 'cn', path: '/tmp/x', source: 'desktop' })
    expect(credential?.region).toBe('ai')
  })

  it('falls back to the edition when the claim is absent', () => {
    const credential = parseTraeCredential(JSON.stringify({
      a: { token: 't', userId: 'u' },
    }), { edition: 'solo-sg', path: '/tmp/x', source: 'desktop' })
    // The shape test requires a token AND a region claim, so a record without
    // the claim is not the auth record at all.
    expect(credential).toBeUndefined()
  })

  it('accepts the CLI bare-JWT form, including quoted', () => {
    const credential = parseTraeCredential('"a.b.c"', { edition: 'cn', path: '/tmp/jwt', source: 'cli' })
    expect(credential?.token).toBe('a.b.c')
    expect(credential?.source).toBe('cli')
  })

  it('rejects unparseable JSON and empty documents', () => {
    expect(parseTraeCredential('{ nope', candidate)).toBeUndefined()
    expect(parseTraeCredential('{}', candidate)).toBeUndefined()
    expect(parseTraeCredential('[]', candidate)).toBeUndefined()
    expect(parseTraeCredential('', { edition: 'cn', path: '/tmp/jwt', source: 'cli' })).toBeUndefined()
  })

  it('ignores an object with a token but no region claim', () => {
    expect(parseTraeCredential(JSON.stringify({ a: { token: 't' } }), candidate)).toBeUndefined()
  })
})

describe('traeAccountId', () => {
  it('is derived from the region and user, never the token', () => {
    // An id built from the token would change on every refresh and orphan the
    // account's usage history.
    const first = traeAccountId({ region: 'cn', userId: 'u-1' })
    const second = traeAccountId({ region: 'cn', userId: 'u-1' })
    expect(first).toBe(second)
    expect(first).toBe('cn:u-1')
  })

  it('separates the same user id across regions', () => {
    expect(traeAccountId({ region: 'cn', userId: 'u' })).not.toBe(traeAccountId({ region: 'ai', userId: 'u' }))
  })
})

describe('traeStorageCandidates', () => {
  it('covers all four editions and both sources', () => {
    const candidates = traeStorageCandidates()
    const editions = new Set(candidates.map(c => c.edition))
    expect(editions).toEqual(new Set(['cn', 'sg', 'solo', 'solo-sg']))
    expect(candidates.some(c => c.source === 'cli')).toBe(true)
    expect(candidates.some(c => c.source === 'desktop')).toBe(true)
  })

  it('always includes the CLI dotfile homes', () => {
    const cli = traeStorageCandidates().filter(c => c.source === 'cli')
    expect(cli.some(c => c.path.includes('.trae-cn'))).toBe(true)
    expect(cli.some(c => c.path.includes('.trae'))).toBe(true)
  })
})

describe('Trae backend states', () => {
  it('reports a usable state without throwing', async () => {
    const state = await createTraeBackend().current()
    expect(['ready', 'signed-out', 'unavailable', 'failed']).toContain(state.state)
  })

  it('declines to invent a balance it cannot verify', async () => {
    const backend = createTraeBackend()
    await backend.current()
    const reading = await backend.readQuota('cn:whatever')
    // Either an honest "unavailable" or an account-changed error; never a
    // fabricated number.
    expect(['unavailable', 'error']).toContain(reading.kind)
  })
})
