/**
 * Registration for the usage dashboard's main-panel seat.
 *
 * Kept out of `index.tsx` deliberately. That file is already the browser half's
 * assembly point for the WorkBuddy cards, and the dashboard belongs to the
 * MERGED backends rather than to the WorkBuddy variant path — mixing the two
 * registrations in one function is what would make a future change to either
 * one require reading both.
 *
 * The panel registers on the same `main` slot the quota dashboard uses, under
 * its own key. Registering for a declaration that never arrives is a no-op by
 * construction, so no capability gate is needed.
 *
 * @module dsh-workbuddy-connect/client/usage-registration
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { UsagePanel } from './UsagePanel.tsx'
import { injectUsageCss } from './usage-styles.ts'
import { WORKBUDDY_USAGE_PATH } from '../usage-paths.ts'

/**
 * The panel key.
 *
 * Distinct from the quota dashboard's key: two entries under one key would
 * replace each other, and the usage page must be reachable while a WorkBuddy
 * variant's quota panel is also live.
 */
export const USAGE_PANEL_ID = 'dsh-workbuddy-connect-usage'

/** What the shell hands the panel at render time. */
export interface UsagePanelInjected {
  /** Path the panel fetches its document from. */
  usagePath: string
  /** Close the panel, when the surrounding shell offers a selection seam. */
  close: () => void
}

/**
 * Register the usage dashboard.
 *
 * @param ctx - the browser plugin context.
 * @param options - injects the panel's face (path and close seam).
 * @returns nothing; registration failures are logged, never thrown, so a
 *   missing seat cannot stop the rest of the browser half from loading.
 */
export function registerUsagePanel(ctx: ClientContext, options: {
  panelId: string
  close: () => void
}): void {
  ctx.effect(() => injectUsageCss(), 'dsh-workbuddy-connect: usage styles')
  const face = (): UsagePanelInjected => ({
    usagePath: WORKBUDDY_USAGE_PATH,
    close: options.close,
  })
  try {
    ctx.slots.inject('main', () => ctx.slots.register(
      { name: 'main', key: options.panelId, inject: face as never },
      UsagePanel as never,
    ))
  } catch (error: unknown) {
    console.error('[dsh-workbuddy-connect] could not register the usage panel:', error)
  }
}
