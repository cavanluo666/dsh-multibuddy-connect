import { n as BaseBackendAdapter, r as messageOf, t as BackendUnavailable } from "./base-DPIOH9ta.js";
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
/** 后端 origin：聊天与刷新共用同一台主机，只有路径不同。 */
const BACKEND_ORIGIN = "https://copilot.tencent.com";
/**
* OpenAI 兼容的 base URL，**不含** `/chat/completions`。
*
* 上游路由是 `/v2/chat/completions`，最后一段由 SDK 自己补上，所以这里必须停在
* `/v2`。把完整路径交出去会拼成 `/v2/chat/completions/chat/completions` —— 这种错误
* 在注册阶段看不出来，只在用户发出第一条消息时才会暴露。
*/
const CHAT_BASE_URL = BACKEND_ORIGIN + "/v2";
/** 刷新令牌的端点；它只签发新 token，不报告任何余额。 */
const REFRESH_URL = BACKEND_ORIGIN + "/v2/plugin/auth/token/refresh";
/**
* 单次刷新请求的超时上限。
*
* 刷新发生在请求路径上（用户正等着回复），一次挂起的网络不能把整轮对话钉住。
*/
const REFRESH_TIMEOUT_MS = 15e3;
/**
* 刷新请求自报的 User-Agent。
*
* 端点认的是 `X-Refresh-Token` 而不是 UA，但兄弟路径（WorkBuddy，见
* `src/upstream.ts`）同样自报身份而不伪装桌面端，而「本插件」是能兑现的说法。刻意
* 不复制桌面客户端的指纹：那是本适配器背书不了的声明。
*/
const REFRESH_USER_AGENT = "dsh-multibuddy-connect";
/**
* 刷新响应既没给 `expiresAt` 也没给 `expiresIn` 时，假定的新 token 寿命。
*
* 刻意取短。另一种做法 —— 把「没写过期时间」当成「永不过期」—— 会让新 token 在
* 进程生命周期内一直被复用、连文件都不再重读，于是一个已经作废的 token 会一路 401
* 到重启为止。十分钟的代价只是厂商两个字段都缺失时多刷新一次；而参考实现用
* `Date.now()` 兜底，反而会把一个完全可用的新 token 当场判死。
*/
const REFRESH_FALLBACK_TTL_MS = 6e5;
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
* fallback for the built-in `auto` entry and for manifests that omit it.
*/
const DEFAULT_MAX_TOKENS = 64e3;
/** Context capacity assumed for a model no manifest describes. */
const DEFAULT_CONTEXT_WINDOW = 1e6;
/**
* Reasoning efforts the CodeBuddy backend accepts.
*
* Declared on every model because the wire request carries `reasoning_effort`
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
* `auto`: it is the one id guaranteed to survive a subscription change. A
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
	settingsNs: "llm-codebuddy",
	serves: true
};
/**
* Candidate auth directories, computed fresh on every call.
*
* Read lazily rather than captured at module load so a test (or a user) that
* sets `LOCALAPPDATA` before the first probe still gets the right answer.
*
* All three platform layouts are enumerated rather than branching on
* `process.platform`, matching the sibling Loomy and MiMo backends: a moved or
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
* `readdir` on a directory that holds a handful of entries and turns a silent
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
* `uid` is preferred because it is the per-person key the other backends in
* this catalogue also use; `enterpriseId` identifies a tenant, which two
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
		source: uid !== void 0 ? "uid" : enterpriseId !== void 0 ? "enterprise" : "file",
		...uid === void 0 ? {} : { uid },
		...enterpriseId === void 0 ? {} : { enterpriseId }
	};
}
/** The credential file's base name without its `.info` suffix. */
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
* Parse one CodeBuddy `*.info` document.
*
* Returns undefined for anything that cannot yield a usable bearer token —
* malformed JSON, a JSON scalar, an empty `auth` block, a document whose access
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
	const refreshToken = nonEmptyString(auth["refreshToken"]) ?? "";
	const expiresAt = typeof auth["expiresAt"] === "number" && Number.isFinite(auth["expiresAt"]) ? auth["expiresAt"] : 0;
	const domain = nonEmptyString(auth["domain"]);
	return {
		accessToken,
		refreshToken,
		expiresAt,
		...domain === void 0 ? {} : { domain },
		identity: identityOf(parsed, file)
	};
}
/**
* 一个「明确声明过的」过期时刻是否已经到达（或即将到达）。
*
* 抽成独立函数，是因为内存里刷新出来的 token 只有 `expiresAt`、没有完整的凭据文档，
* 却必须和文件里的 token 用同一条规则判断过期 —— 两条规则迟早会分叉，而分叉的表现
* 是「内存里的 token 明明死了还在用」。
*/
function expiryReached(expiresAt, nowMs) {
	return expiresAt > 0 && nowMs + EXPIRY_MARGIN_MS >= expiresAt;
}
/** Whether a stated expiry has already passed (or is about to). */
function isExpired(credential, nowMs = Date.now()) {
	return expiryReached(credential.expiresAt, nowMs);
}
/**
* Locate the official client's `product.json` manifests.
*
* Roots are the same ones the original implementation scans: the VSCode-family
* extension directories plus CodeBuddy's own. Names are matched loosely (any
* directory mentioning the official publisher AND `product.json` present)
* rather than against the exact `tencent-cloud.coding-copilot-<version>`
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
* Parse an official manifest's `models` array into the neutral vocabulary.
*
* Two filters are load-bearing and both come from the original implementation:
* `productName` must literally be `CodeBuddy`, so an unrelated extension's
* manifest in the same directory cannot masquerade as the roster; and rows
* carrying `supportsExtra` are dropped because they are completion/auxiliary
* entries that cannot serve a chat turn — offering one in the picker would
* produce a model that fails on first use.
*
* @param product - the parsed `product.json` value.
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
/** 一个正数，或 undefined。 */
function positiveFinite(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
/**
* 按顺序读取并解析每一个候选凭据文件。
*
* 凭据读取只发生在这一处：discover 要列账号，transport 每次请求要取 token，两处各写
* 一遍解析循环迟早会分叉（比如新字段只有一处学会读）。一个候选文件都没有时抛
* {@link BackendUnavailable} —— 那是「客户端没装」而不是「没登录」，只有前者配得上
* 那句安装提示。
*
* @returns 所有能解析出 token 的凭据，按候选顺序。
*/
async function readCredentials() {
	const files = await infoFileCandidates();
	if (files.length === 0) throw new BackendUnavailable("未检测到腾讯 CodeBuddy 桌面端的登录状态；请先安装并登录 CodeBuddy（或 WorkBuddy）桌面端，登录后重新连接。");
	const credentials = [];
	for (const file of files) {
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch {
			continue;
		}
		const credential = parseCodeBuddyAuth(text, file);
		if (credential !== void 0) credentials.push(credential);
	}
	return credentials;
}
/**
* 读一次刷新响应，成功时给出新 token 的事实。
*
* 只有 `code === 0` 且真的带回 accessToken 才算成功。刷新端点和聊天端点共用同一套
* 信封，「HTTP 200」本身不是成功：把它当成功会让路由带着一个空 key 出去，用户看到的
* 会是厂商的 401，而不是这里本来就能说清楚的「请重新登录」。
*
* `expiresAt` 按 epoch 毫秒解读，与凭据文件里的字段同一套单位（见
* {@link parseCodeBuddyAuth} / {@link isExpired}）；部分部署只给秒级的 `expiresIn`，
* 两种都认。两个字段都没有时退回 {@link REFRESH_FALLBACK_TTL_MS}。
*
* @param response - 刷新端点的响应。
* @returns 新 token 及其过期时刻。
*/
async function readRefreshResult(response) {
	let text = "";
	try {
		text = await response.text();
	} catch {}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = void 0;
	}
	const envelope = isRecord(parsed) ? parsed : {};
	const data = isRecord(envelope["data"]) ? envelope["data"] : {};
	const accessToken = nonEmptyString(data["accessToken"]);
	if (!response.ok || envelope["code"] !== 0 || accessToken === void 0) {
		const detail = nonEmptyString(envelope["msg"]) ?? (text === "" ? "HTTP " + response.status : text.slice(0, 200));
		throw new Error("刷新 CodeBuddy 登录令牌被拒绝（" + detail + "）：请在 CodeBuddy 桌面端重新登录后重试");
	}
	const expiresAtMs = positiveFinite(data["expiresAt"]);
	const expiresInSec = positiveFinite(data["expiresIn"]);
	const stated = expiresAtMs ?? (expiresInSec === void 0 ? void 0 : Date.now() + expiresInSec * 1e3);
	const expiresAt = stated === void 0 || stated <= Date.now() ? Date.now() + REFRESH_FALLBACK_TTL_MS : stated;
	const rotated = nonEmptyString(data["refreshToken"]);
	return {
		accessToken,
		expiresAt,
		...rotated === void 0 ? {} : { refreshToken: rotated }
	};
}
/** CodeBuddy's product-specific half. */
var CodeBuddyImpl = class {
	/**
	* 内存里刷新得到的 token；undefined 表示还没刷新过。
	*
	* 放在 Impl 上而不是 resolveApiKey 的闭包里：transport 会被调用多次，闭包级缓存
	* 会让同一份 refreshToken 被拿去刷新两次，而刷新令牌是轮换的 —— 第二次用旧令牌
	* 换，轻则失败，重则把刚拿到的新令牌也一起作废。
	*/
	memory;
	/** 正在进行的刷新；见 {@link CodeBuddyImpl.refreshInMemory}。 */
	refreshing;
	async discover() {
		const credential = (await readCredentials())[0];
		if (credential === void 0) return [];
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
	async models() {
		return await readOfficialModels() ?? FALLBACK_MODELS;
	}
	/**
	* CodeBuddy 的 OpenAI 兼容传输。
	*
	* 三个事实的来源：
	*
	*  - baseUrl：固定的官方主机加 `/v2`（见 {@link CHAT_BASE_URL}）；
	*  - models：官方客户端 `product.json` 的解析结果（{@link parseCodeBuddyModels}），
	*    读不到才退回内置的 `auto`；
	*  - key：桌面端登录文件里的 accessToken，**每次请求现取**（见
	*    {@link CodeBuddyImpl.accessTokenFor}）。
	*
	* 与 `usable` 的区别值得写下来：`discover` 用 `usable: false` 描述「文件里的凭据
	* 已经过期」，而 transport 描述的是「这条路由现在还能不能干活」。两者可以同时成立
	* —— 文件里的 token 死了，而 resolveApiKey 能在内存里换一个新的 —— 所以这里不因
	* `usable: false` 就拒绝提供传输。
	*
	* 唯一的「没得服务」情形在这里挡掉：一个能解析的凭据都没有（客户端没装，或用户还
	* 没登录）时返回 undefined，shell 于是干脆不注册 provider，与 cline.ts、opencode.ts
	* 的做法一致。这只是一次存在性探测：凭据检查刻意**不**靠抛错来完成，因为
	* {@link BaseBackendAdapter.transport} 会把本方法抛出的任何错误吞成 undefined，
	* shell 同样不会注册 provider，用户却连一句解释都看不到 —— 而账号卡片会按登录状态
	* 把该做的事说清楚。真正拿不到可用凭据时由 resolveApiKey 抛错，harness 会把那句话
	* 渲染给用户，这比发一个未认证的请求、再把厂商的 401 抛出来好得多。
	*
	* @param accountId - 要服务的账号；空串表示「没有偏好」，此时取第一个可用登录。
	* @returns 传输，或一个能解析的凭据都没有时的 undefined。
	*/
	async transport(accountId) {
		try {
			await this.credentialFor(accountId);
		} catch {
			return;
		}
		return {
			baseUrl: CHAT_BASE_URL,
			models: await this.models(),
			resolveApiKey: () => this.accessTokenFor(accountId)
		};
	}
	/**
	* 取本次请求要用的 bearer key。
	*
	* 三步，顺序有讲究：
	*
	*  1. 文件里的 token 还活着 —— 直接用。文件始终是第一事实来源，这个顺序让用户刚在
	*     桌面端重新登录时立刻切到新凭据。
	*  2. 文件里的 token 将过期，但内存里换过的那个还没过期 —— 用内存的那个。因为刷新
	*     结果不回写文件，续期之后文件会永远停在旧 token 上，所以这一步是稳态路径而不是
	*     异常路径。
	*  3. 两个都不能用 —— 在内存里刷新一次。刷新失败就抛错，让用户看到「请重新登录」，
	*     而不是让请求带着一个死 token 出去换一个 401 回来。
	*
	* 每次调用都重读凭据文件（一次有界的目录扫描 + 一次读文件）。这是有意的：磁盘上的
	* 文件才是真相，缓存反而会让桌面端重新登录之后的账号切换延迟生效。
	*
	* @param accountId - 要服务的账号；CodeBuddy 只有一个登录槽，所以它主要用来对号。
	* @returns 本次请求要带的 bearer key。
	*/
	async accessTokenFor(accountId) {
		const credential = await this.credentialFor(accountId);
		if (!isExpired(credential)) return credential.accessToken;
		const memory = this.memory;
		if (memory !== void 0 && memory.accountId === credential.identity.id && !expiryReached(memory.expiresAt, Date.now())) return memory.accessToken;
		return (await this.refreshInMemory(credential)).accessToken;
	}
	/**
	* 定位这个 accountId 对应的凭据。
	*
	* accountId 在 CodeBuddy 上只是标识（`multiAccount: false`，一台机器只有一个登录
	* 槽），所以先按 id 精确匹配；匹配不上就退回第一个能解析的凭据 —— 单槽产品的「当前
	* 凭据」本来就只有那一个，而如果用户在桌面端重新登录换了 uid，shell 手里可能还握着
	* 旧 id，这时直接失败会把一条本来能用的路由钉死。
	*
	* @param accountId - 要定位的账号标识。
	* @returns 它的凭据；一个都读不到时抛错（错误文案就是给用户看的那句话）。
	*/
	async credentialFor(accountId) {
		const credentials = await readCredentials();
		const credential = credentials.find((candidate) => candidate.identity.id === accountId) ?? credentials[0];
		if (credential === void 0) throw new Error("CodeBuddy 未找到可用的登录凭据：请在 CodeBuddy 桌面端登录后重试（本插件不会改写桌面端登录文件）");
		return credential;
	}
	/**
	* 在内存里刷新一次 token（单飞）。
	*
	* 同一时刻只允许一个刷新在跑，其余调用等它的结果：刷新令牌是轮换的，两个并发刷新
	* 拿着同一个旧令牌，第二个大概率失败，甚至可能把第一个刚换来的新令牌一起作废。
	* CodeBuddy 只有一个登录槽，所以一把锁覆盖所有账号就够了。
	*
	* @param credential - 文件里那份（可能已过期的）凭据。
	* @returns 内存里的新 token。
	*/
	refreshInMemory(credential) {
		const running = this.refreshing;
		if (running !== void 0) return running;
		const started = this.performRefresh(credential);
		this.refreshing = started;
		const release = () => {
			this.refreshing = void 0;
		};
		started.then(release, release);
		return started;
	}
	/**
	* 真正发出一次刷新请求；只由 {@link CodeBuddyImpl.refreshInMemory} 调用以串行化。
	*
	* @param credential - 文件里那份凭据。
	* @returns 缓存进内存的新 token。
	*/
	async performRefresh(credential) {
		const previous = this.memory;
		const refreshToken = previous !== void 0 && previous.accountId === credential.identity.id && previous.refreshToken !== "" ? previous.refreshToken : credential.refreshToken;
		if (refreshToken === "") throw new Error("CodeBuddy 登录令牌已过期，且本地凭据不含 refreshToken，无法自动续期：请在 CodeBuddy 桌面端重新登录后重试（本插件不会改写桌面端登录文件）");
		const domain = credential.domain ?? DEFAULT_DOMAIN;
		let response;
		try {
			response = await fetch(REFRESH_URL, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json",
					authorization: "Bearer " + credential.accessToken,
					"x-user-id": credential.identity.uid ?? "",
					"x-enterprise-id": credential.identity.enterpriseId ?? "",
					"x-tenant-id": credential.identity.enterpriseId ?? "",
					"x-domain": domain,
					"user-agent": REFRESH_USER_AGENT,
					"x-refresh-token": refreshToken,
					"x-auth-refresh-source": "plugin"
				},
				body: "{}",
				signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS)
			});
		} catch (error) {
			throw new Error("刷新 CodeBuddy 登录令牌失败（网络错误）：" + messageOf(error) + "；请检查网络，或在 CodeBuddy 桌面端重新登录后重试");
		}
		const result = await readRefreshResult(response);
		const next = {
			accountId: credential.identity.id,
			accessToken: result.accessToken,
			expiresAt: result.expiresAt,
			refreshToken: result.refreshToken ?? refreshToken
		};
		this.memory = next;
		return next;
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
