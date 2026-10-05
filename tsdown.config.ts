import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'

/**
 * The manifest, read once and used for both build-time constants below.
 *
 * The package NAME is not duplicated as a literal. It is the client bundle's
 * registration key — DSH's `ClientBundleRegistration.id` is documented as
 * "Plugin id (package name) — the registration key; must match the graph row
 * being executed" — so a rename that updated package.json but left a literal
 * here produced a bundle that registered under a name the graph never asked
 * for. The failure was silent at build time and appeared only as "1 entry did
 * not activate" in the browser. Deriving it makes that class of drift
 * impossible: the two can no longer disagree.
 */
const MANIFEST = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name: string; version: string }

/** Client bundle registration id; must equal the package name. */
const PLUGIN_ID = MANIFEST.name

/** Read the npm version once so the build injects it into src/version.ts. */
const PACKAGE_VERSION = MANIFEST.version

/**
 * Build-time define map.
 *
 * `src/version.ts` reads `__DSH_WORKBUDDY_VERSION__`; `src/plugin-name.ts`
 * reads `__DSH_PLUGIN_NAME__`. Both come from the manifest, so neither can
 * drift from package.json.
 */
const DEFINES = {
  __DSH_WORKBUDDY_VERSION__: JSON.stringify(PACKAGE_VERSION),
  __DSH_PLUGIN_NAME__: JSON.stringify(PLUGIN_ID),
}

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-locale/client',
] as const

export default [
  {
    entry: {
      index: 'src/index.ts',
      bin: 'src/bin.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    define: DEFINES,
    deps: {
      neverBundle: [
        '@earendil-works/pi-ai',
        '@deepseek-ai/schemastery',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-atomic-write',
        '@deepseek-ai/dsh-attachment',
        '@deepseek-ai/dsh-home-paths',
        '@deepseek-ai/dsh-host-webserver',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-llm-pi-ai',
        '@deepseek-ai/dsh-settings',
      ],
    },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    clean: false,
    define: DEFINES,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
