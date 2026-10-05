import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseWorkBuddyAuth,
  WorkBuddyCredentialStore,
  WORKBUDDY_CREDENTIAL_SOURCE,
  WORKBUDDY_DATA_DIR_ENV,
  WORKBUDDY_DATA_DIR_NAME,
  workbuddyPluginDataDir,
  type WorkBuddyCredential,
} from '../src/auth.ts'
import { AI_VARIANT, CN_VARIANT, type WorkBuddyVariant } from '../src/variants.ts'
import type { WorkBuddyRefreshOutcome } from '../src/upstream.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

/** A credential document in the published nested cross-tool layout. */
function nestedDoc(expiresAt: number): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt, domain: 'www.codebuddy.cn' },
    account: { uid: 'uid-1', enterpriseId: 'ent-1', nickname: '昵称' },
  })
}

/** Fresh temp directory, cleaned up after the case. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('parseWorkBuddyAuth', () => {
  it('reads the nested form with millisecond expiry', () => {
    const credential = parseWorkBuddyAuth(nestedDoc(1_792_128_236_868))
    expect(credential?.accessToken).toBe('at')
    expect(credential?.refreshToken).toBe('rt')
    expect(credential?.expiresAtMs).toBe(1_792_128_236_868)
    expect(credential?.uid).toBe('uid-1')
    expect(credential?.enterpriseId).toBe('ent-1')
    expect(credential?.nickname).toBe('昵称')
  })

  it('normalizes second-precision expiry to milliseconds', () => {
    const credential = parseWorkBuddyAuth(nestedDoc(1_792_128_236))
    expect(credential?.expiresAtMs).toBe(1_792_128_236_000)
  })

  it('reads the flat form', () => {
    const credential = parseWorkBuddyAuth(JSON.stringify({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 0,
      domain: '',
      uid: 'uid-2',
    }))
    expect(credential?.accessToken).toBe('at')
    expect(credential?.uid).toBe('uid-2')
    expect(credential?.expiresAtMs).toBe(0)
  })

  it('rejects documents without an access token', () => {
    expect(parseWorkBuddyAuth('{}')).toBeUndefined()
    expect(parseWorkBuddyAuth('not json')).toBeUndefined()
    expect(parseWorkBuddyAuth(JSON.stringify({ auth: { refreshToken: 'rt' } }))).toBeUndefined()
  })
})

/**
 * A store over an explicit plugin-owned path, with refresh stubbed in.
 *
 * Explicit `ownPath` keeps these cases independent of where the plugin would put
 * its data by default; the default layout has its own cases below.
 */
function storeAt(
  ownPath: string,
  refresh?: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>,
): WorkBuddyCredentialStore {
  return new WorkBuddyCredentialStore({
    ownPath,
    refresh: refresh ?? (async credential => ({ accessToken: credential.accessToken })),
  })
}

/** The same, but bound to one product, so its realm check applies. */
function storeForVariant(ownPath: string, variant: WorkBuddyVariant): WorkBuddyCredentialStore {
  return new WorkBuddyCredentialStore({
    ownPath,
    variant,
    refresh: async credential => ({ accessToken: credential.accessToken }),
  })
}

describe('WorkBuddyCredentialStore', () => {
  it('serves a fresh stored credential without refreshing', async () => {
    const dir = await tempDir()
    const own = join(dir, 'own.json')
    await writeFile(own, nestedDoc(Date.now() + 3600_000))
    let refreshes = 0
    const store = storeAt(own, async () => {
      refreshes += 1
      return { accessToken: 'new' }
    })
    await expect(store.resolve()).resolves.toMatchObject({
      accessToken: 'at',
      source: WORKBUDDY_CREDENTIAL_SOURCE,
    })
    expect(refreshes).toBe(0)
  })

  it('refreshes an expiring credential and serves the refreshed one next', async () => {
    const dir = await tempDir()
    const own = join(dir, 'own.json')
    await writeFile(own, nestedDoc(Date.now() - 1000))
    const store = storeAt(own, async () => ({ accessToken: 'fresh', refreshToken: 'rt2', expiresInSec: 3600 }))
    await expect(store.resolve()).resolves.toMatchObject({
      accessToken: 'fresh',
      source: WORKBUDDY_CREDENTIAL_SOURCE,
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'fresh' })
  })

  it('still returns a not-yet-expired token when refresh fails', async () => {
    const dir = await tempDir()
    const own = join(dir, 'own.json')
    await writeFile(own, nestedDoc(Date.now() + 60_000))
    const store = new WorkBuddyCredentialStore({
      ownPath: own,
      refreshMarginMs: 5 * 60_000,
      refresh: async () => {
        throw new Error('refresh endpoint down')
      },
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at' })
  })

  it('serves the refreshed credential with its expiry and identity to a new store', async () => {
    const dir = await tempDir()
    const own = join(dir, 'own.json')
    await writeFile(own, nestedDoc(Date.now() - 1000))
    let refreshes = 0
    const store = storeAt(own, async () => {
      refreshes += 1
      return { accessToken: 'fresh', refreshToken: 'rt2', expiresInSec: 3600 }
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'fresh' })

    // A restart builds a new store over the same plugin-owned file: the refresh
    // it wrote must survive on disk, identity and all.
    const afterRestart = storeAt(own)
    const survived = await afterRestart.resolve()
    expect(refreshes).toBe(1)
    expect(survived).toMatchObject({
      accessToken: 'fresh',
      uid: 'uid-1',
      enterpriseId: 'ent-1',
      nickname: '昵称',
      source: WORKBUDDY_CREDENTIAL_SOURCE,
    })
    expect(survived.expiresAtMs).toBeGreaterThan(Date.now() + 3000_000)
  })

  it('persists a saved credential in the plugin layout', async () => {
    const dir = await tempDir()
    const own = join(dir, 'own.json')
    const expiresAtMs = Date.now() + 3600_000
    const store = storeAt(own)
    await store.save({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAtMs,
      domain: 'www.codebuddy.cn',
      uid: 'uid-1',
      enterpriseId: 'ent-1',
      nickname: '昵称',
      source: WORKBUDDY_CREDENTIAL_SOURCE,
    })

    expect(store.ownAuthPath()).toBe(own)
    // The published nested layout, with the expiry in SECONDS and an explicit
    // region — the two facts that make the file interchangeable with a
    // workbuddy.json written by the sibling tooling.
    const written = JSON.parse(await readFile(own, 'utf8')) as {
      version: number
      region: string
      auth: { accessToken: string, expiresAt: number, domain: string }
      account: { uid: string, nickname?: string }
    }
    expect(written.version).toBe(1)
    expect(written.region).toBe('cn')
    expect(written.auth).toMatchObject({
      accessToken: 'at',
      expiresAt: Math.floor(expiresAtMs / 1000),
      domain: 'www.codebuddy.cn',
    })
    expect(written.account).toMatchObject({ uid: 'uid-1', nickname: '昵称' })

    await expect(storeAt(own).resolve()).resolves.toMatchObject({
      accessToken: 'at',
      uid: 'uid-1',
      enterpriseId: 'ent-1',
      nickname: '昵称',
      source: WORKBUDDY_CREDENTIAL_SOURCE,
    })
  })

  it('rejects an unreadable or unrecognized document', async () => {
    const dir = await tempDir()
    const own = join(dir, 'own.json')
    await writeFile(own, JSON.stringify({ version: 99, credential: { meaningless: true } }))
    await expect(storeAt(own).resolve()).rejects.toThrow(/not signed in/)
  })

  it('fails loudly when nothing is signed in', async () => {
    const dir = await tempDir()
    const own = join(dir, 'missing.json')
    const store = storeAt(own)
    await expect(store.resolve()).rejects.toThrow(/not signed in/)
    await expect(store.status()).resolves.toMatchObject({ state: 'signed-out' })
  })

  it('removes its own credential file on logout', async () => {
    const dir = await tempDir()
    const own = join(dir, 'own.json')
    await writeFile(own, nestedDoc(Date.now() + 3600_000))
    const store = storeAt(own)
    await expect(store.status()).resolves.toMatchObject({ state: 'signed-in' })
    await store.logout()
    await expect(store.status()).resolves.toMatchObject({ state: 'signed-out' })
  })
})

describe('importing a supplied credential document', () => {
  /** A document in the exact shape the sibling tooling writes a workbuddy.json. */
  function workbuddyFile(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      account: { enterpriseId: '', nickname: '小楚', uid: 'uid-imported' },
      auth: {
        accessToken: 'imported-at',
        domain: 'copilot.tencent.com',
        // Seconds, which is what the sibling tooling writes.
        expiresAt: 1_794_051_445,
        refreshToken: 'imported-rt',
      },
      disabled: false,
      type: 'workbuddy',
      ...overrides,
    })
  }

  it('adopts a workbuddy.json and rewrites it in the plugin layout', async () => {
    const dir = await tempDir()
    const own = join(dir, 'own.json')
    const store = storeForVariant(own, CN_VARIANT)

    const adopted = await store.importDocument(workbuddyFile())
    expect(adopted).toMatchObject({
      accessToken: 'imported-at',
      refreshToken: 'imported-rt',
      uid: 'uid-imported',
      nickname: '小楚',
      domain: 'copilot.tencent.com',
      source: WORKBUDDY_CREDENTIAL_SOURCE,
    })
    // The seconds in the source document become milliseconds in memory.
    expect(adopted.expiresAtMs).toBe(1_794_051_445_000)

    // An empty enterpriseId must not survive as an empty string.
    expect(adopted.enterpriseId).toBeUndefined()

    // It is now this store's credential, readable by a fresh store.
    await expect(storeForVariant(own, CN_VARIANT).resolve()).resolves.toMatchObject({ accessToken: 'imported-at' })
  })

  it('refuses a document belonging to the other product, naming it', async () => {
    const dir = await tempDir()
    const store = storeForVariant(join(dir, 'own.json'), AI_VARIANT)
    // CN domain in a document offered to the international provider.
    await expect(store.importDocument(workbuddyFile())).rejects.toThrow(/WorkBuddy \(CN\)/)
    await expect(store.importDocument(workbuddyFile())).rejects.toThrow(/--provider workbuddy/)
  })

  it('honours an explicit region over a domain that disagrees', async () => {
    const dir = await tempDir()
    const store = storeForVariant(join(dir, 'own.json'), AI_VARIANT)
    // A document declaring `global` while naming a CN domain: the sibling tooling
    // treats the declaration as authoritative, so the international provider accepts it.
    const adopted = await store.importDocument(workbuddyFile({
      region: 'global',
      auth: { accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: 1_794_051_445, domain: 'copilot.tencent.com' },
    }))
    expect(adopted.region).toBe('global')
  })

  it('refuses text that carries no credential', async () => {
    const dir = await tempDir()
    const store = storeForVariant(join(dir, 'own.json'), CN_VARIANT)
    for (const text of ['not json', '{}', '{"auth":{}}', '[1,2,3]']) {
      await expect(store.importDocument(text)).rejects.toThrow(/no usable credential/)
    }
  })

  it('accepts the plugin\'s own layout too, so an export round-trips', async () => {
    const dir = await tempDir()
    const own = join(dir, 'own.json')
    const source = storeForVariant(own, CN_VARIANT)
    await source.save({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAtMs: Date.now() + 3600_000,
      domain: 'www.codebuddy.cn',
      uid: 'uid-1',
      source: WORKBUDDY_CREDENTIAL_SOURCE,
    })
    const exported = await readFile(own, 'utf8')
    const target = storeForVariant(join(dir, 'other.json'), CN_VARIANT)
    await expect(target.importDocument(exported)).resolves.toMatchObject({ accessToken: 'at', uid: 'uid-1' })
  })
})

describe('plugin data directory', () => {
  it('uses the override when one is set', () => {
    const previous = process.env[WORKBUDDY_DATA_DIR_ENV]
    try {
      process.env[WORKBUDDY_DATA_DIR_ENV] = '/tmp/wb-override'
      expect(workbuddyPluginDataDir()).toBe('/tmp/wb-override')
    } finally {
      if (previous === undefined) delete process.env[WORKBUDDY_DATA_DIR_ENV]
      else process.env[WORKBUDDY_DATA_DIR_ENV] = previous
    }
  })

  it('picks the profile whose manifest declares this plugin', async () => {
    const home = await tempDir()
    // A profile installed by link — the shape a developer runs — names the plugin
    // in its manifest while the module itself resolves elsewhere entirely. Walking
    // up from the module misses it; reading the manifest is what finds it.
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(
      join(home, 'profiles', 'web', 'package.json'),
      JSON.stringify({ name: 'dsh-profile-web', dependencies: { 'dsh-workbuddy-connect': 'link:E:/elsewhere' } }),
    )
    await mkdir(join(home, 'profiles', 'desktop'), { recursive: true })
    await writeFile(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop' }))

    const previousDir = process.env[WORKBUDDY_DATA_DIR_ENV]
    const previousHome = process.env['DSH_HOME']
    try {
      delete process.env[WORKBUDDY_DATA_DIR_ENV]
      process.env['DSH_HOME'] = home
      expect(workbuddyPluginDataDir()).toBe(join(home, 'profiles', 'web', WORKBUDDY_DATA_DIR_NAME))
    } finally {
      if (previousDir === undefined) delete process.env[WORKBUDDY_DATA_DIR_ENV]
      else process.env[WORKBUDDY_DATA_DIR_ENV] = previousDir
      if (previousHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previousHome
    }
  })

  it('does not guess between two profiles that both declare it', async () => {
    const home = await tempDir()
    for (const name of ['web', 'desktop']) {
      await mkdir(join(home, 'profiles', name), { recursive: true })
      await writeFile(
        join(home, 'profiles', name, 'package.json'),
        JSON.stringify({ dependencies: { 'dsh-workbuddy-connect': 'link:E:/elsewhere' } }),
      )
    }
    const previousDir = process.env[WORKBUDDY_DATA_DIR_ENV]
    const previousHome = process.env['DSH_HOME']
    try {
      delete process.env[WORKBUDDY_DATA_DIR_ENV]
      process.env['DSH_HOME'] = home
      // Neither profile's installed copy resolves to this package, so there is no
      // evidence for either: writing a credential into a guess would be worse than
      // falling back to the Harness home.
      expect(workbuddyPluginDataDir()).toBe(join(home, WORKBUDDY_DATA_DIR_NAME))
    } finally {
      if (previousDir === undefined) delete process.env[WORKBUDDY_DATA_DIR_ENV]
      else process.env[WORKBUDDY_DATA_DIR_ENV] = previousDir
      if (previousHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previousHome
    }
  })

  it('falls back under the Harness home when no profile can be discovered', () => {
    const previousDir = process.env[WORKBUDDY_DATA_DIR_ENV]
    const previousHome = process.env['DSH_HOME']
    try {
      delete process.env[WORKBUDDY_DATA_DIR_ENV]
      process.env['DSH_HOME'] = '/tmp/wb-home'
      // These specs run from a checkout rather than an installed profile, so the
      // documented fallback is what applies: the plugin's own folder inside the
      // Harness home, not the home directory itself.
      const resolved = workbuddyPluginDataDir()
      expect(basename(resolved)).toBe(WORKBUDDY_DATA_DIR_NAME)
      expect(dirname(resolved).endsWith(join('tmp', 'wb-home'))).toBe(true)
      expect(resolved).not.toBe(process.env['DSH_HOME'])
    } finally {
      if (previousDir === undefined) delete process.env[WORKBUDDY_DATA_DIR_ENV]
      else process.env[WORKBUDDY_DATA_DIR_ENV] = previousDir
      if (previousHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previousHome
    }
  })

  it('gives each variant its own file inside one data directory', () => {
    const cn = new WorkBuddyCredentialStore({ variant: CN_VARIANT, refresh: async c => ({ accessToken: c.accessToken }) })
    const ai = new WorkBuddyCredentialStore({ variant: AI_VARIANT, refresh: async c => ({ accessToken: c.accessToken }) })
    expect(cn.ownAuthPath()).toBe(join(workbuddyPluginDataDir(), CN_VARIANT.ownFilename))
    expect(ai.ownAuthPath()).toBe(join(workbuddyPluginDataDir(), AI_VARIANT.ownFilename))
    expect(cn.ownAuthPath()).not.toBe(ai.ownAuthPath())
  })
})

describe('credential file writing', () => {
  /** A minimal credential the store will accept. */
  function credential(): WorkBuddyCredential {
    return {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAtMs: Date.now() + 3600_000,
      domain: 'www.codebuddy.cn',
      uid: 'uid-1',
      source: WORKBUDDY_CREDENTIAL_SOURCE,
    }
  }

  it('creates the data directory its first write needs', async () => {
    const dir = await tempDir()
    // Several levels deep and entirely absent: a fresh install has no data
    // directory, so the first write is what has to bring it into being. Opening a
    // lock or a file under a missing directory fails outright, which is exactly
    // how the first import of a fresh install used to fail.
    const own = join(dir, 'absent', 'deeper', '.workbuddy-auth.json')
    const store = storeAt(own)
    await store.save(credential())
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at' })
  })

  it('leaves the credential and nothing else beside it', async () => {
    const dir = await tempDir()
    const store = storeAt(join(dir, '.workbuddy-auth.json'))
    await store.save(credential())
    // No lock file and no leftover temporary: residue the user never asked for,
    // in a directory whose whole contents they can inspect.
    expect(await readdir(dir)).toEqual(['.workbuddy-auth.json'])
  })
})
