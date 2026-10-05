/**
 * WorkBuddy daily check-in service.
 *
 * Implements daily check-in against WorkBuddy endpoints (CN and International/Global):
 * - CN: https://www.workbuddy.cn/v2/billing/meter/daily-checkin
 * - Global: https://www.workbuddy.ai/v2/billing/meter/daily-checkin
 *
 * Headers and protocol:
 * - Common headers: Content-Type, Accept, Authorization: Bearer <token>
 * - Global headers: X-Domain: www.workbuddy.ai, X-No-Enterprise-Id: 1, Accept-Language: en-US
 * - CN headers: X-Domain, enterprise headers if present, Accept-Language: zh-CN
 * - Device fingerprint: X-Machine-ID, X-Session-ID derived from UID
 * - Gateway headers: X-CodeBuddy-Request: 1
 *
 * Handles already-claimed detection (HTTP 400 with code 10001 or message containing "已签到"/"今天已签到"),
 * successful claim (code 0 or 200, extracting credit amount).
 *
 * @module dsh-workbuddy-connect/checkin
 */

import { createHash } from 'node:crypto'
import type { WorkBuddyCredential } from './auth.ts'
import { realmOf } from './upstream.ts'

export interface WorkBuddyCheckInResult {
  variantId: string
  date: string
  timestamp: number
  status: 'claimed' | 'already-claimed' | 'no-campaign' | 'error'
  amount?: number | undefined
  message?: string | undefined
}

export interface WorkBuddyCheckInServiceOptions {
  fetch?: typeof fetch | undefined
  timeoutMs?: number | undefined
}

const DEFAULT_TIMEOUT_MS = 15_000
const CN_CHECKIN_URL = 'https://www.workbuddy.cn/v2/billing/meter/daily-checkin'
const GLOBAL_CHECKIN_URL = 'https://www.workbuddy.ai/v2/billing/meter/daily-checkin'
const GLOBAL_DOMAIN = 'www.workbuddy.ai'
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** One stable 36-hex identifier for an account and purpose. */
function deriveAccountStableId(uid: string, purpose: string): string {
  return createHash('sha256').update(`wb2a:${purpose}:${uid}`).digest('hex').slice(0, 36)
}

/** Returns device headers if UID is present. */
function accountDeviceHeaders(uid: string): Record<string, string> {
  if (!uid || uid.trim() === '') return {}
  return {
    'X-Machine-ID': deriveAccountStableId(uid, 'machine'),
    'X-Session-ID': deriveAccountStableId(uid, 'session'),
  }
}

/** Returns the current date in YYYY-MM-DD standardized on UTC+8 (Beijing Time). */
export function getUtc8DateString(nowMs: number = Date.now()): string {
  const d = new Date(nowMs)
  const utc8 = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60_000)
  const y = utc8.getFullYear()
  const m = String(utc8.getMonth() + 1).padStart(2, '0')
  const day = String(utc8.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export class WorkBuddyCheckInService {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: WorkBuddyCheckInServiceOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * Execute daily check-in for a credential.
   */
  async checkIn(
    variantId: string,
    credential: WorkBuddyCredential | undefined,
    signal?: AbortSignal,
  ): Promise<WorkBuddyCheckInResult> {
    const nowMs = Date.now()
    const today = getUtc8DateString(nowMs)

    if (!credential || !credential.accessToken || credential.accessToken.trim() === '') {
      return {
        variantId,
        date: today,
        timestamp: nowMs,
        status: 'error',
        message: 'No access token available',
      }
    }

    const isGlobal = realmOf(credential) === 'global' || variantId.includes('ai')
    const checkInUrl = isGlobal ? GLOBAL_CHECKIN_URL : CN_CHECKIN_URL
    const origin = isGlobal ? 'https://www.workbuddy.ai' : 'https://www.workbuddy.cn'

    // Build headers based on specification
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${credential.accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Origin': origin,
      'Referer': `${origin}/profile/growth-center`,
      'User-Agent': CLIENT_UA,
      'X-CodeBuddy-Request': '1',
      'Accept-Language': isGlobal ? 'en-US' : 'zh-CN',
      ...accountDeviceHeaders(credential.uid),
    }

    if (credential.uid && credential.uid.trim() !== '') {
      headers['X-User-Id'] = credential.uid
    }

    if (isGlobal) {
      headers['X-Domain'] = GLOBAL_DOMAIN
      headers['X-No-Enterprise-Id'] = '1'
    } else {
      if (credential.enterpriseId && credential.enterpriseId.trim() !== '') {
        headers['X-Enterprise-Id'] = credential.enterpriseId
        headers['X-Tenant-Id'] = credential.enterpriseId
      } else {
        headers['X-No-Enterprise-Id'] = '1'
      }
      if (credential.domain && credential.domain.trim() !== '') {
        headers['X-Domain'] = credential.domain
      }
    }

    const combinedSignal = signal ?? AbortSignal.timeout(this.timeoutMs)

    try {
      const response = await this.fetchImpl(checkInUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
        signal: combinedSignal,
      })

      let bodyText = ''
      try {
        bodyText = await response.text()
      } catch {
        // Fall through to parse failure
      }

      let data: any
      try {
        data = JSON.parse(bodyText)
      } catch {
        data = undefined
      }

      const code = typeof data?.code === 'number' ? data.code : undefined
      const msg = typeof data?.msg === 'string'
        ? data.msg
        : typeof data?.message === 'string'
          ? data.message
          : ''

      // 判定 1: 已签到 (already-claimed)
      // 响应中 code === 10001 (常伴随 HTTP 400)，或错误信息包含 "已签到" / "今天已签到" / "already"
      const isAlreadyClaimed =
        code === 10001 ||
        msg.includes('今天已签到') ||
        msg.includes('已签到') ||
        msg.toLowerCase().includes('already')

      if (isAlreadyClaimed) {
        return {
          variantId,
          date: today,
          timestamp: nowMs,
          status: 'already-claimed',
          message: msg || 'Already checked in today',
        }
      }

      // 判定 2: 活动未开启 / 无活动 (no-campaign)
      const isNoCampaign =
        data?.data?.active === false ||
        msg.includes('活动未开启') ||
        msg.includes('已过期') ||
        msg.toLowerCase().includes('not active')

      if (isNoCampaign) {
        return {
          variantId,
          date: today,
          timestamp: nowMs,
          status: 'no-campaign',
          message: msg || 'Check-in campaign not active',
        }
      }

      // 判定 3: 签到成功 (claimed)
      // 返回 code === 0 或 200 视为 claimed，提取 credit 额度
      const isClaimedSuccess = response.ok && (code === 0 || code === 200 || code === undefined)
      if (isClaimedSuccess) {
        const amountCandidate =
          data?.data?.credit ??
          data?.data?.amount ??
          data?.data?.points ??
          data?.credit ??
          data?.amount ??
          data?.points

        const amount = typeof amountCandidate === 'number' && Number.isFinite(amountCandidate)
          ? amountCandidate
          : undefined

        return {
          variantId,
          date: today,
          timestamp: nowMs,
          status: 'claimed',
          amount,
          message: msg || (amount ? `Claimed ${amount} credits` : 'Check-in successful'),
        }
      }

      // 判定 4: 异常失败 (error)
      return {
        variantId,
        date: today,
        timestamp: nowMs,
        status: 'error',
        message: msg || `HTTP ${response.status}: ${bodyText.slice(0, 100)}`,
      }
    } catch (error: unknown) {
      const errMessage = error instanceof Error ? error.message : String(error)
      return {
        variantId,
        date: today,
        timestamp: nowMs,
        status: 'error',
        message: errMessage,
      }
    }
  }
}
