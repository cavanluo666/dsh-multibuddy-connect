import { n as BaseBackendAdapter, t as BackendUnavailable } from "./base-B4d56Evj.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, readdirSync } from "node:fs";
//#region src/backends/opencode.ts
/**
* OpenCode Zen — a managed-runtime backend, merged from the two original
* plugins that reach the same free tier by two different routes.
*
* THE PRODUCT, and why it is unlike every other backend here: OpenCode Zen's
* free models carry a server-side gate. A direct call to
* `https://opencode.ai/zen/v1/chat/completions` is answered with
*
*   FreeTierError: OpenCode's free tier can only be used from within OpenCode
*
* and the measurement that produced this backend's whole shape is that NO
* header or User-Agent change lifts it — nine spellings were tried, all 403.
* Only traffic originating from a genuine OpenCode runtime is accepted. So
* there is no credential to adopt and no key to paste that would work: the
* entity that authenticates is a PROCESS, which is exactly what `authKind:
* 'managed-runtime'` records.
*
* THE TWO ORIGINALS, and what each contributes:
*
*  - `dsh-opencode-xdbridge` (the primary) is the honest route. It resolves a
*    real OpenCode binary — an installation it manages under its own data
*    directory, the user's `opencode` on PATH, or a one-time ~57 MB download
*    of the vendor's npm package — starts it isolated on a loopback port, and
*    speaks to it locally. Its binary resolution order and its data directory
*    layout are mirrored verbatim below.
*  - `dsh-opencode-free-models` (the contrast) is a panel that registers a
*    pi-ai transport against the same host with the literal bearer key
*    `public` and the official client's User-Agent. It is worth reading
*    precisely because it shows what the gate rejects, and it carries one real
*    deployment fact this adapter honours: an operator may raise the free-tier
*    ceiling by exporting `OPENCODE_ZEN_API_KEY`, which the original reads as
*    `OPENCODE_ZEN_API_KEY || OPENCODE_GO_API_KEY || 'public'`. That variable
*    is deliberately NOT treated as readiness below — with no runtime present
*    it authenticates nothing, and reporting it as a usable account would
*    promise exactly the 403 the gate exists to return.
*
* WHAT THIS FILE DELIBERATELY DOES NOT DO. It never downloads, never spawns,
* and never writes. Migration guidance for the xdbridge plugin says its startup
* must not be awaited because preparing the runtime can be a 57 MB download —
* and the shell calls `discover()` on every backend at startup and on every
* manual refresh. A discover that fetched or spawned would therefore stall the
* whole plugin on a first run, which is the one failure mode that would take
* the other backends down with it. {@link OpenCodeImpl.discover} is a pure
* existence probe over named paths; the runtime itself is the child process
* the adapter shell already manages for the original plugin, and mounting it
* belongs to the integration layer, not here.
*
* FREE MODELS COME FROM ONE OF TWO PLACES, and the adapter does not pretend
* otherwise. The runtime is asked for its own catalog first (`GET /provider`,
* the route xdbridge reads), and only that response decides what is free: a
* model counts when every cost dimension is zero. When no runtime is listening
* the roster degrades to the free tier the second original ships as a constant,
* and each entry is labelled as such rather than presented as a live reading.
*
* `multiAccount` is false because the managed runtime starts with a fresh
* random password per launch and grants no second identity — there is
* structurally nothing for an "add account" button to write to. `reportsQuota`
* is false because OpenCode Zen's free tier has no balance endpoint at all: the
* models are free, the process is the entitlement, and a zero on the dashboard
* would read as an exhausted account rather than an absent meter.
*
* @module dsh-workbuddy-connect/backends/opencode
*/
/** The descriptor this backend registers under. */
const OPENCODE_DESCRIPTOR = {
	id: "opencode",
	displayName: "OpenCode Zen",
	description: "OpenCode Zen 免费模型（受管本地运行时）",
	brand: {
		vendor: "OpenCode",
		product: "Zen"
	},
	authKind: "managed-runtime",
	multiAccount: false,
	reportsQuota: false,
	reportsTokenUsage: false,
	settingsNs: "opencode-xdbridge",
	managesRuntime: true
};
/** Environment variable naming the xdbridge data directory. */
const DATA_DIR_ENV = "OPENCODE_XDBRIDGE_DATA_DIR";
/** Environment variable naming an existing OpenCode binary. */
const BINARY_PATH_ENV = "OPENCODE_BINARY_PATH";
/** The runtime provider whose catalog the free tier is read from. */
const RUNTIME_PROVIDER = "opencode";
/** Release-version shape the managed runtime's directory names must follow. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
/** How long any one runtime probe may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 5e3;
/**
* The free tier as the free-models plugin ships it.
*
* Used ONLY when no runtime answers. It exists because the alternative is an
* empty picker on a machine that has a perfectly good runtime whose `/provider`
* route was momentarily busy, and because one of the two originals genuinely
* ships this list as its roster. Each entry is relabelled in the detail line so
* a user looking at a stale id knows which source they are looking at.
*/
const FREE_TIER_FALLBACK = [
	{
		id: "big-pickle",
		name: "Big Pickle",
		contextWindow: 2e5
	},
	{
		id: "mimo-v2.5-free",
		name: "MiMo 2.5",
		contextWindow: 2e5
	},
	{
		id: "hy3-free",
		name: "Hunyuan 3",
		contextWindow: 2e5
	},
	{
		id: "nemotron-3-ultra-free",
		name: "Nemotron 3 Ultra",
		contextWindow: 131072
	},
	{
		id: "nemotron-3.5-lightning-free",
		name: "Nemotron 3.5 Lightning",
		contextWindow: 131072
	},
	{
		id: "muse-spark-1.2-contributor-free",
		name: "Muse Spark 1.2 Contributor",
		contextWindow: 2e5
	}
];
/**
* The Harness home directory.
*
* Mirrors the host's own convention (`$DSH_HOME`, else `~/.dsh`) rather than
* importing the shell's path helper: this module is a leaf, and the one value
* it needs is cheaper to restate than to couple.
*
* @returns the absolute Harness home path.
*/
function dshHome() {
	const explicit = process.env["DSH_HOME"];
	return explicit !== void 0 && explicit.trim() !== "" ? explicit : join(homedir(), ".dsh");
}
/**
* Where the managed runtime, its isolated XDG root and its log live.
*
* Resolution order is the original plugin's: an explicit environment override,
* then a directory inside the Harness home. The path is not a guess — it is the
* one xdbridge itself computes, which is why a runtime installed by the
* original plugin is found here without any migration step.
*
* @returns the absolute data directory path.
*/
function openCodeDataDir() {
	const override = process.env[DATA_DIR_ENV];
	if (override !== void 0 && override.trim() !== "") return override.trim();
	return join(dshHome(), "opencode-xdbridge");
}
/**
* Candidate locations of an OpenCode binary this machine already has.
*
* The first group is the xdbridge data directory's managed layout
* (`<dataDir>/.opencode/runtime/<version>/opencode[.exe]`, newest version
* first because that is the one its own resolver would pick). The second is the
* original's PATH-independent fallbacks — its own install, then Homebrew and
* `/usr/local` — plus the explicit override, which is checked first because a
* user who set it has already answered this question.
*
* All platform layouts are probed rather than branching on `process.platform`,
* for the same reason Loomy and MiMo do it: the test is a handful of `stat`
* calls, and a moved or non-standard install is then still found.
*
* @returns candidate absolute paths, most-preferred first.
*/
function opencodeBinaryCandidates() {
	const candidates = [];
	const override = process.env[BINARY_PATH_ENV];
	if (override !== void 0 && override.trim() !== "") candidates.push(override.trim());
	for (const name of ["opencode.exe", "opencode"]) {
		candidates.push(join(homedir(), ".opencode", "bin", name));
		candidates.push(join("/opt/homebrew/bin", name));
		candidates.push(join("/usr/local/bin", name));
	}
	const root = join(openCodeDataDir(), "runtime");
	for (const name of ["opencode.exe", "opencode"]) for (const version of installedRuntimeVersions(root)) candidates.push(join(root, version, name));
	return [...new Set(candidates)];
}
/**
* Version directories already installed under the managed runtime root.
*
* Newest first, with a numeric-aware comparison, because the directory name is
* the version and a lexicographic sort puts `1.9.0` above `1.18.0`. Only names
* matching the release shape are returned: the root also accumulates
* `download.tgz` and `.extract` scratch files, and offering one of those as a
* binary would produce a confusing spawn failure instead of a clean miss.
*
* Unreadable means "nothing installed" rather than an error: the directory is
* absent on every machine that has never run the original plugin, which is the
* normal case and not a fault to report.
*
* @param root - the managed runtime directory.
* @returns version directory names, newest first.
*/
function installedRuntimeVersions(root) {
	let entries;
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}
	return entries.filter((name) => VERSION_PATTERN.test(name)).sort((left, right) => right.localeCompare(left, "en", { numeric: true }));
}
/**
* Whether the isolated OpenCode home has been materialised.
*
* This is the filesystem trace of a `startBackend` that got as far as creating
* its XDG roots, which makes it the useful middle state: the binary is present
* AND has been started at least once, so the runtime is not merely downloadable
* but proven to run here. It is not the readiness signal on its own — a binary
* that has never been launched is still a working setup — but its absence is
* what turns "we have a binary" into "we have only a binary".
*
* @returns true when the isolated config root exists.
*/
function opencodeRuntimePrepared() {
	return existsSync(join(openCodeDataDir(), "opencode", "config"));
}
/**
* The first candidate path that exists.
*
* @param candidates - absolute paths, most-preferred first.
* @returns the first existing path, or undefined when none exists.
*/
function firstExisting(candidates) {
	return candidates.find((candidate) => existsSync(candidate));
}
/** True for a JSON object that is not an array. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** A finite positive number, or undefined for anything else. */
function positiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
/**
* Reduce the runtime's provider document to the models that are genuinely free.
*
* The filter is the xdbridge rule and it is the load-bearing part: a model
* counts only when EVERY cost dimension is zero and the runtime declares it
* still serves text. Two things follow, and both are the point of validating
* rather than casting. First, the free tier rotates, so a hardcoded roster goes
* stale in the direction of offering models that now bill — the one error a
* user cannot detect until they are charged. Second, a model the runtime has
* marked `deprecated` stays listed by the vendor while failing every call, so
* publishing it would put a permanently broken row in the picker.
*
* A zero-cost reading is required rather than assumed: a model with no `cost`
* block at all is NOT free by default. Absent pricing means the vendor did not
* say, and guessing in that direction spends the user's money to find out.
*
* @param payload - the decoded `/provider` body.
* @returns the free models, sorted by id for a stable roster.
*/
function parseRuntimeFreeModels(payload) {
	if (!isRecord(payload)) return [];
	const all = payload["all"];
	if (!Array.isArray(all)) return [];
	const models = [];
	for (const raw of all) {
		if (!isRecord(raw)) continue;
		if (raw["id"] !== RUNTIME_PROVIDER) continue;
		const declared = raw["models"];
		if (!isRecord(declared)) continue;
		for (const [id, value] of Object.entries(declared)) {
			if (id === "" || !isRecord(value)) continue;
			if (value["status"] === "deprecated") continue;
			const cost = value["cost"];
			if (!isRecord(cost)) continue;
			const cache = isRecord(cost["cache"]) ? cost["cache"] : {};
			if (!(cost["input"] === 0 && cost["output"] === 0 && (cache["read"] ?? 0) === 0 && (cache["write"] ?? 0) === 0)) continue;
			const capabilities = isRecord(value["capabilities"]) ? value["capabilities"] : {};
			if ((isRecord(capabilities["output"]) ? capabilities["output"] : {})["text"] === false) continue;
			const input = isRecord(capabilities["input"]) ? capabilities["input"] : {};
			const limit = isRecord(value["limit"]) ? value["limit"] : {};
			const name = typeof value["name"] === "string" && value["name"] !== "" ? value["name"] : id;
			const contextWindow = positiveNumber(limit["context"]);
			const maxTokens = positiveNumber(limit["output"]);
			models.push({
				id,
				name,
				...contextWindow === void 0 ? {} : { contextWindow },
				...maxTokens === void 0 ? {} : { maxTokens },
				...input["image"] === true ? { supportsImages: true } : {}
			});
		}
	}
	models.sort((left, right) => left.id.localeCompare(right.id));
	return models;
}
/**
* The loopback endpoint a running runtime is listening on.
*
* This is the runtime's OWN endpoint discovery — the original plugin writes the
* port it chose into its data directory, because the port is picked at random
* from the OS and there is no way to derive it. Only a loopback address is
* accepted: the document lives in a directory another process could have
* written, and forwarding a request to an arbitrary host from a credential
* file is precisely the kind of trust a plugin must not extend to a file it
* merely reads.
*
* @returns the base URL, or undefined when nothing is listening.
*/
function opencodeRuntimeEndpoint() {
	const path = join(openCodeDataDir(), "runtime.json");
	if (!existsSync(path)) return void 0;
	try {
		const text = readFileSync(path, "utf8");
		const value = JSON.parse(text);
		if (!isRecord(value)) return void 0;
		const port = value["port"];
		if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return void 0;
		const password = typeof value["password"] === "string" ? value["password"] : "";
		return {
			baseUrl: "http://127.0.0.1:" + String(port),
			password
		};
	} catch {
		return;
	}
}
/** OpenCode Zen's product-specific half. */
var OpenCodeImpl = class {
	/**
	* Report the local runtime, or the missing prerequisite.
	*
	* A PURE EXISTENCE PROBE — see the module note. The three outcomes are
	* deliberately distinct:
	*
	*  - a binary exists → one account representing the runtime itself,
	*  - the data directory exists but holds no binary → `[]`, which the base
	*    class renders as signed-out. The setup was attempted here and is
	*    incomplete, so telling the user to install OpenCode would be wrong: what
	*    they need is the partial state explained, and that is what the runtime's
	*    own panel is for,
	*  - nothing exists anywhere → `BackendUnavailable`, because there is a real
	*    prerequisite to prepare and the user has to be told what it is.
	*
	* The binary is reported as `usable` whether or not it has ever been started,
	* because "will this binary run on this machine" is not answerable from a
	* `stat` and pretending to answer it would either hide a working setup or
	* promise a broken one.
	*
	* @returns the runtime account, or none when the setup is incomplete.
	* @throws {BackendUnavailable} when no runtime has been prepared at all.
	*/
	async discover() {
		const binary = firstExisting(opencodeBinaryCandidates());
		if (binary !== void 0) {
			const prepared = opencodeRuntimePrepared();
			const listening = opencodeRuntimeEndpoint() !== void 0;
			return [{
				id: RUNTIME_ACCOUNT_ID,
				label: "OpenCode Zen 运行时",
				detail: listening ? "本地运行时已就绪，模型清单读取自 " + binary : prepared ? "运行时已安装并初始化，启动后提供免费模型" : "运行时二进制已就位，首次启动时准备隔离环境",
				usable: true
			}];
		}
		if (existsSync(openCodeDataDir())) return [];
		throw new BackendUnavailable("未检测到本地 OpenCode 运行时。OpenCode Zen 的免费模型只接受来自真实 OpenCode 进程的请求，直接请求会返回 403 FreeTierError，因此需要先准备运行时：在 DSH 里启用 dsh-opencode-xdbridge 插件（首次启动会自动下载约 57 MB 的官方二进制），或把已有的 opencode 可执行文件路径写入环境变量 " + BINARY_PATH_ENV + "。");
	}
	/**
	* The free models this machine can currently reach.
	*
	* A live runtime is asked first, so a model the vendor adds or retires
	* appears without this file changing. When the runtime is not running, its
	* port document is missing, or the endpoint does not answer, the constant
	* free tier is returned: the setup IS present — that is the only way this
	* method is ever reached — so an empty picker would report a working
	* installation as broken. Throwing is worse still, because the base class
	* renders a throw as an empty roster with no explanation.
	*
	* @param _accountId - unused; one runtime serves every model.
	* @returns the free models, live when possible and from the shipped list otherwise.
	*/
	async models(_accountId) {
		const live = await this.liveModels();
		if (live.length > 0) return live;
		return FREE_TIER_FALLBACK.map((model) => ({
			...model,
			name: model.name + "（内置清单）",
			rate: "免费"
		}));
	}
	/**
	* Ask a running runtime for its own free-model catalog.
	*
	* Every failure path returns an empty list rather than throwing, because the
	* single caller has a meaningful fallback and the distinction between "not
	* running" and "answered oddly" would change nothing it does.
	*
	* @returns the free models, or an empty list when the runtime cannot be read.
	*/
	async liveModels() {
		const endpoint = opencodeRuntimeEndpoint();
		if (endpoint === void 0) return [];
		try {
			const response = await fetch(endpoint.baseUrl + "/provider", {
				headers: {
					accept: "application/json",
					authorization: "Basic " + Buffer.from("opencode:" + endpoint.password).toString("base64")
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
			if (!response.ok) return [];
			return parseRuntimeFreeModels(await response.json()).map((model) => ({
				id: model.id,
				name: model.name,
				...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
				...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
				...model.supportsImages === void 0 ? {} : { supportsImages: model.supportsImages },
				rate: "免费"
			}));
		} catch {
			return [];
		}
	}
};
/** The single account id: the runtime is the account. */
const RUNTIME_ACCOUNT_ID = "local-runtime";
/** Thin subclass so the concrete type names the backend in stack traces. */
var OpenCodeBackend = class extends BaseBackendAdapter {};
/**
* The OpenCode Zen backend, ready to register.
*
* @returns the adapter the shell registers.
*/
function createOpenCodeBackend() {
	return new OpenCodeBackend(OPENCODE_DESCRIPTOR, new OpenCodeImpl());
}
//#endregion
export { createOpenCodeBackend };
