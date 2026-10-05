/**
 * CodeBuddy (腾讯) — a desktop-adoption backend.
 *
 * The CodeBuddy desktop client / official extension keeps its sign-in in a
 * \`*.info\` document under CodeBuddyExtension's data directory. That file is
 * read here, READ-ONLY. This is the one place where the read-only rule is not
 * merely a matter of correctness but of NOT BREAKING THE USER'S APP: the
 * original plugin refreshes an expiring access token and writes the new one
 * back into the same document. Doing that here would mean the plugin owns a
 * write path into another application's credential store — a corrupt or racing
 * write signs the desktop app out, which is a far worse outcome than this
 * adapter reporting the account as unusable. So an expired token is REPORTED
 * (\`usable: false\`) and never repaired; signing in again in the desktop app
 * fixes it, and nothing needs reinstalling.
 *
 * CodeBuddy and WorkBuddy share Tencent's account system, and the original
 * plugin deliberately reads whichever \`*.info\` it finds first rather than
 * insisting on one product's directory. That behaviour is kept: the account is
 * adopted from the local desktop login, whichever of the two placed it there.
 *
 * multiAccount is false because the desktop client holds a single login slot —
 * a statement about the vendor's credential model rather than a limitation of
 * this adapter.
 *
 * reportsQuota is false, and that is a finding rather than a default. The
 * original implementation exposes exactly one authenticated backend call
 * (\`POST /v2/chat/completions\`); the only other endpoint it knows is
 * \`/v2/plugin/auth/token/refresh\`, which mints tokens and reports no balance.
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
import { BaseBackendAdapter, BackendUnavailable, type BackendImpl, type DiscoveredAccount } from './base.ts'
import type { BackendDescriptor, BackendModelInfo } from './types.ts'

/** Environment override naming an explicit credential file. */
const AUTH_FILE_ENV = 'CODEBUDDY_AUTH_FILE'

/** Environment override naming an explicit auth directory. */
const AUTH_DIR_ENV = 'CODEBUDDY_AUTH_DIR'

/** Suffix of the desktop client's credential documents. */
const AUTH_FILE_SUFFIX = '.info'

/** Login domain assumed when the credential carries none. */
const DEFAULT_DOMAIN = 'www.codebuddy.cn'

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
 * fallback for the built-in \`auto\` entry and for manifests that omit it.
 */
const DEFAULT_MAX_TOKENS = 64_000

/** Context capacity assumed for a model no manifest describes. */
const DEFAULT_CONTEXT_WINDOW = 1_000_000

/**
 * Reasoning efforts the CodeBuddy backend accepts.
 *
 * Declared on every model because the wire request carries \`reasoning_effort\`
 * for all of them — the backend streams reasoning regardless of the model name,
 * so gating this per model would invent a distinction the vendor does not make.
 */
const REASONING_EFFORTS: readonly string[] = ['off', 'low', 'high', 'max']

/**
 * Built-in roster, used when no official client manifest can be read.
 *
 * Deliberately minimal, for the same reason the original plugin keeps only
 * \`auto\`: it is the one id guaranteed to survive a subscription change. A
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
}

/**
 * Candidate auth directories, computed fresh on every call.
 *
 * Read lazily rather than captured at module load so a test (or a user) that
 * sets \`LOCALAPPDATA\` before the first probe still gets the right answer.
 *
 * All three platform layouts are enumerated rather than branching on
 * \`process.platform\`, matching the sibling Loomy and MiMo backends: a moved or
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
 * @returns the absolute path of the first \`*.info\` file, or undefined.
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
 * \`readdir\` on a directory that holds a handful of entries and turns a silent
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
 * \`uid\` is preferred because it is the per-person key the other backends in
 * this catalogue also use; \`enterpriseId\` identifies a tenant, which two
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
  }
}

/** The credential file's base name without its \`.info\` suffix. */
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
 * Parse one CodeBuddy \`*.info\` document.
 *
 * Returns undefined for anything that cannot yield a usable bearer token —
 * malformed JSON, a JSON scalar, an empty \`auth\` block, a document whose access
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

  const expiresAt = typeof auth['expiresAt'] === 'number' && Number.isFinite(auth['expiresAt'])
    ? auth['expiresAt']
    : 0
  const domain = nonEmptyString(auth['domain'])

  return {
    accessToken,
    expiresAt,
    ...(domain === undefined ? {} : { domain }),
    identity: identityOf(parsed, file),
  }
}

/** Whether a stated expiry has already passed (or is about to). */
export function isExpired(credential: CodeBuddyCredential, nowMs = Date.now()): boolean {
  // An unstated expiry is unknown rather than expired; only a definite,
  // passed instant is treated as a spent token.
  return credential.expiresAt > 0 && nowMs + EXPIRY_MARGIN_MS >= credential.expiresAt
}

/**
 * Locate the official client's \`product.json\` manifests.
 *
 * Roots are the same ones the original implementation scans: the VSCode-family
 * extension directories plus CodeBuddy's own. Names are matched loosely (any
 * directory mentioning the official publisher AND \`product.json\` present)
 * rather than against the exact \`tencent-cloud.coding-copilot-<version>\`
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

/** One entry of an official manifest's \`models\` array. */
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
 * Parse an official manifest's \`models\` array into the neutral vocabulary.
 *
 * Two filters are load-bearing and both come from the original implementation:
 * \`productName\` must literally be \`CodeBuddy\`, so an unrelated extension's
 * manifest in the same directory cannot masquerade as the roster; and rows
 * carrying \`supportsExtra\` are dropped because they are completion/auxiliary
 * entries that cannot serve a chat turn — offering one in the picker would
 * produce a model that fails on first use.
 *
 * @param product - the parsed \`product.json\` value.
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

/** CodeBuddy's product-specific half. */
class CodeBuddyImpl implements BackendImpl {
  async discover(): Promise<readonly DiscoveredAccount[]> {
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

    for (const file of files) {
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch {
        continue
      }
      const credential = parseCodeBuddyAuth(text, file)
      if (credential === undefined) continue

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
        usable: !expired,
        ...(expired
          // The one failure mode this adapter refuses to repair: the fix is a
          // human signing in, so the reason has to say exactly that.
          ? { reason: '登录令牌已过期，请在 CodeBuddy 桌面端重新登录（本插件不会改写桌面端登录文件）' }
          : {}),
      }]
    }

    // Files are present but none yields a token: the user signed out in the
    // app. No accounts, not "unavailable" — signing in again fixes it and
    // nothing needs installing.
    return []
  }

  async models(): Promise<readonly BackendModelInfo[]> {
    // The roster is the same for every account (the manifest is a property of
    // the installed client, not of the login), so the account id is unused.
    return (await readOfficialModels()) ?? FALLBACK_MODELS
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
