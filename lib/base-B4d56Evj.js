//#region src/backends/base.ts
/**
* Thrown by a backend to report a missing prerequisite as `unavailable`
* rather than `failed`.
*
* An exception rather than a return value because the check usually happens
* deep inside a probe (a file that must exist for the parse to continue), and
* threading an optional result back through every layer is the kind of
* plumbing that gets skipped in one place and reports a wrong state.
*/
var BackendUnavailable = class extends Error {
	hint;
	constructor(hint) {
		super(hint);
		this.hint = hint;
		this.name = "BackendUnavailable";
	}
};
/**
* The base class every merged backend extends.
*
* Holds the resolved availability so a caller can ask repeatedly (the card
* re-renders, the dashboard refreshes) without re-reading the disk each time,
* and exposes `refresh` for when a re-read is actually wanted.
*/
var BaseBackendAdapter = class {
	descriptor;
	impl;
	/** Last resolved state; undefined until the first resolve. */
	availability;
	/** The accounts currently known, keyed by id, for quota/model lookups. */
	accounts = /* @__PURE__ */ new Map();
	constructor(descriptor, impl) {
		this.descriptor = descriptor;
		this.impl = impl;
	}
	/**
	* Resolve accounts, containing every failure mode.
	*
	* Never throws: the shell starts all backends together and one bad backend
	* must not take the plugin down. The failure is reported as this backend's
	* own state instead.
	*
	* @param force - re-read from the source rather than answering from cache.
	*/
	async resolveAccounts(force = false) {
		if (!force && this.availability !== void 0) return this.availability;
		let next;
		try {
			const discovered = await this.impl.discover();
			next = discovered.length === 0 ? { state: "signed-out" } : {
				state: "ready",
				accounts: discovered.map(toAccount)
			};
		} catch (error) {
			if (error instanceof BackendUnavailable) next = {
				state: "unavailable",
				hint: error.hint
			};
			else next = {
				state: "failed",
				message: messageOf(error)
			};
		}
		this.availability = next;
		this.accounts = new Map(next.state === "ready" ? next.accounts.map((account) => [account.id, account]) : []);
		return next;
	}
	/** The cached availability, resolving once if it has never been read. */
	async current() {
		return this.availability ?? this.resolveAccounts();
	}
	/** The accounts known from the last resolve. */
	knownAccounts() {
		return [...this.accounts.values()];
	}
	/**
	* Read one account's quota.
	*
	* A backend with no billing endpoint answers `unavailable` without being
	* asked — the descriptor already knows, and a per-call failure would be
	* reported as a transient error for what is a permanent property.
	*/
	async readQuota(accountId) {
		if (!this.descriptor.reportsQuota) return {
			kind: "unavailable",
			reason: `${this.descriptor.displayName} 不提供额度查询`
		};
		if (this.impl.quota === void 0) return {
			kind: "unavailable",
			reason: `${this.descriptor.displayName} 不提供额度查询`
		};
		try {
			return await this.impl.quota(accountId);
		} catch (error) {
			return {
				kind: "error",
				message: messageOf(error)
			};
		}
	}
	/** List models, degrading to an empty roster rather than failing the card. */
	async listModels(accountId) {
		if (this.impl.models === void 0) return [];
		try {
			return await this.impl.models(accountId);
		} catch {
			return [];
		}
	}
	/** Release the backend's own resources, then drop cached state. */
	async dispose() {
		try {
			await this.impl.dispose?.();
		} finally {
			this.availability = void 0;
			this.accounts = /* @__PURE__ */ new Map();
		}
	}
};
/** Wrap a discovered account into the public shape, defaulting `usable`. */
function toAccount(discovered) {
	return {
		id: discovered.id,
		label: discovered.label,
		...discovered.detail === void 0 ? {} : { detail: discovered.detail },
		usable: discovered.usable !== false,
		...discovered.reason === void 0 ? {} : { reason: discovered.reason }
	};
}
/** A readable message from an unknown thrown value. */
function messageOf(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return String(error);
}
//#endregion
export { BaseBackendAdapter as n, messageOf as r, BackendUnavailable as t };
