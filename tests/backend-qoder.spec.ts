import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  QODER_DESCRIPTOR,
  QODER_REGIONS,
  createQoderBackend,
  qoderEnvPat,
} from '../src/backends/qoder.ts'
import type { QoderRegionSpec } from '../src/backends/qoder.ts'

describe('Qoder descriptor', () => {
  it('declares two regions as two accounts, and multi-account support', () => {
    expect(QODER_DESCRIPTOR.id).toBe('qoder')
    expect(QODER_DESCRIPTOR.authKind).toBe('desktop-adoption')
    expect(QODER_DESCRIPTOR.multiAccount).toBe(true)
  })

  it('describes both products with distinct gateways', () => {
    expect(QODER_REGIONS).toHaveLength(2)
    const gateways = QODER_REGIONS.map(region => region.gateway)
    expect(new Set(gateways).size).toBe(2)
    expect(QODER_REGIONS.map(r => r.id)).toEqual(['qoder-cn', 'qoder'])
  })
})

describe('qoderEnvPat', () => {
  const cn: QoderRegionSpec = QODER_REGIONS[0]!

  it('finds a configured token and says which variable it came from', () => {
    const found = qoderEnvPat(cn, { QODERCN_PAT: 'tok' } as NodeJS.ProcessEnv)
    expect(found).toEqual({ name: 'QODERCN_PAT', value: 'tok' })
  })

  it('prefers the first listed variable when several are set', () => {
    const found = qoderEnvPat(cn, {
      QODERCN_API_KEY: 'first',
      QODERCN_PAT: 'second',
    } as NodeJS.ProcessEnv)
    expect(found?.name).toBe('QODERCN_API_KEY')
  })

  it('ignores an empty or whitespace value', () => {
    // An exported-but-empty variable is not a credential, and treating it as
    // one would offer an account that fails every request.
    expect(qoderEnvPat(cn, { QODERCN_PAT: '   ' } as NodeJS.ProcessEnv)).toBeUndefined()
  })

  it('is undefined when nothing is configured', () => {
    expect(qoderEnvPat(cn, {} as NodeJS.ProcessEnv)).toBeUndefined()
  })

  it('does not leak one region\'s variable into the other', () => {
    const intl = QODER_REGIONS[1]!
    expect(qoderEnvPat(intl, { QODERCN_PAT: 'cn-only' } as NodeJS.ProcessEnv)).toBeUndefined()
    expect(qoderEnvPat(cn, { QODER_PAT: 'intl-only' } as NodeJS.ProcessEnv)).toBeUndefined()
  })
})

describe('Qoder backend states', () => {
  let dir: string
  const saved: Record<string, string | undefined> = {}
  const names = ['APPDATA', 'XDG_CONFIG_HOME', 'HOME', 'USERPROFILE', 'QODERCN_PAT', 'QODER_PAT', 'QODERCN_API_KEY', 'QODER_API_KEY', 'QODERCN_PERSONAL_ACCESS_TOKEN', 'QODER_PERSONAL_ACCESS_TOKEN']

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qoder-'))
    for (const name of names) saved[name] = process.env[name]
    // Point every data root at an empty temp directory so no real install is
    // visible, and clear every PAT variable.
    process.env['APPDATA'] = dir
    process.env['XDG_CONFIG_HOME'] = join(dir, 'xdg')
    process.env['HOME'] = dir
    process.env['USERPROFILE'] = dir
    for (const name of names.slice(4)) delete process.env[name]
  })

  afterEach(async () => {
    for (const name of names) {
      const value = saved[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('reports unavailable with an actionable hint when neither product is present', async () => {
    const state = await createQoderBackend().resolveAccounts()
    expect(state.state).toBe('unavailable')
    if (state.state !== 'unavailable') throw new Error('unreachable')
    // The hint must name BOTH ways out, since either one fixes it.
    expect(state.hint).toContain('QODERCN_PAT')
  })

  it('reports a PAT account as usable even with no desktop app', async () => {
    process.env['QODERCN_PAT'] = 'tok'
    const state = await createQoderBackend().resolveAccounts()
    expect(state.state).toBe('ready')
    if (state.state !== 'ready') throw new Error('unreachable')
    expect(state.accounts).toHaveLength(1)
    expect(state.accounts[0]!.usable).toBe(true)
    // The token itself must never reach a renderable field.
    expect(JSON.stringify(state.accounts)).not.toContain('tok')
  })

  it('reports an installed app as present but unadopted, not as signed out', async () => {
    await mkdir(join(dir, 'Qoder'), { recursive: true })
    const state = await createQoderBackend().resolveAccounts()
    expect(state.state).toBe('ready')
    if (state.state !== 'ready') throw new Error('unreachable')
    const account = state.accounts[0]!
    // "Sign in again" would not help here, so this must NOT read as signed out.
    expect(account.usable).toBe(false)
    expect(account.reason).toContain('PAT')
  })

  it('lists both regions as separate accounts when both are installed', async () => {
    await mkdir(join(dir, 'Qoder'), { recursive: true })
    await mkdir(join(dir, 'Qoder CN'), { recursive: true })
    const state = await createQoderBackend().resolveAccounts()
    if (state.state !== 'ready') throw new Error('unreachable')
    expect(state.accounts.map(a => a.id).sort()).toEqual(['qoder-cn:desktop', 'qoder:desktop'])
  })

  it('serves a per-region model roster', async () => {
    process.env['QODERCN_PAT'] = 'tok'
    const backend = createQoderBackend()
    await backend.current()
    const cnModels = await backend.listModels('qoder-cn:pat')
    expect(cnModels.length).toBeGreaterThan(0)
    // An unknown account yields nothing rather than another region's roster.
    expect(await backend.listModels('nonexistent')).toEqual([])
  })

  it('declines to invent a balance', async () => {
    process.env['QODERCN_PAT'] = 'tok'
    const backend = createQoderBackend()
    await backend.current()
    expect((await backend.readQuota('qoder-cn:pat')).kind).toBe('unavailable')
  })
})
