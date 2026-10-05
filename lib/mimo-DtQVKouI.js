import { n as BaseBackendAdapter, t as BackendUnavailable } from "./base-DPIOH9ta.js";
import { copyFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
//#region src/backends/mimo.ts
/**
* MiMo (小米) — a desktop-adoption backend.
*
* MiMo Desktop signs in through Xiaomi Passport, and its Chromium build leaves
* the passport cookies in a SQLite cookie jar. Those cookies are read here,
* read-only; the plugin never writes to the application and cannot start a
* sign-in (the user signs in *in the app*, or the plugin's own credential file
* is used instead, which takes priority).
*
* MiMo is a SINGLE-ACCOUNT product: the desktop app holds one Xiaomi passport
* sign-in and its cookie store has no notion of a second, so `multiAccount` is
* false in the descriptor — a statement about the vendor's model rather than a
* limitation of this adapter.
*
* Unlike the sibling Loomy backend, MiMo CAN report remaining quota: the
* desktop-free channel exposes `GET /api/user/usage`, so `reportsQuota` is true
* and `quota()` actually probes it.
*
* @module dsh-workbuddy-connect/backends/mimo
*/
/** Environment override naming an explicit cookie database. */
const COOKIE_DB_ENV = "MIMO_COOKIE_DB";
/** Environment override naming an explicit plugin-owned credential file. */
const AUTH_FILE_ENV = "MIMO_AUTH_FILE";
/** The plugin's own credential file, relative to the Harness home. */
const OWN_AUTH_FILENAME = ".mimo-connect-auth.json";
/** On-disk format version of the plugin-owned credential. */
const OWN_FORMAT_VERSION = 1;
/**
* The passport cookies required to establish a session.
*
* Only these matter; the jar also holds analytics and locale noise. `passToken`
* is the one that is actually load-bearing, and the two identity cookies ride
* along so the session can be re-established after a merge.
*/
const REQUIRED_COOKIES = [
	"passToken",
	"cUserId",
	"userId"
];
/**
* Cookie database row cap.
*
* A Chromium jar on a long-lived profile can hold thousands of rows, but the
* passport triple lives in a handful. Bounding the scan keeps a pathological
* database from turning startup into a stall; the required cookies are matched
* by name, so the cap only ever truncates irrelevant rows.
*/
const MAX_COOKIE_ROWS = 2e4;
/** Upstream host the desktop-free channel is served from. */
const MIMO_SERVER = "https://mimo-server-cn.xiaomimimo.com";
/**
* User-Agent presented upstream.
*
* Deliberately NOT the desktop app's: the gateway does not require desktop
* impersonation, and copying a desktop fingerprint would be a claim this
* adapter cannot back.
*/
const MIMO_USER_AGENT = "MiClaw/1.0";
/** Upper bound on one quota probe, so a hung gateway cannot pin a render open. */
const QUOTA_TIMEOUT_MS = 8e3;
/** Maximum redirect hops followed while minting a service token. */
const MAX_SESSION_HOPS = 6;
/**
* Built-in roster.
*
* The MiMo gateway exposes NO model-listing endpoint (`/api/models` and its
* neighbours answer 404), so the roster is a snapshot mirrored from MiMo
* Desktop's own `model-catalog.json`. Only chat models belong here: the app's
* ASR / TTS / image entries cannot serve a DSH turn.
*/
const MIMO_MODELS = [{
	id: "mimo-v2.6-flash",
	name: "MiMo V2.6 Flash",
	contextWindow: 262144,
	maxTokens: 65536,
	supportsImages: true,
	rate: "x0.40",
	displayRatio: .4
}, {
	id: "mimo-v2.6-pro",
	name: "MiMo V2.6 Pro",
	contextWindow: 262144,
	maxTokens: 65536,
	supportsImages: true,
	rate: "x1.00",
	displayRatio: 1
}];
/** The descriptor this backend registers under. */
const MIMO_DESCRIPTOR = {
	id: "mimo",
	displayName: "MiMo",
	description: "小米 MiMo 桌面端内置模型",
	brand: {
		vendor: "小米",
		product: "MiMo"
	},
	authKind: "desktop-adoption",
	multiAccount: false,
	reportsQuota: true,
	reportsTokenUsage: false,
	settingsNs: "llm-mimo"
};
/**
* Candidate locations of MiMo's Chromium cookie database, most likely first.
*
* All platform layouts are probed rather than branching on `process.platform`,
* so a moved or non-standard install is still found — the same reasoning the
* Loomy backend uses for its auth file.
*
* @returns candidate absolute paths.
*/
function mimoCookieCandidates() {
	const candidates = [];
	const appData = process.env["APPDATA"];
	if (appData !== void 0 && appData !== "") {
		candidates.push(join(appData, "Xiaomi MiMo", "Partitions", "xiaomi-account", "Network", "Cookies"));
		candidates.push(join(appData, "Xiaomi MiMo", "Network", "Cookies"));
	}
	const home = homedir();
	candidates.push(join(home, ".config", "Xiaomi MiMo", "Partitions", "xiaomi-account", "Network", "Cookies"));
	candidates.push(join(home, "Library", "Application Support", "Xiaomi MiMo", "Partitions", "xiaomi-account", "Network", "Cookies"));
	return [...new Set(candidates)];
}
/**
* The plugin's own credential file path.
*
* Resolved through the Harness home helper so an explicit `$DSH_HOME` is
* honoured; the file is the PLUGIN's own, never the application's.
*
* @returns the absolute path.
*/
function mimoOwnAuthPath() {
	return join(resolveDshHome(), OWN_AUTH_FILENAME);
}
/**
* Parse the plugin-owned credential document.
*
* A missing `passToken` makes the document unusable rather than partially
* usable: the other two cookies cannot mint a session on their own, so
* accepting the file would produce an account that fails every request.
*
* @param text - raw file contents.
* @returns the credential, or undefined when unusable.
*/
function parseOwnMiMoCredential(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	if (document["version"] !== void 0 && document["version"] !== OWN_FORMAT_VERSION) return void 0;
	const inner = typeof document["credential"] === "object" && document["credential"] !== null ? document["credential"] : document;
	const passToken = typeof inner["passToken"] === "string" ? inner["passToken"] : "";
	if (passToken === "") return void 0;
	return {
		passToken,
		cUserId: typeof inner["cUserId"] === "string" ? inner["cUserId"] : "",
		userId: typeof inner["userId"] === "string" ? inner["userId"] : "",
		source: "plugin"
	};
}
/**
* Load `node:sqlite` without making it a load-time requirement.
*
* A static import would make the WHOLE backend module fail to load on a runtime
* without SQLite, and the catalogue's guarded import would then report this
* backend as broken rather than unreadable. A dynamic import inside a try keeps
* the module loadable everywhere.
*
* The module is unflagged from Node 22.13 / 23.4, so this project's engine
* floor of 22.19 already has it; the guard exists for hosts that differ.
*
* @returns the module, or undefined when unavailable.
*/
async function loadSqlite() {
	try {
		return await import("node:sqlite");
	} catch {
		return;
	}
}
/**
* Extract the passport cookies from a Chromium cookie database.
*
* Why `node:sqlite` rather than a hand-rolled byte scan: the cookie jar IS a
* SQLite file, and scanning bytes for `passToken` cannot tell a live cookie row
* from a deleted one still sitting in a free page. A stale `passToken` would be
* sent upstream and read as a revoked session, so a scan would trade a real
* correctness property for a dependency the runtime already carries.
*
* The database is copied to a scratch file before it is opened, because MiMo
* holds the original open while it runs and opening a SQLite file another
* process is actively writing can fail or block. The copy is strictly
* read-only as far as the application is concerned.
*
* @param dbPath - path to the `Cookies` SQLite file.
* @returns the passport cookies found there, or undefined when unreadable.
*/
async function readMiMoCookies(dbPath) {
	if (!existsSync(dbPath)) return void 0;
	const scratch = join(tmpdir(), "mimo-ck-" + process.pid + "-" + Date.now() + ".db");
	const sidecars = [
		"",
		"-journal",
		"-wal",
		"-shm"
	];
	const copied = [];
	try {
		for (const suffix of sidecars) {
			if (!existsSync(dbPath + suffix)) continue;
			try {
				await copyFile(dbPath + suffix, scratch + suffix);
				copied.push(scratch + suffix);
			} catch {}
		}
		if (!existsSync(scratch)) return void 0;
		const sqlite = await loadSqlite();
		if (sqlite === void 0) return void 0;
		const db = new sqlite.DatabaseSync(scratch, { readOnly: true });
		try {
			const rows = db.prepare("SELECT host_key, name, value FROM cookies LIMIT ?").all(MAX_COOKIE_ROWS);
			const out = [];
			for (const raw of rows) {
				if (typeof raw !== "object" || raw === null) continue;
				const row = raw;
				const name = row["name"];
				const value = row["value"];
				const host = row["host_key"];
				if (typeof name !== "string" || typeof value !== "string" || value === "") continue;
				if (typeof host !== "string" || host === "") continue;
				if (!REQUIRED_COOKIES.includes(name)) continue;
				out.push({
					host,
					name,
					value
				});
			}
			return out;
		} finally {
			db.close();
		}
	} catch {
		return;
	} finally {
		for (const path of copied) try {
			await unlink(path);
		} catch {}
	}
}
/**
* Assemble a credential from the passport cookies of one cookie database.
*
* The triple is looked up under the account domain, because the same cookie
* names also appear scoped to `.xiaomi.com`, and picking the wrong scope would
* send a stale identity. A `passToken` is required; the other two are optional
* because older builds omit them.
*
* @param rows - the cookies read from the database.
* @returns the credential, or undefined when no passport sign-in is present.
*/
function credentialFromCookies(rows) {
	const byHost = /* @__PURE__ */ new Map();
	for (const row of rows) {
		let bucket = byHost.get(row.host);
		if (bucket === void 0) {
			bucket = /* @__PURE__ */ new Map();
			byHost.set(row.host, bucket);
		}
		bucket.set(row.name, row.value);
	}
	const found = [...byHost].find(([host, cookies]) => host.includes("account.xiaomi.com") && cookies.has("passToken")) ?? [...byHost].find(([, cookies]) => cookies.has("passToken"));
	if (found === void 0) return void 0;
	const cookies = found[1];
	const passToken = cookies.get("passToken");
	if (passToken === void 0 || passToken === "") return void 0;
	return {
		passToken,
		cUserId: cookies.get("cUserId") ?? "",
		userId: cookies.get("userId") ?? "",
		source: "desktop"
	};
}
/** Lowercase a domain and drop a leading dot. */
function normalizeDomain(domain) {
	return domain.trim().toLowerCase().replace(/^\./u, "");
}
/** Whether a cookie scoped to `domain` may be sent to `host`. */
function domainMatches(domain, host) {
	const d = normalizeDomain(domain);
	const h = normalizeDomain(host);
	if (d === "" || h === "") return false;
	return h === d || h.endsWith("." + d);
}
/** Parse one `Set-Cookie` line down to the parts the jar keeps. */
function parseSetCookie(line, fallbackHost) {
	const parts = line.split(";");
	const pair = parts[0] ?? "";
	const eq = pair.indexOf("=");
	if (eq <= 0) return void 0;
	const name = pair.slice(0, eq).trim();
	if (name === "") return void 0;
	let value = pair.slice(eq + 1).trim();
	const quoted = /^"(.*)"$/u.exec(value);
	if (quoted !== null) value = quoted[1] ?? "";
	let domain = normalizeDomain(fallbackHost);
	for (const attr of parts.slice(1)) {
		const i = attr.indexOf("=");
		if ((i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase() === "domain") domain = normalizeDomain(i === -1 ? "" : attr.slice(i + 1).trim());
	}
	if (domain === "") return void 0;
	return {
		domain,
		name,
		value
	};
}
/**
* A domain-scoped cookie jar.
*
* This exists because of one measured failure in the original plugin: sending
* `.account.xiaomi.com` and `.xiaomi.com` cookies in the same `Cookie` header
* makes MiMo's gateway treat the session as invalid and answer `EXPIRED`.
* Scoping each request's header to the domains that actually match its host is
* what makes the token exchange succeed.
*/
var MiMoJar = class {
	byDomain = /* @__PURE__ */ new Map();
	/** Store a cookie; an empty or `EXPIRED` value clears it. */
	set(domain, name, value) {
		const key = normalizeDomain(domain);
		if (key === "") return;
		let bucket = this.byDomain.get(key);
		if (bucket === void 0) {
			bucket = /* @__PURE__ */ new Map();
			this.byDomain.set(key, bucket);
		}
		if (value.trim() === "" || value.trim() === "EXPIRED") bucket.delete(name);
		else bucket.set(name, value);
	}
	/** Read one cookie, or undefined. */
	get(domain, name) {
		return this.byDomain.get(normalizeDomain(domain))?.get(name);
	}
	/** Every domain currently holding at least one cookie. */
	domains() {
		return [...this.byDomain.keys()];
	}
	/**
	* Build the `Cookie` header for one URL.
	*
	* A host can match several stored domains at once and the same name may exist
	* in more than one; emitting it twice produces an invalid header, so each name
	* is emitted once with the value from the most specific domain — the rule
	* browsers apply.
	*/
	headerFor(url) {
		let host;
		try {
			host = new URL(url).hostname;
		} catch {
			return "";
		}
		const matches = [...this.byDomain].filter(([domain]) => domainMatches(domain, host));
		matches.sort((a, b) => b[0].length - a[0].length);
		const chosen = /* @__PURE__ */ new Map();
		for (const [, cookies] of matches) for (const [name, value] of cookies) if (!chosen.has(name)) chosen.set(name, value);
		return [...chosen].map(([name, value]) => name + "=" + value).join("; ");
	}
	/** Absorb the `Set-Cookie` headers of one response. */
	absorb(headers, host) {
		for (const line of headers.getSetCookie()) {
			const parsed = parseSetCookie(line, host);
			if (parsed === void 0) continue;
			this.set(parsed.domain, parsed.name, parsed.value);
		}
	}
};
/**
* One MiMo session: the cookie jar plus the minted `serviceToken`.
*
* The passport cookies cannot be used for inference directly. They must first
* be exchanged for a `serviceToken` through MiMo's STS endpoint, by walking a
* redirect chain. Two details are load-bearing and were both learned the hard
* way: cookies must be sent per-domain (see {@link MiMoJar}), and EVERY
* response must be absorbed, because the `deviceId` issued along the way is
* required by a later hop.
*/
var MiMoSession = class {
	jar = new MiMoJar();
	constructor(credential) {
		this.jar.set(".account.xiaomi.com", "passToken", credential.passToken);
		if (credential.cUserId !== "") {
			this.jar.set(".account.xiaomi.com", "cUserId", credential.cUserId);
			this.jar.set(".xiaomi.com", "cUserId", credential.cUserId);
		}
		if (credential.userId !== "") {
			this.jar.set(".account.xiaomi.com", "userId", credential.userId);
			this.jar.set(".xiaomi.com", "userId", credential.userId);
		}
	}
	/**
	* The `serviceToken`, matched the way the jar matches headers.
	*
	* The gateway issues it under `Domain=.xiaomimimo.com` — a parent of the
	* server host — so a strict host-keyed lookup would miss it.
	*/
	serviceToken() {
		let best;
		let bestLen = -1;
		const host = new URL(MIMO_SERVER).hostname;
		for (const domain of this.jar.domains()) {
			if (!domainMatches(domain, host)) continue;
			const value = this.jar.get(domain, "serviceToken");
			if (value === void 0) continue;
			if (domain.length > bestLen) {
				best = value;
				bestLen = domain.length;
			}
		}
		return best;
	}
	/** One request carrying only the cookies matching that URL. */
	async request(url, init) {
		const headers = new Headers(init.headers);
		headers.set("User-Agent", MIMO_USER_AGENT);
		const cookie = this.jar.headerFor(url);
		if (cookie !== "") headers.set("Cookie", cookie);
		const response = await fetch(url, {
			...init,
			headers,
			redirect: "manual"
		});
		this.jar.absorb(response.headers, new URL(url).hostname);
		return response;
	}
	/** Drop any held `serviceToken`, wherever it was scoped. */
	clearServiceToken() {
		const host = new URL(MIMO_SERVER).hostname;
		for (const domain of this.jar.domains()) if (domainMatches(domain, host)) this.jar.set(domain, "serviceToken", "");
	}
	/** Establish a `serviceToken` by walking the redirect chain. */
	async ensureSession() {
		const existing = this.serviceToken();
		if (existing !== void 0 && existing !== "") return existing;
		this.clearServiceToken();
		let url = MIMO_SERVER + "/api/user/xiaomi/me";
		let lastStatus = 0;
		for (let hop = 0; hop < MAX_SESSION_HOPS; hop++) {
			const response = await this.request(url, { headers: { Accept: "text/html,application/json,*/*;q=0.8" } });
			lastStatus = response.status;
			const token = this.serviceToken();
			if (token !== void 0 && token !== "") {
				try {
					await response.arrayBuffer();
				} catch {}
				return token;
			}
			const location = response.headers.get("location");
			if (location === null || location === "") {
				try {
					await response.arrayBuffer();
				} catch {}
				break;
			}
			url = new URL(location, url).toString();
		}
		throw new Error("MiMo 会话建立失败：未取得 serviceToken（最后一次响应 HTTP " + lastStatus + "）。");
	}
	/** Read the account's allowance document, or undefined when unreadable. */
	async usage(signal) {
		await this.ensureSession();
		const response = await this.request(MIMO_SERVER + "/api/user/usage", {
			headers: { Accept: "application/json" },
			signal
		});
		if (!response.ok) {
			try {
				await response.arrayBuffer();
			} catch {}
			return;
		}
		const text = await response.text();
		if (!text.trimStart().startsWith("{")) return void 0;
		return JSON.parse(text);
	}
};
/**
* Parse the `data` payload of `/api/user/usage`.
*
* `percent` is the REMAINING share of the period's allowance, not the used
* share: a freshly reset account reads 99.8 rather than 0.2. Reading it as
* "used" would invert the whole dashboard, which is the one mistake this
* function exists to prevent.
*
* @param value - the decoded response body.
* @returns the percentage remaining and its reset instant, or undefined.
*/
function parseMiMoQuota(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const envelope = value;
	const data = typeof envelope["data"] === "object" && envelope["data"] !== null ? envelope["data"] : envelope;
	const percent = data["percent"];
	if (typeof percent !== "number" || !Number.isFinite(percent)) return void 0;
	const resetAt = typeof data["resetAt"] === "number" && Number.isFinite(data["resetAt"]) ? (/* @__PURE__ */ new Date(data["resetAt"] * 1e3)).toISOString() : typeof data["resetDate"] === "string" && data["resetDate"] !== "" ? data["resetDate"] : void 0;
	return {
		remainPercent: Math.min(100, Math.max(0, percent)),
		...resetAt === void 0 ? {} : { resetAt }
	};
}
/**
* Read the resolved credential, preferring the plugin's own file.
*
* That ordering is what makes a machine which already has a signed-in desktop
* app work with zero prompts, while still letting an explicit plugin sign-in
* override it.
*
* @returns the credential, or undefined when neither source has one.
* @throws {BackendUnavailable} when MiMo is not installed at all.
*/
async function resolveCredential() {
	const ownOverride = process.env[AUTH_FILE_ENV];
	const ownPath = ownOverride !== void 0 && ownOverride !== "" ? ownOverride : mimoOwnAuthPath();
	if (existsSync(ownPath)) try {
		const parsed = parseOwnMiMoCredential(await readFile(ownPath, "utf8"));
		if (parsed !== void 0) return parsed;
		return;
	} catch {
		return;
	}
	const override = process.env[COOKIE_DB_ENV];
	const candidates = override !== void 0 && override !== "" ? [override, ...mimoCookieCandidates()] : mimoCookieCandidates();
	let sawDatabase = false;
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		sawDatabase = true;
		const rows = await readMiMoCookies(path);
		if (rows === void 0) continue;
		const credential = credentialFromCookies(rows);
		if (credential === void 0) continue;
		return {
			...credential,
			cookiePath: path
		};
	}
	if (!sawDatabase) throw new BackendUnavailable("未检测到小米 MiMo 桌面端的登录状态；请先安装并登录 MiMo 客户端，或在插件中配置 MiMo 凭据。");
}
/** A masked identity for the account label. */
function maskIdentity(credential) {
	const id = credential.userId !== "" ? credential.userId : credential.cUserId;
	if (id === "") return "Xiaomi 账号";
	if (id.length <= 6) return "•".repeat(Math.max(4, id.length));
	return id.slice(0, 3) + "****" + id.slice(-3);
}
/** MiMo's product-specific half. */
var MiMoImpl = class {
	async discover() {
		const credential = await resolveCredential();
		if (credential === void 0) return [];
		const id = credential.userId !== "" ? credential.userId : credential.cUserId;
		if (id === "") return [];
		return [{
			id,
			label: maskIdentity(credential),
			detail: credential.source === "desktop" ? "来自 MiMo 桌面端登录状态" : "来自插件凭据",
			usable: true
		}];
	}
	async quota(accountId) {
		const credential = await resolveCredential();
		if (credential === void 0) return {
			kind: "error",
			message: "MiMo 登录状态已失效，请重新登录。"
		};
		const resolvedId = credential.userId !== "" ? credential.userId : credential.cUserId;
		if (resolvedId !== "" && resolvedId !== accountId) return {
			kind: "error",
			message: "MiMo 账号已变更，请刷新后重试。"
		};
		const session = new MiMoSession(credential);
		try {
			const usage = await session.usage(AbortSignal.timeout(QUOTA_TIMEOUT_MS));
			if (usage === void 0) return {
				kind: "error",
				message: "MiMo 未返回额度信息（会话可能已过期）。"
			};
			const parsed = parseMiMoQuota(usage);
			if (parsed === void 0) return {
				kind: "error",
				message: "MiMo 额度响应格式无法识别。"
			};
			return {
				kind: "packages",
				total: parsed.remainPercent,
				totalSize: 100,
				packages: [{
					packageName: "MiMo 免费额度",
					remain: parsed.remainPercent,
					size: 100,
					...parsed.resetAt === void 0 ? {} : { packageEndTime: parsed.resetAt }
				}]
			};
		} catch (error) {
			return {
				kind: "error",
				message: error instanceof Error ? error.message : String(error)
			};
		}
	}
	async models() {
		return MIMO_MODELS.map((entry) => ({
			id: entry.id,
			name: entry.name,
			...entry.contextWindow === void 0 ? {} : { contextWindow: entry.contextWindow },
			...entry.maxTokens === void 0 ? {} : { maxTokens: entry.maxTokens },
			...entry.supportsImages === void 0 ? {} : { supportsImages: entry.supportsImages },
			...entry.rate === void 0 ? {} : { rate: entry.rate }
		}));
	}
};
/** Thin subclass so the concrete type names the backend in stack traces. */
var MiMoBackend = class extends BaseBackendAdapter {};
/** The MiMo backend, ready to register. */
function createMiMoBackend() {
	return new MiMoBackend(MIMO_DESCRIPTOR, new MiMoImpl());
}
//#endregion
export { mimoOwnAuthPath as a, readMiMoCookies as c, mimoCookieCandidates as i, createMiMoBackend as n, parseMiMoQuota as o, credentialFromCookies as r, parseOwnMiMoCredential as s, MIMO_DESCRIPTOR as t };
