import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * WHY THIS FILE EXISTS.
 *
 * Two modules here were written, tested and merged while being UNREACHABLE from
 * the package entry point - first the multi-account pool, then the growth
 * automation. Both times the unit tests passed, because they import the module
 * directly; only a consumer going through lib/index.js noticed, and it noticed
 * as "WorkBuddyAccountManager is not a constructor".
 *
 * The entry point is the package's public surface, so a module not exported from
 * it is a module nobody outside this repository can use. These assertions turn
 * that state into a test failure instead of a runtime surprise.
 */
describe('public exports', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

  /** Modules that must be reachable from the package entry point. */
  const REQUIRED: readonly { module: string; symbol: string }[] = [
    { module: './pool.ts', symbol: 'WorkBuddyAccountPool' },
    { module: './pool.ts', symbol: 'cooldownMsFor' },
    { module: './pool-failover.ts', symbol: 'withFailover' },
    { module: './account-manager.ts', symbol: 'WorkBuddyAccountManager' },
    { module: './growth.ts', symbol: 'WorkBuddyGrowthClient' },
    { module: './growth.ts', symbol: 'growthOrigin' },
    { module: './growth-scheduler.ts', symbol: 'GrowthScheduler' },
  ]

  for (const { module, symbol } of REQUIRED) {
    it('re-exports ' + symbol + ' from ' + module, () => {
      expect(source).toContain(symbol)
      // The symbol must appear in a re-export FROM that module, not merely
      // somewhere in the file: a bare side-effect import would satisfy the
      // first assertion while exporting nothing.
      const blocks = source.split('} from ' + JSON.stringify(module).replace(/"/g, "'"))
      expect(blocks.length).toBeGreaterThan(1)
      const exported = blocks.slice(0, -1).join('')
      expect(exported).toContain(symbol)
    })
  }

  it('keeps the pre-existing surfaces exported too', () => {
    // A regression here would break consumers that predate the pool.
    for (const symbol of ['WORKBUDDY_VARIANTS', 'createWorkBuddyAdapter', 'WorkBuddyCatalog']) {
      expect(source).toContain(symbol)
    }
  })
})
