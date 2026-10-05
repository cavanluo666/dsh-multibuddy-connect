import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
//#region src/paths.ts
/**
* The plugin's data directory — the ONE place every file the plugin owns
* lives.
*
* Layout: `<profile>/.dsh-workbuddy-connect/config/` (the profile discovered
* the same way the credential store always did). Everything — credentials,
* saved catalogs, probe results, the host heartbeat, App-version caches —
* writes there, so a profile directory never collects loose `.workbuddy-*`
* files and the whole plugin's footprint is one folder.
*
* Fallbacks, in order: `DSH_WORKBUDDY_DATA_DIR` env override → the discovered
* profile → the Harness home (a checkout running its own tests, or a host
* loading the plugin from outside any profile).
*
* Split out of `auth.ts` so catalog/probe/heartbeat stores can import the
* directory without pulling in the credential code (and its upstream
* dependency) — these modules stay leaf-light on purpose.
*
* @module dsh-workbuddy-connect/paths
*/
/** The per-profile directory the plugin's data folder lives under. */
const WORKBUDDY_DATA_DIR_NAME = ".dsh-workbuddy-connect";
/** The directory inside the data dir where the rebuildable state files live. */
const WORKBUDDY_STATE_DIR_NAME = "state";
/** Environment override for the whole data directory. */
const WORKBUDDY_DATA_DIR_ENV = "DSH_WORKBUDDY_DATA_DIR";
const PROFILES_DIR_NAME = "profiles";
/** The npm name of this package, as a profile's manifest declares it. */
const PLUGIN_PACKAGE_NAME = "dsh-workbuddy-connect";
function pluginPackageRoot() {
	try {
		return dirname(dirname(fileURLToPath(import.meta.url)));
	} catch {
		return;
	}
}
/**
* Whether a profile directory declares this plugin.
*
* Read from the profile's manifest rather than inferred from this module's own
* location, because DSH installs a plugin into a profile by *link*: the manifest
* carries `"dsh-workbuddy-connect": "link:/path/to/checkout"`, while Node
* resolves the module to that real path, which lies outside `$DSH_HOME` entirely.
* Walking up from the module would therefore miss the profile for exactly the
* install shape a developer uses.
*/
function profileDeclaresPlugin(profileDir) {
	try {
		const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
		return typeof manifest.dependencies?.[PLUGIN_PACKAGE_NAME] === "string" || typeof manifest.devDependencies?.[PLUGIN_PACKAGE_NAME] === "string";
	} catch {
		return false;
	}
}
/**
* Whether a profile's installed copy of this plugin resolves to this package.
*
* This is what separates two profiles that both declare the plugin — a `web` and
* a `desktop` profile can each list it — so the data directory follows the
* profile whose copy is actually running rather than the first one found.
*/
function profileLinksToThisPackage(profileDir) {
	const own = pluginPackageRoot();
	if (own === void 0) return false;
	try {
		return realpathSync(join(profileDir, "node_modules", PLUGIN_PACKAGE_NAME)) === realpathSync(own);
	} catch {
		return false;
	}
}
/**
* The profile directory this plugin belongs to, or undefined when none can be
* determined.
*
* A single declaring profile is accepted without the link test, so a normal
* (non-linked) install still resolves.
*/
function discoverProfileDir() {
	const profilesRoot = join(resolveDshHome(), PROFILES_DIR_NAME);
	let entries;
	try {
		entries = readdirSync(profilesRoot, { withFileTypes: true });
	} catch {
		return;
	}
	const candidates = [];
	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const dir = join(profilesRoot, entry.name);
		if (profileDeclaresPlugin(dir)) candidates.push(dir);
	}
	if (candidates.length === 0) return void 0;
	if (candidates.length === 1) return candidates[0];
	return candidates.find((candidate) => profileLinksToThisPackage(candidate));
}
/**
* The plugin's data directory: `<profile>/.dsh-workbuddy-connect`.
*
* Falls back to the Harness home when no profile can be discovered — a
* checkout running its own tests, or a host that loads the plugin from
* outside a profile — so the plugin always has somewhere to write, and
* `DSH_WORKBUDDY_DATA_DIR` overrides either way.
*/
function workbuddyPluginDataDir() {
	const override = process.env[WORKBUDDY_DATA_DIR_ENV];
	if (override !== void 0 && override.trim() !== "") return override;
	const base = discoverProfileDir() ?? resolveDshHome();
	return join(base, WORKBUDDY_DATA_DIR_NAME);
}
/**
* The directory the rebuildable state files live in:
* `<data dir>/state/` (saved catalogs, probe records, the host heartbeat).
*/
function workbuddyStateDir() {
	return join(workbuddyPluginDataDir(), WORKBUDDY_STATE_DIR_NAME);
}
//#endregion
//#region src/app-version.ts
/**
* The international desktop app's version, used as the `/v3/config` UA.
*
* The App-shaped catalog is served only to a User-Agent carrying the product
* name (see `docs/workbuddy-ai-international-research-2026-09-11.md` §2.7).
* That document's conclusion recommended the space form `WorkBuddy AI/<v>`;
* re-measured on 2026-09-11 the *space* form is rejected (HTTP 400, code
* 12403) while the terse `WorkBuddyAI/<v>` form — with or without the space
* removed — returns the 21-model App document. The UA is therefore built from
* the form verified in code, not from the earlier prose.
*
* The version is only ever a UA component: a missing App, an unreadable
* plist, or a bad cached value degrades to the last saved value and finally to
* a compiled-in constant, and never blocks credential use or the provider.
*
* @module dsh-workbuddy-connect/app-version
*/
/**
* Last-resort UA version.
*
* The gateway ignores the version number when splitting the UA (research §2.7.2
* item 2: `CLI/1.0.0`, `CLI/99.0.0` and the real version all return the same
* document), so this constant is a shape requirement rather than a currency
* claim. It is *not* used to infer anything about model capabilities.
*/
const FALLBACK_APP_VERSION = "5.5.2";
/** Basename of the saved version under `$DSH_HOME`. */
const WORKBUDDY_APP_VERSION_FILENAME = ".workbuddy-ai-version.json";
/**
* Whether a string is safe to interpolate into an HTTP header.
*
* Strict on purpose: the value reaches a header, so anything that could split
* the request (CR, LF, spaces beyond the separator) or inject a second UA
* token must never pass. The App's own version is always `N.N.N` or `N.N.N.N`.
*/
function validAppVersion(value) {
	return typeof value === "string" && /^\d{1,6}(?:\.\d{1,6}){1,3}$/u.test(value);
}
/** macOS App-bundle roots: system-wide first, then the user's own install. */
function macAppRoots$1() {
	return ["/Applications", join(homedir(), "Applications")];
}
/**
* Read `CFBundleShortVersionString` out of an `Info.plist`.
*
* Parsed as XML rather than grepped, because the plist contains several
* `<string>` values and a regex would be one unrelated key away from
* returning the wrong one. A binary plist has no `<dict>` in its bytes and is
* reported as unreadable (the saved value then applies) rather than guessed at.
*/
async function readBundleVersion(plistPath) {
	let text;
	try {
		text = await readFile(plistPath, "utf8");
	} catch {
		return;
	}
	const version = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(text)?.[1]?.trim();
	return validAppVersion(version) ? version : void 0;
}
/**
* The installed international App's version, or `undefined` when it is not
* installed (or not readable).
*
* Windows and Linux have no verified bundle-metadata location yet, so this
* returns `undefined` there and the saved/fallback value is used instead of
* guessing a path — the same discipline the credential discovery follows.
*/
async function installedAppVersion() {
	if (process.platform !== "darwin") return void 0;
	for (const root of macAppRoots$1()) {
		const bundle = join(root, "WorkBuddy AI.app");
		const version = await readBundleVersion(join(bundle, "Contents", "Info.plist"));
		if (version !== void 0) return {
			version,
			bundle
		};
	}
}
/** Saved-version file path inside the plugin's config directory. */
function appVersionPath() {
	return join(workbuddyStateDir(), WORKBUDDY_APP_VERSION_FILENAME);
}
/**
* Resolve the UA version: installed App first, then the last saved value, then
* the compiled-in fallback.
*
* A value read from the App is written back immediately, so an uninstalled App
* or an unreadable plist later still has the last real version to fall back
* on. The write is best-effort: failing to cache a version must never fail the
* catalog request that asked for it.
*/
async function resolveAppVersion(options = {}) {
	const path = options.path ?? appVersionPath();
	const installed = await (options.installed ?? installedAppVersion)();
	if (installed !== void 0 && validAppVersion(installed.version)) {
		try {
			await writeFileAtomic(path, `${JSON.stringify({
				version: installed.version,
				bundle: installed.bundle,
				observedAt: Date.now()
			}, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		} catch {}
		return {
			version: installed.version,
			source: "installed",
			bundle: installed.bundle
		};
	}
	try {
		const saved = JSON.parse(await readFile(path, "utf8"));
		if (typeof saved === "object" && saved !== null) {
			const version = saved["version"];
			if (validAppVersion(version)) return {
				version,
				source: "saved"
			};
		}
	} catch {}
	return {
		version: FALLBACK_APP_VERSION,
		source: "fallback"
	};
}
/**
* Build the App-shaped User-Agent for catalog requests.
*
* `WorkBuddyAI/<version>` with no space is the form measured to reach the App
* document; the space form is rejected with 400/12403. Throws on an invalid
* version rather than sending a malformed header.
*/
function appUserAgent(version) {
	if (!validAppVersion(version)) throw new Error(`invalid WorkBuddy AI version for User-Agent: ${JSON.stringify(version)}`);
	return `WorkBuddyAI/${version}`;
}
//#endregion
//#region src/client-identity.ts
/**
* The desktop-client identity chat requests present as (phase 1 of
* `docs/upstream-identity-alignment-plan.md`).
*
* Chat and its probe sibling carry the User-Agent shape the official desktop
* client composes — `WorkBuddy/<v> <product>/<v> CLI/<cli>` — where the
* product token names the app that owns the region's requests: `WorkBuddy`
* for CN, `WorkBuddy AI` for international. Versions come from the installed
* App when it can be read, degrade to a per-region saved value, and finally
* to a compiled-in constant. A CLI version that does not resolve drops the
* `CLI/…` token instead of inventing one (the official client's own rule for
* a missing extension).
*
* Scope: chat and probe requests ONLY. Refresh, catalog, and billing keep
* the headers they have always sent; the plan holds the blast radius to this
* one variable so the live verification matrix stays readable.
*
* @module dsh-workbuddy-connect/client-identity
*/
/**
* Compiled-in CN fallback for the `WorkBuddy/<v>` tokens.
*
* Observed on the CN desktop app installed here (research §3.1, verified
* 2026-09-11); like the international fallback it is a shape requirement,
* not a currency claim — the gateway has not been observed to branch on it.
*/
const FALLBACK_CN_APP_VERSION = "5.5.6";
/**
* Basename of the CN saved-version cache under `$DSH_HOME`.
*
* Deliberately not the international `.workbuddy-ai-version.json`: that file
* feeds the international catalog's User-Agent, and a CN App writing its
* version into it would relabel that request. The two caches stay isolated
* the way the per-variant catalog files are.
*/
const CN_APP_VERSION_FILENAME = ".workbuddy-app-version.json";
/**
* Whether a value is a CLI version that may reach a header.
*
* Tolerates a prerelease suffix (`2.137.1-rc.1`) because the bundled CLI's
* own metadata uses that spelling; anything with whitespace, CR or LF never
* passes — the value is interpolated into an HTTP header.
*/
function validCliVersion(value) {
	return typeof value === "string" && /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/u.test(value);
}
/** macOS App-bundle roots, searched in the order `app-version.ts` uses. */
function macAppRoots() {
	return ["/Applications", join(homedir(), "Applications")];
}
/** Path of the bundled agent CLI's package.json inside an App bundle. */
function cliPackagePath(bundle) {
	return join(bundle, "Contents", "Resources", "app.asar.unpacked", "cli", "package.json");
}
/**
* The bundled agent CLI's real version, or `undefined` when it does not resolve.
*
* `cli/package.json` ships a `0.0.0` placeholder in `version` with the real
* version in `publishConfig.customPackage.version`; a valid non-placeholder
* `version` wins, otherwise the custom-package value applies, and unreadable
* or invalid metadata yields `undefined` (the caller drops the `CLI/…` UA
* token rather than guessing).
*/
async function readCliVersion(bundle) {
	let document;
	try {
		document = JSON.parse(await readFile(cliPackagePath(bundle), "utf8"));
	} catch {
		return;
	}
	if (typeof document !== "object" || document === null || Array.isArray(document)) return void 0;
	const pkg = document;
	const declared = pkg["version"];
	if (validCliVersion(declared) && declared !== "0.0.0") return declared;
	const publishConfig = pkg["publishConfig"];
	const customPackage = typeof publishConfig === "object" && publishConfig !== null && !Array.isArray(publishConfig) ? publishConfig : void 0;
	const customVersion = (typeof customPackage?.["customPackage"] === "object" && customPackage["customPackage"] !== null && !Array.isArray(customPackage["customPackage"]) ? customPackage["customPackage"] : void 0)?.["version"];
	return validCliVersion(customVersion) ? customVersion : void 0;
}
/**
* Build the chat User-Agent for one region.
*
* Throws on an invalid version rather than interpolating one into a header;
* `resolveChatIdentity` never produces such an identity, so the throw is a
* last gate against future call-site mistakes, not an expected path.
*/
function chatUserAgent(identity, region) {
	if (!validAppVersion(identity.clientVersion)) throw new Error(`invalid client version for chat User-Agent: ${JSON.stringify(identity.clientVersion)}`);
	if (identity.cliVersion !== void 0 && !validCliVersion(identity.cliVersion)) throw new Error(`invalid CLI version for chat User-Agent: ${JSON.stringify(identity.cliVersion)}`);
	const product = region === "global" ? "WorkBuddy AI" : "WorkBuddy";
	const parts = [`WorkBuddy/${identity.clientVersion}`, `${product}/${identity.clientVersion}`];
	if (identity.cliVersion !== void 0) parts.push(`CLI/${identity.cliVersion}`);
	return parts.join(" ");
}
/** The installed CN desktop bundle, or `undefined` when it is not installed (or not readable). */
async function installedCnApp() {
	if (process.platform !== "darwin") return void 0;
	for (const root of macAppRoots()) {
		const bundle = join(root, "WorkBuddy.app");
		const version = await readBundleVersion(join(bundle, "Contents", "Info.plist"));
		if (version !== void 0) return {
			version,
			bundle
		};
	}
}
/** Default CN saved-cache path. */
function cnSavedVersionPath() {
	return join(workbuddyStateDir(), CN_APP_VERSION_FILENAME);
}
/**
* Resolve the chat identity for one region: installed App → region's saved
* value → compiled-in fallback. Never throws — a missing App, an unreadable
* plist, a failed cache write, or a reader that throws outright all degrade
* to {@link fallbackChatIdentity}; resolution never blocks a message.
*
* The production path caches per region (a message must not re-read the
* install tree); any injected option bypasses the cache entirely so tests
* with different readers cannot observe each other's resolutions.
*/
async function resolveChatIdentity(region, options = {}) {
	const injectable = options.installedCn !== void 0 || options.resolveIntl !== void 0 || options.cliVersion !== void 0 || options.cnSavedPath !== void 0;
	if (!injectable) {
		const cached = cache.get(region);
		if (cached !== void 0) return cached;
	}
	let identity;
	try {
		identity = region === "global" ? await resolveGlobalIdentity(options) : await resolveCnIdentity(options);
	} catch {
		return fallbackChatIdentity(region);
	}
	if (!injectable) cache.set(region, identity);
	return identity;
}
const cache = /* @__PURE__ */ new Map();
/**
* The region's compiled-in fallback identity: the desktop form with the
* built-in version and no `CLI/…` segment. This is the single degraded
* shape every failure path converges on — a thrown reader, an unreadable
* bundle, or a missing cache all present this, never the legacy CLI UA.
*/
function fallbackChatIdentity(region) {
	return { clientVersion: region === "global" ? FALLBACK_APP_VERSION : FALLBACK_CN_APP_VERSION };
}
/** CN: installed `WorkBuddy.app` → CN saved cache → CN fallback. */
async function resolveCnIdentity(options) {
	const savedPath = options.cnSavedPath ?? cnSavedVersionPath();
	const installed = await (options.installedCn ?? installedCnApp)();
	if (installed !== void 0 && validAppVersion(installed.version)) {
		const cliVersion = await (options.cliVersion ?? readCliVersion)(installed.bundle);
		const identity = {
			clientVersion: installed.version,
			...cliVersion !== void 0 && validCliVersion(cliVersion) ? { cliVersion } : {}
		};
		try {
			await writeFileAtomic(savedPath, `${JSON.stringify({
				version: identity.clientVersion,
				observedAt: Date.now()
			}, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		} catch {}
		return identity;
	}
	try {
		const saved = JSON.parse(await readFile(savedPath, "utf8"));
		if (typeof saved === "object" && saved !== null && !Array.isArray(saved)) {
			const document = saved;
			if (validAppVersion(document["version"])) return { clientVersion: document["version"] };
		}
	} catch {}
	return fallbackChatIdentity("cn");
}
/**
* International: reuse `app-version.ts`'s installed → saved → fallback chain
* (its cache format and the catalog's version source stay untouched). The
* CLI version is read only when that chain reports the installed bundle; a
* saved or fallback resolution has no bundle path and drops the `CLI/…` token.
* The CN cache is never read or written on this path.
*/
async function resolveGlobalIdentity(options) {
	const info = await (options.resolveIntl ?? resolveAppVersion)();
	const clientVersion = validAppVersion(info.version) ? info.version : FALLBACK_APP_VERSION;
	let cliVersion;
	if (info.bundle !== void 0) {
		const read = await (options.cliVersion ?? readCliVersion)(info.bundle);
		if (read !== void 0 && validCliVersion(read)) cliVersion = read;
	}
	return {
		clientVersion,
		...cliVersion === void 0 ? {} : { cliVersion }
	};
}
//#endregion
//#region src/probe.ts
/**
* The reasoning-effort probe: decide whether a model's `reasoning_effort`
* parameter is actually validated, and if so which canonical values it accepts.
*
* Implements `docs/reasoning-effort-probe-plan.md` §4. The order matters and is
* not an optimization:
*
* 1. **Baseline** (no `reasoning_effort`) proves the model, credential, and
*    request shape work at all, so a later rejection can be attributed.
* 2. **Sentinel** (a fresh random, impossible-to-collide value) answers the one
*    question a per-level sweep cannot: does the upstream validate the field?
*    A model that accepts the sentinel answers 200 to *everything*, so its
*    per-level results would be uniformly false positives.
* 3. **Levels**, only after the sentinel was refused.
*
* The result is an observation, never a capability claim. Even a fully
* successful sweep means "the upstream accepted these spellings", not "these
* spellings change how the model thinks".
*
* @module dsh-workbuddy-connect/probe
*/
/**
* The canonical values a probe tests, in a fixed order.
*
* `minimal` is absent: it appears in no upstream vocabulary. `off` is absent
* by policy — disabling thinking is a separate capability the upstream must
* declare through `canDisableThinking`, never something probing may infer.
*/
const PROBE_EFFORT_CANDIDATES = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Prompt body used by every probe request; carries nothing user-specific. */
const PROBE_PROMPT = "ping";
/** Default sentinel: unmistakably non-canonical, different on every call. */
function randomSentinel() {
	return `probe_sentinel_${randomBytes(12).toString("hex")}`;
}
/**
* The upstream's "this effort value is not supported" code, measured
* 2026-09-11 (plan §4.2). It is *not* treated as a permanent protocol promise:
* anything unrecognized degrades to `unknown` rather than to a capability
* conclusion.
*/
const INVALID_EFFORT_CODE = "invalid_reasoning_effort";
/** Whether an attempt is an attributable rejection of the effort value. */
function isEffortRejection(attempt) {
	return attempt.status === 400 && attempt.errorCode === INVALID_EFFORT_CODE;
}
/** Whether an attempt shows the upstream accepted the request and streamed. */
function isAcceptance(attempt) {
	return attempt.status === 200 && attempt.streamed;
}
/** Why an attempt ended in `unknown`, phrased for a log line. */
function unknownReason(stage, attempt) {
	const code = attempt.errorCode === void 0 ? "" : ` (${attempt.errorCode})`;
	const detail = attempt.detail === void 0 ? "" : `: ${attempt.detail}`;
	return `${stage} status ${attempt.status}${code}${detail}`;
}
/**
* Probe one model.
*
* `options.candidates` exists so tests can shorten the sweep; production always
* uses {@link PROBE_EFFORT_CANDIDATES}.
*/
async function probeModel(options) {
	const sentinel = options.sentinel ?? randomSentinel;
	const candidates = options.candidates ?? PROBE_EFFORT_CANDIDATES;
	const timeoutMs = options.timeoutMs ?? 3e4;
	let requests = 0;
	const attempt = async (effort) => {
		requests += 1;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await options.send(effort, controller.signal);
		} catch (error) {
			return {
				status: 0,
				streamed: false,
				detail: `transport error: ${String(error)}`
			};
		} finally {
			clearTimeout(timer);
		}
	};
	const baseline = await attempt(void 0);
	if (!isAcceptance(baseline)) return {
		validation: "unknown",
		efforts: [],
		requests,
		reason: unknownReason("baseline", baseline)
	};
	const sentinelAttempt = await attempt(sentinel());
	if (isAcceptance(sentinelAttempt)) return {
		validation: "non-validating",
		efforts: [],
		requests
	};
	if (!isEffortRejection(sentinelAttempt)) return {
		validation: "unknown",
		efforts: [],
		requests,
		reason: unknownReason("sentinel", sentinelAttempt)
	};
	const accepted = [];
	for (const effort of candidates) {
		const levelAttempt = await attempt(effort);
		if (isAcceptance(levelAttempt)) {
			accepted.push(effort);
			continue;
		}
		if (isEffortRejection(levelAttempt)) continue;
		return {
			validation: "unknown",
			efforts: [],
			requests,
			reason: unknownReason(`level ${effort}`, levelAttempt)
		};
	}
	return {
		validation: "validating",
		efforts: accepted,
		requests
	};
}
//#endregion
//#region src/upstream.ts
/**
* WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client: chat streaming,
* token refresh, model catalog, and credit balance. The wire behavior is
* ported from Sliverkiss/workbuddy2api (MIT), whose Go implementation is
* battle-tested against the real endpoint.
*
* @module dsh-workbuddy-connect/upstream
*/
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
/**
* The domain the international gateway expects in `X-Domain`.
*
* A fixed value rather than the signed-in account's own domain: the
* international client declares it is talking to `www.workbuddy.ai` whichever
* host issued its session, and the gateway rejects the request as illegal when
* the declared domain disagrees.
*/
const GLOBAL_DOMAIN = "www.workbuddy.ai";
/** The chat path both realms serve. */
const CHAT_PATH = "/v2/chat/completions";
/**
* The international gateway's first-choice chat path.
*
* Tried before {@link CHAT_PATH} and abandoned on 404/405: the two deployments
* route chat differently, so a single hard-coded path fails one of them.
*/
const GLOBAL_CONSOLE_CHAT_PATH = "/console/chat/completions";
/**
* Display name for the single synthetic row the enterprise endpoint produces.
*
* The endpoint reports one cycle quota, not the personal endpoint's list of
* named packages, so the card's "by package" table has exactly one row.
*/
const enterprisePackageName = "enterprise";
/**
* Field names and value types of a response document, for diagnostics.
*
* Names and `typeof` only. This string ends up in the status route and then in
* the browser, and the response describes the account's own usage; the values
* themselves must never travel. Only the document and its `data` member are
* described, so the output stays small.
*/
function describeShape(document) {
	if (typeof document !== "object" || document === null || Array.isArray(document)) return typeof document;
	const record = document;
	const at = (source) => {
		const keys = Object.keys(source).slice(0, 24);
		return keys.length === 0 ? "(empty)" : keys.map((key) => `${key}:${typeof source[key]}`).join(", ");
	};
	const top = `top-level { ${at(record)} }`;
	const data = record["data"];
	if (typeof data !== "object" || data === null || Array.isArray(data)) return top;
	return `${top}; data { ${at(data)} }`;
}
/** Shared CLI-form User-Agent for refresh and the CN catalog; chat and probe present the desktop identity (client-identity.ts). */
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
/** Client version carried by the attribution and billing headers. */
const CLIENT_VERSION = "2.63.2";
/** Client name the upstream attributes usage to; the desktop product, not a gateway. */
const WORKBUDDY_CLIENT_NAME = "WorkBuddy";
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
	"insufficient credit",
	"no credit",
	"credit exhausted",
	"credits exhausted",
	"out of credit",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"credit not enough",
	"not enough credit",
	"积分不足",
	"额度不足",
	"余额不足",
	"积分用完",
	"额度用尽",
	"没有积分"
];
/**
* Rate-limit markers that arrive without a 429 status.
*
* The upstream reports throttling in the body on 200/400/403 as well, so a
* status-only test misses it and the account is neither cooled down nor moved
* aside — it simply keeps failing.
*/
const SOFT_RATE_MARKERS = [
	"rate limit",
	"rate-limiting",
	"rate-limited",
	"too many requests",
	"too many",
	"usage limit",
	"请求过于频繁",
	"限流"
];
/**
* Markers for "the account exists but its free trial was never activated".
*
* The international gateway answers HTTP 429 with business code 14017 and a
* message telling the user to sign out and back in to activate the trial. The
* status alone is indistinguishable from rate limiting, so without this list
* the failure renders as "slow down and retry" — advice that can never work,
* because no amount of retrying activates an account.
*
* The code is the reliable signal; the phrases cover bodies that arrive
* without it. Tested BEFORE the status-based 429 branch for that reason.
*
* The code is matched as a JSON field, never as a bare substring: every
* upstream error body carries a UUID requestId, and a four-digit substring
* test would eventually match one of those by chance and tell a throttled
* user to go activate an account that is already fine.
*/
const ACTIVATION_REQUIRED_CODES = [14017];
/** Wording that identifies the same condition when no code is present. */
const ACTIVATION_REQUIRED_MARKERS = [
	"trial version is not yet activated",
	"trial is not activated",
	"not yet activated",
	"免费试用未激活",
	"试用未激活"
];
/** Whether an upstream body carries an activation-required business code. */
function hasActivationCode(body) {
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		return false;
	}
	const codeFrom = (value) => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const record = value;
		for (const key of ["code", "errorCode"]) {
			const raw = record[key];
			const numeric = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
			if (ACTIVATION_REQUIRED_CODES.includes(numeric)) return true;
		}
		for (const key of ["data", "error"]) if (codeFrom(record[key])) return true;
		return false;
	};
	return codeFrom(parsed);
}
/** The concrete effort spellings WorkBuddy exposes on the wire. */
const EFFORT_VALUES = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Promotional badge keys the upstream tags carry, minus their color suffix. */
const BADGE_PREFIX = "badge:";
/** Parse the upstream `reasoning` object into {@link WorkBuddyModelReasoning}. */
function resolveUpstreamReasoning(wrapped) {
	const supports = wrapped["supportsReasoning"] === true;
	const onlyReasoning = wrapped["onlyReasoning"] === true;
	const rawReasoning = wrapped["reasoning"];
	let supportedEfforts;
	let defaultEffort;
	let canDisableThinking = true;
	if (typeof rawReasoning === "object" && rawReasoning !== null && !Array.isArray(rawReasoning)) {
		const reasoning = rawReasoning;
		const rawEfforts = reasoning["supportedEfforts"];
		if (Array.isArray(rawEfforts)) {
			const efforts = rawEfforts.filter((value) => typeof value === "string" && EFFORT_VALUES.includes(value));
			if (efforts.length > 0) supportedEfforts = efforts;
		}
		if (typeof reasoning["defaultEffort"] === "string" && EFFORT_VALUES.includes(reasoning["defaultEffort"])) defaultEffort = reasoning["defaultEffort"];
		else if (typeof reasoning["effort"] === "string" && EFFORT_VALUES.includes(reasoning["effort"])) defaultEffort = reasoning["effort"];
		canDisableThinking = reasoning["canDisableThinking"] === true;
	}
	return { reasoning: {
		supports,
		onlyReasoning,
		...supportedEfforts === void 0 ? {} : { supportedEfforts },
		...defaultEffort === void 0 ? {} : { defaultEffort },
		canDisableThinking
	} };
}
/**
* Reduce an upstream credits string to its language-neutral display form.
*
* The host LLM seam carries this text to the browser, and the host has no
* locale service — whatever string is produced here is shown verbatim in every
* UI language. The upstream is inconsistent in a way that matters: some catalog
* rows report a bare multiplier (`x0.79`) and others append a unit word
* (`x0.79 credits`), and the unit word would pin the display to English.
* Dropping a trailing `credits` (case-insensitive, singular or plural) yields
* the one spelling that reads identically in every language.
*
* @param credits - raw upstream credits string, e.g. `"x0.79 credits"`.
* @returns the bare multiplier, or undefined when nothing displayable remains.
*/
function normalizeCredits(credits) {
	if (credits === void 0) return void 0;
	const trimmed = credits.trim();
	if (trimmed === "") return void 0;
	if (/^credits?$/iu.test(trimmed)) return void 0;
	const bare = trimmed.replace(/\s+credits?$/iu, "").trim();
	return bare === "" ? void 0 : bare;
}
/** Parse the upstream `tags` / `credits` fields into billing metadata. */
function resolveUpstreamBilling(wrapped) {
	const rawCredits = wrapped["credits"];
	const credits = typeof rawCredits === "string" && rawCredits.trim() !== "" ? rawCredits.trim() : void 0;
	const badges = [];
	const rawTags = wrapped["tags"];
	if (Array.isArray(rawTags)) for (const tag of rawTags) {
		if (typeof tag !== "string") continue;
		if (!tag.toLowerCase().startsWith(BADGE_PREFIX)) continue;
		const label = tag.slice(6).split(":")[0] ?? tag.slice(6);
		if (label !== "") badges.push(label);
	}
	const free = credits !== void 0 && /^x?0\.0+$/u.test(credits);
	return { billing: {
		...credits === void 0 ? {} : { credits },
		...badges.length === 0 ? {} : { badges },
		free
	} };
}
/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS = ["Offline user session not found", "12153"];
/**
* Classify an upstream failure from its HTTP status and body excerpt.
*
* Order is load-bearing:
*
* - A hard credit refusal (402, or an exhausted-balance phrase) is terminal for
*   the account, so it is checked first.
* - Session death follows, because its marker appears in bodies that also carry
*   other numbers.
* - **429 comes before the credit phrase list.** A throttling body often also
*   says "quota exceeded"; reading that as an exhausted balance parks a healthy
*   account until the next billing day instead of retrying shortly. Testing the
*   status first is what keeps the two apart.
* - The phrase lists then catch what the status alone does not report.
*/
function classifyUpstreamError(status, body) {
	const lower = body.toLowerCase();
	if (status === 402) return "hard_credit";
	for (const marker of SESSION_DEAD_MARKERS) if (body.includes(marker)) return "session_dead";
	if (hasActivationCode(body)) return "activation_required";
	for (const marker of ACTIVATION_REQUIRED_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "activation_required";
	if (status === 429) return "soft_rate";
	for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
	for (const marker of SOFT_RATE_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	if (status >= 400) return "client";
	return "client";
}
/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
function regionOf(domain) {
	const lowered = domain.trim().toLowerCase();
	if (lowered === "workbuddy.ai" || lowered.endsWith(".workbuddy.ai")) return "global";
	return "cn";
}
/**
* The realm a credential belongs to.
*
* An explicit realm wins when it names the international deployment, matching
* the rule the sibling tooling applies: a credential that declares `global` is
* routed there even if its domain would say otherwise, while a domain naming
* `workbuddy.ai` is international whatever the explicit realm says. Anything
* else is CN, which keeps a credential that states nothing behaving exactly as
* it did before the field existed.
*/
function realmOf(credential) {
	if (credential.region === "global") return "global";
	return regionOf(credential.domain);
}
function chatBase(credential) {
	return realmOf(credential) === "global" ? GLOBAL_BASE : CN_CHAT_BASE;
}
function billingBase(credential) {
	return realmOf(credential) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
function originReferer(credential) {
	return realmOf(credential) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
/**
* Per-account device identifiers, derived from the uid.
*
* Stable across restarts and distinct per account, which is what the upstream
* treats a device fingerprint as: a missing or drifting one lets it associate
* several accounts as a single client. A credential with no uid carries none,
* since an anonymous request has no device to name.
*/
function accountStableHeaders(credential) {
	if (credential.uid === "") return {};
	return {
		"X-Machine-ID": deriveAccountStableId(credential.uid, "machine"),
		"X-Session-ID": deriveAccountStableId(credential.uid, "session")
	};
}
/** One stable 36-hex identifier for an account and purpose. */
function deriveAccountStableId(uid, purpose) {
	return createHash("sha256").update(`wb2a:${purpose}:${uid}`).digest("hex").slice(0, 36);
}
/** The locale the upstream expects for a realm's requests. */
function acceptLanguageFor(credential) {
	return realmOf(credential) === "global" ? "en-US" : "zh-CN";
}
/** Headers every upstream request shares. */
function commonHeaders(credential) {
	return {
		"Content-Type": "application/json",
		"Accept": "application/json",
		"X-Requested-With": "XMLHttpRequest",
		"Origin": originReferer(credential),
		"Referer": `${originReferer(credential)}/`,
		"User-Agent": CLIENT_UA,
		"X-CodeBuddy-Request": "1",
		"Accept-Language": acceptLanguageFor(credential),
		...accountStableHeaders(credential)
	};
}
/**
* Chat request headers, including the X-No-* conventions the official CLI uses.
*
* `userAgent` carries the desktop identity for chat and probe requests; when
* it is absent the shared CLI-form UA applies. Refresh shares `commonHeaders`
* but never this override, so the two paths cannot drift into each other.
*/
function chatHeaders(credential, userAgent) {
	const international = realmOf(credential) === "global";
	return {
		...commonHeaders(credential),
		...userAgent === void 0 ? {} : { "User-Agent": userAgent },
		"Accept": "application/json, text/event-stream",
		...credential.accessToken === "" ? { "X-No-Authorization": "1" } : { "Authorization": `Bearer ${credential.accessToken}` },
		...credential.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
		...international ? {
			"X-No-Enterprise-Id": "1",
			"X-Domain": GLOBAL_DOMAIN
		} : {
			...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
			...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain }
		},
		"X-Agent-Purpose": "conversation",
		"X-IDE-Name": WORKBUDDY_CLIENT_NAME,
		"X-IDE-Type": WORKBUDDY_CLIENT_NAME,
		"X-IDE-Version": CLIENT_VERSION,
		"X-Product": WORKBUDDY_CLIENT_NAME
	};
}
/**
* Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else.
*
* `X-Auth-Refresh-Source` names the channel the refresh came through. The value
* is `plugin`, matching the official client's own refresh channel.
*/
function refreshHeaders(credential) {
	const headers = {
		...commonHeaders(credential),
		"X-Refresh-Token": credential.refreshToken,
		"X-Auth-Refresh-Source": "plugin"
	};
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
	return headers;
}
/**
* Billing request headers.
*
* This path does not go through {@link commonHeaders}, so the gate header, the
* locale, the identity, and the account device ids are applied here as well — a
* billing call that looks like an unidentified client is the anomaly the
* upstream's own client never produces.
*/
function billingHeaders(credential) {
	const headers = {
		"Authorization": `Bearer ${credential.accessToken}`,
		"Accept": "application/json",
		"Content-Type": "application/json",
		"X-CodeBuddy-Request": "1",
		"Accept-Language": acceptLanguageFor(credential),
		"User-Agent": CLIENT_UA,
		...accountStableHeaders(credential)
	};
	if (credential.uid !== "") headers["X-User-Id"] = credential.uid;
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
		headers["X-Enterprise-Id"] = credential.enterpriseId;
		headers["X-Tenant-Id"] = credential.enterpriseId;
	}
	if (credential.domain !== "") headers["X-Domain"] = credential.domain;
	return headers;
}
/**
* Normalize an OpenAI chat-completions body for the WorkBuddy upstream: force
* `stream: true` (the upstream rejects non-streaming), translate the
* `max_completion_tokens` alias, default `stream_options`, flatten `tool_choice`
* (the upstream's field is a string; object forms return 400), and rewrite
* `developer` messages as `system`.
*
* The `developer` rewrite is load-bearing: pi-ai emits the system prompt as
* `role: "developer"` (the OpenAI convention it adopted), but the WorkBuddy
* upstream rejects that role with HTTP 400 code 11128 ("Illegal API
* invocation from an unapproved channel"). Rewriting to `system` is the
* compatible spelling the upstream accepts.
*/
function prepareChatBody(source) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return source;
	const obj = body;
	obj["stream"] = true;
	translateMaxCompletionTokens(obj);
	if (!("stream_options" in obj)) obj["stream_options"] = { include_usage: true };
	normalizeDeveloperRole(obj);
	normalizeToolChoice(obj);
	return JSON.stringify(obj);
}
/**
* Translate the `max_completion_tokens` alias into the `max_tokens` field the
* upstream actually reads.
*
* OpenAI deprecated `max_tokens` in favour of the alias, so a newer client sends
* only the alias; the upstream ignores it and falls back to its own default
* output cap, which truncates long answers. An explicit `max_tokens` wins and
* the alias is then dropped rather than translated, and a value that is not a
* positive integer is dropped without translating — `0` and `null` mean "not
* set", and a negative or non-numeric value is malformed input that must not be
* laundered into a valid one.
*/
function translateMaxCompletionTokens(obj) {
	const present = "max_completion_tokens" in obj;
	const alias = obj["max_completion_tokens"];
	delete obj["max_completion_tokens"];
	if (!present || "max_tokens" in obj) return;
	if (typeof alias === "number" && Number.isInteger(alias) && alias > 0) obj["max_tokens"] = alias;
}
/** Rewrite `role: "developer"` messages to `role: "system"` (upstream rejects developer). */
function normalizeDeveloperRole(obj) {
	const messages = obj["messages"];
	if (!Array.isArray(messages)) return;
	for (const message of messages) {
		if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
		const wrapped = message;
		if (wrapped["role"] === "developer") wrapped["role"] = "system";
	}
}
/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj) {
	const suppress = () => {
		delete obj["tools"];
		delete obj["functions"];
	};
	if (!("tool_choice" in obj)) return;
	const choice = obj["tool_choice"];
	if (typeof choice === "string") {
		if (choice.trim().toLowerCase() === "none") {
			delete obj["tool_choice"];
			suppress();
		}
		return;
	}
	if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
		const wrapped = choice;
		const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
		if (type === "none") {
			delete obj["tool_choice"];
			suppress();
		} else if (type === "auto" || type === "required") obj["tool_choice"] = type;
		else if (type === "function") {
			const fn = typeof wrapped["function"] === "object" && wrapped["function"] !== null ? wrapped["function"] : void 0;
			let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
			if (name === "" && typeof wrapped["name"] === "string") name = wrapped["name"];
			name = name.trim();
			obj["tool_choice"] = name !== "" ? name : "auto";
		} else delete obj["tool_choice"];
		return;
	}
	delete obj["tool_choice"];
}
async function readEnvelope(response) {
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`);
	const document = parsed;
	return {
		code: typeof document["code"] === "number" ? document["code"] : 0,
		msg: typeof document["msg"] === "string" ? document["msg"] : "",
		data: "data" in document ? document["data"] : void 0,
		document
	};
}
/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status, envelope) {
	const kind = classifyUpstreamError(status, envelope.msg);
	return /* @__PURE__ */ new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`);
}
/**
* Upstream HTTP client. One instance serves the whole plugin; requests take
* the credential explicitly so token refreshes apply on the next call.
*
* One instance is *per variant*: the international provider needs its own
* catalog source, UA version, and probe differences, and keeping them on the
* instance avoids passing a variant through every call signature.
*/
var WorkBuddyUpstreamClient = class {
	/**
	* Resolves the App-shaped UA version for international catalog requests.
	* Injectable so tests never read the real filesystem.
	*/
	resolveAppVersion;
	/** Chat-identity resolver; see {@link WorkBuddyUpstreamClientOptions.resolveChatIdentity}. */
	resolveChatIdentity;
	/** Provenance of the most recent successful catalog fetch, for the card. */
	lastCatalog;
	constructor(options = {}) {
		this.resolveAppVersion = options.resolveAppVersion ?? (() => resolveAppVersion());
		this.resolveChatIdentity = options.resolveChatIdentity ?? ((region) => resolveChatIdentity(region));
	}
	/** POST the chat endpoint; a successful answer is the raw SSE response. */
	async chatStream(credential, bodyJson, signal) {
		const region = realmOf(credential);
		let userAgent;
		try {
			userAgent = chatUserAgent(await this.resolveChatIdentity(region), region);
		} catch {
			userAgent = chatUserAgent(fallbackChatIdentity(region), region);
		}
		const body = withPromptCacheKey(region === "global" ? prepareInternationalChatBody(bodyJson) : bodyJson, credential.uid);
		let response;
		let lastFailure;
		try {
			for (const path of chatPaths(region)) {
				const attempt = await fetch(`${chatBase(credential)}${path}`, {
					method: "POST",
					headers: chatHeaders(credential, userAgent),
					body,
					...signal === void 0 ? {} : { signal }
				});
				if (attempt.ok) {
					response = attempt;
					break;
				}
				lastFailure = {
					status: attempt.status,
					text: (await attempt.text()).slice(0, ERROR_BODY_LIMIT)
				};
				if (!pathFallbackStatus(attempt.status)) break;
			}
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		}
		if (response !== void 0) return {
			ok: true,
			response
		};
		const failure = lastFailure ?? {
			status: 0,
			text: "no chat endpoint answered"
		};
		return {
			ok: false,
			status: failure.status,
			kind: classifyUpstreamError(failure.status, failure.text),
			message: failure.text
		};
	}
	/** POST the token-refresh endpoint; the caller merges the outcome. */
	async refreshToken(credential) {
		const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
			method: "POST",
			headers: refreshHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
		if (accessToken === "") throw new Error("workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app");
		const outcome = { accessToken };
		if (typeof data["refreshToken"] === "string" && data["refreshToken"] !== "") outcome.refreshToken = data["refreshToken"];
		if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) outcome.expiresInSec = data["expiresIn"];
		if (typeof data["domain"] === "string" && data["domain"] !== "") outcome.domain = data["domain"];
		return outcome;
	}
	/**
	* GET the personal model catalog.
	*
	* Two upstream documents feed this, one per variant:
	*
	* - CN (`workbuddy`): `/console/enterprises/personal/models`, the document
	*   the official CLI itself consumes. Unchanged behaviour.
	* - International (`workbuddy-ai`): `/v3/config`, the product document the
	*   App's main process fetches. The gateway splits it by User-Agent, so this
	*   request carries the App-shaped UA while every other request keeps the
	*   CLI UA it has always sent.
	*
	* Both are unwrapped and classified the same way — `readEnvelope` plus
	* `envelopeError` — so an expired session or exhausted credit is reported as
	* such rather than as a generic catalog failure.
	*/
	async fetchModels(credential, signal) {
		const international = realmOf(credential) === "global";
		const appVersion = international ? await this.resolveAppVersion() : void 0;
		const response = await fetch(`${chatBase(credential)}${international ? "/v3/config" : "/console/enterprises/personal/models"}`, {
			headers: {
				Authorization: `Bearer ${credential.accessToken}`,
				Accept: "application/json",
				Origin: originReferer(credential),
				Referer: `${originReferer(credential)}/`,
				...international ? {
					"X-Requested-With": "XMLHttpRequest",
					"X-Product": "SaaS"
				} : {},
				"User-Agent": appVersion === void 0 ? CLIENT_UA : appUserAgent(appVersion.version)
			},
			signal: signal === void 0 ? AbortSignal.timeout(JSON_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)])
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const models = parseModelCatalog(isObject(envelope.data) ? envelope.data : "models" in envelope.document || "agents" in envelope.document ? envelope.document : {}, international);
		this.lastCatalog = {
			fetchedAtMs: Date.now(),
			source: international ? "workbuddy-ai:app" : "workbuddy:cli",
			...appVersion === void 0 ? {} : { appVersion }
		};
		return models;
	}
	/**
	* POST the billing endpoint for the aggregated remaining credit.
	*
	* Two upstream shapes, chosen by account type:
	*
	* - **CN enterprise** (`regionOf === 'cn'` and `enterpriseId` non-empty) asks
	*   `/v2/billing/meter/get-enterprise-user-usage`, which answers with a single
	*   cycle quota. The personal endpoint serves these accounts an empty
	*   `Accounts` list, which the card then renders as "0 credit" — a wrong
	*   number rather than a visible failure (issue #31).
	* - **Everyone else** keeps the personal endpoint unchanged.
	*
	* The region gate is load-bearing: the enterprise endpoint is unverified for
	* the global region, so an international credential that happens to carry an
	* `enterpriseId` must stay on the measured personal path instead of being
	* moved onto an unmeasured one.
	*/
	async fetchCredits(credential) {
		if (realmOf(credential) === "cn" && credential.enterpriseId !== void 0 && credential.enterpriseId !== "") return await this.fetchEnterpriseCredits(credential);
		const now = /* @__PURE__ */ new Date();
		const format = (date) => [
			date.getFullYear().toString().padStart(4, "0"),
			(date.getMonth() + 1).toString().padStart(2, "0"),
			date.getDate().toString().padStart(2, "0")
		].join("-") + " " + [
			date.getHours().toString().padStart(2, "0"),
			date.getMinutes().toString().padStart(2, "0"),
			date.getSeconds().toString().padStart(2, "0")
		].join(":");
		const body = JSON.stringify({
			PageNumber: 1,
			PageSize: 100,
			ProductCode: "p_tcaca",
			Status: [0, 3],
			PackageEndTimeRangeBegin: format(now),
			PackageEndTimeRangeEnd: format(new Date(now.getTime() + 3185136e6))
		});
		let response;
		let lastStatus = 0;
		for (const path of billingMeterPaths(realmOf(credential))) {
			const attempt = await fetch(`${billingBase(credential)}${path}`, {
				method: "POST",
				headers: billingHeaders(credential),
				body,
				signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
			});
			lastStatus = attempt.status;
			if (attempt.ok || !pathFallbackStatus(attempt.status)) {
				response = attempt;
				break;
			}
		}
		if (response === void 0) throw new Error(`workbuddy billing endpoint unavailable (http ${lastStatus})`);
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const responseWrapper = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const data = typeof responseWrapper["Response"] === "object" && responseWrapper["Response"] !== null ? responseWrapper["Response"] : {};
		const inner = typeof data["Data"] === "object" && data["Data"] !== null ? data["Data"] : {};
		const rawAccounts = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
		const accounts = [];
		let total = 0;
		let totalSize = 0;
		for (const raw of rawAccounts) {
			if (typeof raw !== "object" || raw === null) continue;
			const account = raw;
			const numberField = (key) => typeof account[key] === "number" ? account[key] : 0;
			const size = numberField("CycleCapacitySize");
			const cycleRemain = numberField("CycleCapacityRemain");
			const cycleUsed = numberField("CycleCapacityUsed");
			const capacityRemain = numberField("CapacityRemain");
			let remain;
			if (size > 0) remain = cycleRemain;
			else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain;
			else remain = capacityRemain;
			if (remain < 0) remain = 0;
			total += remain;
			totalSize += size > 0 ? size : numberField("CapacitySize");
			accounts.push({
				packageName: typeof account["PackageName"] === "string" ? account["PackageName"] : "(unnamed)",
				remain,
				size: size > 0 ? size : numberField("CapacitySize"),
				...(() => {
					for (const key of ["CycleEndTime", "ExpiredTime"]) {
						const value = account[key];
						if (typeof value === "string" && value !== "") return { packageEndTime: value };
						if (typeof value === "number" && value > 0) return { packageEndTime: new Date(value).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace("T", " ") };
					}
					return {};
				})()
			});
		}
		const dosage = typeof inner["TotalDosage"] === "number" ? inner["TotalDosage"] : 0;
		if (dosage > totalSize) totalSize = dosage;
		return {
			total,
			accounts,
			...totalSize > 0 ? { totalSize } : {}
		};
	}
	/**
	* CN enterprise credit read: a single cycle quota instead of a package list.
	*
	* Verified against the WorkBuddy desktop app (`app.asar`,
	* `BackendProvider.getEnterpriseUsage` and `CloudAccountRepo.billing`): the
	* body is an empty object and the account identity travels only in the
	* headers. The two official call sites disagree on the field spelling
	* (`limitNum`/`credit` vs `limit_num`/`used_num`), so both are accepted.
	*
	* A body carrying no recognisable quota field is a hard error rather than a
	* zero. Rendering `0` for "we did not understand the answer" is exactly how
	* issue #31 stayed invisible while users saw a plausible wrong number.
	*
	* The error names fields and types only: it reaches the browser, and the
	* response body may describe the account's usage.
	*/
	async fetchEnterpriseCredits(credential) {
		const response = await fetch(`${CN_BILLING_BASE}/v2/billing/meter/get-enterprise-user-usage`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const sources = [];
		for (const candidate of [envelope.data, envelope.document]) {
			if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
			const record = candidate;
			if (typeof record["data"] === "object" && record["data"] !== null && !Array.isArray(record["data"])) sources.push(record["data"]);
			sources.push(record);
		}
		const numberAt = (source, key) => typeof source[key] === "number" ? source[key] : void 0;
		let limit;
		let used;
		let resetTime;
		for (const source of sources) {
			const candidate = numberAt(source, "limitNum") ?? numberAt(source, "limit_num");
			if (candidate === void 0) continue;
			limit = candidate;
			used = numberAt(source, "credit") ?? numberAt(source, "used_num");
			if (typeof source["cycleResetTime"] === "string" && source["cycleResetTime"] !== "") resetTime = source["cycleResetTime"];
			break;
		}
		if (limit === void 0) throw new Error(`workbuddy enterprise billing response carried no recognised quota field (expected limitNum/limit_num + credit/used_num; received ${describeShape(envelope.document)})`);
		if (limit === -1) return {
			total: 0,
			accounts: [{
				packageName: enterprisePackageName,
				remain: 0,
				size: 0,
				unlimited: true
			}],
			unlimited: true,
			...resetTime === void 0 ? {} : { cycleResetTime: resetTime }
		};
		if (used === void 0) throw new Error(`workbuddy enterprise billing response carried a quota limit but no recognised usage field (expected credit/used_num alongside limitNum/limit_num; received ${describeShape(envelope.document)})`);
		let remain = limit - used;
		if (remain < 0) remain = 0;
		return {
			total: remain,
			accounts: [{
				packageName: enterprisePackageName,
				remain,
				size: limit
			}],
			...resetTime === void 0 ? {} : { cycleResetTime: resetTime }
		};
	}
	/**
	* One probe request: a real streaming chat call carrying the effort under
	* test.
	*
	* Shares `chatHeaders` with the normal chat path on purpose — the plan
	* forbids probing through anything but the plugin's own credential handling,
	* so a result describes what a real message would experience.
	*
	* The caller aborts as soon as a parseable event arrives; the body is never
	* assembled into an answer. `reasoning_effort` is omitted entirely (rather
	* than sent empty) when `effort` is undefined, so the baseline case is a
	* genuinely bare request.
	*
	* Two international differences, both measured on 2026-09-11:
	*
	* - The gateway requires a leading `system` message (400/11128 otherwise), so
	*   one is prepended for the global region only.
	* - `max_tokens: 1` is below some models' floor (the GPT-5.6 family rejects it
	*   with 400/11133 `integer_below_min_value`), so the international probe asks
	*   for a slightly larger minimum. This is a floor the plugin must clear, not
	*   evidence about any model's effort support: a model still refusing that
	*   minimum is reported as an incompatible request, never as "effort
	*   unsupported", and the ceiling is never raised further to force an answer.
	*/
	async probeEffort(credential, model, effort, signal) {
		const international = realmOf(credential) === "global";
		let userAgent;
		try {
			userAgent = chatUserAgent(await this.resolveChatIdentity(international ? "global" : "cn"), international ? "global" : "cn");
		} catch {
			userAgent = chatUserAgent(fallbackChatIdentity(international ? "global" : "cn"), international ? "global" : "cn");
		}
		const payload = {
			model,
			stream: true,
			messages: [...international ? [{
				role: "system",
				content: INTERNATIONAL_SYSTEM_PROMPT
			}] : [], {
				role: "user",
				content: PROBE_PROMPT
			}],
			max_tokens: international ? INTERNATIONAL_PROBE_MAX_TOKENS : 1
		};
		if (effort !== void 0) payload["reasoning_effort"] = effort;
		let response;
		try {
			response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential, userAgent),
					"Authorization": `Bearer ${credential.accessToken}`
				},
				body: JSON.stringify(payload),
				signal
			});
		} catch (error) {
			return {
				status: 0,
				streamed: false,
				detail: `transport error: ${String(error)}`
			};
		}
		if (!response.ok) {
			const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
			return {
				status: response.status,
				streamed: false,
				...errorCodeOf(text)
			};
		}
		const streamed = await readFirstEvent(response);
		return {
			status: response.status,
			streamed
		};
	}
};
/**
* The chat paths to try, in order, for a realm.
*
* The international deployment answers chat on the console path and the CN
* deployment on the shared v2 path; the international list keeps the shared one
* as a fallback, so a deployment that changes its routing still resolves.
*/
function chatPaths(region) {
	return region === "global" ? [GLOBAL_CONSOLE_CHAT_PATH, CHAT_PATH] : [CHAT_PATH];
}
/** Whether a failed request should be retried on the next candidate path. */
function pathFallbackStatus(status) {
	return status === 404 || status === 405;
}
/**
* The personal billing paths to try, in order, for a realm.
*
* The international deployment serves the meter without the `/v2` prefix; the CN
* deployment serves it with one. Each realm tries its own spelling first and
* falls back to the other on a routing miss.
*/
function billingMeterPaths(region) {
	const withVersion = "/v2/billing/meter/get-user-resource";
	return region === "global" ? ["/billing/meter/get-user-resource", withVersion] : [withVersion];
}
/**
* Add a `prompt_cache_key` to an outbound chat body.
*
* The key is derived from the account's uid and its conversation, so the same
* conversation on the same account reuses the upstream's prefix cache while two
* accounts can never collide on one key — a collision would let one account hit
* a cached prefix belonging to another. A body that already carries a key is
* left alone: the caller knows better which prefix it means to reuse.
*
* A body that is not a JSON object is returned unchanged, matching
* {@link prepareChatBody}: a malformed body is the upstream's to reject, not
* this function's to rewrite.
*/
function withPromptCacheKey(source, uid) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return source;
	const obj = body;
	const existing = obj["prompt_cache_key"];
	if (typeof existing === "string" && existing !== "") return source;
	obj["prompt_cache_key"] = buildPromptCacheKey(uid, typeof obj["conversation_id"] === "string" && obj["conversation_id"] !== "" ? obj["conversation_id"] : typeof obj["conversationId"] === "string" && obj["conversationId"] !== "" ? obj["conversationId"] : "");
	return JSON.stringify(obj);
}
/** The stable `wb2a-<uid8>-<conversationHash>` cache key for one account. */
function buildPromptCacheKey(uid, conversation) {
	return `wb2a-${uid === "" ? "-" : uid.slice(0, 8)}-${createHash("sha256").update(`${uid}|${conversation}`).digest("hex").slice(0, 32)}`;
}
/** Pull `extError.code` out of an upstream error body, if it is shaped that way. */
function errorCodeOf(text) {
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const extError = parsed["extError"];
			if (typeof extError === "object" && extError !== null && !Array.isArray(extError)) {
				const code = extError["code"];
				if (typeof code === "string") return {
					errorCode: code,
					detail: code
				};
			}
		}
	} catch {}
	return { detail: text.slice(0, 200) };
}
/**
* Consume just enough of a streaming response to know it really streams.
*
* Returns true on the first chunk containing a data line. Cancels the body
* afterwards; a stream that ends or errors before that counts as not streamed,
* because an empty 200 is not evidence the effort was accepted.
*/
async function readFirstEvent(response) {
	const body = response.body;
	if (body === null) return false;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return false;
			if (decoder.decode(value, { stream: true }).includes("data:")) return true;
		}
	} catch {
		return false;
	} finally {
		await reader.cancel().catch(() => {});
	}
}
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positive(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
/** Parse either response shape after its envelope has been checked. */
function parseModelCatalog(data, international = false) {
	const rawModels = Array.isArray(data["models"]) ? data["models"] : [];
	const agents = Array.isArray(data["agents"]) ? data["agents"] : [];
	let cliIds;
	for (const agent of agents) if (typeof agent === "object" && agent !== null) {
		const wrapped = agent;
		if (wrapped["name"] === "cli" && Array.isArray(wrapped["models"])) {
			cliIds = wrapped["models"].filter((id) => typeof id === "string");
			break;
		}
	}
	if (cliIds === void 0 || cliIds.length === 0) throw new Error("workbuddy model catalog lists no cli agent models");
	const byId = /* @__PURE__ */ new Map();
	for (const model of rawModels) {
		if (typeof model !== "object" || model === null) continue;
		const wrapped = model;
		const id = typeof wrapped["id"] === "string" ? wrapped["id"] : "";
		if (id === "" || wrapped["disabled"] === true) continue;
		const input = typeof wrapped["maxInputTokens"] === "number" ? wrapped["maxInputTokens"] : 0;
		const output = typeof wrapped["maxOutputTokens"] === "number" ? wrapped["maxOutputTokens"] : 0;
		if (input <= 0 || output <= 0) continue;
		byId.set(id, {
			id,
			name: typeof wrapped["name"] === "string" && wrapped["name"] !== "" ? wrapped["name"] : id,
			contextWindow: international && isObject(wrapped["contextWindow"]) && positive(wrapped["contextWindow"]["defaultLength"]) ? wrapped["contextWindow"]["defaultLength"] : input,
			...international ? {
				...isObject(wrapped["contextWindow"]) && positive(wrapped["contextWindow"]["defaultLength"]) ? { defaultContextWindow: wrapped["contextWindow"]["defaultLength"] } : {},
				maxInputTokens: input,
				supportedContextWindows: isObject(wrapped["contextWindow"]) && Array.isArray(wrapped["contextWindow"]["supportedLengths"]) ? wrapped["contextWindow"]["supportedLengths"].filter(positive) : [],
				promotions: parsePromotions(data["modelPromotions"], id)
			} : {},
			maxTokens: output,
			supportsImages: wrapped["supportsImages"] === true && wrapped["disabledMultimodal"] !== true,
			...resolveUpstreamReasoning(wrapped),
			...resolveUpstreamBilling(wrapped)
		});
	}
	const models = cliIds.map((id) => byId.get(id)).filter((model) => model !== void 0);
	if (models.length === 0) throw new Error("workbuddy model catalog resolved to an empty list");
	return models;
}
/** Extract the promotions covering `model` from the `modelPromotions` array. */
function parsePromotions(value, model) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isObject(item) || item["enabled"] !== true) return [];
		const modelIds = item["modelIds"];
		if (!Array.isArray(modelIds) || !modelIds.includes(model)) return [];
		const schedule = item["schedule"];
		const discount = item["discount"];
		const badge = item["badge"];
		if (!isObject(schedule) || !isObject(discount) || !isObject(badge)) return [];
		if (discount["displayMode"] !== "replace") return [];
		const start = typeof schedule["validFrom"] === "string" ? Date.parse(schedule["validFrom"]) : NaN;
		const end = typeof schedule["validUntil"] === "string" ? Date.parse(schedule["validUntil"]) : NaN;
		const factor = discount["factor"];
		if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
		if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0) return [];
		return [{
			start,
			end,
			factor,
			label: typeof badge["label"] === "string" ? badge["label"] : "",
			priority: typeof item["priority"] === "number" && Number.isFinite(item["priority"]) ? item["priority"] : 0
		}];
	});
}
/**
* Re-evaluate a model's promotion against the current time.
*
* Promotions are time-boxed, and the catalog they arrive in is cached for the
* life of the process. Frozen at parse time, a cached "Free now" would keep
* claiming a discount after `validUntil` had passed, and would keep showing the
* pre-discount rate as the discounted one. Re-deriving on every read means the
* badge disappears on its own and the rate reverts, with no refresh needed.
*
* Non-destructive: the model's own `credits` and `badges` are the base, and the
* promotion is layered onto a copy. A model with no live promotion is returned
* as-is, so the common case allocates nothing.
*/
function modelWithCurrentPromotion(model, now = Date.now()) {
	if (model.promotions === void 0 || model.promotions.length === 0) return model;
	const promotion = [...model.promotions].sort((a, b) => b.priority - a.priority).find((candidate) => now >= candidate.start && now < candidate.end);
	if (promotion === void 0) {
		if (!(model.billing?.free === true || (model.billing?.badges?.length ?? 0) > 0 || model.promotions.some((candidate) => candidate.factor !== 1))) return model;
		const staleRate = normalizeCredits(model.billing?.credits);
		const expiredLabels = [...new Set(model.promotions.map((candidate) => candidate.label).filter((label) => label !== void 0 && label !== ""))];
		return {
			...model,
			billing: {
				free: false,
				rateUnknown: true,
				...staleRate === void 0 ? {} : { credits: staleRate },
				...expiredLabels.length === 0 ? {} : { expiredPromotions: expiredLabels }
			}
		};
	}
	const rate = normalizeCredits(model.billing?.credits);
	const original = rate !== void 0 && rate.startsWith("x") ? Number(rate.slice(1)) : NaN;
	if (promotion.factor !== 0 && !Number.isFinite(original)) return model;
	const value = promotion.factor === 0 ? 0 : original * promotion.factor;
	return {
		...model,
		billing: {
			...model.billing,
			credits: `x${value.toFixed(2)}`,
			free: value === 0,
			badges: [...model.billing?.badges ?? [], ...promotion.label === "" ? [] : [promotion.label]]
		}
	};
}
/**
* Apply the international endpoint's extra chat requirement: the first message
* must be a system prompt.
*
* The international gateway rejects a body whose first message is not `system`
* with HTTP 400 code 11128 ("first message is not system prompt"). Note that
* the *same* code means something else on the CN endpoint — there it reports a
* rejected `developer` role — so the two are never branched on by code alone.
*
* The added prompt is deliberately empty of user content and prepended, never
* merged: existing messages keep their order and wording. A body that is not a
* JSON object is returned unchanged, exactly as {@link prepareChatBody} does,
* so this is safe to run over an already-prepared-or-not body.
*/
function prepareInternationalChatBody(source) {
	const prepared = prepareChatBody(source);
	let body;
	try {
		body = JSON.parse(prepared);
	} catch {
		return prepared;
	}
	if (!isObject(body)) return prepared;
	const messages = body["messages"];
	if (!Array.isArray(messages)) return prepared;
	const first = messages[0];
	if (isObject(first) && first["role"] === "system") return prepared;
	messages.unshift({
		role: "system",
		content: INTERNATIONAL_SYSTEM_PROMPT
	});
	return JSON.stringify(body);
}
/**
* The system prompt injected when the international endpoint receives a body
* with none.
*
* Minimal on purpose: it exists to satisfy a gateway precondition, not to
* steer the model. The plugin is not the place to invent a persona, and the
* normal path never reaches this — pi-ai already sends the harness's system
* prompt, so this only covers a caller that omitted one.
*/
const INTERNATIONAL_SYSTEM_PROMPT = "You are a helpful assistant.";
/**
* Output ceiling for an international probe request.
*
* Above the smallest value that the strictest observed model accepts (the
* GPT-5.6 family rejects `1` with 11133), while still being far too small to
* produce a real answer. See {@link WorkBuddyUpstreamClient.probeEffort}.
*/
const INTERNATIONAL_PROBE_MAX_TOKENS = 16;
//#endregion
//#region src/auth.ts
/** The one provenance a stored credential can have: this plugin's own login. */
const WORKBUDDY_CREDENTIAL_SOURCE = "login";
/** Basename of the plugin-owned credential file inside the plugin's data directory. */
const WORKBUDDY_AUTH_FILENAME = ".workbuddy-auth.json";
/**
* Name of the folder this plugin keeps its own files in.
*
* Scoped per profile, so the two plugins' state and two profiles' sign-ins stay
* apart: DSH already separates a profile's installed plugins, and a credential
* belongs to the profile that is running rather than to the machine.
*/
const OWN_FORMAT_VERSION = 1;
/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
	if (value <= 0) return 0;
	return value > 0xe8d4a51000 ? value : value * 1e3;
}
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
function isDocument(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Plugin-owned credential path used when no variant names its own file.
*
* Credentials deliberately live at the DATA-DIRECTORY ROOT, outside `config/`
* (the user's ruling): a credential is secret material, not configuration, and
* keeping it apart from the rebuildable cache files makes "wipe the caches"
* a safe gesture that can never touch a credential.
*
* @returns the path inside the plugin's data directory.
*/
function workbuddyOwnAuthPath() {
	return join(workbuddyPluginDataDir(), WORKBUDDY_AUTH_FILENAME);
}
/**
* Parse a WorkBuddy credential document in either on-disk layout: the nested
* form `{"auth":{...},"account":{...}}` this plugin writes and the sibling
* tooling publishes, and the flat form hand-written files use. Returns undefined
* when the document carries no access token.
*
* Tolerance is deliberate: this is a published cross-tool format, and a file
* written by a sibling tool must keep loading rather than silently signing the
* user out. Two spellings of "which realm" are accepted 鈥?a top-level `region`
* and a nested `auth.realm` 鈥?because both are in use.
*/
function parseWorkBuddyAuth(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (!isDocument(parsed)) return void 0;
	let auth;
	let identity;
	if (isDocument(parsed["auth"])) {
		auth = parsed["auth"];
		identity = isDocument(parsed["account"]) ? parsed["account"] : {};
	} else {
		auth = parsed;
		identity = parsed;
	}
	const accessToken = typeof auth["accessToken"] === "string" ? auth["accessToken"] : "";
	if (accessToken === "") return void 0;
	const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number" ? expiryToMs(auth["refreshExpiresAt"]) : void 0;
	const enterpriseId = optionalString(identity["enterpriseId"]);
	const nickname = optionalString(identity["nickname"]);
	const realm = optionalString(parsed["region"]) ?? optionalString(auth["realm"]);
	return {
		accessToken,
		refreshToken: typeof auth["refreshToken"] === "string" ? auth["refreshToken"] : "",
		expiresAtMs: typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		domain: optionalString(auth["domain"]) ?? "",
		...realm === void 0 ? {} : { region: realm.trim().toLowerCase() === "global" ? "global" : "cn" },
		uid: optionalString(identity["uid"]) ?? "",
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname },
		source: WORKBUDDY_CREDENTIAL_SOURCE
	};
}
/**
* Parse a document this plugin wrote.
*
* Two spellings exist. Current versions write the nested cross-tool layout with
* a `version` marker; version 1 as originally shipped wrote the normalized
* credential under `credential` (camelCase `expiresAtMs`, identity at the top
* level). Both are read, because rejecting the older one would sign a working
* user out on upgrade.
*/
function parseOwnDocument(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (!isDocument(parsed)) return void 0;
	const stored = parsed["credential"];
	if (isDocument(stored) && typeof stored["accessToken"] === "string" && stored["accessToken"] !== "") {
		const refreshExpiresAtMs = typeof stored["refreshExpiresAtMs"] === "number" ? stored["refreshExpiresAtMs"] : void 0;
		const enterpriseId = optionalString(stored["enterpriseId"]);
		const nickname = optionalString(stored["nickname"]);
		const realm = optionalString(stored["region"]);
		return {
			accessToken: stored["accessToken"],
			refreshToken: typeof stored["refreshToken"] === "string" ? stored["refreshToken"] : "",
			expiresAtMs: typeof stored["expiresAtMs"] === "number" ? stored["expiresAtMs"] : 0,
			...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
			domain: optionalString(stored["domain"]) ?? "",
			...realm === void 0 ? {} : { region: realm.trim().toLowerCase() === "global" ? "global" : "cn" },
			uid: optionalString(stored["uid"]) ?? "",
			...enterpriseId === void 0 ? {} : { enterpriseId },
			...nickname === void 0 ? {} : { nickname },
			source: WORKBUDDY_CREDENTIAL_SOURCE
		};
	}
	return parseWorkBuddyAuth(text);
}
/**
* Serialize the plugin-owned document in the nested cross-tool layout.
*
* `expiresAt` is written in **seconds**, matching the sibling tooling this
* format comes from: the two write the same file, so a value in the wrong unit
* would be read as an expiry decades away rather than rejected. Readers here
* accept either unit, which is what makes that safe.
*
* Identity fields are omitted rather than written empty, so a credential whose
* account lookup failed does not claim a `uid` of `""`.
*/
function ownDocument(credential) {
	const region = realmOf(credential);
	return {
		version: OWN_FORMAT_VERSION,
		region,
		auth: {
			accessToken: credential.accessToken,
			refreshToken: credential.refreshToken,
			expiresAt: Math.floor(credential.expiresAtMs / 1e3),
			...credential.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAt: Math.floor(credential.refreshExpiresAtMs / 1e3) },
			domain: credential.domain,
			realm: region
		},
		account: {
			uid: credential.uid,
			...credential.enterpriseId === void 0 ? {} : { enterpriseId: credential.enterpriseId },
			...credential.nickname === void 0 ? {} : { nickname: credential.nickname }
		}
	};
}
/** Whether a filesystem error reports an absent path. */
function isENOENT(error) {
	return error?.code === "ENOENT";
}
/**
* Credential store with demand-driven refresh.
*
* Refresh policy: refresh only when the access token is inside the margin (or
* already expired), and keep the refreshed credential in the plugin-owned file.
* A failed refresh still returns a not-yet-expired token, so an unreachable
* refresh endpoint does not take down a working session.
*/
var WorkBuddyCredentialStore = class {
	variant;
	refresh;
	refreshMarginMs;
	ownPath;
	inflight;
	constructor(options) {
		this.variant = options.variant;
		this.refresh = options.refresh;
		this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
		this.ownPath = options.ownPath ?? (options.variant ? join(workbuddyPluginDataDir(), options.variant.ownFilename) : workbuddyOwnAuthPath());
	}
	/** The plugin-owned credential path, for diagnostics. */
	ownAuthPath() {
		return this.ownPath;
	}
	/**
	* Read the stored credential without refreshing anything.
	*
	* A credential belonging to the other realm is refused rather than used: one
	* plugin serves both products, and sending one realm's token to the other's
	* endpoint would leak it across products. The error names the file and the
	* expected realm, which is what makes it fixable.
	*/
	async current() {
		const credential = await this.readOwn();
		if (credential === void 0 || this.variant === void 0) return credential;
		const region = realmOf(credential);
		if (region !== this.variant.region) throw new Error(`${this.variant.displayName} holds a ${region === "cn" ? "WorkBuddy (CN)" : "WorkBuddy AI"} credential (domain ${JSON.stringify(credential.domain)}) in ${this.ownPath}; sign in again for ${this.variant.appName}, or remove that file`);
		return credential;
	}
	/**
	* Adopt a credential document supplied by the user.
	*
	* The document is parsed with the tolerant cross-tool reader, so a
	* `workbuddy.json` written by the sibling tooling imports as-is. It is then
	* checked against this store's realm before anything is written: a document
	* for the other product is refused with a message naming that product, rather
	* than stored and refused on every later read.
	*
	* @param text - the document's text, exactly as read from the user's file.
	* @returns the adopted credential, for a secret-free summary.
	* @throws when the text carries no usable credential or belongs to the other realm.
	*/
	async importDocument(text) {
		const credential = parseOwnDocument(text);
		if (credential === void 0) throw new Error("no usable credential in that document (expected an accessToken, as workbuddy.json has)");
		const region = realmOf(credential);
		if (this.variant !== void 0 && region !== this.variant.region) throw new Error(`that document belongs to ${region === "cn" ? "WorkBuddy (CN)" : "WorkBuddy AI"}, not ${this.variant.displayName}; import it for --provider ${region === "cn" ? "workbuddy" : "workbuddy-ai"}`);
		await this.saveOwn(credential);
		return credential;
	}
	/**
	* Persist a credential a login just obtained. This is the store's only write
	* path besides refresh; the login route is its only caller.
	*
	* A credential for the wrong realm is refused here, at the boundary that knows
	* which product asked, rather than written and refused on every later read.
	*/
	async save(credential) {
		if (this.variant !== void 0) {
			const region = realmOf(credential);
			if (region !== this.variant.region) throw new Error(`refusing to store a ${region === "cn" ? "WorkBuddy (CN)" : "WorkBuddy AI"} credential for ${this.variant.displayName}`);
		}
		await this.saveOwn(credential);
	}
	/**
	* The credential to send upstream: {@link current}, refreshed on demand.
	* Single-flight, so parallel requests share one refresh.
	*/
	async resolve() {
		const credential = await this.current();
		if (credential === void 0) {
			const app = this.variant?.appName ?? "WorkBuddy";
			throw new Error(`workbuddy: not signed in to ${app}; sign in from the plugin's settings card (the credential is stored at ${this.ownPath})`);
		}
		if (!this.needsRefresh(credential)) return credential;
		this.inflight ??= this.refreshNow(credential).finally(() => {
			this.inflight = void 0;
		});
		return this.inflight;
	}
	/** Read-only sign-in summary; never refreshes and never throws. */
	async status() {
		try {
			const credential = await this.current();
			if (credential === void 0) return { state: "signed-out" };
			return {
				state: "signed-in",
				expiresAtMs: credential.expiresAtMs,
				...credential.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
				...credential.nickname === void 0 ? {} : { nickname: credential.nickname },
				...credential.domain === "" ? {} : { domain: credential.domain },
				region: realmOf(credential)
			};
		} catch (error) {
			return {
				state: "signed-out",
				reason: error instanceof Error ? error.message : String(error)
			};
		}
	}
	/** Remove the stored credential. */
	async logout() {
		await rm(this.ownPath, { force: true });
	}
	needsRefresh(credential) {
		if (credential.expiresAtMs <= 0) return true;
		return Date.now() + this.refreshMarginMs >= credential.expiresAtMs;
	}
	async refreshNow(credential) {
		if (credential.refreshToken === "") {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error("workbuddy: access token expired and no refresh token is stored; sign in again from the settings card");
		}
		try {
			const outcome = await this.refresh(credential);
			const refreshed = {
				...credential,
				accessToken: outcome.accessToken,
				...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
				expiresAtMs: outcome.expiresInSec !== void 0 ? Date.now() + outcome.expiresInSec * 1e3 : credential.expiresAtMs,
				...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain },
				source: WORKBUDDY_CREDENTIAL_SOURCE
			};
			await this.saveOwn(refreshed);
			return refreshed;
		} catch (error) {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error(`workbuddy: token refresh failed and the access token is expired (${String(error)}); sign in again from the plugin's settings card`);
		}
	}
	async saveOwn(credential) {
		await mkdir(dirname(this.ownPath), {
			recursive: true,
			mode: 448
		});
		await writeFileAtomic(this.ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, {
			mode: 384,
			dirMode: 448
		});
	}
	async readOwn() {
		try {
			return parseOwnDocument(await readFile(this.ownPath, "utf8"));
		} catch (error) {
			if (isENOENT(error)) return void 0;
			return;
		}
	}
};
//#endregion
export { validAppVersion as A, resolveChatIdentity as C, installedAppVersion as D, appUserAgent as E, WORKBUDDY_DATA_DIR_NAME as M, workbuddyPluginDataDir as N, readBundleVersion as O, workbuddyStateDir as P, readCliVersion as S, WORKBUDDY_APP_VERSION_FILENAME as T, randomSentinel as _, workbuddyOwnAuthPath as a, chatUserAgent as b, modelWithCurrentPromotion as c, prepareChatBody as d, prepareInternationalChatBody as f, probeModel as g, PROBE_EFFORT_CANDIDATES as h, parseWorkBuddyAuth as i, WORKBUDDY_DATA_DIR_ENV as j, resolveAppVersion as k, normalizeCredits as l, regionOf as m, WORKBUDDY_CREDENTIAL_SOURCE as n, WorkBuddyUpstreamClient as o, realmOf as p, WorkBuddyCredentialStore as r, classifyUpstreamError as s, WORKBUDDY_AUTH_FILENAME as t, parseModelCatalog as u, CN_APP_VERSION_FILENAME as v, validCliVersion as w, fallbackChatIdentity as x, FALLBACK_CN_APP_VERSION as y };
