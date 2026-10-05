/**
 * The multi-backend configuration card: one settings-page card that lists every
 * merged backend and configures the ones this plugin is allowed to configure.
 *
 * Reads its document from WORKBUDDY_BACKENDS_PATH and writes through
 * WORKBUDDY_BACKENDS_ACTION_PATH. Both are same-origin plugin routes; the write
 * route additionally requires the in-process key the document hands over, sent
 * as the x-workbuddy-key header.
 *
 * WHY THE SAME CARD LOOKS DIFFERENT PER BACKEND. The merged backends do not all
 * own their credentials, and the difference is reported as `configurable`,
 * never guessed from `authKind`. An `api-key` backend stores its keys HERE, so
 * the card shows a real account manager: the stored accounts, a delete control
 * per row, and an add form. A `desktop-adoption` backend (Trae, Qoder,
 * CodeBuddy, MiMo, Loomy) reads ANOTHER application's single login slot, and a
 * `managed-runtime` backend (OpenCode) reports whether its runtime is prepared;
 * for both, there is nothing this plugin could write. A button with nothing
 * behind it is worse than no button: the user clicks, nothing happens, and they
 * conclude the plugin is broken. Those two therefore render a READ-ONLY status
 * line instead — and this file never renders an account control for them, by
 * branching on `configurable` alone.
 *
 * SECRETS NEVER ARRIVE. The host sends `secretMasked` and never a stored value,
 * so the card can only ever DISPLAY a mask and SEND a new secret.
 *
 * @module dsh-workbuddy-connect/client/BackendsCard
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  WORKBUDDY_BACKENDS_ACTION_PATH,
  WORKBUDDY_BACKENDS_PATH,
} from '../backends-paths.ts'
import type {
  BackendsWebAccount,
  BackendsWebAction,
  BackendsWebActionResult,
  BackendsWebAuthKind,
  BackendsWebDocument,
  BackendsWebEntry,
  BackendsWebFailure,
  BackendsWebStoredAccount,
} from '../backends-paths.ts'

/**
 * Props for the card.
 *
 * The request is explicit: this file must not import any browser-only DSH
 * package, so the card takes no slot runtime props. A host that does want to
 * hand it one may, because the type is open to extra keys — but nothing here
 * depends on that.
 */
export interface BackendsCardProps {
  /** Card heading; overridable so a host can localise it. */
  title?: string
  /** The line under the heading. */
  subtitle?: string
  /** Extra keys supplied by a host binding are accepted and ignored here. */
  readonly [extra: string]: unknown
}

/** authKind -> the Chinese label the card shows. */
const AUTH_KIND_LABELS: Record<BackendsWebAuthKind, string> = {
  'device-code': '网页登录',
  'api-key': 'API Key',
  'desktop-adoption': '读取客户端登录',
  'managed-runtime': '受管运行时',
}

/**
 * Per-authKind explanation for the non-configurable backends.
 *
 * These are the two cases where the credential lives in the OTHER program: a
 * desktop-adoption account belongs to the adopted client (the user signs in
 * there, and this plugin only reads the result), and a managed runtime must be
 * installed locally before the backend can run at all. Neither has a value this
 * plugin could accept, which is why the sentence says what to do INSTEAD of
 * offering a form.
 */
const READ_ONLY_NOTES: Partial<Record<BackendsWebAuthKind, string>> = {
  'desktop-adoption': '这类后端读取的是对应客户端自身的登录状态：需要在那个客户端里登录，本插件只读，无法代为配置账号。',
  'managed-runtime': '这类后端需要先准备好本地运行时；运行时就绪后本插件会自动检测到，无需在此配置账号。',
}

/** The badge shown for each resolved availability state. */
const STATE_PRESENTATION: Record<BackendsWebEntry['state'], { label: string; tone: 'ready' | 'signedOut' | 'unavailable' | 'failed' }> = {
  ready: { label: '可用', tone: 'ready' },
  'signed-out': { label: '未登录', tone: 'signedOut' },
  unavailable: { label: '不可用', tone: 'unavailable' },
  failed: { label: '启动失败', tone: 'failed' },
}

/** The non-configurable explanation for an authKind with no canned sentence. */
const READ_ONLY_FALLBACK = '这个后端的账号由它自己管理，本插件只显示探测到的状态。'

/** Fetch one document, reporting a failure as a value rather than throwing. */
async function fetchDocument(signal: AbortSignal): Promise<{ ok: true; doc: BackendsWebDocument } | { ok: false; message: string }> {
  try {
    const response = await fetch(WORKBUDDY_BACKENDS_PATH, { signal, headers: { accept: 'application/json' } })
    if (!response.ok) return { ok: false, message: 'HTTP ' + response.status }
    return { ok: true, doc: await response.json() as BackendsWebDocument }
  } catch (error: unknown) {
    if (signal.aborted) return { ok: false, message: '已取消' }
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * One timestamp, rendered compactly and in the LOCAL timezone.
 *
 * Locale-dependent time formatting is deliberately NOT used: the harness ships
 * with a pinned locale, while a stored account's update time is a fact the user
 * compares against their own clock, not prose. Returns undefined for a missing
 * or unparsable value so the row omits the line instead of printing
 * "Invalid Date".
 */
function formatStamp(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return undefined
  const pad = (value: number): string => (value < 10 ? '0' + String(value) : String(value))
  return String(date.getFullYear()) + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/**
 * The stored account's update stamp, or undefined when the value is unusable.
 *
 * A named accessor rather than an inline call: the row tests the value for
 * presence and then prints it, and doing that through two expressions would
 * recompute the format on every render.
 */
function stampOf(account: BackendsWebStoredAccount): string | undefined {
  return formatStamp(account.updatedAtMs)
}

/**
 * A stable id-safe fragment of a backend id.
 *
 * Used to build the htmlFor/id pair that associates each add-account label with
 * its input. Several backends render at once, so the ids must differ; the index
 * is appended by the caller as a tiebreaker for ids that contain nothing usable
 * (or are empty).
 */
function idFragment(backendId: string): string {
  const cleaned = backendId.replace(/[^A-Za-z0-9_-]/g, '-')
  return cleaned.length > 0 ? cleaned : 'backend'
}

/** The multi-backend configuration card. */
export function BackendsCard(props: BackendsCardProps = {}): ReactNode {
  const title = typeof props.title === 'string' ? props.title : '第三方后端配置'
  const subtitle = typeof props.subtitle === 'string'
    ? props.subtitle
    : '这里列出已合并进本插件的全部后端。可以配置的后端能直接管理账号；凭据属于其他应用的只显示状态。'

  const [doc, setDoc] = useState<BackendsWebDocument | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | undefined>(undefined)
  /** Draft of every add-account form, keyed by backend id. */
  const [drafts, setDrafts] = useState<Record<string, { label: string; secret: string }>>({})
  const controllerRef = useRef<AbortController | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const result = await fetchDocument(controller.signal)
    if (controller.signal.aborted) return
    if (result.ok) {
      setDoc(result.doc)
      setError(undefined)
    } else {
      setError(result.message)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => {
      controllerRef.current?.abort()
    }
  }, [load])

  /**
   * Send one write. The key travels with the document; the route rejects a
   * request without it, so a missing key is reported rather than ignored.
   */
  const act = useCallback(async (action: BackendsWebAction): Promise<void> => {
    const key = doc?.actionKey
    if (key === undefined || key.length === 0) {
      setMessage({ text: '缺少写入密钥，无法提交；请重新加载页面后再试。', ok: false })
      return
    }
    setBusy(true)
    setMessage(undefined)
    try {
      const response = await fetch(WORKBUDDY_BACKENDS_ACTION_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-workbuddy-key': key },
        body: JSON.stringify(action),
      })
      const result = await response.json() as BackendsWebActionResult
      setMessage({ text: result.message ?? (result.ok ? '操作已完成' : '操作失败'), ok: result.ok })
      // A successful write changes the account list, so the card re-reads the
      // document instead of patching local state: the host stays the single
      // source of truth for what a backend actually holds.
      await load()
    } catch (caught: unknown) {
      setMessage({ text: caught instanceof Error ? caught.message : String(caught), ok: false })
    } finally {
      setBusy(false)
    }
  }, [doc?.actionKey, load])

  /** Store (or replace) one account, then clear the form. */
  const addAccount = useCallback(async (backendId: string, label: string, secret: string): Promise<void> => {
    // Emptiness is judged on the value the user typed; the secret is sent as-is
    // because a key may legitimately contain leading or trailing whitespace.
    if (secret.length === 0) {
      setMessage({ text: '请先填写密钥。', ok: false })
      return
    }
    const action: BackendsWebAction = { action: 'add-account', backendId, secret }
    if (label.length > 0) action.label = label
    await act(action)
    // Cleared unconditionally: the secret must not linger in a DOM input after
    // the write, whether that write succeeded or not.
    setDrafts(previous => ({ ...previous, [backendId]: { label: '', secret: '' } }))
  }, [act])

  /** Drop one stored account after an explicit confirmation. */
  const removeAccount = useCallback(async (backendId: string, account: BackendsWebStoredAccount): Promise<void> => {
    const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm('确定删除账号「' + account.label + '」吗？删除后该密钥将不再可用。')
      : true
    if (!confirmed) return
    await act({ action: 'remove-account', backendId, accountId: account.id })
  }, [act])

  const failures: readonly BackendsWebFailure[] = doc?.failures ?? []
  const usableCount = useMemo(
    () => (doc?.backends ?? []).filter(backend => backend.state === 'ready').length,
    [doc?.backends],
  )

  if (doc === undefined && error === undefined) {
    return <div className="wbc-root"><div className="wbc-empty">正在读取后端列表…</div></div>
  }
  if (doc === undefined) {
    return (
      <div className="wbc-root">
        <div className="wbc-empty">
          <span>无法读取后端列表：{error}</span>
          <span>请确认插件的主机半边已启动，然后重试。</span>
        </div>
      </div>
    )
  }

  return (
    <div className="wbc-root">
      <div className="wbc-header">
        <div className="wbc-titleBlock">
          <h2 className="wbc-title">{title}</h2>
          <span className="wbc-subtitle">
            {subtitle} · 共 {doc.backends.length} 个后端，其中 {usableCount} 个可用
          </span>
        </div>
        <div className="wbc-actions">
          <button
            type="button"
            className="wbc-button"
            disabled={busy}
            onClick={() => { void act({ action: 'refresh' }) }}
          >
            {busy ? '处理中…' : '重新检测'}
          </button>
        </div>
      </div>

      {message !== undefined && (
        <div className={'wbc-message ' + (message.ok ? 'wbc-messageOk' : 'wbc-messageError')} role="status">
          {message.text}
        </div>
      )}

      {/* Backends that never constructed. Rendered apart from the sections
          because there is no descriptor to describe them with: without this
          block, a group that failed to load is indistinguishable from one that
          was never merged in. */}
      {failures.length > 0 && (
        <div className="wbc-failures" role="status">
          <h3 className="wbc-failuresTitle">以下后端未能启动（{failures.length} 个）</h3>
          {failures.map(failure => (
            <p className="wbc-failureLine" key={failure.id}>
              后端 {failure.id}：{failure.message}
            </p>
          ))}
        </div>
      )}

      {doc.backends.length === 0
        ? <div className="wbc-empty">还没有合并任何第三方后端。</div>
        : doc.backends.map((backend, index) => (
          <BackendSection
            key={backend.id}
            backend={backend}
            index={index}
            busy={busy}
            draft={drafts[backend.id] ?? { label: '', secret: '' }}
            onDraftChange={(next) => { setDrafts(previous => ({ ...previous, [backend.id]: next })) }}
            onAdd={(label, secret) => { void addAccount(backend.id, label, secret) }}
            onRemove={(account) => { void removeAccount(backend.id, account) }}
          />
        ))}
    </div>
  )
}

/** Props of one backend section. */
interface BackendSectionProps {
  backend: BackendsWebEntry
  /** Position in the list; used to keep the form ids unique. */
  index: number
  busy: boolean
  /** The current add-account draft for this backend. */
  draft: { label: string; secret: string }
  onDraftChange: (next: { label: string; secret: string }) => void
  onAdd: (label: string, secret: string) => void
  onRemove: (account: BackendsWebStoredAccount) => void
}

/**
 * One backend's section.
 *
 * The single branch that matters is `backend.configurable`:
 *
 *  - true  -> the account manager (stored rows with delete, the add form, envHint);
 *  - false -> the read-only status view (discovered accounts plus the sentence
 *             that says where the credential actually lives).
 *
 * The two arms share nothing but the header, so a future control cannot leak
 * into the read-only arm by accident.
 */
function BackendSection(props: BackendSectionProps): ReactNode {
  const { backend, draft } = props
  const presentation = STATE_PRESENTATION[backend.state]
  const fieldId = 'wbc-add-' + idFragment(backend.id) + '-' + String(props.index)
  const note = READ_ONLY_NOTES[backend.authKind]
  // A device-code or api-key backend still has a credential the document does
  // not carry; only the two adoption kinds have a canned explanation.
  const readOnlyNote = note ?? READ_ONLY_FALLBACK

  return (
    <section className="wbc-section">
      <div className="wbc-sectionHead">
        <div className="wbc-sectionTitle">
          <span className="wbc-name">{backend.displayName}</span>
          <span className="wbc-id">
            {backend.vendor !== undefined && backend.vendor.length > 0 ? backend.vendor + ' · ' : ''}
            {backend.id}
          </span>
        </div>
        <span className="wbc-spacer" />
        <span className="wbc-chip">{AUTH_KIND_LABELS[backend.authKind]}</span>
        <span className={'wbc-badge wbc-badge' + presentation.tone}>{presentation.label}</span>
      </div>

      {backend.description !== undefined && backend.description.length > 0 && (
        <p className="wbc-hint">{backend.description}</p>
      )}
      {/* hint is the actionable instruction for `unavailable`; message is the
          reason for `failed`. Both render whenever present rather than only in
          their nominal state, so a host that attaches guidance to a signed-out
          entry is not silently dropped. */}
      {backend.hint !== undefined && backend.hint.length > 0 && (
        <p className="wbc-hint">{backend.hint}</p>
      )}
      {backend.message !== undefined && backend.message.length > 0 && (
        <p className="wbc-messageText">{backend.message}</p>
      )}

      {backend.configurable
        ? (
          <>
            <div className="wbc-block">
              <h3 className="wbc-blockTitle">已配置账号（{backend.stored.length}）</h3>
              {backend.stored.length === 0
                ? <p className="wbc-note">尚未配置账号。</p>
                : (
                  <ul className="wbc-list">
                    {backend.stored.map(account => (
                      <li className="wbc-row" key={account.id}>
                        <span className="wbc-rowMain">
                          <span className="wbc-rowLabel">{account.label}</span>
                          <span className="wbc-rowSub">
                            {/* One formatted stamp per row: formatting is a
                                pure function of the value, so it is computed
                                once here instead of on both sides of the test. */}
                            {account.secretMasked}
                            {stampOf(account) === undefined ? '' : ' · 更新于 ' + String(stampOf(account))}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="wbc-button wbc-buttonDanger"
                          disabled={props.busy}
                          aria-label={'删除账号 ' + account.label}
                          onClick={() => { props.onRemove(account) }}
                        >
                          删除
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
            </div>

            {/* The envHint is shown so a user who already exports the variable
                understands why the backend works with no account configured,
                and does not create a duplicate one. */}
            {backend.envHint !== undefined && backend.envHint.length > 0 && (
              <p className="wbc-envHint">
                未配置账号时会回落到环境变量 {backend.envHint}。若该变量已导出，这里不配置账号也能正常工作，
                请不要为此再添加一个重复账号。
              </p>
            )}

            <form
              className="wbc-form"
              onSubmit={(event) => {
                event.preventDefault()
                props.onAdd(draft.label.trim(), draft.secret.trim())
              }}
            >
              {/* The label/input pair is associated by htmlFor+id AND by the
                  aria-label on the secret field: an id-based association is the
                  one screen readers prefer, and the duplicate aria-label costs
                  nothing while surviving a host that re-renders the card in a
                  shadow root where id lookups can fail. */}
              <span className="wbc-field">
                <label className="wbc-label" htmlFor={fieldId + '-label'}>显示名称</label>
                <input
                  id={fieldId + '-label'}
                  className="wbc-input"
                  type="text"
                  value={draft.label}
                  placeholder={backend.displayName}
                  disabled={props.busy}
                  onChange={(event) => { props.onDraftChange({ label: event.target.value, secret: draft.secret }) }}
                />
              </span>
              <span className="wbc-field">
                <label className="wbc-label" htmlFor={fieldId + '-secret'}>密钥（API Key）</label>
                <input
                  id={fieldId + '-secret'}
                  className="wbc-input"
                  type="password"
                  value={draft.secret}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={props.busy}
                  aria-label={'为 ' + backend.displayName + ' 添加账号的密钥'}
                  onChange={(event) => { props.onDraftChange({ label: draft.label, secret: event.target.value }) }}
                />
              </span>
              <button
                type="button"
                className="wbc-button"
                disabled={props.busy}
                onClick={() => { props.onDraftChange({ label: '', secret: '' }) }}
              >
                清空
              </button>
              <button type="submit" className="wbc-button" disabled={props.busy}>
                {props.busy ? '提交中…' : '添加账号'}
              </button>
            </form>
          </>
        )
        : (
          <>
            {/* NO add-account control in this arm, by design: the credential
                belongs to another program, so there is nothing to write. */}
            <p className="wbc-note">{readOnlyNote}</p>
            <div className="wbc-block">
              <h3 className="wbc-blockTitle">探测到的账号（{backend.accounts.length}）</h3>
              {backend.accounts.length === 0
                ? <p className="wbc-note">没有探测到账号。</p>
                : (
                  <ul className="wbc-list">
                    {backend.accounts.map(account => (
                      <li className="wbc-row" key={account.id}>
                        <span className="wbc-rowMain">
                          <span className="wbc-rowLabel">{account.label}</span>
                          {account.detail !== undefined && account.detail.length > 0 && (
                            <span className="wbc-rowSub">{account.detail}</span>
                          )}
                        </span>
                        <span className={account.usable ? 'wbc-badge wbc-badgeReady' : 'wbc-badge wbc-badgeUnavailable'}>
                          {account.usable ? '可用' : '不可用'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
            {backend.accounts.map(account => (account.reason !== undefined && account.reason.length > 0
              ? <p className="wbc-note" key={account.id + '-reason'}>{account.label}：{account.reason}</p>
              : null))}
          </>
        )}
    </section>
  )
}

