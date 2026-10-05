import { n as BaseBackendAdapter, t as BackendUnavailable } from "./base-B4d56Evj.js";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import "node:fs";
//#region src/backends/codebuddy.ts
/** Environment override naming an explicit auth directory. */
const AUTH_DIR_ENV = "CODEBUDDY_AUTH_DIR";
/** Suffix of the desktop client's credential documents. */
const AUTH_FILE_SUFFIX = ".info";
/** Login domain assumed when the credential carries none. */
const DEFAULT_DOMAIN = "www.codebuddy.cn";
/**
* How long before expiry an access token is treated as spent.
*
* The original plugin refreshes 60s ahead. Without a write path this margin
* only decides whether the account is labelled usable, and 60s is the smallest
* honest number: it is short enough that a live credential is not written off,
* and long enough that a token about to die mid-request is reported now rather
* than after a failed turn.
*/
const EXPIRY_MARGIN_MS = 6e4;
/** Recursion bound for the auth-directory scan (see {@link infoFileCandidates}). */
const MAX_SCAN_DEPTH = 3;
/** Directory entries examined per level, bounding a pathological auth tree. */
const MAX_SCAN_ENTRIES = 500;
/** Subdirectory holding the extension's public data inside the app data root. */
const EXTENSION_DATA_DIR = "CodeBuddyExtension";
/**
* Default per-request output cap, mirroring the original plugin.
*
* A product manifest normally states the real value per model; this is the
* fallback for the built-in \`auto\` entry and for manifests that omit it.
*/
const DEFAULT_MAX_TOKENS = 64e3;
/** Context capacity assumed for a model no manifest describes. */
const DEFAULT_CONTEXT_WINDOW = 1e6;
/**
* Reasoning efforts the CodeBuddy backend accepts.
*
* Declared on every model because the wire request carries \`reasoning_effort\`
* for all of them — the backend streams reasoning regardless of the model name,
* so gating this per model would invent a distinction the vendor does not make.
*/
const REASONING_EFFORTS = [
	"off",
	"low",
	"high",
	"max"
];
/**
* Built-in roster, used when no official client manifest can be read.
*
* Deliberately minimal, for the same reason the original plugin keeps only
* \`auto\`: it is the one id guaranteed to survive a subscription change. A
* longer hand-written list would go stale silently and then fail every turn
* that picked an id the account no longer has.
*/
const FALLBACK_MODELS = [{
	id: "auto",
	name: "Auto",
	contextWindow: DEFAULT_CONTEXT_WINDOW,
	maxTokens: DEFAULT_MAX_TOKENS
}];
/** The descriptor this backend registers under. */
const CODEBUDDY_DESCRIPTOR = {
	id: "codebuddy",
	displayName: "CodeBuddy",
	description: "腾讯 CodeBuddy 桌面端内置模型",
	brand: {
		vendor: "腾讯",
		product: "CodeBuddy"
	},
	authKind: "desktop-adoption",
	multiAccount: false,
	reportsQuota: false,
	reportsTokenUsage: false,
	settingsNs: "llm-codebuddy"
};
/**
* Candidate auth directories, computed fresh on every call.
*
* Read lazily rather than captured at module load so a test (or a user) that
* sets \`LOCALAPPDATA\` before the first probe still gets the right answer.
*
* All three platform layouts are enumerated rather than branching on
* \`process.platform\`, matching the sibling Loomy and MiMo backends: a moved or
* cross-platform-synced install is then still found, and there is no branch to
* get wrong.
*
* @returns candidate directories, most likely first.
*/
function codeBuddyAuthDirs() {
	const home = homedir();
	const dirs = [];
	const local = process.env["LOCALAPPDATA"];
	if (local !== void 0 && local !== "") dirs.push(join(local, EXTENSION_DATA_DIR, "Data", "Public", "auth"));
	dirs.push(join(home, "AppData", "Local", EXTENSION_DATA_DIR, "Data", "Public", "auth"));
	dirs.push(join(home, "Library", "Application Support", EXTENSION_DATA_DIR, "Data", "Public", "auth"));
	const xdg = process.env["XDG_DATA_HOME"];
	if (xdg !== void 0 && xdg !== "") dirs.push(join(xdg, EXTENSION_DATA_DIR, "Data", "Public", "auth"));
	dirs.push(join(home, ".local", "share", EXTENSION_DATA_DIR, "Data", "Public", "auth"));
	return [...new Set(dirs)];
}
/**
* Enumerate candidate credential files under {@link codeBuddyAuthDirs}.
*
* The original implementation reads only the top level of each directory. That
* is fine for the layout CodeBuddy currently ships, but "no usable login" and
* "no login file where we happened to look" are indistinguishable from the
* outside, and only one of them is true. A shallow, bounded walk costs one
* \`readdir\` on a directory that holds a handful of entries and turns a silent
* miss into a hit — while the entry and depth caps keep a pathological tree
* from stalling startup.
*
* Sorted for determinism: two runs on the same machine must pick the same
* account, otherwise an unrelated file appearing (a second WorkBuddy profile)
* would silently switch which account the dashboard is showing.
*
* @returns absolute paths, top-level files first, then deeper ones.
*/
async function infoFileCandidates() {
	const overrideDir = process.env[AUTH_DIR_ENV];
	const roots = overrideDir !== void 0 && overrideDir !== "" ? [overrideDir, ...codeBuddyAuthDirs()] : codeBuddyAuthDirs();
	const found = [];
	const seen = /* @__PURE__ */ new Set();
	const walk = async (dir, depth) => {
		let entries;
		try {
			entries = await readdir(dir);
		} catch {
			return;
		}
		for (const entry of entries.slice(0, MAX_SCAN_ENTRIES)) {
			const full = join(dir, entry);
			if (entry.endsWith(AUTH_FILE_SUFFIX)) {
				if (seen.has(full)) continue;
				seen.add(full);
				found.push(full);
				continue;
			}
			if (depth >= MAX_SCAN_DEPTH) continue;
			let isDirectory = false;
			try {
				isDirectory = (await stat(full)).isDirectory();
			} catch {
				continue;
			}
			if (!isDirectory) continue;
			await walk(full, depth + 1);
		}
	};
	for (const root of roots) await walk(root, 1);
	return found;
}
/** A JSON object that is not an array. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** A non-empty trimmed string, or undefined. */
function nonEmptyString(value) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
/**
* Derive the account identity from the credential document.
*
* \`uid\` is preferred because it is the per-person key the other backends in
* this catalogue also use; \`enterpriseId\` identifies a tenant, which two
* colleagues share, so it is usable but weaker. When neither is present the
* account is keyed off its FILE NAME: a doc with no identity at all still needs
* a stable key, and the file is what made it discoverable — inventing a
* placeholder id would collide across machines in the ledger.
*
* @param document - the parsed credential document.
* @param file - the path it was read from, used for the file-derived key.
* @returns the identity.
*/
function identityOf(document, file) {
	const account = isRecord(document["account"]) ? document["account"] : {};
	const uid = nonEmptyString(account["uid"]);
	const enterpriseId = nonEmptyString(account["enterpriseId"]);
	const nickname = nonEmptyString(account["nickname"]);
	return {
		id: uid ?? enterpriseId ?? fileBaseName(file),
		label: nickname ?? (uid !== void 0 ? "CodeBuddy · " + maskId(uid) : "CodeBuddy 账号"),
		source: uid !== void 0 ? "uid" : enterpriseId !== void 0 ? "enterprise" : "file"
	};
}
/** The credential file's base name without its \`.info\` suffix. */
function fileBaseName(file) {
	const base = file.split(/[\\/]/u).pop() ?? file;
	return base.endsWith(AUTH_FILE_SUFFIX) ? base.slice(0, -5) : base;
}
/**
* Mask an identifier for display.
*
* Idempotent on an already-masked value, for the same reason Loomy's phone
* masker is: one build may store the raw id and another the masked form, and
* re-masking the masked string would destroy characters the user recognises.
*
* A SHORT identifier is masked entirely rather than passed through. The
* earlier "return it unchanged when it is short" branch looked harmless and was
* the opposite: a 6-character id is exactly what a staff number or a short
* tenant handle looks like, and it was the one input the function rendered in
* full. There is no safe window to show in a value that short, so none is
* shown — the row still identifies the account by its backend and nickname.
*
* @param value - raw or already-masked identifier.
* @returns the masked form; never the raw input.
*/
function maskId(value) {
	if (value.includes("*")) return value;
	if (value.length <= 6) return "•".repeat(Math.max(4, value.length));
	return value.slice(0, 3) + "****" + value.slice(-3);
}
/**
* Parse one CodeBuddy \`*.info\` document.
*
* Returns undefined for anything that cannot yield a usable bearer token —
* malformed JSON, a JSON scalar, an empty \`auth\` block, a document whose access
* token is missing. A parse failure is a definite answer about THIS file, and
* the caller must not paper over it by trying a different source.
*
* @param text - raw file contents.
* @param file - the path it was read from, used for the file-derived key.
* @returns the credential, or undefined when unusable.
*/
function parseCodeBuddyAuth(text, file = "") {
	let parsed;
	try {
		parsed = JSON.parse(text.replace(/^\uFEFF/u, ""));
	} catch {
		return;
	}
	if (!isRecord(parsed)) return void 0;
	const auth = isRecord(parsed["auth"]) ? parsed["auth"] : {};
	const accessToken = nonEmptyString(auth["accessToken"]);
	if (accessToken === void 0) return void 0;
	const expiresAt = typeof auth["expiresAt"] === "number" && Number.isFinite(auth["expiresAt"]) ? auth["expiresAt"] : 0;
	const domain = nonEmptyString(auth["domain"]);
	return {
		accessToken,
		expiresAt,
		...domain === void 0 ? {} : { domain },
		identity: identityOf(parsed, file)
	};
}
/** Whether a stated expiry has already passed (or is about to). */
function isExpired(credential, nowMs = Date.now()) {
	return credential.expiresAt > 0 && nowMs + EXPIRY_MARGIN_MS >= credential.expiresAt;
}
/**
* Locate the official client's \`product.json\` manifests.
*
* Roots are the same ones the original implementation scans: the VSCode-family
* extension directories plus CodeBuddy's own. Names are matched loosely (any
* directory mentioning the official publisher AND \`product.json\` present)
* rather than against the exact \`tencent-cloud.coding-copilot-<version>\`
* prefix, because the publisher renames its extension folder between releases
* and a rename would otherwise silently downgrade every model to the fallback
* capacities.
*
* @returns candidate manifest paths, newest-looking name first.
*/
function codeBuddyProductCandidates() {
	const home = homedir();
	const local = process.env["LOCALAPPDATA"];
	const roots = [
		join(home, ".vscode", "extensions"),
		join(home, ".vscode-insiders", "extensions"),
		join(home, ".codebuddy", "extensions")
	];
	if (local !== void 0 && local !== "") roots.push(join(local, EXTENSION_DATA_DIR, "extensions"));
	roots.push(join(home, "AppData", "Local", EXTENSION_DATA_DIR, "extensions"));
	roots.push(join(home, "Library", "Application Support", EXTENSION_DATA_DIR, "extensions"));
	return [...new Set(roots)];
}
/** A positive safe integer wire value, or undefined. */
function positiveInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
/**
* Parse an official manifest's \`models\` array into the neutral vocabulary.
*
* Two filters are load-bearing and both come from the original implementation:
* \`productName\` must literally be \`CodeBuddy\`, so an unrelated extension's
* manifest in the same directory cannot masquerade as the roster; and rows
* carrying \`supportsExtra\` are dropped because they are completion/auxiliary
* entries that cannot serve a chat turn — offering one in the picker would
* produce a model that fails on first use.
*
* @param product - the parsed \`product.json\` value.
* @returns the models it declares, or undefined when this is not the manifest.
*/
function parseCodeBuddyModels(product) {
	if (!isRecord(product)) return void 0;
	if (product["productName"] !== "CodeBuddy") return void 0;
	const rows = product["models"];
	if (!Array.isArray(rows)) return void 0;
	const models = [];
	const seen = /* @__PURE__ */ new Set();
	for (const row of rows) {
		if (!isRecord(row)) continue;
		const entry = row;
		const id = nonEmptyString(entry.id);
		if (id === void 0 || seen.has(id)) continue;
		if (entry.supportsExtra === true) continue;
		seen.add(id);
		models.push({
			id,
			name: nonEmptyString(entry.name) ?? id,
			...positiveInteger(entry.maxInputTokens) === void 0 ? {} : { contextWindow: positiveInteger(entry.maxInputTokens) },
			...positiveInteger(entry.maxOutputTokens) === void 0 ? {} : { maxTokens: positiveInteger(entry.maxOutputTokens) },
			...entry.supportsImages === true ? { supportsImages: true } : {},
			efforts: REASONING_EFFORTS
		});
	}
	return models.length > 0 ? models : void 0;
}
/**
* Read the first readable official manifest.
*
* Scanning is separate from parsing so a broken or renamed manifest falls
* through to the next candidate rather than collapsing the whole roster.
*
* @returns the models from the best manifest found, or undefined.
*/
async function readOfficialModels() {
	for (const root of codeBuddyProductCandidates()) {
		let entries;
		try {
			entries = await readdir(root);
		} catch {
			continue;
		}
		const dirs = entries.filter((entry) => entry.includes("coding-copilot")).sort().reverse();
		for (const dir of dirs) {
			const file = join(root, dir, "product.json");
			let raw;
			try {
				raw = await readFile(file, "utf8");
			} catch {
				continue;
			}
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				continue;
			}
			const models = parseCodeBuddyModels(parsed);
			if (models !== void 0) return models;
		}
	}
}
/** CodeBuddy's product-specific half. */
var CodeBuddyImpl = class {
	async discover() {
		const files = await infoFileCandidates();
		if (files.length === 0) throw new BackendUnavailable("未检测到腾讯 CodeBuddy 桌面端的登录状态；请先安装并登录 CodeBuddy（或 WorkBuddy）桌面端，登录后重新连接。");
		for (const file of files) {
			let text;
			try {
				text = await readFile(file, "utf8");
			} catch {
				continue;
			}
			const credential = parseCodeBuddyAuth(text, file);
			if (credential === void 0) continue;
			const expired = isExpired(credential);
			const detail = (credential.domain ?? DEFAULT_DOMAIN) + " · " + sourceLabel(credential.identity.source);
			return [{
				id: credential.identity.id,
				label: credential.identity.label,
				detail,
				usable: !expired,
				...expired ? { reason: "登录令牌已过期，请在 CodeBuddy 桌面端重新登录（本插件不会改写桌面端登录文件）" } : {}
			}];
		}
		return [];
	}
	async models() {
		return await readOfficialModels() ?? FALLBACK_MODELS;
	}
};
/** A short Chinese description of where the identity came from. */
function sourceLabel(source) {
	if (source === "uid") return "来自桌面端登录状态";
	if (source === "enterprise") return "企业版账号";
	return "本地登录文件";
}
/** Thin subclass so the concrete type names the backend in stack traces. */
var CodeBuddyBackend = class extends BaseBackendAdapter {};
/** The CodeBuddy backend, ready to register. */
function createCodeBuddyBackend() {
	return new CodeBuddyBackend(CODEBUDDY_DESCRIPTOR, new CodeBuddyImpl());
}
//#endregion
export { createCodeBuddyBackend };
