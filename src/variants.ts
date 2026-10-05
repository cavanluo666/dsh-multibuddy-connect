/**
 * The two WorkBuddy products this one plugin serves.
 *
 * Both are the same client framework in different regions, and they differ by
 * upstream realm, catalog endpoint, and display identity. Everything that
 * varies between them is collected here as one descriptor, so no module has to
 * carry its own `if (international)` branch and a third variant would be a data
 * change rather than a refactor.
 *
 * Each variant signs in independently, through its own realm's device
 * authorization flow. The two therefore never share a credential, and a realm
 * that is unreachable from the user's network (the international one, from some
 * mainland networks) cannot block the other's login.
 *
 * This module is host-side (it names files and routes). The browser half takes
 * the same ids and routes from the Node-free `status-paths.ts`, which stays the
 * single source shared by both halves.
 *
 * @module dsh-workbuddy-connect/variants
 */

import {
  WORKBUDDY_AI_LOGIN_PATH,
  WORKBUDDY_AI_PROBE_PATH,
  WORKBUDDY_AI_STATUS_PATH,
  WORKBUDDY_LOGIN_PATH,
  WORKBUDDY_PROBE_PATH,
  WORKBUDDY_STATUS_PATH,
} from './status-paths.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/** One WorkBuddy product variant. */
export interface WorkBuddyVariant {
  /** Provider id registered with DSH, e.g. `workbuddy-ai`. */
  id: string
  /** Model-group heading and card title stem, e.g. `WorkBuddy AI`. */
  displayName: string
  /** Product name as users know it, for diagnostics and error copy. */
  appName: string
  /** Which upstream realm this variant's credentials must belong to. */
  region: WorkBuddyRegion
  /** Basename of the plugin-owned credential file under `$DSH_HOME`. */
  ownFilename: string
  /** Basename of the plugin-owned probe-record file under `$DSH_HOME`. */
  probeFilename: string
  /**
   * Basename of the plugin-owned saved-catalog file under `$DSH_HOME`.
   *
   * One per variant, like the probe records: the two endpoints disagree about
   * rates, windows, and even which models exist for a shared id, so a catalog
   * saved from one must never be served as the other's.
   */
  catalogFilename: string
  /** Same-origin status route consumed by this variant's card. */
  statusPath: string
  /** Same-origin probe-control route consumed by this variant's card. */
  probePath: string
  /** Same-origin sign-in route consumed by this variant's card. */
  loginPath: string
}

/** CN WorkBuddy first: the existing provider keeps its id, paths, and copy. */
export const WORKBUDDY_VARIANTS: readonly WorkBuddyVariant[] = [
  {
    id: 'workbuddy',
    displayName: 'WorkBuddy',
    appName: 'WorkBuddy',
    region: 'cn',
    ownFilename: '.workbuddy-auth.json',
    probeFilename: '.workbuddy-probe.json',
    catalogFilename: '.workbuddy-catalog.json',
    statusPath: WORKBUDDY_STATUS_PATH,
    probePath: WORKBUDDY_PROBE_PATH,
    loginPath: WORKBUDDY_LOGIN_PATH,
  },
  {
    id: 'workbuddy-ai',
    displayName: 'WorkBuddy AI',
    appName: 'WorkBuddy AI',
    region: 'global',
    ownFilename: '.workbuddy-ai-auth.json',
    probeFilename: '.workbuddy-ai-probe.json',
    catalogFilename: '.workbuddy-ai-catalog.json',
    statusPath: WORKBUDDY_AI_STATUS_PATH,
    probePath: WORKBUDDY_AI_PROBE_PATH,
    loginPath: WORKBUDDY_AI_LOGIN_PATH,
  },
]

/** The CN variant; the plugin's long-standing default and compatibility anchor. */
export const CN_VARIANT: WorkBuddyVariant = WORKBUDDY_VARIANTS[0]!

/** The international variant. */
export const AI_VARIANT: WorkBuddyVariant = WORKBUDDY_VARIANTS[1]!

/** Look up a variant by provider id. */
export function variantFor(id: string): WorkBuddyVariant | undefined {
  return WORKBUDDY_VARIANTS.find(variant => variant.id === id)
}
