/**
 * This bundle's package name, injected at build time.
 *
 * Kept as a single injected constant rather than a literal in each file that
 * needs it, because the name is not decoration — it is an identity that three
 * separate mechanisms look up by exact string:
 *
 *  - the client bundle's `__ModuleLoader__.load({ id })` registration, whose id
 *    DSH documents as "Plugin id (package name) — the registration key; must
 *    match the graph row being executed";
 *  - the `plugins.bundle.config` slot key, which the plugin manager's
 *    configuration ledger reads to decide whether to render this bundle's
 *    settings section at all;
 *  - the profile manifest lookup that decides which profile's data directory
 *    the plugin belongs to.
 *
 * Each of those fails QUIETLY when the string disagrees — a missing client
 * bundle, an absent settings section, a plugin writing to the wrong directory —
 * and none of them fails at build time. Deriving all of them from package.json
 * is what makes the class of bug impossible rather than merely fixed.
 *
 * The fallback keeps a build without the define (a bare test run) working, and
 * names the real package so behaviour does not silently change under test.
 */
declare const __DSH_PLUGIN_NAME__: string

/** The npm package name, as `package.json` declares it. */
export const PLUGIN_PACKAGE_NAME: string =
  typeof __DSH_PLUGIN_NAME__ === 'string' && __DSH_PLUGIN_NAME__ !== ''
    ? __DSH_PLUGIN_NAME__
    : 'dsh-multibuddy-connect'
