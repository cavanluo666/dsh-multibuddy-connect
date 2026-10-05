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

import { randomUUID } from 'node:crypto'
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

/** One task's verdict from an accept call. */
export interface GrowthAcceptResult {
  code: string
  /** Whether the upstream enrolled the task. */
  ok: boolean
  /** Why it refused, when it did (e.g. an unmet prerequisite). */
  message?: string
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

/** How one streak tier stands. */
export type StreakTierStatus = 'locked' | 'claimable' | 'claimed' | 'unknown'

/** One consecutive-login tier. */
export interface StreakTier {
  /** Tier id, e.g. \`7\` or \`14\`. */
  tier: string
  /** Consecutive days the tier requires. */
  days: number
  credit: number
  energy: number
  /** Makeup cards the tier pays. */
  cards: number
  /** Lottery draws the tier unlocks. */
  chances: number
  status: StreakTierStatus
}

/** The consecutive-login picture. */
export interface StreakStatus {
  /** Consecutive days so far. */
  days: number
  monthTotalDays: number
  /** The next tier's id, when one exists. */
  nextTier?: string
  /** Days still needed for it. */
  nextTierRemaining: number
  /** Makeup cards in hand. */
  makeupCards: number
  tiers: readonly StreakTier[]
}

/** The buddy's travel state. */
export interface TravelStatus {
  /** Upstream state word, e.g. \`idle\` or \`travelling\`. */
  state: string
  /** The active trip's record id, needed to collect it. */
  recordId: number
  /** Whether today's trips are used up. */
  dailyLimitReached: boolean
  /** Credits the completed trip is worth. */
  rewardCredit: number
}

/** The buddy itself. */
export interface BuddyInfo {
  instanceId: number
  name: string
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
  async acceptTasks(credential: WorkBuddyCredential, codes: readonly string[]): Promise<readonly GrowthAcceptResult[]> {
    if (codes.length === 0) return []
    const response = await this.fetchImpl(growthOrigin() + GROWTH_PATH + '/accept', {
      method: 'POST',
      headers: chatHeaders(credential),
      body: JSON.stringify({ task_codes: [...codes] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    // A PER-TASK verdict rides INSIDE a successful envelope.
    //
    // Measured behaviour: accepting a task whose prerequisite is unmet answers
    // HTTP 200 with `code: 0` at the envelope level, and reports the refusal only
    // as `data.results[].status === 'error'` with a message such as
    // "prerequisite not met: first_buddy". Treating the envelope code as the
    // answer therefore reports success for every task and leaves the user with a
    // board that never fills — the failure is real, per-task, and must be read
    // from here.
    const data = typeof envelope.data === 'object' && envelope.data !== null && !Array.isArray(envelope.data)
      ? envelope.data as Record<string, unknown>
      : {}
    const raw = Array.isArray(data['results']) ? data['results'] : []
    const results: GrowthAcceptResult[] = []
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      const code = typeof record['task_code'] === 'string' ? record['task_code'] : ''
      if (code === '') continue
      results.push({
        code,
        ok: record['status'] !== 'error',
        ...typeof record['message'] === 'string' && record['message'] !== ''
          ? { message: record['message'] }
          : {},
      })
    }
    return results
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

  /**
   * Send one growth request and return its \`data\` object.
   *
   * A second envelope reader exists because these endpoints are addressed the
   * same way but answer with different payloads; routing every one through a
   * single helper is what keeps the error handling identical across them.
   *
   * @param credential - the account.
   * @param method - the HTTP method.
   * @param path - the path on the growth origin, leading slash included.
   * @param body - the JSON body, when the call takes one.
   * @returns the envelope's \`data\` as a record.
   */
  private async growthJson(
    credential: WorkBuddyCredential,
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const init: RequestInit = {
      method,
      headers: chatHeaders(credential),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    const response = await this.fetchImpl(growthOrigin() + path, init)
    const envelope = await readEnvelope(response)
    return typeof envelope.data === 'object' && envelope.data !== null && !Array.isArray(envelope.data)
      ? envelope.data as Record<string, unknown>
      : {}
  }

  /**
   * The consecutive-login picture.
   *
   * READ FIRST, REDEEM SECOND: a locked tier answers 403 from the redeem
   * endpoint, which once stripped to an error is indistinguishable from a real
   * failure. The tier's own status is the only honest answer to "is there
   * anything to collect".
   *
   * @param credential - the account.
   * @returns days, next tier, makeup cards, and each tier's state.
   */
  async streakStatus(credential: WorkBuddyCredential): Promise<StreakStatus> {
    const data = await this.growthJson(credential, 'GET', '/activity/growth/streak')
    const streak = asRecord(data['streak'])
    const redemption = asRecord(data['redemption_status'])
    const cards = asRecord(data['makeup_cards'])
    const tiers: StreakTier[] = []
    if (Array.isArray(redemption['tiers'])) {
      for (const entry of redemption['tiers']) {
        const tier = asRecord(entry)
        const name = typeof tier['tier'] === 'string' ? tier['tier'] : ''
        if (name === '') continue
        tiers.push({
          tier: name,
          days: numOf(tier['days']),
          credit: numOf(tier['credit']),
          energy: numOf(tier['energy']),
          cards: numOf(tier['cards']),
          chances: numOf(tier['chances']),
          // The flat \`tier_<name>_status\` field is authoritative; the per-tier
          // entry carries no status of its own.
          status: parseTierStatus(redemption['tier_' + name + '_status']),
        })
      }
    }
    return {
      days: numOf(streak['days']),
      monthTotalDays: numOf(streak['month_total_days']),
      ...typeof streak['next_tier'] === 'string' && streak['next_tier'] !== ''
        ? { nextTier: streak['next_tier'] }
        : {},
      nextTierRemaining: numOf(streak['next_tier_remaining']),
      makeupCards: numOf(cards['balance']),
      tiers,
    }
  }

  /**
   * Redeem one unlocked streak tier.
   *
   * The client token is the upstream's idempotency key, so a FRESH one per
   * attempt is what keeps a retry from being read as a duplicate of the last.
   *
   * @param credential - the account.
   * @param tier - the tier id.
   */
  async redeemStreakTier(credential: WorkBuddyCredential, tier: string): Promise<void> {
    await this.growthJson(credential, 'POST', '/activity/growth/redeem', {
      tier,
      client_token: randomUUID(),
    })
  }

  /**
   * How many lottery draws are available.
   *
   * @param credential - the account.
   * @returns the draw count.
   */
  async lotteryChances(credential: WorkBuddyCredential): Promise<number> {
    const data = await this.growthJson(credential, 'GET', '/activity/growth/lottery/summary')
    return numOf(data['chances'])
  }

  /**
   * Draw the lottery once.
   *
   * The prize payload's shape is set by the running campaign, so it is passed
   * through rather than modelled — a model here would be wrong next month.
   *
   * @param credential - the account.
   * @returns whatever the campaign returned.
   */
  async lotteryDraw(credential: WorkBuddyCredential): Promise<unknown> {
    return this.growthJson(credential, 'POST', '/activity/growth/lottery/draw', {
      client_token: randomUUID(),
    })
  }

  /**
   * The buddy profile, when the account has one.
   *
   * \`data.buddy\` arrives as null, absent, or an empty object depending on how
   * far the account got; all three mean the same thing to a caller, so all three
   * answer undefined.
   *
   * @param credential - the account.
   * @returns the buddy, or undefined when none has been adopted.
   */
  async buddyInfo(credential: WorkBuddyCredential): Promise<BuddyInfo | undefined> {
    const data = await this.growthJson(credential, 'GET', '/activity/growth/buddy/info')
    const buddy = asRecord(data['buddy'])
    if (Object.keys(buddy).length === 0) return undefined
    return { instanceId: numOf(buddy['instance_id']), name: String(buddy['name'] ?? '') }
  }

  /** Agree to the buddy terms. Idempotent upstream. */
  async buddyAgree(credential: WorkBuddyCredential): Promise<void> {
    await this.growthJson(credential, 'POST', '/activity/growth/buddy/agreement', { agree: true })
  }

  /**
   * Adopt the first buddy.
   *
   * Gated upstream on having reported activity that day: without it the answer
   * is 400 "first_buddy task not completed yet". Thrown as-is so the caller can
   * classify it as "not yet" rather than as a failure.
   */
  async buddyAdoptFirst(credential: WorkBuddyCredential): Promise<void> {
    await this.growthJson(credential, 'POST', '/activity/growth/buddy/first', {})
  }

  /**
   * The buddy's travel state.
   *
   * @param credential - the account.
   * @returns the state, including the record id a claim needs.
   */
  async travelStatus(credential: WorkBuddyCredential): Promise<TravelStatus> {
    const data = await this.growthJson(credential, 'GET', '/activity/growth/buddy/travel/status')
    return {
      state: typeof data['state'] === 'string' ? data['state'] : '',
      recordId: numOf(data['record_id']),
      dailyLimitReached: data['daily_limit_reached'] === true,
      rewardCredit: numOf(data['reward_credit']),
    }
  }

  /**
   * Send the buddy travelling.
   *
   * The location is fixed at 4: the four locations have identical reward and
   * duration ranges, so there is nothing to choose between them.
   *
   * @param credential - the account.
   */
  async travelDepart(credential: WorkBuddyCredential, locationId = 4): Promise<void> {
    await this.growthJson(credential, 'POST', '/activity/growth/buddy/travel/depart', {
      location_id: locationId,
    })
  }

  /**
   * Collect an arrived trip.
   *
   * The record id comes from {@link travelStatus}; the upstream rejects a claim
   * without it.
   *
   * @param credential - the account.
   * @param recordId - the trip's record id.
   * @returns the credits collected, 0 when the payload states none.
   */
  async travelClaim(credential: WorkBuddyCredential, recordId: number): Promise<number> {
    const data = await this.growthJson(credential, 'POST', '/activity/growth/buddy/travel/claim', {
      record_id: recordId,
    })
    // A missing reward field is not a failure: the trip is collected either way.
    return numOf(data['reward_credit'])
  }
}

/** Coerce an unknown value to a record, empty when it is not one. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Coerce an unknown value to a finite number, 0 otherwise. */
function numOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Read one tier's unlock state from its flat status field. */
function parseTierStatus(value: unknown): StreakTierStatus {
  if (typeof value !== 'string') return 'unknown'
  if (value === 'locked') return 'locked'
  if (value === 'claimable' || value === 'unlocked' || value === 'available') return 'claimable'
  if (value === 'claimed' || value === 'redeemed') return 'claimed'
  return 'unknown'
}
