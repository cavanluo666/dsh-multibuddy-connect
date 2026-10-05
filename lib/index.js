import { A as validAppVersion, C as resolveChatIdentity, D as installedAppVersion, E as appUserAgent, M as WORKBUDDY_DATA_DIR_NAME, N as workbuddyPluginDataDir, O as readBundleVersion, P as workbuddyStateDir, S as readCliVersion, T as WORKBUDDY_APP_VERSION_FILENAME, _ as randomSentinel, a as workbuddyOwnAuthPath, b as chatUserAgent, c as modelWithCurrentPromotion, d as prepareChatBody, f as prepareInternationalChatBody, g as probeModel, h as PROBE_EFFORT_CANDIDATES, i as parseWorkBuddyAuth, j as WORKBUDDY_DATA_DIR_ENV, k as resolveAppVersion, l as normalizeCredits, m as regionOf, n as WORKBUDDY_CREDENTIAL_SOURCE, o as WorkBuddyUpstreamClient, p as realmOf, r as WorkBuddyCredentialStore, s as classifyUpstreamError, t as WORKBUDDY_AUTH_FILENAME, u as parseModelCatalog, v as CN_APP_VERSION_FILENAME, w as validCliVersion, x as fallbackChatIdentity, y as FALLBACK_CN_APP_VERSION } from "./auth-DWGLoiHC.js";
import { C as resolveLoginRegion, S as normalizeLoginRegion, _ as WORKBUDDY_LOGIN_PATH, a as WORKBUDDY_HOST_HEARTBEAT_FILENAME, b as LOGIN_PENDING_CODE, c as processStartTimeMs, d as writeHostHeartbeat, f as WORKBUDDY_CONNECT_VERSION, g as WORKBUDDY_AI_LOGIN_PATH, h as WorkBuddyCatalog, i as variantFor, l as readHostHeartbeat, m as FALLBACK_WORKBUDDY_MODELS, n as CN_VARIANT, o as clearHostHeartbeat, p as FALLBACK_WORKBUDDY_AI_MODELS, r as WORKBUDDY_VARIANTS, s as isHeartbeatProcessAlive, t as AI_VARIANT, u as workbuddyHostHeartbeatPath, x as WorkBuddyLoginClient } from "./variants-Csv2pCM9.js";
import { a as createCommandCodeBackend, c as BackendAccountRegistry, i as COMMANDCODE_DESCRIPTOR, l as backendAccountsPath, u as maskSecret } from "./commandcode-2Von9uxI.js";
import { n as BaseBackendAdapter, r as messageOf, t as BackendUnavailable } from "./base-DPIOH9ta.js";
import { n as createClineBackend, t as CLINE_DESCRIPTOR } from "./cline-CIpppzgy.js";
import { n as createLoomyBackend, t as LOOMY_DESCRIPTOR } from "./loomy-CJQm4QIs.js";
import { n as createMiMoBackend, t as MIMO_DESCRIPTOR } from "./mimo-DtQVKouI.js";
import z from "@deepseek-ai/schemastery";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
import { Readable } from "node:stream";
//#region src/pool.ts
/**
* The account pool: several WorkBuddy sign-ins of ONE product, with automatic
* failover when one of them is throttled or out of credit.
*
* WHY A POOL RATHER THAN A BIGGER STORE. \`WorkBuddyCredentialStore\` holds
* exactly one credential and is the compatibility anchor of this plugin; every
* card, route and catalog path already goes through it. Rather than teach it to
* hold N credentials — which would touch all of those — the pool OWNS N stores,
* one per account, and each keeps the single-account semantics it already has
* (its own file, its own single-flight refresh, its own realm check). The pool
* adds only the two things that are genuinely new: WHICH account serves a
* request, and WHEN an account has to sit out.
*
* WHY FAILOVER IS NOT NAIVE RETRY. Only some upstream failures mean \"try
* another account\":
*
*  - \`soft_rate\` and \`hard_credit\` are per-ACCOUNT conditions, so another
*    account can genuinely succeed;
*  - \`session_dead\` needs a fresh sign-in, so the account is parked until the
*    user does that;
*  - \`server\`, \`client\` and \`activation_required\` are NOT account conditions.
*    Retrying them on every account multiplies one failure by the pool size and
*    makes the user wait through N identical errors — the failure has to be
*    returned as-is on the first occurrence.
*
* The classification already exists (\`classifyUpstreamError\`); this module only
* decides what each class MEANS for pool membership.
*
* @module dsh-multibuddy-connect/pool
*/
/** On-disk pool format; readers refuse anything else rather than guess. */
const POOL_FORMAT_VERSION = 1;
/**
* How long one account sits out after a failure class.
*
* A rate limit is usually seconds-to-minutes, so the base is deliberately
* short: parking a healthy account for an hour because it hit one 429 turns a
* brief throttle into an outage. Repeat offenders back off (see
* {@link cooldownMsFor}), which is what stops a genuinely bad account from
* being retried every minute forever.
*/
const SOFT_RATE_BASE_MS = 6e4;
/** Ceiling for the exponential backoff, so a parked account is still retried. */
const SOFT_RATE_MAX_MS = 18e5;
/**
* How long an exhausted account sits out when the upstream states no reset.
*
* A credit refusal means \"not until the next billing cycle\", and inventing a
* precise reset time would be worse than admitting the granularity: the account
* is parked for a day and the next request after that probes it again.
*/
const HARD_CREDIT_FALLBACK_MS = 864e5;
/**
* Where one account's credential lives.
*
* Derived from the pool's base file name so the FIRST account keeps the
* historical path exactly: an existing single-account install must keep reading
* the file it already wrote, or the upgrade would look like a sign-out.
*
* @param baseFilename - the variant's own credential filename.
* @param slot - 0 for the original file, 1+ for added accounts.
* @returns the absolute path for that slot.
*/
function poolAccountPath(baseFilename, slot) {
	const dir = workbuddyPluginDataDir();
	if (slot === 0) return join(dir, baseFilename);
	const dot = baseFilename.lastIndexOf(".");
	const stem = dot === -1 ? baseFilename : baseFilename.slice(0, dot);
	const ext = dot === -1 ? "" : baseFilename.slice(dot);
	return join(dir, stem + "-a" + String(slot + 1) + ext);
}
/** The pool's own bookkeeping file, beside the credentials it tracks. */
function poolStatePath(baseFilename) {
	const dot = baseFilename.lastIndexOf(".");
	const stem = dot === -1 ? baseFilename : baseFilename.slice(0, dot);
	return join(workbuddyPluginDataDir(), stem + "-pool.json");
}
/**
* Whether a failure class means \"try another account\".
*
* The three that do are per-account conditions. Everything else is a property
* of the REQUEST or the SERVICE, so walking the pool would repeat one failure N
* times and delay the error the user needs to see.
*
* @param kind - the classified upstream failure.
* @returns true when another account may succeed.
*/
function isAccountScoped(kind) {
	return kind === "soft_rate" || kind === "hard_credit" || kind === "session_dead";
}
/**
* The cooldown for one failure, given how many times this account has already
* been rate-limited in a row.
*
* Exponential with a ceiling: the first throttle costs a minute, and an account
* that keeps being throttled is parked progressively longer instead of being
* retried every minute forever.
*
* @param kind - the failure class.
* @param rateLimitHits - consecutive rate-limit hits, including this one.
* @returns how long to park the account, in milliseconds.
*/
function cooldownMsFor(kind, rateLimitHits) {
	if (kind === "soft_rate") {
		const step = Math.max(0, rateLimitHits - 1);
		return Math.min(SOFT_RATE_MAX_MS, SOFT_RATE_BASE_MS * Math.pow(2, step));
	}
	if (kind === "hard_credit") return HARD_CREDIT_FALLBACK_MS;
	return Number.POSITIVE_INFINITY;
}
/**
* The pool's live state for one product variant.
*
* Credential STORAGE is not this class's business — the caller supplies the
* stores, one per account, because only the shell knows how to build them (they
* need the variant and the refresh function). The pool owns selection, cooldown
* accounting, and persistence of the bookkeeping beside those credentials.
*/
var WorkBuddyAccountPool = class {
	baseFilename;
	records = [];
	activeId;
	loaded = false;
	dirty = false;
	constructor(baseFilename) {
		this.baseFilename = baseFilename;
	}
	/** Read the pool file once; a missing or unreadable file starts empty. */
	async load() {
		if (this.loaded) return;
		this.loaded = true;
		let text;
		try {
			text = await readFile(poolStatePath(this.baseFilename), "utf8");
		} catch {
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			return;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
		const document = parsed;
		if (document["version"] !== POOL_FORMAT_VERSION) return;
		const raw = document["accounts"];
		if (!Array.isArray(raw)) return;
		for (const entry of raw) {
			const record = parseRecord(entry);
			if (record !== void 0) this.records.push(record);
		}
		const active = document["activeId"];
		if (typeof active === "string" && active !== "") this.activeId = active;
	}
	/** Every tracked account, in stable order. */
	all() {
		return this.records;
	}
	/** The account the pool prefers, when it is usable. */
	active() {
		return this.records.find((record) => record.id === this.activeId);
	}
	/**
	* Record one account, merging with what is already known.
	*
	* Cooldown state is CARRIED OVER rather than reset: a discovery pass runs on
	* every catalog refresh, and letting it clear a cooldown would put a
	* throttled account straight back into rotation.
	*
	* @param record - the account's identity and location.
	*/
	upsert(record) {
		const existing = this.records.find((candidate) => candidate.id === record.id);
		if (existing === void 0) this.records.push({
			cooldownUntilMs: 0,
			rateLimitHits: 0,
			...record
		});
		else {
			existing.label = record.label;
			existing.path = record.path;
		}
		this.activeId ??= record.id;
		this.dirty = true;
	}
	/** Drop one account; a no-op when the id is unknown. */
	remove(id) {
		const before = this.records.length;
		this.records = this.records.filter((record) => record.id !== id);
		if (this.records.length === before) return;
		if (this.activeId === id) this.activeId = this.records[0]?.id;
		this.dirty = true;
	}
	/** Mark which account the pool should prefer. */
	setActive(id) {
		if (!this.records.some((record) => record.id === id)) return;
		this.activeId = id;
		this.dirty = true;
	}
	/**
	* Accounts that may serve a request right now, best first.
	*
	* The active account leads so a healthy preference is honoured, and the rest
	* follow in insertion order — which is the order the user signed them in, and
	* therefore the order they would expect.
	*
	* @param now - current time; injected so tests need no clock.
	* @returns the usable accounts, in the order they should be tried.
	*/
	available(now) {
		const usable = this.records.filter((record) => record.needsSignIn !== true && record.cooldownUntilMs <= now);
		const preferred = usable.filter((record) => record.id === this.activeId);
		const rest = usable.filter((record) => record.id !== this.activeId);
		return [...preferred, ...rest];
	}
	/**
	* Apply one request outcome to an account.
	*
	* Success CLEARS the rate-limit streak: the counter exists to lengthen the
	* backoff of an account that keeps failing, so an account that just worked
	* must start from the short cooldown again.
	*
	* @param id - the account that served the attempt.
	* @param outcome - the classified result, or \`ok\` for a success.
	* @param now - current time.
	* @returns the account's state after the update.
	*/
	report(id, outcome, now) {
		const record = this.records.find((candidate) => candidate.id === id);
		if (record === void 0) return void 0;
		if (outcome === "ok") {
			record.cooldownUntilMs = 0;
			delete record.cooldownReason;
			record.rateLimitHits = 0;
			delete record.needsSignIn;
			record.lastSuccessAtMs = now;
			this.dirty = true;
			return record;
		}
		if (!isAccountScoped(outcome)) return record;
		if (outcome === "session_dead") {
			record.needsSignIn = true;
			delete record.cooldownReason;
			record.cooldownUntilMs = 0;
			this.dirty = true;
			return record;
		}
		record.rateLimitHits = outcome === "soft_rate" ? record.rateLimitHits + 1 : record.rateLimitHits;
		const cooldown = cooldownMsFor(outcome, record.rateLimitHits);
		record.cooldownReason = outcome;
		record.cooldownUntilMs = Number.isFinite(cooldown) ? now + cooldown : Number.MAX_SAFE_INTEGER;
		this.dirty = true;
		return record;
	}
	/** Persist the bookkeeping, when anything changed. */
	async flush() {
		if (!this.dirty) return;
		const document = {
			version: POOL_FORMAT_VERSION,
			accounts: this.records,
			...this.activeId === void 0 ? {} : { activeId: this.activeId }
		};
		const path = poolStatePath(this.baseFilename);
		try {
			await mkdir(dirname(path), {
				recursive: true,
				mode: 448
			});
			await writeFileAtomic(path, JSON.stringify(document, void 0, 2) + "\n", {
				mode: 384,
				dirMode: 448
			});
			this.dirty = false;
		} catch {}
	}
};
/** Validate one persisted record; undefined when unusable. */
function parseRecord(entry) {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return void 0;
	const record = entry;
	const id = typeof record["id"] === "string" ? record["id"] : void 0;
	const path = typeof record["path"] === "string" ? record["path"] : void 0;
	if (id === void 0 || id === "" || path === void 0 || path === "") return void 0;
	const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
	return {
		id,
		label: typeof record["label"] === "string" && record["label"] !== "" ? record["label"] : id,
		path,
		cooldownUntilMs: number(record["cooldownUntilMs"]),
		...typeof record["cooldownReason"] === "string" ? { cooldownReason: record["cooldownReason"] } : {},
		rateLimitHits: number(record["rateLimitHits"]),
		...record["needsSignIn"] === true ? { needsSignIn: true } : {},
		...typeof record["lastSuccessAtMs"] === "number" ? { lastSuccessAtMs: record["lastSuccessAtMs"] } : {}
	};
}
//#endregion
//#region src/account-manager.ts
/**
* Several sign-ins of ONE WorkBuddy product, exposed to the rest of the plugin
* as if there were only one.
*
* THE COMPATIBILITY TRICK, and why it matters. Twelve call sites already do
* \`runtime.store.current()\`, \`runtime.store.reresolve()\` and so on, and every
* one of them means \"the account in effect\". Teaching all of them about a pool
* would be a wide, risky change to the plugin's most load-bearing path. Instead
* this manager OWNS N credential stores and hands the shell a \`store\` that
* IS the active account's store, so those call sites keep working unchanged and
* keep meaning exactly what they meant.
*
* The pool itself (cooldowns, selection order, failover) lives in \`pool.ts\`.
* This module is the bridge: it maps pool records onto real stores, and it owns
* the two operations a pool cannot perform on its own — ADDING an account (by
* writing a new credential file) and REMOVING one.
*
* FIRST SLOT KEEPS THE HISTORICAL PATH. Account 0 lives at the variant's own
* credential file, so an existing single-account install is already account 0
* and an upgrade is not a sign-out.
*
* @module dsh-multibuddy-connect/account-manager
*/
/**
* The account set for one variant.
*
* Not a \`WorkBuddyCredentialStore\` subclass: the shell needs BOTH faces — the
* pool (for failover and the card) and a store-shaped object (for the twelve
* existing call sites) — and composition is how both can exist without either
* pretending to be the other.
*/
var WorkBuddyAccountManager = class {
	options;
	pool;
	accounts = /* @__PURE__ */ new Map();
	loaded = false;
	constructor(options) {
		this.options = options;
		this.pool = new WorkBuddyAccountPool(options.variant.ownFilename);
	}
	/** The pool, for failover and the configuration card. */
	accountPool() {
		return this.pool;
	}
	/** Build a store for one slot, pointed at that slot's credential file. */
	storeFor(slot) {
		return new WorkBuddyCredentialStore({
			variant: this.options.variant,
			ownPath: poolAccountPath(this.options.variant.ownFilename, slot),
			refresh: this.options.refresh
		});
	}
	/**
	* Discover the accounts already on disk and register them with the pool.
	*
	* Slots are probed in order until one is missing. Contiguous numbering is
	* what makes removal safe: slot N+1 is only ever read after slot N, so a gap
	* left by a deletion means the later slots are renumbered on the next
	* add rather than read at a stale position.
	*
	* @returns the accounts now known, in slot order.
	*/
	async load() {
		if (this.loaded) return this.all();
		this.loaded = true;
		await this.pool.load();
		for (let slot = 0; slot < 64; slot += 1) {
			const store = this.storeFor(slot);
			let credential;
			try {
				credential = await store.current();
			} catch {
				credential = void 0;
			}
			if (credential === void 0) {
				if (slot > 0 && !this.accounts.has(String(slot - 1))) break;
				continue;
			}
			const id = identityOf(credential);
			const account = {
				record: freshRecord(id, labelOf(credential, this.options.variant), store.ownAuthPath()),
				store
			};
			this.accounts.set(id, account);
			this.pool.upsert(account.record);
		}
		return this.all();
	}
	/** Every known account, in slot order. */
	all() {
		return [...this.accounts.values()];
	}
	/** Look one up by pool id. */
	get(id) {
		return this.accounts.get(id);
	}
	/**
	* The store the rest of the plugin should treat as \"the account\".
	*
	* Falls back to slot 0's store when no account has been discovered yet, so a
	* fresh install still has something to sign in to.
	*/
	activeStore() {
		const active = this.pool.active();
		if (active !== void 0) {
			const account = this.accounts.get(active.id);
			if (account !== void 0) return account.store;
		}
		return this.accounts.values().next().value?.store ?? this.storeFor(0);
	}
	/**
	* Add a fresh sign-in, or refresh an existing one.
	*
	* Keyed by IDENTITY, not by slot: signing the same account in again must
	* update it in place rather than create a duplicate that shares its quota.
	*
	* @param credential - the credential the sign-in produced.
	* @returns the account it belongs to.
	*/
	async add(credential) {
		await this.load();
		const id = identityOf(credential);
		const existing = this.accounts.get(id);
		if (existing !== void 0) {
			const reloaded = this.storeForSlotOf(existing);
			await reloaded.save(credential);
			const replaced = {
				record: {
					...existing.record,
					label: labelOf(credential, this.options.variant)
				},
				store: reloaded
			};
			this.accounts.set(id, replaced);
			this.pool.upsert(replaced.record);
			await this.pool.flush();
			return replaced;
		}
		const slot = this.nextSlot();
		const store = this.storeFor(slot);
		await store.save(credential);
		const account = {
			record: freshRecord(id, labelOf(credential, this.options.variant), store.ownAuthPath()),
			store
		};
		this.accounts.set(id, account);
		this.pool.upsert(account.record);
		await this.pool.flush();
		return account;
	}
	/**
	* Forget one account and delete its credential file.
	*
	* @param id - the pool id to remove.
	*/
	async remove(id) {
		const account = this.accounts.get(id);
		if (account === void 0) return;
		try {
			await account.store.logout();
		} catch {}
		this.accounts.delete(id);
		this.pool.remove(id);
		await this.pool.flush();
	}
	/** Persist pool bookkeeping; safe to call on every request outcome. */
	async flush() {
		await this.pool.flush();
	}
	/** Which slot an existing account occupies, by comparing file paths. */
	storeForSlotOf(account) {
		const path = account.store.ownAuthPath();
		for (let slot = 0; slot < 64; slot += 1) {
			const candidate = this.storeFor(slot);
			if (candidate.ownAuthPath() === path) return candidate;
		}
		return this.storeFor(0);
	}
	/** The next free slot: one past the highest occupied. */
	nextSlot() {
		let highest = -1;
		for (const account of this.accounts.values()) for (let slot = 0; slot < 64; slot += 1) if (this.storeFor(slot).ownAuthPath() === account.store.ownAuthPath()) {
			if (slot > highest) highest = slot;
			break;
		}
		return highest + 1;
	}
};
/**
* The stable identity of one account, matching the shell's own identity key.
*
* uid plus enterpriseId, because one person can belong to several enterprises
* and each is a separately billed account.
*
* @param credential - the credential.
* @returns the identity string.
*/
function identityOf(credential) {
	return credential.uid + ":" + (credential.enterpriseId ?? "");
}
/**
* A brand-new pool record for an account just discovered or added.
*
* Cooldown state starts clean because this describes an account the pool has not
* yet seen; an account it HAS seen keeps its state through
* {@link WorkBuddyAccountPool.upsert}, which merges rather than replaces.
*
* @param id - the account identity.
* @param label - the display label.
* @param path - that account's credential file.
* @returns a record with no cooldown applied.
*/
function freshRecord(id, label, path) {
	return {
		id,
		label,
		path,
		cooldownUntilMs: 0,
		rateLimitHits: 0
	};
}
/** A display label: the nickname when the upstream gave one. */
function labelOf(credential, variant) {
	const nickname = credential.nickname;
	if (nickname !== void 0 && nickname !== "") return nickname;
	return variant.displayName;
}
//#endregion
//#region src/loopback.ts
/**
* Shared loopback gates for the plugin's local HTTP surfaces: the loopback
* shim and the same-origin web-status route. Both are only ever meant to be
* addressed through the machine's loopback interface.
*
* @module dsh-workbuddy-connect/loopback
*/
/** Loopback hostnames a local plugin surface may be addressed by. */
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && !hostname.slice(0, colon).includes(":") && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The request's Host header must name the loopback interface. A DNS-rebinding
* page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
* Host, so this check drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin (present header) must be loopback. Non-browser
* clients (the plugin's own fetch calls) send no Origin at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
//#endregion
//#region src/login-route.ts
/**
* Sign-in route: starts, polls, and ends one variant's login.
*
* The state-changing endpoints the plugin exposes share one guard shape — a
* loopback Host and Origin, plus the in-process key the card receives with its
* status document — because loopback alone is *not* authentication: any local
* process can address `127.0.0.1`, and this route both holds a pending OAuth
* attempt and writes a credential to disk.
*
* The realm is never taken from the request. It is fixed by the route the
* browser called (one route per variant), so a card for one product can never
* be steered into signing in against the other's upstream.
*
* @module dsh-workbuddy-connect/login-route
*/
/** Largest control body accepted; an imported credential document is larger. */
const MAX_BODY_BYTES$3 = 65536;
function json$4(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Read the request body with a hard ceiling. */
async function readBody$4(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES$3) return void 0;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Parse and shape-check a login request; unknown fields are ignored, not trusted. */
function parseRequest(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	const action = wrapped["action"];
	if (action === "begin" || action === "logout") return { action };
	if (action === "poll") {
		const state = wrapped["state"];
		if (typeof state !== "string" || state.trim() === "") return void 0;
		return {
			action: "poll",
			state: state.trim()
		};
	}
	if (action === "import") {
		const document = wrapped["document"];
		if (typeof document !== "string" || document.trim() === "") return void 0;
		return {
			action: "import",
			document
		};
	}
}
/**
* Strip token-like content from a message before it reaches the browser.
*
* The route reports failures to a same-origin card, and an upstream error body
* is the one input here that is not the plugin's own prose. Belt-and-braces:
* everything this route produces is already a summary, and this keeps a future
* one from carrying a credential across.
*/
function safeMessage$1(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
/**
* The sign-in route's handler, extracted so tests can mount it on a bare server
* with a known key.
*
* @param deps - the login operations for one variant.
* @param key - the in-process control key this route requires.
* @returns the Node request handler.
*/
function workBuddyLoginHandler(deps, key) {
	return async (req, res) => {
		if (req.method !== "POST") {
			json$4(res, 405, { error: "method not allowed" });
			return;
		}
		if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
			json$4(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (!keyMatches$3(key, req.headers["x-workbuddy-login-key"])) {
			json$4(res, 403, { error: "invalid-login-key" });
			return;
		}
		const body = await readBody$4(req);
		if (body === void 0) {
			json$4(res, 413, { error: "body too large" });
			return;
		}
		const request = parseRequest(body);
		if (request === void 0) {
			json$4(res, 400, { error: "invalid action" });
			return;
		}
		try {
			if (request.action === "begin") {
				const attempt = await deps.begin();
				json$4(res, 200, {
					status: "pending",
					state: attempt.state,
					url: attempt.url
				});
				return;
			}
			if (request.action === "logout") {
				await deps.logout();
				json$4(res, 200, { status: "signed-out" });
				return;
			}
			if (request.action === "import") {
				const adopted = await deps.importDocument(request.document);
				json$4(res, 200, {
					status: "imported",
					...adopted.uid === void 0 ? {} : { uid: adopted.uid },
					...adopted.nickname === void 0 ? {} : { nickname: adopted.nickname }
				});
				return;
			}
			json$4(res, 200, await deps.poll(request.state));
		} catch (error) {
			json$4(res, 200, {
				status: "failed",
				message: safeMessage$1(error)
			});
		}
	};
}
/** Mint the per-process sign-in control key. */
function createLoginKey() {
	return randomBytes(24).toString("hex");
}
/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches$3(expected, presented) {
	if (presented === void 0 || presented.length !== expected.length) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && timingSafeEqual(a, b);
}
/** Mount the POST sign-in route on an optional webServer context. */
function registerWorkBuddyLoginRoute(ctx, deps, key) {
	const path = deps.path ?? "/plugins/dsh-workbuddy-connect/login";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path,
			handler: workBuddyLoginHandler(deps, key)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy-connect: login route");
}
//#endregion
//#region src/catalog-store.ts
/**
* The last catalog that actually loaded, kept per variant and per account.
*
* Both the plan (§4 "降级顺序为同版同来源的最近成功目录 → 本版内置保守目录")
* and the README promise this fallback, and without it a restart always drops
* the user to the built-in roster even when a good catalog was fetched minutes
* earlier. The built-in roster is a snapshot taken once; a fetched catalog is
* what the upstream actually serves to this account.
*
* What it deliberately is *not*:
*
* - not a cache with a freshness policy — it never prevents a fetch, it only
*   answers when a fetch cannot;
* - not shared across accounts (a different account can see a different roster
*   and different promotions), nor across variants (the CN and international
*   endpoints disagree about rates and windows for the same model id);
* - not a place for secrets: model metadata only, never a token. The account
*   key is a `uid:enterpriseId` identity already visible in the status document.
*
* @module dsh-workbuddy-connect/catalog-store
*/
/** On-disk format this reader accepts; other versions are discarded. */
const CATALOG_FORMAT_VERSION = 1;
/** Basename of the CN variant's saved catalog inside the plugin's config dir. */
const WORKBUDDY_CATALOG_FILENAME = ".workbuddy-catalog.json";
/** Plugin-owned saved-catalog path inside the plugin's config directory. */
function workbuddyCatalogPath(filename = WORKBUDDY_CATALOG_FILENAME) {
	return join(workbuddyStateDir(), filename);
}
/** Whether a parsed value is a model row worth keeping. */
function isModel(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const row = value;
	return typeof row["id"] === "string" && row["id"] !== "" && typeof row["name"] === "string" && typeof row["contextWindow"] === "number" && Number.isFinite(row["contextWindow"]) && typeof row["maxTokens"] === "number" && Number.isFinite(row["maxTokens"]) && typeof row["supportsImages"] === "boolean";
}
/** Whether a parsed value is a saved catalog this reader can trust. */
function isSaved(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entry = value;
	if (typeof entry["account"] !== "string" || entry["account"] === "") return false;
	if (typeof entry["source"] !== "string" || entry["source"] === "") return false;
	if (typeof entry["fetchedAtMs"] !== "number" || !Number.isFinite(entry["fetchedAtMs"])) return false;
	const models = entry["models"];
	if (!Array.isArray(models) || models.length === 0) return false;
	return models.every(isModel);
}
/**
* The last successful catalog per account, read once and written atomically.
*
* Malformed content reads as "nothing saved" rather than throwing: this file
* is an optimization for the offline and first-seconds cases, and a corrupt one
* must never be able to stop the plugin from serving models.
*/
var WorkBuddyCatalogStore = class {
	path;
	entries;
	constructor(options = {}) {
		this.path = typeof options === "string" ? options : options.path ?? workbuddyCatalogPath();
	}
	/** Resolved state-file path, for the CLI and tests. */
	filePath() {
		return this.path;
	}
	load() {
		if (this.entries !== void 0) return this.entries;
		const entries = {};
		if (existsSync(this.path)) try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8"));
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const document = parsed;
				const raw = document["version"] === CATALOG_FORMAT_VERSION ? document["entries"] : void 0;
				if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
					for (const [key, value] of Object.entries(raw)) if (isSaved(value)) entries[key] = value;
				}
			}
		} catch {}
		this.entries = entries;
		return entries;
	}
	/** The saved catalog for one account, or `undefined` when there is none. */
	get(account) {
		const entry = this.load()[account];
		return entry === void 0 ? void 0 : entry;
	}
	/**
	* Remember a catalog for an account, replacing whatever was saved before.
	*
	* A failed write is swallowed: the plugin has already served these models,
	* and losing the *memory* of them is not worth surfacing.
	*/
	set(account, catalog) {
		const entries = this.load();
		entries[account] = {
			account,
			...catalog
		};
		this.persist();
	}
	/** Forget one account's catalog — used when that account signs out. */
	delete(account) {
		const entries = this.load();
		if (!(account in entries)) return;
		delete entries[account];
		this.persist();
	}
	persist() {
		const directory = dirname(this.path);
		try {
			if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
			const document = {
				version: CATALOG_FORMAT_VERSION,
				entries: this.load()
			};
			const temporary = resolve(`${this.path}.tmp`);
			writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 384 });
			renameSync(temporary, this.path);
		} catch {}
	}
};
//#endregion
//#region src/adapter.ts
/**
* The `workbuddy` pi-ai provider: one loopback-backed adapter registered
* into the Harness LLM seam, assembled from public `dsh-llm-pi-ai`
* extension points the way `dsh-codex-connect` assembles its Codex route.
*
* @module dsh-workbuddy-connect/adapter
*/
/** Provider route this bundle owns. */
const WORKBUDDY_PROVIDER = "workbuddy";
/** Provider idle ceiling while one stream read is outstanding. */
const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
* them required in 0.1.1-rc.2. They bound requests to models whose catalog
* entry declares `supportsImages`; text-only models never receive images.
*/
const REQUEST_IMAGE_BUDGETS$1 = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Inert pi-ai auth plane. The workbuddy route authenticates only through the
* shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
* credential lifecycle and ambient discovery must never manufacture a
* credential for it. `PiAiAdapterOptions.auth` is required since 0.1.1-rc.2;
* every ambient question here answers "nothing stored, nothing set".
*/
const INERT_AUTH$1 = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-workbuddy-connect: the workbuddy route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST$1 = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/**
* The suffix appended to a model's display name so its billing rate is visible
* wherever the name is shown.
*
* The separator is a middle dot rather than a hyphen or colon: model names
* already contain hyphens (`GLM-5.3-Flash`, `Deepseek-V4-Flash`), so a hyphen
* separator would be ambiguous about where the name ends and the rate begins.
*/
const RATE_SEPARATOR = " · ";
/**
* What the model seat shows in place of a missing rate.
*
* The seat has no locale service (the adapter is a host seam), and the plugin's
* own dictionaries live on the browser half, so this is a literal. It matches
* the settings card's own wording for the same state.
*/
const RATE_UNAVAILABLE = "价格暂不可用";
/**
* Append the billing rate to one model's display name.
*
* The rate AND the declared promo badges ride the *name* alone: since DSH
* 0.1.2 the composer's model seat (`ModelSelect`) renders `model.name` only —
* `description` is no longer read there at all (the 0.1.1-era client rendered
* it, which is why the badges used to be visible in the seat). The `/model`
* popup renders the name too, so a separate `description` copy would either
* duplicate (rate) or vanish (badges) depending on client generation.
*
* This is display-only and cannot affect routing: the wire request is built
* from `model.id` (pi-ai's completions API sets `model: model.id`), the
* selection a picker submits is `{provider, model: id, reasoningEffort}`, and
* `dsh-llm` validates `name` as a non-empty string without comparing its
* contents. Nothing in the host resolves a model *by* name.
*/
/**
* The catalog display suffix: the billing rate followed by the declared promo
* badges (`限时免费`, `夜间折扣`), or undefined when the row carries neither.
* The badge labels are the upstream's own spellings and the host seam has no
* locale service, so non-Chinese UIs see them verbatim — accepted until the
* picker grows a localized badge slot.
*
* A price the plugin cannot stand behind renders as WORDS, never as an empty
* slot: every other model in the seat shows `· x0.3`, so a bare name where the
* rate should be reads as a rendering bug (and invites "why is this one
* blank?"). `rateUnknown` means exactly that case — the upstream baked an ended
* promotion's discount into the row, so the original is not recoverable and the
* honest answer is to say so.
*/
function displaySuffix(info) {
	if (info.billing?.rateUnknown === true) return RATE_UNAVAILABLE;
	const parts = [normalizeCredits(info.billing?.credits), ...info.billing?.badges ?? []].filter((part) => part !== void 0 && part !== "");
	return parts.length === 0 ? void 0 : parts.join(" · ");
}
/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name, info) {
	const suffix = displaySuffix(info);
	return suffix === void 0 ? name : `${name}${RATE_SEPARATOR}${suffix}`;
}
/**
* Resolve a WorkBuddy model's reasoning capability into pi-ai's
* `thinkingLevelMap` (every level pinned to its wire spelling or `null` for
* unsupported), mirroring `dsh-llm-pi-ai`'s own `resolveModelReasoning`.
*
* Two sources, strictly ordered (`docs/reasoning-effort-probe-plan.md` §5):
*
* 1. **The declared set.** When the upstream declares a non-empty
*    `supportedEfforts`, exactly those values are offered and nothing else.
*    This always wins: an observation never widens or narrows a declared set.
* 2. **A local observation.** Rows without a declared set (the older
*    `{effort, summary}` shape) normally get no control at all — their
*    selectable set is client-side knowledge the catalog does not carry, and
*    the desktop app differs per model there. If the user authorized a probe
*    and it established that the upstream *validates* the parameter, the
*    verified spellings are offered.
*
* A `non-validating` observation deliberately yields no control: the upstream
* accepts values that cannot exist (measured on `glm-5.2`), so every per-level
* acceptance it produced would be a false positive.
*
* `off` is offered only when the upstream declares `canDisableThinking: true`.
* It is never probed — disabling thinking is a separate capability, and the
* per-model acceptance of `off` cannot be inferred from the row's shape.
*
* The offered set is described internally as "verified accepted", never as
* "verified effective": acceptance proves the upstream did not reject the
* spelling, not that it changes what the model does.
*/
function reasoningFields$1(info, observed) {
	const reasoning = info.reasoning;
	if (reasoning === void 0 || reasoning.supports !== true) return { reasoning: false };
	const declared = reasoning.supportedEfforts;
	const efforts = declared !== void 0 && declared.length > 0 ? declared : observed?.validation === "validating" && observed.efforts.length > 0 ? observed.efforts : void 0;
	if (efforts === void 0) return { reasoning: false };
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: reasoning.canDisableThinking === true && declared !== void 0 && declared.length > 0 ? "off" : null,
			minimal: null,
			low: efforts.includes("low") ? "low" : null,
			medium: efforts.includes("medium") ? "medium" : null,
			high: efforts.includes("high") ? "high" : null,
			xhigh: efforts.includes("xhigh") ? "xhigh" : null,
			max: efforts.includes("max") ? "max" : null
		}
	};
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel$1(info, baseUrl, observed, providerId = WORKBUDDY_PROVIDER) {
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: info.supportsImages === true ? ["text", "image"] : ["text"],
		...reasoningFields$1(info, observed),
		cost: NO_COST$1,
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens,
		compat: { maxTokensField: "max_tokens" }
	};
}
/**
* Assemble the adapter. The provider's `getModels` reads the live catalog,
* and every model's `baseUrl` is re-resolved per read so the shim's
* ephemeral port applies from the first snapshot after startup.
*
* The profile is constructed by hand rather than through dsh-llm-pi-ai's
* internal `resolveProfiles()`: that helper is not part of the package's
* public export surface (root entry, `lib/` deep imports blocked by the
* exports map, `src/` not shipped), so hand-assembly is the only supported
* path and every newly required field must be adopted here explicitly —
* `modelErrors` since 0.1.5-alpha.2 (#12).
*/
function createWorkBuddyAdapter(options) {
	const { shim, store, catalog, resolveAttachments, observe } = options;
	const providerId = options.providerId ?? "workbuddy";
	const displayName = options.displayName ?? "WorkBuddy";
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.current().map((info) => toPiModel$1(info, baseUrl, observe?.(info.id), providerId));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: displayName,
			auth: { apiKey: {
				name: "WorkBuddy OAuth bearer token",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "WorkBuddy"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName,
		streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-workbuddy-connect retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS$1,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		adapter: new WorkBuddyPiAiAdapter(catalog, {
			profiles: () => profiles,
			auth: INERT_AUTH$1,
			resolveApiKey: async () => shim.token(),
			...resolveAttachments === void 0 ? {} : { resolveAttachments }
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
/**
* The WorkBuddy route's adapter: `PiAiAdapter` with the billing rate folded
* into the catalog answers it returns to the DSH model pickers.
*
* `PiAiAdapter.listModels()` and `.resolveModel()` build their answers straight
* from the pi-ai descriptors, which carry no billing fact, so the rate is
* layered on here by looking the model up in the live catalog. Both overrides
* delegate to `super` and then rewrite only the display fields, so streaming,
* capability resolution, and effort mapping stay exactly as `dsh-llm-pi-ai`
* implements them.
*
* A model missing from the catalog (an id the shim would serve but the last
* upstream refresh did not list) falls through with its name untouched rather
* than being dropped: catalog membership is advisory, and the seam tolerates
* serving an unlisted id.
*/
var WorkBuddyPiAiAdapter = class extends PiAiAdapter {
	catalog;
	constructor(catalog, options) {
		super(options);
		this.catalog = catalog;
	}
	/** Catalog entry for one model id, or undefined when the catalog omits it. */
	infoFor(model) {
		return this.catalog.current().find((entry) => entry.id === model);
	}
	async listModels(provider) {
		return (await super.listModels(provider)).map((model) => {
			const info = this.infoFor(model.id);
			if (info === void 0) return model;
			return {
				...model,
				name: withCatalogDisplay(model.name, info)
			};
		});
	}
	async resolveModel(provider, model, signal) {
		const resolved = await super.resolveModel(provider, model, signal);
		const info = this.infoFor(model);
		if (info === void 0) return resolved;
		return {
			...resolved,
			name: withCatalogDisplay(resolved.name, info)
		};
	}
};
//#endregion
//#region src/pool-failover.ts
/**
* Failover across a WorkBuddy account pool.
*
* This is the piece the user asked for: send the request, and if the account
* that served it is throttled or out of credit, try the next one — without the
* caller knowing a pool exists.
*
* WHAT IT IS NOT. It is not a generic retry loop. A retry loop would re-send on
* every failure, including the ones where the next account fails identically
* (see \`isAccountScoped\`), and it would re-send the SAME attempt twice on one
* account. The rules here are deliberately narrower:
*
*  1. Every account is tried AT MOST ONCE per request. A second attempt on a
*     throttled account is a wasted round trip, and on a streaming endpoint it
*     is also a second chance to emit partial output.
*  2. Only account-scoped failures advance the walk. Anything else returns
*     immediately, because the pool cannot fix it.
*  3. When every account has been tried, the LAST failure is returned with the
*     number of accounts attempted, so the user can tell \"throttled on all
*     three\" from \"throttled, and I have only one account\".
*
* The attempt callback is supplied by the caller and owns the actual request;
* this module owns only the decision of when to stop.
*
* @module dsh-multibuddy-connect/pool-failover
*/
/**
* Try each available account until one succeeds.
*
* @param options - the pool and the attempt callback.
* @returns the first success, or the last failure with the accounts tried.
*/
async function withFailover(options) {
	const { pool } = options;
	const now = options.now ?? Date.now;
	const tried = [];
	let last;
	const candidates = pool.available(now());
	for (const record of candidates) {
		tried.push(record.id);
		const outcome = await options.attempt(record);
		try {
			options.onAttempt?.(record, outcome);
		} catch {}
		if (outcome.ok) {
			pool.report(record.id, "ok", now());
			await pool.flush();
			return {
				value: outcome.value,
				tried
			};
		}
		pool.report(record.id, outcome.kind, now());
		last = {
			kind: outcome.kind,
			message: outcome.message,
			status: outcome.status,
			accountId: record.id
		};
		if (!isAccountScoped(outcome.kind)) {
			await pool.flush();
			return {
				tried,
				failure: last
			};
		}
	}
	await pool.flush();
	return last === void 0 ? { tried } : {
		tried,
		failure: last
	};
}
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
* shim applies the WorkBuddy wire quirks (forced streaming, string
* `tool_choice`, CLI-shaped headers) and forwards to the real upstream.
* It binds 127.0.0.1 only and never serves another interface.
*
* Inbound hardening: the loopback bind alone is not a trust boundary (any
* local process or a DNS-rebinding page can reach 127.0.0.1), so every
* request must carry a loopback Host header, browser-sent Origins must be
* loopback, chat POSTs must be application/json, and the Authorization
* header must carry the shim's per-process shared secret. The plugin's
* own client satisfies all four by construction; local attackers cannot
* read the secret out of the plugin process's memory.
*
* @module dsh-workbuddy-connect/shim
*/
const REQUEST_BODY_LIMIT = 67108864;
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	activation_required: 403,
	session_dead: 401,
	not_found: 502,
	server: 502,
	client: 400
};
/**
* What a user sees when the upstream reports an unactivated trial (code 14017).
*
* Written as an instruction rather than a diagnosis: the fix is a website
* action the plugin cannot perform, so the message names it directly and keeps
* the original upstream text for anyone who wants the raw reason.
*/
const ACTIVATION_REQUIRED_MESSAGE = "WorkBuddy 国际版账号尚未激活免费试用，因此无法调用模型。请打开 https://www.workbuddy.ai 登录后完成免费试用激活（选择地区即可），然后回到此处重试。WorkBuddy AI account has not activated its free trial yet. Open https://www.workbuddy.ai, sign in and activate the free trial (just pick your region), then retry.";
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody$3(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/**
* Start the loopback endpoint. Requests carry any bearer; the loopback bind
* is the boundary, and the upstream credential comes from the store alone.
*/
function createWorkBuddyShim(options) {
	const { store, client, catalog } = options;
	const logger = options.logger;
	const onActivationRequired = options.onActivationRequired;
	const onActivationCleared = options.onActivationCleared;
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	/** Constant-time bearer check; absent or mismatched bearers are rejected. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const presented = match[1];
		const expected = SHARED_SECRET;
		const a = Buffer.from(presented);
		const b = Buffer.from(expected);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("workbuddy shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				writeJson(res, 200, {
					object: "list",
					data: catalog.current().map((model) => ({
						id: model.id,
						object: "model",
						created: 0,
						owned_by: "workbuddy"
					}))
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		}
	}
	/**
	* Send one prepared chat body, failing over across the account pool.
	*
	* WHY THIS IS NOT JUST `store.resolve()`. With one account the answer is that
	* account; with several it is whichever one is not throttled, and a request
	* that hits a rate limit must be retried on the next rather than surfaced.
	* The decision of WHEN to retry lives in `withFailover`; all this does is
	* supply it the per-account attempt.
	*
	* A POOL-LESS VARIANT STAYS ON THE OLD PATH. When no pool is supplied the
	* resolve-and-send happens exactly as before, so a single-account install
	* cannot be affected by any of this.
	*
	* @param prepared - the request body, already translated for the upstream.
	* @param signal - aborted when the caller disconnects.
	* @returns the upstream result, or undefined when no account could be resolved.
	*/
	async function sendWithFailover(prepared, signal) {
		const pool = options.accountPool;
		if (pool === void 0) {
			let credential;
			try {
				credential = await store.resolve();
			} catch {
				return;
			}
			return client.chatStream(credential, prepared, signal);
		}
		const resolveAccount = options.resolveAccount;
		if (resolveAccount === void 0) throw new Error("dsh-workbuddy-connect: a shim was given an account pool without an account resolver");
		return (await withFailover({
			pool,
			attempt: async (record) => {
				let credential;
				try {
					credential = await resolveAccount(record.id);
				} catch (error) {
					return {
						ok: false,
						kind: "session_dead",
						status: 401,
						message: String(error)
					};
				}
				const outcome = await client.chatStream(credential, prepared, signal);
				return outcome.ok ? {
					ok: true,
					value: outcome
				} : {
					ok: false,
					kind: outcome.kind,
					status: outcome.status,
					message: outcome.message
				};
			},
			onAttempt: (record, outcome) => {
				options.onAccountOutcome?.(record.id, outcome.ok ? "ok" : outcome.kind);
			}
		})).value;
	}
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		const raw = (await readBody$3(req)).toString("utf8");
		const prepared = prepareChatBody(raw);
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const result = await sendWithFailover(prepared, controller.signal);
		if (result === void 0) {
			writeOpenAIError(res, 401, "not_signed_in", "workbuddy: no usable account; sign in from the plugin's settings card");
			return;
		}
		if (!result.ok) {
			if (result.kind === "activation_required") try {
				onActivationRequired?.();
			} catch {}
			writeOpenAIError(res, KIND_STATUS[result.kind], result.kind, result.kind === "activation_required" ? ACTIVATION_REQUIRED_MESSAGE : `workbuddy upstream ${result.kind} (http ${result.status}): ${result.message.slice(0, 400)}`);
			return;
		}
		try {
			onActivationCleared?.();
		} catch {}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		let sawDone = false;
		const body = Readable.fromWeb(result.response.body);
		body.on("data", (chunk) => {
			if (chunk.includes("[DONE]")) sawDone = true;
		});
		body.on("error", (error) => {
			logger?.warn("dsh-workbuddy-connect: upstream stream failed mid-flight", error);
			if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
		});
		body.pipe(res);
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.close(() => resolve());
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
//#endregion
//#region src/probe-store.ts
/**
* Local record of reasoning-effort probes.
*
* What this stores is an *observation*, never a claim about the upstream: a
* model's row is only consulted when the catalog carries no explicit
* `supportedEfforts` set, and it always loses to a declared set. The plan this
* implements (`docs/reasoning-effort-probe-plan.md` §5) requires that a result
* is invalidated whenever the model's catalog row changes, so every record
* carries a fingerprint of the fields the probe depended on.
*
* The file lives beside the plugin's own credential copy under `$DSH_HOME`,
* never in the desktop app's files, and carries no token, prompt, or response
* body — only model ids, effort spellings, and timestamps.
*
* @module dsh-workbuddy-connect/probe-store
*/
/** Basename of the probe record inside the Harness home. */
const WORKBUDDY_PROBE_FILENAME = ".workbuddy-probe.json";
/** On-disk format this reader accepts; other versions are discarded. */
const PROBE_FORMAT_VERSION = 1;
/**
* How long an observation stays usable. Conservative on purpose: the plan's
* whole argument is that upstream metadata moves fast, so a result that has
* outlived its fingerprint's usefulness should not quietly keep granting a
* picker entry.
*/
const DEFAULT_TTL_MS = 12096e5;
/**
* Plugin-owned probe record path inside the plugin's config directory.
*
* One file per variant. Same-named models exist on both endpoints (the
* international catalog repeats `glm-5.3`, `glm-5.2`, `hy3`, `kimi-k2.6`), and
* {@link fingerprintModel} covers only `id`/`reasoning`/`supportsImages` —
* never the provider — so a single shared file would let one variant's
* observation answer for the other. The paths differ; the format does not.
*/
function workbuddyProbePath(filename = WORKBUDDY_PROBE_FILENAME) {
	return join(workbuddyStateDir(), filename);
}
/**
* Fingerprint the catalog fields a probe depends on.
*
* Deliberately excludes display-only fields (`name`, `billing`, `contextWindow`)
* so a rename or a promo badge does not throw away a valid observation, and
* deliberately includes the whole reasoning object so any change to the
* declared shape re-probes.
*/
function fingerprintModel(info) {
	const basis = JSON.stringify({
		id: info.id,
		reasoning: info.reasoning ?? null,
		supportsImages: info.supportsImages ?? null
	});
	return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}
/** Read-and-validate the documents on disk; anything malformed reads as empty. */
function readDocument(path) {
	if (!existsSync(path)) return void 0;
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	if (wrapped["version"] !== PROBE_FORMAT_VERSION) return void 0;
	const records = wrapped["records"];
	if (typeof records !== "object" || records === null || Array.isArray(records)) return void 0;
	return parsed;
}
/** One record's shape check; a bad row is dropped rather than trusted. */
function isRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const wrapped = value;
	const validation = wrapped["validation"];
	if (validation !== "validating" && validation !== "non-validating" && validation !== "unknown") return false;
	if (typeof wrapped["fingerprint"] !== "string") return false;
	if (typeof wrapped["probedAtMs"] !== "number" || !Number.isFinite(wrapped["probedAtMs"])) return false;
	if (typeof wrapped["pluginVersion"] !== "string") return false;
	const efforts = wrapped["efforts"];
	if (!Array.isArray(efforts) || efforts.some((effort) => typeof effort !== "string")) return false;
	return true;
}
/**
* The plugin's probe records: read once, written atomically, never trusted
* across a fingerprint change or past the TTL.
*/
var WorkBuddyProbeStore = class {
	path;
	ttlMs;
	pluginVersion;
	now;
	records;
	constructor(options) {
		const opts = typeof options === "string" ? {
			path: options,
			pluginVersion: "0.0.0"
		} : options;
		this.path = opts.path ?? workbuddyProbePath();
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.pluginVersion = opts.pluginVersion;
		this.now = opts.now ?? (() => Date.now());
	}
	/** Resolved state-file path, for the CLI and tests. */
	filePath() {
		return this.path;
	}
	load() {
		if (this.records === void 0) {
			const document = readDocument(this.path);
			const records = {};
			for (const [id, record] of Object.entries(document?.records ?? {})) if (isRecord(record)) records[id] = record;
			this.records = records;
		}
		return this.records;
	}
	/**
	* The usable record for a model, or `undefined` when there is none, it is
	* expired, it was taken against a different catalog row, or it belongs to a
	* different account.
	*
	* @param account - the account in effect, as `uid:enterpriseId`. Records are
	*   only returned for the account that produced them.
	*/
	get(modelId, fingerprint, account) {
		const record = this.load()[modelId];
		if (record === void 0) return void 0;
		if (record.fingerprint !== fingerprint) return void 0;
		if (record.account !== account) return void 0;
		if (this.now() - record.probedAtMs > this.ttlMs) return void 0;
		return record;
	}
	/**
	* Store one observation. Only a decisive answer (`validating` /
	* `non-validating`) replaces an existing decisive record: a transient
	* `unknown` must not erase knowledge the user already paid for.
	*/
	set(modelId, record) {
		const records = this.load();
		const existing = records[modelId];
		if (record.validation === "unknown" && existing !== void 0 && existing.fingerprint === record.fingerprint && existing.validation !== "unknown") return;
		records[modelId] = record;
		this.persist();
	}
	/** Drop every record; used by the card's explicit "clear" action. */
	clear() {
		this.records = {};
		this.persist();
	}
	/**
	* Drop every record that does NOT belong to the given account.
	*
	* The identity-change purge: a previous account's observations must not
	* answer for the account now in effect, but the account taking over keeps
	* its own records — written before a restart, or seeded while the host was
	* running. Clearing the whole file here (as `clear` does) would delete
	* those too, so the purge is per-account instead. Records with no account
	* (written before account binding existed) cannot be attributed to anyone,
	* so they go.
	*/
	clearOthers(account) {
		const records = this.load();
		let dropped = false;
		for (const [id, record] of Object.entries(records)) if (record.account !== account) {
			delete records[id];
			dropped = true;
		}
		if (dropped) this.persist();
	}
	/** Every record currently held, for status display. */
	all() {
		return { ...this.load() };
	}
	/** Build a record stamped with this store's clock, version, and account. */
	record(fingerprint, validation, efforts, account) {
		return {
			fingerprint,
			validation,
			efforts: validation === "validating" ? [...efforts] : [],
			probedAtMs: this.now(),
			pluginVersion: this.pluginVersion,
			account
		};
	}
	/**
	* Write through a temporary file and rename, so a crash mid-write cannot
	* leave a half-parsed document that reads as "no records" and silently drops
	* every observation.
	*/
	persist() {
		const directory = dirname(this.path);
		try {
			if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
			const document = {
				version: PROBE_FORMAT_VERSION,
				records: this.load()
			};
			const temporary = resolve(`${this.path}.tmp`);
			writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 384 });
			renameSync(temporary, this.path);
		} catch {}
	}
};
/**
* Order observations newest-first for display.
*
* The store keeps insertion order so the file reads chronologically, but the
* card wants the most recent detection at the top: a sweep the user just ran
* should not appear below every earlier one, which is what appending to an
* insertion-ordered list does.
*/
function newestFirst(records) {
	return [...records].sort((a, b) => b.probedAt - a.probedAt);
}
//#endregion
//#region src/probe-service.ts
/**
* Serial probe runner. One instance is shared by the manual API and any
* future automatic trigger, so the two can never overlap.
*/
var WorkBuddyProbeService = class {
	options;
	queue = Promise.resolve();
	pending = /* @__PURE__ */ new Map();
	running = false;
	constructor(options) {
		this.options = options;
	}
	/** Whether a sweep is in flight right now. */
	isRunning() {
		return this.running;
	}
	/**
	* The record the adapter may use for this model, or `undefined`.
	*
	* Applies the plan's precedence (§5): a declared set always wins, so a model
	* that declares `supportedEfforts` is never answered from an observation.
	*/
	recordFor(modelId) {
		const info = this.options.catalog.current().find((model) => model.id === modelId);
		if (info === void 0) return void 0;
		if (info.reasoning?.supportedEfforts !== void 0 && info.reasoning.supportedEfforts.length > 0) return;
		const account = this.options.account();
		if (account === void 0) return void 0;
		return this.options.store.get(modelId, fingerprintModel(info), account);
	}
	/**
	* Probe one model, serially.
	*
	* The authenticated manual route supplies one-request consent after UI
	* confirmation. Other callers must pass the configured consent gate.
	* Manual consent never changes the automatic-probing configuration.
	* Explicit requests bypass historical results, but share an ongoing run.
	*/
	async probe(modelId, manualConsent = false) {
		if (!manualConsent && !this.options.consent()) return {
			state: "unavailable",
			reason: "probing is not authorized"
		};
		if (this.options.catalog.current().find((model) => model.id === modelId) === void 0) return {
			state: "unavailable",
			reason: `unknown model: ${modelId}`
		};
		const account = this.options.account();
		if (account === void 0) return {
			state: "unavailable",
			reason: "no WorkBuddy credential"
		};
		const pendingKey = JSON.stringify([account, modelId]);
		const pending = this.pending.get(pendingKey);
		if (pending !== void 0) return pending;
		const run = this.queue.then(async () => {
			const current = this.options.catalog.current().find((model) => model.id === modelId);
			if (current === void 0) return {
				state: "unavailable",
				reason: `unknown model: ${modelId}`
			};
			if (!manualConsent && !this.options.consent()) return {
				state: "unavailable",
				reason: "probing is not authorized"
			};
			if (current.reasoning?.supports !== true || (current.reasoning.supportedEfforts?.length ?? 0) > 0) return {
				state: "unavailable",
				reason: "model does not need detection"
			};
			const cached = this.recordFor(modelId);
			if (!manualConsent && cached !== void 0 && cached.validation !== "unknown") return {
				state: "ok",
				validation: cached.validation,
				efforts: cached.efforts,
				requests: 0
			};
			if (this.options.account() !== account) return {
				state: "unavailable",
				reason: "account changed before detection"
			};
			const credential = await this.options.credentials.current();
			if (credential === void 0) return {
				state: "unavailable",
				reason: "no WorkBuddy credential"
			};
			const send = this.options.send === void 0 ? (effort, signal) => this.options.client.probeEffort(credential, modelId, effort, signal) : this.options.send(modelId);
			this.running = true;
			try {
				const outcome = await probeModel({
					send,
					...this.options.sentinel === void 0 ? {} : { sentinel: this.options.sentinel }
				});
				if (this.options.account() !== account) return {
					state: "unavailable",
					reason: "account changed during detection"
				};
				const record = this.options.store.record(fingerprintModel(current), outcome.validation, outcome.efforts, account);
				this.options.store.set(modelId, record);
				if (outcome.validation === "unknown") return {
					state: "unavailable",
					reason: outcome.reason
				};
				return {
					state: "ok",
					validation: outcome.validation,
					efforts: record.efforts,
					requests: outcome.requests
				};
			} finally {
				this.running = false;
			}
		});
		this.queue = run.catch(() => void 0);
		this.pending.set(pendingKey, run);
		try {
			return await run;
		} finally {
			this.pending.delete(pendingKey);
		}
	}
};
//#endregion
//#region src/web-status.ts
/** Redact token-like content before it crosses to the browser. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function json$3(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/**
* The request must be addressed to the loopback interface, and a
* browser-attached Origin must be loopback too. The Host check drops
* DNS-rebinding pages (their Host is the attacker's domain, not loopback);
* the card's same-origin fetches carry no Origin and pass on Host alone.
*/
function loopbackRequest(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
/**
* Assemble the card's status document. Sign-in state is read-only; credit is
* a live billing answer whose failure degrades to `creditsError` rather than
* failing the whole document.
*/
async function workBuddyWebStatus(deps) {
	const authStatus = await deps.store.status();
	if (authStatus.state !== "signed-in") return {
		status: "signed-out",
		...authStatus.reason === void 0 ? {} : { reason: authStatus.reason },
		...deps.loginKey === void 0 ? {} : { loginKey: deps.loginKey }
	};
	const pool = deps.pool?.();
	const status = {
		status: "signed-in",
		...authStatus.nickname === void 0 ? {} : { nickname: authStatus.nickname },
		...authStatus.domain === void 0 || authStatus.domain === "" ? {} : { domain: authStatus.domain },
		...authStatus.region === void 0 ? {} : { region: authStatus.region },
		...authStatus.expiresAtMs === void 0 ? {} : { expiresAt: authStatus.expiresAtMs },
		...deps.loginKey === void 0 ? {} : { loginKey: deps.loginKey },
		...pool === void 0 ? {} : { pool }
	};
	const modelsField = deps.models().map((model) => {
		const rate = normalizeCredits(model.billing?.credits);
		const staleRate = model.billing?.rateUnknown === true ? normalizeCredits(model.billing.credits) : void 0;
		const expiredLabels = [...new Set((model.billing?.expiredPromotions ?? []).filter((label) => label !== ""))];
		const supported = model.supportedContextWindows ?? [];
		const maxContextWindow = supported.length > 0 ? Math.max(...supported) : void 0;
		const defaultContextWindow = model.defaultContextWindow ?? model.contextWindow;
		return {
			id: model.id,
			name: model.name,
			...model.billing?.free === true ? { free: true } : {},
			...model.billing?.badges !== void 0 && model.billing.badges.length > 0 ? { badges: model.billing.badges } : {},
			...model.billing?.rateUnknown === true ? {
				rateUnknown: true,
				...staleRate === void 0 ? {} : { expiredCredits: staleRate },
				...expiredLabels.length === 0 ? {} : { expiredPromotions: expiredLabels }
			} : rate === void 0 ? {} : { credits: rate },
			...typeof model.contextWindow === "number" && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
			...typeof defaultContextWindow === "number" && defaultContextWindow > 0 && defaultContextWindow < model.contextWindow ? { defaultContextWindow } : {},
			...maxContextWindow === void 0 || maxContextWindow <= defaultContextWindow ? {} : { maxContextWindow },
			...typeof model.maxInputTokens === "number" && model.maxInputTokens > 0 ? { maxInputTokens: model.maxInputTokens } : {}
		};
	});
	const catalog = deps.catalog?.();
	const withCatalog = catalog === void 0 ? status : {
		...status,
		catalog
	};
	const statusWithModels = modelsField.length > 0 ? {
		...withCatalog,
		models: modelsField
	} : withCatalog;
	const checkInRecord = deps.checkIn?.();
	const probed = {
		...statusWithModels,
		...deps.probe === void 0 ? {} : { probe: deps.probe() },
		...deps.probeKey === void 0 ? {} : { probeKey: deps.probeKey },
		...deps.useMaximumContextWindow === void 0 ? {} : { useMaximumContextWindow: deps.useMaximumContextWindow() },
		...deps.disabledModels === void 0 ? {} : { disabledModels: deps.disabledModels() },
		...checkInRecord === void 0 ? {} : { checkIn: checkInRecord },
		...deps.activationRequired?.() === true ? { activationRequired: true } : {}
	};
	try {
		const credential = await deps.store.current();
		if (credential !== void 0) {
			const credits = await deps.client.fetchCredits(credential);
			return {
				...probed,
				credits
			};
		}
	} catch (error) {
		return {
			...probed,
			creditsError: safeMessage(error)
		};
	}
	return probed;
}
/** The status route's request handler, extracted so tests can mount it on a bare server. */
function workBuddyStatusHandler(deps) {
	return async (req, res) => {
		if (req.method !== "GET") {
			json$3(res, 405, { error: "method not allowed" });
			return;
		}
		if (!loopbackRequest(req)) {
			json$3(res, 403, { error: "request-not-trusted" });
			return;
		}
		try {
			json$3(res, 200, await workBuddyWebStatus(deps));
		} catch (error) {
			json$3(res, 500, { error: safeMessage(error) });
		}
	};
}
/** Mount the GET status route on an optional webServer context. */
function registerWorkBuddyStatusRoute(ctx, deps) {
	const path = deps.path ?? "/plugins/dsh-workbuddy-connect/status";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path,
			handler: workBuddyStatusHandler(deps)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy-connect: Web status route");
}
//#endregion
//#region src/probe-route.ts
/**
* Probe control route: the only state-changing endpoint the plugin exposes.
*
* Two guards, because they stop different things (see `docs/reasoning-effort-probe-plan.md`
* §6.4 and the v0.3.1 note in AGENTS.md about their exact scope):
*
* 1. **Loopback Host + Origin**, shared with the status route. This drops
*    DNS-rebinding pages, whose requests arrive addressed to the attacker's
*    domain.
* 2. **An in-process random key**, minted per process and handed only to the
*    same-origin card. Loopback alone is *not* authentication — any local
*    process can write `Host: 127.0.0.1` — so a route that spends the user's
*    credit must prove the caller was told the key.
*
* The route never accepts a prompt, a model id outside the live catalog, or a
* sentinel from the browser: a probe request is assembled entirely host-side.
*
* @module dsh-workbuddy-connect/probe-route
*/
/** Largest control body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES$2 = 4096;
/** Mint the per-process control key. */
function createProbeKey() {
	return randomBytes(24).toString("hex");
}
/**
* Constant-time key comparison; a length mismatch is a failure, not a crash.
*/
function keyMatches$2(expected, presented) {
	if (presented === void 0 || presented.length !== expected.length) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && timingSafeEqual(a, b);
}
function json$2(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Read the request body with a hard ceiling. */
async function readBody$2(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES$2) return void 0;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Parse and shape-check an action; unknown fields are ignored, not trusted. */
function parseAction(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	const action = wrapped["action"];
	if (action === "clear") return { action: "clear" };
	if (action === "clear-checkin-logs") return { action: "clear-checkin-logs" };
	if (action === "checkin") return { action: "checkin" };
	if (action === "refresh") return { action: "refresh" };
	if (action === "set-maximum-context-window") return typeof wrapped["enabled"] === "boolean" ? {
		action: "set-maximum-context-window",
		enabled: wrapped["enabled"]
	} : void 0;
	if (action === "set-disabled-models") return Array.isArray(wrapped["disabledModels"]) && wrapped["disabledModels"].every((item) => typeof item === "string") ? {
		action: "set-disabled-models",
		disabledModels: wrapped["disabledModels"]
	} : void 0;
	if (action === "probe") {
		const model = wrapped["model"];
		if (typeof model !== "string" || model.trim() === "") return void 0;
		return {
			action: "probe",
			model: model.trim()
		};
	}
}
/**
* The control route's handler, extracted so tests can mount it on a bare
* server with a known key.
*/
function workBuddyProbeHandler(deps, key) {
	return async (req, res) => {
		if (req.method !== "POST") {
			json$2(res, 405, { error: "method not allowed" });
			return;
		}
		if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
			json$2(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (!keyMatches$2(key, req.headers["x-workbuddy-probe-key"])) {
			json$2(res, 403, { error: "invalid-probe-key" });
			return;
		}
		const body = await readBody$2(req);
		if (body === void 0) {
			json$2(res, 413, { error: "body too large" });
			return;
		}
		const action = parseAction(body);
		if (action === void 0) {
			json$2(res, 400, { error: "invalid action" });
			return;
		}
		try {
			if (action.action === "clear") {
				deps.clear();
				json$2(res, 200, { state: "cleared" });
				return;
			}
			if (action.action === "clear-checkin-logs") {
				deps.clearCheckInLogs?.();
				json$2(res, 200, { state: "cleared" });
				return;
			}
			if (action.action === "checkin") {
				if (deps.checkIn === void 0) {
					json$2(res, 404, { error: "checkin-not-supported" });
					return;
				}
				json$2(res, 200, await deps.checkIn());
				return;
			}
			if (action.action === "refresh") {
				if (deps.refresh === void 0) {
					json$2(res, 404, { error: "refresh-not-supported" });
					return;
				}
				json$2(res, 200, await deps.refresh());
				return;
			}
			if (action.action === "set-maximum-context-window") {
				if (deps.setMaximumContextWindow === void 0) {
					json$2(res, 404, { error: "context-window-setting-not-supported" });
					return;
				}
				json$2(res, 200, await deps.setMaximumContextWindow(action.enabled === true));
				return;
			}
			if (action.action === "set-disabled-models") {
				if (deps.setDisabledModels === void 0) {
					json$2(res, 404, { error: "disabled-models-setting-not-supported" });
					return;
				}
				json$2(res, 200, await deps.setDisabledModels(action.disabledModels ?? []));
				return;
			}
			json$2(res, 200, await deps.probe(action.model));
		} catch (error) {
			json$2(res, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	};
}
/** Mount the POST probe-control route on an optional webServer context. */
function registerWorkBuddyProbeRoute(ctx, deps, key) {
	const path = deps.path ?? "/plugins/dsh-workbuddy-connect/probe";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path,
			handler: workBuddyProbeHandler(deps, key)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy-connect: probe control route");
}
//#endregion
//#region src/backends/wiring.ts
/**
* Wiring: turn the stored account registry into the per-backend account lists
* that api-key backends expect.
*
* WHY THIS IS A SEPARATE MODULE. The backends are leaf modules — they are
* given their accounts and do not read the registry themselves, which keeps
* each one testable without a filesystem and stops nine modules from each
* inventing their own read/cache/error policy for the same file. The cost of
* that choice is this adapter layer, which is the single place that knows both
* the registry's shape and each backend's expectations.
*
* THE SEMANTIC THAT MATTERS, and the one most easily got wrong: a registry
* with zero accounts is NOT the same fact as "no registry was consulted".
*
*  - Zero accounts means the user has configured none, so the backend should
*    fall back to its environment variable (a developer's `CLINE_API_KEY`).
*  - A NON-EMPTY list means the user deliberately configured accounts, and the
*    environment variable must then be IGNORED. Honouring both would make a
*    deleted account reappear from the environment on the next restart —
*    "I removed it and it came back" is the kind of bug nobody can explain by
*    looking at the UI.
*
* Hence this module passes `undefined` for the empty case and the list
* otherwise, and never an empty array. That distinction is the whole point of
* the module existing rather than each call site inlining a map.
*
* @module dsh-workbuddy-connect/backends/wiring
*/
/**
* Read one backend's accounts and shape them for injection.
*
* A stored secret that is not a string is DROPPED rather than coerced. These
* documents are written by this plugin, so a non-string means either a
* hand-edited file or a future format; either way, sending `[object Object]`
* as an API key would produce a confusing upstream auth failure instead of a
* missing account the user can see and fix.
*
* @param registry - the account registry.
* @param backendId - the backend to read.
* @returns the seed list, or `undefined` when none are configured (see the
*   module note — this is NOT the same as an empty list).
*/
async function seedsFor(registry, backendId) {
	const stored = await registry.list(backendId);
	const seeds = [];
	for (const account of stored) {
		const seed = toSeed(account);
		if (seed !== void 0) seeds.push(seed);
	}
	if (seeds.length > 0) return seeds;
	return await registry.hasStored(backendId) ? [] : void 0;
}
/** Shape one stored account, or undefined when its secret is unusable. */
function toSeed(account) {
	const secret = typeof account.secret === "string" ? account.secret.trim() : void 0;
	if (secret === void 0 || secret === "") return void 0;
	return {
		id: account.id,
		label: account.label,
		secret
	};
}
/**
* The registry instance the shell shares with its backends.
*
* One instance per plugin start, not per backend: the registry caches parsed
* files, and nine instances would mean nine copies of every account list in
* memory and nine chances for one to go stale after a write.
*/
function createRegistry() {
	return new BackendAccountRegistry();
}
//#endregion
//#region src/backends/catalog.ts
/**
* The merged backends, in display order.
*
* Static imports would turn a typo in a module path into a build failure, which
* is strictly better — but several backends pull in Node built-ins and one may
* fail to load on a platform it does not support, so the dynamic import is what
* lets {@link loadBackends} attribute that failure to one backend instead of
* losing the whole catalogue.
*/
const BACKEND_ENTRIES = [
	{
		id: "loomy",
		create: async () => (await import("./loomy-DoUyEpLW.js")).createLoomyBackend()
	},
	{
		id: "mimo",
		create: async () => (await import("./mimo-C9NOl0vA.js")).createMiMoBackend()
	},
	{
		id: "cline",
		create: async (registry) => {
			const accounts = await seedsFor(registry, "cline");
			const { createClineBackend } = await import("./cline-CUegIe1c.js");
			return accounts === void 0 ? createClineBackend() : createClineBackend({ accounts });
		}
	},
	{
		id: "commandcode",
		create: async (registry) => {
			const accounts = await seedsFor(registry, "commandcode");
			const { createCommandCodeBackend } = await import("./commandcode-BOPLiNl5.js");
			return accounts === void 0 ? createCommandCodeBackend({ registry }) : createCommandCodeBackend({
				accounts,
				registry
			});
		}
	},
	{
		id: "trae",
		create: async () => (await import("./trae-Bipv_pum.js")).createTraeBackend()
	},
	{
		id: "qoder",
		create: async () => (await import("./qoder-CZiFl29j.js")).createQoderBackend()
	},
	{
		id: "codebuddy",
		create: async () => (await import("./codebuddy-BaKBvFrA.js")).createCodeBuddyBackend()
	},
	{
		id: "opencode",
		create: async () => (await import("./opencode-BDOMRIKR.js")).createOpenCodeBackend()
	}
];
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
async function loadBackends(registry) {
	const backends = [];
	const failures = [];
	for (const entry of BACKEND_ENTRIES) try {
		backends.push(await entry.create(registry));
	} catch (error) {
		failures.push({
			id: entry.id,
			message: error instanceof Error ? error.message : String(error)
		});
	}
	return {
		backends,
		failures
	};
}
//#endregion
//#region src/usage/ledger.ts
/**
* The local usage ledger: per-day, per-account token accounting.
*
* WHY THIS EXISTS. The usage dashboard is meant to answer "what have I spent",
* and the honest answer is that almost none of the merged backends will tell
* us. Qoder, Trae, MiMo, Loomy and CodeBuddy are subscription products whose
* endpoints expose a remaining balance at best; the OpenCode pair hides behind
* a child runtime. Only the harness-native meter knows token counts — and it
* knows them per SESSION, not per backend account, and not retained across
* days.
*
* So the plugin keeps its own ledger. The harness reports the four token
* buckets this plugin folds in, and the ledger attributes them to the account
* that was actually serving the session at the time.
*
* THE ATTRIBUTION PROBLEM, and why the API looks like this. A token count
* arrives without saying which account produced it. The ledger therefore does
* NOT guess from content or timing: the caller must name the (backend,
* account) pair explicitly, and the shell derives that pair from the session's
* routed model — the one place where the truth actually lives. An unattributed
* count is DROPPED rather than filed under a default account, because a wrong
* attribution silently corrupts the very comparison the user opened the page
* to make.
*
* LAYOUT. One row per (day, backend, account). Days are the ledger's grain
* because that is the granularity the dashboard charts and the format the user
* asked for; a finer grain would only be aggregated back down, and a coarser
* one could not be re-sliced. Rows are pruned by age so the file stays bounded
* on a machine that has been running for months.
*
* @module dsh-workbuddy-connect/usage/ledger
*/
/** On-disk format version; an unknown version is refused, not guessed at. */
const LEDGER_FORMAT_VERSION = 1;
/**
* How long a daily row is kept.
*
* 400 days, not 365: a user comparing "this month against the same month last
* year" needs the previous year's row to still exist on the first day of the
* month, and 365 would have pruned it exactly one day too early.
*/
const RETENTION_DAYS = 400;
/**
* The local calendar day of a timestamp.
*
* LOCAL, not UTC, and that is a deliberate choice with a visible consequence:
* a token spent at 23:30 belongs to the day the user experienced it, not to
* the next UTC day. A UTC ledger would show a user in UTC+8 an hour of their
* evening activity filed under tomorrow.
*
* @param atMs - the timestamp.
* @returns `YYYY-MM-DD` in the machine's local timezone.
*/
function localDay(atMs) {
	const date = new Date(atMs);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
/** Zero buckets, for accumulating into. */
function zeroBuckets$1() {
	return {
		uncachedInput: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0
	};
}
/** Sum of a bucket set — the figure the dashboard shows as "total tokens". */
function totalTokens(tokens) {
	return tokens.uncachedInput + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}
/**
* Where the ledger file lives.
*
* Data-directory root beside the credentials, but this is NOT secret material —
* it is usage metadata. It lives here anyway because it is user state that must
* survive a cache wipe: deleting token history because someone cleared a
* model catalog would be a surprise.
*/
function usageLedgerPath() {
	return join(workbuddyPluginDataDir(), ".usage-ledger.json");
}
/**
* The usage ledger.
*
* Writes are batched in memory and flushed explicitly. A flush per model call
* would rewrite the whole file on every turn — the ledger holds up to 400 days
* of rows — and every one of those writes is a chance to be interrupted
* mid-file.
*/
var UsageLedger = class {
	rows = [];
	loaded = false;
	/** Whether anything changed since the last successful flush. */
	dirty = false;
	/** Read the file once; subsequent calls use the in-memory rows. */
	async load() {
		if (this.loaded) return;
		this.loaded = true;
		let text;
		try {
			text = await readFile(usageLedgerPath(), "utf8");
		} catch {
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			return;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
		const document = parsed;
		if (document["version"] !== LEDGER_FORMAT_VERSION) return;
		const raw = document["rows"];
		if (!Array.isArray(raw)) return;
		for (const entry of raw) {
			const row = parseRow(entry);
			if (row !== void 0) this.rows.push(row);
		}
	}
	/**
	* Add one model call's tokens to an account's day.
	*
	* `backendId` and `accountId` are REQUIRED and never defaulted — see the
	* module note on attribution. A caller that does not know which account
	* served a call must not record it at all.
	*
	* @param backendId - the backend that served the call.
	* @param accountId - the account within that backend.
	* @param tokens - the four buckets reported for the call.
	* @param atMs - when the call happened; defaults to now.
	*/
	record(backendId, accountId, tokens, atMs = Date.now()) {
		if (backendId === "" || accountId === "") return;
		const day = localDay(atMs);
		const target = this.rows.find((candidate) => candidate.day === day && candidate.backendId === backendId && candidate.accountId === accountId) ?? this.push({
			day,
			backendId,
			accountId,
			tokens: zeroBuckets$1(),
			calls: 0
		});
		target.tokens.uncachedInput += tokens.uncachedInput ?? 0;
		target.tokens.output += tokens.output ?? 0;
		target.tokens.cacheRead += tokens.cacheRead ?? 0;
		target.tokens.cacheWrite += tokens.cacheWrite ?? 0;
		target.calls += 1;
		this.dirty = true;
	}
	/** Every row, oldest first. */
	all() {
		return this.rows;
	}
	/**
	* Rows within a day range, inclusive.
	*
	* @param fromDay - `YYYY-MM-DD` lower bound, inclusive.
	* @param toDay - `YYYY-MM-DD` upper bound, inclusive; omitted means today.
	*/
	range(fromDay, toDay = localDay(Date.now())) {
		return this.rows.filter((row) => row.day >= fromDay && row.day <= toDay).sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
	}
	/** Persist, after pruning rows past the retention window. */
	async flush() {
		if (!this.dirty && this.loaded) return;
		const cutoff = localDay(Date.now() - RETENTION_DAYS * 864e5);
		this.rows = this.rows.filter((row) => row.day >= cutoff);
		const file = {
			version: LEDGER_FORMAT_VERSION,
			rows: this.rows
		};
		const path = usageLedgerPath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(file), "utf8");
		this.dirty = false;
	}
	/** Drop every row, in memory and on disk. */
	async clear() {
		this.rows = [];
		this.dirty = true;
		await this.flush();
	}
	push(row) {
		this.rows.push(row);
		return row;
	}
};
/** Validate one persisted row; undefined when unusable. */
function parseRow(entry) {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return void 0;
	const record = entry;
	const day = record["day"];
	const backendId = record["backendId"];
	const accountId = record["accountId"];
	if (typeof day !== "string" || typeof backendId !== "string" || typeof accountId !== "string") return void 0;
	if (day === "" || backendId === "" || accountId === "") return void 0;
	const rawTokens = record["tokens"];
	if (typeof rawTokens !== "object" || rawTokens === null) return void 0;
	const tokens = rawTokens;
	const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
	return {
		day,
		backendId,
		accountId,
		tokens: {
			uncachedInput: number(tokens["uncachedInput"]),
			output: number(tokens["output"]),
			cacheRead: number(tokens["cacheRead"]),
			cacheWrite: number(tokens["cacheWrite"])
		},
		calls: number(record["calls"])
	};
}
/**
* Fold rows into per-day totals across every account.
*
* `from`/`to` are filled in even for days with no activity, because a chart
* that skips empty days draws a misleading continuous line across a week the
* user was away.
*
* @param rows - ledger rows to fold.
* @param fromDay - inclusive lower bound.
* @param toDay - inclusive upper bound.
* @returns one point per calendar day in range, oldest first.
*/
function dailySeries(rows, fromDay, toDay) {
	const byDay = /* @__PURE__ */ new Map();
	for (const row of rows) {
		if (row.day < fromDay || row.day > toDay) continue;
		const entry = byDay.get(row.day) ?? {
			tokens: zeroBuckets$1(),
			calls: 0
		};
		entry.tokens.uncachedInput += row.tokens.uncachedInput;
		entry.tokens.output += row.tokens.output;
		entry.tokens.cacheRead += row.tokens.cacheRead;
		entry.tokens.cacheWrite += row.tokens.cacheWrite;
		entry.calls += row.calls;
		byDay.set(row.day, entry);
	}
	const out = [];
	for (let cursor = fromDay; cursor <= toDay; cursor = nextDay(cursor)) {
		const entry = byDay.get(cursor);
		out.push({
			day: cursor,
			tokens: entry?.tokens ?? zeroBuckets$1(),
			calls: entry?.calls ?? 0
		});
	}
	return out;
}
/**
* The next calendar day.
*
* Walks through UTC deliberately: this is pure date arithmetic on a
* `YYYY-MM-DD` label, and a local-time walk would repeat or skip a day across
* a daylight-saving transition.
*/
function nextDay(day) {
	const [year, month, date] = day.split("-").map(Number);
	const next = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + 1));
	return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}
//#endregion
//#region src/usage/summary.ts
/** How far back the default window reaches. */
const DEFAULT_WINDOW_DAYS = 30;
/** Zero buckets. */
function zeroBuckets() {
	return {
		uncachedInput: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0
	};
}
/** Add one bucket set into another, in place. */
function addInto(target, source) {
	target.uncachedInput += source.uncachedInput;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
}
/**
* Fold one account's rows into window and today figures.
*
* `windowFrom` and `today` are passed in rather than recomputed so every row
* in one document agrees on the window even if the build straddles midnight.
*/
function foldAccount(rows, windowFrom, today) {
	const window = zeroBuckets();
	const todayBuckets = zeroBuckets();
	let calls = 0;
	for (const row of rows) {
		if (row.day >= windowFrom) {
			addInto(window, row.tokens);
			calls += row.calls;
		}
		if (row.day === today) addInto(todayBuckets, row.tokens);
	}
	return {
		window,
		today: todayBuckets,
		calls
	};
}
/**
* Build the dashboard document.
*
* Pure: every input is passed in, nothing is read from disk or the network, and
* the same inputs always produce the same document. That is what lets the whole
* page be tested without a host, a browser, or a clock.
*
* @param accounts - one input per resolved account, in display order.
* @param rows - the ledger's rows.
* @param options - window size and a fixed "now" for tests.
* @returns the assembled document.
*/
function buildUsageSummary(accounts, rows, options = {}) {
	const nowMs = options.nowMs ?? Date.now();
	const windowDays = options.windowDays ?? 30;
	const today = localDay(nowMs);
	const fromDay = localDay(nowMs - (windowDays - 1) * 864e5);
	const byAccount = /* @__PURE__ */ new Map();
	for (const row of rows) {
		const key = `${row.backendId}\u0000${row.accountId}`;
		const list = byAccount.get(key);
		if (list === void 0) byAccount.set(key, [row]);
		else list.push(row);
	}
	const accountRows = accounts.map((account) => {
		const key = `${account.backendId}\u0000${account.accountId}`;
		const folded = foldAccount(byAccount.get(key) ?? [], fromDay, today);
		return {
			backendId: account.backendId,
			backendName: account.backendName,
			authKind: account.authKind,
			accountId: account.accountId,
			accountLabel: account.accountLabel,
			...account.accountDetail === void 0 ? {} : { accountDetail: account.accountDetail },
			usable: account.usable,
			...account.reason === void 0 ? {} : { reason: account.reason },
			...account.quota === void 0 ? {} : { quota: account.quota },
			...account.quotaFetchedAtMs === void 0 ? {} : { quotaFetchedAtMs: account.quotaFetchedAtMs },
			windowTokens: folded.window,
			todayTokens: folded.today,
			windowCalls: folded.calls
		};
	});
	const days = dailySeries(rows, fromDay, today);
	const backendOrder = [];
	const backendTotals = /* @__PURE__ */ new Map();
	for (const row of accountRows) {
		let total = backendTotals.get(row.backendId);
		if (total === void 0) {
			total = {
				backendId: row.backendId,
				backendName: row.backendName,
				windowTokens: zeroBuckets(),
				windowCalls: 0,
				share: 0
			};
			backendTotals.set(row.backendId, total);
			backendOrder.push(row.backendId);
		}
		addInto(total.windowTokens, row.windowTokens);
		total.windowCalls += row.windowCalls;
	}
	const windowTotals = zeroBuckets();
	let windowCalls = 0;
	const todayTotals = zeroBuckets();
	for (const day of days) addInto(windowTotals, day.tokens);
	for (const day of days) if (day.day === today) addInto(todayTotals, day.tokens);
	for (const row of accountRows) windowCalls += row.windowCalls;
	const grandTotal = totalTokens(windowTotals);
	return {
		fromDay,
		toDay: today,
		accounts: accountRows,
		days,
		backends: backendOrder.map((id) => {
			const total = backendTotals.get(id);
			return {
				...total,
				share: grandTotal > 0 ? totalTokens(total.windowTokens) / grandTotal : 0
			};
		}),
		windowTotals,
		windowCalls,
		todayTotals,
		anyQuota: accountRows.some((row) => row.quota !== void 0 && row.quota.kind !== "unavailable"),
		hasHistory: rows.length > 0
	};
}
//#endregion
//#region src/usage/service.ts
/**
* Attach a staleness notice to a reading without losing its figure.
*
* Only the balance arm can carry the note: it is the only reading whose value
* survives as a plain number the page renders beside the warning. A packages
* reading is left untouched — its bars are already labelled with their own
* fetch time — and the other two arms carry no figure to keep.
*
* @param reading - the last good reading.
* @param reason - why the latest refresh failed.
* @returns the reading, annotated when it can be.
*/
function withStaleNote(reading, reason) {
	if (reading.kind !== "balance") return reading;
	return {
		...reading,
		staleReason: reason
	};
}
/**
* Decide what to report for one account from its cached state.
*
* Three cases, and the distinction matters to the page:
*
*  - nothing cached yet: report nothing, so the row says "not read yet"
*    rather than "zero";
*  - only a failure ever: report the error, because there is no figure to show
*    and pretending otherwise would render an empty balance;
*  - a good reading, with or without an outstanding failure: report the
*    FIGURE, annotated with the failure when there is one. Losing the number
*    to a transient error is the behaviour that makes a dashboard useless.
*
* @param cached - this account's cached state.
* @returns the reading to publish, or undefined to publish none.
*/
function effectiveReading(cached) {
	if (cached?.lastGood === void 0) {
		if (cached?.lastError === void 0) return void 0;
		return {
			reading: {
				kind: "error",
				message: cached.lastError.message
			},
			fetchedAtMs: cached.lastError.failedAtMs
		};
	}
	if (cached.lastError === void 0) return {
		reading: cached.lastGood.reading,
		fetchedAtMs: cached.lastGood.fetchedAtMs
	};
	return {
		reading: withStaleNote(cached.lastGood.reading, cached.lastError.message),
		fetchedAtMs: cached.lastGood.fetchedAtMs
	};
}
var UsageService = class {
	options;
	/** Last good quota per `backendId\u0000accountId`, for the refresh path. */
	quotaCache = /* @__PURE__ */ new Map();
	/** The dashboard window, in days. */
	windowDays = 30;
	constructor(options) {
		this.options = options;
	}
	/**
	* The in-process key authorizing writes on this service's routes.
	*
	* Exposed rather than kept private because the route must compare the
	* presented header against the SAME key the document handed the browser. If
	* the route minted its own, every write would 403 while the page showed a
	* correctly-rendered dashboard — a failure mode that looks like a UI bug.
	*/
	actionKey() {
		return this.options.actionKey();
	}
	/** The current window size in days. */
	currentWindowDays() {
		return this.windowDays;
	}
	/**
	* Set the window, clamped to a sane range.
	*
	* The clamp is not cosmetic: the document materialises one point per day, and
	* an unclamped value from a crafted request would allocate an array of
	* millions and hang the host. One year is the useful maximum.
	*/
	setWindowDays(days) {
		if (!Number.isFinite(days)) return;
		this.windowDays = Math.min(3650, Math.max(1, Math.floor(days)));
	}
	/**
	* Build the dashboard document.
	*
	* Reads cached quota rather than fetching, so a page load never blocks on a
	* slow vendor endpoint. {@link refreshQuotas} is the explicit way to fetch.
	*
	* @param nowMs - the moment to build for; injected for tests.
	* @returns the document the browser renders.
	*/
	async document(nowMs = Date.now()) {
		const inputs = [];
		for (const backend of this.options.backends()) {
			const availability = await backend.current();
			if (availability.state !== "ready") continue;
			for (const account of availability.accounts) {
				const effective = effectiveReading(this.quotaCache.get(`${backend.descriptor.id}\u0000${account.id}`));
				inputs.push({
					backendId: backend.descriptor.id,
					backendName: backend.descriptor.displayName,
					authKind: backend.descriptor.authKind,
					accountId: account.id,
					accountLabel: account.label,
					...account.detail === void 0 ? {} : { accountDetail: account.detail },
					usable: account.usable,
					...account.reason === void 0 ? {} : { reason: account.reason },
					...effective === void 0 ? {} : {
						quota: effective.reading,
						quotaFetchedAtMs: effective.fetchedAtMs
					}
				});
			}
		}
		const summary = buildUsageSummary(inputs, this.options.ledger.all(), {
			windowDays: this.windowDays,
			nowMs
		});
		const failures = this.options.failures?.() ?? [];
		return {
			fromDay: summary.fromDay,
			toDay: summary.toDay,
			accounts: summary.accounts.map((account) => ({
				backendId: account.backendId,
				backendName: account.backendName,
				authKind: account.authKind,
				accountId: account.accountId,
				accountLabel: account.accountLabel,
				...account.accountDetail === void 0 ? {} : { accountDetail: account.accountDetail },
				usable: account.usable,
				...account.reason === void 0 ? {} : { reason: account.reason },
				...account.quota === void 0 ? {} : { quota: account.quota },
				...account.quotaFetchedAtMs === void 0 ? {} : { quotaFetchedAtMs: account.quotaFetchedAtMs },
				windowTokens: account.windowTokens,
				todayTokens: account.todayTokens,
				windowCalls: account.windowCalls
			})),
			days: summary.days.map((day) => ({
				day: day.day,
				tokens: day.tokens,
				calls: day.calls
			})),
			backends: summary.backends.map((total) => ({
				backendId: total.backendId,
				backendName: total.backendName,
				windowTokens: total.windowTokens,
				windowCalls: total.windowCalls,
				share: total.share
			})),
			windowTotals: summary.windowTotals,
			windowCalls: summary.windowCalls,
			todayTotals: summary.todayTotals,
			anyQuota: summary.anyQuota,
			hasHistory: summary.hasHistory,
			...failures.length === 0 ? {} : { failures },
			actionKey: this.options.actionKey(),
			windowDays: this.windowDays
		};
	}
	/**
	* Re-read every ready account's balance.
	*
	* Sequential rather than concurrent on purpose: these are different vendors'
	* endpoints, several are rate-limited, and a burst of simultaneous requests
	* from one user action is the pattern that gets a client throttled. The page
	* waits for one refresh, not for nine parallel ones.
	*
	* A failure for one account leaves its previous reading in place — a transient
	* network error must not blank a balance that was correct a minute ago.
	*
	* @returns how many accounts were read successfully.
	*/
	async refreshQuotas() {
		let succeeded = 0;
		for (const backend of this.options.backends()) {
			const availability = await backend.current();
			if (availability.state !== "ready") continue;
			for (const account of availability.accounts) {
				const key = `${backend.descriptor.id}\u0000${account.id}`;
				const now = Date.now();
				const reading = await backend.readQuota(account.id);
				const entry = this.quotaCache.get(key) ?? {};
				if (reading.kind === "error") {
					entry.lastError = {
						message: reading.message,
						failedAtMs: now
					};
					this.quotaCache.set(key, entry);
					continue;
				}
				entry.lastGood = {
					reading,
					fetchedAtMs: now
				};
				delete entry.lastError;
				this.quotaCache.set(key, entry);
				succeeded += 1;
			}
		}
		return succeeded;
	}
	/** Drop the locally metered history. */
	async clearLedger() {
		await this.options.ledger.clear();
	}
	/** Seed the cache from a reading taken elsewhere, for tests and warm starts. */
	seedQuota(backendId, accountId, reading, fetchedAtMs = Date.now()) {
		this.quotaCache.set(`${backendId}\u0000${accountId}`, { lastGood: {
			reading,
			fetchedAtMs
		} });
	}
};
//#endregion
//#region src/usage-paths.ts
/**
* The usage dashboard's wire contract, shared by the host and the browser half.
*
* Lives beside `status-paths.ts` and for the same reason: the two halves are
* built independently, so a route named in one place and spelled differently in
* the other fails only at runtime, in a browser, for the user. Both halves
* import these literals instead.
*
* The types here are structurally identical to `usage/summary.ts` on purpose
* rather than imported from it. That module is host-side and pulls in the
* filesystem through the ledger; this one must stay free of Node built-ins so
* the browser bundle can include it. The duplication is one direction only —
* the host builds a document that satisfies THIS shape — and is checked by the
* host-side type test rather than by a shared import that would drag Node into
* the browser.
*
* @module dsh-workbuddy-connect/usage-paths
*/
/** Same-origin route serving the usage dashboard document. */
const WORKBUDDY_USAGE_PATH = "/plugins/dsh-workbuddy-connect/usage";
/**
* Same-origin route accepting usage-dashboard writes.
*
* Separate from the read route for the reason the probe route is separate from
* the status route: `POST` here mutates state (refreshing quotas, clearing the
* ledger), and a state-changing action must not be reachable by the same
* unauthenticated GET a page can be tricked into issuing.
*/
const WORKBUDDY_USAGE_ACTION_PATH = "/plugins/dsh-workbuddy-connect/usage/action";
/** Window sizes the UI offers. */
const USAGE_WINDOW_CHOICES = [
	7,
	30,
	90,
	365
];
//#endregion
//#region src/usage-route.ts
/**
* The usage dashboard's host routes: one read, one write.
*
* Security follows the plugin's existing control-route pattern exactly, for the
* same reasons documented in `probe-route.ts`:
*
*  1. The GET is protected by the loopback Host/Origin guard, which stops a
*     DNS-rebinding page from reading the user's usage history.
*  2. The POST adds the in-process key, because loopback alone is not
*     authentication — any local process can forge `Host: 127.0.0.1`, and this
*     route can spend the user's credit by refreshing quotas against nine
*     different vendors. A caller that cannot present the key does not get to
*     trigger that.
*
* The read route never accepts parameters that reach the filesystem or the
* network: the window comes from the service's own state, not from the query
* string, so a crafted URL cannot make the host allocate a million-point chart
* or read an arbitrary path.
*
* @module dsh-workbuddy-connect/usage-route
*/
/** Largest control body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES$1 = 4096;
/** Mint the per-process action key. */
function createUsageKey() {
	return randomBytes(24).toString("hex");
}
/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches$1(expected, presented) {
	if (presented === void 0 || presented.length !== expected.length) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && timingSafeEqual(a, b);
}
function json$1(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Read the request body with a hard ceiling. */
async function readBody$1(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES$1) return void 0;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Whether this request may reach the read route at all. */
function readable$1(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
/** Parse and shape-check a write request; unknown fields are ignored. */
function parseUsageAction(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	const action = wrapped["action"];
	if (action === "refresh-quotas") return { action };
	if (action === "clear-ledger") return { action };
	if (action === "set-window") {
		const windowDays = wrapped["windowDays"];
		if (typeof windowDays !== "number" || !Number.isFinite(windowDays)) return void 0;
		return {
			action,
			windowDays
		};
	}
}
/**
* The read handler, exposed for tests.
*
* @param service - the usage service.
* @param res - the response to write.
*/
async function usageDocumentHandler(service, res) {
	try {
		json$1(res, 200, await service.document());
	} catch (error) {
		json$1(res, 500, { message: error instanceof Error ? error.message : String(error) });
	}
}
/**
* Mount both usage routes on the host's web server.
*
* Follows the plugin's existing route convention exactly, because deviating
* from it fails SILENTLY: routes are registered through
* `ctx.webServer.register({ kind, path, handler })`, and the handler owns the
* method check. The first version of this function instead reached for
* `webServer.get()` / `webServer.post()` — methods that do not exist on that
* service — so every call was an optional call on undefined, no route was ever
* mounted, and the browser's fetch came back 404 while the build, the types,
* and the tests all stayed green. Nothing but a real request could reveal it.
*
* Registration is wrapped in `ctx.effect` so the disposer runs when the fiber
* unwinds. The caller must already have injected `webServer`, which is what
* makes `ctx.webServer` resolvable here.
*
* @param ctx - a context that has injected the webServer service.
* @param options - the service getter and optional path overrides.
*/
function registerUsageRoute(ctx, options) {
	const readPath = options.path ?? "/plugins/dsh-workbuddy-connect/usage";
	const writePath = options.actionPath ?? "/plugins/dsh-workbuddy-connect/usage/action";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: readPath,
			handler: usageDocumentRoute(options)
		});
		return () => {
			dispose();
		};
	}, "dsh-multibuddy-connect: usage document route");
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: writePath,
			handler: usageActionRoute(options)
		});
		return () => {
			dispose();
		};
	}, "dsh-multibuddy-connect: usage action route");
}
/**
* The read route's handler.
*
* Owns the method check because the web server dispatches by PATH alone — a
* POST to this path must be refused here rather than by the router.
*
* @param options - the service getter.
* @returns the node request handler.
*/
function usageDocumentRoute(options) {
	return (req, res) => {
		(async () => {
			if (req.method !== "GET") {
				json$1(res, 405, { message: "method not allowed" });
				return;
			}
			if (!readable$1(req)) {
				json$1(res, 403, { message: "forbidden" });
				return;
			}
			const service = options.service();
			if (service === void 0) {
				json$1(res, 503, { message: "usage service is still starting" });
				return;
			}
			await usageDocumentHandler(service, res);
		})();
	};
}
/**
* The write route's handler.
*
* Two guards besides the method check, because a state-changing route must not
* be reachable by the same unauthenticated GET a page can be tricked into
* issuing: the loopback Host/Origin pair, then the in-process key the document
* handed the browser.
*
* @param options - the service getter.
* @returns the node request handler.
*/
function usageActionRoute(options) {
	return (req, res) => {
		(async () => {
			if (req.method !== "POST") {
				json$1(res, 405, { message: "method not allowed" });
				return;
			}
			if (!readable$1(req)) {
				json$1(res, 403, { message: "forbidden" });
				return;
			}
			const service = options.service();
			if (service === void 0) {
				json$1(res, 503, { message: "usage service is still starting" });
				return;
			}
			const presented = req.headers["x-workbuddy-key"];
			if (!keyMatches$1(service.actionKey(), Array.isArray(presented) ? presented[0] : presented)) {
				json$1(res, 403, { message: "forbidden" });
				return;
			}
			const body = await readBody$1(req);
			if (body === void 0) {
				json$1(res, 413, { message: "payload too large" });
				return;
			}
			const action = parseUsageAction(body);
			if (action === void 0) {
				json$1(res, 400, { message: "unknown action" });
				return;
			}
			let result;
			try {
				if (action.action === "refresh-quotas") result = {
					ok: true,
					message: `已刷新 ${await service.refreshQuotas()} 个账号的额度`
				};
				else if (action.action === "clear-ledger") {
					await service.clearLedger();
					result = {
						ok: true,
						message: "已清空本地用量记录"
					};
				} else {
					service.setWindowDays(action.windowDays ?? 30);
					result = { ok: true };
				}
			} catch (error) {
				result = {
					ok: false,
					message: error instanceof Error ? error.message : String(error)
				};
			}
			json$1(res, result.ok ? 200 : 500, result);
		})();
	};
}
//#endregion
//#region src/backends/route.ts
/**
* The backend configuration routes: one read, one write.
*
* These back the multi-backend settings card. The read route answers what every
* merged backend is, whether it can be configured here, and what accounts it
* currently has; the write route adds or removes an account.
*
* Security follows the plugin's existing control-route pattern exactly, for the
* reasons documented in probe-route.ts: the GET is protected by the loopback
* Host/Origin guard, and the POST additionally requires the in-process key,
* because loopback alone is not authentication — any local process can forge
* Host: 127.0.0.1, and this route writes credential material.
*
* SECRETS ARE WRITE-ONLY ACROSS THIS BOUNDARY. The document carries a MASKED
* form of every stored secret so a user can tell which key is which, and never
* the value itself. The only time a secret travels is when the browser sends a
* new one to store.
*
* @module dsh-multibuddy-connect/backends/route
*/
/** Largest control body accepted; these payloads carry one key at most. */
const MAX_BODY_BYTES = 8192;
/** Mint the per-process action key. */
function createBackendsKey() {
	return randomBytes(24).toString("hex");
}
/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches(expected, presented) {
	if (presented === void 0 || presented.length !== expected.length) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && timingSafeEqual(a, b);
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Whether this request may reach the routes at all. */
function readable(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
/** Read the request body with a hard ceiling. */
async function readBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/**
* Whether this plugin can WRITE accounts for a backend.
*
* True only for api-key backends, where the credential is the plugin's own.
* A desktop-adoption backend reads another application's single login slot and
* a managed-runtime backend has no account at all, so offering a write control
* for either would be a button with nothing behind it.
*
* @param authKind - the backend's credential model.
* @returns true when account management is meaningful.
*/
function isConfigurable(authKind) {
	return authKind === "api-key";
}
/**
* Derive a stable account id from its display label.
*
* The label is the natural key: the card shows labels and nothing else, so
* "add an account called Work" twice reads as an update rather than as a
* duplicate the user never asked for. Non-Latin labels are kept as-is rather
* than transliterated — the id only ever appears in JSON and in a log line.
*
* @param label - the user-supplied display label.
* @returns a stable, non-empty id.
*/
function accountIdFromLabel(label) {
	const slug = label.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, "-").replace(/^-+|-+$/gu, "");
	return slug === "" ? "default" : slug;
}
/**
* Build the configuration document.
*
* @param options - the live backend set and registry.
* @returns the document the card renders.
*/
async function buildBackendsDocument(options) {
	const registry = options.registry();
	const entries = [];
	for (const backend of options.backends()) {
		const descriptor = backend.descriptor;
		const configurable = isConfigurable(descriptor.authKind);
		const availability = await backend.current();
		const accounts = availability.state === "ready" ? availability.accounts.map((account) => ({
			id: account.id,
			label: account.label,
			...account.detail === void 0 ? {} : { detail: account.detail },
			usable: account.usable,
			...account.reason === void 0 ? {} : { reason: account.reason }
		})) : [];
		let stored = [];
		if (configurable) stored = (await registry.list(descriptor.id)).map((row) => ({
			id: row.id,
			label: row.label,
			secretMasked: maskSecret(typeof row.secret === "string" ? row.secret : ""),
			updatedAtMs: row.updatedAtMs
		}));
		entries.push({
			id: descriptor.id,
			displayName: descriptor.displayName,
			...descriptor.description === void 0 ? {} : { description: descriptor.description },
			...descriptor.brand?.vendor === void 0 ? {} : { vendor: descriptor.brand.vendor },
			authKind: descriptor.authKind,
			multiAccount: descriptor.multiAccount,
			reportsQuota: descriptor.reportsQuota,
			configurable,
			state: availability.state,
			...availability.state === "unavailable" && availability.hint !== void 0 ? { hint: availability.hint } : {},
			...availability.state === "failed" ? { message: availability.message } : {},
			accounts,
			stored,
			...descriptor.envHint === void 0 ? {} : { envHint: descriptor.envHint }
		});
	}
	const failures = (options.failures?.() ?? []).map((failure) => ({
		id: failure.id,
		message: failure.message
	}));
	return {
		backends: entries,
		...failures.length === 0 ? {} : { failures },
		actionKey: options.actionKey()
	};
}
/** Parse and shape-check a write request; unknown fields are ignored. */
function parseBackendsAction(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	const action = wrapped["action"];
	const string = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
	if (action === "refresh") return { action };
	if (action === "remove-account") {
		const backendId = string(wrapped["backendId"]);
		const accountId = string(wrapped["accountId"]);
		if (backendId === void 0 || accountId === void 0) return void 0;
		return {
			action,
			backendId,
			accountId
		};
	}
	if (action === "add-account") {
		const backendId = string(wrapped["backendId"]);
		const secret = typeof wrapped["secret"] === "string" ? wrapped["secret"].trim() : "";
		if (backendId === void 0 || secret === "") return void 0;
		const label = string(wrapped["label"]);
		const accountId = string(wrapped["accountId"]);
		return {
			action,
			backendId,
			secret,
			...label === void 0 ? {} : { label },
			...accountId === void 0 ? {} : { accountId }
		};
	}
}
/**
* Apply one write.
*
* Kept as a named export so it can be tested without an HTTP round trip.
*
* @param options - the live backend set and registry.
* @param action - the validated action.
* @returns the result the card shows.
*/
async function applyBackendsAction(options, action) {
	if (action.action === "refresh") {
		await options.reload?.();
		return {
			ok: true,
			message: "已重新检测各后端账号"
		};
	}
	const backendId = action.backendId ?? "";
	const backend = options.backends().find((candidate) => candidate.descriptor.id === backendId);
	if (backend === void 0) return {
		ok: false,
		message: "未找到后端 " + backendId
	};
	if (!isConfigurable(backend.descriptor.authKind)) return {
		ok: false,
		message: backend.descriptor.displayName + " 的凭据来自其它应用，本插件不代为配置"
	};
	const registry = options.registry();
	try {
		if (action.action === "remove-account") {
			await registry.remove(backendId, action.accountId ?? "");
			registry.invalidate(backendId);
			await options.reload?.();
			return {
				ok: true,
				message: "已删除账号"
			};
		}
		const label = action.label ?? backend.descriptor.displayName;
		const id = action.accountId ?? accountIdFromLabel(label);
		const secret = action.secret ?? "";
		if (secret === "") return {
			ok: false,
			message: "密钥不能为空"
		};
		await registry.put(backendId, {
			id,
			label,
			secret,
			updatedAtMs: Date.now()
		});
		registry.invalidate(backendId);
		await options.reload?.();
		return {
			ok: true,
			message: "已保存账号 " + label
		};
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error)
		};
	}
}
/**
* The read route's handler.
*
* @param options - the live backend set and registry.
* @returns the node request handler.
*/
function backendsDocumentRoute(options) {
	return (req, res) => {
		(async () => {
			if (req.method !== "GET") {
				json(res, 405, { message: "method not allowed" });
				return;
			}
			if (!readable(req)) {
				json(res, 403, { message: "forbidden" });
				return;
			}
			try {
				json(res, 200, await buildBackendsDocument(options));
			} catch (error) {
				json(res, 500, { message: error instanceof Error ? error.message : String(error) });
			}
		})();
	};
}
/**
* The write route's handler.
*
* @param options - the live backend set and registry.
* @returns the node request handler.
*/
function backendsActionRoute(options) {
	return (req, res) => {
		(async () => {
			if (req.method !== "POST") {
				json(res, 405, { message: "method not allowed" });
				return;
			}
			if (!readable(req)) {
				json(res, 403, { message: "forbidden" });
				return;
			}
			const presented = req.headers["x-workbuddy-key"];
			if (!keyMatches(options.actionKey(), Array.isArray(presented) ? presented[0] : presented)) {
				json(res, 403, { message: "forbidden" });
				return;
			}
			const body = await readBody(req);
			if (body === void 0) {
				json(res, 413, { message: "payload too large" });
				return;
			}
			const action = parseBackendsAction(body);
			if (action === void 0) {
				json(res, 400, { message: "unknown action" });
				return;
			}
			const result = await applyBackendsAction(options, action);
			json(res, result.ok ? 200 : 400, result);
		})();
	};
}
/**
* Mount both configuration routes on the host's web server.
*
* Registration goes through ctx.webServer.register and is wrapped in
* ctx.effect, matching every other route in this plugin — reaching for
* non-existent helper methods on that service is a mistake this plugin has
* already made once, and the failure mode is a silent 404 with green tests.
*
* @param ctx - a context that has injected the webServer service.
* @param options - the live backend set and registry.
*/
function registerBackendsRoute(ctx, options) {
	const readPath = options.path ?? "/plugins/dsh-workbuddy-connect/backends";
	const writePath = options.actionPath ?? "/plugins/dsh-workbuddy-connect/backends/action";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: readPath,
			handler: backendsDocumentRoute(options)
		});
		return () => {
			dispose();
		};
	}, "dsh-multibuddy-connect: backend configuration route");
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: writePath,
			handler: backendsActionRoute(options)
		});
		return () => {
			dispose();
		};
	}, "dsh-multibuddy-connect: backend action route");
}
//#endregion
//#region src/backends/openai-compat.ts
/**
* A reusable transport for the merged backends whose upstream speaks the
* OpenAI chat-completions protocol.
*
* WHY ONE MODULE. Cline, CodeBuddy and OpenCode differ only in where their base
* URL, bearer key and model roster come from — the wire protocol, the streaming
* translation, and the harness seam are identical. Writing that three times
* would mean three places to fix when the pi-ai profile grows a required field
* (it gained 'modelErrors' in 0.1.5-alpha.2, and the WorkBuddy adapter carries a
* note about exactly that cost).
*
* WHAT IT DOES NOT DO. It never decides WHERE credentials come from: the caller
* passes a resolveApiKey that reads the registry, the environment, or another
* application's login state. That keeps the per-vendor credential rules in the
* backend that owns them, which is the whole point of the backend split.
*
* The key is resolved PER REQUEST, so pi-ai never stores it and an ambient
* credential lifecycle can never manufacture one. That is why this module uses
* the inert auth plane rather than pi-ai's own credential store.
*
* @module dsh-multibuddy-connect/backends/openai-compat
*/
/**
* Image-request budgets, matching dsh-llm-pi-ai's own defaults.
*
* These bound requests to models whose catalog entry declares image support;
* text-only models never receive an image, so the budget is a ceiling rather
* than a reservation.
*/
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Inert pi-ai auth plane.
*
* The route authenticates only through resolveApiKey, so pi-ai's own credential
* lifecycle and ambient discovery must never manufacture one; every question
* here answers 'nothing stored, nothing set'.
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-multibuddy-connect: the merged backend routes have no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/** Map declared effort ids onto pi-ai's thinking-level vocabulary. */
function reasoningFields(model) {
	const efforts = model.efforts ?? [];
	if (efforts.length === 0) return { reasoning: false };
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: efforts.includes("off") ? "off" : null,
			minimal: null,
			low: efforts.includes("low") ? "low" : null,
			medium: efforts.includes("medium") ? "medium" : null,
			high: efforts.includes("high") ? "high" : null,
			xhigh: efforts.includes("xhigh") ? "xhigh" : null,
			max: efforts.includes("max") ? "max" : null
		}
	};
}
/**
* Build one pi-ai model descriptor.
*
* @param info - the backend's neutral model description.
* @param baseUrl - the vendor endpoint this request should reach.
* @param providerId - the route this model belongs to.
* @param displayName - the name the picker shows.
*/
function toPiModel(info, baseUrl, providerId, displayName) {
	return {
		id: info.id,
		name: displayName,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: info.supportsImages === true ? ["text", "image"] : ["text"],
		...reasoningFields(info),
		cost: NO_COST,
		...info.contextWindow === void 0 ? {} : { contextWindow: info.contextWindow },
		...info.maxTokens === void 0 ? {} : { maxTokens: info.maxTokens },
		compat: { maxTokensField: "max_tokens" }
	};
}
/**
* Assemble a route.
*
* The profile is constructed by hand rather than through dsh-llm-pi-ai's
* internal resolveProfiles(): that helper is not part of the package's public
* export surface, so hand-assembly is the only supported path — and every newly
* required field must be adopted here explicitly.
*
* @param options - the caller-supplied vendor facts.
* @returns the adapter plus its invalidation signal.
*/
function createOpenAiCompatRoute(options) {
	const { providerId, displayName } = options;
	const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 3e5;
	const buildModels = () => {
		const baseUrl = options.baseUrl();
		return options.models().map((info) => toPiModel(info, baseUrl, providerId, options.displayNameFor?.(info) ?? info.name));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: displayName,
			auth: { apiKey: {
				name: displayName + " bearer key",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: displayName
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName,
		streamIdleTimeoutMs,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-multibuddy-connect " + providerId + " retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		adapter: new PiAiAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => options.resolveApiKey(),
			...options.resolveAttachments === void 0 ? {} : { resolveAttachments: options.resolveAttachments }
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
//#endregion
//#region src/checkin.ts
/**
* WorkBuddy daily check-in service.
*
* Implements daily check-in against WorkBuddy endpoints (CN and International/Global):
* - CN: https://www.workbuddy.cn/v2/billing/meter/daily-checkin
* - Global: https://www.workbuddy.ai/v2/billing/meter/daily-checkin
*
* Headers and protocol:
* - Common headers: Content-Type, Accept, Authorization: Bearer <token>
* - Global headers: X-Domain: www.workbuddy.ai, X-No-Enterprise-Id: 1, Accept-Language: en-US
* - CN headers: X-Domain, enterprise headers if present, Accept-Language: zh-CN
* - Device fingerprint: X-Machine-ID, X-Session-ID derived from UID
* - Gateway headers: X-CodeBuddy-Request: 1
*
* Handles already-claimed detection (HTTP 400 with code 10001 or message containing "已签到"/"今天已签到"),
* successful claim (code 0 or 200, extracting credit amount).
*
* @module dsh-workbuddy-connect/checkin
*/
const DEFAULT_TIMEOUT_MS = 15e3;
const CN_CHECKIN_URL = "https://www.workbuddy.cn/v2/billing/meter/daily-checkin";
const GLOBAL_CHECKIN_URL = "https://www.workbuddy.ai/v2/billing/meter/daily-checkin";
const GLOBAL_DOMAIN = "www.workbuddy.ai";
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
/** One stable 36-hex identifier for an account and purpose. */
function deriveAccountStableId(uid, purpose) {
	return createHash("sha256").update(`wb2a:${purpose}:${uid}`).digest("hex").slice(0, 36);
}
/** Returns device headers if UID is present. */
function accountDeviceHeaders(uid) {
	if (!uid || uid.trim() === "") return {};
	return {
		"X-Machine-ID": deriveAccountStableId(uid, "machine"),
		"X-Session-ID": deriveAccountStableId(uid, "session")
	};
}
/** Returns the current date in YYYY-MM-DD standardized on UTC+8 (Beijing Time). */
function getUtc8DateString(nowMs = Date.now()) {
	const d = new Date(nowMs);
	const utc8 = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 6e4);
	return `${utc8.getFullYear()}-${String(utc8.getMonth() + 1).padStart(2, "0")}-${String(utc8.getDate()).padStart(2, "0")}`;
}
var WorkBuddyCheckInService = class {
	fetchImpl;
	timeoutMs;
	constructor(options = {}) {
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}
	/**
	* Execute daily check-in for a credential.
	*/
	async checkIn(variantId, credential, signal) {
		const nowMs = Date.now();
		const today = getUtc8DateString(nowMs);
		if (!credential || !credential.accessToken || credential.accessToken.trim() === "") return {
			variantId,
			date: today,
			timestamp: nowMs,
			status: "error",
			message: "No access token available"
		};
		const isGlobal = realmOf(credential) === "global" || variantId.includes("ai");
		const checkInUrl = isGlobal ? GLOBAL_CHECKIN_URL : CN_CHECKIN_URL;
		const origin = isGlobal ? "https://www.workbuddy.ai" : "https://www.workbuddy.cn";
		const headers = {
			"Authorization": `Bearer ${credential.accessToken}`,
			"Content-Type": "application/json",
			"Accept": "application/json, text/plain, */*",
			"Origin": origin,
			"Referer": `${origin}/profile/growth-center`,
			"User-Agent": CLIENT_UA,
			"X-CodeBuddy-Request": "1",
			"Accept-Language": isGlobal ? "en-US" : "zh-CN",
			...accountDeviceHeaders(credential.uid)
		};
		if (credential.uid && credential.uid.trim() !== "") headers["X-User-Id"] = credential.uid;
		if (isGlobal) {
			headers["X-Domain"] = GLOBAL_DOMAIN;
			headers["X-No-Enterprise-Id"] = "1";
		} else {
			if (credential.enterpriseId && credential.enterpriseId.trim() !== "") {
				headers["X-Enterprise-Id"] = credential.enterpriseId;
				headers["X-Tenant-Id"] = credential.enterpriseId;
			} else headers["X-No-Enterprise-Id"] = "1";
			if (credential.domain && credential.domain.trim() !== "") headers["X-Domain"] = credential.domain;
		}
		const combinedSignal = signal ?? AbortSignal.timeout(this.timeoutMs);
		try {
			const response = await this.fetchImpl(checkInUrl, {
				method: "POST",
				headers,
				body: JSON.stringify({}),
				signal: combinedSignal
			});
			let bodyText = "";
			try {
				bodyText = await response.text();
			} catch {}
			let data;
			try {
				data = JSON.parse(bodyText);
			} catch {
				data = void 0;
			}
			const code = typeof data?.code === "number" ? data.code : void 0;
			const msg = typeof data?.msg === "string" ? data.msg : typeof data?.message === "string" ? data.message : "";
			if (code === 10001 || msg.includes("今天已签到") || msg.includes("已签到") || msg.toLowerCase().includes("already")) return {
				variantId,
				date: today,
				timestamp: nowMs,
				status: "already-claimed",
				message: msg || "Already checked in today"
			};
			if (data?.data?.active === false || msg.includes("活动未开启") || msg.includes("已过期") || msg.toLowerCase().includes("not active")) return {
				variantId,
				date: today,
				timestamp: nowMs,
				status: "no-campaign",
				message: msg || "Check-in campaign not active"
			};
			if (response.ok && (code === 0 || code === 200 || code === void 0)) {
				const amountCandidate = data?.data?.credit ?? data?.data?.amount ?? data?.data?.points ?? data?.credit ?? data?.amount ?? data?.points;
				const amount = typeof amountCandidate === "number" && Number.isFinite(amountCandidate) ? amountCandidate : void 0;
				return {
					variantId,
					date: today,
					timestamp: nowMs,
					status: "claimed",
					amount,
					message: msg || (amount ? `Claimed ${amount} credits` : "Check-in successful")
				};
			}
			return {
				variantId,
				date: today,
				timestamp: nowMs,
				status: "error",
				message: msg || `HTTP ${response.status}: ${bodyText.slice(0, 100)}`
			};
		} catch (error) {
			return {
				variantId,
				date: today,
				timestamp: nowMs,
				status: "error",
				message: error instanceof Error ? error.message : String(error)
			};
		}
	}
};
//#endregion
//#region src/settings-store.ts
/**
* Plugin-owned settings store — the single source of truth for this plugin's
* user configuration on every host line.
*
* WHY THIS EXISTS
*
* A settings write on DSH 0.1.7 goes through the profile patch
* (`configEditor.edit`), which reconciles the whole loader tree and hot-reloads
* the plugin's fiber (~1–1.5 s, plus a storm of client mirror refreshes) on
* EVERY write — one per toggled switch. The plugin's own files (the credential,
* the catalog cache) have always lived in `<profile>/.dsh-workbuddy-connect/`,
* so the settings move there too: a write becomes a small atomic local file
* write with an in-memory apply, no tree reconcile, no reload.
*
* FILE
*   <plugin data dir>/settings.json   (same directory as the credential)
*
* The data directory is resolved by `workbuddyPluginDataDir()` — the ONE
* discovery implementation this plugin already has. It is deliberately not
* re-implemented here: a second copy of that logic is how a nested
* `.dsh-workbuddy-connect/.dsh-workbuddy-connect/` path gets shipped.
*
* MIGRATION (one time)
*   the file is absent → seed it from the entry config's own fields → write the
*   file → delete ONLY this plugin's fields from the entry config (see
*   ./index.ts), so the profile row returns to its shipped state.
*
* @module dsh-workbuddy-connect/settings-store
*/
/** Settings file name inside the plugin data directory. */
const SETTINGS_FILE_NAME = "settings.json";
/**
* Reserved bookkeeping key: how many writes the settings card has made through
* this store. Its presence separates "the file holds the startup seed" from
* "the file holds the user's live edits" — see the seed rule in ./index.ts.
* Field readers address their fields by name and never collide with it.
*/
const WRITE_MARK = "__writes";
/** This plugin's data directory (shared with the credential and caches). */
function dataDir() {
	return workbuddyPluginDataDir();
}
/** Absolute path of the settings file. */
function settingsFilePath() {
	return join(dataDir(), SETTINGS_FILE_NAME);
}
/** Read + parse the settings file; `undefined` when absent or unreadable. */
function readFile$1() {
	const path = settingsFilePath();
	if (!existsSync(path)) return void 0;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
/** Write the settings file atomically (tmp + rename), creating the directory. */
function writeSettings(values) {
	const path = settingsFilePath();
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}
/**
* One store instance: the plugin's own settings file, with the entry config as
* the fallback layer the caller overlays it on.
*/
var SettingsStore = class {
	/** The user layer exactly as stored (presence marks an override). */
	user;
	constructor() {
		this.user = readFile$1() ?? {};
	}
	/** Whether the store file exists. */
	exists() {
		return existsSync(settingsFilePath());
	}
	/**
	* Whether the settings card has ever written through this store.
	*
	* While false the entry config stays authoritative; once the card writes,
	* the file is — a runtime edit must never be regressed by a stale profile
	* row.
	*/
	get edited() {
		return typeof this.user[WRITE_MARK] === "number" && this.user[WRITE_MARK] > 0;
	}
	/**
	* Apply one patch in memory and persist it.
	* @param patch - field → value; a `null` value clears the field.
	* @param fromCard - true when the settings card made this write; marks the
	*   file as holding live user edits from then on.
	* @returns the new user layer.
	*/
	patch(patch, fromCard = false) {
		const next = { ...this.user };
		for (const [field, value] of Object.entries(patch)) if (value === null) delete next[field];
		else next[field] = value;
		if (fromCard) next[WRITE_MARK] = (typeof next[WRITE_MARK] === "number" ? next[WRITE_MARK] : 0) + 1;
		writeSettings(next);
		for (const key of Object.keys(this.user)) delete this.user[key];
		Object.assign(this.user, next);
		return this.user;
	}
	/** The current user layer. */
	values() {
		return this.user;
	}
};
//#endregion
//#region src/checkin-scheduler.ts
/**
* Startup check-in orchestration for daily benefits (UTC+8).
*
* This fork runs check-in ON DSH STARTUP rather than on a wall-clock timer:
* - JsonFileCheckInStore persists checkin records and up to 30 history log rows to checkin-status.json
* - One sweep per process start claims today's benefit for every enabled variant
* - Already-claimed days are skipped, so restarts never double-claim
*
* @module dsh-workbuddy-connect/checkin-scheduler
*/
var JsonFileCheckInStore = class {
	filePath;
	constructor(filePath) {
		this.filePath = filePath ?? join(workbuddyPluginDataDir(), "checkin-status.json");
	}
	readAll() {
		try {
			if (!existsSync(this.filePath)) return {};
			const raw = readFileSync(this.filePath, "utf-8");
			return JSON.parse(raw);
		} catch {
			return {};
		}
	}
	read(variantId) {
		return this.readAll()[variantId];
	}
	clearLogs(variantId) {
		try {
			const all = this.readAll();
			if (all[variantId]) {
				all[variantId] = {
					...all[variantId],
					logs: []
				};
				mkdirSync(dirname(this.filePath), { recursive: true });
				writeFileSync(this.filePath, JSON.stringify(all, null, 2), "utf-8");
			}
		} catch {}
	}
	write(variantId, record) {
		try {
			const all = this.readAll();
			const existingLogs = all[variantId]?.logs ?? [];
			const newLog = {
				id: `${record.lastDate}-${record.lastAt}`,
				date: record.lastDate,
				timestamp: record.lastAt,
				status: record.status,
				...record.amount === void 0 ? {} : { amount: record.amount },
				...record.message === void 0 ? {} : { message: record.message }
			};
			const updatedLogs = [newLog, ...existingLogs.filter((l) => l.id !== newLog.id)].slice(0, 30);
			all[variantId] = {
				...record,
				logs: updatedLogs
			};
			mkdirSync(dirname(this.filePath), { recursive: true });
			writeFileSync(this.filePath, JSON.stringify(all, null, 2), "utf-8");
		} catch {}
	}
};
var CheckInScheduler = class {
	targets;
	isEnabled;
	store;
	onResult;
	now;
	inFlight = /* @__PURE__ */ new Set();
	disposed = false;
	constructor(options) {
		this.targets = options.targets;
		this.isEnabled = options.isEnabled;
		this.store = options.store ?? new JsonFileCheckInStore();
		this.onResult = options.onResult;
		this.now = options.now ?? Date.now;
	}
	/**
	* Claim today's benefit for every enabled variant. Called once per process
	* start (and again when the user flips a toggle on), never on a timer.
	*/
	start() {
		if (this.disposed) return;
		this.sweepAll();
	}
	/**
	* Re-run the startup sweep. Kept as a separate name because the settings card
	* calls it after a toggle so enabling check-in takes effect without a restart.
	*/
	catchUp() {
		if (this.disposed) return;
		this.sweepAll();
	}
	dispose() {
		this.disposed = true;
	}
	async sweepAll(only) {
		if (this.disposed) return;
		const nowMs = this.now();
		const today = getUtc8DateString(nowMs);
		for (const target of this.targets) {
			if (only !== void 0 && target.variantId !== only) continue;
			if (!this.isEnabled(target.variantId)) continue;
			if (this.inFlight.has(target.variantId)) continue;
			this.inFlight.add(target.variantId);
			try {
				await this.sweepOne(target, nowMs, today);
			} finally {
				this.inFlight.delete(target.variantId);
			}
		}
	}
	async sweepOne(target, nowMs, today) {
		const record = this.store.read(target.variantId);
		if (record?.lastDate === today && (record.status === "claimed" || record.status === "already-claimed")) return;
		let result;
		try {
			result = await target.checkIn();
		} catch {
			return;
		}
		try {
			if (result.status !== "error") {
				this.store.write(target.variantId, {
					lastDate: result.date,
					lastAt: result.timestamp,
					status: result.status,
					amount: result.amount,
					message: result.message
				});
				if (result.status === "claimed") target.onClaimed?.();
			}
			this.onResult?.(result);
		} catch {}
	}
};
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name. */
const name = "llm-workbuddy";
/** The model registry required before the provider can register. */
const inject = ["llm"];
/**
* Settings namespace owning the CN card's section.
*
* DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace is
* now a nominal string, validated by the type system where it is used rather
* than at runtime by a function call. The brand is compile-time only, so this
* stays the plain string it always was — every comparison, descriptor lookup,
* and `dsh` config file still sees `'workbuddy'`. It is cast once here so the
* public constant carries the seam's type without pulling the brand helper
* into this package (upstream DSH plugins, `dsh-llm-pi-ai` included, pass
* their namespaces as plain string literals).
*/
const WORKBUDDY_SETTINGS_NS = "workbuddy";
/**
* Settings namespace owning the international card's section.
*
* The international variant keeps its own namespace so its section (and the
* card reading it) stays separate from the domestic one. The host's
* per-namespace card dispatch (the 0.1.5 Plugins tab) is gone; both namespaces
* remain served on the plugin's own settings face as section identities.
*/
const WORKBUDDY_AI_SETTINGS_NS = "workbuddy-ai";
/**
* Settings namespace owning the shared quota-card section.
*
* One card above the two variant cards configures both sidebar quota widgets
* (CN and international) from a single place, so its toggles cannot live in
* either variant's section — they are per-variant fields on a cross-variant
* card.
*/
const WORKBUDDY_QUOTA_SETTINGS_NS = "workbuddy-quota";
/**
* Plugin-owned settings endpoint consumed by its browser half.
*
* GET answers the whole entry configuration as three layers (value/base/user)
* plus the write key; POST applies one patch. This is the plugin's own settings
* surface, replacing writes through the host's settings service — see
* {@link ./settings-store.ts} for why.
*/
const WORKBUDDY_SETTINGS_FACE_PATH = "/plugins/dsh-workbuddy-connect/settings";
/**
* How often the credential files are re-checked, in milliseconds.
*
* A startup-only catalog fetch cannot notice a sign-in that happens while DSH
* is already running, so the model group would not appear until a restart. This
* poll is a cheap existence/parse read of at most a few local files: it never
* contacts the network and never runs a reasoning probe.
*
* `DSH_WORKBUDDY_POLL_MS` overrides it. That exists so the sweep can be
* exercised end to end in tests and shortened while diagnosing a slow sign-in
* on a real machine; it is not a product setting and no UI exposes it. The
* value is clamped to a sane range so a mistaken override cannot turn the poll
* into a busy loop.
*/
const CREDENTIAL_POLL_MS = 3e4;
/** Floor and ceiling for the overridable poll interval. */
const MIN_POLL_MS = 100;
const MAX_POLL_MS = 864e5;
/** Resolve the sweep interval, honoring the override when it is usable. */
function credentialPollMs() {
	const override = Number(process.env["DSH_WORKBUDDY_POLL_MS"]);
	if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS;
	return Math.min(override, MAX_POLL_MS);
}
/**
* How long to wait before retrying a catalog fetch that failed.
*
* The credential sweep deliberately does not re-fetch a catalog it already has
* (a same-identity token rotation carries no new model information). But a
* *failed* fetch must not be treated the same way: without a retry, one
* transient network blip at startup would leave the group on the built-in
* fallback roster until the user noticed and pressed refresh. This bound keeps
* that recovery automatic while still honoring the "not every round" rule — at
* most one attempt per interval, and none at all once a live catalog lands.
*
* Expressed as a multiple of the sweep rather than a fixed duration so the two
* stay in proportion under the `DSH_WORKBUDDY_POLL_MS` override.
*/
const CATALOG_RETRY_SWEEPS = 10;
/**
* Mark one user-editable configuration field as volatile — where the running
* schemastery knows what that means.
*
* DSH 0.1.7 projects a Config field into its settings form only when the field
* carries `meta.volatile`, and parses such a field into a stable reference the
* Host reads back through `.get()` (see {@link readField}). DSH 0.1.5's
* schemastery has no `volatile` method at all, so an unconditional call would
* throw a TypeError while this module is being imported and take the whole Host
* half down with it. The method is therefore probed per field and a schema
* without it is returned untouched: 0.1.5 keeps parsing and reading plain
* values, which is exactly its old behaviour.
*
* Each editable field is marked WHOLE (one top-level field, one fixed path):
* a volatile field may not enclose another, and the 0.1.7 client writes
* single-segment paths (`path: ['sidebarQuotaCN']`) that the Host validates
* against exactly this mark.
*
* @param field - the schemastery field to mark.
* @returns the volatile schema on 0.1.7, the same schema unchanged on 0.1.5.
*/
function volatileField(field) {
	const candidate = field;
	if (typeof candidate.volatile === "function") return candidate.volatile();
	if (typeof candidate.extra === "function") return candidate.extra("volatile", true);
	if (candidate && typeof candidate === "object") {
		candidate.meta = {
			...candidate.meta,
			volatile: true
		};
		return candidate;
	}
	return field;
}
/**
* Read one configuration field compatibly across both host lines.
*
* On 0.1.7 a field marked volatile is parsed into a `Volatile<T>` reference and
* MUST be read through `.get()` — the built-in plugins do exactly that
* (`dsh-agent-default-model`: `this.config.provider.get()`), and a raw read
* yields the reference object rather than the value. On 0.1.5 the same field is
* the plain value, so a raw read stays correct there. Every read of a volatile
* field goes through this one reader, which is what keeps a single code path
* correct on both lines.
*
* @param source - the configuration object (or section source) to read.
* @param field - the field name.
* @returns the field's value, or undefined when the source carries none.
*/
function readField(source, field) {
	const value = source?.[field];
	if (value !== null && typeof value === "object" && typeof value.get === "function") return value.get();
	return value;
}
/** Probe authorization (shared by the plugin schema and the CN section). */
const PROBE_CONSENT_FIELD = volatileField(z.boolean().default(false).description("Authorize reasoning-effort probes (each probe sends real requests that may consume credit)"));
const MAXIMUM_CONTEXT_WINDOW_FIELD = volatileField(z.boolean().default(true).description("Use the largest context window declared by WorkBuddy AI when alternatives are available (on by default)"));
const DISABLED_MODELS_FIELD = volatileField(z.array(z.string()).default([]).description("Disabled model IDs for this variant (empty by default)"));
/** Sidebar quota toggle (one per variant; both live on the shared quota card). */
const QUOTA_TOGGLE_FIELD = volatileField(z.boolean().default(false).description("Show this variant’s remaining-credit card in the sidebar footer (off by default)"));
/** Automatic check-in toggle. */
const AUTO_CHECK_IN_FIELD = volatileField(z.boolean().default(false).description("每天自动签到领取算力额度（默认关闭）"));
/**
* Quota poll interval: default 5 minutes, floor 1 minute. The status route
* performs a live upstream billing call per request with no cache, so an
* aggressively small interval translates directly into upstream load; the
* floor is the smallest value the UI offers rather than a silent clamp —
* smaller staged values fail Host validation and refuse to save.
*/
const QUOTA_POLL_DEFAULT_MS = 3e5;
const QUOTA_POLL_MIN_MS = 6e4;
const QUOTA_POLL_FIELD = volatileField(z.number().default(QUOTA_POLL_DEFAULT_MS).min(QUOTA_POLL_MIN_MS).description("Sidebar quota card refresh interval in milliseconds (default 300000, minimum 60000)"));
const Config = z.object({
	probeConsent: PROBE_CONSENT_FIELD,
	useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
	disabledModelsCN: DISABLED_MODELS_FIELD,
	disabledModelsAI: DISABLED_MODELS_FIELD,
	sidebarQuotaCN: QUOTA_TOGGLE_FIELD,
	sidebarQuotaAI: QUOTA_TOGGLE_FIELD,
	autoCheckInCN: AUTO_CHECK_IN_FIELD,
	autoCheckInAI: AUTO_CHECK_IN_FIELD,
	quotaPollMs: QUOTA_POLL_FIELD
});
z.object({
	probeConsent: PROBE_CONSENT_FIELD,
	disabledModelsCN: DISABLED_MODELS_FIELD
});
z.object({
	useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
	disabledModelsAI: DISABLED_MODELS_FIELD
});
z.object({
	sidebarQuotaCN: QUOTA_TOGGLE_FIELD,
	sidebarQuotaAI: QUOTA_TOGGLE_FIELD,
	autoCheckInCN: AUTO_CHECK_IN_FIELD,
	autoCheckInAI: AUTO_CHECK_IN_FIELD,
	quotaPollMs: QUOTA_POLL_FIELD
});
const CN_SECTION_KEYS = ["probeConsent", "disabledModelsCN"];
const AI_SECTION_KEYS = ["useMaximumContextWindow", "disabledModelsAI"];
const QUOTA_SECTION_KEYS = [
	"sidebarQuotaCN",
	"sidebarQuotaAI",
	"autoCheckInCN",
	"autoCheckInAI",
	"quotaPollMs"
];
/** Every declared configuration field, across all sections. */
const CONFIG_KEYS = [
	...CN_SECTION_KEYS,
	...AI_SECTION_KEYS,
	...QUOTA_SECTION_KEYS
];
/**
* The schema defaults, READ off each field's own `meta.default`.
*
* Two ways this was got wrong before, both silent and both destructive: a
* hand-written table drifted from the schema (so the schema's own defaults
* were classified as real overrides and the legacy settings document could
* never win), and `validate({})` was then tried instead — which on this
* schemastery answers with hollow `{}` per field instead of applying the
* defaults, which is worse than nothing because it looks like it worked.
* Walking `Config.dict` for `meta.default` is the only honest source: it is
* the value schemastery itself substituted during validation.
*/
const DEFAULT_FOR_FIELD = (() => {
	const out = {};
	try {
		for (const [key, field] of Object.entries(Config.dict ?? {})) {
			const fallback = field?.meta?.default;
			if (fallback !== void 0) out[key] = fallback;
		}
	} catch {}
	if (Object.keys(out).length === 0) return {
		probeConsent: false,
		useMaximumContextWindow: true,
		disabledModelsCN: [],
		disabledModelsAI: [],
		sidebarQuotaCN: false,
		sidebarQuotaAI: false,
		autoCheckInCN: false,
		autoCheckInAI: false,
		quotaPollMs: 3e5
	};
	return out;
})();
/** Stable identity key used by credentials, probe records, and catalog entries. */
function credentialIdentity(credential) {
	return `${credential.uid}:${credential.enterpriseId ?? ""}`;
}
/** The settings namespace a variant's card and provider directory entry use. */
function settingsNamespaceFor(variant) {
	return variant.id === CN_VARIANT.id ? WORKBUDDY_SETTINGS_NS : WORKBUDDY_AI_SETTINGS_NS;
}
/**
* The static catalog a variant serves before its first successful fetch.
*
* Each variant has its own roster: the two endpoints share several model ids
* but not their billing, context windows, or reasoning sets, so one shared
* fallback would misdescribe whichever variant it was not captured from.
*/
function fallbackFor(variant) {
	return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS : FALLBACK_WORKBUDDY_AI_MODELS;
}
/** Build one variant's stores and probe state. */
function createVariantRuntime(config, variant, current, identityOf) {
	const client = new WorkBuddyUpstreamClient();
	/**
	* Every sign-in of this product, with failover between them.
	*
	* The manager owns the credential stores; `activeStore()` is what the rest of
	* this factory means by "the account". Keeping the indirection in ONE place is
	* what lets the pool decide the answer without every catalog, probe and
	* check-in path having to know a pool exists.
	*/
	const accounts = new WorkBuddyAccountManager({
		variant,
		refresh: (credential) => client.refreshToken(credential)
	});
	/** The account in effect right now; falls back to slot 0 before discovery. */
	const activeStore = () => accounts.activeStore();
	const fallback = fallbackFor(variant);
	const catalog = new WorkBuddyCatalog(fallback);
	const initial = current();
	if (variant.id !== CN_VARIANT.id) {
		catalog.setUseMaximumContextWindow(initial.useMaximumContextWindow === true);
		const disabledAI = initial.disabledModelsAI;
		if (disabledAI !== void 0) catalog.setDisabledModels(disabledAI);
	} else {
		const disabledCN = initial.disabledModelsCN;
		if (disabledCN !== void 0) catalog.setDisabledModels(disabledCN);
	}
	catalog.setVisible(false);
	const probeStore = new WorkBuddyProbeStore({
		pluginVersion: WORKBUDDY_CONNECT_VERSION,
		path: workbuddyProbePath(variant.probeFilename)
	});
	const savedCatalogs = new WorkBuddyCatalogStore(workbuddyCatalogPath(variant.catalogFilename));
	const checkInService = new WorkBuddyCheckInService();
	return {
		variant,
		accounts,
		get store() {
			return activeStore();
		},
		client,
		checkIn: async (signal) => {
			const credential = await activeStore().current();
			return checkInService.checkIn(variant.id, credential, signal);
		},
		catalog,
		probeStore,
		probeService: new WorkBuddyProbeService({
			store: probeStore,
			catalog,
			credentials: { current: async () => activeStore().current() },
			client,
			consent: () => readField(current(), "probeConsent") === true,
			account: () => identityOf(variant.id)
		}),
		savedCatalogs,
		fallback,
		catalogSource: "fallback",
		catalogFetchedAtMs: void 0,
		catalogError: void 0,
		activationRequired: false,
		lastFetchAtMs: 0,
		catalogGeneration: 0,
		inflightFetch: void 0,
		invalidate: () => {},
		registered: false
	};
}
/**
* The account pool as the card renders it.
*
* Returns undefined when the variant holds at most one account: a "pool" of one
* is not a pool, and showing it would put a redundant section on every existing
* single-account install.
*
* @param runtime - the variant's runtime.
* @returns the pool section, or undefined when there is nothing to explain.
*/
function poolSection(runtime) {
	const pool = runtime.accounts.accountPool();
	const records = pool.all();
	if (records.length <= 1) return void 0;
	const activeId = pool.active()?.id;
	const now = Date.now();
	return {
		accounts: records.map((record) => ({
			id: record.id,
			label: record.label,
			active: record.id === activeId,
			cooldownUntilMs: record.cooldownUntilMs,
			...record.cooldownReason === void 0 ? {} : { cooldownReason: record.cooldownReason },
			rateLimitHits: record.rateLimitHits,
			...record.needsSignIn === true ? { needsSignIn: true } : {},
			...record.lastSuccessAtMs === void 0 ? {} : { lastSuccessAtMs: record.lastSuccessAtMs }
		})),
		available: pool.available(now).length
	};
}
/** The catalog provenance the card displays. */
function catalogSection(runtime) {
	const fetch = runtime.client.lastCatalog;
	return {
		source: runtime.catalogSource,
		...runtime.catalogFetchedAtMs === void 0 ? {} : { fetchedAt: runtime.catalogFetchedAtMs },
		...fetch?.appVersion === void 0 ? {} : { appVersion: fetch.appVersion.version },
		...runtime.catalogError === void 0 ? {} : { error: runtime.catalogError }
	};
}
/**
* Whether a model can be probed by hand: it reasons and the upstream declares
* no effort set for it.
*
* Deliberately *not* filtered by whether a result already exists. Dropping a
* model once it has been detected made the list shrink with use, so
* re-detecting one model — after an upstream change, say — meant clearing every
* other result first. The list stays stable and the card marks which entries
* already have an answer.
*/
function isProbeCandidate(info) {
	if (info.reasoning?.supports !== true) return false;
	return (info.reasoning.supportedEfforts?.length ?? 0) === 0;
}
/** Compact probe state for one card: consent, candidates, observations. */
function probeSection(runtime, consent) {
	const models = runtime.catalog.current();
	const results = models.flatMap((info) => {
		const record = runtime.probeService.recordFor(info.id);
		if (record === void 0) return [];
		return [{
			id: info.id,
			name: info.name,
			validation: record.validation,
			efforts: record.efforts,
			probedAt: record.probedAtMs
		}];
	});
	return {
		consent,
		running: runtime.probeService.isRunning(),
		candidates: models.filter(isProbeCandidate).map((info) => info.id),
		results: newestFirst(results)
	};
}
/**
* Start one variant: its loopback endpoint, provider registration, and
* configuration-card wiring.
*
* Registration waits for the shim to hold a port, because the provider's
* models read the shim origin at construction time. A failure here is
* contained to this variant: the caller logs it and the other keeps working.
*
* @returns whether the provider registered.
*/
async function startVariant(ctx, runtime, seedCatalog) {
	const { variant, client, catalog, probeService } = runtime;
	try {
		await runtime.accounts.load();
	} catch (error) {
		ctx.logger.warn(`dsh-workbuddy-connect: ${variant.displayName} account discovery failed`, error);
	}
	const shim = createWorkBuddyShim({
		store: runtime.store,
		accountPool: runtime.accounts.accountPool(),
		onAccountOutcome: (id, outcome) => {
			runtime.accounts.accountPool().report(id, outcome, Date.now());
		},
		resolveAccount: async (id) => {
			const account = runtime.accounts.get(id);
			if (account === void 0) throw new Error("workbuddy: account " + id + " is no longer in the pool");
			return account.store.resolve();
		},
		client,
		catalog,
		logger: ctx.logger,
		onActivationRequired: () => {
			runtime.activationRequired = true;
		},
		onActivationCleared: () => {
			runtime.activationRequired = false;
		}
	});
	try {
		await shim.ready;
	} catch (error) {
		ctx.logger.error(`dsh-workbuddy-connect: ${variant.displayName} loopback endpoint failed to start`, error);
		return false;
	}
	try {
		const workbuddy = createWorkBuddyAdapter({
			providerId: variant.id,
			displayName: variant.displayName,
			shim,
			store: runtime.store,
			catalog,
			resolveAttachments: () => ctx.get("attachments"),
			observe: (modelId) => probeService.recordFor(modelId)
		});
		workbuddy.invalidate;
		runtime.invalidate = () => {
			workbuddy.invalidate();
			ctx.emit("llm/adapters-updated");
		};
		let releaseAdapter;
		let releaseDirectory;
		try {
			releaseAdapter = ctx.llm.registerAdapter([variant.id], workbuddy.adapter);
			const host017 = (() => {
				try {
					return ctx.get?.("configEditor") !== void 0;
				} catch {
					return false;
				}
			})();
			const entryId = ctx.fiber?.entry?.options?.id;
			const settingsNs = host017 && entryId !== void 0 ? entryId : settingsNamespaceFor(variant);
			releaseDirectory = ctx.llm.registerConfigurableProviders([{
				provider: variant.id,
				displayName: variant.displayName,
				settingsNs,
				settingsPath: [],
				declared: false
			}]);
		} finally {
			if (releaseAdapter === void 0 || releaseDirectory === void 0) {
				releaseAdapter?.();
				releaseDirectory?.();
			}
		}
		try {
			ctx.effect(() => () => {
				releaseAdapter?.();
				releaseDirectory?.();
				shim.close();
			});
		} catch {
			releaseAdapter?.();
			releaseDirectory?.();
			shim.close();
		}
		runtime.registered = true;
		(async () => {
			try {
				await seedCatalog();
			} catch {}
		})();
		return true;
	} catch (error) {
		ctx.logger.error(`dsh-workbuddy-connect: ${variant.displayName} provider registration failed`, error);
		shim.close();
		return false;
	}
}
/**
* Start both variants: their loopback endpoints, the `workbuddy` and
* `workbuddy-ai` providers, their configuration cards, and their
* credential-driven catalog lifecycles.
*
* Each variant registers unconditionally; what varies is whether its catalog is
* *visible*. An empty catalog is how DSH hides a model group (the host filters
* out groups with no models), which keeps a sign-in that happens after startup
* working without re-registering the provider.
*/
/**
* State that MUST survive a fiber reload, module-level on purpose.
*
* DSH 0.1.7's configuration write (`configEditor.edit`) reconciles the profile
* tree, which hot-reloads the entry's fiber — `apply()` runs again with a fresh
* closure. Anything re-minted per apply is invalidated by every settings write:
* the browser cards hold the keys the status document handed them, so a
* per-apply key turns each write into a wave of 403s ("刷新失败"), and a
* per-apply identity map makes the sweep re-fetch the catalog from upstream on
* every write. Both are per-PROCESS secrets and caches, so they live here once.
*/
/** The in-process control keys, minted once per process. */
let processKeys;
function controlKeys() {
	processKeys ??= {
		probe: createProbeKey(),
		login: createLoginKey()
	};
	return processKeys;
}
/** The usage route's in-process action key, minted once per process. */
let usageProcessKey;
/** The backend-configuration route's in-process action key, minted once. */
let backendsProcessKey;
/** The account identity each variant last published a catalog for, across reloads. */
const lastIdentities = /* @__PURE__ */ new Map();
/** The loopback guard the probe and status routes use, restated for settings. */
function trustedSettingsRequest(req) {
	const host = req.headers.host ?? "";
	const origin = req.headers.origin;
	if (!/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(host))) return false;
	return origin === void 0 || /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(origin));
}
/** JSON response helper for the settings face. */
function jsonFace(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(payload);
}
/** Read the request body, or undefined when absent or oversized. */
function readFaceBody(req) {
	return new Promise((resolve) => {
		let body = "";
		req.on("data", (chunk) => {
			body += String(chunk);
			if (body.length > 1e6) resolve(void 0);
		});
		req.on("end", () => resolve(body));
		req.on("error", () => resolve(void 0));
	});
}
/** Schema-level validation of one settings patch; the reason, or undefined. */
function validateSettingsPatch(patch) {
	for (const [field, value] of Object.entries(patch)) {
		if (!CONFIG_KEYS.includes(field)) return `unknown field ${field}`;
		if (value === null) continue;
		switch (field) {
			case "probeConsent":
			case "useMaximumContextWindow":
			case "sidebarQuotaCN":
			case "sidebarQuotaAI":
			case "autoCheckInCN":
			case "autoCheckInAI":
				if (typeof value !== "boolean") return `${field} must be a boolean`;
				break;
			case "disabledModelsCN":
			case "disabledModelsAI":
				if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return `${field} must be an array of strings`;
				break;
			case "quotaPollMs": if (typeof value !== "number" || !Number.isInteger(value) || value < 6e4) return `${field} must be an integer of at least 60000 ms`;
		}
	}
}
/**
* Register the settings face (GET/POST) the browser cards read and write
* through, answering the whole entry configuration as three layers.
*
* `value` carries every declared field, so the quota card sees the same merged
* view the host itself reads; `user` is the settings file exactly as stored
* (presence marks an override). A POST validates the fields it may touch,
* writes the file, applies the new view in memory, and re-arms the check-in
* scheduler (the section `onChange` behaviour this plugin used to rely on).
*/
function registerSettingsFace(ctx, deps) {
	const { store, current, apply, rearm } = deps;
	const key = createProbeKey();
	/** The document both routes answer with. */
	const view = () => {
		const merged = current();
		const value = {};
		const baseOut = {};
		for (const field of CONFIG_KEYS) {
			if (merged[field] !== void 0) value[field] = merged[field];
			baseOut[field] = DEFAULT_FOR_FIELD[field];
		}
		return {
			key,
			value,
			base: baseOut,
			user: store.values()
		};
	};
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDY_SETTINGS_FACE_PATH,
			handler: async (req, res) => {
				if (!trustedSettingsRequest(req)) {
					jsonFace(res, 403, { error: "request-not-trusted" });
					return;
				}
				if (req.method === "GET") {
					jsonFace(res, 200, view());
					return;
				}
				if (req.method !== "POST") {
					jsonFace(res, 405, { error: "method not allowed" });
					return;
				}
				if (req.headers["x-workbuddy-settings-key"] !== key) {
					jsonFace(res, 403, { error: "invalid-key" });
					return;
				}
				const body = await readFaceBody(req);
				if (body === void 0) {
					jsonFace(res, 413, { error: "body too large" });
					return;
				}
				let patch;
				try {
					patch = JSON.parse(body || "{}");
				} catch {
					jsonFace(res, 400, { error: "invalid json" });
					return;
				}
				if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
					jsonFace(res, 400, { error: "invalid patch" });
					return;
				}
				const invalid = validateSettingsPatch(patch);
				if (invalid !== void 0) {
					jsonFace(res, 400, { error: invalid });
					return;
				}
				store.patch(patch, true);
				apply(current());
				rearm();
				jsonFace(res, 200, view());
			}
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy-connect: settings face");
}
/**
* Delete this plugin's own fields from the profile entry config, leaving every
* other key of the row untouched.
*
* One-time, right after the settings file has been seeded: the entry returns to
* its shipped state, so no second source of truth remains. The write rides
* `configEditor` — the profile-patch editor — probed on the plugin context
* first and on the settings service's owner context second, because that is
* where the host root mounts it.
*
* @param ctx - plugin context.
* @param ownKeys - this plugin's declared config fields.
*/
async function cleanupEntryConfig(ctx, ownKeys) {
	const attempts = 10;
	for (let attempt = 0; attempt < attempts; attempt++) try {
		if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2e3 + Math.random() * 1e3));
		const probe = ctx;
		const editor = (typeof probe.get === "function" ? (() => {
			try {
				return probe.get.call(ctx, "configEditor");
			} catch {
				return;
			}
		})() : void 0) ?? await new Promise((resolve) => {
			ctx.inject(["settings"], (settingsCtx) => {
				const owner = settingsCtx.settings?.ownerContext;
				resolve(typeof owner?.get === "function" ? (() => {
					try {
						return owner.get.call(owner, "configEditor");
					} catch {
						return;
					}
				})() : void 0);
			});
		});
		const entry = probe.fiber?.entry;
		if (editor !== void 0 && entry !== void 0) {
			await editor.edit(entry, (raw, inherited) => {
				const next = { ...inherited ?? {} };
				for (const [key, value] of Object.entries(raw ?? {})) {
					if (ownKeys.includes(key)) continue;
					if (!Object.hasOwn(next, key)) next[key] = value;
				}
				return next;
			});
			return;
		}
		return;
	} catch (error) {
		if (attempt === 9) {
			ctx.logger?.warn?.("dsh-workbuddy-connect: entry config cleanup failed", error);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1) + Math.random() * 500));
	}
}
/**
* Start both variants: their loopback endpoints, the `workbuddy` and
* `workbuddy-ai` providers, their configuration cards, and their
* credential-driven catalog lifecycles.
*
* Each variant registers unconditionally; what varies is whether its catalog is
* *visible*. An empty catalog is how DSH hides a model group (the host filters
* out groups with no models), which keeps a sign-in that happens after startup
* working without re-registering the provider.
*/
function apply(ctx, config) {
	const store = new SettingsStore();
	let current = () => withOwnValues(config);
	/**
	* Overlay the plugin-owned settings file on the entry's config view.
	*
	* `readField` unwraps the volatile references 0.1.7 hands out, so this
	* answers plain values on both host lines.
	*/
	const withOwnValues = (base) => {
		const out = { ...base };
		for (const key of CONFIG_KEYS) {
			const value = readField(base, key);
			if (value !== void 0) out[key] = value;
		}
		for (const [key, value] of Object.entries(store.values())) {
			if (key.startsWith("__")) continue;
			out[key] = value;
		}
		return out;
	};
	/**
	* One-time migration: per field — the file never held it → take the entry;
	* the card HAS written this file → keep the file; the entry carries a
	* NON-DEFAULT value → take the entry; the entry only carries the schema
	* default → keep the file.
	*
	* That last clause is load-bearing: a bundle layer's insert config does NOT
	* reach the composition (verified with `dsh --dump-config`), so once the
	* one-time cleanup has emptied the entry row the entry answers pure defaults —
	* treating those as authoritative would erase the user's values on the next
	* boot. Re-checked on every apply, which is also what closes the volatile
	* commit timing window.
	*
	* When the entry is authoritative, its own fields are then deleted from the
	* profile row, so no second source of truth remains.
	*/
	const migrateOwnSettings = () => {
		const seeded = {};
		for (const key of CONFIG_KEYS) {
			const entryValue = readField(config, key);
			if (!Object.hasOwn(store.user, key)) {
				if (entryValue !== void 0 && JSON.stringify(entryValue) !== JSON.stringify(DEFAULT_FOR_FIELD[key])) seeded[key] = entryValue;
				else if (entryValue !== void 0) seeded[key] = entryValue;
				continue;
			}
			if (store.edited) continue;
			if (entryValue !== void 0 && JSON.stringify(entryValue) !== JSON.stringify(DEFAULT_FOR_FIELD[key])) seeded[key] = entryValue;
		}
		if (Object.keys(seeded).length === 0) return;
		store.patch(seeded);
		cleanupEntryConfig(ctx, CONFIG_KEYS);
	};
	migrateOwnSettings();
	ctx.on("loader/volatile-update", () => {
		migrateOwnSettings();
	});
	/** Timers and in-flight work belonging to this plugin instance. */
	let stopped = false;
	const timers = [];
	const runtimes = WORKBUDDY_VARIANTS.map((variant) => createVariantRuntime(config, variant, () => current(), (id) => lastIdentities.get(id)));
	const checkInStore = new JsonFileCheckInStore();
	const checkInScheduler = new CheckInScheduler({
		targets: runtimes.map((runtime) => ({
			variantId: runtime.variant.id,
			checkIn: (signal) => runtime.checkIn(signal),
			onClaimed: () => {
				runtime.store.status().then((status) => {
					if (status.state === "signed-in") runtime.store.current().then((c) => {
						if (c) runtime.client.fetchCredits(c).catch(() => void 0);
					});
				});
			}
		})),
		isEnabled: (variantId) => {
			const cfg = current();
			if (variantId === CN_VARIANT.id) return readField(cfg, "autoCheckInCN") === true;
			return readField(cfg, "autoCheckInAI") === true;
		},
		store: checkInStore
	});
	checkInScheduler.start();
	let startupCatchUpDone = false;
	const runStartupCatchUpOnce = () => {
		if (startupCatchUpDone) return;
		startupCatchUpDone = true;
		checkInScheduler.catchUp();
	};
	const { probe: probeKey, login: loginKey } = controlKeys();
	/** The device-authorization client; one instance serves both realms. */
	const loginClient = new WorkBuddyLoginClient();
	/**
	* The one in-flight sign-in attempt per variant, keyed by provider id.
	*
	* One per variant because a second attempt for the same realm would issue a
	* second state and leave the first polling forever; a user who wants to
	* restart signs out or reloads, which discards this.
	*/
	const loginAttempts = /* @__PURE__ */ new Map();
	let setMaximumContextWindow;
	let setDisabledModelsForVariant;
	/**
	* Point a variant at an account identity, invalidating whatever the previous
	* one left behind.
	*
	* One helper for all four transitions (sweep sign-in, sweep sign-out, manual
	* refresh, manual refresh sign-out) because each of them used to do its own
	* partial version, and the manual path forgot pieces the sweep did. Every
	* transition bumps {@link VariantRuntime.catalogGeneration}, which is what
	* makes an in-flight request from before the change refuse to write back.
	*
	* Probe observations are dropped whenever the account actually changes —
	* including sign-out, and including the "signed out, then in as someone else"
	* sequence that used to look like a first sighting and let the new account
	* inherit the old one's detected levels. They are deliberately NOT cleared on
	* a first sign-in: no previous account's data could leak there, and clearing
	* would delete records this very account owns (written before a restart, or
	* seeded while all of this is running).
	*
	* @param identity - the account now in effect, or `undefined` when signed out.
	*/
	const adoptIdentity = (runtime, identity) => {
		const id = runtime.variant.id;
		const known = lastIdentities.get(id);
		if (known === identity && runtime.catalog.isVisible()) return;
		const hadCredential = known !== void 0;
		if (identity === void 0) lastIdentities.delete(id);
		else lastIdentities.set(id, identity);
		runtime.catalogGeneration += 1;
		runtime.inflightFetch?.controller.abort();
		runtime.inflightFetch = void 0;
		if (hadCredential && known !== identity) {
			if (identity === void 0) runtime.probeStore.clear();
			else runtime.probeStore.clearOthers(identity);
			runtime.invalidate();
		}
		if (identity === void 0) {
			if (known !== void 0) runtime.savedCatalogs.delete(known);
			runtime.catalog.set(runtime.fallback);
			runtime.catalogSource = "fallback";
			runtime.catalogFetchedAtMs = void 0;
			runtime.catalogError = void 0;
			if (runtime.catalog.setVisible(false)) runtime.invalidate();
			return;
		}
		const saved = runtime.savedCatalogs.get(identity);
		if (saved !== void 0) {
			runtime.catalog.set([...saved.models]);
			runtime.catalogSource = "saved";
			runtime.catalogFetchedAtMs = saved.fetchedAtMs;
		} else {
			runtime.catalog.set(runtime.fallback);
			runtime.catalogSource = "fallback";
			runtime.catalogFetchedAtMs = void 0;
		}
		runtime.catalogError = void 0;
		runtime.catalog.setVisible(true);
		runtime.invalidate();
	};
	ctx.inject(["webServer"], (webCtx) => {
		registerUsageRoute(webCtx, { service: () => usageService });
		registerBackendsRoute(webCtx, {
			registry: () => backendRegistry,
			backends: () => mergedBackends,
			failures: () => backendFailures,
			actionKey: () => backendsProcessKey ??= createBackendsKey(),
			reload: async () => {
				await reloadMergedBackends();
			}
		});
		for (const runtime of runtimes) {
			registerWorkBuddyStatusRoute(webCtx, {
				path: runtime.variant.statusPath,
				store: runtime.store,
				client: runtime.client,
				models: () => runtime.catalog.all(),
				catalog: () => catalogSection(runtime),
				probe: () => probeSection(runtime, readField(current(), "probeConsent") === true),
				probeKey,
				loginKey,
				...runtime.variant.id === CN_VARIANT.id ? {} : { useMaximumContextWindow: () => readField(current(), "useMaximumContextWindow") === true },
				disabledModels: () => runtime.catalog.disabledModels(),
				activationRequired: () => runtime.activationRequired,
				checkIn: () => checkInStore.read(runtime.variant.id),
				pool: () => poolSection(runtime)
			});
			registerWorkBuddyLoginRoute(webCtx, {
				path: runtime.variant.loginPath,
				begin: async () => {
					const previous = loginAttempts.get(runtime.variant.id);
					if (previous !== void 0) loginClient.forget(previous.state);
					const attempt = await loginClient.begin(runtime.variant.region);
					loginAttempts.set(runtime.variant.id, attempt);
					return {
						state: attempt.state,
						url: attempt.authUrl
					};
				},
				poll: async (state) => {
					const attempt = loginAttempts.get(runtime.variant.id);
					if (attempt === void 0 || attempt.state !== state) return {
						status: "failed",
						message: "this sign-in attempt is no longer active; start again"
					};
					const outcome = await loginClient.poll(attempt);
					if (outcome.status === "pending") return {
						status: "pending",
						state
					};
					loginClient.forget(state);
					loginAttempts.delete(runtime.variant.id);
					const region = resolveLoginRegion(runtime.variant.region, outcome.tokens.domain);
					const credential = {
						accessToken: outcome.tokens.accessToken,
						refreshToken: outcome.tokens.refreshToken,
						expiresAtMs: outcome.tokens.expiresInSec > 0 ? Date.now() + outcome.tokens.expiresInSec * 1e3 : 0,
						domain: outcome.tokens.domain,
						uid: outcome.account.uid,
						...outcome.account.enterpriseId === void 0 ? {} : { enterpriseId: outcome.account.enterpriseId },
						...outcome.account.nickname === void 0 ? {} : { nickname: outcome.account.nickname },
						source: WORKBUDDY_CREDENTIAL_SOURCE
					};
					if (region !== runtime.variant.region) return {
						status: "failed",
						message: `this sign-in returned a ${region === "cn" ? "WorkBuddy (CN)" : "WorkBuddy AI"} account, which belongs to the other provider; sign in from that one's card instead`
					};
					try {
						const account = await runtime.accounts.add(credential);
						runtime.accounts.accountPool().setActive(account.record.id);
						await runtime.accounts.flush();
					} catch (error) {
						return {
							status: "failed",
							message: error instanceof Error ? error.message.slice(0, 300) : String(error)
						};
					}
					const identity = credentialIdentity(credential);
					adoptIdentity(runtime, identity);
					fetchCatalog(runtime, identity);
					return {
						status: "complete",
						...outcome.account.nickname === void 0 ? {} : { nickname: outcome.account.nickname }
					};
				},
				logout: async () => {
					const attempt = loginAttempts.get(runtime.variant.id);
					if (attempt !== void 0) loginClient.forget(attempt.state);
					loginAttempts.delete(runtime.variant.id);
					const active = runtime.accounts.accountPool().active();
					if (active !== void 0) await runtime.accounts.remove(active.id);
					else await runtime.store.logout();
					const credential = await runtime.accounts.activeStore().current().catch(() => void 0);
					adoptIdentity(runtime, credential === void 0 ? void 0 : credentialIdentity(credential));
				},
				importDocument: async (document) => {
					const credential = await runtime.store.importDocument(document);
					const account = await runtime.accounts.add(credential);
					runtime.accounts.accountPool().setActive(account.record.id);
					await runtime.accounts.flush();
					const identity = credentialIdentity(credential);
					adoptIdentity(runtime, identity);
					fetchCatalog(runtime, identity);
					return {
						...credential.uid === "" ? {} : { uid: credential.uid },
						...credential.nickname === void 0 ? {} : { nickname: credential.nickname }
					};
				}
			}, loginKey);
			registerWorkBuddyProbeRoute(webCtx, {
				path: runtime.variant.probePath,
				probe: async (modelId) => {
					const result = await runtime.probeService.probe(modelId, true);
					if (result.state === "ok") runtime.invalidate();
					return result;
				},
				clear: () => {
					runtime.probeStore.clear();
					runtime.invalidate();
				},
				refresh: async () => {
					if (stopped) return {
						state: "failed",
						reason: "plugin is stopping"
					};
					let credential;
					try {
						credential = await runtime.store.current();
					} catch (error) {
						return {
							state: "failed",
							reason: error instanceof Error ? error.message.slice(0, 300) : String(error)
						};
					}
					if (credential === void 0) {
						adoptIdentity(runtime, void 0);
						return { state: "signed-out" };
					}
					const identity = credentialIdentity(credential);
					adoptIdentity(runtime, identity);
					await fetchCatalog(runtime, identity);
					return runtime.catalogError === void 0 ? {
						state: "refreshed",
						reason: `${runtime.catalog.current().length} models`
					} : {
						state: "failed",
						reason: runtime.catalogError
					};
				},
				clearCheckInLogs: () => {
					checkInStore.clearLogs(runtime.variant.id);
				},
				checkIn: async () => {
					const result = await runtime.checkIn();
					if (result.status !== "error") {
						checkInStore.write(runtime.variant.id, {
							lastDate: result.date,
							lastAt: result.timestamp,
							status: result.status,
							...result.amount === void 0 ? {} : { amount: result.amount },
							...result.message === void 0 ? {} : { message: result.message }
						});
						if (result.status === "claimed") {
							const cred = await runtime.store.current();
							if (cred) runtime.client.fetchCredits(cred).catch(() => void 0);
						}
					}
					return {
						state: result.status,
						...result.amount === void 0 ? {} : { amount: result.amount },
						...result.message === void 0 ? {} : { reason: result.message }
					};
				},
				setDisabledModels: async (disabled) => {
					if (setDisabledModelsForVariant === void 0) return {
						state: "failed",
						reason: "settings are unavailable"
					};
					return setDisabledModelsForVariant(runtime.variant.id, disabled);
				},
				...runtime.variant.id === CN_VARIANT.id ? {} : { setMaximumContextWindow: async (enabled) => {
					if (setMaximumContextWindow === void 0) return {
						state: "failed",
						reason: "settings are unavailable"
					};
					return setMaximumContextWindow(enabled);
				} }
			}, probeKey);
		}
		registerSettingsFace(webCtx, {
			store,
			current,
			apply: applyCatalogSettings,
			rearm: () => {
				runStartupCatchUpOnce();
			}
		});
	});
	/** Apply catalog preferences from a configuration view, in memory. */
	const applyCatalogSettings = (next) => {
		const aiRuntime = runtimes.find((candidate) => candidate.variant.id !== CN_VARIANT.id);
		if (aiRuntime?.catalog.setUseMaximumContextWindow(next.useMaximumContextWindow === true)) aiRuntime.invalidate();
		for (const runtime of runtimes) {
			const disabled = runtime.variant.id === CN_VARIANT.id ? next.disabledModelsCN ?? [] : next.disabledModelsAI ?? [];
			if (runtime.catalog.setDisabledModels(disabled)) runtime.invalidate();
		}
	};
	ctx.inject(["settings"], (settingsCtx) => {
		const settings = settingsCtx.settings;
		if (typeof settings.configure === "function") try {
			settingsCtx.effect(() => {
				const dispose = settings.configure({ auto: false }, ctx.fiber);
				return typeof dispose === "function" ? dispose : () => {};
			});
		} catch (error) {
			console.error("[dsh-workbuddy-connect] settings.configure failed (own settings file still serves):", error);
		}
		/**
		* The setters, one implementation: write the plugin-owned settings file,
		* then apply the new view in memory. No profile-patch write means no tree
		* reconcile, no fiber reload, and no client-mirror storm per toggle.
		*/
		const write = (patch) => {
			store.patch(patch, true);
			applyCatalogSettings(current());
			checkInScheduler.catchUp();
		};
		setMaximumContextWindow = async (enabled) => {
			write({ useMaximumContextWindow: enabled });
			return { state: "updated" };
		};
		setDisabledModelsForVariant = async (variantId, disabled) => {
			const key = variantId === CN_VARIANT.id ? "disabledModelsCN" : "disabledModelsAI";
			write({ [key]: [...disabled] });
			return { state: "updated" };
		};
	});
	const backendRegistry = createRegistry();
	const usageLedger = new UsageLedger();
	let mergedBackends = [];
	let backendFailures = [];
	let usageService;
	/** Disposers for the merged backends' registered LLM routes. */
	let backendReleases = [];
	/** Live routes, so a changed roster can be pushed without re-registering. */
	const backendRoutes = /* @__PURE__ */ new Map();
	/** Assigned below; the route closures call it on a write. */
	let reloadMergedBackends = async () => {};
	/**
	* Publish every merged backend that can actually serve requests.
	*
	* A backend that offers no transport is SKIPPED rather than registered with
	* an empty roster: a provider that appears in the picker and then fails on
	* the first message is worse than one that never appears, because the user
	* only discovers the problem after committing to it.
	*/
	const publishBackendProviders = async () => {
		for (const release of backendReleases) try {
			release();
		} catch {}
		backendReleases = [];
		backendRoutes.clear();
		for (const backend of mergedBackends) {
			if (stopped) return;
			if (backend.descriptor.serves !== true) continue;
			try {
				const availability = await backend.current();
				if (availability.state !== "ready") continue;
				const accountId = availability.accounts[0]?.id;
				if (accountId === void 0) continue;
				const transport = await backend.transport?.(accountId);
				if (transport === void 0) continue;
				const route = createOpenAiCompatRoute({
					providerId: backend.descriptor.id,
					displayName: backend.descriptor.displayName,
					baseUrl: () => transport.baseUrl,
					models: () => transport.models,
					resolveApiKey: () => transport.resolveApiKey(),
					resolveAttachments: () => ctx.get("attachments"),
					...transport.displayNameFor === void 0 ? {} : { displayNameFor: transport.displayNameFor }
				});
				backendRoutes.set(backend.descriptor.id, route);
				const releaseAdapter = ctx.llm.registerAdapter([backend.descriptor.id], route.adapter);
				const releaseDirectory = ctx.llm.registerConfigurableProviders([{
					provider: backend.descriptor.id,
					displayName: backend.descriptor.displayName,
					settingsNs: backend.descriptor.settingsNs,
					settingsPath: [],
					declared: false
				}]);
				backendReleases.push(releaseAdapter, releaseDirectory);
				ctx.emit("llm/adapters-updated");
			} catch (error) {
				ctx.logger.warn("dsh-workbuddy-connect: backend \"" + backend.descriptor.id + "\" provider registration failed", error);
			}
		}
	};
	/**
	* The usage route's per-process action key.
	*
	* A getter so the key is minted on first use and then never changes: a
	* settings write hot-reloads this fiber and re-runs `apply`, so a key minted
	* eagerly would be replaced on every write while the browser still held the
	* previous one — every refresh button would 403 until the page reloaded.
	*/
	const usageKeys = { get action() {
		return usageProcessKey ??= createUsageKey();
	} };
	/**
	* Rebuild the merged backend set and republish their providers.
	*
	* Called after a configuration write, because a stored account only takes
	* effect once the adapter that consumes it has been reconstructed.
	*/
	reloadMergedBackends = async () => {
		try {
			for (const backend of mergedBackends) try {
				await backend.dispose?.();
			} catch {}
			const loaded = await loadBackends(backendRegistry);
			mergedBackends = loaded.backends;
			backendFailures = loaded.failures;
			await publishBackendProviders();
		} catch (error) {
			ctx.logger.error("dsh-workbuddy-connect: reloading merged backends failed", error);
		}
	};
	(async () => {
		try {
			await usageLedger.load();
			const loaded = await loadBackends(backendRegistry);
			mergedBackends = loaded.backends;
			backendFailures = loaded.failures;
			for (const failure of backendFailures) ctx.logger.warn(`dsh-workbuddy-connect: backend "${failure.id}" failed to start: ${failure.message}`);
			usageService = new UsageService({
				backends: () => mergedBackends,
				failures: () => backendFailures,
				ledger: usageLedger,
				actionKey: () => usageKeys.action
			});
			if (stopped) return;
			await publishBackendProviders();
			ctx.logger.info("dsh-workbuddy-connect: " + String(mergedBackends.length) + " merged backend(s) ready, " + String(backendRoutes.size) + " serving models");
		} catch (error) {
			ctx.logger.error("dsh-workbuddy-connect: merged backends failed to start", error);
		}
	})();
	ctx.effect(() => () => {
		stopped = true;
		checkInScheduler.dispose();
		for (const timer of timers) clearInterval(timer);
		timers.length = 0;
		clearHostHeartbeat();
		usageLedger.flush().catch(() => void 0);
		for (const release of backendReleases) try {
			release();
		} catch {}
		backendReleases = [];
		for (const backend of mergedBackends) backend.dispose?.().catch(() => void 0);
	});
	/**
	* Fetch one variant's catalog for the current credential.
	*
	* Shared by the credential sweep and the card's manual refresh, and written
	* so that concurrent callers cost one request and cannot interleave badly:
	*
	* - **One request at a time.** A second caller joins the in-flight fetch
	*   instead of starting its own (spec §5: one catalog request per variant at
	*   a time).
	* - **Generation-checked write-back.** The request records the generation it
	*   started under and writes nothing if the generation moved on — which is
	*   what a slow answer from a superseded account must not do. Checking only
	*   the *identity* was not enough: two refreshes for the same account can
	*   still finish out of order, and the older one would win.
	* - **`resolve()`, not `current()`.** Only `resolve()` performs the locked,
	*   single-flight token renewal. Reading `current()` meant an expired token
	*   made every catalog request fail until something else happened to refresh
	*   it, leaving the group on the fallback roster.
	*/
	const fetchCatalog = async (runtime, identity) => {
		const inflight = runtime.inflightFetch;
		const generation = runtime.catalogGeneration;
		if (inflight !== void 0 && inflight.identity === identity && inflight.generation === generation) return inflight.promise;
		inflight?.controller.abort();
		const controller = new AbortController();
		let run;
		run = (async () => {
			let models;
			try {
				const credential = await runtime.store.resolve();
				const resolvedIdentity = credentialIdentity(credential);
				if (resolvedIdentity !== identity) {
					adoptIdentity(runtime, resolvedIdentity);
					await fetchCatalog(runtime, resolvedIdentity);
					return;
				}
				models = await runtime.client.fetchModels(credential, controller.signal);
				const latest = await runtime.store.current();
				const latestIdentity = latest === void 0 ? void 0 : credentialIdentity(latest);
				if (latestIdentity !== identity) {
					adoptIdentity(runtime, latestIdentity);
					if (latestIdentity !== void 0) await fetchCatalog(runtime, latestIdentity);
					return;
				}
			} catch (error) {
				if (stopped || runtime.catalogGeneration !== generation) return;
				runtime.lastFetchAtMs = Date.now();
				runtime.catalogError = error instanceof Error ? error.message.slice(0, 300) : String(error);
				ctx.logger.warn(`dsh-workbuddy-connect: ${runtime.variant.displayName} catalog unavailable; serving the fallback list`, error);
				runtime.invalidate();
				return;
			}
			if (stopped || runtime.catalogGeneration !== generation) return;
			runtime.lastFetchAtMs = Date.now();
			runtime.catalog.set([...models]);
			runtime.catalogSource = "live";
			runtime.catalogFetchedAtMs = runtime.client.lastCatalog?.fetchedAtMs ?? Date.now();
			runtime.catalogError = void 0;
			if (lastIdentities.get(runtime.variant.id) === identity) runtime.savedCatalogs.set(identity, {
				source: runtime.client.lastCatalog?.source ?? "unknown",
				fetchedAtMs: runtime.client.lastCatalog?.fetchedAtMs ?? Date.now(),
				models: [...models],
				...runtime.client.lastCatalog?.appVersion === void 0 ? {} : { appVersion: runtime.client.lastCatalog.appVersion.version }
			});
			runtime.invalidate();
		})().finally(() => {
			if (runtime.inflightFetch?.promise === run) runtime.inflightFetch = void 0;
		});
		runtime.inflightFetch = {
			identity,
			generation,
			controller,
			promise: run
		};
		return run;
	};
	/**
	* Reconcile one variant with its credentials.
	*
	* Four transitions matter, and each is a different action:
	*
	* - **none → some** (first sighting): reveal the group and fetch a catalog.
	* - **none → some, identity changed**: additionally drop the previous
	*   account's observations, so another user's probe answers cannot be read as
	*   the new account's.
	* - **some → none**: hide the group and stop serving its models.
	* - **same identity**: nothing to do — the store refreshes tokens on demand,
	*   and re-fetching on every rotation would hit the catalog endpoint for no
	*   new information.
	*/
	const syncVariant = async (runtime) => {
		if (stopped || !runtime.registered) return;
		const credential = await runtime.store.current().catch((error) => {
			ctx.logger.warn(`dsh-workbuddy-connect: ${runtime.variant.displayName} credential read failed`, error);
		});
		if (stopped) return;
		if (credential === void 0) {
			adoptIdentity(runtime, void 0);
			return;
		}
		const identity = credentialIdentity(credential);
		if (lastIdentities.get(runtime.variant.id) === identity && runtime.catalog.isVisible()) {
			const stale = runtime.catalogSource !== "live";
			const due = Date.now() - runtime.lastFetchAtMs >= credentialPollMs() * CATALOG_RETRY_SWEEPS;
			if (stale && due) await fetchCatalog(runtime, identity);
			return;
		}
		adoptIdentity(runtime, identity);
		await fetchCatalog(runtime, identity);
	};
	/** Run one reconcile sweep across both variants. */
	const syncAll = async () => {
		for (const runtime of runtimes) await syncVariant(runtime);
	};
	Promise.all(runtimes.map(async (runtime) => startVariant(ctx, runtime, async () => {
		if (stopped) return;
		let credential;
		try {
			credential = await runtime.store.current();
		} catch {
			return;
		}
		if (credential === void 0) return;
		const identity = credentialIdentity(credential);
		if (lastIdentities.get(runtime.variant.id) !== identity || !runtime.catalog.isVisible()) adoptIdentity(runtime, identity);
	}))).then(() => {
		if (stopped) return;
		if (runtimes.some((runtime) => runtime.registered)) writeHostHeartbeat();
		syncAll();
		const timer = setInterval(() => {
			syncAll();
		}, credentialPollMs());
		timer.unref?.();
		timers.push(timer);
	});
}
//#endregion
export { AI_SECTION_KEYS, AI_VARIANT, BACKEND_ENTRIES, BackendAccountRegistry, BackendUnavailable, BaseBackendAdapter, CLINE_DESCRIPTOR, CN_APP_VERSION_FILENAME, CN_SECTION_KEYS, CN_VARIANT, COMMANDCODE_DESCRIPTOR, Config, DEFAULT_WINDOW_DAYS, FALLBACK_CN_APP_VERSION, FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, LOGIN_PENDING_CODE, LOOMY_DESCRIPTOR, MIMO_DESCRIPTOR, PROBE_EFFORT_CANDIDATES, QUOTA_POLL_DEFAULT_MS, QUOTA_POLL_MIN_MS, QUOTA_SECTION_KEYS, USAGE_WINDOW_CHOICES, UsageLedger, UsageService, WORKBUDDY_AI_LOGIN_PATH, WORKBUDDY_AI_SETTINGS_NS, WORKBUDDY_APP_VERSION_FILENAME, WORKBUDDY_AUTH_FILENAME, WORKBUDDY_CATALOG_FILENAME, WORKBUDDY_CREDENTIAL_SOURCE, WORKBUDDY_DATA_DIR_ENV, WORKBUDDY_DATA_DIR_NAME, WORKBUDDY_HOST_HEARTBEAT_FILENAME, WORKBUDDY_LOGIN_PATH, WORKBUDDY_PROBE_FILENAME, WORKBUDDY_PROVIDER, WORKBUDDY_QUOTA_SETTINGS_NS, WORKBUDDY_SETTINGS_FACE_PATH, WORKBUDDY_SETTINGS_NS, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, WORKBUDDY_USAGE_ACTION_PATH, WORKBUDDY_USAGE_PATH, WORKBUDDY_VARIANTS, WorkBuddyAccountManager, WorkBuddyAccountPool, WorkBuddyCatalog, WorkBuddyCatalogStore, WorkBuddyCredentialStore, WorkBuddyLoginClient, WorkBuddyProbeService, WorkBuddyProbeStore, WorkBuddyUpstreamClient, appUserAgent, apply, backendAccountsPath, buildUsageSummary, chatUserAgent, classifyUpstreamError, clearHostHeartbeat, cooldownMsFor, createClineBackend, createCommandCodeBackend, createLoginKey, createLoomyBackend, createMiMoBackend, createRegistry, createUsageKey, createWorkBuddyAdapter, createWorkBuddyShim, dailySeries, fallbackChatIdentity, fingerprintModel, identityOf, inject, installedAppVersion, isAccountScoped, isHeartbeatProcessAlive, loadBackends, localDay, maskSecret, messageOf, modelWithCurrentPromotion, name, normalizeCredits, normalizeLoginRegion, parseModelCatalog, parseUsageAction, parseWorkBuddyAuth, poolAccountPath, poolStatePath, prepareChatBody, prepareInternationalChatBody, probeModel, processStartTimeMs, randomSentinel, readBundleVersion, readCliVersion, readHostHeartbeat, regionOf, registerUsageRoute, registerWorkBuddyLoginRoute, resolveAppVersion, resolveChatIdentity, resolveLoginRegion, seedsFor, totalTokens, usageDocumentHandler, usageLedgerPath, validAppVersion, validCliVersion, variantFor, withFailover, workBuddyLoginHandler, workbuddyCatalogPath, workbuddyHostHeartbeatPath, workbuddyOwnAuthPath, workbuddyPluginDataDir, workbuddyProbePath };
