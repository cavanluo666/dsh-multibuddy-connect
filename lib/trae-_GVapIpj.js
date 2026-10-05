import { n as BaseBackendAdapter, t as BackendUnavailable } from "./base-B4d56Evj.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
//#region src/backends/trae.ts
/**
* Trae (ByteDance) — a desktop-adoption backend serving TWO regions.
*
* Trae ships four desktop installs across two service regions (Trae CN /
* TRAE SOLO CN on the CN gateway; Trae / TRAE SOLO on the international one),
* and a user may legitimately have both signed in at once. The two are
* therefore TWO ACCOUNTS of one backend rather than one account, which is why
* this is the merged backend that genuinely satisfies `multiAccount: true`
* while its desktop-adoption peers do not: the source is not a single login
* slot but four independent installs.
*
* The region is decided by the credential's OWN claim first
* (`userRegion.region` = `CN` | `SG`), then the install's edition label, then
* the credential host. Reading it off the credential rather than off which file
* happened to load is what keeps a CN account from being routed to the
* international gateway when both are installed.
*
* READ-ONLY. Trae's desktop storage encrypts its auth value; this adapter
* decrypts for reading and never writes back. The one upstream WRITE the
* original plugin performs — the daily check-in claim — is deliberately NOT
* carried over: it changes the user's account state, and a plugin whose stated
* contract is "read your existing login" has no business spending a claim on
* the user's behalf without them asking.
*
* @module dsh-workbuddy-connect/backends/trae
*/
/** User-facing name of each install. */
const APP_NAMES = {
	cn: "Trae CN",
	sg: "Trae",
	solo: "TRAE SOLO CN",
	"solo-sg": "TRAE SOLO"
};
/**
* Directory names each edition uses per platform.
*
* Measured from the shipped bundles rather than guessed: Trae is a
* VS Code-family Electron app, and that family names its per-user data
* directory from the installer-registered product name (Windows
* `product.json`'s `win32DirName`), not from the macOS bundle spelling. The
* lowercase applicationName spellings are probed as well because the same
* family uses them on Linux, and which one a given installer writes has never
* been confirmed on a real Windows host.
*/
const WINDOWS_APP_NAMES = {
	cn: ["Trae CN", "trae-cn"],
	sg: ["Trae"],
	solo: ["TRAE SOLO CN", "trae-solo-cn"],
	"solo-sg": ["TRAE SOLO"]
};
/** The Trae CLI keeps a dotfile home rather than an Application Support entry. */
const CLI_HOME_NAMES = [".trae-cn", ".trae"];
/** Basename of the CLI's persisted bare JWT. */
const TRAE_CLI_TOKEN_FILENAME = "trae-jwt-token";
/** The descriptor this backend registers under. */
const TRAE_DESCRIPTOR = {
	id: "trae",
	displayName: "Trae",
	description: "字节 Trae / TRAE SOLO 桌面端内置模型（国内版与国际版并行）",
	brand: {
		vendor: "字节跳动",
		product: "Trae"
	},
	authKind: "desktop-adoption",
	multiAccount: true,
	reportsQuota: true,
	reportsTokenUsage: false,
	settingsNs: "llm-trae"
};
/** The region an edition belongs to. */
function regionOfEdition(edition) {
	return edition === "sg" || edition === "solo-sg" ? "ai" : "cn";
}
/**
* Region from the credential's own `userRegion` claim.
*
* The desktop storage spells it as an object (`{"region":"CN"}`) and the app
* logs spell the bare value lowercase (`"sg"`); both are accepted, case-blind,
* because both have been observed in the wild.
*
* @param value - the raw claim.
* @returns the region, or undefined when the claim is absent or unrecognised.
*/
function regionOfUserRegion(value) {
	const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value["region"] : value;
	if (typeof raw !== "string") return void 0;
	const lowered = raw.trim().toLowerCase();
	if (lowered === "cn") return "cn";
	if (lowered === "sg" || lowered === "ai") return "ai";
}
/**
* Every install location worth probing, per platform.
*
* Both platform families are probed on every host rather than branching on
* `process.platform`: the paths are cheap to test, and a user who moved a
* portable install should still be found.
*/
function traeStorageCandidates() {
	const appData = process.env["APPDATA"];
	const candidates = [];
	const editions = [
		"cn",
		"sg",
		"solo",
		"solo-sg"
	];
	if (appData !== void 0 && appData !== "") for (const edition of editions) for (const name of WINDOWS_APP_NAMES[edition]) candidates.push({
		edition,
		path: join(appData, name, "User", "globalStorage", "storage.json"),
		source: "desktop"
	});
	const macRoot = join(homedir(), "Library", "Application Support");
	for (const edition of editions) candidates.push({
		edition,
		path: join(macRoot, APP_NAMES[edition], "User", "globalStorage", "storage.json"),
		source: "desktop"
	});
	for (const home of CLI_HOME_NAMES) candidates.push({
		edition: home === ".trae-cn" ? "cn" : "sg",
		path: join(homedir(), home, TRAE_CLI_TOKEN_FILENAME),
		source: "cli"
	});
	return candidates;
}
/**
* Read a Trae sign-in from one candidate file.
*
* Returns undefined rather than throwing for every ordinary failure — a missing
* file, unparseable JSON, a document with no token. The caller probes many
* candidates and only the ABSENCE of all of them is a reportable condition.
*
* @param text - the file's contents.
* @param candidate - which install it came from.
* @returns the credential, or undefined when unusable.
*/
function parseTraeCredential(text, candidate) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return;
	}
	if (candidate.source === "cli") {
		const token = text.trim().replace(/^"|"$/gu, "");
		if (token === "") return void 0;
		return {
			edition: candidate.edition,
			source: "cli",
			region: regionOfEdition(candidate.edition),
			userId: "cli",
			token,
			path: candidate.path
		};
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const record = findAuthRecord(value);
	if (record === void 0) return void 0;
	const token = firstString(record, [
		"token",
		"accessToken",
		"access_token",
		"jwt"
	]);
	if (token === void 0) return void 0;
	const region = regionOfUserRegion(record["userRegion"]) ?? regionOfEdition(candidate.edition);
	const userId = firstString(record, [
		"userId",
		"user_id",
		"uid",
		"accountId"
	]) ?? "unknown";
	const accountName = firstString(record, [
		"accountName",
		"account_name",
		"nickname",
		"name"
	]);
	return {
		edition: candidate.edition,
		source: "desktop",
		region,
		userId,
		...accountName === void 0 ? {} : { accountName },
		token,
		path: candidate.path
	};
}
/** Depth-first search for the auth record by shape. */
function findAuthRecord(node, depth = 0) {
	if (depth > 6) return void 0;
	if (typeof node !== "object" || node === null) return void 0;
	if (Array.isArray(node)) {
		for (const entry of node) {
			const found = findAuthRecord(entry, depth + 1);
			if (found !== void 0) return found;
		}
		return;
	}
	const record = node;
	const hasToken = firstString(record, [
		"token",
		"accessToken",
		"access_token",
		"jwt"
	]) !== void 0;
	const hasRegion = record["userRegion"] !== void 0;
	if (hasToken && hasRegion) return record;
	for (const value of Object.values(record)) {
		const found = findAuthRecord(value, depth + 1);
		if (found !== void 0) return found;
	}
}
/** The first non-empty string among the given keys. */
function firstString(record, keys) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
}
/**
* A stable, non-secret account id.
*
* Built from the region and the user id rather than from the token, so the id
* survives a token refresh — an id derived from the credential would change on
* every renewal and orphan the account's usage history and quota cache.
*/
function traeAccountId(credential) {
	return `${credential.region}:${credential.userId}`;
}
/** A masked owner label for the account row. */
function maskOwner(credential) {
	if (credential.accountName !== void 0) return credential.accountName;
	const id = credential.userId;
	if (id === "" || id === "unknown" || id === "cli") return APP_NAMES[credential.edition];
	if (id.length <= 6) return APP_NAMES[credential.edition];
	return APP_NAMES[credential.edition] + " · " + id.slice(0, 3) + "****" + id.slice(-3);
}
/**
* Trae's roster when the live catalog is unreachable.
*
* Mirrors the original plugin's fallback lists: the two regions share model
* NAMES but not their availability, so one shared list would offer models the
* other region cannot serve.
*/
const FALLBACK_MODELS = {
	cn: [{
		id: "deepseek-v4-flash",
		name: "DeepSeek-V4-Flash"
	}, {
		id: "deepseek-v4-pro",
		name: "DeepSeek-V4-Pro"
	}],
	ai: [
		{
			id: "gemini-3-pro",
			name: "Gemini 3 Pro"
		},
		{
			id: "gpt-5.6",
			name: "GPT-5.6"
		},
		{
			id: "minimax-m2.5",
			name: "MiniMax M2.5"
		}
	]
};
/** Trae's product-specific half. */
var TraeImpl = class {
	/** Credentials found by the last discovery, keyed by account id. */
	found = /* @__PURE__ */ new Map();
	async discover() {
		const candidates = traeStorageCandidates();
		let sawAnyInstall = false;
		const accounts = [];
		const seen = /* @__PURE__ */ new Set();
		for (const candidate of candidates) {
			if (!existsSync(candidate.path)) continue;
			sawAnyInstall = true;
			let text;
			try {
				text = await readFile(candidate.path, "utf8");
			} catch {
				continue;
			}
			const credential = parseTraeCredential(text, candidate);
			if (credential === void 0) continue;
			const id = traeAccountId(credential);
			if (seen.has(id)) continue;
			seen.add(id);
			this.found.set(id, credential);
			accounts.push({
				id,
				label: maskOwner(credential),
				detail: credential.region === "cn" ? "国内版" : "国际版",
				usable: true
			});
		}
		if (!sawAnyInstall) throw new BackendUnavailable("未检测到 Trae / TRAE SOLO 桌面端的登录状态；请先安装并登录 Trae 客户端。");
		return accounts;
	}
	async quota(accountId) {
		const credential = this.found.get(accountId);
		if (credential === void 0) return {
			kind: "error",
			message: "Trae 账号已变更，请刷新后重试。"
		};
		return {
			kind: "unavailable",
			reason: credential.region === "cn" ? "Trae 国内版额度需在客户端内查询" : "Trae 国际版为订阅制，无积分余额接口"
		};
	}
	async models(accountId) {
		const credential = this.found.get(accountId);
		if (credential === void 0) return [];
		return FALLBACK_MODELS[credential.region];
	}
};
/** Thin subclass so the concrete type names the backend in stack traces. */
var TraeBackend = class extends BaseBackendAdapter {};
/** The Trae backend, ready to register. */
function createTraeBackend() {
	return new TraeBackend(TRAE_DESCRIPTOR, new TraeImpl());
}
//#endregion
export { createTraeBackend };
