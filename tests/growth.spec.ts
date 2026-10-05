import { describe, expect, it } from 'vitest'
import { WorkBuddyGrowthClient, growthOrigin } from '../src/growth.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'tok',
  refreshToken: 'ref',
  expiresAtMs: Date.now() + 3_600_000,
  domain: 'www.codebuddy.cn',
  uid: 'u-1',
  source: 'login',
}

/**
 * Real task shapes, taken from a live listing.
 *
 * Not invented: the state-derivation rules were written against these, and a
 * hand-made fixture would have encoded this author's assumptions rather than the
 * service's behaviour.
 */
const TASK_NOT_ACCEPTED = {
  task_code: 'create_canvas',
  title: '体验「设计创意模式」',
  description: '前往 Workbuddy…',
  task_type: 'single',
  reward_credit: 300,
  reward_energy: 5,
  reward_buddy: false,
  accept_status: 'not_accepted',
  progress: null,
  locked: false,
  has_reward: true,
}

const TASK_ACCEPTED_WITH_PROGRESS = {
  ...TASK_NOT_ACCEPTED,
  task_code: 'chat_5',
  title: '和 AI 聊天 5 次',
  reward_credit: 100,
  reward_energy: 5,
  accept_status: 'accepted',
  progress: 5,
}

const TASK_LOCKED = { ...TASK_NOT_ACCEPTED, task_code: 'locked_one', locked: true }
const TASK_CLAIMED = { ...TASK_ACCEPTED_WITH_PROGRESS, task_code: 'done_one', claim_status: 'claimed' }

/** A client whose fetch is scripted per call. */
function makeClient(responses: readonly unknown[], status = 200): { client: WorkBuddyGrowthClient; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  let index = 0
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const body = responses[index] ?? responses[responses.length - 1]
    index += 1
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { client: new WorkBuddyGrowthClient(fetchImpl), calls }
}

describe('growthOrigin', () => {
  it('addresses the web origin, not the credential domain', () => {
    // Measured: a CodeBuddy-domain credential is served fine by the WorkBuddy
    // web origin, and the credential domain names the CHAT gateway, which does
    // not host the growth centre.
    expect(growthOrigin()).toBe('https://www.workbuddy.cn')
  })
})

describe('listTasks', () => {
  it('derives every task state from the real field shapes', async () => {
    const { client } = makeClient([{ code: 0, data: { tasks: [
      TASK_NOT_ACCEPTED,
      TASK_ACCEPTED_WITH_PROGRESS,
      TASK_LOCKED,
      TASK_CLAIMED,
    ] } }])
    const board = await client.listTasks(CREDENTIAL)
    expect(board.tasks.map(t => t.status)).toEqual(['not_accepted', 'claimable', 'locked', 'claimed'])
  })

  it('reads the reward figures', async () => {
    const { client } = makeClient([{ code: 0, data: { tasks: [TASK_NOT_ACCEPTED] } }])
    const board = await client.listTasks(CREDENTIAL)
    expect(board.tasks[0]).toMatchObject({ code: 'create_canvas', credit: 300, energy: 5 })
  })

  it('counts what is claimable versus merely acceptable', async () => {
    const { client } = makeClient([{ code: 0, data: { tasks: [TASK_NOT_ACCEPTED, TASK_ACCEPTED_WITH_PROGRESS] } }])
    const board = await client.listTasks(CREDENTIAL)
    expect(board.claimable).toBe(1)
    expect(board.acceptable).toBe(1)
  })

  it('EXCLUDES claimed and locked tasks from the pending totals', async () => {
    // Including them would advertise rewards that cannot be collected.
    const { client } = makeClient([{ code: 0, data: { tasks: [TASK_NOT_ACCEPTED, TASK_LOCKED, TASK_CLAIMED] } }])
    const board = await client.listTasks(CREDENTIAL)
    expect(board.pendingCredit).toBe(300)
    expect(board.pendingEnergy).toBe(5)
  })

  it('skips entries with no task code rather than inventing one', async () => {
    const { client } = makeClient([{ code: 0, data: { tasks: [{ title: 'nameless' }, TASK_NOT_ACCEPTED, null, 42] } }])
    const board = await client.listTasks(CREDENTIAL)
    expect(board.tasks.map(t => t.code)).toEqual(['create_canvas'])
  })

  it('carries the account identity headers', async () => {
    const { client, calls } = makeClient([{ code: 0, data: { tasks: [] } }])
    await client.listTasks(CREDENTIAL)
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer tok')
    expect(headers['X-User-Id']).toBe('u-1')
    expect(headers['X-Domain']).toBe('www.codebuddy.cn')
  })

  it('surfaces a non-zero envelope code as an error', async () => {
    const { client } = makeClient([{ code: 10001, msg: 'not logged in' }])
    await expect(client.listTasks(CREDENTIAL)).rejects.toThrow('not logged in')
  })

  it('surfaces a non-JSON body as an error', async () => {
    const fetchImpl = (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch
    await expect(new WorkBuddyGrowthClient(fetchImpl).listTasks(CREDENTIAL))
      .rejects.toThrow('non-JSON')
  })

  it('tolerates a missing tasks array', async () => {
    const { client } = makeClient([{ code: 0, data: {} }])
    const board = await client.listTasks(CREDENTIAL)
    expect(board.tasks).toEqual([])
    expect(board.pendingCredit).toBe(0)
  })
})

describe('acceptTasks', () => {
  it('posts the codes to the accept endpoint', async () => {
    const { client, calls } = makeClient([{ code: 0, data: {} }])
    await client.acceptTasks(CREDENTIAL, ['a', 'b'])
    expect(calls[0]!.url).toBe('https://www.workbuddy.cn/v2/activity/growth/tasks/accept')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ task_codes: ['a', 'b'] })
  })

  it('does not call the upstream for an empty list', async () => {
    const { client, calls } = makeClient([{ code: 0 }])
    await client.acceptTasks(CREDENTIAL, [])
    expect(calls).toEqual([])
  })
})

describe('claimTask', () => {
  it('puts the code in the PATH, not the body', async () => {
    // The documented shape: the chat host's own /reward/claim path does not
    // exist, and the working route carries the code as a path segment.
    const { client, calls } = makeClient([{ code: 0, data: { credit: 100, energy: 5 } }])
    await client.claimTask(CREDENTIAL, 'chat_5')
    expect(calls[0]!.url).toBe('https://www.workbuddy.cn/activity/growth/tasks/chat_5/claim')
    expect(calls[0]!.init?.body).toBeUndefined()
  })

  it('sends the growth-centre Origin, Referer and web platform', async () => {
    // Without these the web origin refuses the request whatever credentials it
    // carries.
    const { client, calls } = makeClient([{ code: 0, data: {} }])
    await client.claimTask(CREDENTIAL, 'x')
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers['Origin']).toBe('https://www.workbuddy.cn')
    expect(headers['Referer']).toBe('https://www.workbuddy.cn/profile/growth-center')
    expect(headers['x-client-platform']).toBe('web')
  })

  it('reports a repeat claim as already claimed, not as a payout', async () => {
    // Otherwise today's earnings would grow every time the button was pressed.
    const { client } = makeClient([{ code: 0, data: { already_claimed: true } }])
    const claim = await client.claimTask(CREDENTIAL, 'x')
    expect(claim).toEqual({ code: 'x', credit: 0, energy: 0, alreadyClaimed: true })
  })

  it('percent-encodes the code', async () => {
    const { client, calls } = makeClient([{ code: 0, data: {} }])
    await client.claimTask(CREDENTIAL, 'a/b c')
    expect(calls[0]!.url).toContain('a%2Fb%20c')
  })
})

describe('claimAll', () => {
  it('sums the payouts and stays sequential', async () => {
    const { client, calls } = makeClient([
      { code: 0, data: { credit: 100, energy: 5 } },
      { code: 0, data: { credit: 300, energy: 8 } },
    ])
    const summary = await client.claimAll(CREDENTIAL, ['a', 'b'])
    expect(summary.credit).toBe(400)
    expect(summary.energy).toBe(13)
    expect(calls).toHaveLength(2)
  })

  it('keeps going after one task fails, and reports it', async () => {
    // The rest are still claimable; aborting the pass would lose them.
    let index = 0
    const fetchImpl = (async () => {
      index += 1
      if (index === 1) return new Response(JSON.stringify({ code: 500, msg: 'boom' }), { status: 200 })
      return new Response(JSON.stringify({ code: 0, data: { credit: 100, energy: 5 } }), { status: 200 })
    }) as unknown as typeof fetch
    const summary = await new WorkBuddyGrowthClient(fetchImpl).claimAll(CREDENTIAL, ['bad', 'good'])
    expect(summary.failures).toHaveLength(1)
    expect(summary.failures[0]!.code).toBe('bad')
    expect(summary.credit).toBe(100)
  })

  it('does nothing for an empty list', async () => {
    const { client, calls } = makeClient([{ code: 0 }])
    const summary = await client.claimAll(CREDENTIAL, [])
    expect(calls).toEqual([])
    expect(summary.credit).toBe(0)
  })
})
