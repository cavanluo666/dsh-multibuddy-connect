import { N as workbuddyPluginDataDir } from "./auth-DWGLoiHC.js";
import { n as BaseBackendAdapter } from "./base-B4d56Evj.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import "node:os";
//#region src/backends/registry.ts
/**
* The multi-account credential registry: one file per backend holding THAT
* backend's accounts, keyed by backend-local account id.
*
* Why a registry rather than "one credential file per backend". The merge
* brings backends whose account models disagree:
*
*  - Command Code configures an `accounts` dictionary and mints one bearer
*    key per entry;
*  - Trae and Qoder expose two regions that are separately signed in;
*  - the desktop-adoption backends (Qoder, Trae, MiMo, Loomy, CodeBuddy)
*    have exactly one slot, because the slot belongs to another program.
*
* Storing "the one credential" would force every backend into the narrowest
* of those models. Instead every backend keeps N accounts under its own
* `accounts` map, and `multiAccount: false` in the descriptor means N is
* pinned to 1 — a restriction the UI enforces, not one the storage imposes.
*
* Isolation is the whole point, so the layout makes it structural rather than
* conventional: accounts live in separate files per backend, and each
* account's secret material carries its own provenance. A bug that confuses
* two accounts cannot silently overwrite one with the other, because it would
* have to address the wrong file by name first.
*
* The WorkBuddy variants do NOT use this registry. They keep their own
* `.workbuddy-auth.json` / `.workbuddy-ai-auth.json` files and their
* `WorkBuddyCredentialStore`, because that store predates the merge and is
* the compatibility anchor. Unifying them would mean rewriting the one part
* of this plugin that is known to work; the registry is additive.
*
* @module dsh-workbuddy-connect/backends/registry
*/
/**
* On-disk format version.
*
* Bumped only for a layout change a reader must know about. An unknown version
* is refused rather than guessed at: misreading a credential file as a newer
* layout is how a user gets silently signed out.
*/
const REGISTRY_FORMAT_VERSION = 1;
/**
* Where one backend's accounts live.
*
* Same data-directory root as the WorkBuddy credentials, and for the same
* reason: a credential is secret material, not configuration, so it must stay
* outside the rebuildable `config/` tree and survive "wipe the caches".
*
* @param backendId - the backend whose file to name.
* @returns the absolute path of that backend's account file.
*/
function backendAccountsPath(backendId) {
	return join(workbuddyPluginDataDir(), `.backend-${sanitize(backendId)}-accounts.json`);
}
/**
* Reduce a backend id to something safe to put in a filename.
*
* Backend ids are authored constants and should already be filename-safe, but
* a descriptor is data — a third-party backend is data this plugin does not
* control — so the reduction must be defensive rather than cosmetic.
*
* Two classes of character are rejected, for different reasons:
*
*  - Anything outside `[A-Za-z0-9_-]` becomes `_`. This removes the path
*    separators outright, so a write can never land outside the data directory.
*  - A DOT becomes `_` too. Allowing dots would let the id `..` survive into
*    the filename, and `.backend-..-accounts.json` is exactly the shape that
*    confuses a human (and some tooling) into reading a traversal. Since no
*    real backend id needs a dot, dropping them removes the entire class
*    rather than trying to special-case the dangerous members.
*
* The result is additionally collapsed of runs and trimmed of edge
* underscores, so `../../evil` yields the readable stem `evil`.
*
* @param id - the raw backend id.
* @returns a filename-safe stem; never empty.
*/
function sanitize(id) {
	const reduced = id.replace(/[^A-Za-z0-9_-]/gu, "_").replace(/_+/gu, "_").replace(/^_+|_+$/gu, "");
	return reduced === "" ? "backend" : reduced;
}
/**
* The multi-account registry.
*
* Every method is explicit about which backend it addresses, so no call can
* accidentally read one backend's accounts under another's name.
*/
var BackendAccountRegistry = class {
	/**
	* Cache of parsed files, keyed by backend id; invalidated on write.
	*
	* Each entry records whether a file actually backed it. Caching the ABSENCE of
	* a file is useful — it keeps a never-configured backend from hitting the disk
	* on every render — but it means `cache.has()` cannot answer "is there a
	* file?", because a cached empty result looks identical to a cached real one.
	* The `existed` flag is what tells them apart, and it is the difference
	* between consulting an environment variable and not.
	*/
	cache = /* @__PURE__ */ new Map();
	/**
	* Read one backend's accounts.
	*
	* A missing file is an empty set, not an error: a backend whose desktop app
	* is installed but never signed in has simply never written one. A file that
	* exists but does not parse is ALSO an empty set — with the version check
	* applied first — because a corrupt credential file must degrade to
	* "signed out" (recoverable by signing in again) rather than throw during
	* plugin startup and take every other backend down with it.
	*
	* @param backendId - the backend to read.
	* @returns its stored accounts, in file order.
	*/
	async list(backendId) {
		const cached = this.cache.get(backendId);
		if (cached !== void 0) return cached.file.accounts;
		const { file, existed } = await this.read(backendId);
		this.cache.set(backendId, {
			file,
			existed
		});
		return file.accounts;
	}
	/**
	* Whether this backend has EVER been written to.
	*
	* Distinct from "has accounts": a user who configured accounts and then
	* deleted every one of them leaves a file with an empty list, and that is a
	* deliberate state which must not be mistaken for "never configured" — the
	* difference decides whether an environment variable is still consulted as a
	* fallback, and getting it backwards resurrects an account the user removed.
	*
	* @param backendId - the backend to test.
	* @returns true when a file exists for this backend.
	*/
	async hasStored(backendId) {
		const cached = this.cache.get(backendId);
		if (cached !== void 0) return cached.existed;
		try {
			await readFile(backendAccountsPath(backendId), "utf8");
			return true;
		} catch {
			return false;
		}
	}
	/** Read one account, or undefined when this backend has no such id. */
	async get(backendId, accountId) {
		return (await this.list(backendId)).find((account) => account.id === accountId);
	}
	/**
	* Insert or replace one account, preserving the order of the others.
	*
	* Order is meaning, not incidental: the account list renders top-to-bottom
	* and the FIRST account is the default a new session uses, so a replace must
	* not silently promote a different account to the front.
	*
	* @param backendId - the backend to write.
	* @param account - the account to store; its id is the merge key.
	*/
	async put(backendId, account) {
		const { file } = await this.read(backendId);
		const index = file.accounts.findIndex((existing) => existing.id === account.id);
		const next = {
			...account,
			updatedAtMs: Date.now()
		};
		if (index >= 0) file.accounts[index] = next;
		else file.accounts.push(next);
		await this.write(backendId, file);
	}
	/** Remove one account; a no-op when the id is unknown. */
	async remove(backendId, accountId) {
		const { file } = await this.read(backendId);
		const next = file.accounts.filter((account) => account.id !== accountId);
		if (next.length === file.accounts.length) return;
		file.accounts = next;
		await this.write(backendId, file);
	}
	/** Drop the in-memory cache for one backend, or all of them. */
	invalidate(backendId) {
		if (backendId === void 0) this.cache.clear();
		else this.cache.delete(backendId);
	}
	/**
	* Read and validate one backend's file, without consulting the cache.
	*
	* Reports whether a file actually backed the result, which the cache needs
	* and the file's CONTENTS cannot express: an absent file and a file holding
	* an empty list both parse to zero accounts, but only one of them means the
	* user has ever configured this backend.
	*
	* @param backendId - the backend to read.
	* @returns the parsed file plus whether one existed.
	*/
	async read(backendId) {
		const empty = {
			version: REGISTRY_FORMAT_VERSION,
			backendId,
			accounts: []
		};
		let text;
		try {
			text = await readFile(backendAccountsPath(backendId), "utf8");
		} catch {
			return {
				file: empty,
				existed: false
			};
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			return {
				file: empty,
				existed: true
			};
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {
			file: empty,
			existed: true
		};
		const document = parsed;
		if (document["version"] !== REGISTRY_FORMAT_VERSION) return {
			file: empty,
			existed: true
		};
		const raw = document["accounts"];
		if (!Array.isArray(raw)) return {
			file: empty,
			existed: true
		};
		const accounts = [];
		for (const entry of raw) {
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
			const record = entry;
			const id = typeof record["id"] === "string" ? record["id"] : void 0;
			const label = typeof record["label"] === "string" ? record["label"] : void 0;
			if (id === void 0 || id === "" || label === void 0) continue;
			accounts.push({
				id,
				label,
				...typeof record["detail"] === "string" ? { detail: record["detail"] } : {},
				secret: record["secret"],
				updatedAtMs: typeof record["updatedAtMs"] === "number" ? record["updatedAtMs"] : 0
			});
		}
		return {
			file: {
				version: REGISTRY_FORMAT_VERSION,
				backendId,
				accounts
			},
			existed: true
		};
	}
	/** Persist one backend's file and refresh the cache. */
	async write(backendId, file) {
		const path = backendAccountsPath(backendId);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(file, void 0, 2), "utf8");
		this.cache.set(backendId, {
			file,
			existed: true
		});
	}
};
/**
* Mask a secret for display: keep a short prefix and suffix so a user can
* confirm WHICH credential they are looking at, and nothing more.
*
* The point is identification, not partial disclosure: `sk-ab…9f2c` lets a
* human match this row against the key they pasted, while revealing too little
* to be worth stealing. A short secret is masked entirely rather than shown,
* since a 6-character value has no room for a safe window.
*
* @param secret - the raw secret.
* @returns a display-safe rendering.
*/
function maskSecret(secret) {
	if (secret.length <= 12) return "•".repeat(Math.max(4, secret.length));
	return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}
//#endregion
//#region src/backends/commandcode.ts
/** Provider route id used when nothing is configured; also the default account id. */
const COMMANDCODE_DEFAULT_ACCOUNT_ID = "commandcode";
/** Credential reference consulted when an account names none of its own. */
const COMMANDCODE_API_KEY_ENV = "COMMANDCODE_API_KEY";
/** Gateway root; the catalog endpoint hangs off it. */
const COMMANDCODE_BASE_URL = "https://api.commandcode.ai";
/** The descriptor this backend registers under. */
const COMMANDCODE_DESCRIPTOR = {
	id: "commandcode",
	displayName: "Command Code Go",
	description: "Command Code Go 套餐（多账号 API Key）",
	brand: {
		vendor: "Command Code",
		product: "Go"
	},
	authKind: "api-key",
	multiAccount: true,
	reportsQuota: false,
	reportsTokenUsage: false,
	settingsNs: "commandcode-go-provider"
};
/** Context capacity assumed when the listing discloses none. */
const FALLBACK_CONTEXT_WINDOW = 262144;
/** Per-request budget for the open listing endpoint. */
const FETCH_TIMEOUT_MS = 3e4;
/**
* Reduce the configured routes to the accounts to discover.
*
* The deduplication is not cosmetic: two routes sharing an id would collide in
* the account map, and the LATER one would silently shadow the earlier,
* leaving a user with a key that appears configured but never authenticates.
* First wins, matching the upstream dictionary's read order.
*
* @param options - the caller's construction options.
* @returns the routes to discover, in configuration order.
*/
function configuredAccounts(options) {
	const declared = options.accounts ?? [];
	if (declared.length === 0) return [{
		id: COMMANDCODE_DEFAULT_ACCOUNT_ID,
		label: COMMANDCODE_DESCRIPTOR.displayName,
		apiKeyEnv: COMMANDCODE_API_KEY_ENV
	}];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const account of declared) {
		const id = account.id !== void 0 && account.id !== "" ? account.id : COMMANDCODE_DEFAULT_ACCOUNT_ID;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push({
			id,
			label: account.label !== void 0 && account.label !== "" ? account.label : id,
			apiKeyEnv: account.apiKeyEnv !== void 0 && account.apiKeyEnv !== "" ? account.apiKeyEnv : COMMANDCODE_API_KEY_ENV,
			...account.secret === void 0 || account.secret === "" ? {} : { secret: account.secret }
		});
	}
	return out;
}
/** Read the opaque secret a registry row holds, tolerating either spelling. */
function secretOf(secret) {
	if (typeof secret !== "object" || secret === null || Array.isArray(secret)) return {};
	const record = secret;
	return {
		...typeof record["key"] === "string" && record["key"] !== "" ? { key: record["key"] } : {},
		...typeof record["apiKeyEnv"] === "string" && record["apiKeyEnv"] !== "" ? { apiKeyEnv: record["apiKeyEnv"] } : {}
	};
}
/**
* Model ids the Go plan includes that carry NO `-free` suffix.
*
* The listing endpoint is unauthenticated and discloses nothing about plans,
* so membership cannot be read off it. The `-free` suffix covers the free
* tier, but the Go plan also grants a handful of PAID-tier models — the
* upstream project names GPT-5.6 Luna, Grok 4.5, and Muse Spark 1.2
* Contributor — and filtering on the suffix alone silently removes every one
* of them. That is not a conservative default; it is the plugin offering less
* than the subscription the user paid for, with no visible reason why.
*
* These ids are therefore listed EXPLICITLY rather than inferred. Matching is
* on the id's leading segment so a dated variant (`gpt-5.6-luna-2026-01-01`)
* still resolves to its family entry.
*
* The cost of this list is that a NEW paid Go model stays invisible until the
* list is extended. That is the acceptable direction of error: one model
* arrives late, rather than five existing ones never arriving at all — and
* unlike a live cross-source join, it cannot shrink the roster because a CDN
* served a stale document.
*/
const GO_PLAN_MODEL_FAMILIES = [
	"gpt-5.6-luna",
	"grok-4.5",
	"muse-spark-1.2-contributor"
];
/**
* Whether a model id belongs to the Go plan.
*
* True for the free tier (the `-free` suffix) and for the paid families the
* plan explicitly grants (see {@link GO_PLAN_MODEL_FAMILIES}).
*
* @param id - the wire model id.
* @returns true when the Go plan is expected to serve this model.
*/
function isGoModelId(id) {
	const lower = id.toLowerCase();
	if (lower.endsWith("-free")) return true;
	return GO_PLAN_MODEL_FAMILIES.some((family) => lower === family || lower.startsWith(`${family}-`));
}
/**
* Read the free-tier ids out of the listing payload.
*
* Validates rather than casts, so a vendor changing the envelope shape
* produces an empty roster instead of a crash: the shell renders "registered,
* nothing to offer" for the former and a backend failure for the latter.
*
* @param payload - the decoded JSON body.
* @returns the models, sorted by id so the cached document is diff-stable.
*/
function parseCommandCodeModels(payload) {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
	const data = payload["data"];
	if (!Array.isArray(data)) return [];
	const models = [];
	for (const raw of data) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
		const record = raw;
		const id = typeof record["id"] === "string" ? record["id"] : "";
		if (id === "" || !isGoModelId(id)) continue;
		const name = typeof record["name"] === "string" && record["name"] !== "" ? record["name"] : id;
		const disclosed = record["context_length"] ?? record["context_window"];
		models.push({
			id,
			name: /free/i.test(name) ? name : `${name} (free)`,
			contextWindow: typeof disclosed === "number" && Number.isFinite(disclosed) && disclosed > 0 ? disclosed : FALLBACK_CONTEXT_WINDOW
		});
	}
	models.sort((left, right) => left.id.localeCompare(right.id));
	return models;
}
/** Command Code Go's product-specific half. */
var CommandCodeImpl = class {
	options;
	registry;
	/** The one catalog scan, shared by every account. */
	scanned;
	/** In-flight scan, so N accounts resolving at once issue one request. */
	scanning;
	constructor(options, registry) {
		this.options = options;
		this.registry = registry;
	}
	/**
	* Resolve every configured route.
	*
	* A route with no key AND no key in the environment resolves as
	* `usable: false`, carrying the reference to set. It is still returned
	* rather than dropped: the route is configured, the user needs to see WHICH
	* reference is missing, and a silently absent row is the one failure a user
	* cannot diagnose. When every route is in that state the list stays
	* "configured but unusable", and registering a route that rejects every
	* request is exactly what the shell must be able to warn about.
	*/
	async discover() {
		const stored = await this.registry.list(COMMANDCODE_DESCRIPTOR.id);
		const out = [];
		for (const account of configuredAccounts(this.options)) {
			const persisted = secretOf(stored.find((entry) => entry.id === account.id)?.secret);
			const key = account.secret ?? persisted.key;
			const ref = account.apiKeyEnv ?? persisted.apiKeyEnv ?? "COMMANDCODE_API_KEY";
			if (key !== void 0) {
				out.push({
					id: account.id,
					label: account.label,
					detail: maskSecret(key),
					usable: true
				});
				continue;
			}
			const ambient = process.env[ref];
			if (ambient === void 0 || ambient === "") {
				out.push({
					id: account.id,
					label: account.label,
					detail: `未设置 ${ref}`,
					usable: false,
					reason: `未找到 API Key；请设置环境变量 ${ref}，或在设置中填入该账号的 Key。`
				});
				continue;
			}
			out.push({
				id: account.id,
				label: account.label,
				detail: `${ref}：${maskSecret(ambient)}`,
				usable: true
			});
		}
		return out;
	}
	/**
	* The Go plan's models, identical for every account.
	*
	* The catalog is memoized per adapter and the fetch is shared, so resolving
	* five accounts costs one request rather than five. A failed scan yields an
	* empty roster rather than a throw: the picker shows nothing and the next
	* resolve retries.
	*/
	async models() {
		return (await this.scan()).map((model) => ({
			id: model.id,
			name: model.name,
			contextWindow: model.contextWindow
		}));
	}
	/** The memoized catalog, scanning once and de-duplicating concurrent callers. */
	async scan() {
		if (this.scanned !== void 0) return this.scanned;
		this.scanning ??= this.fetchCatalog().then((models) => {
			this.scanned = models;
			this.scanning = void 0;
			return models;
		}, () => {
			this.scanning = void 0;
			return [];
		});
		return this.scanning;
	}
	/** One request to the open listing endpoint. */
	async fetchCatalog() {
		const base = process.env["COMMANDCODE_BASE_URL"] ?? "https://api.commandcode.ai";
		const response = await fetch(`${base}/provider/v1/models`, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
		if (!response.ok) throw new Error(`Command Code 模型列表返回 HTTP ${response.status}`);
		return parseCommandCodeModels(await response.json());
	}
};
/** Thin subclass so the concrete type names the backend in stack traces. */
var CommandCodeBackend = class extends BaseBackendAdapter {};
/**
* The Command Code Go backend, ready to register.
*
* @param options - configured routes and the store to read them through.
* @returns the adapter the shell registers.
*/
function createCommandCodeBackend(options = {}) {
	const registry = options.registry ?? new BackendAccountRegistry();
	return new CommandCodeBackend(COMMANDCODE_DESCRIPTOR, new CommandCodeImpl(options, registry));
}
//#endregion
export { createCommandCodeBackend as a, BackendAccountRegistry as c, COMMANDCODE_DESCRIPTOR as i, backendAccountsPath as l, COMMANDCODE_BASE_URL as n, isGoModelId as o, COMMANDCODE_DEFAULT_ACCOUNT_ID as r, parseCommandCodeModels as s, COMMANDCODE_API_KEY_ENV as t, maskSecret as u };
