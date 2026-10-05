/**
 * The backend catalogue: every merged product, in the order the UI lists them.
 *
 * This is the ONE place the merge is enumerated. The shell iterates it to
 * register providers and build the usage dashboard; nothing else in the plugin
 * hardcodes a backend id. Adding a tenth backend is one entry here plus its own
 * module — not a change scattered across routes, cards, and tests.
 *
 * ORDER IS PRESENTATION. The list renders top-to-bottom in the settings card
 * and in the usage dashboard, so the backends a mainland user is most likely to
 * have installed come first.
 *
 * Every factory is LAZY — a function, not an instance — because constructing a
 * backend touches the filesystem (probing for a desktop app) and building the
 * catalogue must stay free of I/O. The shell decides when to instantiate.
 *
 * @module dsh-workbuddy-connect/backends/catalog
 */

import type { BackendAccountRegistry } from './registry.ts'
import { seedsFor } from './wiring.ts'
import type { BackendAdapter } from './types.ts'

/** One catalogue entry: a backend and how to build it. */
export interface BackendEntry {
  /** Provider id; must equal the descriptor's own id. */
  id: string
  /**
   * Build the adapter.
   *
   * Receives the shared registry so an api-key backend can be handed the
   * accounts the user configured. Desktop-adoption backends ignore it — their
   * account comes from another program, not from a file this plugin owns.
   */
  create: (registry: BackendAccountRegistry) => Promise<BackendAdapter> | BackendAdapter
}

/**
 * The merged backends, in display order.
 *
 * Static imports would turn a typo in a module path into a build failure, which
 * is strictly better — but several backends pull in Node built-ins and one may
 * fail to load on a platform it does not support, so the dynamic import is what
 * lets {@link loadBackends} attribute that failure to one backend instead of
 * losing the whole catalogue.
 */
export const BACKEND_ENTRIES: readonly BackendEntry[] = [
  {
    id: 'loomy',
    create: async () => (await import('./loomy.ts')).createLoomyBackend(),
  },
  {
    id: 'mimo',
    create: async () => (await import('./mimo.ts')).createMiMoBackend(),
  },
  {
    id: 'cline',
    create: async registry => {
      const accounts = await seedsFor(registry, 'cline')
      const { createClineBackend } = await import('./cline.ts')
      // Built conditionally rather than passing `accounts: undefined`: under
      // `exactOptionalPropertyTypes` an explicit undefined is not the same as
      // an absent key, and the backend distinguishes them (absent means "fall
      // back to the environment", empty means "the user configured nothing").
      return accounts === undefined ? createClineBackend() : createClineBackend({ accounts })
    },
  },
  {
    id: 'commandcode',
    create: async registry => {
      const accounts = await seedsFor(registry, 'commandcode')
      const { createCommandCodeBackend } = await import('./commandcode.ts')
      return accounts === undefined
        ? createCommandCodeBackend({ registry })
        : createCommandCodeBackend({ accounts, registry })
    },
  },
  {
    id: 'trae',
    create: async () => (await import('./trae.ts')).createTraeBackend(),
  },
  {
    id: 'qoder',
    create: async () => (await import('./qoder.ts')).createQoderBackend(),
  },
  {
    id: 'codebuddy',
    create: async () => (await import('./codebuddy.ts')).createCodeBuddyBackend(),
  },
  {
    id: 'opencode',
    create: async () => (await import('./opencode.ts')).createOpenCodeBackend(),
  },
]

/** One backend that could not be built, reported rather than swallowed. */
export interface BackendLoadFailure {
  id: string
  message: string
}

/** The outcome of building every backend. */
export interface BackendLoadResult {
  backends: readonly BackendAdapter[]
  failures: readonly BackendLoadFailure[]
}

/**
 * Build every catalogue backend, containing each failure.
 *
 * The merged backends are maintained by different authors against different
 * vendors. One breaking — a module that will not import on this platform, a
 * constructor that throws — must leave the others working AND leave a visible
 * record, so the user can see which one is at fault instead of wondering why a
 * model group vanished.
 *
 * @param registry - the shared account registry.
 * @returns the built adapters plus one failure record per backend that failed.
 */
export async function loadBackends(registry: BackendAccountRegistry): Promise<BackendLoadResult> {
  const backends: BackendAdapter[] = []
  const failures: BackendLoadFailure[] = []
  for (const entry of BACKEND_ENTRIES) {
    try {
      backends.push(await entry.create(registry))
    } catch (error: unknown) {
      failures.push({ id: entry.id, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { backends, failures }
}
