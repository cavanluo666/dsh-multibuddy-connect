import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/** Mirror the build-time define from tsdown.config.ts so tests see the same version. */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string

export default defineConfig({
  define: {
    __DSH_WORKBUDDY_VERSION__: JSON.stringify(PACKAGE_VERSION),
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // Each spec file gets its own process. The plugin resolves its data
    // directory from `$DSH_HOME`/profile discovery and many specs point that at
    // a temporary directory through `DSH_WORKBUDDY_DATA_DIR`; sharing one
    // process let those overrides leak between files, so a spec that expected
    // the default directory instead saw another file's temp dir and failed —
    // but only when the whole suite ran at once, never in isolation.
    pool: 'forks',
    isolate: true,
    // ...and the files run ONE AT A TIME. Process isolation alone was not
    // enough: the fork pool REUSES a worker for several files, and a file that
    // sets `DSH_WORKBUDDY_DATA_DIR` in a `beforeEach` leaves it set for
    // whatever runs next on that worker. The symptom was a flaky failure in the
    // pre-existing catalog/settings specs — a spec that had passed for months
    // failing roughly one run in three, in a different file each time. Serial
    // execution costs a few seconds and makes every spec's result depend on the
    // spec alone, which is the only property that makes a failure meaningful.
    fileParallelism: false,
  },
})
