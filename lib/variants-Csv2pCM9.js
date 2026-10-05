import { F as PLUGIN_PACKAGE_NAME, P as workbuddyStateDir, c as modelWithCurrentPromotion, m as regionOf } from "./auth-DWGLoiHC.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
//#region src/login.ts
/** Upstream host per realm; both serve the identical plugin login paths. */
const LOGIN_BASE = {
	cn: "https://copilot.tencent.com",
	global: "https://www.workbuddy.ai"
};
/**
* Origin and Referer per realm. They are not the same host as the API: the CN
* deployment serves `copilot.tencent.com` for the `codebuddy.cn` site, and the
* gateway rejects a request whose Origin does not match the realm it targets.
*/
const LOGIN_ORIGIN = {
	cn: "https://www.codebuddy.cn",
	global: "https://www.workbuddy.ai"
};
/** CLI identity the login endpoints expect; unrelated to the chat User-Agent. */
const LOGIN_USER_AGENT = "CLI/2.63.2 CodeBuddy/2.63.2";
/** Login round trips are interactive; a slow one is dead, not merely slow. */
const LOGIN_TIMEOUT_MS = 3e4;
/** Business code `auth/token` returns while the browser half is unfinished. */
const LOGIN_PENDING_CODE = 11217;
/** Path of the state issuer, relative to the realm's base URL. */
const AUTH_STATE_PATH = "/v2/plugin/auth/state?platform=CLI";
/** Poll and account paths; both take the state as a query parameter. */
function authTokenPath(state) {
	return `/v2/plugin/auth/token?state=${encodeURIComponent(state)}`;
}
function loginAccountPath(state) {
	return `/v2/plugin/login/account?state=${encodeURIComponent(state)}`;
}
/** A minimal cookie jar, scoped to one login attempt. */
var LoginCookieJar = class {
	cookies = /* @__PURE__ */ new Map();
	/** Record every cookie the response set, last write winning per name. */
	absorb(response) {
		for (const raw of response.headers.getSetCookie()) {
			const pair = raw.split(";", 1)[0] ?? "";
			const separator = pair.indexOf("=");
			if (separator <= 0) continue;
			const name = pair.slice(0, separator).trim();
			const value = pair.slice(separator + 1).trim();
			if (name !== "") this.cookies.set(name, value);
		}
	}
	/** The Cookie header for this attempt, or undefined when it holds nothing. */
	header() {
		if (this.cookies.size === 0) return void 0;
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
	}
};
/**
* Read an upstream envelope. A body that is not JSON, or not an object, is
* reported with its HTTP status so a proxy or gateway page is distinguishable
* from a real answer.
*/
async function readEnvelope(response) {
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`workbuddy login: upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`workbuddy login: upstream returned an unexpected document (http ${response.status})`);
	const document = parsed;
	return {
		code: typeof document["code"] === "number" ? document["code"] : 0,
		msg: typeof document["msg"] === "string" ? document["msg"] : "",
		data: "data" in document ? document["data"] : void 0
	};
}
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/**
* Normalize a realm spelling, folding anything unrecognised onto CN so a
* missing or mistyped value behaves like the deployment the plugin shipped for.
*/
function normalizeLoginRegion(region) {
	return region?.trim().toLowerCase() === "global" ? "global" : "cn";
}
/**
* The realm a finished login belongs to: the realm the attempt was started
* against, falling back to what the returned domain says when the attempt
* carried none. The domain fallback exists because the upstream may answer a
* login with a credential for the domain it redirected to.
*/
function resolveLoginRegion(region, domain) {
	const fromDomain = regionOf(domain);
	return domain.trim() === "" ? region : fromDomain;
}
/**
* The login client. One instance serves both cards; each attempt owns its own
* cookie jar, keyed by the state it issued.
*/
var WorkBuddyLoginClient = class {
	fetchImpl;
	jars = /* @__PURE__ */ new Map();
	constructor(fetchImpl = fetch) {
		this.fetchImpl = fetchImpl;
	}
	/** Request headers for one realm, carrying the attempt's cookies when it has any. */
	headers(region, jar) {
		const origin = LOGIN_ORIGIN[region];
		return {
			"Content-Type": "application/json",
			"Accept": "application/json, text/plain, */*",
			"X-Requested-With": "XMLHttpRequest",
			"Origin": origin,
			"Referer": `${origin}/`,
			"User-Agent": LOGIN_USER_AGENT,
			...jar?.header() === void 0 ? {} : { "Cookie": jar.header() }
		};
	}
	/**
	* Issue one attempt: obtain the state and the URL the human must open.
	*
	* The response's cookies are retained under the returned state, because the
	* poll that finishes this attempt has to present them.
	*/
	async begin(region) {
		const jar = new LoginCookieJar();
		const response = await this.fetchImpl(`${LOGIN_BASE[region]}${AUTH_STATE_PATH}`, {
			method: "POST",
			headers: this.headers(region),
			body: "{}",
			signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS)
		});
		jar.absorb(response);
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw new Error(`workbuddy login: auth state failed (http ${response.status}, code ${envelope.code}): ${envelope.msg.slice(0, 160)}`);
		const data = isObject(envelope.data) ? envelope.data : {};
		const state = optionalString(data["state"]);
		const authUrl = optionalString(data["authUrl"]);
		if (state === void 0 || authUrl === void 0) throw new Error("workbuddy login: auth state reply carried no state or authUrl");
		this.jars.set(state, jar);
		return {
			state,
			authUrl,
			region
		};
	}
	/** Drop a finished or abandoned attempt's jar. */
	forget(state) {
		this.jars.delete(state);
	}
	/** How many attempts currently hold a jar; diagnostics and tests. */
	pendingCount() {
		return this.jars.size;
	}
	/**
	* Poll one attempt once. The caller drives the cadence.
	*
	* `pending` covers both "the human has not finished" (business code 11217)
	* and "the gateway refused this poll yet" (a 4xx while the browser half is
	* still open) — the latter is what the CN endpoint answers before the
	* browser visit completes. A transport failure, or a 5xx, is a real error
	* and is thrown: retrying those as pending would hide an outage behind a
	* spinner that never resolves.
	*/
	async poll(attempt) {
		const jar = this.jars.get(attempt.state);
		const response = await this.fetchImpl(`${LOGIN_BASE[attempt.region]}${authTokenPath(attempt.state)}`, {
			method: "GET",
			headers: this.headers(attempt.region, jar),
			signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS)
		});
		jar?.absorb(response);
		if (response.status >= 500) throw new Error(`workbuddy login: token endpoint failed (http ${response.status})`);
		if (response.status >= 400) return { status: "pending" };
		const envelope = await readEnvelope(response);
		if (envelope.code === 11217) return { status: "pending" };
		if (envelope.code !== 0) return { status: "pending" };
		const data = isObject(envelope.data) ? envelope.data : {};
		const accessToken = optionalString(data["accessToken"]);
		if (accessToken === void 0) return { status: "pending" };
		const tokens = {
			accessToken,
			refreshToken: optionalString(data["refreshToken"]) ?? "",
			expiresInSec: typeof data["expiresIn"] === "number" && data["expiresIn"] > 0 ? data["expiresIn"] : 0,
			domain: optionalString(data["domain"]) ?? ""
		};
		return {
			status: "complete",
			tokens,
			account: await this.fetchAccount(attempt, tokens.accessToken, jar)
		};
	}
	/**
	* Read the account identity for a finished attempt.
	*
	* Best effort by design: the token bundle is what makes the credential
	* usable, and the identity only improves the display name and the
	* `X-User-Id` header. A failure here must not discard a working login.
	*/
	async fetchAccount(attempt, accessToken, jar) {
		try {
			const response = await this.fetchImpl(`${LOGIN_BASE[attempt.region]}${loginAccountPath(attempt.state)}`, {
				method: "GET",
				headers: {
					...this.headers(attempt.region, jar),
					"Authorization": `Bearer ${accessToken}`
				},
				signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS)
			});
			jar?.absorb(response);
			if (!response.ok) return { uid: "" };
			const envelope = await readEnvelope(response);
			const data = isObject(envelope.data) ? envelope.data : {};
			const enterpriseId = optionalString(data["enterpriseId"]);
			const nickname = optionalString(data["nickname"]);
			return {
				uid: optionalString(data["uid"]) ?? "",
				...enterpriseId === void 0 ? {} : { enterpriseId },
				...nickname === void 0 ? {} : { nickname }
			};
		} catch {
			return { uid: "" };
		}
	}
};
//#endregion
//#region src/status-paths.ts
/** Node-free constants and types shared by the Host and browser halves. */
/** Plugin-owned status endpoint consumed by its browser half. */
const WORKBUDDY_STATUS_PATH = "/plugins/dsh-workbuddy-connect/status";
/**
* Plugin-owned probe control endpoint.
*
* Separate from the status route because it accepts writes: the status route's
* loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
* not the same as authorizing a state-changing action. This route therefore
* also requires the in-process key the browser half receives with the status
* document.
*/
const WORKBUDDY_PROBE_PATH = "/plugins/dsh-workbuddy-connect/probe";
/**
* The international (WorkBuddy AI) variant's own pair of routes.
*
* Kept as separate constants rather than a computed suffix so both halves
* reference literal strings: the browser bundle and the host bundle are built
* independently, and a shared expression is one build-config drift away from
* the desk asking a route the host never mounted.
*/
const WORKBUDDY_AI_STATUS_PATH = "/plugins/dsh-workbuddy-connect/ai/status";
const WORKBUDDY_AI_PROBE_PATH = "/plugins/dsh-workbuddy-connect/ai/probe";
/**
* Plugin-owned sign-in endpoints, one per variant.
*
* Each variant signs in against its own realm, so each needs its own route: the
* realm is chosen by which provider the user is looking at, never by a value the
* browser sends. A POST here starts an attempt (or polls one, or signs out);
* see {@link WorkBuddyWebLoginRequest}.
*/
const WORKBUDDY_LOGIN_PATH = "/plugins/dsh-workbuddy-connect/login";
const WORKBUDDY_AI_LOGIN_PATH = "/plugins/dsh-workbuddy-connect/ai/login";
//#endregion
//#region src/catalog.ts
/**
* WorkBuddy model catalog: a static fallback list captured from the live
* endpoint, replaced by the upstream's dynamic answer once it loads.
*
* @module dsh-workbuddy-connect/catalog
*/
/**
* Static CLI models observed on the CN endpoint (re-verified against the live
* catalog 2026-09-01, including the thinking-effort and billing metadata). The
* upstream refresh replaces this list at startup; it exists so the provider
* registers with a usable catalog even while the first fetch is in flight or
* offline.
*
* The list tracks the `cli` agent's model roster exactly: the 16 models the
* desktop CLI offers. Reasoning metadata is taken verbatim from the live
* endpoint — each model's supported effort set and whether thinking can be
* disabled — and the `free` flag follows the upstream `x0.00` credits marker.
*/
const FALLBACK_WORKBUDDY_MODELS = [
	{
		id: "auto",
		name: "Auto",
		contextWindow: 168e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: { free: false }
	},
	{
		id: "hy4-preview",
		name: "Hy4 preview",
		contextWindow: 1e6,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			free: false,
			rateUnknown: true
		}
	},
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 192e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			free: false,
			rateUnknown: true
		}
	},
	{
		id: "hy3-x",
		name: "Hy3-X",
		contextWindow: 192e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["low", "high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.05",
			free: false
		}
	},
	{
		id: "deepseek-v4.1-flash",
		name: "Deepseek-V4.1-Flash",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.03 credits",
			badges: ["独家优惠"],
			free: false
		}
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 1e6,
		maxTokens: 48e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.79",
			free: false
		}
	},
	{
		id: "glm-5.3-flash",
		name: "GLM-5.3-Flash",
		contextWindow: 1e6,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.06",
			free: false
		}
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 1e6,
		maxTokens: 48e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.79 credits",
			badges: ["夜间折扣"],
			free: false
		}
	},
	{
		id: "glm-5.1",
		name: "GLM-5.1",
		contextWindow: 2e5,
		maxTokens: 48e3,
		supportsImages: false,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.79 credits",
			free: false
		}
	},
	{
		id: "glm-5v-turbo",
		name: "GLM-5v-Turbo",
		contextWindow: 2e5,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.71 credits",
			free: false
		}
	},
	{
		id: "kimi-k3-1",
		name: "Kimi-K3",
		contextWindow: 1e6,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x1.62 credits",
			free: false
		}
	},
	{
		id: "kimi-k2.8-preview",
		name: "Kimi-K2.8-Preview",
		contextWindow: 1e6,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.77 credits",
			free: false
		}
	},
	{
		id: "kimi-k2.7",
		name: "Kimi-K2.7-Code",
		contextWindow: 256e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.57 credits",
			free: false
		}
	},
	{
		id: "kimi-k2.6",
		name: "Kimi-K2.6",
		contextWindow: 256e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.52 credits",
			free: false
		}
	},
	{
		id: "minimax-m3",
		name: "MiniMax-M3",
		contextWindow: 512e3,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.25 credits",
			free: false
		}
	},
	{
		id: "deepseek-v4-pro",
		name: "Deepseek-V4-Pro",
		contextWindow: 1e6,
		maxTokens: 5e4,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.51 credits",
			free: false
		}
	}
];
/**
* Static CLI models for the international endpoint, captured 2026-09-11 from
* the App-form `/v3/config` document (the 20 ids of its `cli` agent, in order).
*
* Same purpose and same discipline as {@link FALLBACK_WORKBUDDY_MODELS}: it
* covers the window before the first successful fetch and an offline start,
* and it is deliberately *not* a promise about the upstream's current state.
* Reasoning metadata is verbatim from that snapshot. No promo badge is baked
* in: promotions are time-boxed (`modelPromotions` carries `validFrom`/
* `validUntil`), so hard-coding a "Free now" label would keep claiming a
* discount the upstream may have already ended.
*/
const FALLBACK_WORKBUDDY_AI_MODELS = [
	{
		id: "default-model",
		name: "Auto",
		contextWindow: 176e3,
		maxTokens: 24e3,
		supportsImages: true,
		reasoning: {
			supports: false,
			onlyReasoning: false,
			canDisableThinking: true
		},
		billing: { free: false }
	},
	{
		id: "fast-model",
		name: "Fast",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.34",
			free: false
		}
	},
	{
		id: "balanced-model",
		name: "Balanced",
		contextWindow: 256e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.59",
			free: false
		}
	},
	{
		id: "primary-model",
		name: "Primary",
		contextWindow: 272e3,
		maxTokens: 72e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x3.31",
			free: false
		}
	},
	{
		id: "deep-model",
		name: "Deep",
		contextWindow: 176e3,
		maxTokens: 24e3,
		supportsImages: true,
		reasoning: {
			supports: false,
			onlyReasoning: false,
			canDisableThinking: true
		},
		billing: {
			credits: "x3.33",
			free: false
		}
	},
	{
		id: "hy4-preview-f",
		name: "Hy4 preview",
		contextWindow: 3e5,
		defaultContextWindow: 3e5,
		supportedContextWindows: [3e5, 1e6],
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			free: false,
			rateUnknown: true
		}
	},
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 192e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["low", "high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			free: false,
			rateUnknown: true
		}
	},
	{
		id: "deepseek-v4.1-flash",
		name: "Deepseek-V4.1-Flash",
		contextWindow: 3e5,
		defaultContextWindow: 3e5,
		supportedContextWindows: [3e5, 1e6],
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			free: false,
			rateUnknown: true
		}
	},
	{
		id: "gpt-6-astra",
		name: "GPT-6-Astra",
		contextWindow: 4e5,
		defaultContextWindow: 4e5,
		supportedContextWindows: [4e5, 1e6],
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "medium",
			canDisableThinking: true
		},
		billing: {
			credits: "x6.67",
			free: false
		}
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6-Sol",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "medium",
			canDisableThinking: true
		},
		billing: {
			credits: "x3.47",
			free: false
		}
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6-Terra",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "medium",
			canDisableThinking: true
		},
		billing: {
			credits: "x1.39",
			free: false
		}
	},
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6-Luna",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "medium",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.14",
			free: false
		}
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x3.31",
			free: false
		}
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		contextWindow: 272e3,
		maxTokens: 72e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x1.65",
			free: false
		}
	},
	{
		id: "gpt-5.3-codex",
		name: "GPT-5.3-Codex",
		contextWindow: 272e3,
		maxTokens: 72e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x1.25",
			free: false
		}
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini-3.5-Flash",
		contextWindow: 1e6,
		maxTokens: 65536,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.99",
			free: false
		}
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 1e6,
		maxTokens: 48e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.79",
			free: false
		}
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 1e6,
		maxTokens: 48e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["high", "xhigh"],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.79",
			free: false
		}
	},
	{
		id: "kimi-k3",
		name: "Kimi-K3",
		contextWindow: 1e6,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x1.62",
			free: false
		}
	},
	{
		id: "kimi-k2.6",
		name: "Kimi-K2.6",
		contextWindow: 256e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.52",
			free: false
		}
	}
];
/**
* Mutable catalog shared by the shim's `/v1/models` and the adapter.
*
* Visibility is separate from content. A variant whose app has no credentials
* must expose *no* models rather than a fallback roster: the DSH model picker
* drops an empty group, so an empty catalog is exactly how a provider hides
* without touching registration. Serving the fallback to a signed-out user
* instead offers models that can only fail (`store.resolve()` throws on the
* first message), which is worse than showing nothing.
*
* The flag defaults to visible so a directly-constructed catalog behaves as it
* always has; the plugin runtime applies the credential gate.
*/
var WorkBuddyCatalog = class {
	models;
	visible = true;
	useMaximumContextWindow = false;
	disabledModelIds = /* @__PURE__ */ new Set();
	constructor(initial = FALLBACK_WORKBUDDY_MODELS) {
		this.models = initial;
	}
	/** All known models before filtering disabled ones; empty while the variant has no usable credential. */
	all() {
		if (!this.visible) return [];
		return this.models.map((model) => {
			const current = modelWithCurrentPromotion(model);
			const maximum = current.supportedContextWindows === void 0 ? void 0 : Math.max(...current.supportedContextWindows);
			return this.useMaximumContextWindow && maximum !== void 0 && maximum > current.contextWindow ? {
				...current,
				defaultContextWindow: current.defaultContextWindow ?? current.contextWindow,
				contextWindow: maximum
			} : current;
		});
	}
	/** Current enabled entries; empty while the variant has no usable credential. */
	current() {
		return this.all().filter((model) => !this.disabledModelIds.has(model.id));
	}
	/** Replace the list; callers invalidate their adapter snapshot after this. */
	set(models) {
		this.models = [...models];
	}
	/** Whether this variant's models are exposed at all. */
	isVisible() {
		return this.visible;
	}
	/**
	* Show or hide the whole catalog. Returns whether the value changed, so the
	* caller can skip an invalidation that would re-render an identical list.
	*/
	setVisible(visible) {
		if (this.visible === visible) return false;
		this.visible = visible;
		return true;
	}
	/** Select the largest declared international window where the upstream offers one. */
	setUseMaximumContextWindow(useMaximum) {
		if (this.useMaximumContextWindow === useMaximum) return false;
		this.useMaximumContextWindow = useMaximum;
		return true;
	}
	/** Update the set of disabled model ids. Returns whether the effective disabled set changed. */
	setDisabledModels(disabled) {
		const next = new Set(disabled);
		if (next.size === this.disabledModelIds.size) {
			let same = true;
			for (const id of next) if (!this.disabledModelIds.has(id)) {
				same = false;
				break;
			}
			if (same) return false;
		}
		this.disabledModelIds = next;
		return true;
	}
	/** Currently disabled model ids as an array. */
	disabledModels() {
		return [...this.disabledModelIds];
	}
	/** Models to fall back to when the upstream fetch fails; ignores visibility. */
	fallback() {
		return this.models;
	}
};
//#endregion
//#region src/version.ts
const WORKBUDDY_CONNECT_VERSION = "0.6.8";
//#endregion
//#region src/host-heartbeat.ts
/**
* Host-side heartbeat: a small JSON file written under `$DSH_HOME` once the
* `workbuddy` provider is registered. The status CLI reads it to report
* whether the host bundle is alive, independent of the browser card.
*
* The browser (client) bundle cannot write files; its health is reported
* only through `console.error` on failure (see `src/client/index.tsx`).
* This asymmetry is intentional: the host is the load-bearing half, and
* a missing heartbeat unambiguously means the host never started.
*
* @module dsh-workbuddy-connect/host-heartbeat
*/
/** Basename of the host heartbeat file inside the plugin's config directory. */
const WORKBUDDY_HOST_HEARTBEAT_FILENAME = ".workbuddy-host-heartbeat.json";
/** Current on-disk heartbeat format; readers reject others. */
const HEARTBEAT_FORMAT_VERSION = 1;
/** Absolute path of the host heartbeat file. */
function workbuddyHostHeartbeatPath() {
	return join(workbuddyStateDir(), WORKBUDDY_HOST_HEARTBEAT_FILENAME);
}
/**
* Write (or overwrite) the heartbeat after the host bundle registered the
* provider. A failed write is non-fatal: the host is already running, and
* the status CLI will simply report "heartbeat missing" rather than failing.
*/
async function writeHostHeartbeat() {
	const document = {
		version: HEARTBEAT_FORMAT_VERSION,
		package: PLUGIN_PACKAGE_NAME,
		pluginVersion: WORKBUDDY_CONNECT_VERSION,
		registeredAt: Date.now(),
		pid: process.pid
	};
	try {
		await mkdir(workbuddyStateDir(), { recursive: true });
		await writeFile(workbuddyHostHeartbeatPath(), JSON.stringify(document), "utf8");
	} catch {}
}
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
async function clearHostHeartbeat() {
	try {
		await rm(workbuddyHostHeartbeatPath(), { force: true });
	} catch {}
}
/** Read and validate the heartbeat; returns `undefined` when absent or malformed. */
async function readHostHeartbeat() {
	let raw;
	try {
		raw = await readFile(workbuddyHostHeartbeatPath(), "utf8");
	} catch {
		return;
	}
	try {
		const parsed = JSON.parse(raw);
		if (parsed.version === HEARTBEAT_FORMAT_VERSION && parsed.package === "dsh-multibuddy-connect" && typeof parsed.registeredAt === "number" && typeof parsed.pid === "number") return {
			version: HEARTBEAT_FORMAT_VERSION,
			package: PLUGIN_PACKAGE_NAME,
			pluginVersion: typeof parsed.pluginVersion === "string" ? parsed.pluginVersion : "unknown",
			registeredAt: parsed.registeredAt,
			pid: parsed.pid
		};
	} catch {}
}
/**
* Absolute start time (epoch ms) of the process holding `pid`, or `undefined`
* when it cannot be determined (no such PID, platform lacks a readable source).
*
* - macOS / Linux: `ps -o lstart=` prints a local-time "EEE MMM DD HH:MM:SS YYYY";
*   `Date.parse` resolves it against the local clock, which matches how
*   `registeredAt` (a `Date.now()` absolute value) is expressed.
* - Windows: WMI `CreationDate` is UTC (`YYYYMMDDHHMMSS.mmm+zzzz`); parsed with
*   `Date.UTC`, again comparable to `registeredAt`.
*
* Failures return `undefined` so callers can fall back to plain PID liveness
* rather than mis-report a running host as dead.
*/
function processStartTimeMs(pid) {
	try {
		if (process.platform === "win32") {
			const m = execFileSync("wmic", [
				"process",
				"where",
				`processid=${pid}`,
				"get",
				"CreationDate"
			], {
				encoding: "utf8",
				windowsHide: true
			}).match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d{4})/);
			if (m === null) return void 0;
			const [, y, mo, d, h, mi, s] = m;
			const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
			return Number.isFinite(ms) ? ms : void 0;
		}
		const out = execFileSync("ps", [
			"-o",
			"lstart=",
			"-p",
			String(pid)
		], {
			encoding: "utf8",
			env: {
				...process.env,
				LC_ALL: "C",
				LANG: "C"
			}
		}).trim();
		if (out === "") return void 0;
		const ms = Date.parse(out);
		return Number.isFinite(ms) ? ms : void 0;
	} catch {
		return;
	}
}
/**
* Whether the heartbeat's PID is still alive *and* still the same process that
* registered it. A stale heartbeat (host crashed without clearing the file)
* is distinguished from a live host by two checks:
*
* 1. `process.kill(pid, 0)` — the PID exists (signal 0 tests existence).
* 2. The process holding that PID started at or before `registeredAt`. A host
*    that registered the heartbeat must have been started before writing it,
*    so `start <= registeredAt`; a recycled PID belongs to an unrelated process
*    started after the host died, so `start > registeredAt` correctly reads dead.
*
* PID-only detection is not enough: after a crash the OS may hand the same PID
* to an unrelated process, and the un-cleared stale heartbeat would otherwise
* produce a false "Host running". When the process start time cannot be read
* (e.g. unsupported platform) the check degrades to plain PID liveness.
*/
function isHeartbeatProcessAlive(heartbeat) {
	try {
		process.kill(heartbeat.pid, 0);
	} catch {
		return false;
	}
	const startAtMs = processStartTimeMs(heartbeat.pid);
	if (startAtMs === void 0) return true;
	return startAtMs <= heartbeat.registeredAt;
}
//#endregion
//#region src/variants.ts
/**
* The two WorkBuddy products this one plugin serves.
*
* Both are the same client framework in different regions, and they differ by
* upstream realm, catalog endpoint, and display identity. Everything that
* varies between them is collected here as one descriptor, so no module has to
* carry its own `if (international)` branch and a third variant would be a data
* change rather than a refactor.
*
* Each variant signs in independently, through its own realm's device
* authorization flow. The two therefore never share a credential, and a realm
* that is unreachable from the user's network (the international one, from some
* mainland networks) cannot block the other's login.
*
* This module is host-side (it names files and routes). The browser half takes
* the same ids and routes from the Node-free `status-paths.ts`, which stays the
* single source shared by both halves.
*
* @module dsh-workbuddy-connect/variants
*/
/** CN WorkBuddy first: the existing provider keeps its id, paths, and copy. */
const WORKBUDDY_VARIANTS = [{
	id: "workbuddy",
	displayName: "WorkBuddy",
	appName: "WorkBuddy",
	region: "cn",
	ownFilename: ".workbuddy-auth.json",
	probeFilename: ".workbuddy-probe.json",
	catalogFilename: ".workbuddy-catalog.json",
	statusPath: WORKBUDDY_STATUS_PATH,
	probePath: WORKBUDDY_PROBE_PATH,
	loginPath: WORKBUDDY_LOGIN_PATH
}, {
	id: "workbuddy-ai",
	displayName: "WorkBuddy AI",
	appName: "WorkBuddy AI",
	region: "global",
	ownFilename: ".workbuddy-ai-auth.json",
	probeFilename: ".workbuddy-ai-probe.json",
	catalogFilename: ".workbuddy-ai-catalog.json",
	statusPath: WORKBUDDY_AI_STATUS_PATH,
	probePath: WORKBUDDY_AI_PROBE_PATH,
	loginPath: WORKBUDDY_AI_LOGIN_PATH
}];
/** The CN variant; the plugin's long-standing default and compatibility anchor. */
const CN_VARIANT = WORKBUDDY_VARIANTS[0];
/** The international variant. */
const AI_VARIANT = WORKBUDDY_VARIANTS[1];
/** Look up a variant by provider id. */
function variantFor(id) {
	return WORKBUDDY_VARIANTS.find((variant) => variant.id === id);
}
//#endregion
export { resolveLoginRegion as C, normalizeLoginRegion as S, WORKBUDDY_LOGIN_PATH as _, WORKBUDDY_HOST_HEARTBEAT_FILENAME as a, LOGIN_PENDING_CODE as b, processStartTimeMs as c, writeHostHeartbeat as d, WORKBUDDY_CONNECT_VERSION as f, WORKBUDDY_AI_LOGIN_PATH as g, WorkBuddyCatalog as h, variantFor as i, readHostHeartbeat as l, FALLBACK_WORKBUDDY_MODELS as m, CN_VARIANT as n, clearHostHeartbeat as o, FALLBACK_WORKBUDDY_AI_MODELS as p, WORKBUDDY_VARIANTS as r, isHeartbeatProcessAlive as s, AI_VARIANT as t, workbuddyHostHeartbeatPath as u, WORKBUDDY_PROBE_PATH as v, WorkBuddyLoginClient as x, WORKBUDDY_STATUS_PATH as y };
