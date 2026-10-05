/**
 * A reusable transport for the merged backends whose upstream speaks the
 * OpenAI chat-completions protocol.
 *
 * WHY ONE MODULE. Cline, CodeBuddy and OpenCode differ only in where their base
 * URL, bearer key and model roster come from — the wire protocol, the streaming
 * translation, and the harness seam are identical. Writing that three times
 * would mean three places to fix when the pi-ai profile grows a required field
 * (it gained 'modelErrors' in 0.1.5-alpha.2, and the WorkBuddy adapter carries a
 * note about exactly that cost).
 *
 * WHAT IT DOES NOT DO. It never decides WHERE credentials come from: the caller
 * passes a resolveApiKey that reads the registry, the environment, or another
 * application's login state. That keeps the per-vendor credential rules in the
 * backend that owns them, which is the whole point of the backend split.
 *
 * The key is resolved PER REQUEST, so pi-ai never stores it and an ambient
 * credential lifecycle can never manufacture one. That is why this module uses
 * the inert auth plane rather than pi-ai's own credential store.
 *
 * @module dsh-multibuddy-connect/backends/openai-compat
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, Model, ModelThinkingLevel, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { BackendModelInfo } from './types.ts'

/**
 * Image-request budgets, matching dsh-llm-pi-ai's own defaults.
 *
 * These bound requests to models whose catalog entry declares image support;
 * text-only models never receive an image, so the budget is a ceiling rather
 * than a reservation.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/**
 * Inert pi-ai auth plane.
 *
 * The route authenticates only through resolveApiKey, so pi-ai's own credential
 * lifecycle and ambient discovery must never manufacture one; every question
 * here answers 'nothing stored, nothing set'.
 */
const INERT_AUTH = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-multibuddy-connect: the merged backend routes have no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
} as never

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** Constructor options for one OpenAI-compatible route. */
export interface OpenAiCompatOptions {
  /** Provider id registered with DSH. */
  providerId: string
  /** Display name in the model picker. */
  displayName: string
  /**
   * The base URL, WITHOUT a trailing slash and WITHOUT /chat/completions.
   *
   * A getter because it can change while the process runs: OpenCode's local
   * runtime picks a random port at startup, so the URL is only knowable once
   * its endpoint document has been written.
   */
  baseUrl: () => string
  /** The roster to publish, read live so a catalog refresh takes effect. */
  models: () => readonly BackendModelInfo[]
  /**
   * Resolve the bearer key for the NEXT request.
   *
   * Called per request so a rotated or refreshed credential is picked up
   * without rebuilding the adapter. Throwing is correct when no credential is
   * available: the harness renders the message, which is far better than
   * sending an unauthenticated request and surfacing the vendor's 401.
   */
  resolveApiKey: () => Promise<string>
  /** Attachment store seam. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Stream idle ceiling while one read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Build the picker-visible name, e.g. to append a billing rate. */
  displayNameFor?: (model: BackendModelInfo) => string
}

/** One assembled route. */
export interface OpenAiCompatRoute {
  adapter: PiAiAdapter
  /**
   * Rebuild the pi-ai profile snapshot.
   *
   * PiAiAdapter memoizes its snapshot on the identity of the Map it is handed,
   * so a fresh Map is how a changed roster becomes visible. A fresh Map per read
   * would rebuild the whole collection on every call, hence the explicit signal
   * rather than a computed getter.
   */
  invalidate: () => void
}

/** Map declared effort ids onto pi-ai's thinking-level vocabulary. */
function reasoningFields(model: BackendModelInfo): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  const efforts = model.efforts ?? []
  if (efforts.length === 0) return { reasoning: false }
  const map: Record<ModelThinkingLevel, string | null> = {
    off: efforts.includes('off') ? 'off' : null,
    // Not in the upstream effort vocabulary (EFFORT_VALUES), so no declared set
    // can ever contain it.
    minimal: null,
    low: efforts.includes('low') ? 'low' : null,
    medium: efforts.includes('medium') ? 'medium' : null,
    high: efforts.includes('high') ? 'high' : null,
    xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
    max: efforts.includes('max') ? 'max' : null,
  }
  return { reasoning: true, thinkingLevelMap: map as unknown as ThinkingLevelMap }
}

/**
 * Build one pi-ai model descriptor.
 *
 * @param info - the backend's neutral model description.
 * @param baseUrl - the vendor endpoint this request should reach.
 * @param providerId - the route this model belongs to.
 * @param displayName - the name the picker shows.
 */
function toPiModel(info: BackendModelInfo, baseUrl: string, providerId: string, displayName: string): Model<Api> {
  return {
    id: info.id,
    name: displayName,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: info.supportsImages === true ? ['text', 'image'] : ['text'],
    ...reasoningFields(info),
    cost: NO_COST,
    ...(info.contextWindow === undefined ? {} : { contextWindow: info.contextWindow }),
    ...(info.maxTokens === undefined ? {} : { maxTokens: info.maxTokens }),
    // pi-ai cannot infer a vendor's field spelling from an arbitrary base URL,
    // so name the OpenAI-compatible field explicitly.
    compat: { maxTokensField: 'max_tokens' },
  } as unknown as Model<Api>
}

/**
 * Assemble a route.
 *
 * The profile is constructed by hand rather than through dsh-llm-pi-ai's
 * internal resolveProfiles(): that helper is not part of the package's public
 * export surface, so hand-assembly is the only supported path — and every newly
 * required field must be adopted here explicitly.
 *
 * @param options - the caller-supplied vendor facts.
 * @returns the adapter plus its invalidation signal.
 */
export function createOpenAiCompatRoute(options: OpenAiCompatOptions): OpenAiCompatRoute {
  const { providerId, displayName } = options
  const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 300_000

  const buildModels = (): Model<Api>[] => {
    const baseUrl = options.baseUrl()
    return options.models().map(info => toPiModel(
      info,
      baseUrl,
      providerId,
      options.displayNameFor?.(info) ?? info.name,
    ))
  }

  const base = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: displayName + ' bearer key',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: displayName }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  // getModels is delegated to a live read, so the picker's roster tracks a
  // catalog refresh while stream dispatch still runs through the constructed
  // provider.
  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-multibuddy-connect ' + providerId + ' retryPolicy'),
    configuredMaxTokens: new Map(),
    // Required since 0.1.5-alpha.2; this route reports no per-model failures.
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    // Same duplicate-package cast as the WorkBuddy adapter; see the longer note
    // there. pi-ai is installed twice and only the nested copy's Provider type
    // is accepted here.
    piProvider: provider as unknown as NonNullable<ResolvedPiAiProviderProfile['piProvider']>,
  }

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => options.resolveApiKey(),
    ...(options.resolveAttachments === undefined ? {} : { resolveAttachments: options.resolveAttachments }),
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
    },
  }
}
