import { n as BaseBackendAdapter, t as BackendUnavailable } from "./base-DPIOH9ta.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
//#region src/backends/loomy.ts
/**
* Loomy (讯飞) — a desktop-adoption backend.
*
* Loomy writes its sign-in session to an Electron data directory. The JSON
* sidecar is read here, read-only. Loomy is a SINGLE-ACCOUNT product: the
* desktop app holds one sign-in and the plugin cannot start a second one, so
* `multiAccount` is false in the descriptor — a statement about the vendor's
* model rather than a limitation of this adapter.
*
* @module dsh-workbuddy-connect/backends/loomy
*/
/** Environment overrides, matching the upstream plugin's published names. */
const AUTH_FILE_ENV = "LOOMY_AUTH_FILE";
const CONFIG_FILE_ENV = "LOOMY_CONFIG_FILE";
/** The descriptor this backend registers under. */
const LOOMY_DESCRIPTOR = {
	id: "loomy",
	displayName: "Loomy",
	description: "讯飞 Loomy 桌面应用内置模型",
	brand: {
		vendor: "讯飞",
		product: "Loomy"
	},
	authKind: "desktop-adoption",
	multiAccount: false,
	reportsQuota: true,
	reportsTokenUsage: false,
	settingsNs: "llm-loomy"
};
/**
* Candidate locations of Loomy's sign-in file.
*
* macOS first, then Windows, matching the upstream probe order. Both are
* checked on every platform rather than branching on `process.platform`, so a
* moved or non-standard install is still found.
*/
function loomyAuthCandidates() {
	const appData = process.env["APPDATA"];
	const candidates = [join(homedir(), "Library", "Application Support", "loomy", "auth-session.json")];
	if (appData !== void 0 && appData !== "") candidates.push(join(appData, "loomy", "auth-session.json"));
	return candidates;
}
/** Candidate locations of Loomy's generated model manifest. */
function loomyConfigCandidates() {
	const appData = process.env["APPDATA"];
	const candidates = [join(homedir(), ".config", "loomy-opencode", "opencode.json")];
	if (appData !== void 0 && appData !== "") candidates.push(join(appData, "loomy-opencode", "opencode.json"));
	return candidates;
}
/** The first existing path, or undefined when none exists. */
function firstExisting(candidates) {
	return candidates.find((candidate) => existsSync(candidate));
}
/**
* Mask a phone number for display.
*
* Idempotent on an already-masked value: the macOS build stores the masked
* form and the Windows build the raw one, and re-masking a masked string would
* discard information. Checking for an existing asterisk first makes the two
* builds converge on one rendering.
*
* @param value - raw or already-masked phone.
* @returns the masked form.
*/
function maskPhone(value) {
	if (value.includes("*")) return value;
	if (/^\d{11}$/u.test(value)) return `${value.slice(0, 3)}****${value.slice(7)}`;
	if (value.length <= 4) return value;
	return `${value.slice(0, Math.ceil(value.length / 3))}****${value.slice(-Math.ceil(value.length / 4))}`;
}
/** Parse Loomy's sign-in document. */
function parseLoomyAuth(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const record = value;
	const session = typeof record["session"] === "string" ? record["session"].trim() : "";
	const userId = typeof record["userid"] === "string" ? record["userid"].trim() : "";
	if (session === "" || userId === "") return void 0;
	const phone = typeof record["maskedPhone"] === "string" && record["maskedPhone"] !== "" ? record["maskedPhone"] : typeof record["phone"] === "string" ? record["phone"] : "";
	return {
		session,
		userId,
		...phone === "" ? {} : { maskedPhone: maskPhone(phone) }
	};
}
/**
* Parse Loomy's `opencode.json` into the neutral model vocabulary.
*
* Only text models are kept: an image-only entry would appear in the picker and
* then fail every request. An entry that declares no modalities at all is kept,
* because the manifest omits the field for its ordinary text models.
*
* @param text - the manifest file's contents.
* @returns the models it declares, in file order.
*/
function parseLoomyModels(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return [];
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	const providers = value["provider"];
	if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return [];
	const out = [];
	for (const provider of Object.values(providers)) {
		if (typeof provider !== "object" || provider === null || Array.isArray(provider)) continue;
		const models = provider["models"];
		if (typeof models !== "object" || models === null || Array.isArray(models)) continue;
		for (const [id, raw] of Object.entries(models)) {
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
			const model = raw;
			const modalities = Array.isArray(model.modalities) ? model.modalities.map(String) : void 0;
			if (modalities !== void 0 && !modalities.includes("text")) continue;
			const contextWindow = typeof model.contextWindow === "number" ? model.contextWindow : typeof model.limit === "number" ? model.limit : void 0;
			out.push({
				id,
				name: typeof model.name === "string" && model.name !== "" ? model.name : id,
				...contextWindow === void 0 ? {} : { contextWindow },
				...typeof model.output === "number" ? { maxTokens: model.output } : {},
				...modalities !== void 0 && modalities.includes("image") ? { supportsImages: true } : {}
			});
		}
	}
	return out;
}
/** Loomy's product-specific half. */
var LoomyImpl = class {
	async discover() {
		const override = process.env[AUTH_FILE_ENV];
		const path = override !== void 0 && override !== "" ? override : firstExisting(loomyAuthCandidates());
		if (path === void 0 || !existsSync(path)) throw new BackendUnavailable("未检测到 Loomy 桌面应用的登录状态；请先在 Loomy 客户端中登录。");
		const credential = parseLoomyAuth(await readFile(path, "utf8"));
		if (credential === void 0) return [];
		return [{
			id: credential.userId,
			label: credential.maskedPhone ?? "Loomy 账号",
			...credential.maskedPhone === void 0 ? {} : { detail: credential.maskedPhone },
			usable: true
		}];
	}
	async quota() {
		return {
			kind: "unavailable",
			reason: "Loomy 积分缓存在客户端本地，本插件不读取"
		};
	}
	async models() {
		const override = process.env[CONFIG_FILE_ENV];
		const path = override !== void 0 && override !== "" ? override : firstExisting(loomyConfigCandidates());
		if (path === void 0) return [];
		try {
			return parseLoomyModels(await readFile(path, "utf8"));
		} catch {
			return [];
		}
	}
};
/** Thin subclass so the concrete type names the backend in stack traces. */
var LoomyBackend = class extends BaseBackendAdapter {};
/** The Loomy backend, ready to register. */
function createLoomyBackend() {
	return new LoomyBackend(LOOMY_DESCRIPTOR, new LoomyImpl());
}
//#endregion
export { maskPhone as a, loomyConfigCandidates as i, createLoomyBackend as n, parseLoomyAuth as o, loomyAuthCandidates as r, parseLoomyModels as s, LOOMY_DESCRIPTOR as t };
