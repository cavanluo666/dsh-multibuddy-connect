/**
 * The usage dashboard: what every backend account holds, and what has been
 * spent, in one screen.
 *
 * Reads its document from `WORKBUDDY_USAGE_PATH` and writes through
 * `WORKBUDDY_USAGE_ACTION_PATH`. Both are same-origin plugin routes; the write
 * route additionally requires the in-process key the document hands over.
 *
 * DELIBERATE DIVISION OF LABOUR. This component decides presentation and
 * nothing else: every rule about what a figure MEANS (is a missing balance a
 * zero? is a short bar a small day or an empty one?) lives in
 * `usage-format.ts`, which is tested without a DOM. The component is therefore
 * mostly markup, and a layout change cannot alter what the page claims.
 *
 * @module dsh-workbuddy-connect/client/UsagePanel
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  USAGE_WINDOW_CHOICES,
  WORKBUDDY_USAGE_ACTION_PATH,
  WORKBUDDY_USAGE_PATH,
} from '../usage-paths.ts'
import type {
  UsageWebAccount,
  UsageWebActionResult,
  UsageWebDocument,
} from '../usage-paths.ts'
import {
  accountState,
  barHeightPercent,
  chartCeiling,
  formatFetchedAt,
  formatNumber,
  formatTokens,
  quotaFraction,
  quotaSummary,
  shortDay,
  tokensTotal,
} from './usage-format.ts'

/** How often the page re-reads the document while it is open. */
const REFRESH_INTERVAL_MS = 30_000

/** One colour per backend in the chart legend; cycles when exhausted. */
const BACKEND_COLORS = ['#4d6bfe', '#22a06b', '#e8833a', '#9b5de5', '#00b8d9', '#d6455d'] as const

/** Fetch one document, reporting a failure as a state rather than throwing. */
async function fetchDocument(signal: AbortSignal): Promise<{ ok: true; doc: UsageWebDocument } | { ok: false; message: string }> {
  try {
    const response = await fetch(WORKBUDDY_USAGE_PATH, { signal, headers: { accept: 'application/json' } })
    if (!response.ok) return { ok: false, message: `HTTP ${response.status}` }
    return { ok: true, doc: await response.json() as UsageWebDocument }
  } catch (error: unknown) {
    if (signal.aborted) return { ok: false, message: 'aborted' }
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** The dashboard's top-level component. */
export function UsagePanel(): ReactNode {
  const [doc, setDoc] = useState<UsageWebDocument | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
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
      setNow(Date.now())
    } else {
      setError(result.message)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, REFRESH_INTERVAL_MS)
    return () => {
      clearInterval(timer)
      controllerRef.current?.abort()
    }
  }, [load])

  /** Send one write to the action route; the key travels with the document. */
  const act = useCallback(async (action: 'refresh-quotas' | 'clear-ledger' | 'set-window', windowDays?: number): Promise<void> => {
    const key = doc?.actionKey
    if (key === undefined) return
    setBusy(true)
    setMessage(undefined)
    try {
      const response = await fetch(WORKBUDDY_USAGE_ACTION_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-workbuddy-key': key },
        // `windowDays` is omitted rather than sent as undefined so the host's
        // shape check sees exactly the fields the action defines.
        body: JSON.stringify(windowDays === undefined ? { action } : { action, windowDays }),
      })
      const result = await response.json() as UsageWebActionResult
      setMessage({ text: result.message ?? (result.ok ? '已完成' : '失败'), ok: result.ok })
      await load()
    } catch (error: unknown) {
      setMessage({ text: error instanceof Error ? error.message : String(error), ok: false })
    } finally {
      setBusy(false)
    }
  }, [doc?.actionKey, load])

  const ceiling = useMemo(() => chartCeiling(doc?.days ?? []), [doc?.days])
  const backendColors = useMemo(() => {
    const map = new Map<string, string>()
    doc?.backends.forEach((backend, index) => {
      map.set(backend.backendId, BACKEND_COLORS[index % BACKEND_COLORS.length]!)
    })
    return map
  }, [doc?.backends])

  if (doc === undefined && error === undefined) {
    return <div className="wbu-root"><div className="wbu-empty">正在读取用量…</div></div>
  }
  if (doc === undefined) {
    return (
      <div className="wbu-root">
        <div className="wbu-empty">
          <span className="wbu-emptyTitle">无法读取用量数据</span>
          <span>{error}</span>
        </div>
      </div>
    )
  }

  const windowTotal = tokensTotal(doc.windowTotals)
  const todayTotal = tokensTotal(doc.todayTotals)

  return (
    <div className="wbu-root">
      <div className="wbu-header">
        <div className="wbu-titleBlock">
          <h2 className="wbu-title">用量汇总</h2>
          <span className="wbu-subtitle">
            {doc.fromDay} 至 {doc.toDay}（{doc.days.length} 天）· 共 {doc.accounts.length} 个账号
          </span>
        </div>
        <div className="wbu-actions">
          <span className="wbu-windowGroup">
            {USAGE_WINDOW_CHOICES.map(days => (
              <button
                key={days}
                type="button"
                className="wbu-windowButton"
                data-active={days === doc.windowDays}
                disabled={busy}
                onClick={() => { void act('set-window', days) }}
              >
                {days} 天
              </button>
            ))}
          </span>
          <button type="button" className="wbu-button" disabled={busy} onClick={() => { void act('refresh-quotas') }}>
            刷新额度
          </button>
          <button type="button" className="wbu-button" disabled={busy} onClick={() => { void act('clear-ledger') }}>
            清空记录
          </button>
        </div>
      </div>

      {message !== undefined && (
        <div className={`wbu-message ${message.ok ? 'wbu-messageOk' : 'wbu-messageError'}`}>{message.text}</div>
      )}
      {doc.failures !== undefined && doc.failures.length > 0 && (
        <div className="wbu-failures">
          {doc.failures.map(failure => (
            <span key={failure.id}>后端 {failure.id} 启动失败：{failure.message}</span>
          ))}
        </div>
      )}

      <div className="wbu-cards">
        <SummaryCard label="窗口内 token" value={formatTokens(windowTotal)} meta={`${doc.windowCalls} 次调用`} />
        <SummaryCard label="今日 token" value={formatTokens(todayTotal)} meta={doc.toDay} />
        <SummaryCard
          label="可查询额度的账号"
          value={`${doc.accounts.filter(a => a.quota !== undefined && a.quota.kind !== 'unavailable').length} / ${doc.accounts.length}`}
          meta={doc.anyQuota ? '来自各后端上游' : '当前无后端提供额度'}
        />
      </div>

      {doc.hasHistory
        ? (
          <UsageChart
            days={doc.days}
            ceiling={ceiling}
            backends={doc.backends.map(backend => ({
              backendId: backend.backendId,
              backendName: backend.backendName,
              share: backend.share,
              color: backendColors.get(backend.backendId) ?? BACKEND_COLORS[0],
            }))}
          />
        )
        : (
          <div className="wbu-empty">
            <span className="wbu-emptyTitle">还没有用量记录</span>
            <span>本插件从此刻起记录每个后端账号的 token 消耗；历史上游不提供按天用量，因此只会计入此后的调用。</span>
          </div>
        )}

      <div className="wbu-section">
        <h3 className="wbu-sectionTitle">账号明细</h3>
        {doc.accounts.length === 0
          ? (
            <div className="wbu-empty">
              <span className="wbu-emptyTitle">还没有可用的后端账号</span>
              <span>在「插件配置」中登录或配置一个后端后，这里会显示它的额度与用量。</span>
            </div>
          )
          : (
            <table className="wbu-table">
              <thead>
                <tr>
                  <th>后端 / 账号</th>
                  <th>状态</th>
                  <th>剩余额度</th>
                  <th className="wbu-num">窗口内</th>
                  <th className="wbu-num">今日</th>
                  <th className="wbu-num">调用</th>
                </tr>
              </thead>
              <tbody>
                {doc.accounts.map(account => (
                  <AccountRow key={`${account.backendId}/${account.accountId}`} account={account} nowMs={now} />
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  )
}

/** One figure in the summary strip. */
function SummaryCard(props: { label: string; value: string; meta?: string }): ReactNode {
  return (
    <div className="wbu-card">
      <span className="wbu-cardLabel">{props.label}</span>
      <span className="wbu-cardValue">{props.value}</span>
      {props.meta !== undefined && <span className="wbu-cardMeta">{props.meta}</span>}
    </div>
  )
}

/** The daily bar chart with its legend. */
function UsageChart(props: {
  days: UsageWebDocument['days']
  ceiling: number
  backends: readonly { backendId: string; backendName: string; share: number; color: string }[]
}): ReactNode {
  const first = props.days[0]?.day
  const last = props.days[props.days.length - 1]?.day
  return (
    <div className="wbu-chart">
      <div className="wbu-bars">
        {props.days.map(day => {
          const total = tokensTotal(day.tokens)
          const height = barHeightPercent(day.tokens, props.ceiling)
          return (
            <div
              key={day.day}
              className="wbu-bar"
              title={`${day.day}：${formatTokens(total)} token，${day.calls} 次调用`}
            >
              {total > 0
                ? <div className="wbu-barFill" style={{ height: `${height}%` }} />
                : <div className="wbu-barEmpty" />}
            </div>
          )
        })}
      </div>
      <div className="wbu-axis">
        <span>{first !== undefined ? shortDay(first) : ''}</span>
        <span>{last !== undefined ? shortDay(last) : ''}</span>
      </div>
      {props.backends.length > 0 && (
        <div className="wbu-legend">
          {props.backends.map(backend => (
            <span key={backend.backendId} className="wbu-legendItem">
              <span className="wbu-legendDot" style={{ background: backend.color }} />
              {backend.backendName} · {Math.round(backend.share * 100)}%
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** One account's row. */
function AccountRow(props: { account: UsageWebAccount; nowMs: number }): ReactNode {
  const { account } = props
  const state = accountState(account)
  const fraction = quotaFraction(account.quota)
  const fetchedAt = formatFetchedAt(account.quotaFetchedAtMs, props.nowMs)
  return (
    <tr>
      <td>
        <span className="wbu-name">
          <span className="wbu-nameMain">{account.accountLabel}</span>
          <span className="wbu-nameSub">
            {account.backendName}
            {account.accountDetail !== undefined ? ` · ${account.accountDetail}` : ''}
          </span>
        </span>
      </td>
      <td><span className={`wbu-chip wbu-chip${toneClass(state.tone)}`}>{state.label}</span></td>
      <td>
        <span className="wbu-quota">
          <span className="wbu-quotaHead">
            <span>{quotaSummary(account.quota)}</span>
          </span>
          {fraction !== undefined && (
            <span className="wbu-quotaBar">
              <span
                className={`wbu-quotaFill${fraction <= 0.1 ? ' wbu-quotaFillWarn' : ''}`}
                style={{ width: `${Math.round(fraction * 100)}%` }}
              />
            </span>
          )}
          {fetchedAt !== undefined && <span className="wbu-quotaNote">读取于 {fetchedAt}</span>}
        </span>
      </td>
      <td className="wbu-num">{formatTokens(tokensTotal(account.windowTokens))}</td>
      <td className="wbu-num">{formatTokens(tokensTotal(account.todayTokens))}</td>
      <td className="wbu-num">{formatNumber(account.windowCalls)}</td>
    </tr>
  )
}

/** Map a tone onto the stylesheet's chip suffix. */
function toneClass(tone: 'ok' | 'warn' | 'error' | 'muted'): string {
  if (tone === 'warn') return 'Warn'
  if (tone === 'error') return 'Error'
  if (tone === 'muted') return 'Muted'
  return 'Ok'
}
