/**
 * The WorkBuddy growth centre: the daily task board whose rewards are credits
 * and energy.
 *
 * WHERE THIS SITS. Entirely BESIDE the chat path. It reads and (only when the
 * user asks) writes the growth-centre endpoints; it does not touch the shim, the
 * catalog, the credential pool or the adapter. A bug here can cost a reward, but
 * it cannot break a conversation — which is the property that matters for a
 * plugin other work depends on.
 *
 * WHY THE URLS ARE SPLIT ACROSS HOSTS. The listing and the accept call live on
 * the chat host, while CLAIMING lives on the web origin and additionally demands
 * the growth-centre Origin/Referer plus `x-client-platform: web`. The chat
 * host's own /reward/claim path does not exist and answers 400 "task not
 * completed" — a failure that reads like a task-state problem and is actually a
 * routing one. These requirements were measured against the live service, not
 * inferred from the client bundle.
 *
 * @module dsh-multibuddy-connect/growth
 */

import type { WorkBuddyCredential } from './auth.ts'

/** Web origin serving the claim endpoint; also the Origin/Referer it demands. */
const WEB_ORIGIN = 'https://www.workbuddy.cn'

/** Path the growth centre lives under on the chat host. */
const GROWTH_PATH = '/v2/activity/growth/tasks'

/** Request ceiling; these answers are small JSON documents. */
const TIMEOUT_MS = 15_000

/** How one task stands, as the card renders it. */
export type GrowthTaskStatus =
  /** Rewards can be collected now. */
  | 'claimable'
  /** Enrolled, but its progress is not met yet. */
  | 'in_progress'
  /** Not enrolled; accepting it is the first step. */
  | 'not_accepted'
  /** Already collected. */
  | 'claimed'
  /** Gated behind something else. */
  | 'locked'

/** One task on the board. */
export interface GrowthTask {
  code: string
  title: string
  description?: string
  /** Credits the reward pays. */
  credit: number
  /** Energy the reward pays. */
  energy: number
  /** Whether this task grants a Buddy. */
  buddy: boolean
  status: GrowthTaskStatus
  /** Whether the upstream says a reward is attached at all. */
  hasReward: boolean
}

/** A task board read. */
export interface GrowthBoard {
  tasks: readonly GrowthTask[]
  /** Tasks whose reward can be collected right now. */
  claimable: number
  /** Tasks not yet enrolled. */
  acceptable: number
  /** Credits still on the table for this account. */
  pendingCredit: number
  /** Energy still on the table. */
  pendingEnergy: number
}

/** One claim's outcome. */
export interface GrowthClaim {
  code: string
  credit: number
  energy: number
  /**
   * Whether the reward had already been collected.
   *
   * Reported rather than hidden: the upstream answers success with zero credit
   * for a repeat claim, and calling that a fresh payout would make the today's
   * earnings figure grow every time the button was pressed.
   */
  alreadyClaimed: boolean
}

/** What a claim pass produced. */
export interface GrowthClaimSummary {
  claimed: readonly GrowthClaim[]
  credit: number
  energy: number
  /** Failures, so a partial pass is reported rather than silently short. */
  failures: readonly { code: string; message: string }[]
}

/** Envelope shape the growth endpoints share. */
interface Envelope {
  code?: unknown
  msg?: unknown
  data?: unknown
}

/**
 * The origin to address for a credential.
 *
 * Always the WorkBuddy web origin, NOT the credential's own domain: measured
 * behaviour is that a CodeBuddy-domain credential is served fine here, and the
 * domain in the credential names the CHAT gateway, which does not host the
 * growth centre.
 *
 * @returns the origin, without a trailing slash.
 */
export function growthOrigin(): string {
  return WEB_ORIGIN
}

/**
 * Headers for the listing and accept calls.
 *
 * @param credential - the account.
 * @returns the request headers.
 */
function chatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': 'Bearer ' + credential.accessToken,
    'X-User-Id': credential.uid,
    'X-Product': 'workbuddy',
    'X-IDE-Name': 'workbuddy',
    'X-IDE-Type': 'workbuddy',
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
  }
  if (credential.enterpriseId !== undefined) headers['X-Enterprise-Id'] = credential.enterpriseId
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/**
 * Headers the CLAIM endpoint demands.
 *
 * Deliberately a different set from {@link chatHeaders}: the claim is served by
 * the web origin and rejects a request without the growth-centre Origin/Referer
 * and the web client platform, whatever credentials it carries.
 *
 * @param credential - the account.
 * @returns the request headers.
 */
function claimHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...chatHeaders(credential),
    'Origin': WEB_ORIGIN,
    'Referer': WEB_ORIGIN + '/profile/growth-center',
    'x-client-platform': 'web',
  }
  return headers
}

/** Read an envelope, treating a non-zero code as an error. */
async function readEnvelope(response: Response): Promise<Envelope> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error('growth: the upstream answered with a non-JSON body (HTTP ' + response.status + ')')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('growth: the upstream answered with an unexpected envelope')
  }
  const envelope = body as Envelope
  if (!response.ok || envelope.code !== 0) {
    const message = typeof envelope.msg === 'string' ? envelope.msg : 'HTTP ' + response.status
    throw new Error('growth: ' + message)
  }
  return envelope
}

/** Read one task entry; undefined when it carries nothing usable. */
function parseTask(entry: unknown): GrowthTask | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  const code = typeof record['task_code'] === 'string' ? record['task_code'] : ''
  if (code === '') return undefined
  const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
  const locked = record['locked'] === true
  const hasReward = record['has_reward'] === true
  const acceptStatus = typeof record['accept_status'] === 'string' ? record['accept_status'] : ''
  // The board reports eligibility through several fields rather than one status,
  // so the state is derived in the documented precedence order.
  let status: GrowthTaskStatus
  if (locked) status = 'locked'
  else if (record['claim_status'] === 'claimed') status = 'claimed'
  else if (hasReward && acceptStatus === 'accepted' && record['progress'] !== null
    && record['progress'] !== undefined) status = 'claimable'
  else if (acceptStatus === 'accepted') status = 'in_progress'
  else status = 'not_accepted'
  return {
    code,
    title: typeof record['title'] === 'string' && record['title'] !== '' ? record['title'] : code,
    ...typeof record['description'] === 'string' && record['description'] !== ''
      ? { description: record['description'] }
      : {},
    credit: number(record['reward_credit']),
    energy: number(record['reward_energy']),
    buddy: record['reward_buddy'] === true,
    status,
    hasReward,
  }
}

/**
 * The growth centre's client.
 *
 * @param fetchImpl - the fetch to use; injected so tests need no network.
 */
export class WorkBuddyGrowthClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /**
   * Read the task board. READ-ONLY.
   *
   * @param credential - the account to read for.
   * @returns the board, with its totals.
   */
  async listTasks(credential: WorkBuddyCredential): Promise<GrowthBoard> {
    const response = await this.fetchImpl(growthOrigin() + GROWTH_PATH, {
      headers: chatHeaders(credential),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const raw = Array.isArray(data['tasks']) ? data['tasks'] : []
    const tasks: GrowthTask[] = []
    for (const entry of raw) {
      const task = parseTask(entry)
      if (task !== undefined) tasks.push(task)
    }
    let pendingCredit = 0
    let pendingEnergy = 0
    for (const task of tasks) {
      if (task.status === 'claimed' || task.status === 'locked') continue
      pendingCredit += task.credit
      pendingEnergy += task.energy
    }
    return {
      tasks,
      claimable: tasks.filter(task => task.status === 'claimable').length,
      acceptable: tasks.filter(task => task.status === 'not_accepted').length,
      pendingCredit,
      pendingEnergy,
    }
  }

  /**
   * Enrol in tasks by code. Idempotent: the upstream answers success for an
   * already-accepted task, so a replay is safe.
   *
   * @param credential - the account.
   * @param codes - the task codes to accept.
   */
  async acceptTasks(credential: WorkBuddyCredential, codes: readonly string[]): Promise<void> {
    if (codes.length === 0) return
    const response = await this.fetchImpl(growthOrigin() + GROWTH_PATH + '/accept', {
      method: 'POST',
      headers: chatHeaders(credential),
      body: JSON.stringify({ task_codes: [...codes] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    await readEnvelope(response)
  }

  /**
   * Collect one task's reward. Idempotent: a repeat answers already_claimed.
   *
   * @param credential - the account.
   * @param code - the task code; it rides the PATH.
   * @returns what the claim paid.
   */
  async claimTask(credential: WorkBuddyCredential, code: string): Promise<GrowthClaim> {
    const response = await this.fetchImpl(
      growthOrigin() + '/activity/growth/tasks/' + encodeURIComponent(code) + '/claim',
      { method: 'POST', headers: claimHeaders(credential), signal: AbortSignal.timeout(TIMEOUT_MS) },
    )
    const envelope = await readEnvelope(response)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    if (data['already_claimed'] === true) {
      return { code, credit: 0, energy: 0, alreadyClaimed: true }
    }
    const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
    return { code, credit: number(data['credit']), energy: number(data['energy']), alreadyClaimed: false }
  }

  /**
   * Collect every eligible reward, one at a time.
   *
   * SEQUENTIAL on purpose: these are write calls against a rate-limited gift
   * endpoint, and a burst is the pattern that gets an account throttled — which,
   * now that accounts are pooled, would park the whole account rather than one
   * task.
   *
   * A failure on one task does NOT abort the pass: the rest are still claimable,
   * and the failure is reported alongside the successes.
   *
   * @param credential - the account.
   * @param codes - the task codes to claim.
   * @returns what the pass produced.
   */
  async claimAll(credential: WorkBuddyCredential, codes: readonly string[]): Promise<GrowthClaimSummary> {
    const claimed: GrowthClaim[] = []
    const failures: { code: string; message: string }[] = []
    let credit = 0
    let energy = 0
    for (const code of codes) {
      try {
        const claim = await this.claimTask(credential, code)
        claimed.push(claim)
        credit += claim.credit
        energy += claim.energy
      } catch (error: unknown) {
        failures.push({ code, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return { claimed, credit, energy, failures }
  }
}
