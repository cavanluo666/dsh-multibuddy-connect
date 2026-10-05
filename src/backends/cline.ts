/**
 * Cline (免费模型) — an API-key backend.
 *
 * The original plugin (cline-free-provider) is a pi-ai transport: it mints a
 * provider route, scrubs the wire, and streams. Most of that is not this
 * adapter's job, and what it keeps is the part the shell genuinely needs —
 * WHICH accounts exist, WHICH models they can reach, and (through `transport`)
 * where a chat request goes and with which key — still read-only: the catalog
 * is fetched from Cline's public feed, never written back. The original's wire
 * enhancements (OpenRouter reasoning scan, payload sanitation, user-agent
 * override, refusal rewriting) are deliberately left behind for now; the
 * `transport` note lists them, so the omission is a decision rather than an
 * oversight.
 *
 * Cline is a MULTI-ACCOUNT candidate, and the reason is structural rather than
 * aspirational: a Cline credential is a bearer API key, and two keys are two
 * independent accounts upstream (separate rate limits, separate free-tier
 * grants). Nothing in the vendor's model pins a machine to one key the way a
 * desktop app's single login slot does, so multiAccount is true and the
 * accounts arrive from the shared BackendAccountRegistry — this file
 * deliberately does not know where they are stored.
 *
 * reportsQuota is false. Cline's free tier has no balance concept to read: the
 * models are free, the key is the entitlement, and there is no billing endpoint
 * whose absence could be mistaken for "zero left". The dashboard therefore
 * shows the account as "not reportable" rather than charting a zero.
 *
 * @module dsh-workbuddy-connect/backends/cline
 */

import { BaseBackendAdapter, type BackendImpl, type DiscoveredAccount } from './base.ts'
import type { BackendDescriptor, BackendModelInfo, BackendTransport } from './types.ts'

/** Environment variable the original plugin reads the API key from. */
const API_KEY_ENV = 'CLINE_API_KEY'

/**
 * Optional endpoint override, matching the original plugin's baseURL config.
 *
 * Kept as an environment escape hatch rather than a constructor parameter so a
 * self-hosted or proxied Cline deployment can be pointed at without a settings
 * round-trip — the same reasoning as Loomy's file-path overrides.
 */
const BASE_URL_ENV = 'CLINE_BASE_URL'

/** The upstream the original plugin ships against. */
const DEFAULT_BASE_URL = 'https://api.cline.bot/api/v1'

/**
 * Free models the catalog feed does not tag itself.
 *
 * The authoritative source is the recommended-models free bucket, fetched live
 * on every discovery. This list exists because that feed's pricing field
 * describes the upstream market price rather than Cline's own free
 * designation, and the two rotate independently. Copied verbatim from the
 * original plugin — inventing or extending it here would be guessing at a
 * vendor's promotions.
 */
const EXTRA_FREE_MODEL_IDS: ReadonlySet<string> = new Set([
  'deepseek/deepseek-v4-flash',
  'z-ai/glm-5.3-flash',
  'meta/muse-spark-1.3',
])

/** How long any one feed request may take before it is abandoned. */
const FEED_TIMEOUT_MS = 30_000

/** The descriptor this backend registers under. */
export const CLINE_DESCRIPTOR: BackendDescriptor = {
  id: 'cline',
  displayName: 'Cline',
  description: 'Cline 免费模型（API key 认证）',
  brand: { vendor: 'Cline', product: 'Cline' },
  authKind: 'api-key',
  // True because the credential model is a bearer key, of which a user may
  // legitimately hold several. The integration layer supplies them from the
  // credential registry; this adapter only consumes the list.
  multiAccount: true,
  reportsQuota: false,
  reportsTokenUsage: false,
  settingsNs: 'llm-cline',
  envHint: API_KEY_ENV,
  serves: true,
}

/**
 * One account handed to the adapter by the integration layer.
 *
 * Declared structurally rather than imported from the registry so this file
 * stays a leaf: the adapter needs three fields and nothing about how they are
 * stored, which also keeps it testable without touching the disk.
 */
export interface ClineAccountSeed {
  /** Backend-local stable id. */
  id: string
  /** Human label for pickers. */
  label: string
  /** The bearer API key. */
  secret: string
}

/** Construction options for createClineBackend. */
export interface ClineBackendOptions {
  /**
   * The accounts to serve.
   *
   * The integration layer reads these from BackendAccountRegistry. When the
   * list is empty or omitted the adapter falls back to the environment, so a
   * user who merely exports CLINE_API_KEY still gets a working provider
   * without ever opening the settings card.
   */
  accounts?: readonly ClineAccountSeed[]
  /** Endpoint override; defaults to the environment, then the vendor URL. */
  baseUrl?: string
  /** Test seam: replaces the global fetch. */
  fetchImpl?: typeof fetch
}

/** One entry of Cline's model feed, reduced to what the roster needs. */
export interface ClineModelEntry {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  supportsImages?: boolean
}

/** True for a JSON object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A finite positive number, or undefined for anything else. */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Fetch and parse one JSON document from the Cline feed.
 *
 * Throws on a non-2xx or an unparseable body: the caller decides whether that
 * is fatal, because the two feeds differ in importance. The recommended-models
 * bucket is a refinement and may fail alone; the model list IS the roster.
 *
 * @param url - absolute feed URL.
 * @param label - feed name, used in the error message.
 * @param fetchImpl - fetch implementation; injected for tests.
 * @returns the parsed JSON value, shape unknown.
 */
async function fetchJson(url: string, label: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(label + ' 端点返回 HTTP ' + String(response.status))
  return await response.json()
}

/**
 * Read Cline's own free-tier designation.
 *
 * @param baseUrl - the API root.
 * @param fetchImpl - fetch implementation.
 * @returns the designated model ids, or an empty set when the feed is missing
 *   or malformed. Never throws: the suffix-and-extras rule still yields a
 *   usable roster, and losing the whole catalog over an optional refinement
 *   would be the worse failure.
 */
async function fetchFreeModelIds(baseUrl: string, fetchImpl: typeof fetch): Promise<ReadonlySet<string>> {
  try {
    const payload = await fetchJson(baseUrl + '/ai/cline/recommended-models', 'Cline recommended models', fetchImpl)
    if (!isRecord(payload) || !Array.isArray(payload['free'])) return new Set<string>()
    const ids = new Set<string>()
    for (const entry of payload['free']) {
      if (isRecord(entry) && typeof entry['id'] === 'string' && entry['id'] !== '') ids.add(entry['id'])
    }
    return ids
  } catch {
    return new Set<string>()
  }
}

/**
 * Read the free models Cline currently serves.
 *
 * A model counts as free when its feed id carries the :free suffix, when it
 * appears in EXTRA_FREE_MODEL_IDS, or when the recommended-models bucket names
 * it. Bucket ids may use Cline's own cline-free/ namespace, so an exact feed
 * match is tried first and an unambiguous slug match second — an ambiguous slug
 * (two feed entries ending in the same segment) is dropped rather than guessed
 * at, since picking the wrong one would silently offer a paid model as free.
 *
 * @param baseUrl - the API root.
 * @param fetchImpl - fetch implementation.
 * @returns the free models, sorted by id for a stable roster.
 */
async function fetchFreeModels(baseUrl: string, fetchImpl: typeof fetch): Promise<readonly ClineModelEntry[]> {
  const [payload, freeBucketIds] = await Promise.all([
    fetchJson(baseUrl + '/ai/cline/models', 'Cline models', fetchImpl),
    fetchFreeModelIds(baseUrl, fetchImpl),
  ])
  if (!isRecord(payload) || !Array.isArray(payload['data'])) {
    throw new Error('Cline models 端点返回了非预期的结构')
  }
  const rawEntries = payload['data']
  const feedIds = new Set<string>()
  for (const raw of rawEntries) {
    if (isRecord(raw) && typeof raw['id'] === 'string') feedIds.add(raw['id'])
  }
  const freeFeedIds = new Set<string>()
  for (const id of feedIds) {
    if (id.endsWith(':free') || EXTRA_FREE_MODEL_IDS.has(id)) freeFeedIds.add(id)
  }
  for (const bucketId of freeBucketIds) {
    if (feedIds.has(bucketId)) {
      freeFeedIds.add(bucketId)
      continue
    }
    const slug = bucketId.split('/').at(-1)
    if (slug === undefined) continue
    const matches = [...feedIds].filter(id => id.split('/').at(-1) === slug)
    // Exactly one match or nothing: an ambiguous slug means two different
    // upstream models share a name, and choosing either would be a guess.
    if (matches.length === 1) freeFeedIds.add(matches[0]!)
  }
  const models: ClineModelEntry[] = []
  for (const raw of rawEntries) {
    if (!isRecord(raw) || typeof raw['id'] !== 'string') continue
    const id = raw['id']
    if (!freeFeedIds.has(id)) continue
    const name = typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : id
    const contextWindow = positiveNumber(raw['context_length'])
    const topProvider = isRecord(raw['top_provider']) ? raw['top_provider'] : undefined
    const maxTokens = positiveNumber(topProvider?.['max_completion_tokens'])
    const architecture = isRecord(raw['architecture']) ? raw['architecture'] : undefined
    const modalities = architecture !== undefined && Array.isArray(architecture['input_modalities'])
      ? architecture['input_modalities']
      : undefined
    models.push({
      id,
      name,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(modalities !== undefined && modalities.includes('image') ? { supportsImages: true } : {}),
    })
  }
  models.sort((a, b) => a.id.localeCompare(b.id))
  return models
}

/**
 * Mask an API key for display.
 *
 * Mirrors the shared maskSecret rule without importing it: this adapter must
 * stay a leaf, and pinning the rendering keeps a key identifiable in the
 * picker (sk-a...1b2c) while revealing too little to be worth stealing. A short
 * key is masked entirely, because a six-character value has no safe window.
 *
 * @param secret - the raw key.
 * @returns a display-safe rendering.
 */
function maskKey(secret: string): string {
  if (secret.length <= 12) return '•'.repeat(Math.max(4, secret.length))
  return secret.slice(0, 4) + '…' + secret.slice(-4)
}

/**
 * Resolve the accounts to serve.
 *
 * The injected list wins outright — an empty-but-present list from the registry
 * means the user has configured accounts, just none right now, and silently
 * resurrecting an environment key would show an account the user believes they
 * removed. Only a genuinely ABSENT list falls back to CLINE_API_KEY.
 *
 * @param options - the factory options.
 * @returns the accounts to report, in the order given.
 */
function resolveAccounts(options: ClineBackendOptions): readonly ClineAccountSeed[] {
  if (options.accounts !== undefined) return options.accounts
  const fromEnv = process.env[API_KEY_ENV]
  if (fromEnv === undefined || fromEnv.trim() === '') return []
  return [{ id: 'default', label: 'CLINE_API_KEY', secret: fromEnv.trim() }]
}

/**
 * The API root in force.
 *
 * Precedence runs constructor, then environment, then the vendor default: the
 * integration layer's explicit choice beats an ambient variable, and the
 * variable beats a hardcoded host so a proxy can be slotted in without a
 * rebuild.
 *
 * @param options - the factory options.
 * @returns an absolute base URL without a trailing slash.
 */
function resolveBaseUrl(options: ClineBackendOptions): string {
  const explicit = options.baseUrl ?? process.env[BASE_URL_ENV]
  const trimmed = explicit === undefined ? '' : explicit.trim().replace(/\/+$/u, '')
  return trimmed === '' ? DEFAULT_BASE_URL : trimmed
}

/** Cline's product-specific half. */
class ClineImpl implements BackendImpl {
  constructor(
    private readonly accounts: readonly ClineAccountSeed[],
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /**
   * Report the injected accounts.
   *
   * There is no third-party application to probe and therefore no "unavailable"
   * state: Cline is reached over the network with a key, so the only two
   * outcomes are "keys exist" and "no keys". An account whose key is blank is
   * reported unusable rather than dropped, so the picker can explain why the row
   * is inert instead of leaving the user wondering where it went.
   *
   * @returns one entry per configured account.
   */
  async discover(): Promise<readonly DiscoveredAccount[]> {
    const out: DiscoveredAccount[] = []
    for (const account of this.accounts) {
      const secret = account.secret.trim()
      if (secret === '') {
        out.push({ id: account.id, label: account.label, usable: false, reason: 'API key 为空' })
        continue
      }
      out.push({ id: account.id, label: account.label, detail: maskKey(secret), usable: true })
    }
    return out
  }

  /**
   * List the free models for one account.
   *
   * The roster is upstream's, not per-account: Cline's free catalog is keyed by
   * account tier upstream, but the public feed this reads is not partitioned by
   * key, so every account legitimately sees the same list. An unreachable feed
   * returns nothing rather than throwing — the base class renders an empty
   * roster as "registered, nothing to offer", which is the honest answer when
   * the catalog cannot be read.
   *
   * @param _accountId - unused; accepted to satisfy the interface.
   * @returns the free models, or none when the feed is unreachable.
   */
  async models(_accountId: string): Promise<readonly BackendModelInfo[]> {
    try {
      return await fetchFreeModels(this.baseUrl, this.fetchImpl)
    } catch {
      return []
    }
  }

  /**
   * The account seed that should serve `accountId`.
   *
   * An exact id match is the normal path. A BLANK id means the caller has no
   * preference — BackendAdapter.transport documents that case as "the first
   * discovered account" — so the first seed answers rather than the whole
   * registration failing over a technicality.
   *
   * Any OTHER unknown id answers undefined, and `transport` turns that into "no
   * provider registered for Cline". Falling back to some other account anyway
   * would authenticate the request as whoever happens to be first, and a silent
   * identity mix-up is far worse than a backend that visibly does not serve the
   * account that was asked for.
   *
   * @param accountId - the account the shell asked to serve.
   * @returns the matching seed, or undefined when this adapter holds none.
   */
  private accountFor(accountId: string): ClineAccountSeed | undefined {
    const id = accountId.trim()
    if (id === '') return this.accounts[0]
    return this.accounts.find(account => account.id === id)
  }

  /**
   * The OpenAI-compatible route Cline serves.
   *
   * Every vendor fact comes from state this adapter already holds rather than
   * from a second implementation of the same scan: the endpoint is the one
   * resolveBaseUrl settled (constructor, then CLINE_BASE_URL, then the vendor
   * default), the key is the seed belonging to `accountId`, and the roster is
   * `models()` — the very same live free-model scan the picker reads, so the
   * two can never disagree about which models exist. Cline's public catalog is
   * not partitioned by key, so the roster is legitimately account-independent;
   * only the key changes with `accountId`.
   *
   * `resolveApiKey` re-reads its account on EVERY call instead of closing over
   * one seed's secret. Capturing the string here is exactly the failure the
   * per-request contract exists to prevent: once the registry replaces or
   * rotates that key, a captured value would keep authenticating with the dead
   * one until the process restarts, which the user experiences as "it worked
   * yesterday". Re-looking up is cheap, and the closure stays correct even if
   * the seed list ever becomes live.
   *
   * A seed that exists but carries no usable secret still yields a transport:
   * resolveApiKey then THROWS, and the harness renders that message. That is
   * deliberate — letting the request go out unauthenticated would surface
   * Cline's 401, which reports the vendor's verdict instead of the missing key
   * the user can actually fix (the rule documented on
   * OpenAiCompatOptions.resolveApiKey).
   *
   * NOT ported from the original plugin: its OpenRouter reasoning scan,
   * `reasoning_effort` payload sanitation, forced Cline user-agent, and 401/403
   * refusal-message rewriting. Each compensates for a specific free-tier
   * behaviour that this plugin cannot exercise here; a basic route is what this
   * layer owes, and an enhancement can be adopted individually once a real
   * request proves it necessary. `displayNameFor` is omitted for the same kind
   * of reason: the free-tier roster carries no per-model rate, so there is
   * nothing honest to append to a model's name.
   *
   * @param accountId - the account to serve; blank means "no preference".
   * @returns the transport, or undefined when no such account is held, in which
   *   case the shell registers no provider for Cline.
   */
  async transport(accountId: string): Promise<BackendTransport | undefined> {
    if (this.accountFor(accountId) === undefined) return undefined
    return {
      baseUrl: this.baseUrl,
      resolveApiKey: async (): Promise<string> => {
        // Resolved per request, never captured — see the note above.
        const account = this.accountFor(accountId)
        if (account !== undefined) {
          const secret = account.secret.trim()
          if (secret !== '') return secret
        }
        const which = account?.label ?? (accountId.trim() === '' ? '当前账号' : accountId.trim())
        throw new Error('Cline：账号 "' + which + '" 没有可用的 API key；请在设置卡中保存该密钥，或导出 ' + API_KEY_ENV + '。')
      },
      models: await this.models(accountId),
    }
  }
}

/** Thin subclass so the concrete type names the backend in stack traces. */
class ClineBackend extends BaseBackendAdapter {}

/**
 * The Cline backend, ready to register.
 *
 * @param options - injected accounts, endpoint, and fetch seam.
 * @returns the adapter, with accounts resolved from the registry or environment.
 */
export function createClineBackend(options: ClineBackendOptions = {}): BaseBackendAdapter {
  return new ClineBackend(
    CLINE_DESCRIPTOR,
    new ClineImpl(resolveAccounts(options), resolveBaseUrl(options), options.fetchImpl ?? fetch),
  )
}
