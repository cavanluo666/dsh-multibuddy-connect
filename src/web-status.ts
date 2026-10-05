/**
 * Same-origin status route for the WorkBuddy plugin card: sign-in state,
 * token expiry, and remaining credit, fetched by the browser half. The route
 * answers loopback browser requests only and never carries token material.
 *
 * @module dsh-workbuddy-connect/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WorkBuddyCredentialStore } from './auth.ts'
import type { WorkBuddyUpstreamClient } from './upstream.ts'
import { normalizeCredits } from './upstream.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { WORKBUDDY_STATUS_PATH } from './status-paths.ts'
import type { WorkBuddyWebCatalog, WorkBuddyWebGrowth, WorkBuddyWebModelBadge, WorkBuddyWebPool, WorkBuddyWebProbeSection, WorkBuddyWebStatus } from './status-paths.ts'

export { WORKBUDDY_STATUS_PATH } from './status-paths.ts'
export type { WorkBuddyWebStatus } from './status-paths.ts'

/** Constructor dependencies. */
export interface WorkBuddyStatusRouteOptions {
  store: WorkBuddyCredentialStore
  client: Pick<WorkBuddyUpstreamClient, 'fetchCredits'>
  /** Resolve the current model catalog for free/badge display. */
  models: () => readonly WorkBuddyModelInfo[]
  /**
   * Compact probe state for the card. Optional so the status route keeps
   * working on its own in tests and headless profiles.
   */
  probe?: () => WorkBuddyWebProbeSection
  /**
   * Origin of the currently served model list. Optional so the status route
   * keeps working without one in tests and headless profiles.
   */
  catalog?: () => WorkBuddyWebCatalog | undefined
  /** In-process key authorizing probe control writes. */
  probeKey?: string
  /**
   * In-process key authorizing sign-in writes. Minted separately from
   * {@link WorkBuddyStatusRouteOptions.probeKey} because the two authorize
   * different powers; a signed-out card needs only this one.
   */
  loginKey?: string
  /** International-card preference selecting larger declared context windows. */
  useMaximumContextWindow?: () => boolean
  /** Read the list of disabled model IDs for this variant. */
  disabledModels?: () => readonly string[]
  /**
   * The account pool's health for the card.
   *
   * Optional so the status route keeps working in tests and headless profiles,
   * and so a single-account install simply reports no pool.
   */
  pool?: () => WorkBuddyWebPool | undefined
  /**
   * The growth centre's state for the card.
   *
   * A LIVE READ rather than a cached snapshot: the board changes as the user
   * uses the product (a task's progress lands, a reward becomes claimable), and
   * the card's refresh is what should pick that up.
   */
  growth?: () => Promise<WorkBuddyWebGrowth> | WorkBuddyWebGrowth
  /**
   * Whether the upstream has reported an unactivated trial for this variant.
   * Optional so the route keeps working without a shim.
   */
  activationRequired?: () => boolean
  /**
   * Daily check-in status provider for this variant.
   */
  checkIn?: () => {
    lastDate: string
    lastAt: number
    status: 'claimed' | 'already-claimed' | 'no-campaign' | 'error'
    amount?: number | undefined
    message?: string | undefined
    logs?: readonly {
      id: string
      date: string
      timestamp: number
      status: 'claimed' | 'already-claimed' | 'no-campaign' | 'error'
      amount?: number | undefined
      message?: string | undefined
    }[] | undefined
  } | undefined
  /**
   * Route path to mount. Defaults to the CN variant's path so existing callers
   * and tests keep their behaviour; the international variant passes its own.
   */
  path?: string
}

/** Redact token-like content before it crosses to the browser. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * The request must be addressed to the loopback interface, and a
 * browser-attached Origin must be loopback too. The Host check drops
 * DNS-rebinding pages (their Host is the attacker's domain, not loopback);
 * the card's same-origin fetches carry no Origin and pass on Host alone.
 */
function loopbackRequest(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

/**
 * Assemble the card's status document. Sign-in state is read-only; credit is
 * a live billing answer whose failure degrades to `creditsError` rather than
 * failing the whole document.
 */
export async function workBuddyWebStatus(
  deps: WorkBuddyStatusRouteOptions,
): Promise<WorkBuddyWebStatus> {
  const authStatus = await deps.store.status()
  if (authStatus.state !== 'signed-in') {
    // A diagnosable sign-out (a credential for the *other* product) keeps its
    // explanation: falling back to the generic hint would tell the user to sign
    // in when the real fix is to correct a path. The sign-in key rides along so
    // this card can offer the action that resolves the state.
    return {
      status: 'signed-out',
      ...authStatus.reason === undefined ? {} : { reason: authStatus.reason },
      ...deps.loginKey === undefined ? {} : { loginKey: deps.loginKey },
    }
  }
  // Read once into a local: testing `deps.pool?.()` and then calling it again
  // leaves the second call's type as `T | undefined`, so the spread widens the
  // whole document and the union stops narrowing.
  const pool = deps.pool?.()
  // Awaited here rather than in the card: the board needs the credential, which
  // only the host holds. A failure is reported INSIDE the section so the rest of
  // the document still renders.
  let growth: WorkBuddyWebGrowth | undefined
  if (deps.growth !== undefined) {
    try {
      growth = await deps.growth()
    } catch (error: unknown) {
      growth = { enabled: false, boardError: error instanceof Error ? error.message : String(error) }
    }
  }
  const status: WorkBuddyWebStatus = {
    status: 'signed-in',
    ...authStatus.nickname === undefined ? {} : { nickname: authStatus.nickname },
    ...authStatus.domain === undefined || authStatus.domain === '' ? {} : { domain: authStatus.domain },
    ...authStatus.region === undefined ? {} : { region: authStatus.region },
    ...authStatus.expiresAtMs === undefined ? {} : { expiresAt: authStatus.expiresAtMs },
    // Both arms carry the key: a signed-in card needs it for sign-out and for
    // switching accounts, and omitting it here made both actions unreachable.
    ...deps.loginKey === undefined ? {} : { loginKey: deps.loginKey },
    ...pool === undefined ? {} : { pool },
    ...growth === undefined ? {} : { growth },
  }
  // Model facts ride the signed-in document so the card can show rates,
  // promos, and context capacity without touching the Models picker. The rate
  // is normalized here (not in the card) so both halves agree on one display
  // form; the card additionally localizes it.
  //
  // The card receives *every* model, not just the discounted ones: context
  // capacity is exactly the fact a user wants before picking a model, and the
  // models where it matters most (a 200k model beside 1M siblings) are
  // precisely the ones with no promo attached. The discount section filters
  // what it renders.
  const models = deps.models()
  const modelsField: readonly WorkBuddyWebModelBadge[] = models
    .map(model => {
      const rate = normalizeCredits(model.billing?.credits)
      // The lapsed rate and its promotion labels, for a row whose promotion has
      // ended: they travel under the expired note, never as a live price.
      const staleRate = model.billing?.rateUnknown === true ? normalizeCredits(model.billing.credits) : undefined
      const expiredLabels = [...new Set((model.billing?.expiredPromotions ?? []).filter(label => label !== ''))]
      // The largest window the upstream declares for this model, when it
      // declares alternatives; equal to `contextWindow` otherwise, and omitted
      // when the upstream said nothing.
      const supported = model.supportedContextWindows ?? []
      const maxContextWindow = supported.length > 0 ? Math.max(...supported) : undefined
      const defaultContextWindow = model.defaultContextWindow ?? model.contextWindow
      return {
        id: model.id,
        name: model.name,
        ...model.billing?.free === true ? { free: true as const } : {},
        ...model.billing?.badges !== undefined && model.billing.badges.length > 0 ? { badges: model.billing.badges } : {},
        // The rate is deliberately withheld for a row whose price cannot be
        // vouched for (a promotion that has ended but is still baked into the
        // cached row): the card then says the price needs a refresh instead of
        // repeating a stale figure or implying the model is free. What it DOES
        // get is the lapsed figure under an "expired" note — the user needs to
        // know the price was x0.00 and that the promotion ran out, which is
        // strictly more useful than a bare "unavailable".
        ...model.billing?.rateUnknown === true
          ? {
              rateUnknown: true as const,
              ...staleRate === undefined ? {} : { expiredCredits: staleRate },
              ...expiredLabels.length === 0 ? {} : { expiredPromotions: expiredLabels },
            }
          : rate === undefined ? {} : { credits: rate },
        // Verbatim from the upstream catalog; omitted when it said nothing.
        ...typeof model.contextWindow === 'number' && model.contextWindow > 0
          ? { contextWindow: model.contextWindow }
          : {},
        ...typeof defaultContextWindow === 'number' && defaultContextWindow > 0 && defaultContextWindow < model.contextWindow
          ? { defaultContextWindow }
          : {},
        ...maxContextWindow === undefined || maxContextWindow <= defaultContextWindow
          ? {}
          : { maxContextWindow },
        ...typeof model.maxInputTokens === 'number' && model.maxInputTokens > 0
          ? { maxInputTokens: model.maxInputTokens }
          : {},
      }
    })
  // Catalog provenance rides the document even when the model list is empty:
  // "no models" is precisely the case a user needs explained, and it is the
  // only way to tell a hidden group from a failed fetch.
  const catalog = deps.catalog?.()
  const withCatalog: WorkBuddyWebStatus = catalog === undefined ? status : { ...status, catalog }
  const statusWithModels: WorkBuddyWebStatus = modelsField.length > 0
    ? { ...withCatalog, models: modelsField }
    : withCatalog
  // Probe state rides the signed-in document so the card can render the
  // consent switches and results without a second request. The control key
  // travels with it: this response already passed the loopback guard, and the
  // key authorizes only probe control, never credentials or completions.
  const checkInRecord = deps.checkIn?.()
  const probed: WorkBuddyWebStatus = {
    ...statusWithModels,
    ...deps.probe === undefined ? {} : { probe: deps.probe() },
    ...deps.probeKey === undefined ? {} : { probeKey: deps.probeKey },
    ...deps.useMaximumContextWindow === undefined ? {} : { useMaximumContextWindow: deps.useMaximumContextWindow() },
    ...deps.disabledModels === undefined ? {} : { disabledModels: deps.disabledModels() },
    ...checkInRecord === undefined ? {} : { checkIn: checkInRecord },
    ...deps.activationRequired?.() === true ? { activationRequired: true } : {},
  }
  try {
    const credential = await deps.store.current()
    if (credential !== undefined) {
      const credits = await deps.client.fetchCredits(credential)
      // `unlimited` and `cycleResetTime` ride along as-is: the card must see
      // "no cap" as its own state, and the fetch only sets them when the
      // upstream actually reported them.
      return { ...probed, credits }
    }
  } catch (error: unknown) {
    return { ...probed, creditsError: safeMessage(error) }
  }
  return probed
}

/** The status route's request handler, extracted so tests can mount it on a bare server. */
export function workBuddyStatusHandler(
  deps: WorkBuddyStatusRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      json(res, 200, await workBuddyWebStatus(deps))
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** Mount the GET status route on an optional webServer context. */
export function registerWorkBuddyStatusRoute(ctx: Context, deps: WorkBuddyStatusRouteOptions): void {
  const path = deps.path ?? WORKBUDDY_STATUS_PATH
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path,
      handler: workBuddyStatusHandler(deps),
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddy-connect: Web status route')
}
