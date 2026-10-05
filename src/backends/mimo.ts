/**
 * MiMo (小米) — a desktop-adoption backend.
 *
 * MiMo Desktop signs in through Xiaomi Passport, and its Chromium build leaves
 * the passport cookies in a SQLite cookie jar. Those cookies are read here,
 * read-only; the plugin never writes to the application and cannot start a
 * sign-in (the user signs in *in the app*, or the plugin's own credential file
 * is used instead, which takes priority).
 *
 * MiMo is a SINGLE-ACCOUNT product: the desktop app holds one Xiaomi passport
 * sign-in and its cookie store has no notion of a second, so `multiAccount` is
 * false in the descriptor — a statement about the vendor's model rather than a
 * limitation of this adapter.
 *
 * Unlike the sibling Loomy backend, MiMo CAN report remaining quota: the
 * desktop-free channel exposes `GET /api/user/usage`, so `reportsQuota` is true
 * and `quota()` actually probes it.
 *
 * @module dsh-workbuddy-connect/backends/mimo
 */

import { existsSync } from 'node:fs'
import { copyFile, readFile, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { BaseBackendAdapter, BackendUnavailable, type BackendImpl, type DiscoveredAccount } from './base.ts'
import type { BackendDescriptor, BackendModelInfo, QuotaReading } from './types.ts'

/** Environment override naming an explicit cookie database. */
const COOKIE_DB_ENV = 'MIMO_COOKIE_DB'

/** Environment override naming an explicit plugin-owned credential file. */
const AUTH_FILE_ENV = 'MIMO_AUTH_FILE'

/** The plugin's own credential file, relative to the Harness home. */
const OWN_AUTH_FILENAME = '.mimo-connect-auth.json'

/** On-disk format version of the plugin-owned credential. */
const OWN_FORMAT_VERSION = 1

/**
 * The passport cookies required to establish a session.
 *
 * Only these matter; the jar also holds analytics and locale noise. `passToken`
 * is the one that is actually load-bearing, and the two identity cookies ride
 * along so the session can be re-established after a merge.
 */
const REQUIRED_COOKIES = ['passToken', 'cUserId', 'userId']

/**
 * Cookie database row cap.
 *
 * A Chromium jar on a long-lived profile can hold thousands of rows, but the
 * passport triple lives in a handful. Bounding the scan keeps a pathological
 * database from turning startup into a stall; the required cookies are matched
 * by name, so the cap only ever truncates irrelevant rows.
 */
const MAX_COOKIE_ROWS = 20000

/** Upstream host the desktop-free channel is served from. */
const MIMO_SERVER = 'https://mimo-server-cn.xiaomimimo.com'

/**
 * User-Agent presented upstream.
 *
 * Deliberately NOT the desktop app's: the gateway does not require desktop
 * impersonation, and copying a desktop fingerprint would be a claim this
 * adapter cannot back.
 */
const MIMO_USER_AGENT = 'MiClaw/1.0'

/** Upper bound on one quota probe, so a hung gateway cannot pin a render open. */
const QUOTA_TIMEOUT_MS = 8000

/** Maximum redirect hops followed while minting a service token. */
const MAX_SESSION_HOPS = 6

/** A model entry plus the credit multiplier MiMo Desktop displays. */
interface MiMoModelEntry extends BackendModelInfo {
  /** Credit multiplier the desktop app shows, e.g. 0.4 for x0.40. */
  displayRatio?: number
}

/**
 * Built-in roster.
 *
 * The MiMo gateway exposes NO model-listing endpoint (`/api/models` and its
 * neighbours answer 404), so the roster is a snapshot mirrored from MiMo
 * Desktop's own `model-catalog.json`. Only chat models belong here: the app's
 * ASR / TTS / image entries cannot serve a DSH turn.
 */
const MIMO_MODELS: readonly MiMoModelEntry[] = [
  {
    id: 'mimo-v2.6-flash',
    name: 'MiMo V2.6 Flash',
    contextWindow: 262144,
    maxTokens: 65536,
    supportsImages: true,
    rate: 'x0.40',
    displayRatio: 0.4,
  },
  {
    id: 'mimo-v2.6-pro',
    name: 'MiMo V2.6 Pro',
    contextWindow: 262144,
    maxTokens: 65536,
    supportsImages: true,
    rate: 'x1.00',
    displayRatio: 1,
  },
]

/** The descriptor this backend registers under. */
export const MIMO_DESCRIPTOR: BackendDescriptor = {
  id: 'mimo',
  displayName: 'MiMo',
  description: '小米 MiMo 桌面端内置模型',
  brand: { vendor: '小米', product: 'MiMo' },
  authKind: 'desktop-adoption',
  // One Xiaomi passport sign-in per installation; the app's jar has one slot.
  multiAccount: false,
  reportsQuota: true,
  reportsTokenUsage: false,
  settingsNs: 'llm-mimo',
}

/**
 * Candidate locations of MiMo's Chromium cookie database, most likely first.
 *
 * All platform layouts are probed rather than branching on `process.platform`,
 * so a moved or non-standard install is still found — the same reasoning the
 * Loomy backend uses for its auth file.
 *
 * @returns candidate absolute paths.
 */
export function mimoCookieCandidates(): readonly string[] {
  const candidates: string[] = []
  const appData = process.env['APPDATA']
  if (appData !== undefined && appData !== '') {
    // The desktop app isolates the Xiaomi account in its own Chromium partition.
    candidates.push(join(appData, 'Xiaomi MiMo', 'Partitions', 'xiaomi-account', 'Network', 'Cookies'))
    candidates.push(join(appData, 'Xiaomi MiMo', 'Network', 'Cookies'))
  }
  const home = homedir()
  candidates.push(join(home, '.config', 'Xiaomi MiMo', 'Partitions', 'xiaomi-account', 'Network', 'Cookies'))
  candidates.push(join(home, 'Library', 'Application Support', 'Xiaomi MiMo', 'Partitions', 'xiaomi-account', 'Network', 'Cookies'))
  return [...new Set(candidates)]
}

/**
 * The plugin's own credential file path.
 *
 * Resolved through the Harness home helper so an explicit `$DSH_HOME` is
 * honoured; the file is the PLUGIN's own, never the application's.
 *
 * @returns the absolute path.
 */
export function mimoOwnAuthPath(): string {
  return join(resolveDshHome(), OWN_AUTH_FILENAME)
}

/** The Xiaomi passport triple a MiMo session is established from. */
export interface MiMoCredential {
  passToken: string
  cUserId: string
  userId: string
  /** Where it came from, for the account detail line. */
  source: 'plugin' | 'desktop'
  /** The cookie database it was read from, when adopted from the desktop app. */
  cookiePath?: string
}

/**
 * Parse the plugin-owned credential document.
 *
 * A missing `passToken` makes the document unusable rather than partially
 * usable: the other two cookies cannot mint a session on their own, so
 * accepting the file would produce an account that fails every request.
 *
 * @param text - raw file contents.
 * @returns the credential, or undefined when unusable.
 */
export function parseOwnMiMoCredential(text: string): MiMoCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  // Version first: a newer layout read as this one would silently drop fields.
  if (document['version'] !== undefined && document['version'] !== OWN_FORMAT_VERSION) return undefined
  const inner = typeof document['credential'] === 'object' && document['credential'] !== null
    ? document['credential'] as Record<string, unknown>
    : document
  const passToken = typeof inner['passToken'] === 'string' ? inner['passToken'] : ''
  if (passToken === '') return undefined
  return {
    passToken,
    cUserId: typeof inner['cUserId'] === 'string' ? inner['cUserId'] : '',
    userId: typeof inner['userId'] === 'string' ? inner['userId'] : '',
    source: 'plugin',
  }
}

/** One cookie row, reduced to what the passport exchange needs. */
interface CookieRow {
  host: string
  name: string
  value: string
}

/** The slice of `node:sqlite` this module uses, loaded dynamically. */
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
    prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] }
    close: () => void
  }
}

/**
 * Load `node:sqlite` without making it a load-time requirement.
 *
 * A static import would make the WHOLE backend module fail to load on a runtime
 * without SQLite, and the catalogue's guarded import would then report this
 * backend as broken rather than unreadable. A dynamic import inside a try keeps
 * the module loadable everywhere.
 *
 * The module is unflagged from Node 22.13 / 23.4, so this project's engine
 * floor of 22.19 already has it; the guard exists for hosts that differ.
 *
 * @returns the module, or undefined when unavailable.
 */
async function loadSqlite(): Promise<SqliteModule | undefined> {
  try {
    return await import('node:sqlite') as unknown as SqliteModule
  } catch {
    return undefined
  }
}

/**
 * Extract the passport cookies from a Chromium cookie database.
 *
 * Why `node:sqlite` rather than a hand-rolled byte scan: the cookie jar IS a
 * SQLite file, and scanning bytes for `passToken` cannot tell a live cookie row
 * from a deleted one still sitting in a free page. A stale `passToken` would be
 * sent upstream and read as a revoked session, so a scan would trade a real
 * correctness property for a dependency the runtime already carries.
 *
 * The database is copied to a scratch file before it is opened, because MiMo
 * holds the original open while it runs and opening a SQLite file another
 * process is actively writing can fail or block. The copy is strictly
 * read-only as far as the application is concerned.
 *
 * @param dbPath - path to the `Cookies` SQLite file.
 * @returns the passport cookies found there, or undefined when unreadable.
 */
export async function readMiMoCookies(dbPath: string): Promise<readonly CookieRow[] | undefined> {
  if (!existsSync(dbPath)) return undefined

  const scratch = join(tmpdir(), 'mimo-ck-' + process.pid + '-' + Date.now() + '.db')
  const sidecars = ['', '-journal', '-wal', '-shm']
  const copied: string[] = []
  try {
    for (const suffix of sidecars) {
      if (!existsSync(dbPath + suffix)) continue
      try {
        await copyFile(dbPath + suffix, scratch + suffix)
        copied.push(scratch + suffix)
      } catch {
        // A locked sidecar is not fatal; the main file carries committed rows.
      }
    }
    if (!existsSync(scratch)) return undefined

    const sqlite = await loadSqlite()
    if (sqlite === undefined) return undefined

    const db = new sqlite.DatabaseSync(scratch, { readOnly: true })
    try {
      const rows = db.prepare('SELECT host_key, name, value FROM cookies LIMIT ?').all(MAX_COOKIE_ROWS)
      const out: CookieRow[] = []
      for (const raw of rows) {
        if (typeof raw !== 'object' || raw === null) continue
        const row = raw as Record<string, unknown>
        const name = row['name']
        const value = row['value']
        const host = row['host_key']
        if (typeof name !== 'string' || typeof value !== 'string' || value === '') continue
        if (typeof host !== 'string' || host === '') continue
        // Only the passport triple is of interest; a wider read would carry
        // unrelated session material for no gain.
        if (!REQUIRED_COOKIES.includes(name)) continue
        out.push({ host, name, value })
      }
      return out
    } finally {
      db.close()
    }
  } catch {
    // A corrupt database, a changed schema, or a permission denial all mean
    // the same thing to the caller: no readable sign-in, reported as
    // signed-out rather than as a fault of the plugin.
    return undefined
  } finally {
    for (const path of copied) {
      try {
        await unlink(path)
      } catch {
        // A leftover scratch file is harmless and outside the application.
      }
    }
  }
}

/**
 * Assemble a credential from the passport cookies of one cookie database.
 *
 * The triple is looked up under the account domain, because the same cookie
 * names also appear scoped to `.xiaomi.com`, and picking the wrong scope would
 * send a stale identity. A `passToken` is required; the other two are optional
 * because older builds omit them.
 *
 * @param rows - the cookies read from the database.
 * @returns the credential, or undefined when no passport sign-in is present.
 */
export function credentialFromCookies(rows: readonly CookieRow[]): MiMoCredential | undefined {
  const byHost = new Map<string, Map<string, string>>()
  for (const row of rows) {
    let bucket = byHost.get(row.host)
    if (bucket === undefined) {
      bucket = new Map()
      byHost.set(row.host, bucket)
    }
    bucket.set(row.name, row.value)
  }

  // Prefer the account host; fall back to any host carrying a passToken, so a
  // build that scopes the passport cookies to `.xiaomi.com` still works.
  const found = [...byHost].find(([host, cookies]) => host.includes('account.xiaomi.com') && cookies.has('passToken'))
    ?? [...byHost].find(([, cookies]) => cookies.has('passToken'))
  if (found === undefined) return undefined

  const cookies = found[1]
  const passToken = cookies.get('passToken')
  if (passToken === undefined || passToken === '') return undefined
  return {
    passToken,
    cUserId: cookies.get('cUserId') ?? '',
    userId: cookies.get('userId') ?? '',
    source: 'desktop',
  }
}

/** Lowercase a domain and drop a leading dot. */
function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\./u, '')
}

/** Whether a cookie scoped to `domain` may be sent to `host`. */
function domainMatches(domain: string, host: string): boolean {
  const d = normalizeDomain(domain)
  const h = normalizeDomain(host)
  if (d === '' || h === '') return false
  return h === d || h.endsWith('.' + d)
}

/** Parse one `Set-Cookie` line down to the parts the jar keeps. */
function parseSetCookie(line: string, fallbackHost: string): { domain: string, name: string, value: string } | undefined {
  const parts = line.split(';')
  const pair = parts[0] ?? ''
  const eq = pair.indexOf('=')
  if (eq <= 0) return undefined
  const name = pair.slice(0, eq).trim()
  if (name === '') return undefined
  let value = pair.slice(eq + 1).trim()
  const quoted = /^"(.*)"$/u.exec(value)
  if (quoted !== null) value = quoted[1] ?? ''
  let domain = normalizeDomain(fallbackHost)
  for (const attr of parts.slice(1)) {
    const i = attr.indexOf('=')
    const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase()
    if (key === 'domain') domain = normalizeDomain(i === -1 ? '' : attr.slice(i + 1).trim())
  }
  if (domain === '') return undefined
  return { domain, name, value }
}

/**
 * A domain-scoped cookie jar.
 *
 * This exists because of one measured failure in the original plugin: sending
 * `.account.xiaomi.com` and `.xiaomi.com` cookies in the same `Cookie` header
 * makes MiMo's gateway treat the session as invalid and answer `EXPIRED`.
 * Scoping each request's header to the domains that actually match its host is
 * what makes the token exchange succeed.
 */
class MiMoJar {
  private readonly byDomain = new Map<string, Map<string, string>>()

  /** Store a cookie; an empty or `EXPIRED` value clears it. */
  set(domain: string, name: string, value: string): void {
    const key = normalizeDomain(domain)
    if (key === '') return
    let bucket = this.byDomain.get(key)
    if (bucket === undefined) {
      bucket = new Map()
      this.byDomain.set(key, bucket)
    }
    // The gateway revokes a session by setting a cookie to `EXPIRED`.
    if (value.trim() === '' || value.trim() === 'EXPIRED') bucket.delete(name)
    else bucket.set(name, value)
  }

  /** Read one cookie, or undefined. */
  get(domain: string, name: string): string | undefined {
    return this.byDomain.get(normalizeDomain(domain))?.get(name)
  }

  /** Every domain currently holding at least one cookie. */
  domains(): readonly string[] {
    return [...this.byDomain.keys()]
  }

  /**
   * Build the `Cookie` header for one URL.
   *
   * A host can match several stored domains at once and the same name may exist
   * in more than one; emitting it twice produces an invalid header, so each name
   * is emitted once with the value from the most specific domain — the rule
   * browsers apply.
   */
  headerFor(url: string): string {
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return ''
    }
    const matches = [...this.byDomain].filter(([domain]) => domainMatches(domain, host))
    matches.sort((a, b) => b[0].length - a[0].length)
    const chosen = new Map<string, string>()
    for (const [, cookies] of matches) {
      for (const [name, value] of cookies) {
        if (!chosen.has(name)) chosen.set(name, value)
      }
    }
    return [...chosen].map(([name, value]) => name + '=' + value).join('; ')
  }

  /** Absorb the `Set-Cookie` headers of one response. */
  absorb(headers: Headers, host: string): void {
    for (const line of headers.getSetCookie()) {
      const parsed = parseSetCookie(line, host)
      if (parsed === undefined) continue
      this.set(parsed.domain, parsed.name, parsed.value)
    }
  }
}

/**
 * One MiMo session: the cookie jar plus the minted `serviceToken`.
 *
 * The passport cookies cannot be used for inference directly. They must first
 * be exchanged for a `serviceToken` through MiMo's STS endpoint, by walking a
 * redirect chain. Two details are load-bearing and were both learned the hard
 * way: cookies must be sent per-domain (see {@link MiMoJar}), and EVERY
 * response must be absorbed, because the `deviceId` issued along the way is
 * required by a later hop.
 */
class MiMoSession {
  private readonly jar = new MiMoJar()

  constructor(credential: MiMoCredential) {
    this.jar.set('.account.xiaomi.com', 'passToken', credential.passToken)
    if (credential.cUserId !== '') {
      this.jar.set('.account.xiaomi.com', 'cUserId', credential.cUserId)
      this.jar.set('.xiaomi.com', 'cUserId', credential.cUserId)
    }
    if (credential.userId !== '') {
      this.jar.set('.account.xiaomi.com', 'userId', credential.userId)
      this.jar.set('.xiaomi.com', 'userId', credential.userId)
    }
  }

  /**
   * The `serviceToken`, matched the way the jar matches headers.
   *
   * The gateway issues it under `Domain=.xiaomimimo.com` — a parent of the
   * server host — so a strict host-keyed lookup would miss it.
   */
  private serviceToken(): string | undefined {
    let best: string | undefined
    let bestLen = -1
    const host = new URL(MIMO_SERVER).hostname
    for (const domain of this.jar.domains()) {
      if (!domainMatches(domain, host)) continue
      const value = this.jar.get(domain, 'serviceToken')
      if (value === undefined) continue
      if (domain.length > bestLen) {
        best = value
        bestLen = domain.length
      }
    }
    return best
  }

  /** One request carrying only the cookies matching that URL. */
  private async request(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('User-Agent', MIMO_USER_AGENT)
    const cookie = this.jar.headerFor(url)
    if (cookie !== '') headers.set('Cookie', cookie)
    // `manual` redirects: each hop's Set-Cookie must be absorbed before the
    // next request is issued, which automatic following would skip.
    const response = await fetch(url, { ...init, headers, redirect: 'manual' })
    this.jar.absorb(response.headers, new URL(url).hostname)
    return response
  }

  /** Drop any held `serviceToken`, wherever it was scoped. */
  private clearServiceToken(): void {
    const host = new URL(MIMO_SERVER).hostname
    for (const domain of this.jar.domains()) {
      if (domainMatches(domain, host)) this.jar.set(domain, 'serviceToken', '')
    }
  }

  /** Establish a `serviceToken` by walking the redirect chain. */
  async ensureSession(): Promise<string> {
    const existing = this.serviceToken()
    if (existing !== undefined && existing !== '') return existing

    // Drop a stale token so a failed refresh cannot look like success.
    this.clearServiceToken()

    let url = MIMO_SERVER + '/api/user/xiaomi/me'
    let lastStatus = 0
    for (let hop = 0; hop < MAX_SESSION_HOPS; hop++) {
      const response = await this.request(url, { headers: { Accept: 'text/html,application/json,*/*;q=0.8' } })
      lastStatus = response.status
      // The token can arrive on any hop; check before deciding to continue.
      const token = this.serviceToken()
      if (token !== undefined && token !== '') {
        try {
          await response.arrayBuffer()
        } catch {
          // Draining is best-effort; the token is already in hand.
        }
        return token
      }
      const location = response.headers.get('location')
      if (location === null || location === '') {
        try {
          await response.arrayBuffer()
        } catch {
          // Nothing more to read from this response.
        }
        break
      }
      url = new URL(location, url).toString()
    }
    throw new Error('MiMo 会话建立失败：未取得 serviceToken（最后一次响应 HTTP ' + lastStatus + '）。')
  }

  /** Read the account's allowance document, or undefined when unreadable. */
  async usage(signal: AbortSignal): Promise<unknown> {
    await this.ensureSession()
    const response = await this.request(MIMO_SERVER + '/api/user/usage', {
      headers: { Accept: 'application/json' },
      signal,
    })
    if (!response.ok) {
      try {
        await response.arrayBuffer()
      } catch {
        // Release the socket; the status already tells us this failed.
      }
      return undefined
    }
    const text = await response.text()
    // Unauthenticated paths on this host answer with HTML rather than JSON.
    if (!text.trimStart().startsWith('{')) return undefined
    return JSON.parse(text) as unknown
  }
}

/**
 * Parse the `data` payload of `/api/user/usage`.
 *
 * `percent` is the REMAINING share of the period's allowance, not the used
 * share: a freshly reset account reads 99.8 rather than 0.2. Reading it as
 * "used" would invert the whole dashboard, which is the one mistake this
 * function exists to prevent.
 *
 * @param value - the decoded response body.
 * @returns the percentage remaining and its reset instant, or undefined.
 */
export function parseMiMoQuota(value: unknown): { remainPercent: number, resetAt?: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const envelope = value as Record<string, unknown>
  // The envelope carries `code`/`data`; a bare object is also accepted so a
  // gateway that drops the envelope keeps working.
  const data = typeof envelope['data'] === 'object' && envelope['data'] !== null
    ? envelope['data'] as Record<string, unknown>
    : envelope
  const percent = data['percent']
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined
  const resetAt = typeof data['resetAt'] === 'number' && Number.isFinite(data['resetAt'])
    ? new Date(data['resetAt'] * 1000).toISOString()
    : (typeof data['resetDate'] === 'string' && data['resetDate'] !== '' ? data['resetDate'] : undefined)
  return {
    remainPercent: Math.min(100, Math.max(0, percent)),
    ...(resetAt === undefined ? {} : { resetAt }),
  }
}

/**
 * Read the resolved credential, preferring the plugin's own file.
 *
 * That ordering is what makes a machine which already has a signed-in desktop
 * app work with zero prompts, while still letting an explicit plugin sign-in
 * override it.
 *
 * @returns the credential, or undefined when neither source has one.
 * @throws {BackendUnavailable} when MiMo is not installed at all.
 */
async function resolveCredential(): Promise<MiMoCredential | undefined> {
  const ownOverride = process.env[AUTH_FILE_ENV]
  const ownPath = ownOverride !== undefined && ownOverride !== '' ? ownOverride : mimoOwnAuthPath()
  if (existsSync(ownPath)) {
    try {
      const parsed = parseOwnMiMoCredential(await readFile(ownPath, 'utf8'))
      if (parsed !== undefined) return parsed
      // The file EXISTS and does not yield a credential. That is a definite
      // answer — "the configured sign-in is not usable" — and must NOT fall
      // through to the desktop source. Falling through makes the outcome depend
      // on whether a cookie database happens to exist, so a user who placed a
      // malformed credential AND has no desktop app is told to go install one:
      // an instruction that cannot fix the problem in front of them.
      return undefined
    } catch {
      // Unreadable (permissions, a race with an editor). Also a definite
      // answer about THIS source; see above.
      return undefined
    }
  }

  const override = process.env[COOKIE_DB_ENV]
  const candidates = override !== undefined && override !== ''
    ? [override, ...mimoCookieCandidates()]
    : mimoCookieCandidates()

  let sawDatabase = false
  for (const path of candidates) {
    if (!existsSync(path)) continue
    sawDatabase = true
    const rows = await readMiMoCookies(path)
    if (rows === undefined) continue
    const credential = credentialFromCookies(rows)
    if (credential === undefined) continue
    return { ...credential, cookiePath: path }
  }

  // A present database with no passport cookies means the app is installed but
  // the user is signed out. NO database anywhere means MiMo is not installed —
  // a different state, and the only one that earns an actionable install hint.
  if (!sawDatabase) {
    throw new BackendUnavailable('未检测到小米 MiMo 桌面端的登录状态；请先安装并登录 MiMo 客户端，或在插件中配置 MiMo 凭据。')
  }
  return undefined
}

/** A masked identity for the account label. */
function maskIdentity(credential: MiMoCredential): string {
  const id = credential.userId !== '' ? credential.userId : credential.cUserId
  if (id === '') return 'Xiaomi 账号'
  if (id.length <= 6) return '•'.repeat(Math.max(4, id.length))
  return id.slice(0, 3) + '****' + id.slice(-3)
}

/** MiMo's product-specific half. */
class MiMoImpl implements BackendImpl {
  async discover(): Promise<readonly DiscoveredAccount[]> {
    const credential = await resolveCredential()
    // No credential: the app is installed but signed out. Reported as no
    // accounts (signed-out) rather than unavailable — signing in again inside
    // MiMo fixes it and nothing needs installing.
    if (credential === undefined) return []
    const id = credential.userId !== '' ? credential.userId : credential.cUserId
    // A credential with no identity at all cannot be keyed in the registry or
    // matched against a quota reading, so it is not an account.
    if (id === '') return []
    return [{
      id,
      label: maskIdentity(credential),
      detail: credential.source === 'desktop' ? '来自 MiMo 桌面端登录状态' : '来自插件凭据',
      usable: true,
    }]
  }

  async quota(accountId: string): Promise<QuotaReading> {
    const credential = await resolveCredential()
    if (credential === undefined) {
      return { kind: 'error', message: 'MiMo 登录状态已失效，请重新登录。' }
    }
    const resolvedId = credential.userId !== '' ? credential.userId : credential.cUserId
    // The base class only asks about an account it discovered, so a mismatch
    // means the stored sign-in changed underneath the dashboard.
    if (resolvedId !== '' && resolvedId !== accountId) {
      return { kind: 'error', message: 'MiMo 账号已变更，请刷新后重试。' }
    }

    const session = new MiMoSession(credential)
    try {
      const usage = await session.usage(AbortSignal.timeout(QUOTA_TIMEOUT_MS))
      if (usage === undefined) {
        return { kind: 'error', message: 'MiMo 未返回额度信息（会话可能已过期）。' }
      }
      const parsed = parseMiMoQuota(usage)
      if (parsed === undefined) {
        return { kind: 'error', message: 'MiMo 额度响应格式无法识别。' }
      }
      // The gateway reports a percentage, so it is published as a package whose
      // size is 100: the existing bar renderer then draws it correctly without
      // needing a percent-specific reading kind.
      return {
        kind: 'packages',
        total: parsed.remainPercent,
        totalSize: 100,
        packages: [{
          packageName: 'MiMo 免费额度',
          remain: parsed.remainPercent,
          size: 100,
          ...(parsed.resetAt === undefined ? {} : { packageEndTime: parsed.resetAt }),
        }],
      }
    } catch (error: unknown) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  async models(): Promise<readonly BackendModelInfo[]> {
    // The gateway has no roster endpoint, so this is a constant snapshot. It is
    // rebuilt per call rather than cached here, because the base class owns the
    // caching decision and a second cache would only disagree with it.
    return MIMO_MODELS.map(entry => ({
      id: entry.id,
      name: entry.name,
      ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
      ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
      ...(entry.supportsImages === undefined ? {} : { supportsImages: entry.supportsImages }),
      ...(entry.rate === undefined ? {} : { rate: entry.rate }),
    }))
  }
}

/** Thin subclass so the concrete type names the backend in stack traces. */
class MiMoBackend extends BaseBackendAdapter {}

/** The MiMo backend, ready to register. */
export function createMiMoBackend(): BaseBackendAdapter {
  return new MiMoBackend(MIMO_DESCRIPTOR, new MiMoImpl())
}
