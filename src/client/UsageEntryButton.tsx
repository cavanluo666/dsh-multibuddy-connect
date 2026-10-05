/**
 * The sidebar entry that opens the usage dashboard.
 *
 * Deliberately NOT a figures card like the two WorkBuddy quota cards beside it.
 * Those exist because a variant's remaining balance is worth seeing at a
 * glance; this page is an overview of every backend, and duplicating a summary
 * here would put a third set of numbers in a narrow column while the real page
 * sits one click away. The entry is therefore a quiet row that matches its
 * neighbours' chrome and says what it opens.
 *
 * Its markup stays PHRASING content: the shell renders footer actions inside
 * its own button in some layouts, so the row uses spans, not divs.
 *
 * @module dsh-workbuddy-connect/client/UsageEntryButton
 */

import type { ReactNode } from 'react'

/** What the shell injects into the entry. */
export interface UsageEntryButtonInjected {
  /** Open the usage dashboard. */
  open: () => void
}

/** Props accepted by the entry (the injected face, or a bare click handler). */
export type UsageEntryButtonProps = UsageEntryButtonInjected

/** One sidebar row that opens the usage dashboard. */
export function UsageEntryButton(props: UsageEntryButtonProps): ReactNode {
  return (
    <button
      type="button"
      className="wbp-foot"
      // The locale dictionary lives on the quota panel's namespace, which this
      // entry also registers under; the label is passed inline because the
      // entry has no locale service of its own.
      title="查看所有后端的额度与 token 用量"
      onClick={props.open}
    >
      <span className="wbp-footTop">
        <span className="wbp-footName">用量汇总</span>
      </span>
    </button>
  )
}
