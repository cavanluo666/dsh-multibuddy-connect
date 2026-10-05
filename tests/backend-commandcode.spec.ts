import { describe, expect, it } from 'vitest'
import {
  COMMANDCODE_DESCRIPTOR,
  createCommandCodeBackend,
  isGoModelId,
  parseCommandCodeModels,
} from '../src/backends/commandcode.ts'

describe('Command Code descriptor', () => {
  it('declares multi-account support and no quota endpoint', () => {
    expect(COMMANDCODE_DESCRIPTOR.id).toBe('commandcode')
    expect(COMMANDCODE_DESCRIPTOR.authKind).toBe('api-key')
    // The upstream plugin's accounts dictionary mints one route per entry, so
    // several keys can be configured side by side.
    expect(COMMANDCODE_DESCRIPTOR.multiAccount).toBe(true)
    // The Go plan exposes no public balance endpoint.
    expect(COMMANDCODE_DESCRIPTOR.reportsQuota).toBe(false)
  })
})

describe('isGoModelId', () => {
  it('accepts a free-tier id', () => {
    expect(isGoModelId('some-model-free')).toBe(true)
  })

  it('accepts the paid families the Go plan grants', () => {
    // Filtering on the -free suffix alone silently removed every paid model the
    // subscription includes, which offered the user less than they paid for.
    expect(isGoModelId('gpt-5.6-luna')).toBe(true)
    expect(isGoModelId('grok-4.5')).toBe(true)
    expect(isGoModelId('muse-spark-1.2-contributor')).toBe(true)
  })

  it('accepts a dated variant of a granted family', () => {
    expect(isGoModelId('gpt-5.6-luna-2026-01-01')).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(isGoModelId('GROK-4.5')).toBe(true)
    expect(isGoModelId('Some-Model-FREE')).toBe(true)
  })

  it('rejects an unlisted paid model', () => {
    // The deliberate direction of error: a new model arrives late rather than
    // an existing one never arriving.
    expect(isGoModelId('gpt-5.5-luna')).toBe(false)
    expect(isGoModelId('claude-opus-9')).toBe(false)
  })

  it('does not match a family name as a mere prefix of a longer word', () => {
    // `grok-4.55` must not be treated as `grok-4.5`, or an unrelated model
    // would be offered under a plan that does not include it.
    expect(isGoModelId('grok-4.55')).toBe(false)
  })
})

describe('parseCommandCodeModels', () => {
  const payload = {
    data: [
      { id: 'alpha-free', name: 'Alpha', context_length: 128000 },
      { id: 'grok-4.5', name: 'Grok 4.5' },
      { id: 'unlisted-model', name: 'Unlisted' },
    ],
  }

  it('keeps the Go models and drops the rest', () => {
    expect(parseCommandCodeModels(payload).map(m => m.id)).toEqual(['alpha-free', 'grok-4.5'])
  })

  it('surfaces the tier in a free model label so two rows never read alike', () => {
    const free = parseCommandCodeModels(payload).find(m => m.id === 'alpha-free')
    expect(free?.name).toContain('free')
  })

  it('returns nothing for a malformed envelope', () => {
    expect(parseCommandCodeModels(null)).toEqual([])
    expect(parseCommandCodeModels({})).toEqual([])
    expect(parseCommandCodeModels({ data: 'nope' })).toEqual([])
  })
})

describe('Command Code accounts', () => {
  const env = 'COMMANDCODE_API_KEY'
  let previous: string | undefined
  const save = (): void => { previous = process.env[env] }
  const restore = (): void => {
    if (previous === undefined) delete process.env[env]
    else process.env[env] = previous
  }

  it('falls back to one default account from the environment', async () => {
    save()
    try {
      process.env[env] = 'sk-env'
      const state = await createCommandCodeBackend().resolveAccounts()
      expect(state.state).toBe('ready')
      if (state.state !== 'ready') throw new Error('unreachable')
      expect(state.accounts).toHaveLength(1)
      expect(state.accounts[0]!.usable).toBe(true)
      // The key itself must never reach the label; only a masked form may.
      expect(JSON.stringify(state.accounts)).not.toContain('sk-env')
    } finally {
      restore()
    }
  })

  it('reports a configured account without a key as unusable, with a reason', async () => {
    save()
    try {
      delete process.env[env]
      const state = await createCommandCodeBackend({
        accounts: [{ id: 'work', label: 'Work' }],
      }).resolveAccounts()
      expect(state.state).toBe('ready')
      if (state.state !== 'ready') throw new Error('unreachable')
      // Kept in the list rather than dropped, so the card can say WHICH variable
      // to set instead of showing an empty group with no explanation.
      expect(state.accounts[0]!.usable).toBe(false)
      expect(state.accounts[0]!.reason).toContain(env)
    } finally {
      restore()
    }
  })

  it('keys several accounts independently', async () => {
    const state = await createCommandCodeBackend({
      accounts: [
        { id: 'work', label: 'Work', secret: 'sk-work' },
        { id: 'personal', label: 'Personal', secret: 'sk-personal' },
      ],
    }).resolveAccounts()
    if (state.state !== 'ready') throw new Error('unreachable')
    expect(state.accounts.map(a => a.id)).toEqual(['work', 'personal'])
    expect(JSON.stringify(state.accounts)).not.toContain('sk-work')
  })

  it('declines to report a balance', async () => {
    expect((await createCommandCodeBackend().readQuota('commandcode')).kind).toBe('unavailable')
  })
})
