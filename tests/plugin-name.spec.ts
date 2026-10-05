import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PLUGIN_PACKAGE_NAME } from '../src/plugin-name.ts'

/**
 * The package name is an identity that several mechanisms match by EXACT
 * string, and every one of them fails quietly when it disagrees:
 *
 *  - the client bundle's `__ModuleLoader__.load({ id })` registration, which
 *    DSH documents as "must match the graph row being executed" — a mismatch
 *    produced "1 entry did not activate" in the browser, with no build error;
 *  - the `plugins.bundle.config` slot key, read by the plugin manager's
 *    configuration ledger to decide whether this bundle's settings section
 *    renders at all;
 *  - the profile-manifest lookup that decides which profile's data directory
 *    the plugin writes to.
 *
 * These assertions pin the constant to package.json and to the build config, so
 * a future rename that updates one place and not another fails HERE — at test
 * time, with a sentence explaining what broke — instead of as a plugin that
 * silently does not load.
 */
describe('package name identity', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { name: string }

  it('matches package.json', () => {
    expect(PLUGIN_PACKAGE_NAME).toBe(manifest.name)
  })

  it('is the id the client bundle build derives', () => {
    // tsdown.config.ts takes the id from the manifest rather than a literal;
    // this asserts the wiring is still in place, since reintroducing a literal
    // is exactly the regression that shipped once.
    const config = readFileSync(new URL('../tsdown.config.ts', import.meta.url), 'utf8')
    expect(config).toContain('const PLUGIN_ID = MANIFEST.name')
    expect(config).toContain('__DSH_PLUGIN_NAME__')
    // No stale literal may anchor the id.
    expect(config).not.toMatch(/const PLUGIN_ID = '/u)
  })

  it('is what the cordis patch row registers', () => {
    // The host discovers the client half through \`nearestPackage\`, comparing
    // the row specifier to this manifest's name and silently dropping the client
    // bundle on any mismatch.
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain(`name: ${manifest.name}`)
  })

  it('keeps the legacy name accepted by the profile lookup', async () => {
    // A profile that installed the upstream bundle can still carry that older
    // dependency row; refusing to recognise it would strand the user on the
    // fallback data directory.
    const paths = readFileSync(new URL('../src/paths.ts', import.meta.url), 'utf8')
    expect(paths).toContain("'dsh-workbuddy-connect'")
  })
})
