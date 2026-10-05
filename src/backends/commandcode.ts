/**
 * Command Code Go — an API-key backend with a native multi-account model.
 *
 * Unlike the desktop-adoption backends, nothing here is read from another
 * application: the credential IS an API key, so the plugin owns it outright.
 * What makes this backend unusual is that the key is not the account — an
 * account is a ROUTE. The upstream plugin declares an `accounts` dictionary in
 * which every key becomes its own provider route with its own key reference,
 * base URL, and output cap, and every route shares ONE scanned catalog. This
 * adapter mirrors that model exactly rather than flattening it to a single
 * key, which is why `multiAccount` is true here and false for Loomy: it is a
 * fact about the vendor's own credential model, not a feature this file adds.
 *
 * Two consequences of that split are load-bearing:
 *
 *  - The catalog is scanned ONCE per adapter and handed to every account. A
 *    per-account scan would multiply an open, unauthenticated request by the
 *    number of keys and could return subtly different catalogs for the same
 *    account set, so the shell would show two accounts different model lists.
 *  - The account id IS the route id, because that is what the registry keys
 *    on, what the usage ledger keys on, and what a user typed when they
 *    configured the route. Renaming it would break all three.
 *
 * The Go plan deliberately has no balance endpoint — the Provider API refuses
 * it outright — so `reportsQuota` is false and the dashboard is told that the
 * absence is permanent rather than a transient failure.
 *
 * @module dsh-workbuddy-connect/backends/commandcode
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { BaseBackendAdapter, type BackendImpl, type DiscoveredAccount } from './base.ts'
import type { BackendDescriptor, BackendModelInfo } from './types.ts'
import { BackendAccountRegistry, maskSecret } from './registry.ts'

/** Provider route id used when nothing is configured; also the default account id. */
export const COMMANDCODE_DEFAULT_ACCOUNT_ID = 'commandcode'

/** Credential reference consulted when an account names none of its own. */
export const COMMANDCODE_API_KEY_ENV = 'COMMANDCODE_API_KEY'

/** Gateway root; the catalog endpoint hangs off it. */
export const COMMANDCODE_BASE_URL = 'https://api.commandcode.ai'

/** The descriptor this backend registers under. */
export const COMMANDCODE_DESCRIPTOR: BackendDescriptor = {
  id: 'commandcode',
  displayName: 'Command Code Go',
  description: 'Command Code Go 套餐（多账号 API Key）',
  brand: { vendor: 'Command Code', product: 'Go' },
  authKind: 'api-key',
  // The upstream plugin's own accounts dictionary: one route per key, each
  // independently configured. N is genuinely unbounded, so declaring this true
  // is a statement about the product rather than a promise about the UI.
  multiAccount: true,
  // A Go 套餐没有公开的余额查询接口: the Provider API answers 403
  // upgrade_required and the /alpha/generate gateway returns no billing data.
  // Saying "not reportable" is honest; a zero would read as an empty account.
  reportsQuota: false,
  reportsTokenUsage: false,
  settingsNs: 'commandcode-go-provider',
  envHint: COMMANDCODE_API_KEY_ENV,
}

/** Context capacity assumed when the listing discloses none. */
const FALLBACK_CONTEXT_WINDOW = 262_144

/** Per-request budget for the open listing endpoint. */
const FETCH_TIMEOUT_MS = 30_000

/** One account route the caller configured. */
export interface CommandCodeAccountOption {
  /** Route id; defaults to the single-account id when omitted. */
  id?: string
  /** Picker label; defaults to the account key, as the upstream plugin does. */
  label?: string
  /** The bearer key itself. */
  secret?: string
  /** Credential reference naming the key, when it lives in the environment. */
  apiKeyEnv?: string
}

/** Construction options, mirroring the upstream plugin's config surface. */
export interface CommandCodeBackendOptions {
  /**
   * Configured routes. Absent or empty means "one default account whose key
   * comes from {@link COMMANDCODE_API_KEY_ENV}", which is the upstream
   * plugin's behaviour for an empty accounts dictionary.
   */
  accounts?: readonly CommandCodeAccountOption[]
  /**
   * Store the plugin owns, when the shell supplies one. Passing a registry the
   * caller also holds lets a settings write land in the store this adapter
   * reads, instead of a private instance that would go stale; omitted, the
   * adapter makes its own — still the plugin's file, never a third-party app's.
   */
  registry?: BackendAccountRegistry
}

/** One resolved account route. */
interface ResolvedAccount {
  id: string
  label: string
  /** Reference to look the key up under, when the account names one. */
  apiKeyEnv?: string
  /** An inline key, which wins over the reference. */
  secret?: string
}

/** One model in the Provider API listing, after the Go filter. */
export interface CommandCodeModel {
  id: string
  name: string
  contextWindow: number
}

/**
 * Reduce the configured routes to the accounts to discover.
 *
 * The deduplication is not cosmetic: two routes sharing an id would collide in
 * the account map, and the LATER one would silently shadow the earlier,
 * leaving a user with a key that appears configured but never authenticates.
 * First wins, matching the upstream dictionary's read order.
 *
 * @param options - the caller's construction options.
 * @returns the routes to discover, in configuration order.
 */
function configuredAccounts(options: CommandCodeBackendOptions): readonly ResolvedAccount[] {
  const declared = options.accounts ?? []
  if (declared.length === 0) {
    return [{
      id: COMMANDCODE_DEFAULT_ACCOUNT_ID,
      label: COMMANDCODE_DESCRIPTOR.displayName,
      apiKeyEnv: COMMANDCODE_API_KEY_ENV,
    }]
  }
  const seen = new Set<string>()
  const out: ResolvedAccount[] = []
  for (const account of declared) {
    const id = account.id !== undefined && account.id !== '' ? account.id : COMMANDCODE_DEFAULT_ACCOUNT_ID
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      // An unnamed route shows its id: a bare product name repeated down the
      // list would make two accounts indistinguishable, while the id is
      // exactly what the user typed when configuring them.
      label: account.label !== undefined && account.label !== '' ? account.label : id,
      apiKeyEnv: account.apiKeyEnv !== undefined && account.apiKeyEnv !== ''
        ? account.apiKeyEnv
        : COMMANDCODE_API_KEY_ENV,
      ...(account.secret === undefined || account.secret === '' ? {} : { secret: account.secret }),
    })
  }
  return out
}

/** Read the opaque secret a registry row holds, tolerating either spelling. */
function secretOf(secret: unknown): { key?: string; apiKeyEnv?: string } {
  if (typeof secret !== 'object' || secret === null || Array.isArray(secret)) return {}
  const record = secret as Record<string, unknown>
  return {
    ...(typeof record['key'] === 'string' && record['key'] !== '' ? { key: record['key'] } : {}),
    ...(typeof record['apiKeyEnv'] === 'string' && record['apiKeyEnv'] !== ''
      ? { apiKeyEnv: record['apiKeyEnv'] }
      : {}),
  }
}

/**
 * Where the model listing cache lives.
 *
 * Under the plugin's OWN data directory, beside the credential registry, and
 * never inside any third-party application's tree — the read-only contract for
 * other vendors' files applies to everything this plugin touches, and a cache
 * is the easiest place to break it by accident.
 *
 * @returns the absolute path of the catalog cache file.
 */
export function commandCodeCatalogPath(): string {
  const dir = process.env['COMMANDCODE_DATA_DIR']
  const root = dir !== undefined && dir !== ''
    ? dir
    : process.env['DSH_WORKBUDDY_DATA_DIR'] ?? join(homedir(), '.dsh-workbuddy-connect')
  return join(root, 'commandcode-go-models.json')
}

/**
 * Model ids the Go plan includes that carry NO `-free` suffix.
 *
 * The listing endpoint is unauthenticated and discloses nothing about plans,
 * so membership cannot be read off it. The `-free` suffix covers the free
 * tier, but the Go plan also grants a handful of PAID-tier models — the
 * upstream project names GPT-5.6 Luna, Grok 4.5, and Muse Spark 1.2
 * Contributor — and filtering on the suffix alone silently removes every one
 * of them. That is not a conservative default; it is the plugin offering less
 * than the subscription the user paid for, with no visible reason why.
 *
 * These ids are therefore listed EXPLICITLY rather than inferred. Matching is
 * on the id's leading segment so a dated variant (`gpt-5.6-luna-2026-01-01`)
 * still resolves to its family entry.
 *
 * The cost of this list is that a NEW paid Go model stays invisible until the
 * list is extended. That is the acceptable direction of error: one model
 * arrives late, rather than five existing ones never arriving at all — and
 * unlike a live cross-source join, it cannot shrink the roster because a CDN
 * served a stale document.
 */
const GO_PLAN_MODEL_FAMILIES: readonly string[] = [
  'gpt-5.6-luna',
  'grok-4.5',
  'muse-spark-1.2-contributor',
]

/**
 * Whether a model id belongs to the Go plan.
 *
 * True for the free tier (the `-free` suffix) and for the paid families the
 * plan explicitly grants (see {@link GO_PLAN_MODEL_FAMILIES}).
 *
 * @param id - the wire model id.
 * @returns true when the Go plan is expected to serve this model.
 */
export function isGoModelId(id: string): boolean {
  const lower = id.toLowerCase()
  if (lower.endsWith('-free')) return true
  return GO_PLAN_MODEL_FAMILIES.some(family => lower === family || lower.startsWith(`${family}-`))
}

/**
 * Read the free-tier ids out of the listing payload.
 *
 * Validates rather than casts, so a vendor changing the envelope shape
 * produces an empty roster instead of a crash: the shell renders "registered,
 * nothing to offer" for the former and a backend failure for the latter.
 *
 * @param payload - the decoded JSON body.
 * @returns the models, sorted by id so the cached document is diff-stable.
 */
export function parseCommandCodeModels(payload: unknown): readonly CommandCodeModel[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
  const data = (payload as Record<string, unknown>)['data']
  if (!Array.isArray(data)) return []
  const models: CommandCodeModel[] = []
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const id = typeof record['id'] === 'string' ? record['id'] : ''
    if (id === '' || !isGoModelId(id)) continue
    const name = typeof record['name'] === 'string' && record['name'] !== '' ? record['name'] : id
    const disclosed = record['context_length'] ?? record['context_window']
    models.push({
      id,
      // One display name is reused by the paid and free tier of a model, so the
      // tier is surfaced in the label; without it two picker rows read
      // identically while billing differently.
      name: /free/i.test(name) ? name : `${name} (free)`,
      contextWindow: typeof disclosed === 'number' && Number.isFinite(disclosed) && disclosed > 0
        ? disclosed
        : FALLBACK_CONTEXT_WINDOW,
    })
  }
  models.sort((left, right) => left.id.localeCompare(right.id))
  return models
}

/** Command Code Go's product-specific half. */
class CommandCodeImpl implements BackendImpl {
  /** The one catalog scan, shared by every account. */
  private scanned: readonly CommandCodeModel[] | undefined
  /** In-flight scan, so N accounts resolving at once issue one request. */
  private scanning: Promise<readonly CommandCodeModel[]> | undefined

  constructor(
    private readonly options: CommandCodeBackendOptions,
    private readonly registry: BackendAccountRegistry,
  ) {}

  /**
   * Resolve every configured route.
   *
   * A route with no key AND no key in the environment resolves as
   * `usable: false`, carrying the reference to set. It is still returned
   * rather than dropped: the route is configured, the user needs to see WHICH
   * reference is missing, and a silently absent row is the one failure a user
   * cannot diagnose. When every route is in that state the list stays
   * "configured but unusable", and registering a route that rejects every
   * request is exactly what the shell must be able to warn about.
   */
  async discover(): Promise<readonly DiscoveredAccount[]> {
    const stored = await this.registry.list(COMMANDCODE_DESCRIPTOR.id)
    const out: DiscoveredAccount[] = []
    for (const account of configuredAccounts(this.options)) {
      const persisted = secretOf(stored.find(entry => entry.id === account.id)?.secret)
      const key = account.secret ?? persisted.key
      const ref = account.apiKeyEnv ?? persisted.apiKeyEnv ?? COMMANDCODE_API_KEY_ENV
      if (key !== undefined) {
        // An inline key is reported as configured and nothing more. This module
        // says WHICH accounts exist and whether a credential is present;
        // judging whether a key is well-formed is the point-of-use job, and a
        // stricter check here would hide a working key behind a rejected one.
        out.push({ id: account.id, label: account.label, detail: maskSecret(key), usable: true })
        continue
      }
      const ambient = process.env[ref]
      if (ambient === undefined || ambient === '') {
        out.push({
          id: account.id,
          label: account.label,
          detail: `未设置 ${ref}`,
          usable: false,
          reason: `未找到 API Key；请设置环境变量 ${ref}，或在设置中填入该账号的 Key。`,
        })
        continue
      }
      out.push({
        id: account.id,
        label: account.label,
        detail: `${ref}：${maskSecret(ambient)}`,
        usable: true,
      })
    }
    return out
  }

  /**
   * The Go plan's models, identical for every account.
   *
   * The catalog is memoized per adapter and the fetch is shared, so resolving
   * five accounts costs one request rather than five. A failed scan yields an
   * empty roster rather than a throw: the picker shows nothing and the next
   * resolve retries.
   */
  async models(): Promise<readonly BackendModelInfo[]> {
    return (await this.scan()).map(model => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
    }))
  }

  /** The memoized catalog, scanning once and de-duplicating concurrent callers. */
  private async scan(): Promise<readonly CommandCodeModel[]> {
    if (this.scanned !== undefined) return this.scanned
    this.scanning ??= this.fetchCatalog().then(
      (models) => {
        this.scanned = models
        this.scanning = undefined
        return models
      },
      () => {
        // Not memoized: a transient network fault must not pin the roster
        // empty for the life of the process, since the user's only recourse
        // would then be a restart.
        this.scanning = undefined
        return []
      },
    )
    return this.scanning
  }

  /** One request to the open listing endpoint. */
  private async fetchCatalog(): Promise<readonly CommandCodeModel[]> {
    const base = process.env['COMMANDCODE_BASE_URL'] ?? COMMANDCODE_BASE_URL
    const response = await fetch(`${base}/provider/v1/models`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Command Code 模型列表返回 HTTP ${response.status}`)
    return parseCommandCodeModels(await response.json())
  }
}

/** Thin subclass so the concrete type names the backend in stack traces. */
class CommandCodeBackend extends BaseBackendAdapter {}

/**
 * The Command Code Go backend, ready to register.
 *
 * @param options - configured routes and the store to read them through.
 * @returns the adapter the shell registers.
 */
export function createCommandCodeBackend(options: CommandCodeBackendOptions = {}): BaseBackendAdapter {
  const registry = options.registry ?? new BackendAccountRegistry()
  return new CommandCodeBackend(COMMANDCODE_DESCRIPTOR, new CommandCodeImpl(options, registry))
}
