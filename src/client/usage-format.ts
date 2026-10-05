/**
 * Pure formatting and derivation helpers for the usage dashboard.
 *
 * Separated from the React component so every rule that decides WHAT the page
 * says can be tested in Node, without a DOM, a renderer, or a harness. The
 * component then only decides how it looks.
 *
 * These functions are the page's honesty layer. Each one exists because the
 * obvious inline version would state something the data does not support —
 * rendering a missing figure as zero, an unreadable balance as empty, or an
 * unmeasured value as a measurement.
 *
 * @module dsh-workbuddy-connect/client/usage-format
 */

import type { UsageWebAccount, UsageWebDay, UsageWebQuota, UsageWebTokens } from '../usage-paths.ts'

/**
 * Format a token count for a compact surface.
 *
 * Rounds DOWN at every step and never promotes a figure to the next unit until
 * it is actually there, so the page never claims more usage than happened —
 * the direction that matters, because an inflated figure reads as overspend.
 *
 * @param value - the raw count.
 * @returns a short label such as `1.2K`, `3.4M`, or `0`.
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  const units: readonly { limit: number; divisor: number; suffix: string }[] = [
    { limit: 1e9, divisor: 1e9, suffix: 'B' },
    { limit: 1e6, divisor: 1e6, suffix: 'M' },
    { limit: 1e3, divisor: 1e3, suffix: 'K' },
  ]
  for (const unit of units) {
    if (value >= unit.limit) {
      const scaled = Math.floor((value / unit.divisor) * 10) / 10
      return `${scaled}${unit.suffix}`
    }
  }
  return String(Math.floor(value))
}

/** The total of one bucket set. */
export function tokensTotal(tokens: UsageWebTokens): number {
  return tokens.uncachedInput + tokens.output + tokens.cacheRead + tokens.cacheWrite
}

/**
 * The tallest day in a series, floored at 1.
 *
 * The floor is what keeps every bar from dividing by zero on a fresh install,
 * and it is why the chart can render an all-empty week without special-casing.
 *
 * @param days - the series.
 * @returns a positive denominator.
 */
export function chartCeiling(days: readonly UsageWebDay[]): number {
  let max = 0
  for (const day of days) {
    const total = tokensTotal(day.tokens)
    if (total > max) max = total
  }
  return max > 0 ? max : 1
}

/**
 * A bar's height as a percentage of the ceiling.
 *
 * A NON-ZERO day never renders at zero height. Without the floor, a day with
 * one token beside a day with a million would round to a 0px bar and read as
 * "nothing happened that day" — the exact opposite of the truth, and the one
 * error a usage chart must not make. The minimum is presentation only; the
 * tooltip still carries the real figure.
 *
 * @param tokens - that day's buckets.
 * @param ceiling - the series maximum, from {@link chartCeiling}.
 * @returns a percentage in [0, 100].
 */
export function barHeightPercent(tokens: UsageWebTokens, ceiling: number): number {
  const total = tokensTotal(tokens)
  if (total <= 0) return 0
  const percent = (total / ceiling) * 100
  return Math.min(100, Math.max(2, percent))
}

/** A short `MM-DD` label for a `YYYY-MM-DD` day. */
export function shortDay(day: string): string {
  const parts = day.split('-')
  if (parts.length !== 3) return day
  return `${parts[1]}-${parts[2]}`
}

/**
 * How much of a quota reading remains, as a 0–1 fraction.
 *
 * Returns `undefined` when the reading cannot express a fraction — an
 * unavailable backend has no figure, an unlimited one has no denominator, and a
 * package set whose sizes were all zero cannot be turned into a percentage
 * without inventing one. `undefined` renders as "no bar"; `0` renders as an
 * empty bar and means "nothing left", which is a different statement.
 *
 * @param quota - the reading, when there is one.
 * @returns the fraction, or undefined when no honest fraction exists.
 */
export function quotaFraction(quota: UsageWebQuota | undefined): number | undefined {
  if (quota === undefined) return undefined
  if (quota.kind === 'balance') {
    if (quota.size === undefined || !(quota.size > 0)) return undefined
    return Math.min(1, Math.max(0, quota.remain / quota.size))
  }
  if (quota.kind === 'packages') {
    if (quota.unlimited === true) return undefined
    if (!(quota.totalSize !== undefined && quota.totalSize > 0)) return undefined
    return Math.min(1, Math.max(0, quota.total / quota.totalSize))
  }
  return undefined
}

/**
 * One line describing a quota reading.
 *
 * Never returns an empty string: every arm says something, including the arms
 * that mean "we could not find out", because a blank cell on a dashboard reads
 * as a rendering bug rather than as missing data.
 *
 * @param quota - the reading, when there is one.
 * @returns a short human label.
 */
export function quotaSummary(quota: UsageWebQuota | undefined): string {
  if (quota === undefined) return '尚未读取'
  switch (quota.kind) {
    case 'unavailable':
      return '不提供额度查询'
    case 'error':
      return `读取失败：${quota.message}`
    case 'balance':
      return `${formatNumber(quota.remain)}${quota.unit ? ' ' + quota.unit : ''}`
    case 'packages': {
      if (quota.unlimited === true) return '不限量'
      if (quota.totalSize === undefined || !(quota.totalSize > 0)) return `剩余 ${formatNumber(quota.total)}`
      return `${formatNumber(quota.total)} / ${formatNumber(quota.totalSize)}`
    }
  }
}

/**
 * Format a number with thousands separators and at most one decimal.
 *
 * `Intl` is deliberately NOT used: the browser bundle is injected into an
 * unknown document, and a locale-sensitive formatter would render differently
 * depending on ambient state the page cannot see. A stable rendering is worth
 * more here than locale-correct separators.
 *
 * @param value - the number.
 * @returns the formatted string.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 10) / 10
  const whole = Math.trunc(rounded)
  const fraction = Math.abs(rounded - whole)
  const grouped = String(Math.abs(whole)).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
  const sign = rounded < 0 ? '-' : ''
  return fraction > 0 ? `${sign}${grouped}.${String(Math.round(fraction * 10))}` : `${sign}${grouped}`
}

/** Whether an account's row should carry a warning chip. */
export function accountState(account: UsageWebAccount): { label: string; tone: 'ok' | 'warn' | 'error' | 'muted' } {
  if (!account.usable) return { label: account.reason ?? '不可用', tone: 'error' }
  const quota = account.quota
  if (quota?.kind === 'error') return { label: '额度读取失败', tone: 'warn' }
  if (quota?.kind === 'balance' && quota.staleReason !== undefined) return { label: '额度可能已过期', tone: 'warn' }
  if (quota?.kind === 'unavailable') return { label: '不提供额度', tone: 'muted' }
  return { label: '正常', tone: 'ok' }
}

/**
 * Format an instant as a short local timestamp.
 *
 * @param atMs - epoch milliseconds.
 * @returns `HH:MM` when today, otherwise `MM-DD HH:MM`.
 */
export function formatFetchedAt(atMs: number | undefined, nowMs: number): string | undefined {
  if (atMs === undefined || !Number.isFinite(atMs)) return undefined
  const at = new Date(atMs)
  const now = new Date(nowMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const sameDay = at.getFullYear() === now.getFullYear()
    && at.getMonth() === now.getMonth()
    && at.getDate() === now.getDate()
  return sameDay ? time : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`
}
