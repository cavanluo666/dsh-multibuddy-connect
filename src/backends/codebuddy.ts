/**
 * CodeBuddy (腾讯) — a desktop-adoption backend.
 *
 * The CodeBuddy desktop client / official extension keeps its sign-in in a
 * `*.info` document under CodeBuddyExtension's data directory. That file is
 * read here, READ-ONLY. This is the one place where the read-only rule is not
 * merely a matter of correctness but of NOT BREAKING THE USER'S APP: the
 * original plugin refreshes an expiring access token and writes the new one
 * back into the same document. Doing that here would mean the plugin owns a
 * write path into another application's credential store — a corrupt or racing
 * write signs the desktop app out, which is a far worse outcome than this
 * adapter reporting the account as unusable. So an expired token is never
 * REPAIRED ON DISK: signing in again in the desktop app is the only thing that
 * changes the file, and nothing here ever needs reinstalling.
 *
 * 续期只发生在内存里。transport 的 `resolveApiKey` 会在 token 到达（或接近）过期时
 * 刻调 `/v2/plugin/auth/token/refresh` 换一个新 token，并把它留在进程内存里：桌面端
 * 的文件依然一个字节都不写，「严格只读」这条底线因此完好，而一个跑了很久的会话也
 * 不会因为 token 中途过期而卡死。刷新失败时报的是「请重新登录」，而不是把一个上游
 * 401 抛给用户。两个状态刻意分开：`usable` 描述的是**文件**（文件里的 token 一过期
 * 就一直 `usable: false`），transport 描述的是**这条路由现在还能不能干活**（见
 * {@link CodeBuddyImpl.transport}）。
 *
 * CodeBuddy and WorkBuddy share Tencent's account system, and the original
 * plugin deliberately reads whichever `*.info` it finds first rather than
 * insisting on one product's directory. That behaviour is kept: the account is
 * adopted from the local desktop login, whichever of the two placed it there.
 *
 * multiAccount is false because the desktop client holds a single login slot —
 * a statement about the vendor's credential model rather than a limitation of
 * this adapter.
 *
 * reportsQuota is false, and that is a finding rather than a default. The
 * original implementation exposes exactly one authenticated backend call
 * (`POST /v2/chat/completions`); the only other endpoint it knows is
 * `/v2/plugin/auth/token/refresh`, which mints tokens and reports no balance.
 * Quota reaches the client solely as a mid-request business error (code 14012
 * "企业版额度不足"), i.e. the vendor tells you when you have none left, never
 * how much remains. Charting that would mean inventing a number, so the
 * dashboard is told to show the account as not-reportable instead.
 *
 * @module dsh-workbuddy-connect/backends/codebuddy
 */

import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BaseBackendAdapter, BackendUnavailable, messageOf, type BackendImpl, type DiscoveredAccount } from './base.ts'
import type { BackendDescriptor, BackendModelInfo, BackendTransport } from './types.ts'

/** Environment override naming an explicit credential file. */
const AUTH_FILE_ENV = 'CODEBUDDY_AUTH_FILE'

/** Environment override naming an explicit auth directory. */
const AUTH_DIR_ENV = 'CODEBUDDY_AUTH_DIR'

/** Suffix of the desktop client's credential documents. */
const AUTH_FILE_SUFFIX = '.info'

/** Login domain assumed when the credential carries none. */
const DEFAULT_DOMAIN = 'www.codebuddy.cn'

/** 后端 origin：聊天与刷新共用同一台主机，只有路径不同。 */
const BACKEND_ORIGIN = 'https://copilot.tencent.com'

/**
 * OpenAI 兼容的 base URL，**不含** `/chat/completions`。
 *
 * 上游路由是 `/v2/chat/completions`，最后一段由 SDK 自己补上，所以这里必须停在
 * `/v2`。把完整路径交出去会拼成 `/v2/chat/completions/chat/completions` —— 这种错误
 * 在注册阶段看不出来，只在用户发出第一条消息时才会暴露。
 */
const CHAT_BASE_URL = BACKEND_ORIGIN + '/v2'

/** 刷新令牌的端点；它只签发新 token，不报告任何余额。 */
const REFRESH_URL = BACKEND_ORIGIN + '/v2/plugin/auth/token/refresh'

/**
 * 单次刷新请求的超时上限。
 *
 * 刷新发生在请求路径上（用户正等着回复），一次挂起的网络不能把整轮对话钉住。
 */
const REFRESH_TIMEOUT_MS = 15_000

/**
 * 刷新请求自报的 User-Agent。
 *
 * 端点认的是 `X-Refresh-Token` 而不是 UA，但兄弟路径（WorkBuddy，见
 * `src/upstream.ts`）同样自报身份而不伪装桌面端，而「本插件」是能兑现的说法。刻意
 * 不复制桌面客户端的指纹：那是本适配器背书不了的声明。
 */
const REFRESH_USER_AGENT = 'dsh-multibuddy-connect'

/**
 * 刷新响应既没给 `expiresAt` 也没给 `expiresIn` 时，假定的新 token 寿命。
 *
 * 刻意取短。另一种做法 —— 把「没写过期时间」当成「永不过期」—— 会让新 token 在
 * 进程生命周期内一直被复用、连文件都不再重读，于是一个已经作废的 token 会一路 401
 * 到重启为止。十分钟的代价只是厂商两个字段都缺失时多刷新一次；而参考实现用
 * `Date.now()` 兜底，反而会把一个完全可用的新 token 当场判死。
 */
const REFRESH_FALLBACK_TTL_MS = 10 * 60_000

/**
 * How long before expiry an access token is treated as spent.
 *
 * The original plugin refreshes 60s ahead. Without a write path this margin
 * only decides whether the account is labelled usable, and 60s is the smallest
 * honest number: it is short enough that a live credential is not written off,
 * and long enough that a token about to die mid-request is reported now rather
 * than after a failed turn.
 */
const EXPIRY_MARGIN_MS = 60_000

/** Recursion bound for the auth-directory scan (see {@link infoFileCandidates}). */
const MAX_SCAN_DEPTH = 3

/** Directory entries examined per level, bounding a pathological auth tree. */
const MAX_SCAN_ENTRIES = 500

/** Subdirectory holding the extension's public data inside the app data root. */
const EXTENSION_DATA_DIR = 'CodeBuddyExtension'

/**
 * Default per-request output cap, mirroring the original plugin.
 *
 * A product manifest normally states the real value per model; this is the
 * fallback for the built-in `auto` entry and for manifests that omit it.
 */
const DEFAULT_MAX_TOKENS = 64_000

/** Context capacity assumed for a model no manifest describes. */
const DEFAULT_CONTEXT_WINDOW = 1_000_000

/**
 * Reasoning efforts the CodeBuddy backend accepts.
 *
 * Declared on every model because the wire request carries `reasoning_effort`
 * for all of them — the backend streams reasoning regardless of the model name,
 * so gating this per model would invent a distinction the vendor does not make.
 */
const REASONING_EFFORTS: readonly string[] = ['off', 'low', 'high', 'max']

/**
 * Built-in roster, used when no official client manifest can be read.
 *
 * Deliberately minimal, for the same reason the original plugin keeps only
 * `auto`: it is the one id guaranteed to survive a subscription change. A
 * longer hand-written list would go stale silently and then fail every turn
 * that picked an id the account no longer has.
 */
const FALLBACK_MODELS: readonly BackendModelInfo[] = [
  { id: 'auto', name: 'Auto', contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
]

/** Identity of the account taken from the credential document's account block. */
interface CodeBuddyIdentity {
  /** Stable backend-local id, used as the account key. */
  id: string
  /** Human label for pickers. */
  label: string
  /** Where the identity came from, for the detail line. */
  source: 'uid' | 'enterprise' | 'file'
  /**
   * 租户内的用户 id。
   *
   * 不用于展示（展示走 {@link maskId} 处理过的 label），而是刷新请求的 `x-user-id`
   * 身份头：缺了它，刷新端点无法把「给谁续期」和这次会话对上。
   */
  uid?: string
  /** 企业 id；同样是刷新请求的身份头（`x-enterprise-id` / `x-tenant-id`）。 */
  enterpriseId?: string
}

/** The descriptor this backend registers under. */
export const CODEBUDDY_DESCRIPTOR: BackendDescriptor = {
  id: 'codebuddy',
  displayName: 'CodeBuddy',
  description: '腾讯 CodeBuddy 桌面端内置模型',
  brand: { vendor: '腾讯', product: 'CodeBuddy' },
  authKind: 'desktop-adoption',
  // One desktop login slot; CodeBuddy and WorkBuddy share it, so there is no
  // second account this installation could hold.
  multiAccount: false,
  // No balance endpoint exists upstream; see the module header.
  reportsQuota: false,
  reportsTokenUsage: false,
  settingsNs: 'llm-codebuddy',
  serves: true,
}

/**
 * Candidate auth directories, computed fresh on every call.
 *
 * Read lazily rather than captured at module load so a test (or a user) that
 * sets `LOCALAPPDATA` before the first probe still gets the right answer.
 *
 * All three platform layouts are enumerated rather than branching on
 * `process.platform`, matching the sibling Loomy and MiMo backends: a moved or
 * cross-platform-synced install is then still found, and there is no branch to
 * get wrong.
 *
 * @returns candidate directories, most likely first.
 */
export function codeBuddyAuthDirs(): readonly string[] {
  const home = homedir()
  const dirs: string[] = []

  const local = process.env['LOCALAPPDATA']
  if (local !== undefined && local !== '') {
    dirs.push(join(local, EXTENSION_DATA_DIR, 'Data', 'Public', 'auth'))
  }
  dirs.push(join(home, 'AppData', 'Local', EXTENSION_DATA_DIR, 'Data', 'Public', 'auth'))

  // macOS layout.
  dirs.push(join(home, 'Library', 'Application Support', EXTENSION_DATA_DIR, 'Data', 'Public', 'auth'))

  // Linux/XDG layout.
  const xdg = process.env['XDG_DATA_HOME']
  if (xdg !== undefined && xdg !== '') dirs.push(join(xdg, EXTENSION_DATA_DIR, 'Data', 'Public', 'auth'))
  dirs.push(join(home, '.local', 'share', EXTENSION_DATA_DIR, 'Data', 'Public', 'auth'))

  return [...new Set(dirs)]
}

/**
 * The credential file the original implementation would have used.
 *
 * Exposed separately from the scan because the two produce different facts:
 * "the client is not installed" versus "the client is installed but signed
 * out". Only the second may be reported as signed-out.
 *
 * @returns the absolute path of the first `*.info` file, or undefined.
 */
export async function findCodeBuddyAuthFile(): Promise<string | undefined> {
  const override = process.env[AUTH_FILE_ENV]
  if (override !== undefined && override !== '') return existsSync(override) ? override : undefined

  const candidates = await infoFileCandidates()
  return candidates[0]
}

/**
 * Enumerate candidate credential files under {@link codeBuddyAuthDirs}.
 *
 * The original implementation reads only the top level of each directory. That
 * is fine for the layout CodeBuddy currently ships, but "no usable login" and
 * "no login file where we happened to look" are indistinguishable from the
 * outside, and only one of them is true. A shallow, bounded walk costs one
 * `readdir` on a directory that holds a handful of entries and turns a silent
 * miss into a hit — while the entry and depth caps keep a pathological tree
 * from stalling startup.
 *
 * Sorted for determinism: two runs on the same machine must pick the same
 * account, otherwise an unrelated file appearing (a second WorkBuddy profile)
 * would silently switch which account the dashboard is showing.
 *
 * @returns absolute paths, top-level files first, then deeper ones.
 */
async function infoFileCandidates(): Promise<readonly string[]> {
  const overrideDir = process.env[AUTH_DIR_ENV]
  const roots = overrideDir !== undefined && overrideDir !== ''
    ? [overrideDir, ...codeBuddyAuthDirs()]
    : codeBuddyAuthDirs()

  const found: string[] = []
  const seen = new Set<string>()

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      // Absent or unreadable root: neither is a fault of the plugin, and both
      // are reported by the caller as "not installed" only after EVERY root has
      // been ruled out.
      return
    }
    for (const entry of entries.slice(0, MAX_SCAN_ENTRIES)) {
      const full = join(dir, entry)
      if (entry.endsWith(AUTH_FILE_SUFFIX)) {
        if (seen.has(full)) continue
        seen.add(full)
        found.push(full)
        continue
      }
      if (depth >= MAX_SCAN_DEPTH) continue
      // Only descend into directories; a symlink loop or a special file would
      // otherwise be followed on every refresh.
      let isDirectory = false
      try {
        isDirectory = (await stat(full)).isDirectory()
      } catch {
        continue
      }
      if (!isDirectory) continue
      await walk(full, depth + 1)
    }
  }

  for (const root of roots) await walk(root, 1)
  return found
}

/** A parsed CodeBuddy credential, reduced to what this adapter needs. */
export interface CodeBuddyCredential {
  /** Bearer token the backend accepts. */
  accessToken: string
  /**
   * 用来换新 accessToken 的令牌；文件里没有时是空串。
   *
   * 只有内存续期用得到它。空串是一个必须能报出去的事实：token 一旦过期，除了在
   * 桌面端重新登录就没有别的出路，所以它不能悄悄退化成一次上游 401。
   */
  refreshToken: string
  /**
   * Epoch-millisecond expiry, or 0 when the document did not state one.
   *
   * Zero means UNKNOWN, not expired: refusing an account whose file simply
   * omits the field would lock out a working login on a vendor format change.
   * The one thing that is checked is a stated expiry that has passed.
   */
  expiresAt: number
  /** Optional login domain; selects the regional backend upstream. */
  domain?: string
  /** The account identity the credential states. */
  identity: CodeBuddyIdentity
}

/** A JSON object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty trimmed string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Derive the account identity from the credential document.
 *
 * `uid` is preferred because it is the per-person key the other backends in
 * this catalogue also use; `enterpriseId` identifies a tenant, which two
 * colleagues share, so it is usable but weaker. When neither is present the
 * account is keyed off its FILE NAME: a doc with no identity at all still needs
 * a stable key, and the file is what made it discoverable — inventing a
 * placeholder id would collide across machines in the ledger.
 *
 * @param document - the parsed credential document.
 * @param file - the path it was read from, used for the file-derived key.
 * @returns the identity.
 */
function identityOf(document: Record<string, unknown>, file: string): CodeBuddyIdentity {
  const account = isRecord(document['account']) ? document['account'] as Record<string, unknown> : {}
  const uid = nonEmptyString(account['uid'])
  const enterpriseId = nonEmptyString(account['enterpriseId'])
  const nickname = nonEmptyString(account['nickname'])

  const key = uid ?? enterpriseId ?? fileBaseName(file)
  return {
    id: key,
    // The nickname is a display label the vendor itself provides; falling back
    // to the id keeps the row identifiable without leaking a token.
    label: nickname ?? (uid !== undefined ? 'CodeBuddy · ' + maskId(uid) : 'CodeBuddy 账号'),
    source: uid !== undefined ? 'uid' : enterpriseId !== undefined ? 'enterprise' : 'file',
    // 这两个 id 只服务于刷新请求的身份头（见 CodeBuddyIdentity）。用条件展开而不是
    // 写 undefined，是因为 exactOptionalPropertyTypes 下两者并不等价。
    ...(uid === undefined ? {} : { uid }),
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
  }
}

/** The credential file's base name without its `.info` suffix. */
function fileBaseName(file: string): string {
  const base = file.split(/[\\/]/u).pop() ?? file
  return base.endsWith(AUTH_FILE_SUFFIX) ? base.slice(0, -AUTH_FILE_SUFFIX.length) : base
}

/**
 * Mask an identifier for display.
 *
 * Idempotent on an already-masked value, for the same reason Loomy's phone
 * masker is: one build may store the raw id and another the masked form, and
 * re-masking the masked string would destroy characters the user recognises.
 *
 * A SHORT identifier is masked entirely rather than passed through. The
 * earlier "return it unchanged when it is short" branch looked harmless and was
 * the opposite: a 6-character id is exactly what a staff number or a short
 * tenant handle looks like, and it was the one input the function rendered in
 * full. There is no safe window to show in a value that short, so none is
 * shown — the row still identifies the account by its backend and nickname.
 *
 * @param value - raw or already-masked identifier.
 * @returns the masked form; never the raw input.
 */
export function maskId(value: string): string {
  if (value.includes('*')) return value
  if (value.length <= 6) return '•'.repeat(Math.max(4, value.length))
  return value.slice(0, 3) + '****' + value.slice(-3)
}

/**
 * Parse one CodeBuddy `*.info` document.
 *
 * Returns undefined for anything that cannot yield a usable bearer token —
 * malformed JSON, a JSON scalar, an empty `auth` block, a document whose access
 * token is missing. A parse failure is a definite answer about THIS file, and
 * the caller must not paper over it by trying a different source.
 *
 * @param text - raw file contents.
 * @param file - the path it was read from, used for the file-derived key.
 * @returns the credential, or undefined when unusable.
 */
export function parseCodeBuddyAuth(text: string, file = ''): CodeBuddyCredential | undefined {
  let parsed: unknown
  try {
    // The desktop client writes with a BOM on some builds; JSON.parse rejects
    // it and the account would silently vanish.
    parsed = JSON.parse(text.replace(/^\uFEFF/u, ''))
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined

  const auth = isRecord(parsed['auth']) ? parsed['auth'] as Record<string, unknown> : {}
  const accessToken = nonEmptyString(auth['accessToken'])
  if (accessToken === undefined) return undefined
  // 缺失的刷新令牌不算解析失败：access token 还活着时账号完全可用，只是过期后必须
  // 由用户重新登录。
  const refreshToken = nonEmptyString(auth['refreshToken']) ?? ''

  const expiresAt = typeof auth['expiresAt'] === 'number' && Number.isFinite(auth['expiresAt'])
    ? auth['expiresAt']
    : 0
  const domain = nonEmptyString(auth['domain'])

  return {
    accessToken,
    refreshToken,
    expiresAt,
    ...(domain === undefined ? {} : { domain }),
    identity: identityOf(parsed, file),
  }
}

/**
 * 一个「明确声明过的」过期时刻是否已经到达（或即将到达）。
 *
 * 抽成独立函数，是因为内存里刷新出来的 token 只有 `expiresAt`、没有完整的凭据文档，
 * 却必须和文件里的 token 用同一条规则判断过期 —— 两条规则迟早会分叉，而分叉的表现
 * 是「内存里的 token 明明死了还在用」。
 */
function expiryReached(expiresAt: number, nowMs: number): boolean {
  // 未声明的过期时间是「未知」，不是「已过期」；只有明确且已过的时刻才算作废。
  return expiresAt > 0 && nowMs + EXPIRY_MARGIN_MS >= expiresAt
}

/** Whether a stated expiry has already passed (or is about to). */
export function isExpired(credential: CodeBuddyCredential, nowMs = Date.now()): boolean {
  return expiryReached(credential.expiresAt, nowMs)
}

/**
 * Locate the official client's `product.json` manifests.
 *
 * Roots are the same ones the original implementation scans: the VSCode-family
 * extension directories plus CodeBuddy's own. Names are matched loosely (any
 * directory mentioning the official publisher AND `product.json` present)
 * rather than against the exact `tencent-cloud.coding-copilot-<version>`
 * prefix, because the publisher renames its extension folder between releases
 * and a rename would otherwise silently downgrade every model to the fallback
 * capacities.
 *
 * @returns candidate manifest paths, newest-looking name first.
 */
export function codeBuddyProductCandidates(): readonly string[] {
  const home = homedir()
  const local = process.env['LOCALAPPDATA']
  const roots = [
    join(home, '.vscode', 'extensions'),
    join(home, '.vscode-insiders', 'extensions'),
    join(home, '.codebuddy', 'extensions'),
  ]
  if (local !== undefined && local !== '') roots.push(join(local, EXTENSION_DATA_DIR, 'extensions'))
  roots.push(join(home, 'AppData', 'Local', EXTENSION_DATA_DIR, 'extensions'))
  roots.push(join(home, 'Library', 'Application Support', EXTENSION_DATA_DIR, 'extensions'))
  return [...new Set(roots)]
}

/** One entry of an official manifest's `models` array. */
interface ProductModelWire {
  id?: unknown
  name?: unknown
  maxInputTokens?: unknown
  maxOutputTokens?: unknown
  supportsImages?: unknown
  supportsExtra?: unknown
}

/** A positive safe integer wire value, or undefined. */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Parse an official manifest's `models` array into the neutral vocabulary.
 *
 * Two filters are load-bearing and both come from the original implementation:
 * `productName` must literally be `CodeBuddy`, so an unrelated extension's
 * manifest in the same directory cannot masquerade as the roster; and rows
 * carrying `supportsExtra` are dropped because they are completion/auxiliary
 * entries that cannot serve a chat turn — offering one in the picker would
 * produce a model that fails on first use.
 *
 * @param product - the parsed `product.json` value.
 * @returns the models it declares, or undefined when this is not the manifest.
 */
export function parseCodeBuddyModels(product: unknown): readonly BackendModelInfo[] | undefined {
  if (!isRecord(product)) return undefined
  if (product['productName'] !== 'CodeBuddy') return undefined
  const rows = product['models']
  if (!Array.isArray(rows)) return undefined

  const models: BackendModelInfo[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!isRecord(row)) continue
    const entry = row as ProductModelWire
    const id = nonEmptyString(entry.id)
    if (id === undefined || seen.has(id)) continue
    if (entry.supportsExtra === true) continue
    seen.add(id)
    models.push({
      id,
      name: nonEmptyString(entry.name) ?? id,
      // Only a stated capacity is published. Defaulting a missing one here
      // would claim a 1M context the harness would then use to size
      // compaction — a wrong number is worse than an absent one.
      ...(positiveInteger(entry.maxInputTokens) === undefined ? {} : { contextWindow: positiveInteger(entry.maxInputTokens) as number }),
      ...(positiveInteger(entry.maxOutputTokens) === undefined ? {} : { maxTokens: positiveInteger(entry.maxOutputTokens) as number }),
      ...(entry.supportsImages === true ? { supportsImages: true } : {}),
      efforts: REASONING_EFFORTS,
    })
  }
  return models.length > 0 ? models : undefined
}

/**
 * Read the first readable official manifest.
 *
 * Scanning is separate from parsing so a broken or renamed manifest falls
 * through to the next candidate rather than collapsing the whole roster.
 *
 * @returns the models from the best manifest found, or undefined.
 */
async function readOfficialModels(): Promise<readonly BackendModelInfo[] | undefined> {
  for (const root of codeBuddyProductCandidates()) {
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      continue
    }
    // Descending name order approximates "newest extension version first", the
    // ordering the original implementation derives from the directory's version
    // suffix. Exact comparison is not worth re-deriving here: the manifests of
    // successive versions agree on the fields this adapter publishes.
    const dirs = entries.filter(entry => entry.includes('coding-copilot')).sort().reverse()
    for (const dir of dirs) {
      const file = join(root, dir, 'product.json')
      let raw: string
      try {
        raw = await readFile(file, 'utf8')
      } catch {
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      const models = parseCodeBuddyModels(parsed)
      if (models !== undefined) return models
    }
  }
  return undefined
}

/**
 * 内存里刷新过的 token。
 *
 * 只活在进程内：本插件对第三方应用严格只读，刷新结果**不回写**桌面端的凭据文件
 * （见模块头）。因为不落盘，`accountId` 必须一起记住 —— 用户在桌面端重新登录成另
 * 一个账号后，属于旧账号的内存 token 不能再被复用。
 */
interface MemoryToken {
  /** 凭据身份 id；换了账号即失效。 */
  accountId: string
  /** 本次请求要带的 bearer key。 */
  accessToken: string
  /** Epoch 毫秒；0 视为未知，与文件里的语义一致。 */
  expiresAt: number
  /** 刷新令牌会轮换，下一次刷新要用最新的这一个。 */
  refreshToken: string
}

/** 刷新响应里能用得上的字段，全部逐项校验过。 */
interface RefreshResult {
  accessToken: string
  /** 只在厂商轮换了刷新令牌时才存在。 */
  refreshToken?: string
  /** Epoch 毫秒。 */
  expiresAt: number
}

/** 一个正数，或 undefined。 */
function positiveFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * 按顺序读取并解析每一个候选凭据文件。
 *
 * 凭据读取只发生在这一处：discover 要列账号，transport 每次请求要取 token，两处各写
 * 一遍解析循环迟早会分叉（比如新字段只有一处学会读）。一个候选文件都没有时抛
 * {@link BackendUnavailable} —— 那是「客户端没装」而不是「没登录」，只有前者配得上
 * 那句安装提示。
 *
 * @returns 所有能解析出 token 的凭据，按候选顺序。
 */
async function readCredentials(): Promise<readonly CodeBuddyCredential[]> {
  const files = await infoFileCandidates()

  if (files.length === 0) {
    // Not one credential file anywhere. That is the missing prerequisite —
    // there is no app to sign into — so it earns the actionable hint, and it
    // is the ONLY case that does. Reporting an empty array here would show a
    // "signed out, go sign in" card on a machine where signing in is
    // impossible without first installing the client.
    throw new BackendUnavailable(
      '未检测到腾讯 CodeBuddy 桌面端的登录状态；请先安装并登录 CodeBuddy（或 WorkBuddy）桌面端，登录后重新连接。',
    )
  }

  const credentials: CodeBuddyCredential[] = []
  for (const file of files) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const credential = parseCodeBuddyAuth(text, file)
    if (credential !== undefined) credentials.push(credential)
  }
  return credentials
}

/**
 * 读一次刷新响应，成功时给出新 token 的事实。
 *
 * 只有 `code === 0` 且真的带回 accessToken 才算成功。刷新端点和聊天端点共用同一套
 * 信封，「HTTP 200」本身不是成功：把它当成功会让路由带着一个空 key 出去，用户看到的
 * 会是厂商的 401，而不是这里本来就能说清楚的「请重新登录」。
 *
 * `expiresAt` 按 epoch 毫秒解读，与凭据文件里的字段同一套单位（见
 * {@link parseCodeBuddyAuth} / {@link isExpired}）；部分部署只给秒级的 `expiresIn`，
 * 两种都认。两个字段都没有时退回 {@link REFRESH_FALLBACK_TTL_MS}。
 *
 * @param response - 刷新端点的响应。
 * @returns 新 token 及其过期时刻。
 */
async function readRefreshResult(response: Response): Promise<RefreshResult> {
  let text = ''
  try {
    text = await response.text()
  } catch {
    // 读不动的响应体不影响判断：下面按「没有 data」处理，状态码仍然出现在错误里。
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const envelope = isRecord(parsed) ? parsed : {}
  const data = isRecord(envelope['data']) ? envelope['data'] : {}
  const accessToken = nonEmptyString(data['accessToken'])
  if (!response.ok || envelope['code'] !== 0 || accessToken === undefined) {
    const detail = nonEmptyString(envelope['msg']) ?? (text === '' ? 'HTTP ' + response.status : text.slice(0, 200))
    throw new Error('刷新 CodeBuddy 登录令牌被拒绝（' + detail + '）：请在 CodeBuddy 桌面端重新登录后重试')
  }
  const expiresAtMs = positiveFinite(data['expiresAt'])
  const expiresInSec = positiveFinite(data['expiresIn'])
  const stated = expiresAtMs ?? (expiresInSec === undefined ? undefined : Date.now() + expiresInSec * 1000)
  // 刚签发的 token 不可能已经过期。一个落在过去的时刻只说明这个字段的单位（或对方
  // 的时钟）和我们的假设不一致 —— 比如它给的是秒。照单全收会让每一次请求都判定「将
  // 过期」，把这条路由变成刷新风暴；退回保守 TTL 的代价只是多刷新一次。
  const expiresAt = stated === undefined || stated <= Date.now()
    ? Date.now() + REFRESH_FALLBACK_TTL_MS
    : stated
  const rotated = nonEmptyString(data['refreshToken'])
  return {
    accessToken,
    expiresAt,
    ...(rotated === undefined ? {} : { refreshToken: rotated }),
  }
}

/** CodeBuddy's product-specific half. */
class CodeBuddyImpl implements BackendImpl {
  /**
   * 内存里刷新得到的 token；undefined 表示还没刷新过。
   *
   * 放在 Impl 上而不是 resolveApiKey 的闭包里：transport 会被调用多次，闭包级缓存
   * 会让同一份 refreshToken 被拿去刷新两次，而刷新令牌是轮换的 —— 第二次用旧令牌
   * 换，轻则失败，重则把刚拿到的新令牌也一起作废。
   */
  private memory: MemoryToken | undefined

  /** 正在进行的刷新；见 {@link CodeBuddyImpl.refreshInMemory}。 */
  private refreshing: Promise<MemoryToken> | undefined

  async discover(): Promise<readonly DiscoveredAccount[]> {
    // readCredentials 已经处理了「一个凭据文件都没有」（抛 BackendUnavailable）这个
    // 前置条件；走到这里还有文件、却没有一个能解析出 token，那是用户在应用里退登了
    // —— 重新登录即可，不需要安装任何东西，所以是空账号而不是 unavailable。
    const credential = (await readCredentials())[0]
    if (credential === undefined) return []

    const expired = isExpired(credential)
    const domain = credential.domain ?? DEFAULT_DOMAIN
    // The domain is surfaced because CodeBuddy is region-scoped and two
    // otherwise identical logins can point at different backends; without it
    // a wrong-region account is indistinguishable from a broken one.
    const detail = domain + ' · ' + sourceLabel(credential.identity.source)
    return [{
      id: credential.identity.id,
      label: credential.identity.label,
      detail,
      // `usable` 说的是文件里的凭据：过期的文件就是过期的文件。路由不会因此停摆
      // （transport 能在内存里续期），但这句 reason 依然是对账号状态最诚实的描述，
      // 用户据此知道该等自动续期，还是直接去桌面端重新登录。
      usable: !expired,
      ...(expired
        ? { reason: '登录令牌已过期，请在 CodeBuddy 桌面端重新登录（本插件不会改写桌面端登录文件）' }
        : {}),
    }]
  }

  async models(): Promise<readonly BackendModelInfo[]> {
    // The roster is the same for every account (the manifest is a property of
    // the installed client, not of the login), so the account id is unused.
    return (await readOfficialModels()) ?? FALLBACK_MODELS
  }

  /**
   * CodeBuddy 的 OpenAI 兼容传输。
   *
   * 三个事实的来源：
   *
   *  - baseUrl：固定的官方主机加 `/v2`（见 {@link CHAT_BASE_URL}）；
   *  - models：官方客户端 `product.json` 的解析结果（{@link parseCodeBuddyModels}），
   *    读不到才退回内置的 `auto`；
   *  - key：桌面端登录文件里的 accessToken，**每次请求现取**（见
   *    {@link CodeBuddyImpl.accessTokenFor}）。
   *
   * 与 `usable` 的区别值得写下来：`discover` 用 `usable: false` 描述「文件里的凭据
   * 已经过期」，而 transport 描述的是「这条路由现在还能不能干活」。两者可以同时成立
   * —— 文件里的 token 死了，而 resolveApiKey 能在内存里换一个新的 —— 所以这里不因
   * `usable: false` 就拒绝提供传输。
   *
   * 唯一的「没得服务」情形在这里挡掉：一个能解析的凭据都没有（客户端没装，或用户还
   * 没登录）时返回 undefined，shell 于是干脆不注册 provider，与 cline.ts、opencode.ts
   * 的做法一致。这只是一次存在性探测：凭据检查刻意**不**靠抛错来完成，因为
   * {@link BaseBackendAdapter.transport} 会把本方法抛出的任何错误吞成 undefined，
   * shell 同样不会注册 provider，用户却连一句解释都看不到 —— 而账号卡片会按登录状态
   * 把该做的事说清楚。真正拿不到可用凭据时由 resolveApiKey 抛错，harness 会把那句话
   * 渲染给用户，这比发一个未认证的请求、再把厂商的 401 抛出来好得多。
   *
   * @param accountId - 要服务的账号；空串表示「没有偏好」，此时取第一个可用登录。
   * @returns 传输，或一个能解析的凭据都没有时的 undefined。
   */
  async transport(accountId: string): Promise<BackendTransport | undefined> {
    // 没有任何凭据可服务：返回 undefined 让 shell 不注册 provider，而不是注册一个每
    // 次请求都注定失败的 provider。credentialFor 在无凭据时抛错，这里把它翻译成
    // undefined（同样与 cline.ts / opencode.ts 一致）。
    try {
      await this.credentialFor(accountId)
    } catch {
      return undefined
    }
    return {
      baseUrl: CHAT_BASE_URL,
      models: await this.models(),
      // 每次请求现取，绝不把 token 捕获成常量：token 会过期、会轮换，捕获之后路由会
      // 一直用一个死凭据，用户的表现是「昨天还能用」。
      resolveApiKey: () => this.accessTokenFor(accountId),
    }
  }

  /**
   * 取本次请求要用的 bearer key。
   *
   * 三步，顺序有讲究：
   *
   *  1. 文件里的 token 还活着 —— 直接用。文件始终是第一事实来源，这个顺序让用户刚在
   *     桌面端重新登录时立刻切到新凭据。
   *  2. 文件里的 token 将过期，但内存里换过的那个还没过期 —— 用内存的那个。因为刷新
   *     结果不回写文件，续期之后文件会永远停在旧 token 上，所以这一步是稳态路径而不是
   *     异常路径。
   *  3. 两个都不能用 —— 在内存里刷新一次。刷新失败就抛错，让用户看到「请重新登录」，
   *     而不是让请求带着一个死 token 出去换一个 401 回来。
   *
   * 每次调用都重读凭据文件（一次有界的目录扫描 + 一次读文件）。这是有意的：磁盘上的
   * 文件才是真相，缓存反而会让桌面端重新登录之后的账号切换延迟生效。
   *
   * @param accountId - 要服务的账号；CodeBuddy 只有一个登录槽，所以它主要用来对号。
   * @returns 本次请求要带的 bearer key。
   */
  private async accessTokenFor(accountId: string): Promise<string> {
    const credential = await this.credentialFor(accountId)
    if (!isExpired(credential)) return credential.accessToken

    const memory = this.memory
    if (memory !== undefined
      && memory.accountId === credential.identity.id
      && !expiryReached(memory.expiresAt, Date.now())) {
      return memory.accessToken
    }

    return (await this.refreshInMemory(credential)).accessToken
  }

  /**
   * 定位这个 accountId 对应的凭据。
   *
   * accountId 在 CodeBuddy 上只是标识（`multiAccount: false`，一台机器只有一个登录
   * 槽），所以先按 id 精确匹配；匹配不上就退回第一个能解析的凭据 —— 单槽产品的「当前
   * 凭据」本来就只有那一个，而如果用户在桌面端重新登录换了 uid，shell 手里可能还握着
   * 旧 id，这时直接失败会把一条本来能用的路由钉死。
   *
   * @param accountId - 要定位的账号标识。
   * @returns 它的凭据；一个都读不到时抛错（错误文案就是给用户看的那句话）。
   */
  private async credentialFor(accountId: string): Promise<CodeBuddyCredential> {
    const credentials = await readCredentials()
    const credential = credentials.find(candidate => candidate.identity.id === accountId) ?? credentials[0]
    if (credential === undefined) {
      throw new Error('CodeBuddy 未找到可用的登录凭据：请在 CodeBuddy 桌面端登录后重试（本插件不会改写桌面端登录文件）')
    }
    return credential
  }

  /**
   * 在内存里刷新一次 token（单飞）。
   *
   * 同一时刻只允许一个刷新在跑，其余调用等它的结果：刷新令牌是轮换的，两个并发刷新
   * 拿着同一个旧令牌，第二个大概率失败，甚至可能把第一个刚换来的新令牌一起作废。
   * CodeBuddy 只有一个登录槽，所以一把锁覆盖所有账号就够了。
   *
   * @param credential - 文件里那份（可能已过期的）凭据。
   * @returns 内存里的新 token。
   */
  private refreshInMemory(credential: CodeBuddyCredential): Promise<MemoryToken> {
    const running = this.refreshing
    if (running !== undefined) return running

    const started = this.performRefresh(credential)
    this.refreshing = started
    // 成功失败都要释放锁：否则一次网络抖动会把这条路由永久钉在「刷新中」。
    const release = (): void => { this.refreshing = undefined }
    void started.then(release, release)
    return started
  }

  /**
   * 真正发出一次刷新请求；只由 {@link CodeBuddyImpl.refreshInMemory} 调用以串行化。
   *
   * @param credential - 文件里那份凭据。
   * @returns 缓存进内存的新 token。
   */
  private async performRefresh(credential: CodeBuddyCredential): Promise<MemoryToken> {
    // 优先用内存里那个刷新令牌：它随每次刷新轮换，再拿文件里的旧令牌去换会失败。
    const previous = this.memory
    const refreshToken = previous !== undefined
      && previous.accountId === credential.identity.id
      && previous.refreshToken !== ''
      ? previous.refreshToken
      : credential.refreshToken
    if (refreshToken === '') {
      throw new Error('CodeBuddy 登录令牌已过期，且本地凭据不含 refreshToken，无法自动续期：请在 CodeBuddy 桌面端重新登录后重试（本插件不会改写桌面端登录文件）')
    }

    const domain = credential.domain ?? DEFAULT_DOMAIN
    let response: Response
    try {
      response = await fetch(REFRESH_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          // 续期请求仍然带上当前这个（可能刚过期的）accessToken：端点用它认会话，真正的
          // 凭据是 X-Refresh-Token。
          authorization: 'Bearer ' + credential.accessToken,
          'x-user-id': credential.identity.uid ?? '',
          'x-enterprise-id': credential.identity.enterpriseId ?? '',
          'x-tenant-id': credential.identity.enterpriseId ?? '',
          'x-domain': domain,
          'user-agent': REFRESH_USER_AGENT,
          // 安全红线：refresh token 只出现在刷新请求里，聊天请求永远不带它。
          'x-refresh-token': refreshToken,
          // 刷新渠道标识，与官方客户端的 plugin 渠道一致；兄弟路径（src/upstream.ts 的
          // refreshHeaders）用的也是这个值。
          'x-auth-refresh-source': 'plugin',
        },
        body: '{}',
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      })
    } catch (error: unknown) {
      throw new Error('刷新 CodeBuddy 登录令牌失败（网络错误）：' + messageOf(error) + '；请检查网络，或在 CodeBuddy 桌面端重新登录后重试')
    }

    const result = await readRefreshResult(response)
    const next: MemoryToken = {
      accountId: credential.identity.id,
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
      refreshToken: result.refreshToken ?? refreshToken,
    }
    // 内存缓存刻意放在成功之后：失败不留下半成品，下一次请求能干净地重试。
    this.memory = next
    return next
  }
}

/** A short Chinese description of where the identity came from. */
function sourceLabel(source: CodeBuddyIdentity['source']): string {
  if (source === 'uid') return '来自桌面端登录状态'
  if (source === 'enterprise') return '企业版账号'
  return '本地登录文件'
}

/** Thin subclass so the concrete type names the backend in stack traces. */
class CodeBuddyBackend extends BaseBackendAdapter {}

/** The CodeBuddy backend, ready to register. */
export function createCodeBuddyBackend(): BaseBackendAdapter {
  return new CodeBuddyBackend(CODEBUDDY_DESCRIPTOR, new CodeBuddyImpl())
}
