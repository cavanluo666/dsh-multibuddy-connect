import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkBuddyAccountManager, identityOf } from '../src/account-manager.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyVariant } from '../src/variants.ts'

const VARIANT: WorkBuddyVariant = {
  id: 'workbuddy',
  displayName: 'WorkBuddy',
  appName: 'WorkBuddy',
  region: 'cn',
  ownFilename: '.workbuddy-auth.json',
  probeFilename: '.workbuddy-probe.json',
  catalogFilename: '.workbuddy-catalog.json',
  statusPath: '/plugins/dsh-workbuddy-connect/status',
  probePath: '/plugins/dsh-workbuddy-connect/probe',
  loginPath: '/plugins/dsh-workbuddy-connect/login',
}

function credential(uid: string, nickname?: string, enterpriseId?: string): WorkBuddyCredential {
  return {
    accessToken: 'token-' + uid,
    refreshToken: 'refresh-' + uid,
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'workbuddy.cn',
    uid,
    ...(nickname === undefined ? {} : { nickname }),
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    source: 'login',
  }
}

function manager(): WorkBuddyAccountManager {
  return new WorkBuddyAccountManager({
    variant: VARIANT,
    refresh: async credential => ({ accessToken: credential.accessToken, expiresInSec: 3600 }),
  })
}

describe('identityOf', () => {
  it('separates the same person across enterprises', () => {
    // One person can belong to several enterprises, each separately billed.
    expect(identityOf({ uid: 'u1' })).not.toBe(identityOf({ uid: 'u1', enterpriseId: 'e1' }))
  })

  it('is stable for the same inputs', () => {
    expect(identityOf({ uid: 'u1', enterpriseId: 'e1' })).toBe(identityOf({ uid: 'u1', enterpriseId: 'e1' }))
  })
})

describe('WorkBuddyAccountManager', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'manager-'))
    previous = process.env['DSH_WORKBUDDY_DATA_DIR']
    process.env['DSH_WORKBUDDY_DATA_DIR'] = dir
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env['DSH_WORKBUDDY_DATA_DIR']
    else process.env['DSH_WORKBUDDY_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  })

  it('starts empty and still offers a store to sign in to', async () => {
    const m = manager()
    await m.load()
    expect(m.all()).toEqual([])
    // A fresh install has no accounts, but the card needs somewhere to write.
    expect(m.activeStore().ownAuthPath()).toBe(join(dir, '.workbuddy-auth.json'))
  })

  it('puts the FIRST account at the historical path', async () => {
    // An upgrade must not look like a sign-out.
    const m = manager()
    await m.load()
    await m.add(credential('u1', 'Alice'))
    expect(m.all()[0]!.store.ownAuthPath()).toBe(join(dir, '.workbuddy-auth.json'))
  })

  it('discovers an account already on disk as account 0', async () => {
    // The pre-multi-account layout: one file, written by the old single-store code.
    const seed = manager()
    await seed.add(credential('u1', 'Alice'))
    const fresh = manager()
    await fresh.load()
    expect(fresh.all().map(a => a.record.label)).toEqual(['Alice'])
    expect(fresh.activeStore().ownAuthPath()).toBe(join(dir, '.workbuddy-auth.json'))
  })

  it('adds a second account at a distinct path', async () => {
    const m = manager()
    await m.load()
    await m.add(credential('u1', 'Alice'))
    await m.add(credential('u2', 'Bob'))
    const paths = m.all().map(a => a.store.ownAuthPath())
    expect(paths).toHaveLength(2)
    expect(new Set(paths).size).toBe(2)
  })

  it('keeps both accounts readable after a restart', async () => {
    const m = manager()
    await m.load()
    await m.add(credential('u1', 'Alice'))
    await m.add(credential('u2', 'Bob'))

    const fresh = manager()
    await fresh.load()
    expect(fresh.all().map(a => a.record.label).sort()).toEqual(['Alice', 'Bob'])
  })

  it('UPDATES in place when the same account signs in again', async () => {
    // Keyed by identity, not by slot: a second sign-in of one account must not
    // create a duplicate that shares its quota.
    const m = manager()
    await m.load()
    await m.add(credential('u1', 'Alice'))
    await m.add(credential('u1', 'Alice (renamed)'))
    expect(m.all()).toHaveLength(1)
    expect(m.all()[0]!.record.label).toBe('Alice (renamed)')
  })

  it('treats the same uid in another enterprise as a different account', async () => {
    const m = manager()
    await m.load()
    await m.add(credential('u1', 'Personal'))
    await m.add(credential('u1', 'Work', 'ent-1'))
    expect(m.all()).toHaveLength(2)
  })

  it('removes an account and its credential file', async () => {
    const m = manager()
    await m.load()
    await m.add(credential('u1', 'Alice'))
    await m.add(credential('u2', 'Bob'))
    const id = m.all()[1]!.record.id
    const path = m.all()[1]!.store.ownAuthPath()
    await m.remove(id)
    expect(m.all()).toHaveLength(1)

    const fresh = manager()
    await fresh.load()
    expect(fresh.all().map(a => a.record.label)).toEqual(['Alice'])
    expect(path).not.toBe(join(dir, '.workbuddy-auth.json'))
  })

  it('exposes the pool so callers can fail over', async () => {
    const m = manager()
    await m.load()
    await m.add(credential('u1', 'Alice'))
    await m.add(credential('u2', 'Bob'))
    expect(m.accountPool().all()).toHaveLength(2)
    expect(m.accountPool().available(Date.now())).toHaveLength(2)
  })

  it('follows the pool when choosing the active store', async () => {
    const m = manager()
    await m.load()
    await m.add(credential('u1', 'Alice'))
    await m.add(credential('u2', 'Bob'))
    const bobId = m.all()[1]!.record.id
    const bobPath = m.all()[1]!.store.ownAuthPath()
    m.accountPool().setActive(bobId)
    expect(m.activeStore().ownAuthPath()).toBe(bobPath)
  })

  it('survives a restart with the active choice and cooldowns', async () => {
    const m = manager()
    await m.load()
    await m.add(credential('u1', 'Alice'))
    await m.add(credential('u2', 'Bob'))
    const bobId = m.all()[1]!.record.id
    m.accountPool().setActive(bobId)
    m.accountPool().report(m.all()[0]!.record.id, 'soft_rate', Date.now())
    await m.flush()

    const fresh = manager()
    await fresh.load()
    expect(fresh.accountPool().active()?.label).toBe('Bob')
    const alice = fresh.accountPool().all().find(r => r.label === 'Alice')
    expect(alice?.rateLimitHits).toBe(1)
  })
})
