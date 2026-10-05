import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLoomyBackend,
  maskPhone,
  parseLoomyAuth,
  parseLoomyModels,
} from '../src/backends/loomy.ts'

describe('parseLoomyAuth', () => {
  it('reads a session and a user id', () => {
    const parsed = parseLoomyAuth(JSON.stringify({ session: 'sess-1', userid: 'u-9' }))
    expect(parsed).toEqual({ session: 'sess-1', userId: 'u-9' })
  })

  it('carries a masked phone through', () => {
    const parsed = parseLoomyAuth(JSON.stringify({ session: 's', userid: 'u', maskedPhone: '138****8888' }))
    expect(parsed?.maskedPhone).toBe('138****8888')
  })

  it('masks a raw 11-digit phone', () => {
    const parsed = parseLoomyAuth(JSON.stringify({ session: 's', userid: 'u', phone: '13212342249' }))
    expect(parsed?.maskedPhone).toBe('132****2249')
  })

  it('rejects a document without a session', () => {
    expect(parseLoomyAuth(JSON.stringify({ userid: 'u' }))).toBeUndefined()
  })

  it('rejects a document without a user id', () => {
    expect(parseLoomyAuth(JSON.stringify({ session: 's' }))).toBeUndefined()
  })

  it('rejects malformed JSON and non-objects', () => {
    expect(parseLoomyAuth('{ not json')).toBeUndefined()
    expect(parseLoomyAuth('[]')).toBeUndefined()
    expect(parseLoomyAuth('null')).toBeUndefined()
  })
})

describe('maskPhone', () => {
  it('masks an 11-digit mainland number', () => {
    expect(maskPhone('13212342249')).toBe('132****2249')
  })

  it('leaves an already-masked value alone', () => {
    expect(maskPhone('132****2249')).toBe('132****2249')
  })

  it('keeps a short value readable', () => {
    expect(maskPhone('123')).toBe('123')
  })
})

describe('parseLoomyModels', () => {
  it('reads model entries out of a provider map', () => {
    const models = parseLoomyModels(JSON.stringify({
      provider: {
        loomy: {
          models: {
            'loomy-text': { name: 'Loomy Text', contextWindow: 128000, output: 8192 },
          },
        },
      },
    }))
    expect(models).toEqual([{ id: 'loomy-text', name: 'Loomy Text', contextWindow: 128000, maxTokens: 8192 }])
  })

  it('accepts the limit spelling as a context window', () => {
    const models = parseLoomyModels(JSON.stringify({
      provider: { p: { models: { m: { limit: 64000 } } } },
    }))
    expect(models[0]!.contextWindow).toBe(64000)
  })

  it('drops an image-only model', () => {
    const models = parseLoomyModels(JSON.stringify({
      provider: { p: { models: { img: { modalities: ['image'] }, txt: { modalities: ['text'] } } } },
    }))
    expect(models.map(m => m.id)).toEqual(['txt'])
  })

  it('flags a model that accepts images', () => {
    const models = parseLoomyModels(JSON.stringify({
      provider: { p: { models: { both: { modalities: ['text', 'image'] } } } },
    }))
    expect(models[0]!.supportsImages).toBe(true)
  })

  it('falls back to the id when no name is given', () => {
    const models = parseLoomyModels(JSON.stringify({ provider: { p: { models: { 'bare-id': {} } } } }))
    expect(models[0]!.name).toBe('bare-id')
  })

  it('returns nothing for malformed input', () => {
    expect(parseLoomyModels('{ nope')).toEqual([])
    expect(parseLoomyModels('{}')).toEqual([])
    expect(parseLoomyModels(JSON.stringify({ provider: 'not an object' }))).toEqual([])
  })
})

describe('loomy backend', () => {
  let dir: string
  let previousAuth: string | undefined
  let previousConfig: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loomy-'))
    previousAuth = process.env['LOOMY_AUTH_FILE']
    previousConfig = process.env['LOOMY_CONFIG_FILE']
  })

  afterEach(async () => {
    if (previousAuth === undefined) delete process.env['LOOMY_AUTH_FILE']
    else process.env['LOOMY_AUTH_FILE'] = previousAuth
    if (previousConfig === undefined) delete process.env['LOOMY_CONFIG_FILE']
    else process.env['LOOMY_CONFIG_FILE'] = previousConfig
    await rm(dir, { recursive: true, force: true })
  })

  it('declares itself single-account and desktop-adopted', () => {
    const backend = createLoomyBackend()
    expect(backend.descriptor.multiAccount).toBe(false)
    expect(backend.descriptor.authKind).toBe('desktop-adoption')
  })

  it('reports signed-out when the sign-in file exists but has no session', async () => {
    const path = join(dir, 'auth-session.json')
    await writeFile(path, JSON.stringify({ userid: 'u' }), 'utf8')
    process.env['LOOMY_AUTH_FILE'] = path
    expect((await createLoomyBackend().resolveAccounts()).state).toBe('signed-out')
  })

  it('reports ready with one account for a valid sign-in', async () => {
    const path = join(dir, 'auth-session.json')
    await writeFile(path, JSON.stringify({ session: 's', userid: 'u-1', phone: '13212342249' }), 'utf8')
    process.env['LOOMY_AUTH_FILE'] = path
    const state = await createLoomyBackend().resolveAccounts()
    expect(state.state).toBe('ready')
    if (state.state !== 'ready') throw new Error('unreachable')
    expect(state.accounts[0]!.label).toBe('132****2249')
    expect(state.accounts[0]!.id).toBe('u-1')
  })

  it('declines to report a balance it cannot vouch for', async () => {
    const reading = await createLoomyBackend().readQuota('u-1')
    expect(reading.kind).toBe('unavailable')
  })

  it('serves the models from the manifest file', async () => {
    const path = join(dir, 'opencode.json')
    await writeFile(path, JSON.stringify({
      provider: { loomy: { models: { alpha: { name: 'Alpha' } } } },
    }), 'utf8')
    process.env['LOOMY_CONFIG_FILE'] = path
    const models = await createLoomyBackend().listModels('u-1')
    expect(models.map(m => m.id)).toEqual(['alpha'])
  })

  it('serves an empty roster when the manifest is missing', async () => {
    process.env['LOOMY_CONFIG_FILE'] = join(dir, 'absent.json')
    expect(await createLoomyBackend().listModels('u-1')).toEqual([])
  })
})
