import { n as BaseBackendAdapter, t as BackendUnavailable } from "./base-B4d56Evj.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
//#region src/backends/qoder.ts
/**
* Qoder (Alibaba) — a desktop-adoption backend serving TWO regions.
*
* Qoder CN and international Qoder are parallel products with separate
* accounts, separate gateways, and separate credential files, exactly like
* Trae's two regions. Each is an account of this one backend.
*
* WHAT THIS ADAPTER DOES, AND WHAT IT DELIBERATELY DOES NOT.
*
* Qoder stores its sign-in in a Chromium OSCrypt blob: an AES-256-GCM ciphertext
* whose key is wrapped by the OS keystore — DPAPI on Windows. Unwrapping needs a
* `Crypt32` call, which Node has no binding for, so the original plugin shells
* out to PowerShell and passes the result through a temp FILE rather than a pipe
* (a pipe would be unusable under a sandbox that forbids piped stdio).
*
* Reproducing that chain here would mean copying ~58 KB of key handling whose
* failure modes are silent — a wrong key derivation produces "not signed in"
* rather than an error, which is the worst possible diagnosis. That code is
* therefore NOT reimplemented. What this adapter does instead:
*
*  1. Reports the accounts it can PROVE exist: a region whose app data directory
*     is present, plus any environment PAT the user supplied. Presence is a fact
*     this module can establish without decrypting anything.
*  2. Says plainly, per account, that the browser session must be adopted by the
*     full credential chain when it is not available here.
*
* A half-working decryptor that silently reports "signed out" would be worse
* than an honest gap, because the user would re-sign-in forever without ever
* being told what is actually wrong.
*
* READ-ONLY, and it never spawns a process: this module touches the filesystem
* for existence checks only, so discovery stays fast and side-effect free.
*
* @module dsh-workbuddy-connect/backends/qoder
*/
/** The two products, in display order. */
const QODER_REGIONS = [{
	id: "qoder-cn",
	displayName: "Qoder CN",
	gateway: "https://gateway.qoder.com.cn",
	patEnvNames: [
		"QODERCN_API_KEY",
		"QODERCN_PERSONAL_ACCESS_TOKEN",
		"QODERCN_PAT"
	],
	appDirNames: ["Qoder", "Qoder CN"]
}, {
	id: "qoder",
	displayName: "Qoder",
	gateway: "https://api3.qoder.sh",
	patEnvNames: [
		"QODER_API_KEY",
		"QODER_PERSONAL_ACCESS_TOKEN",
		"QODER_PAT"
	],
	appDirNames: ["Qoder"]
}];
/** The descriptor this backend registers under. */
const QODER_DESCRIPTOR = {
	id: "qoder",
	displayName: "Qoder",
	description: "阿里 Qoder 桌面端模型（国内版与国际版并行）",
	brand: {
		vendor: "阿里巴巴",
		product: "Qoder"
	},
	authKind: "desktop-adoption",
	multiAccount: true,
	reportsQuota: true,
	reportsTokenUsage: false,
	settingsNs: "llm-qoder"
};
/**
* Candidate app data roots per platform.
*
* Trae's lesson applied: both platform families are probed on every host rather
* than branching on `process.platform`, because the check is a cheap existence
* test and a non-standard install should still be found.
*/
function qoderDataRoots() {
	const roots = [];
	const appData = process.env["APPDATA"];
	if (appData !== void 0 && appData !== "") roots.push(appData);
	roots.push(join(homedir(), "Library", "Application Support"));
	const xdg = process.env["XDG_CONFIG_HOME"];
	roots.push(xdg !== void 0 && xdg !== "" ? xdg : join(homedir(), ".config"));
	return roots;
}
/**
* Every directory that would exist if this region's desktop app were installed.
*
* @param spec - the region.
* @returns absolute candidate directories, most-likely first.
*/
function qoderAppDirs(spec) {
	const dirs = [];
	for (const root of qoderDataRoots()) for (const name of spec.appDirNames) dirs.push(join(root, name));
	return dirs;
}
/**
* Whether this region's desktop app is installed.
*
* Decided by the app data DIRECTORY rather than by a credential file: the
* credential's location has moved between releases (`auth.v1.dat` in 0.3.x,
* VS Code's `state.vscdb` before that), while the directory has not. Probing
* for a specific file would report "not installed" for a user who simply has a
* different version.
*
* @param spec - the region.
* @returns true when an app directory exists.
*/
function qoderAppInstalled(spec) {
	return qoderAppDirs(spec).some((dir) => existsSync(dir));
}
/** The first personal access token supplied through the environment. */
function qoderEnvPat(spec, env = process.env) {
	for (const name of spec.patEnvNames) {
		const value = env[name];
		if (typeof value === "string" && value.trim() !== "") return {
			name,
			value: value.trim()
		};
	}
}
/**
* The roster each region serves when its live catalog is unreachable.
*
* The two gateways expose different model sets, so one shared fallback would
* offer models the other region cannot serve — the same reasoning as Trae's.
*/
const FALLBACK_MODELS = {
	"qoder-cn": [
		{
			id: "qwen3.5-max",
			name: "Qwen3.5-Max"
		},
		{
			id: "deepseek-v4",
			name: "DeepSeek-V4"
		},
		{
			id: "glm-5.2",
			name: "GLM-5.2"
		}
	],
	qoder: [
		{
			id: "claude-sonnet-4.6",
			name: "Claude Sonnet 4.6"
		},
		{
			id: "gpt-5.6",
			name: "GPT-5.6"
		},
		{
			id: "gemini-3-pro",
			name: "Gemini 3 Pro"
		}
	]
};
/** Qoder's product-specific half. */
var QoderImpl = class {
	/** What each discovered account actually is, keyed by account id. */
	found = /* @__PURE__ */ new Map();
	async discover() {
		const accounts = [];
		let sawInstalledApp = false;
		for (const spec of QODER_REGIONS) {
			const installed = qoderAppInstalled(spec);
			if (installed) sawInstalledApp = true;
			const pat = qoderEnvPat(spec);
			if (pat !== void 0) {
				const id = `${spec.id}:pat`;
				this.found.set(id, {
					spec,
					via: "pat"
				});
				accounts.push({
					id,
					label: spec.displayName,
					detail: `来自 ${pat.name}`,
					usable: true
				});
				continue;
			}
			if (!installed) continue;
			const id = `${spec.id}:desktop`;
			this.found.set(id, {
				spec,
				via: "desktop"
			});
			accounts.push({
				id,
				label: spec.displayName,
				detail: "已在客户端登录",
				usable: false,
				reason: "Qoder 的登录凭据为系统加密存储，需要完整凭据链才能读取；可改用环境变量 PAT"
			});
		}
		if (!sawInstalledApp && accounts.length === 0) throw new BackendUnavailable("未检测到 Qoder 桌面端；请安装并登录 Qoder 客户端，或设置环境变量 QODERCN_PAT / QODER_PAT。");
		return accounts;
	}
	async quota(accountId) {
		const entry = this.found.get(accountId);
		if (entry === void 0) return {
			kind: "error",
			message: "Qoder 账号已变更，请刷新后重试。"
		};
		if (entry.via === "desktop") return {
			kind: "unavailable",
			reason: "未取得 Qoder 登录凭据，无法查询额度"
		};
		return {
			kind: "unavailable",
			reason: "Qoder 额度需通过网关查询，当前适配层未实现"
		};
	}
	async models(accountId) {
		const entry = this.found.get(accountId);
		if (entry === void 0) return [];
		return FALLBACK_MODELS[entry.spec.id];
	}
};
/** Thin subclass so the concrete type names the backend in stack traces. */
var QoderBackend = class extends BaseBackendAdapter {};
/** The Qoder backend, ready to register. */
function createQoderBackend() {
	return new QoderBackend(QODER_DESCRIPTOR, new QoderImpl());
}
//#endregion
export { createQoderBackend };
