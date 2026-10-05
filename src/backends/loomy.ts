/**
 * Loomy (讯飞) — a desktop-adoption backend.
 *
 * Loomy writes its sign-in session to an Electron data directory. The JSON
 * sidecar is read here, read-only. Loomy is a SINGLE-ACCOUNT product: the
 * desktop app holds one sign-in and the plugin cannot start a second one, so
 * `multiAccount` is false in the descriptor — a statement about the vendor's
 * model rather than a limitation of this adapter.
 *
 * @module dsh-workbuddy-connect/backends/loomy
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BaseBackendAdapter, BackendUnavailable, type BackendImpl, type DiscoveredAccount } from './base.ts'
import type { BackendDescriptor, BackendModelInfo, QuotaReading } from './types.ts'

/** Environment overrides, matching the upstream plugin's published names. */
const AUTH_FILE_ENV = 'LOOMY_AUTH_FILE'
const CONFIG_FILE_ENV = 'LOOMY_CONFIG_FILE'

/** The descriptor this backend registers under. */
export const LOOMY_DESCRIPTOR: BackendDescriptor = {
  id: 'loomy',
  displayName: 'Loomy',
  description: '讯飞 Loomy 桌面应用内置模型',
  brand: { vendor: '讯飞', product: 'Loomy' },
  authKind: 'desktop-adoption',
  multiAccount: false,
  reportsQuota: true,
  reportsTokenUsage: false,
  settingsNs: 'llm-loomy',
}

/**
 * Candidate locations of Loomy's sign-in file.
 *
 * macOS first, then Windows, matching the upstream probe order. Both are
 * checked on every platform rather than branching on `process.platform`, so a
 * moved or non-standard install is still found.
 */
export function loomyAuthCandidates(): readonly string[] {
  const appData = process.env['APPDATA']
  const candidates = [join(homedir(), 'Library', 'Application Support', 'loomy', 'auth-session.json')]
  if (appData !== undefined && appData !== '') candidates.push(join(appData, 'loomy', 'auth-session.json'))
  return candidates
}

/** Candidate locations of Loomy's generated model manifest. */
export function loomyConfigCandidates(): readonly string[] {
  const appData = process.env['APPDATA']
  const candidates = [join(homedir(), '.config', 'loomy-opencode', 'opencode.json')]
  if (appData !== undefined && appData !== '') candidates.push(join(appData, 'loomy-opencode', 'opencode.json'))
  return candidates
}

/** The first existing path, or undefined when none exists. */
function firstExisting(candidates: readonly string[]): string | undefined {
  return candidates.find(candidate => existsSync(candidate))
}

/** A parsed Loomy sign-in. */
export interface LoomyCredential {
  session: string
  userId: string
  /** Already-masked phone Loomy stores for display. */
  maskedPhone?: string
}

/**
 * Mask a phone number for display.
 *
 * Idempotent on an already-masked value: the macOS build stores the masked
 * form and the Windows build the raw one, and re-masking a masked string would
 * discard information. Checking for an existing asterisk first makes the two
 * builds converge on one rendering.
 *
 * @param value - raw or already-masked phone.
 * @returns the masked form.
 */
export function maskPhone(value: string): string {
  if (value.includes('*')) return value
  if (/^\d{11}$/u.test(value)) return `${value.slice(0, 3)}****${value.slice(7)}`
  if (value.length <= 4) return value
  return `${value.slice(0, Math.ceil(value.length / 3))}****${value.slice(-Math.ceil(value.length / 4))}`
}

/** Parse Loomy's sign-in document. */
export function parseLoomyAuth(text: string): LoomyCredential | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const session = typeof record['session'] === 'string' ? record['session'].trim() : ''
  const userId = typeof record['userid'] === 'string' ? record['userid'].trim() : ''
  if (session === '' || userId === '') return undefined
  const phone = typeof record['maskedPhone'] === 'string' && record['maskedPhone'] !== ''
    ? record['maskedPhone']
    : typeof record['phone'] === 'string' ? record['phone'] : ''
  return {
    session,
    userId,
    ...(phone === '' ? {} : { maskedPhone: maskPhone(phone) }),
  }
}

/** One entry in Loomy's model manifest. */
interface LoomyManifestModel {
  id?: unknown
  name?: unknown
  contextWindow?: unknown
  limit?: unknown
  output?: unknown
  modalities?: unknown
}

/**
 * Parse Loomy's `opencode.json` into the neutral model vocabulary.
 *
 * Only text models are kept: an image-only entry would appear in the picker and
 * then fail every request. An entry that declares no modalities at all is kept,
 * because the manifest omits the field for its ordinary text models.
 *
 * @param text - the manifest file's contents.
 * @returns the models it declares, in file order.
 */
export function parseLoomyModels(text: string): readonly BackendModelInfo[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const providers = (value as Record<string, unknown>)['provider']
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return []
  const out: BackendModelInfo[] = []
  for (const provider of Object.values(providers as Record<string, unknown>)) {
    if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) continue
    const models = (provider as Record<string, unknown>)['models']
    if (typeof models !== 'object' || models === null || Array.isArray(models)) continue
    for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
      const model = raw as LoomyManifestModel
      const modalities = Array.isArray(model.modalities) ? model.modalities.map(String) : undefined
      if (modalities !== undefined && !modalities.includes('text')) continue
      const contextWindow = typeof model.contextWindow === 'number'
        ? model.contextWindow
        : typeof model.limit === 'number' ? model.limit : undefined
      out.push({
        id,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : id,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(typeof model.output === 'number' ? { maxTokens: model.output } : {}),
        ...(modalities !== undefined && modalities.includes('image') ? { supportsImages: true } : {}),
      })
    }
  }
  return out
}

/** Loomy's product-specific half. */
class LoomyImpl implements BackendImpl {
  async discover(): Promise<readonly DiscoveredAccount[]> {
    const override = process.env[AUTH_FILE_ENV]
    const path = override !== undefined && override !== '' ? override : firstExisting(loomyAuthCandidates())
    if (path === undefined || !existsSync(path)) {
      throw new BackendUnavailable('未检测到 Loomy 桌面应用的登录状态；请先在 Loomy 客户端中登录。')
    }
    const credential = parseLoomyAuth(await readFile(path, 'utf8'))
    // The file exists but carries no usable session: the user signed out in the
    // app. Reported as no accounts (signed-out), not unavailable — signing in
    // again inside Loomy fixes it and nothing needs installing.
    if (credential === undefined) return []
    return [{
      id: credential.userId,
      label: credential.maskedPhone ?? 'Loomy 账号',
      ...(credential.maskedPhone === undefined ? {} : { detail: credential.maskedPhone }),
      usable: true,
    }]
  }

  async quota(): Promise<QuotaReading> {
    // Loomy's credits live in the renderer's LevelDB write-ahead log rather
    // than a settled store. A value read from it can be stale by a whole
    // session, so this adapter declines to report a balance instead of
    // charting a figure it cannot vouch for.
    return { kind: 'unavailable', reason: 'Loomy 积分缓存在客户端本地，本插件不读取' }
  }

  async models(): Promise<readonly BackendModelInfo[]> {
    const override = process.env[CONFIG_FILE_ENV]
    const path = override !== undefined && override !== '' ? override : firstExisting(loomyConfigCandidates())
    if (path === undefined) return []
    try {
      return parseLoomyModels(await readFile(path, 'utf8'))
    } catch {
      return []
    }
  }
}

/** Thin subclass so the concrete type names the backend in stack traces. */
class LoomyBackend extends BaseBackendAdapter {}

/** The Loomy backend, ready to register. */
export function createLoomyBackend(): BaseBackendAdapter {
  return new LoomyBackend(LOOMY_DESCRIPTOR, new LoomyImpl())
}
