import { n as BaseBackendAdapter } from "./base-B4d56Evj.js";
//#region src/backends/cline.ts
/**
* Cline (免费模型) — an API-key backend.
*
* The original plugin (cline-free-provider) is a pi-ai transport: it mints a
* provider route, scrubs the wire, and streams. None of that belongs here. What
* this adapter keeps is the part the shell genuinely needs — WHICH accounts
* exist and WHICH models they can reach — and it keeps it read-only: the
* catalog is fetched from Cline's public feed, never written back.
*
* Cline is a MULTI-ACCOUNT candidate, and the reason is structural rather than
* aspirational: a Cline credential is a bearer API key, and two keys are two
* independent accounts upstream (separate rate limits, separate free-tier
* grants). Nothing in the vendor's model pins a machine to one key the way a
* desktop app's single login slot does, so multiAccount is true and the
* accounts arrive from the shared BackendAccountRegistry — this file
* deliberately does not know where they are stored.
*
* reportsQuota is false. Cline's free tier has no balance concept to read: the
* models are free, the key is the entitlement, and there is no billing endpoint
* whose absence could be mistaken for "zero left". The dashboard therefore
* shows the account as "not reportable" rather than charting a zero.
*
* @module dsh-workbuddy-connect/backends/cline
*/
/** Environment variable the original plugin reads the API key from. */
const API_KEY_ENV = "CLINE_API_KEY";
/**
* Optional endpoint override, matching the original plugin's baseURL config.
*
* Kept as an environment escape hatch rather than a constructor parameter so a
* self-hosted or proxied Cline deployment can be pointed at without a settings
* round-trip — the same reasoning as Loomy's file-path overrides.
*/
const BASE_URL_ENV = "CLINE_BASE_URL";
/** The upstream the original plugin ships against. */
const DEFAULT_BASE_URL = "https://api.cline.bot/api/v1";
/**
* Free models the catalog feed does not tag itself.
*
* The authoritative source is the recommended-models free bucket, fetched live
* on every discovery. This list exists because that feed's pricing field
* describes the upstream market price rather than Cline's own free
* designation, and the two rotate independently. Copied verbatim from the
* original plugin — inventing or extending it here would be guessing at a
* vendor's promotions.
*/
const EXTRA_FREE_MODEL_IDS = /* @__PURE__ */ new Set([
	"deepseek/deepseek-v4-flash",
	"z-ai/glm-5.3-flash",
	"meta/muse-spark-1.3"
]);
/** How long any one feed request may take before it is abandoned. */
const FEED_TIMEOUT_MS = 3e4;
/** The descriptor this backend registers under. */
const CLINE_DESCRIPTOR = {
	id: "cline",
	displayName: "Cline",
	description: "Cline 免费模型（API key 认证）",
	brand: {
		vendor: "Cline",
		product: "Cline"
	},
	authKind: "api-key",
	multiAccount: true,
	reportsQuota: false,
	reportsTokenUsage: false,
	settingsNs: "llm-cline"
};
/** True for a JSON object that is not an array. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** A finite positive number, or undefined for anything else. */
function positiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
/**
* Fetch and parse one JSON document from the Cline feed.
*
* Throws on a non-2xx or an unparseable body: the caller decides whether that
* is fatal, because the two feeds differ in importance. The recommended-models
* bucket is a refinement and may fail alone; the model list IS the roster.
*
* @param url - absolute feed URL.
* @param label - feed name, used in the error message.
* @param fetchImpl - fetch implementation; injected for tests.
* @returns the parsed JSON value, shape unknown.
*/
async function fetchJson(url, label, fetchImpl) {
	const response = await fetchImpl(url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(FEED_TIMEOUT_MS)
	});
	if (!response.ok) throw new Error(label + " 端点返回 HTTP " + String(response.status));
	return await response.json();
}
/**
* Read Cline's own free-tier designation.
*
* @param baseUrl - the API root.
* @param fetchImpl - fetch implementation.
* @returns the designated model ids, or an empty set when the feed is missing
*   or malformed. Never throws: the suffix-and-extras rule still yields a
*   usable roster, and losing the whole catalog over an optional refinement
*   would be the worse failure.
*/
async function fetchFreeModelIds(baseUrl, fetchImpl) {
	try {
		const payload = await fetchJson(baseUrl + "/ai/cline/recommended-models", "Cline recommended models", fetchImpl);
		if (!isRecord(payload) || !Array.isArray(payload["free"])) return /* @__PURE__ */ new Set();
		const ids = /* @__PURE__ */ new Set();
		for (const entry of payload["free"]) if (isRecord(entry) && typeof entry["id"] === "string" && entry["id"] !== "") ids.add(entry["id"]);
		return ids;
	} catch {
		return /* @__PURE__ */ new Set();
	}
}
/**
* Read the free models Cline currently serves.
*
* A model counts as free when its feed id carries the :free suffix, when it
* appears in EXTRA_FREE_MODEL_IDS, or when the recommended-models bucket names
* it. Bucket ids may use Cline's own cline-free/ namespace, so an exact feed
* match is tried first and an unambiguous slug match second — an ambiguous slug
* (two feed entries ending in the same segment) is dropped rather than guessed
* at, since picking the wrong one would silently offer a paid model as free.
*
* @param baseUrl - the API root.
* @param fetchImpl - fetch implementation.
* @returns the free models, sorted by id for a stable roster.
*/
async function fetchFreeModels(baseUrl, fetchImpl) {
	const [payload, freeBucketIds] = await Promise.all([fetchJson(baseUrl + "/ai/cline/models", "Cline models", fetchImpl), fetchFreeModelIds(baseUrl, fetchImpl)]);
	if (!isRecord(payload) || !Array.isArray(payload["data"])) throw new Error("Cline models 端点返回了非预期的结构");
	const rawEntries = payload["data"];
	const feedIds = /* @__PURE__ */ new Set();
	for (const raw of rawEntries) if (isRecord(raw) && typeof raw["id"] === "string") feedIds.add(raw["id"]);
	const freeFeedIds = /* @__PURE__ */ new Set();
	for (const id of feedIds) if (id.endsWith(":free") || EXTRA_FREE_MODEL_IDS.has(id)) freeFeedIds.add(id);
	for (const bucketId of freeBucketIds) {
		if (feedIds.has(bucketId)) {
			freeFeedIds.add(bucketId);
			continue;
		}
		const slug = bucketId.split("/").at(-1);
		if (slug === void 0) continue;
		const matches = [...feedIds].filter((id) => id.split("/").at(-1) === slug);
		if (matches.length === 1) freeFeedIds.add(matches[0]);
	}
	const models = [];
	for (const raw of rawEntries) {
		if (!isRecord(raw) || typeof raw["id"] !== "string") continue;
		const id = raw["id"];
		if (!freeFeedIds.has(id)) continue;
		const name = typeof raw["name"] === "string" && raw["name"] !== "" ? raw["name"] : id;
		const contextWindow = positiveNumber(raw["context_length"]);
		const maxTokens = positiveNumber((isRecord(raw["top_provider"]) ? raw["top_provider"] : void 0)?.["max_completion_tokens"]);
		const architecture = isRecord(raw["architecture"]) ? raw["architecture"] : void 0;
		const modalities = architecture !== void 0 && Array.isArray(architecture["input_modalities"]) ? architecture["input_modalities"] : void 0;
		models.push({
			id,
			name,
			...contextWindow === void 0 ? {} : { contextWindow },
			...maxTokens === void 0 ? {} : { maxTokens },
			...modalities !== void 0 && modalities.includes("image") ? { supportsImages: true } : {}
		});
	}
	models.sort((a, b) => a.id.localeCompare(b.id));
	return models;
}
/**
* Mask an API key for display.
*
* Mirrors the shared maskSecret rule without importing it: this adapter must
* stay a leaf, and pinning the rendering keeps a key identifiable in the
* picker (sk-a...1b2c) while revealing too little to be worth stealing. A short
* key is masked entirely, because a six-character value has no safe window.
*
* @param secret - the raw key.
* @returns a display-safe rendering.
*/
function maskKey(secret) {
	if (secret.length <= 12) return "•".repeat(Math.max(4, secret.length));
	return secret.slice(0, 4) + "…" + secret.slice(-4);
}
/**
* Resolve the accounts to serve.
*
* The injected list wins outright — an empty-but-present list from the registry
* means the user has configured accounts, just none right now, and silently
* resurrecting an environment key would show an account the user believes they
* removed. Only a genuinely ABSENT list falls back to CLINE_API_KEY.
*
* @param options - the factory options.
* @returns the accounts to report, in the order given.
*/
function resolveAccounts(options) {
	if (options.accounts !== void 0) return options.accounts;
	const fromEnv = process.env[API_KEY_ENV];
	if (fromEnv === void 0 || fromEnv.trim() === "") return [];
	return [{
		id: "default",
		label: "CLINE_API_KEY",
		secret: fromEnv.trim()
	}];
}
/**
* The API root in force.
*
* Precedence runs constructor, then environment, then the vendor default: the
* integration layer's explicit choice beats an ambient variable, and the
* variable beats a hardcoded host so a proxy can be slotted in without a
* rebuild.
*
* @param options - the factory options.
* @returns an absolute base URL without a trailing slash.
*/
function resolveBaseUrl(options) {
	const explicit = options.baseUrl ?? process.env[BASE_URL_ENV];
	const trimmed = explicit === void 0 ? "" : explicit.trim().replace(/\/+$/u, "");
	return trimmed === "" ? DEFAULT_BASE_URL : trimmed;
}
/** Cline's product-specific half. */
var ClineImpl = class {
	accounts;
	baseUrl;
	fetchImpl;
	constructor(accounts, baseUrl, fetchImpl) {
		this.accounts = accounts;
		this.baseUrl = baseUrl;
		this.fetchImpl = fetchImpl;
	}
	/**
	* Report the injected accounts.
	*
	* There is no third-party application to probe and therefore no "unavailable"
	* state: Cline is reached over the network with a key, so the only two
	* outcomes are "keys exist" and "no keys". An account whose key is blank is
	* reported unusable rather than dropped, so the picker can explain why the row
	* is inert instead of leaving the user wondering where it went.
	*
	* @returns one entry per configured account.
	*/
	async discover() {
		const out = [];
		for (const account of this.accounts) {
			const secret = account.secret.trim();
			if (secret === "") {
				out.push({
					id: account.id,
					label: account.label,
					usable: false,
					reason: "API key 为空"
				});
				continue;
			}
			out.push({
				id: account.id,
				label: account.label,
				detail: maskKey(secret),
				usable: true
			});
		}
		return out;
	}
	/**
	* List the free models for one account.
	*
	* The roster is upstream's, not per-account: Cline's free catalog is keyed by
	* account tier upstream, but the public feed this reads is not partitioned by
	* key, so every account legitimately sees the same list. An unreachable feed
	* returns nothing rather than throwing — the base class renders an empty
	* roster as "registered, nothing to offer", which is the honest answer when
	* the catalog cannot be read.
	*
	* @param _accountId - unused; accepted to satisfy the interface.
	* @returns the free models, or none when the feed is unreachable.
	*/
	async models(_accountId) {
		try {
			return await fetchFreeModels(this.baseUrl, this.fetchImpl);
		} catch {
			return [];
		}
	}
};
/** Thin subclass so the concrete type names the backend in stack traces. */
var ClineBackend = class extends BaseBackendAdapter {};
/**
* The Cline backend, ready to register.
*
* @param options - injected accounts, endpoint, and fetch seam.
* @returns the adapter, with accounts resolved from the registry or environment.
*/
function createClineBackend(options = {}) {
	return new ClineBackend(CLINE_DESCRIPTOR, new ClineImpl(resolveAccounts(options), resolveBaseUrl(options), options.fetchImpl ?? fetch));
}
//#endregion
export { createClineBackend as n, CLINE_DESCRIPTOR as t };
