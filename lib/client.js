window.__ModuleLoader__.load({
	id: "dsh-multibuddy-connect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
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
		//#region src/client/status-document.ts
		/**
		* Whether a parsed status response really is a status document.
		*
		* A 200 is not a promise about the body: it may be empty, literal `null`, a
		* non-JSON page from a proxy, or an array. Both halves of the browser plugin
		* read the same route, so both must agree on what is valid — storing an
		* unreadable value puts something in state that the next render dereferences.
		*
		* The check is deliberately limited to the discriminator (plus `error`'s
		* `message`, which the error paragraph renders): validating optional fields
		* here would reject documents the host legitimately omits fields from.
		*/
		function isWorkBuddyWebStatus(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const wrapped = value;
			const status = wrapped["status"];
			if (status === "signed-out" || status === "signed-in") return true;
			return status === "error" && typeof wrapped["message"] === "string";
		}
		//#endregion
		//#region src/client/quota-settings-store.ts
		let pollIntervalMs = 3e5;
		const toggles = {
			cn: false,
			ai: false
		};
		/**
		* Reference-stable views of the two mutable records below.
		*
		* `useSyncExternalStore` compares snapshots by IDENTITY, so a getter that
		* builds a fresh object on every call makes its subscriber re-render forever
		* and React kills the entry (error #185 — the same crash the settings card's
		* unstable projection caused). The snapshot objects are therefore replaced
		* wholesale only when the underlying record actually changes.
		*/
		let togglesSnapshot = {
			cn: false,
			ai: false
		};
		const signIn = {
			cn: false,
			ai: false
		};
		let signInSnapshot = {
			cn: false,
			ai: false
		};
		let revision = 0;
		const listeners = /* @__PURE__ */ new Set();
		function bump() {
			revision += 1;
			for (const listener of listeners) listener();
		}
		/** Update the shared poll interval (from the settings document). */
		function setQuotaPollMs(ms) {
			if (Number.isFinite(ms) && ms >= 6e4 && pollIntervalMs !== ms) {
				pollIntervalMs = ms;
				bump();
			}
		}
		/** Read the configured poll interval. */
		function quotaPollMs() {
			return pollIntervalMs;
		}
		/** Update both sidebar toggles (from the settings document). */
		function setQuotaToggles(cn, ai) {
			if (toggles.cn !== cn || toggles.ai !== ai) {
				toggles.cn = cn;
				toggles.ai = ai;
				togglesSnapshot = { ...toggles };
				bump();
			}
		}
		/** Read the current toggles. */
		function quotaToggles() {
			return togglesSnapshot;
		}
		/** Record a variant's sign-in state from any successful status poll. */
		function noteQuotaSignIn(variantId, signedIn) {
			if (variantId === "workbuddy" && signIn.cn !== signedIn) {
				signIn.cn = signedIn;
				signInSnapshot = { ...signIn };
				bump();
			} else if (variantId === "workbuddy-ai" && signIn.ai !== signedIn) {
				signIn.ai = signedIn;
				signInSnapshot = { ...signIn };
				bump();
			}
		}
		/** Read the cached sign-in state. */
		function quotaSignInState() {
			return signInSnapshot;
		}
		/** Subscribe to any flag change; returns the disposer. */
		function onQuotaSettingsChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
		/** The current revision — the useSyncExternalStore snapshot value. */
		function quotaSettingsRevision() {
			return revision;
		}
		/** Which variant a status route belongs to, from the route path. */
		function variantOfStatusPath(statusPath) {
			return statusPath.includes("/ai/") ? "workbuddy-ai" : "workbuddy";
		}
		/**
		* The last status document per variant, shared by EVERY quota surface.
		*
		* The sidebar cards and the dashboard each used to fetch independently, so a
		* dashboard refresh updated the panel while the sidebar card kept showing its
		* previous read until its own next tick — two different numbers for one
		* account on one screen. One store, one write path
		* ({@link noteQuotaStatus}), and every subscriber re-renders through the
		* same revision: whatever surface refreshed last, all of them show it.
		*
		* Documents are kept by identity (never mutated), so reference comparisons
		* in useSyncExternalStore selectors stay cheap and stable.
		*/
		const statusDocuments = {
			cn: void 0,
			ai: void 0
		};
		/**
		* Publish one variant's freshly fetched status document. Downstream
		* subscribers (both sidebar cards and the dashboard, through whichever
		* observable wraps this store) re-render on the revision bump.
		*/
		function noteQuotaStatus(variantId, status) {
			if (variantId === "workbuddy" && statusDocuments.cn !== status) {
				statusDocuments.cn = status;
				statusFetchedAt.cn = Date.now();
				bump();
			} else if (variantId === "workbuddy-ai" && statusDocuments.ai !== status) {
				statusDocuments.ai = status;
				statusFetchedAt.ai = Date.now();
				bump();
			}
			noteQuotaSignIn(variantId, status.status === "signed-in");
		}
		/** Read one variant's latest status document. */
		function quotaStatus(variantId) {
			return variantId === "workbuddy" ? statusDocuments.cn : statusDocuments.ai;
		}
		/** When each variant's document was last fetched (per publish, not per read). */
		const statusFetchedAt = {
			cn: void 0,
			ai: void 0
		};
		/** Read the time a variant's current document was fetched, if any. */
		function quotaStatusFetchedAt(variantId) {
			return variantId === "workbuddy" ? statusFetchedAt.cn : statusFetchedAt.ai;
		}
		/**
		* Whether ONE variant's shared document is fresh enough to skip a fetch:
		* the user's rule — a click/mount/interval tick within the configured
		* interval of the last successful read reuses the cached document, and only
		* a variant with NO result yet (or a failed read that never landed one)
		* forces the upstream call. The interval is a cache lifetime, not a metronome.
		*
		* A `maxAgeMs` of the poll interval comes from the settings document; a
		* failed last read is NOT tracked here (callers gate failures themselves),
		* because "the last read failed" still means "no usable result".
		*
		* @param variantId - which variant's freshness to test.
		* @param maxAgeMs - the configured poll interval (cache lifetime).
		*/
		function quotaStatusIsFresh(variantId, maxAgeMs) {
			const fetchedAt = variantId === "workbuddy" ? statusFetchedAt.cn : statusFetchedAt.ai;
			const document = variantId === "workbuddy" ? statusDocuments.cn : statusDocuments.ai;
			if (fetchedAt === void 0 || document === void 0) return false;
			return Date.now() - fetchedAt < maxAgeMs;
		}
		//#endregion
		//#region src/client/QuotaSettingsCard.tsx
		/**
		* The shared quota-settings card: one card above the two variant cards that
		* configures both sidebar quota widgets.
		*
		* It registers into the shared 《插件设置》 block's card list and writes
		* through the settings scope's revision-fenced `set` — the same durable-write
		* path every preference row uses. A toggle commits on click: each click is one
		* explicit user choice, and the scope's ordering makes the last one win, so no
		* staged-draft form is needed for two booleans and a number.
		*
		* The two toggles gate the CN and international sidebar cards respectively;
		* the interval is one shared poll period. Toggles are disabled while their
		* variant is signed out: a quota card for an account nobody is signed into
		* would render an error forever, so the setting waits for a session.
		*/
		/** The default poll interval shown before a value is stored. */
		const POLL_DEFAULT_MS = 3e5;
		/** Floor the schema also enforces; mirrored here for immediate UI feedback. */
		const POLL_MIN_MS = 6e4;
		/** Read the section values out of a scope snapshot (defaults when absent). */
		function project(scope) {
			if (scope === void 0) return {
				status: "unavailable",
				writable: false,
				values: {
					sidebarQuotaCN: false,
					sidebarQuotaAI: false,
					autoCheckInCN: false,
					autoCheckInAI: false,
					quotaPollMs: POLL_DEFAULT_MS
				}
			};
			const snapshot = scope.getSnapshot();
			const value = snapshot.value ?? {};
			return {
				status: snapshot.status,
				writable: snapshot.writable,
				values: {
					sidebarQuotaCN: value.sidebarQuotaCN === true,
					sidebarQuotaAI: value.sidebarQuotaAI === true,
					autoCheckInCN: value.autoCheckInCN === true,
					autoCheckInAI: value.autoCheckInAI === true,
					quotaPollMs: typeof value.quotaPollMs === "number" ? value.quotaPollMs : POLL_DEFAULT_MS
				}
			};
		}
		/**
		* Stable-reference projection cache.
		*
		* React's useSyncExternalStore requires getSnapshot() to return THE SAME
		* reference between renders unless the store actually changed. project()
		* builds a fresh object every call, which re-renders forever and crashes the
		* card with React error #185 ("maximum update depth exceeded") — exactly the
		* crash the slot ledger reported. The cache below compares the projection
		* FIELD BY FIELD and keeps the previous object unless a value actually moved,
		* so a scope handed a fresh-but-equal snapshot object every read (which a test
		* double does, and a normalizing host may too) cannot spin the card.
		*/
		let cachedScope;
		let cachedProjection;
		const UNAVAILABLE = {
			status: "unavailable",
			writable: false,
			values: {
				sidebarQuotaCN: false,
				sidebarQuotaAI: false,
				autoCheckInCN: false,
				autoCheckInAI: false,
				quotaPollMs: POLL_DEFAULT_MS
			}
		};
		function stableProject(scope) {
			if (scope === void 0) return UNAVAILABLE;
			const next = project(scope);
			if (cachedProjection === void 0 || cachedScope !== scope || cachedProjection.status !== next.status || cachedProjection.writable !== next.writable || cachedProjection.values.sidebarQuotaCN !== next.values.sidebarQuotaCN || cachedProjection.values.sidebarQuotaAI !== next.values.sidebarQuotaAI || cachedProjection.values.autoCheckInCN !== next.values.autoCheckInCN || cachedProjection.values.autoCheckInAI !== next.values.autoCheckInAI || cachedProjection.values.quotaPollMs !== next.values.quotaPollMs) {
				cachedScope = scope;
				cachedProjection = next;
			}
			return cachedProjection;
		}
		/** One toggle row: label, hint, and a switch drawn to the shell's proportions. */
		function ToggleRow({ label, hint, checked, disabled, disabledHint, onToggle }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: rowStyle$1,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: rowTextStyle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: labelStyle$1,
						children: label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: hintStyle,
						children: disabled === true && disabledHint !== void 0 ? disabledHint : hint
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					role: "switch",
					"aria-checked": checked,
					disabled,
					"aria-label": label,
					onClick: () => {
						if (disabled) return;
						onToggle(!checked);
					},
					style: {
						...switchStyle,
						background: checked ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.2))",
						justifyContent: checked ? "flex-end" : "flex-start",
						opacity: disabled === true ? .45 : 1,
						cursor: disabled === true ? "not-allowed" : "pointer"
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: knobStyle })
				})]
			});
		}
		/**
		* The quota-settings controls on their own, with no card chrome.
		*
		* This is the half the unified WorkBuddy card embeds at the top of its body.
		* It owns its subscriptions: the scope projection (which values are saved) and
		* the shared sign-in store (which variant has a session), so a toggle
		* re-gates the moment a poll anywhere lands a document — no remount, and no
		* prop-drilling through the slot injection.
		*/
		function QuotaSettingsContent({ t = (key) => key, scope, signedIn }) {
			const subscribe = (0, react.useCallback)((onStoreChange) => {
				return scope?.subscribe(onStoreChange) ?? (() => {});
			}, [scope]);
			const projection = (0, react.useSyncExternalStore)(subscribe, () => stableProject(scope));
			const liveSignIn = (0, react.useSyncExternalStore)(onQuotaSettingsChange, quotaSignInState);
			const [probe, setProbe] = (0, react.useState)();
			(0, react.useEffect)(() => {
				let disposed = false;
				const probeOne = async (path) => {
					try {
						const body = await (await fetch(path, { headers: { accept: "application/json" } })).json();
						if (disposed || !isWorkBuddyWebStatus(body)) return void 0;
						noteQuotaSignIn(variantOfStatusPath(path), body.status === "signed-in");
						return body.status === "signed-in";
					} catch {
						return;
					}
				};
				(async () => {
					const [cn, ai] = await Promise.all([probeOne(WORKBUDDY_STATUS_PATH), probeOne(WORKBUDDY_AI_STATUS_PATH)]);
					if (!disposed) setProbe({
						cn: cn === true,
						ai: ai === true
					});
				})();
				return () => {
					disposed = true;
				};
			}, []);
			if (projection.status === "unavailable") return null;
			const reported = signedIn?.();
			/**
			* Whether one variant has a usable session, decided by whoever can best tell.
			*
			* An explicit `signedIn` reader (what the unified card passes once it has a
			* poll's answer) is authoritative. Otherwise — and that is the case this
			* exists for — a stale optimistic `true` in the store must never be enough:
			* the shared store may hold a sign-in fact from a document that has since
			* been replaced by a signed-out one. So the CURRENT document is consulted,
			* and a document saying `signed-out` closes the toggle regardless of what
			* any cached flag says.
			*/
			const deriveSigned = (variant, variantId) => {
				if (reported !== void 0) return Boolean(reported[variant]);
				const currentStatus = quotaStatus(variantId);
				if (currentStatus?.status === "signed-out") return false;
				const live = liveSignIn[variant];
				if (probe !== void 0) {
					if (!probe[variant]) return Boolean(live && currentStatus?.status === "signed-in");
					return Boolean(live);
				}
				return Boolean(live && currentStatus?.status === "signed-in");
			};
			const signed = {
				cn: deriveSigned("cn", "workbuddy"),
				ai: deriveSigned("ai", "workbuddy-ai")
			};
			const write = (field, value) => {
				if (field === "sidebarQuotaCN" && value === true && !signed.cn) return;
				if (field === "sidebarQuotaAI" && value === true && !signed.ai) return;
				if (field === "autoCheckInCN" && value === true && !signed.cn) return;
				if (field === "autoCheckInAI" && value === true && !signed.ai) return;
				scope?.set(field, value);
			};
			const minutes = Math.max(POLL_MIN_MS / 6e4, Math.round(projection.values.quotaPollMs / 6e4));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 4
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
						label: t("quotaToggleCN"),
						hint: t("quotaToggleHint"),
						checked: projection.values.sidebarQuotaCN,
						disabled: !signed.cn,
						disabledHint: t("quotaSignInRequired"),
						onToggle: (next) => write("sidebarQuotaCN", next)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
						label: t("quotaToggleAI"),
						hint: t("quotaToggleHint"),
						checked: projection.values.sidebarQuotaAI,
						disabled: !signed.ai,
						disabledHint: t("quotaSignInRequired"),
						onToggle: (next) => write("sidebarQuotaAI", next)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
						label: t("autoCheckInCN"),
						hint: t("autoCheckInHintCN"),
						checked: projection.values.autoCheckInCN,
						disabled: !signed.cn,
						disabledHint: t("quotaSignInRequired"),
						onToggle: (next) => write("autoCheckInCN", next)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
						label: t("autoCheckInAI"),
						hint: t("autoCheckInHintAI"),
						checked: projection.values.autoCheckInAI,
						disabled: !signed.ai,
						disabledHint: t("quotaSignInRequired"),
						onToggle: (next) => write("autoCheckInAI", next)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...rowStyle$1,
							borderBottom: "none",
							paddingBottom: 0
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: rowTextStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: labelStyle$1,
								children: t("quotaPollLabel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: hintStyle,
								children: t("quotaPollHint")
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: pollFieldStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "number",
								min: POLL_MIN_MS / 6e4,
								step: 1,
								value: minutes,
								"aria-label": t("quotaPollLabel"),
								onChange: (event) => {
									const mins = Number.parseInt(event.target.value, 10);
									if (Number.isFinite(mins) && mins > 0) write("quotaPollMs", Math.max(POLL_MIN_MS, mins * 6e4));
								},
								style: inputStyle
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: hintStyle,
								children: t("quotaPollUnit")
							})]
						})]
					}),
					projection.writable === false ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: hintStyle,
						children: t("quotaSettingsSaveFailed")
					}) : null
				]
			});
		}
		/**
		* One settings row: NO box of its own (the bordered rows read as nested
		* cards, which the user ruled against) — rows are separated by a hairline
		* bottom rule like the settings shell's own preference lists.
		*/
		const rowStyle$1 = {
			display: "flex",
			alignItems: "center",
			gap: 12,
			borderBottom: ".5px solid var(--dsw-alias-border-l2)",
			paddingBottom: 10
		};
		const rowTextStyle = {
			display: "flex",
			flex: 1,
			minWidth: 0,
			flexDirection: "column",
			gap: 2
		};
		const labelStyle$1 = {
			fontSize: 13,
			fontWeight: 500,
			lineHeight: 1.5,
			color: "var(--dsw-alias-label-primary)"
		};
		const hintStyle = {
			fontSize: 12,
			lineHeight: 1.5,
			color: "var(--dsw-alias-label-tertiary)"
		};
		const switchStyle = {
			flex: "none",
			display: "flex",
			width: 36,
			height: 20,
			borderRadius: 10,
			borderWidth: "1px",
			borderStyle: "solid",
			borderColor: "var(--dsw-alias-border-l2)",
			padding: 1,
			cursor: "pointer",
			alignItems: "center",
			transition: "background .16s"
		};
		const knobStyle = {
			display: "block",
			width: 16,
			height: 16,
			borderRadius: "50%",
			background: "var(--dsw-alias-bg-layer-1, #fff)",
			boxShadow: "0 1px 2px rgba(0,0,0,0.2)"
		};
		const pollFieldStyle = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			flex: "none"
		};
		const inputStyle = {
			boxSizing: "border-box",
			width: 55,
			padding: "5px 8px",
			borderWidth: "1px",
			borderStyle: "solid",
			borderColor: "var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 13,
			textAlign: "right"
		};
		//#endregion
		//#region src/client/WorkBuddyPluginCard.tsx
		/** WorkBuddy status card contributed to Harness Plugin configuration. */
		/** CN WorkBuddy; the plugin's long-standing card and default. */
		const CN_CARD_VARIANT = {
			id: "workbuddy",
			titleKey: "title",
			introKey: "intro",
			signedOutKey: "signedOutHint",
			statusPath: WORKBUDDY_STATUS_PATH,
			probePath: WORKBUDDY_PROBE_PATH,
			loginPath: WORKBUDDY_LOGIN_PATH
		};
		/** International WorkBuddy AI. */
		const AI_CARD_VARIANT = {
			id: "workbuddy-ai",
			titleKey: "titleAI",
			introKey: "introAI",
			signedOutKey: "signedOutHintAI",
			statusPath: WORKBUDDY_AI_STATUS_PATH,
			probePath: WORKBUDDY_AI_PROBE_PATH,
			loginPath: WORKBUDDY_AI_LOGIN_PATH
		};
		/** Both cards, in display order. */
		const CARD_VARIANTS = [CN_CARD_VARIANT, AI_CARD_VARIANT];
		const POLL_INTERVAL_MS = 6e4;
		/**
		* How often the account pool's countdowns are recomputed.
		*
		* Deliberately NOT the poll interval above: the document is re-read once a
		* minute, but "剩余 3 分 20 秒" has to fall every second to look like a clock
		* rather than a stale figure, and a countdown that only moves on poll would sit
		* unchanged for a minute and then jump. This tick re-renders local state only —
		* it never touches the network.
		*/
		const POOL_TICK_MS = 1e3;
		const cardStyle = {
			listStyle: "none",
			borderWidth: "0.5px",
			borderStyle: "solid",
			borderColor: "var(--dsw-alias-border-l4)",
			borderRadius: 16,
			background: "var(--dsw-alias-bg-layer-3)",
			transition: "border-color .16s, background .16s"
		};
		/** Hover, matching the built-in card's `:hover`. Inline styles cannot express a pseudo-class. */
		const cardHoverStyle = { borderColor: "var(--dsw-alias-label-dimmed)" };
		/** Expanded, matching the built-in card's open state. */
		const cardOpenStyle = {
			background: "var(--dsw-alias-bg-layer-2)",
			borderColor: "var(--dsw-alias-label-dimmed)"
		};
		const headerStyle = {
			boxSizing: "border-box",
			width: "100%",
			display: "flex",
			alignItems: "center",
			gap: 12,
			borderWidth: 0,
			borderStyle: "solid",
			borderColor: "transparent",
			borderRadius: 12,
			padding: "14px 16px",
			background: "transparent",
			color: "inherit",
			font: "inherit",
			textAlign: "left",
			cursor: "pointer",
			appearance: "none"
		};
		/**
		* The built-in header's keyboard focus ring.
		*
		* `:focus-visible` is what makes the ring appear for keyboard navigation but not
		* for a mouse click, and an inline style cannot express a pseudo-class — so the
		* component tracks it and applies this instead. Without it the header falls back
		* to the browser's own outline, which is the black box that used to appear on
		* focus where the built-in card shows a brand-coloured ring.
		*/
		const headerFocusStyle = {
			outline: "2px solid var(--dsw-alias-brand-primary)",
			outlineOffset: -2
		};
		const headTextStyle = {
			display: "flex",
			flex: 1,
			minWidth: 0,
			flexDirection: "column",
			gap: 4
		};
		const nameStyle = {
			fontSize: 15,
			lineHeight: 1.4,
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		const descriptionStyle = {
			fontSize: 13,
			lineHeight: 1.5,
			color: "var(--dsw-alias-label-tertiary)"
		};
		/**
		* The disclosure chevron, drawn to match the Settings panel's own card.
		*
		* The built-in card renders `IconChevronDownOutline14` from the client's shared
		* icon catalog, which the shell seeds into the module table. This plugin does
		* not request that catalog, so the same outline is drawn here from the same path
		* data: the text `⌄` glyph this replaces had a different shape, weight, and
		* baseline from the icon the cards beside it use.
		*/
		function ChevronDownIcon() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				width: 14,
				height: 14,
				viewBox: "0 0 14 14",
				fill: "none",
				xmlns: "http://www.w3.org/2000/svg",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z",
					fill: "currentColor"
				})
			});
		}
		/** The built-in card's chevron rule: tertiary color, and only the rotation animates. */
		const chevronStyle = {
			flex: "none",
			display: "flex",
			color: "var(--dsw-alias-label-tertiary)",
			transition: "transform .16s"
		};
		const cardBodyStyle = {
			borderTop: ".5px solid var(--dsw-alias-border-l2)",
			margin: "0 16px",
			padding: "12px 0 8px"
		};
		const bodyStyle = {
			margin: 0,
			fontSize: 13,
			lineHeight: 1.5,
			color: "var(--dsw-alias-label-tertiary)"
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			flexWrap: "wrap",
			gap: 12
		};
		/** A vertical stack, for content that sits BELOW a row rather than inside it. */
		const stackStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 6,
			marginTop: 8
		};
		const statusStyle = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			fontSize: 13,
			fontWeight: 500,
			lineHeight: 1.5,
			color: "var(--dsw-alias-label-primary)"
		};
		/** The built-in secondary button: transparent, hairline border, 8px radius. */
		const buttonStyle$1 = {
			boxSizing: "border-box",
			padding: "5px 14px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			font: "inherit",
			fontSize: 13,
			lineHeight: 1.5,
			cursor: "pointer"
		};
		const errorStyle = {
			...bodyStyle,
			color: "var(--dsw-alias-state-error-primary)"
		};
		/** Callout for "this account needs an action on the provider's website". */
		const activationNoticeStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 4,
			padding: "10px 12px",
			margin: "6px 0",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-state-warn-primary, rgba(217,150,20,0.55))",
			background: "var(--dsw-alias-state-warn-tertiary, rgba(217,150,20,0.12))"
		};
		const activationTitleStyle = {
			margin: 0,
			fontSize: 13,
			lineHeight: 1.5,
			fontWeight: 600,
			color: "var(--dsw-alias-state-warn-primary, #b8860b)"
		};
		const activationBodyStyle = {
			margin: 0,
			fontSize: 12,
			lineHeight: 1.6,
			color: "var(--dsw-alias-label-secondary)",
			wordBreak: "break-word"
		};
		const quotaListStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 18,
			paddingTop: 2
		};
		const quotaGroupStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10
		};
		const quotaTitleStyle = {
			margin: 0,
			fontSize: 13,
			lineHeight: 1.5,
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		const quotaLabelStyle = {
			display: "flex",
			justifyContent: "space-between",
			gap: 12,
			fontSize: 13,
			lineHeight: 1.5,
			color: "var(--dsw-alias-label-secondary)"
		};
		const modelBadgeStyle = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			flexWrap: "wrap"
		};
		const modelOfferStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 2
		};
		const modelRateStyle = {
			fontSize: 12,
			lineHeight: 1.5,
			color: "var(--dsw-alias-label-tertiary)"
		};
		const contextPreferenceStyle = {
			display: "flex",
			alignItems: "flex-start",
			gap: 9,
			padding: "10px 12px",
			border: ".5px solid var(--dsw-alias-border-l4)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-3)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13,
			lineHeight: 1.5
		};
		const contextPreferenceCopyStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 2
		};
		/** The right-hand cell of one context-window row: value and its note on one line. */
		const contextPickerRowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "flex-end",
			gap: 8,
			flexWrap: "wrap"
		};
		/**
		* The promotional badge chip: the theme's soft success tint for the fill and its
		* solid tone for the text. Both tokens exist in the shipped theme — the
		* `-subtle` spelling this used to carry does not, which silently fell back to a
		* hand-picked green and read as off-brand.
		*/
		const modelBadgeChipStyle = {
			padding: "1px 8px",
			borderRadius: 999,
			fontSize: 11,
			lineHeight: "18px",
			background: "var(--dsw-alias-state-success-tertiary)",
			color: "var(--dsw-alias-state-success-primary)"
		};
		/**
		* Localize an upstream promotional badge label, with an unknown-badge fallback.
		*
		* The CN catalog spells badges in Chinese (`限时免费`, `夜间折扣`); the
		* international document's `modelPromotions` carries English (`Free now`). Both
		* are mapped so the same promotion reads consistently in either UI language,
		* and anything else passes through verbatim — an unrecognized badge is still
		* information the upstream chose to show.
		*/
		function modelBadgeLabel(badge, t) {
			if (badge === "限时免费") return t("badgeLimitedFree");
			if (badge === "夜间折扣") return t("badgeNightDiscount");
			if (badge === "Free now") return t("badgeFreeNow");
			return badge;
		}
		const progressTrackStyle = {
			height: 8,
			overflow: "hidden",
			borderRadius: 999,
			background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))"
		};
		/**
		* Inline confirmation box for a paid detection. Replaces the previous
		* `window.confirm`: the decision is one line plus two buttons, and a modal
		* alert for that is heavier than the action it guards.
		*/
		const confirmBoxStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10,
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1)"
		};
		const confirmRowStyle$1 = {
			display: "flex",
			justifyContent: "flex-end",
			gap: 8
		};
		/** One account: state dot, identity, then the counters on the right. */
		const poolRowStyle = {
			display: "flex",
			alignItems: "flex-start",
			gap: 8,
			padding: "8px 10px",
			borderRadius: 8,
			border: ".5px solid var(--dsw-alias-border-l4)",
			background: "var(--dsw-alias-bg-layer-3)"
		};
		/** Label, chips, and the state line, stacked so a long nickname cannot squeeze the state out. */
		const poolIdentityStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 2,
			minWidth: 0,
			flex: 1
		};
		const poolLabelStyle = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			flexWrap: "wrap"
		};
		const poolLabelTextStyle = {
			fontSize: 13,
			lineHeight: 1.5,
			fontWeight: 500,
			color: "var(--dsw-alias-label-primary)",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			maxWidth: 220
		};
		const poolActiveChipStyle = {
			padding: "1px 8px",
			borderRadius: 999,
			fontSize: 11,
			lineHeight: "18px",
			background: "var(--dsw-alias-brand-primary)",
			color: "var(--dsw-alias-label-primary-foreground)"
		};
		/**
		* The alert chip. Border and text colour are spread in per tone, so this stays
		* a neutral shell; a hardcoded red would ignore the theme's own error colour.
		*/
		const poolStateChipStyle = {
			padding: "1px 8px",
			borderRadius: 999,
			borderWidth: "1px",
			borderStyle: "solid",
			borderColor: "var(--dsw-alias-border-l2)",
			fontSize: 11,
			lineHeight: "18px"
		};
		/** Counters: right-aligned, tertiary, and never wider than the row's own label. */
		const poolMetaStyle = {
			display: "flex",
			flexDirection: "column",
			alignItems: "flex-end",
			gap: 2,
			flex: "0 0 auto",
			fontSize: 12,
			lineHeight: 1.5,
			textAlign: "right",
			color: "var(--dsw-alias-label-tertiary)"
		};
		/** One probeable model's row: name on the left, state and action on the right. */
		const probeRowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 12
		};
		const probeRowEndStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: 8,
			flex: "0 0 auto"
		};
		/**
		* Tab strip for the card body. Kept visually light — a full pill would compete
		* with the section headings, and the card is already the densest surface the
		* plugin owns.
		*/
		const tabBarStyle = {
			display: "flex",
			gap: 4,
			marginTop: 4,
			borderBottom: "1px solid var(--dsw-alias-border-l2)"
		};
		const tabStyle = {
			padding: "6px 12px",
			border: 0,
			borderBottom: "2px solid transparent",
			background: "transparent",
			color: "var(--dsw-alias-label-tertiary)",
			font: "inherit",
			fontSize: 13,
			lineHeight: "20px",
			cursor: "pointer"
		};
		const tabActiveStyle = {
			borderBottom: "2px solid var(--dsw-alias-brand-primary)",
			color: "var(--dsw-alias-label-primary)",
			fontWeight: 600
		};
		const tabPanelStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 18,
			paddingTop: 16
		};
		/**
		* The unified card's variant switcher: a segmented control, not the tab strip
		* above it.
		*
		* It sits at the TOP of the card body and chooses WHICH account the rest of
		* the card shows, so it reads as a container switcher — an inset track with a
		* raised active segment — while the strip below stays a flat underline for
		* switching sections within one account. The tints are the theme's own layer
		* tokens, so the control matches the settings shell's other segmented picks.
		*/
		const segmentedContainerStyle = {
			display: "flex",
			alignItems: "center",
			background: "var(--dsw-alias-bg-layer-1, rgba(20, 20, 20, 0.6))",
			borderWidth: "1px",
			borderStyle: "solid",
			borderColor: "var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08))",
			borderRadius: 8,
			padding: 3,
			gap: 4,
			marginTop: 14,
			marginBottom: 16
		};
		function segmentedTabItemStyle(active) {
			return {
				flex: 1,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				gap: 8,
				padding: "6px 12px",
				borderRadius: 6,
				borderWidth: "1px",
				borderStyle: "solid",
				borderColor: active ? "var(--dsw-alias-border-l4, rgba(255, 255, 255, 0.18))" : "transparent",
				background: active ? "var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.08))" : "transparent",
				color: active ? "var(--dsw-alias-label-primary, #fff)" : "var(--dsw-alias-label-tertiary, #8c8c8c)",
				fontWeight: active ? 500 : 400,
				fontSize: 13,
				lineHeight: "18px",
				cursor: "pointer",
				appearance: "none",
				outline: "none",
				transition: "all .16s ease"
			};
		}
		/**
		* Primary action of the inline confirmation. Fill and text colour come from the
		* theme as a pair: `brand-primary` is a light accent here, so pairing it with a
		* hardcoded white would render white-on-white.
		*/
		const primaryButtonStyle$1 = {
			...buttonStyle$1,
			borderWidth: "1px",
			borderStyle: "solid",
			borderColor: "var(--dsw-alias-button-primary-fill)",
			background: "var(--dsw-alias-button-primary-fill)",
			color: "var(--dsw-alias-label-primary-foreground)"
		};
		function progressFillStyle(percent) {
			return {
				width: `${Math.max(0, Math.min(100, percent))}%`,
				height: "100%",
				borderRadius: "inherit",
				background: "var(--dsw-alias-brand-primary, #1677ff)"
			};
		}
		/**
		* Status dot colour. Takes `'loading'` as well as the document's own states:
		* before the first response the card knows nothing about the account, so it must
		* not borrow the signed-out grey — that would read as "nothing is wrong, nobody
		* is signed in" when the truth is "not read yet".
		*/
		function dotStyle(status) {
			return {
				width: 8,
				height: 8,
				borderRadius: "50%",
				flex: "0 0 auto",
				background: status === "signed-in" ? "var(--dsw-alias-state-success-primary, #22a06b)" : status === "error" ? "var(--dsw-alias-state-error-primary, #d92d20)" : "var(--dsw-alias-label-dimmed, #9aa0a6)"
			};
		}
		function formatNumber$1(value) {
			return new Intl.NumberFormat(void 0).format(value);
		}
		function formatTime(ms) {
			return new Intl.DateTimeFormat(void 0, {
				dateStyle: "medium",
				timeStyle: "short"
			}).format(new Date(ms));
		}
		function formatCycleReset(time) {
			const parsed = Date.parse(time);
			if (!Number.isNaN(parsed)) return formatTime(parsed);
			return time;
		}
		/**
		* One billing package as a labeled progress bar.
		*
		* A package whose allowance the upstream never reported (`size` not positive)
		* has no percentage to state. It must not fall back to 100%: the plugin would be
		* claiming a full quota it knows nothing about, which is the opposite of the
		* honest "remaining N" line printed below it. Unknown size therefore renders the
		* percent slot as unknown copy and an unfilled, indeterminate track.
		*/
		function CreditBar({ label, remain, size, unlimited, t }) {
			if (unlimited === true) {
				const quotaText = t("unlimitedQuota");
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: quotaGroupStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: quotaLabelStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: quotaText })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: progressTrackStyle,
							role: "progressbar",
							"aria-label": label,
							"aria-valuetext": quotaText
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: bodyStyle,
							children: quotaText
						})
					]
				});
			}
			const sizeKnown = size > 0;
			const detail = sizeKnown ? t("exactRemaining", {
				remain: formatNumber$1(remain),
				size: formatNumber$1(size)
			}) : t("creditPackageUnknownSize", { remain: formatNumber$1(remain) });
			const percent = sizeKnown ? remain / size * 100 : void 0;
			const display = percent === void 0 ? t("percentUnknown") : t("percentRemaining", { percent: new Intl.NumberFormat(void 0, { maximumFractionDigits: 1 }).format(percent) });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaGroupStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: quotaLabelStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: display })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: progressTrackStyle,
						role: "progressbar",
						"aria-label": label,
						...percent === void 0 ? { "aria-valuetext": detail } : {
							"aria-valuemin": 0,
							"aria-valuemax": 100,
							"aria-valuenow": percent
						},
						children: percent === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: progressFillStyle(percent) })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: detail
					})
				]
			});
		}
		/**
		* One model offer row: name, promotional badges, and the billing rate.
		*
		* The rate sits under the name rather than beside it because the row already
		* spends its horizontal budget on badges; stacking keeps long model names and
		* several badges from squeezing the rate into an ellipsis.
		*/
		function ModelOfferRow({ model, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: modelOfferStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: quotaLabelStyle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: modelBadgeStyle,
						children: [model.badges?.map((badge) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: modelBadgeChipStyle,
							children: modelBadgeLabel(badge, t)
						}, badge)), model.free === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: modelBadgeChipStyle,
							children: t("freeModel")
						}) : null]
					})]
				}), model.credits === void 0 ? model.rateUnknown === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: modelRateStyle,
					children: model.expiredCredits === void 0 ? t("rateUnknown") : t("rateExpired", {
						rate: model.expiredCredits,
						promo: modelBadgeLabel(model.expiredPromotions?.[0] ?? "", t)
					})
				}) : null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: modelRateStyle,
					children: t("rate", { rate: model.credits })
				})]
			});
		}
		/**
		* Context capacity, listed in full.
		*
		* Every model the upstream reports a capacity for, largest first. A one-line
		* summary with the exceptions on hover was tried and rejected: capacity is
		* reference data you scan by model, and hiding most of it behind a hover made
		* the common case (a model you already have in mind) the hard one to look up.
		*
		* Purely a report of the upstream's own numbers. The plugin offers no tier
		* picker: the CN catalog declares one capacity per model and publishes no
		* alternatives, so a menu there would mean inventing client-side policy. The
		* international document does declare alternatives (`supportedLengths`), and
		* they are shown as a secondary figure rather than merged into one number —
		* the default is the budget actually requested, while the larger value is a
		* ceiling the upstream would accept.
		*/
		function ContextTable({ models, t, useMaximumContextWindow, disabled, onUseMaximumContextWindow }) {
			const known = (models ?? []).filter((model) => model.contextWindow !== void 0).sort((a, b) => b.contextWindow - a.contextWindow);
			const canSelectMaximum = known.some((model) => model.maxContextWindow !== void 0 && model.maxContextWindow > (model.defaultContextWindow ?? model.contextWindow ?? 0));
			const showPreference = onUseMaximumContextWindow !== void 0 && (canSelectMaximum || useMaximumContextWindow === true);
			if (known.length === 0 && !showPreference) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaListStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						style: quotaTitleStyle,
						children: t("contextHeading")
					}),
					showPreference && onUseMaximumContextWindow !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: contextPreferenceStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: useMaximumContextWindow === true,
							disabled,
							onChange: (event) => {
								onUseMaximumContextWindow(event.currentTarget.checked);
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: contextPreferenceCopyStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("useMaximumContextWindow") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: modelRateStyle,
								children: t("useMaximumContextWindowHint")
							})]
						})]
					}) : null,
					known.map((model) => {
						const capacity = model.contextWindow;
						const alternative = model.maxContextWindow !== void 0 && model.maxContextWindow > capacity ? model.maxContextWindow : void 0;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: quotaLabelStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: contextPickerRowStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: formatTokens$1(capacity) }), alternative !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: modelRateStyle,
									children: t("contextUpTo", { size: formatTokens$1(alternative) })
								}) : model.defaultContextWindow !== void 0 && model.defaultContextWindow < capacity ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: modelRateStyle,
									children: t("contextDefault", { size: formatTokens$1(model.defaultContextWindow) })
								}) : null]
							})]
						}, model.id);
					})
				]
			});
		}
		/**
		* Compact token count for display: the catalog's own round numbers (`200000`,
		* `1000000`) read better as `200K` / `1M`, and no precision is lost because
		* these values are always whole thousands.
		*/
		function formatTokens$1(tokens) {
			if (tokens >= 1e6 && tokens % 1e6 === 0) return `${tokens / 1e6}M`;
			if (tokens >= 1e3 && tokens % 1e3 === 0) return `${tokens / 1e3}K`;
			return String(tokens);
		}
		/**
		* Model toggle section: individual model toggles, search filtering, select-all checkbox,
		* and bulk enable/disable actions.
		*/
		function ModelTogglesSection({ models, disabledModels = [], t, disabled, onToggleModel, onSetDisabledModels }) {
			const [search, setSearch] = (0, react.useState)("");
			const disabledSet = new Set(disabledModels);
			const allModels = models ?? [];
			const query = search.trim().toLowerCase();
			const filtered = query === "" ? allModels : allModels.filter((m) => m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query));
			const enabledCount = allModels.filter((m) => !disabledSet.has(m.id)).length;
			const totalCount = allModels.length;
			const filteredEnabledCount = filtered.filter((m) => !disabledSet.has(m.id)).length;
			const allFilteredEnabled = filtered.length > 0 && filteredEnabledCount === filtered.length;
			const someFilteredEnabled = filteredEnabledCount > 0 && filteredEnabledCount < filtered.length;
			const handleSelectAllCheckbox = (checked) => {
				if (checked) {
					const filteredIds = new Set(filtered.map((m) => m.id));
					onSetDisabledModels(disabledModels.filter((id) => !filteredIds.has(id)));
				} else onSetDisabledModels(Array.from(/* @__PURE__ */ new Set([...disabledModels, ...filtered.map((m) => m.id)])));
			};
			const handleEnableAll = () => {
				const filteredIds = new Set(filtered.map((m) => m.id));
				onSetDisabledModels(disabledModels.filter((id) => !filteredIds.has(id)));
			};
			const handleDisableAll = () => {
				onSetDisabledModels(Array.from(/* @__PURE__ */ new Set([...disabledModels, ...filtered.map((m) => m.id)])));
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaListStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: bodyStyle,
							children: t("modelsEnabledCount", {
								enabled: enabledCount,
								total: totalCount
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 8,
								alignItems: "center"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle$1,
								disabled: disabled || filtered.length === 0,
								onClick: handleEnableAll,
								children: t("modelsEnableAll")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle$1,
								disabled: disabled || filtered.length === 0,
								onClick: handleDisableAll,
								children: t("modelsDisableAll")
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							display: "flex",
							gap: 10,
							alignItems: "center"
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "text",
							value: search,
							onChange: (e) => {
								setSearch(e.target.value);
							},
							placeholder: t("modelsSearchPlaceholder"),
							style: {
								flex: 1,
								boxSizing: "border-box",
								padding: "6px 12px",
								border: "1px solid var(--dsw-alias-border-l2)",
								borderRadius: 8,
								background: "var(--dsw-alias-bg-layer-2)",
								color: "var(--dsw-alias-label-primary)",
								fontSize: 13,
								outline: "none"
							}
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							padding: "4px 0",
							borderBottom: "1px solid var(--dsw-alias-border-l2)"
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 8,
								cursor: disabled || filtered.length === 0 ? "default" : "pointer",
								fontSize: 13,
								color: "var(--dsw-alias-label-secondary)"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								disabled: disabled || filtered.length === 0,
								checked: allFilteredEnabled,
								ref: (el) => {
									if (el) el.indeterminate = someFilteredEnabled;
								},
								onChange: (e) => {
									handleSelectAllCheckbox(e.currentTarget?.checked ?? e.target.checked);
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("modelsSelectAll") })]
						})
					}),
					filtered.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("modelsNoMatch")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 8
						},
						children: filtered.map((model) => {
							const isEnabled = !disabledSet.has(model.id);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
									padding: "8px 10px",
									borderRadius: 8,
									background: "var(--dsw-alias-bg-layer-2)",
									border: "1px solid var(--dsw-alias-border-l2)"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										flexDirection: "column",
										gap: 2,
										minWidth: 0,
										flex: 1
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "flex",
											alignItems: "center",
											gap: 8,
											flexWrap: "wrap"
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													fontSize: 13,
													fontWeight: 500,
													color: "var(--dsw-alias-label-primary)"
												},
												children: model.name
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												style: {
													fontSize: 11,
													color: "var(--dsw-alias-label-tertiary)"
												},
												children: [
													"(",
													model.id,
													")"
												]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												style: modelBadgeStyle,
												children: [model.badges?.map((badge) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: modelBadgeChipStyle,
													children: modelBadgeLabel(badge, t)
												}, badge)), model.free === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: modelBadgeChipStyle,
													children: t("freeModel")
												}) : null]
											})
										]
									}), model.credits !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: modelRateStyle,
										children: t("rate", { rate: model.credits })
									}) : model.rateUnknown === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: modelRateStyle,
										children: model.expiredCredits === void 0 ? t("rateUnknown") : t("rateExpired", {
											rate: model.expiredCredits,
											promo: modelBadgeLabel(model.expiredPromotions?.[0] ?? "", t)
										})
									}) : null]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									style: {
										display: "flex",
										alignItems: "center",
										gap: 6,
										cursor: disabled ? "default" : "pointer",
										flexShrink: 0
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: isEnabled,
										disabled,
										onChange: (e) => {
											onToggleModel(model.id, e.currentTarget?.checked ?? e.target.checked);
										}
									})
								})]
							}, model.id);
						})
					})
				]
			});
		}
		/**
		* Reasoning-effort detection section: consent switches, per-model detection,
		* and the recorded observations.
		*
		* Two deliberate UX rules from the plan (§3.1, §3.2):
		* - the confirmation is shown *before* any request, and its copy states the
		*   credit caveat;
		* - a `non-validating` result is presented as an observation about the
		*   parameter ("this model does not check it"), never as a statement that a
		*   level is unsupported.
		*/
		function ProbeSection({ probe, t, onDetect, onClear, busy }) {
			const [pending, setPending] = (0, react.useState)();
			const [runningModel, setRunningModel] = (0, react.useState)();
			(0, react.useEffect)(() => {
				if (pending !== void 0 && !probe.candidates.includes(pending)) setPending(void 0);
			}, [pending, probe.candidates]);
			const runningArmed = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (runningModel === void 0) return;
				if (busy || probe.running) {
					runningArmed.current = true;
					return;
				}
				if (!runningArmed.current) return;
				runningArmed.current = false;
				setRunningModel(void 0);
			}, [
				runningModel,
				busy,
				probe.running
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaListStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						style: quotaTitleStyle,
						children: t("probeHeading")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("probeIntro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("probeConsentHint")
					}),
					probe.running ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("probeRunningGeneric")
					}) : null,
					probe.candidates.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("probeResultEmpty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: quotaGroupStyle,
						children: probe.candidates.map((id) => {
							const result = probe.results.find((entry) => entry.id === id);
							const name = result?.name ?? id;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: modelOfferStyle,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: probeRowStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: name }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: probeRowEndStyle,
											children: [result === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: modelBadgeChipStyle,
												children: result.validation === "validating" && result.efforts.length > 0 ? result.efforts.join(" / ") : t(result.validation === "non-validating" ? "probeResultNotValidating" : "probeResultUnknown")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: buttonStyle$1,
												disabled: probe.running || busy,
												onClick: () => {
													setPending(id);
												},
												children: runningModel === id ? t("probeRunning", { model: id }) : t(result === void 0 ? "probeStart" : "probeRedetect")
											})]
										})]
									}),
									result === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: modelRateStyle,
										children: t("probeResultAt", { time: formatTime(result.probedAt) })
									}),
									pending === id ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: confirmBoxStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: bodyStyle,
											children: t("probeConfirmBody", { model: name })
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: confirmRowStyle$1,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: buttonStyle$1,
												onClick: () => {
													setPending(void 0);
												},
												children: t("cancel")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: primaryButtonStyle$1,
												disabled: probe.running || busy,
												onClick: () => {
													setRunningModel(id);
													setPending(void 0);
													onDetect(id);
												},
												children: t("probeConfirmAction")
											})]
										})]
									}) : null
								]
							}, id);
						})
					}),
					probe.results.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: buttonStyle$1,
						disabled: busy,
						onClick: () => {
							onClear();
						},
						children: t("probeClear")
					})
				]
			});
		}
		function CheckInLogTable({ logs = [], t, onCheckIn, onRefresh, onClear, busy, checkingIn, clearing, disabled, notice }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaListStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							flexWrap: "wrap",
							gap: 8
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: quotaTitleStyle,
							children: t("tabCheckIn")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 6
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: buttonStyle$1,
									disabled: disabled || busy || checkingIn,
									onClick: onCheckIn,
									children: checkingIn ? t("checkInChecking") : t("checkInNow")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: buttonStyle$1,
									disabled: busy || checkingIn,
									onClick: onRefresh,
									children: busy ? t("checkInRefreshing") : t("checkInRefresh")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: buttonStyle$1,
									disabled: busy || clearing || !logs || logs.length === 0,
									onClick: onClear,
									children: clearing ? t("checkInClearing") : t("checkInClear")
								})
							]
						})]
					}),
					notice === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: notice
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: descriptionStyle,
						children: t("checkInNextRun")
					}),
					!logs || logs.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: descriptionStyle,
						children: t("checkInLogEmpty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 6
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.15))",
								paddingBottom: 6,
								fontSize: 12,
								color: "var(--dsw-alias-label-tertiary)"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { flex: 2 },
									children: t("checkInLogTime")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { flex: 3 },
									children: t("checkInLogResult")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										flex: 1,
										textAlign: "right"
									},
									children: t("checkInLogAmount")
								})
							]
						}), logs.map((log) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "center",
								padding: "6px 0",
								fontSize: 13,
								borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.08))"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										flex: 2,
										color: "var(--dsw-alias-label-secondary)"
									},
									children: formatTime(log.timestamp)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										flex: 3,
										display: "flex",
										alignItems: "center",
										gap: 6
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
										width: 6,
										height: 6,
										borderRadius: "50%",
										flexShrink: 0,
										background: log.status === "claimed" ? "var(--dsw-alias-status-success, #52c41a)" : log.status === "already-claimed" ? "var(--dsw-alias-status-info, #1890ff)" : log.status === "no-campaign" ? "var(--dsw-alias-label-tertiary, #999)" : "var(--dsw-alias-status-error, #f5222d)"
									} }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: log.status === "claimed" ? t("autoCheckInStatusClaimed", { amount: log.amount ?? 100 }) : log.status === "already-claimed" ? t("autoCheckInStatusAlready") : log.status === "no-campaign" ? t("autoCheckInStatusNoCampaign") : t("autoCheckInStatusError", { message: log.message ?? "" }) })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										flex: 1,
										textAlign: "right",
										fontWeight: 600,
										color: log.amount ? "var(--dsw-alias-brand-primary)" : "inherit"
									},
									children: log.amount ? `+${log.amount}` : "-"
								})
							]
						}, log.id))]
					})
				]
			});
		}
		/**
		* One account's line in the pool, plus the bits it needs from the clock.
		*
		* Split out of the section so the per-second tick re-renders only what the
		* clock actually changes, and so the state wording, its colour, and the chips
		* beside it stay in one place — three things that describe the same account and
		* would otherwise be easy to let disagree.
		*/
		function PoolAccountRow({ account, now }) {
			const remainingMs = account.cooldownUntilMs > now ? account.cooldownUntilMs - now : 0;
			const cooling = remainingMs > 0;
			const needsSignIn = account.needsSignIn === true;
			const tone = needsSignIn ? "danger" : cooling ? "warn" : "ok";
			const toneColor = tone === "danger" ? "var(--dsw-alias-state-error-primary, #d92d20)" : tone === "warn" ? "var(--dsw-alias-state-warn-primary, #b8860b)" : "var(--dsw-alias-state-success-primary, #22a06b)";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: poolRowStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							...dotStyle(needsSignIn ? "error" : "signed-in"),
							background: toneColor
						},
						"aria-hidden": "true"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: poolIdentityStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: poolLabelStyle,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: poolLabelTextStyle,
									children: account.label
								}),
								account.active === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: poolActiveChipStyle,
									children: "当前活跃"
								}) : null,
								needsSignIn ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										...poolStateChipStyle,
										color: toneColor,
										borderColor: toneColor
									},
									children: "需重新登录"
								}) : null
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: modelRateStyle,
							children: poolAccountStateText(account, remainingMs, now)
						})]
					}),
					account.rateLimitHits > 0 || account.lastSuccessAtMs !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: poolMetaStyle,
						children: [account.rateLimitHits > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "累计限流 " + String(account.rateLimitHits) + " 次" }) : null, account.lastSuccessAtMs === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "上次成功 " + formatClockTime(account.lastSuccessAtMs) })]
					}) : null
				]
			});
		}
		/**
		* The account's state as a sentence, from the deadline already computed by the
		* row. Cooldown reasons are the upstream's own failure classes, translated here
		* because "soft_rate" tells a user nothing about what to do next; anything the
		* plugin does not recognize passes through verbatim rather than being replaced
		* by a vague "冷却中", which would hide the very diagnosis the host went to the
		* trouble of forwarding.
		*/
		function poolAccountStateText(account, remainingMs, now) {
			if (account.needsSignIn === true) return "需重新登录";
			if (remainingMs > 0) return "冷却中 · 剩余 " + formatCountdown(remainingMs) + " · " + cooldownReasonText(account.cooldownReason);
			if (account.cooldownUntilMs > 0 && account.cooldownUntilMs <= now) return "冷却已结束（" + cooldownReasonText(account.cooldownReason) + "），可再次使用";
			return "可用";
		}
		/** One upstream failure class in words a user can act on. Unknown classes pass through. */
		function cooldownReasonText(reason) {
			if (reason === "soft_rate") return "触发限流";
			if (reason === "hard_credit") return "额度耗尽";
			if (reason === "session_dead") return "登录已失效";
			if (reason === void 0 || reason === "") return "原因未知";
			return reason;
		}
		/**
		* Remaining cooldown as 分/秒. Rounded up, so a deadline 900 ms away reads as
		* "1 秒" rather than "0 秒" — a row that says zero seconds while still being
		* treated as cooling is a contradiction the user would have to resolve.
		*/
		function formatCountdown(remainingMs) {
			const totalSeconds = Math.max(1, Math.ceil(remainingMs / 1e3));
			const minutes = Math.floor(totalSeconds / 60);
			const seconds = totalSeconds % 60;
			return minutes > 0 ? String(minutes) + " 分 " + String(seconds) + " 秒" : String(seconds) + " 秒";
		}
		/**
		* HH:MM in the *viewer's* zone, zero-padded by hand.
		*
		* Not `toLocaleString`: the harness pins the locale, so a locale-formatted
		* clock can disagree with the wall clock the user is looking at. Only the hour
		* and minute are printed — this is a "how recently did this account work" hint,
		* not an audit trail, and the date is already implied by the row's presence.
		*/
		function formatClockTime(ms) {
			const date = new Date(ms);
			return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
		}
		function pad2(value) {
			return value < 10 ? "0" + String(value) : String(value);
		}
		/**
		* The account pool: which sign-ins share this variant's traffic, and which of
		* them is resting.
		*
		* Why this section exists at all, given that pooling is meant to be invisible:
		* the model picker deliberately shows ONE group per variant, so nothing else in
		* the UI admits that several accounts are in play. That is the right call while
		* the pool is healthy — a user should not have to care which login served a
		* request — but it leaves the two states that DO concern them unobservable: an
		* account that has quietly exhausted its quota, and one whose credential has
		* died and will need a fresh sign-in. Since the pool routes around both, the
		* symptom without this section is a silent quality drop (and, at the end of the
		* pool, requests that fail with no explanation of which login ran out). So the
		* pool stays transparent in routing and becomes *visible* in status: nothing
		* here is actionable except the sign-in prompt, and everything else is there so
		* "why did this get slower" has an answer on screen.
		*
		* The section renders NOTHING when the host sends no `pool`: a single-account
		* variant is not a pool of one, and a lone row would advertise pooling to users
		* who do not have it. An empty `accounts` array is treated the same way — the
		* host sends no pool at all in that case, and a bare heading over a blank list
		* is worse than no section.
		*/
		function PoolSection({ pool }) {
			const [now, setNow] = (0, react.useState)(() => Date.now());
			(0, react.useEffect)(() => {
				if (!pool.accounts.some((account) => account.cooldownUntilMs > Date.now())) return;
				const timer = window.setInterval(() => {
					setNow(Date.now());
				}, POOL_TICK_MS);
				return () => {
					window.clearInterval(timer);
				};
			}, [pool]);
			if (pool.accounts.length === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaListStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: quotaTitleStyle,
							children: "账号池"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: bodyStyle,
							children: "共 " + String(pool.accounts.length) + " 个账号，" + String(pool.available) + " 个可用"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: descriptionStyle,
						children: "以下账号会自动轮换，请求时使用其中可用的一个；当前没有可免登录恢复的账号时才需要处理。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: quotaGroupStyle,
						children: pool.accounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PoolAccountRow, {
							account,
							now
						}, account.id))
					})
				]
			});
		}
		/** Render WorkBuddy sign-in state and credit as one expandable card. */
		function WorkBuddyPluginCard(props) {
			const { t, scope, signedIn, variant, unified, defaultOpen } = props;
			if (t === void 0) throw new Error("WorkBuddy plugin card requires its translation function");
			const isUnified = unified === true;
			const liveSignIn = (0, react.useSyncExternalStore)(onQuotaSettingsChange, quotaSignInState);
			const [activeVariantId, setActiveVariantId] = (0, react.useState)("workbuddy");
			const currentVariant = isUnified ? activeVariantId === "workbuddy" ? CN_CARD_VARIANT : AI_CARD_VARIANT : variant ?? CN_CARD_VARIANT;
			const [open, setOpen] = (0, react.useState)(defaultOpen === true);
			/** Whether the pointer is over the card; drives the same border tint the built-in card gets on hover. */
			const [hovered, setHovered] = (0, react.useState)(false);
			/** Keyboard focus on the header, reproducing the built-in's `:focus-visible` ring. */
			const [headerFocused, setHeaderFocused] = (0, react.useState)(false);
			/**
			* The document to render. `undefined` means *not read yet*, which is a
			* distinct state from "signed out": seeding this with a signed-out document
			* told an already-signed-in user they were signed out for the whole first
			* round trip (and forever, if the read never settled).
			*/
			const [status, setStatus] = (0, react.useState)();
			/**
			* Whether the last **successful** read found a usable credential.
			*
			* Kept apart from `status` because the poll's liveness must depend on what the
			* account actually is, not on what the card last displayed: a failed read
			* leaves this untouched, so a transient failure cannot disarm the interval,
			* while a genuine signed-out answer still stops it.
			*
			* `undefined` therefore means "no successful read yet", which is also the
			* condition that decides whether a failed read has anything to preserve.
			*
			* Named `...State` because in unified mode the injected sign-in reader is
			* `signedIn` — the two are different things and must not shadow each other.
			*/
			const [signedInState, setSignedInState] = (0, react.useState)();
			/**
			* Why the most recent read failed, when it did. Rendered as a notice beside
			* whatever document is still on screen, rather than replacing it.
			*/
			const [readFailure, setReadFailure] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			/**
			* The in-flight sign-in attempt, when there is one.
			*
			* `state` is the attempt to poll and `url` is where the human was sent, kept
			* so the card can offer the link again after a re-render or a popup blocker
			* stopped the automatic tab.
			*/
			const [signIn, setSignIn] = (0, react.useState)();
			/** Why the most recent sign-in attempt failed, when it did. */
			const [signInError, setSignInError] = (0, react.useState)();
			/** Outcome of the most recent credential import, for the card to report. */
			const [importNotice, setImportNotice] = (0, react.useState)();
			/** The hidden file input the import button drives. */
			const importInput = (0, react.useRef)(null);
			const [tab, setTab] = (0, react.useState)("status");
			const [checkingIn, setCheckingIn] = (0, react.useState)(false);
			const [clearingLogs, setClearingLogs] = (0, react.useState)(false);
			const [checkInNotice, setCheckInNotice] = (0, react.useState)();
			const mounted = (0, react.useRef)(true);
			/**
			* Identity of the newest read that may write. Assigned when a read *starts*,
			* so a response is superseded by anything begun after it — "the response whose
			* request started last wins". Without this, a slow poll begun before a manual
			* action could settle after the action's own refresh and restore the older
			* document.
			*/
			const readSeq = (0, react.useRef)(0);
			/** Manual requests in flight, so unmount can abort them like the poll's. */
			const manualControllers = (0, react.useRef)(/* @__PURE__ */ new Set());
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
					for (const controller of manualControllers.current) controller.abort();
					manualControllers.current.clear();
				};
			}, []);
			/** Register a manual request's controller so unmount aborts it. */
			const trackController = (0, react.useCallback)(() => {
				const controller = new AbortController();
				manualControllers.current.add(controller);
				return controller;
			}, []);
			/**
			* The in-process key authorizing this card's writes, or undefined until a
			* document carrying one has been read.
			*
			* Derived once rather than read off each use site: the `error` arm carries no
			* key, and reaching for `status.loginKey` in three places is three chances to
			* dereference a state that has none.
			*/
			const actionKey = status === void 0 || status.status === "error" ? void 0 : status.loginKey;
			/**
			* Read the status document and apply it under the two policies the card's
			* correctness rests on:
			*
			* - a non-document body (empty, `null`, a non-JSON page) is a failed read, not
			*   something to store and then dereference in the render;
			* - a failed read never discards a document already on screen. It is recorded
			*   and shown as a notice beside that document; only when nothing has been
			*   read yet does the failure itself become the rendered state.
			*
			* Returns whether this read produced the current document.
			*/
			const refresh = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const current = () => mounted.current && signal?.aborted !== true && seq === readSeq.current;
				try {
					const response = await fetch(currentVariant.statusPath, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (!isWorkBuddyWebStatus(value)) throw new Error(t("statusResponseInvalid"));
					if (!current()) return false;
					setStatus(value);
					if (value.status === "signed-in") {
						setSignedInState(true);
						noteQuotaStatus(currentVariant.id, value);
					} else if (value.status === "signed-out") {
						setSignedInState(false);
						noteQuotaStatus(currentVariant.id, value);
					}
					setReadFailure(void 0);
					return true;
				} catch (error) {
					const message = error instanceof Error ? error.message : t("requestFailed");
					if (current()) {
						setReadFailure(message);
						setStatus((previous) => previous === void 0 ? {
							status: "error",
							message
						} : previous);
					}
					return false;
				}
			}, [
				currentVariant.statusPath,
				currentVariant.id,
				t
			]);
			(0, react.useEffect)(() => {
				if (!open) return;
				setStatus(void 0);
				setSignedInState(void 0);
				setReadFailure(void 0);
				setSignIn(void 0);
				setSignInError(void 0);
				setImportNotice(void 0);
				const controller = new AbortController();
				refresh(controller.signal);
				return () => {
					controller.abort();
				};
			}, [
				open,
				currentVariant.statusPath,
				refresh
			]);
			(0, react.useEffect)(() => {
				if (!open || signedInState === false) return;
				const controller = new AbortController();
				const timer = window.setInterval(() => {
					refresh(controller.signal);
				}, POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [
				open,
				refresh,
				signedInState
			]);
			const manualRefresh = async () => {
				setBusy(true);
				const controller = trackController();
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setBusy(false);
				}
			};
			/**
			* Ask the host to re-read the credential and re-fetch this variant's catalog.
			*
			* Shares the probe route's key and guards: it is a write that spends an
			* upstream request, so it does not belong on the read-only status GET. A
			* failure is surfaced through the refreshed document's `catalog.error` rather
			* than thrown away, so the reason survives the round trip.
			*/
			const refreshModels = (0, react.useCallback)(async () => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) return;
				setBusy(true);
				const controller = trackController();
				try {
					const response = await fetch(currentVariant.probePath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-WorkBuddy-Probe-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify({ action: "refresh" })
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setReadFailure(error instanceof Error ? error.message : t("requestFailed"));
					manualControllers.current.delete(controller);
					return;
				} finally {
					if (mounted.current) setBusy(false);
				}
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
				}
			}, [
				currentVariant.probePath,
				refresh,
				status,
				t,
				trackController
			]);
			/**
			* Run one control action and refresh the card's state afterwards.
			*
			* The key travels in a header, not the body: it authorizes the write, and
			* the host never accepts a prompt, a sentinel, or a model outside its own
			* catalog from here.
			*/
			const control = (0, react.useCallback)(async (action) => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) return;
				setBusy(true);
				const controller = trackController();
				try {
					const response = await fetch(currentVariant.probePath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-WorkBuddy-Probe-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify(action)
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) {
						const message = typeof value === "object" && value !== null && "error" in value ? String(value["error"]) : `HTTP ${response.status}`;
						throw new Error(message);
					}
					if (action.action === "set-maximum-context-window" && (typeof value !== "object" || value === null || value["state"] !== "updated")) {
						const reason = typeof value === "object" && value !== null && "reason" in value ? String(value["reason"]) : t("requestFailed");
						throw new Error(reason);
					}
					if (action.action === "set-disabled-models" && (typeof value !== "object" || value === null || value["state"] !== "updated")) {
						const reason = typeof value === "object" && value !== null && "reason" in value ? String(value["reason"]) : t("requestFailed");
						throw new Error(reason);
					}
					await refresh(controller.signal);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setReadFailure(error instanceof Error ? error.message : t("requestFailed"));
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setBusy(false);
				}
			}, [
				currentVariant.probePath,
				refresh,
				status,
				t,
				trackController
			]);
			const manualCheckIn = (0, react.useCallback)(async () => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) return;
				setCheckingIn(true);
				setCheckInNotice(void 0);
				const controller = trackController();
				try {
					const response = await fetch(currentVariant.probePath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-WorkBuddy-Probe-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify({ action: "checkin" })
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const result = await response.json();
					if (result.state === "claimed") setCheckInNotice(t("autoCheckInStatusClaimed", { amount: result.amount ?? 100 }));
					else if (result.state === "already-claimed") setCheckInNotice(t("autoCheckInStatusAlready"));
					else if (result.state === "no-campaign") setCheckInNotice(t("autoCheckInStatusNoCampaign"));
					else if (result.reason) setCheckInNotice(t("autoCheckInStatusError", { message: result.reason }));
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setCheckInNotice(error instanceof Error ? error.message : t("requestFailed"));
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setCheckingIn(false);
				}
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
				}
			}, [
				currentVariant.probePath,
				refresh,
				status,
				t,
				trackController
			]);
			const clearCheckInLogs = (0, react.useCallback)(async () => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) return;
				setClearingLogs(true);
				setCheckInNotice(void 0);
				const controller = trackController();
				try {
					const response = await fetch(currentVariant.probePath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-WorkBuddy-Probe-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify({ action: "clear-checkin-logs" })
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setCheckInNotice(error instanceof Error ? error.message : t("requestFailed"));
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setClearingLogs(false);
				}
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
				}
			}, [
				currentVariant.probePath,
				refresh,
				status,
				t,
				trackController
			]);
			/**
			* Start a detection. Confirmation happens inline in the section, so this is
			* only ever called after the user has already agreed.
			*/
			const confirmDetect = (0, react.useCallback)((modelId) => {
				control({
					action: "probe",
					model: modelId
				});
			}, [control]);
			/**
			* Start a fresh attempt against this variant's realm, and send the browser to it.
			*
			* Shared by the signed-out card's sign-in button and by the signed-in card's
			* account switch, which differ only in whether a credential was discarded
			* first. The card never names the realm: the route it posts to belongs to this
			* variant, so the host decides which upstream is signed in to. The returned
			* URL is opened here rather than by the host because only the page can open a
			* tab the user's popup blocker will accept as a response to their click.
			*/
			const startAttempt = (0, react.useCallback)(async (key) => {
				setSignInError(void 0);
				setBusy(true);
				const controller = trackController();
				try {
					const response = await fetch(currentVariant.loginPath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-WorkBuddy-Login-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify({ action: "begin" })
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const record = typeof value === "object" && value !== null ? value : {};
					const state = typeof record["state"] === "string" ? record["state"] : "";
					const url = typeof record["url"] === "string" ? record["url"] : "";
					if (state === "" || url === "") throw new Error(t("requestFailed"));
					setSignIn({
						state,
						url
					});
					window.open(url, "_blank", "noopener,noreferrer");
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setSignInError(error instanceof Error ? error.message : t("requestFailed"));
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setBusy(false);
				}
			}, [
				currentVariant.loginPath,
				t,
				trackController
			]);
			/** The signed-out card's sign-in button. */
			const beginSignIn = (0, react.useCallback)(async () => {
				const key = actionKey;
				if (key === void 0) return;
				await startAttempt(key);
			}, [actionKey, startAttempt]);
			/** Remove the stored credential and forget the account. */
			const signOut = (0, react.useCallback)(async () => {
				if (status?.status !== "signed-in" || status.loginKey === void 0) return;
				const key = status.loginKey;
				setBusy(true);
				const controller = trackController();
				try {
					const response = await fetch(currentVariant.loginPath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-WorkBuddy-Login-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify({ action: "logout" })
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					setSignIn(void 0);
					const signedOutDoc = {
						status: "signed-out",
						loginKey: key
					};
					setStatus(signedOutDoc);
					setSignedInState(false);
					noteQuotaStatus(currentVariant.id, signedOutDoc);
					noteQuotaSignIn(currentVariant.id, false);
					await refresh(controller.signal);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setReadFailure(error instanceof Error ? error.message : t("requestFailed"));
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setBusy(false);
				}
			}, [
				currentVariant.id,
				currentVariant.loginPath,
				refresh,
				status,
				t,
				trackController
			]);
			/**
			* Replace the signed-in account: discard the stored credential, then start a
			* fresh attempt.
			*
			* One action rather than two, because the halves are only useful together: a
			* user switching accounts has no reason to stay signed out in between, and
			* making them press sign-out and then sign-in would leave a window where the
			* card shows no account and the second button is easy to miss.
			*
			* The credential is the only thing discarded — the previous account's saved
			* catalog and probe records are keyed by account, so they are left alone and
			* simply stop applying.
			*/
			const switchAccount = (0, react.useCallback)(async () => {
				const key = actionKey;
				if (key === void 0) return;
				setBusy(true);
				setImportNotice(void 0);
				setSignInError(void 0);
				const controller = trackController();
				try {
					const response = await fetch(currentVariant.loginPath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-WorkBuddy-Login-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify({ action: "logout" })
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					setSignIn(void 0);
					const signedOutDoc = {
						status: "signed-out",
						loginKey: key
					};
					setStatus(signedOutDoc);
					setSignedInState(false);
					noteQuotaStatus(currentVariant.id, signedOutDoc);
					noteQuotaSignIn(currentVariant.id, false);
					await refresh(controller.signal);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setReadFailure(error instanceof Error ? error.message : t("requestFailed"));
					return;
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setBusy(false);
				}
				await startAttempt(key);
			}, [
				actionKey,
				currentVariant.id,
				currentVariant.loginPath,
				refresh,
				startAttempt,
				t,
				trackController
			]);
			/**
			* Poll the active attempt until it settles.
			*
			* Polling lives here rather than in the route because the browser already
			* holds the cadence machinery (and this way an abandoned tab stops polling on
			* its own). A `failed` answer ends the attempt and is reported; `pending`
			* keeps waiting.
			*/
			(0, react.useEffect)(() => {
				if (signIn === void 0) return;
				let cancelled = false;
				const timer = setInterval(() => {
					(async () => {
						const key = actionKey;
						if (key === void 0) return;
						try {
							const value = await (await fetch(currentVariant.loginPath, {
								method: "POST",
								headers: {
									"Content-Type": "application/json",
									"X-WorkBuddy-Login-Key": key
								},
								credentials: "same-origin",
								body: JSON.stringify({
									action: "poll",
									state: signIn.state
								})
							})).json().catch(() => void 0);
							if (cancelled || !mounted.current) return;
							const record = typeof value === "object" && value !== null ? value : {};
							const outcome = record["status"];
							if (outcome === "complete") {
								setSignIn(void 0);
								setSignInError(void 0);
								noteQuotaSignIn(currentVariant.id, true);
								await refresh();
								return;
							}
							if (outcome === "failed") {
								setSignIn(void 0);
								setSignInError(typeof record["message"] === "string" ? record["message"] : t("requestFailed"));
							}
						} catch {}
					})();
				}, 2e3);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, [
				actionKey,
				currentVariant.id,
				currentVariant.loginPath,
				signIn,
				refresh,
				t
			]);
			/**
			* Adopt a credential file the user picked.
			*
			* The browser reads the file and posts its text; the host parses and validates
			* it. The card never inspects the document itself — the realm check and the
			* write belong to the side that owns the credential store, and a card that
			* decided either would be a second, weaker authority.
			*/
			const importCredential = (0, react.useCallback)(async (file) => {
				if (status?.status !== "signed-out" || status.loginKey === void 0) return;
				const key = status.loginKey;
				setImportNotice(void 0);
				setBusy(true);
				const controller = trackController();
				try {
					const document = await file.text();
					const response = await fetch(currentVariant.loginPath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-WorkBuddy-Login-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify({
							action: "import",
							document
						})
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const record = typeof value === "object" && value !== null ? value : {};
					if (record["status"] === "imported") {
						const account = typeof record["nickname"] === "string" && record["nickname"] !== "" ? record["nickname"] : typeof record["uid"] === "string" && record["uid"] !== "" ? record["uid"] : "";
						setImportNotice({
							kind: "done",
							text: t("importDone", { account: account === "" ? "—" : account })
						});
						noteQuotaSignIn(currentVariant.id, true);
						await refresh(controller.signal);
						return;
					}
					setImportNotice({
						kind: "failed",
						text: t("importFailed", { message: typeof record["message"] === "string" ? record["message"] : t("requestFailed") })
					});
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setImportNotice({
						kind: "failed",
						text: t("importFailed", { message: error instanceof Error ? error.message : t("requestFailed") })
					});
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setBusy(false);
				}
			}, [
				currentVariant.id,
				currentVariant.loginPath,
				refresh,
				status,
				t,
				trackController
			]);
			const cardTitle = isUnified ? t("unifiedTitle") : t(currentVariant.titleKey);
			const cardIntro = isUnified ? t("unifiedIntro") : t(currentVariant.introKey);
			const label = status === void 0 ? t("loading") : status.status === "signed-in" ? status.nickname === void 0 ? t("signedInAs", { nickname: "" }).trimEnd().replace(/[:：]$/, "") : t("signedInAs", { nickname: status.nickname }) : status.status === "error" ? t("requestFailed") : t("signedOut");
			/**
			* The dot inside each segment of the variant switcher.
			*
			* The variant on screen reports what its own read found — including
			* 'loading' before the first document lands, which is a different fact from
			* "signed out". The other variant can only be judged by what the shared
			* store has heard from some other surface.
			*
			* An explicit `signedIn` reader is authoritative when present; the store is
			* the fallback. They are NOT OR'd: an optimistic store `true` surviving a
			* sign-out would light a dot for an account nobody is in.
			*/
			const reported = signedIn?.();
			const cnSignedIn = reported !== void 0 ? reported.cn : liveSignIn.cn;
			const aiSignedIn = reported !== void 0 ? reported.ai : liveSignIn.ai;
			const cnDotStatus = isUnified && activeVariantId === "workbuddy" ? status === void 0 ? "loading" : status.status : cnSignedIn ? "signed-in" : "signed-out";
			const aiDotStatus = isUnified && activeVariantId === "workbuddy-ai" ? status === void 0 ? "loading" : status.status : aiSignedIn ? "signed-in" : "signed-out";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				style: {
					...cardStyle,
					...hovered ? cardHoverStyle : {},
					...open ? cardOpenStyle : {}
				},
				onMouseEnter: () => {
					setHovered(true);
				},
				onMouseLeave: () => {
					setHovered(false);
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					style: {
						...headerStyle,
						...headerFocused ? headerFocusStyle : {}
					},
					"aria-expanded": open,
					"aria-label": `${t(open ? "collapse" : "expand")}: ${cardTitle}`,
					onClick: () => {
						setOpen(!open);
					},
					onFocus: (event) => {
						let keyboard = true;
						try {
							keyboard = event.currentTarget.matches(":focus-visible");
						} catch {
							keyboard = true;
						}
						if (keyboard) setHeaderFocused(true);
					},
					onBlur: () => {
						setHeaderFocused(false);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: headTextStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: nameStyle,
							children: cardTitle
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: descriptionStyle,
							children: cardIntro
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							...chevronStyle,
							transform: open ? "rotate(180deg)" : "none"
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChevronDownIcon, {})
					})]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: cardBodyStyle,
					children: [
						isUnified ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaSettingsContent, {
							t,
							scope,
							signedIn
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: segmentedContainerStyle,
							role: "tablist",
							"aria-label": "WorkBuddy Version Selection",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								role: "tab",
								"aria-selected": activeVariantId === "workbuddy",
								style: segmentedTabItemStyle(activeVariantId === "workbuddy"),
								onClick: () => setActiveVariantId("workbuddy"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: dotStyle(cnDotStatus),
									"aria-hidden": "true"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("variantTabCN") })]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								role: "tab",
								"aria-selected": activeVariantId === "workbuddy-ai",
								style: segmentedTabItemStyle(activeVariantId === "workbuddy-ai"),
								onClick: () => setActiveVariantId("workbuddy-ai"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: dotStyle(aiDotStatus),
									"aria-hidden": "true"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("variantTabAI") })]
							})]
						})] }) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: quotaTitleStyle,
							children: t("accountHeading")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: rowStyle,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: statusStyle,
									role: "status",
									"aria-busy": status === void 0,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										"aria-hidden": "true",
										style: dotStyle(status === void 0 ? "loading" : status.status)
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: buttonStyle$1,
									disabled: busy,
									onClick: () => {
										manualRefresh();
									},
									children: busy ? t("refreshing") : t("refresh")
								}),
								status?.status !== "signed-in" || status.loginKey === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: buttonStyle$1,
										disabled: busy || signIn !== void 0,
										onClick: () => {
											beginSignIn();
										},
										children: signIn === void 0 ? t("addAccount") : t("addingAccount")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: buttonStyle$1,
										disabled: busy,
										onClick: () => {
											switchAccount();
										},
										children: busy ? t("switchingAccount") : t("switchAccount")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: buttonStyle$1,
										disabled: busy,
										onClick: () => {
											signOut();
										},
										children: busy ? t("signingOut") : t("signOut")
									})
								] })
							]
						}),
						status?.status !== "signed-in" || signIn === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: stackStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								href: signIn.url,
								target: "_blank",
								rel: "noopener noreferrer",
								style: bodyStyle,
								children: t("signInOpenAgain")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: bodyStyle,
								children: t("signInWaiting")
							})]
						}),
						readFailure === void 0 || signedInState === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: t("statusRefreshFailed", { message: readFailure })
						}),
						status?.status === "signed-in" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							status.expiresAt === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: bodyStyle,
								children: t("accessTokenExpires", { time: formatTime(status.expiresAt) })
							}),
							status.catalog === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: rowStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: bodyStyle,
									children: [status.catalog.source === "live" && status.catalog.fetchedAt !== void 0 ? t("catalogLive", { time: formatTime(status.catalog.fetchedAt) }) : status.catalog.source === "saved" && status.catalog.fetchedAt !== void 0 ? t("catalogSaved", { time: formatTime(status.catalog.fetchedAt) }) : t("catalogFallback"), status.catalog.appVersion === void 0 ? "" : ` · ${t("catalogAppVersion", { version: status.catalog.appVersion })}`]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: buttonStyle$1,
									disabled: busy,
									onClick: () => {
										refreshModels();
									},
									children: busy ? t("refreshingModels") : t("refreshModels")
								})]
							}),
							status.catalog?.error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: errorStyle,
								children: t("catalogError", { message: status.catalog.error })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								role: "tablist",
								style: tabBarStyle,
								children: [
									"status",
									"context",
									"models",
									"details",
									"checkin"
								].map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "tab",
									"aria-selected": tab === id,
									onClick: () => {
										setTab(id);
									},
									style: {
										...tabStyle,
										...tab === id ? tabActiveStyle : {}
									},
									children: t(id === "status" ? "tabStatus" : id === "context" ? "tabContext" : id === "models" ? "tabModels" : id === "details" ? "tabDetails" : "tabCheckIn")
								}, id))
							}),
							tab === "status" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: tabPanelStyle,
								children: [
									status.credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: quotaListStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: rowStyle,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
												style: quotaTitleStyle,
												children: t("creditsHeading")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: bodyStyle,
												children: status.credits.unlimited === true ? t("creditsTotalUnlimited") : t("creditsTotal", { total: formatNumber$1(status.credits.total) })
											})]
										}), status.credits.cycleResetTime === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: descriptionStyle,
											children: t("cycleResetAt", { time: formatCycleReset(status.credits.cycleResetTime) })
										})]
									}),
									status.activationRequired === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: activationNoticeStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: activationTitleStyle,
											children: t("activationRequiredTitle")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: activationBodyStyle,
											children: t("activationRequiredBody")
										})]
									}) : null,
									status.creditsError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										style: errorStyle,
										children: t("creditsError", { message: status.creditsError })
									}),
									status.pool === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PoolSection, { pool: status.pool }),
									status.probe === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProbeSection, {
										probe: status.probe,
										t,
										busy,
										onDetect: confirmDetect,
										onClear: () => {
											control({ action: "clear" });
										}
									})
								]
							}) : tab === "context" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: tabPanelStyle,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ContextTable, {
									models: status.models,
									t,
									disabled: busy,
									...status.useMaximumContextWindow === void 0 ? {} : { useMaximumContextWindow: status.useMaximumContextWindow },
									...currentVariant.id === AI_CARD_VARIANT.id ? { onUseMaximumContextWindow: (enabled) => {
										control({
											action: "set-maximum-context-window",
											enabled
										});
									} } : {}
								})
							}) : tab === "models" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: tabPanelStyle,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelTogglesSection, {
									models: status.models,
									disabledModels: status.disabledModels,
									t,
									disabled: busy,
									onToggleModel: (modelId, enabled) => {
										const currentDisabled = status.disabledModels ?? [];
										const nextDisabled = enabled ? currentDisabled.filter((id) => id !== modelId) : [...currentDisabled.filter((id) => id !== modelId), modelId];
										control({
											action: "set-disabled-models",
											disabledModels: nextDisabled
										});
									},
									onSetDisabledModels: (disabledIds) => {
										control({
											action: "set-disabled-models",
											disabledModels: disabledIds
										});
									}
								})
							}) : tab === "details" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: tabPanelStyle,
								children: [status.credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: quotaListStyle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										style: quotaTitleStyle,
										children: t("creditsDetailHeading")
									}), status.credits.accounts.filter((account) => account.packageName === "enterprise" || account.remain > 0 || account.unlimited === true).map((account, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreditBar, {
										label: account.packageName === "enterprise" ? t("packageEnterprise") : account.packageName,
										remain: account.remain,
										size: account.size,
										unlimited: account.unlimited,
										t
									}, `${account.packageName}-${String(index)}`))]
								}), status.models === void 0 || status.models.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: quotaListStyle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										style: quotaTitleStyle,
										children: t("modelsHeading")
									}), status.models.filter((model) => model.free === true || (model.badges?.length ?? 0) > 0).map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelOfferRow, {
										model,
										t
									}, model.id))]
								})]
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: tabPanelStyle,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckInLogTable, {
									logs: status.checkIn?.logs,
									t,
									disabled: busy,
									busy,
									checkingIn,
									clearing: clearingLogs,
									...checkInNotice === void 0 ? {} : { notice: checkInNotice },
									onCheckIn: () => {
										manualCheckIn();
									},
									onRefresh: () => {
										refresh();
									},
									onClear: () => {
										clearCheckInLogs();
									}
								})
							})
						] }) : null,
						status?.status === "signed-out" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: status.reason === void 0 ? bodyStyle : errorStyle,
								children: status.reason ?? t(currentVariant.signedOutKey)
							}),
							status.loginKey === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: rowStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: buttonStyle$1,
									disabled: busy || signIn !== void 0,
									onClick: () => {
										beginSignIn();
									},
									children: signIn === void 0 ? t("signIn") : t("signingIn")
								}), signIn === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
									href: signIn.url,
									target: "_blank",
									rel: "noopener noreferrer",
									style: bodyStyle,
									children: t("signInOpenAgain")
								})]
							}),
							signIn === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: bodyStyle,
								children: t("signInWaiting")
							}),
							signInError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: errorStyle,
								children: t("signInFailed", { message: signInError })
							}),
							status.loginKey === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: rowStyle,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: bodyStyle,
										children: t("importHeading")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: buttonStyle$1,
										disabled: busy || signIn !== void 0,
										onClick: () => {
											importInput.current?.click();
										},
										children: busy ? t("importing") : t("importAction")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										ref: importInput,
										type: "file",
										accept: ".json,application/json",
										style: { display: "none" },
										onChange: (event) => {
											const file = event.target.files?.[0];
											event.target.value = "";
											if (file !== void 0) importCredential(file);
										}
									})
								]
							}),
							status.loginKey === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: bodyStyle,
								children: t("importHint")
							}),
							importNotice === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: importNotice.kind === "failed" ? errorStyle : bodyStyle,
								children: importNotice.text
							})
						] }) : null,
						status?.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: status.message
						}) : null
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/WorkBuddyProbeControl.tsx
		/**
		* Per-model reasoning-effort entry beside the Composer's model selector.
		*
		* Interaction follows the Fast Mode control `dsh-codex-connect` ships in this
		* same seat, which is the established shape for composer chrome here:
		*
		* - a **static inline label** next to the icon names the feature ("Reasoning
		*   levels"), set smaller and dimmer than the surrounding chrome so it reads as
		*   an annotation on the icon. It never carries state: the verified levels
		*   already appear in the model dropdown (the adapter exposes them as
		*   selectable efforts), so repeating them here would duplicate the real answer
		*   and make the label's width jump as results change.
		* - a **hover/focus tooltip** carries the state and the click's purpose, the way
		*   Fast Mode's tooltip explains its current speed.
		* - the **confirmation** is a small bubble anchored to the control, not a
		*   `window.confirm`. Probing spends real credit, so a confirmation stays — but
		*   it belongs next to the thing it acts on, sized to one line plus two small
		*   buttons.
		*
		* @module dsh-workbuddy-connect/client/probe-control
		*/
		/**
		* The card (and therefore the routes) a selected provider belongs to.
		*
		* The control serves both WorkBuddy providers from one seat, so the provider id
		* is what selects the status and probe endpoints. Returning `undefined` for any
		* other provider is what keeps the icon off every non-WorkBuddy model.
		*/
		function cardVariantFor(provider) {
			return CARD_VARIANTS.find((card) => card.id === provider);
		}
		/** How often the control re-checks state when the window regains focus. */
		const RECONCILE_MS = 6e4;
		const wrapperStyle = {
			display: "inline-flex",
			position: "relative",
			alignItems: "center",
			transform: "translateY(2px)",
			marginRight: -8
		};
		const buttonStyle = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			gap: 2,
			height: 30,
			padding: "0 6px",
			border: 0,
			borderRadius: 8,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			font: "inherit",
			whiteSpace: "nowrap",
			cursor: "pointer"
		};
		/**
		* The inline label. Smaller and dimmer than the surrounding chrome on purpose:
		* it names the feature, so it should read as an annotation attached to the icon
		* rather than compete with the adjacent model selector.
		*/
		const labelStyle = {
			fontSize: 11,
			lineHeight: "16px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		/** Tooltip bubble: the Fast Mode shape (nowrap, one line, above the control). */
		const tooltipStyle = {
			position: "absolute",
			left: "50%",
			bottom: "calc(100% + 8px)",
			zIndex: 1e3,
			transform: "translateX(-50%)",
			padding: "4px 8px",
			borderRadius: 6,
			background: "var(--dsw-specific-tip, #1f2329)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary, #fff)",
			fontSize: 12,
			lineHeight: "18px",
			whiteSpace: "nowrap",
			pointerEvents: "none"
		};
		/** Confirmation bubble: same anchor, but interactive and allowed to wrap. */
		const confirmStyle = {
			position: "absolute",
			right: 0,
			bottom: "calc(100% + 8px)",
			zIndex: 1001,
			display: "flex",
			flexDirection: "column",
			gap: 8,
			width: 260,
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1, #fff)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px"
		};
		const confirmRowStyle = {
			display: "flex",
			justifyContent: "flex-end",
			gap: 8
		};
		const confirmButtonStyle = {
			padding: "3px 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 6,
			background: "transparent",
			color: "inherit",
			font: "inherit",
			fontSize: 12,
			cursor: "pointer"
		};
		/**
		* Primary action inside the confirmation bubble.
		*
		* The fill and its text colour must come as a pair: `brand-primary` resolves to
		* a light accent in this theme, so hardcoding `color: #fff` on top of it renders
		* white-on-white. `button-primary-fill` + `label-primary-foreground` is the
		* theme's own pair for exactly this, and is what `dsh-codex-connect` uses for
		* the same job.
		*/
		const primaryButtonStyle = {
			...confirmButtonStyle,
			border: "1px solid var(--dsw-alias-button-primary-fill)",
			background: "var(--dsw-alias-button-primary-fill)",
			color: "var(--dsw-alias-label-primary-foreground)"
		};
		/**
		* Result note: a single line + a dismiss button, anchored to the control's
		* right side. Smaller than the confirmation bubble because it carries an
		* *outcome*, not a *decision* — the work is done, the user only has to read
		* and dismiss.
		*/
		const noteStyle = {
			position: "absolute",
			right: 0,
			bottom: "calc(100% + 8px)",
			zIndex: 1001,
			display: "flex",
			alignItems: "center",
			gap: 12,
			padding: "6px 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px",
			whiteSpace: "nowrap"
		};
		/**
		* The note's dismiss action. Outlined rather than bare text: inside an already
		* bordered bubble, an unbordered word does not read as something you can click.
		* Matches the outlined pill convention the plugin's other secondary actions use.
		*/
		const noteDismissStyle = {
			padding: "2px 8px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 6,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			font: "inherit",
			fontSize: 12,
			lineHeight: "18px",
			cursor: "pointer"
		};
		/**
		* The feature's static inline label. Deliberately not a state readout — see the
		* module comment.
		*/
		function useLabel(t) {
			return t("probeLabel");
		}
		/** Pick the model's recorded observation out of the probe section. */
		function resultFor(status, model) {
			if (status.status !== "signed-in") return void 0;
			return status.probe?.results.find((result) => result.id === model);
		}
		/**
		* The one-line tooltip: current state first, then what a click does — the same
		* two-part shape Fast Mode uses.
		*
		* A recorded result outranks a remembered failure. `failed` only means "the last
		* run from this control did not complete"; the host can record a result for the
		* same model at any time (a detection started from the settings card, another
		* conversation, or a finished sweep), and the levels the user paid for are the
		* more useful answer than the stale failure. Failure copy is what remains when
		* there is no result to report.
		*/
		function tooltipText(t, model, state) {
			if (state.busy) return t("probeRunning", { model });
			const result = state.result;
			if (result !== void 0) {
				if (result.validation === "validating" && result.efforts.length > 0) return t("probeTooltipVerified", { levels: result.efforts.join(" / ") });
				if (result.validation === "non-validating") return t("probeTooltipNotValidating");
				return t("probeTooltipRetry");
			}
			if (state.failed) return t("probeTooltipRetry");
			return t("probeTooltipIdle", { model });
		}
		/** Model-independent shell: resolves the selection, then delegates per model. */
		function WorkBuddyProbeControl({ directory, t }) {
			const subscribe = (0, react.useCallback)((listener) => directory.subscribe(listener), [directory]);
			const snapshot = (0, react.useCallback)(() => directory.getSnapshot(), [directory]);
			const selection = (0, react.useSyncExternalStore)(subscribe, snapshot, snapshot).current;
			const card = selection == null ? void 0 : cardVariantFor(selection.provider);
			const key = card === void 0 || selection == null ? void 0 : `${card.id}:${selection.model}`;
			return card === void 0 || selection == null || key === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelProbe, {
				model: selection.model,
				card,
				label: useLabel(t),
				t
			}, key);
		}
		function ModelProbe({ model, card, label, t }) {
			const [status, setStatus] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			const [confirming, setConfirming] = (0, react.useState)(false);
			const [tooltipVisible, setTooltipVisible] = (0, react.useState)(false);
			const [failed, setFailed] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)();
			const inFlight = (0, react.useRef)(false);
			const mounted = (0, react.useRef)(false);
			const readSeq = (0, react.useRef)(0);
			const tooltipId = (0, react.useId)();
			const refresh = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const response = await fetch(card.statusPath, {
					credentials: "same-origin",
					headers: { accept: "application/json" },
					...signal === void 0 ? {} : { signal }
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const value = await response.json().catch(() => void 0);
				if (!isWorkBuddyWebStatus(value)) throw new Error(t("statusResponseInvalid"));
				if (mounted.current && !signal?.aborted && seq === readSeq.current) setStatus(value);
			}, [card.statusPath, t]);
			(0, react.useEffect)(() => {
				mounted.current = true;
				const controller = new AbortController();
				const load = () => {
					refresh(controller.signal).catch(() => {});
				};
				load();
				const timer = window.setInterval(load, RECONCILE_MS);
				window.addEventListener("focus", load);
				return () => {
					mounted.current = false;
					controller.abort();
					window.clearInterval(timer);
					window.removeEventListener("focus", load);
				};
			}, [refresh]);
			const probe = status?.status === "signed-in" ? status.probe : void 0;
			const key = status?.status === "signed-in" ? status.probeKey : void 0;
			const result = status === void 0 ? void 0 : resultFor(status, model);
			const visible = probe?.candidates.includes(model) === true || result !== void 0;
			(0, react.useEffect)(() => {
				if (result !== void 0) setFailed(false);
			}, [result]);
			(0, react.useEffect)(() => {
				setConfirming(false);
				setNote(void 0);
			}, [model]);
			const detect = async () => {
				if (key === void 0 || inFlight.current || probe?.running === true) return;
				inFlight.current = true;
				setNote(void 0);
				setConfirming(false);
				setBusy(true);
				setFailed(false);
				try {
					const response = await fetch(card.probePath, {
						method: "POST",
						credentials: "same-origin",
						headers: {
							"Content-Type": "application/json",
							"X-WorkBuddy-Probe-Key": key
						},
						body: JSON.stringify({
							action: "probe",
							model
						})
					});
					const body = await response.json();
					if (!response.ok || body.state !== "ok" || body.validation !== "validating" && body.validation !== "non-validating" || !Array.isArray(body.efforts) || !body.efforts.every((effort) => typeof effort === "string")) throw new Error("probe failed");
					if (mounted.current) {
						const completed = {
							id: model,
							name: model,
							validation: body.validation,
							efforts: body.efforts,
							probedAt: Date.now()
						};
						setNote(completed);
					}
					refresh().catch(() => {});
				} catch {
					if (mounted.current) setFailed(true);
				} finally {
					inFlight.current = false;
					if (mounted.current) setBusy(false);
				}
			};
			if (!visible) return null;
			const text = tooltipText(t, model, {
				busy,
				result,
				failed
			});
			const disabled = busy || probe?.running === true || key === void 0;
			const showTooltip = tooltipVisible && !confirming && note === void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: wrapperStyle,
				onMouseEnter: () => {
					setTooltipVisible(true);
				},
				onMouseLeave: () => {
					setTooltipVisible(false);
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						"aria-label": text,
						"aria-describedby": showTooltip ? tooltipId : void 0,
						"aria-busy": busy,
						"aria-expanded": confirming,
						disabled,
						onClick: () => {
							setConfirming(true);
						},
						onFocus: () => {
							setTooltipVisible(true);
						},
						onBlur: () => {
							setTooltipVisible(false);
						},
						style: {
							...buttonStyle,
							opacity: disabled && !confirming ? .6 : 1,
							cursor: disabled ? "default" : "pointer"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
							width: "16",
							height: "16",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "1.6",
							"aria-hidden": "true",
							focusable: "false",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "9"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "4"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12 12 20 4" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "1"
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: labelStyle,
							children: label
						})]
					}),
					showTooltip && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						id: tooltipId,
						role: "tooltip",
						style: tooltipStyle,
						children: text
					}),
					confirming && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: confirmStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("probeBubbleBody") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: confirmRowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: confirmButtonStyle,
								onClick: () => {
									setConfirming(false);
								},
								children: t("cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: primaryButtonStyle,
								onClick: () => {
									detect();
								},
								children: t("probeConfirmAction")
							})]
						})]
					}),
					note === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						role: "status",
						"aria-live": "polite",
						style: noteStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: noteText(t, note) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: noteDismissStyle,
							onClick: () => {
								setNote(void 0);
							},
							children: t("probeNoteDismiss")
						})]
					})
				]
			});
		}
		/** Compose the one-line outcome string the note bubble shows. */
		function noteText(t, result) {
			if (result.validation === "validating" && result.efforts.length > 0) return t("probeNoteVerified", { levels: result.efforts.join(" / ") });
			if (result.validation === "non-validating") return t("probeNoteNotValidating");
			return t("probeNoteUnknown");
		}
		//#endregion
		//#region src/client/http-settings-scope.ts
		/** Base path of the host half's settings face. */
		const ROUTE_BASE = "/plugins/dsh-workbuddy-connect";
		/**
		* Fetch one settings face document.
		* @param init - the request init (method, headers, body).
		* @returns the parsed document.
		* @throws when the transport or the host refuses the request.
		*/
		async function request(init) {
			const response = await fetch(`${ROUTE_BASE}/settings`, {
				credentials: "same-origin",
				...init
			});
			const value = await response.json().catch(() => void 0);
			if (!response.ok) {
				const error = typeof value === "object" && value !== null && "error" in value ? String(value["error"]) : `HTTP ${response.status}`;
				throw new Error(error);
			}
			if (typeof value !== "object" || value === null || !("value" in value)) throw new Error("workbuddy: settings face answered an invalid document");
			return value;
		}
		/**
		* The scope the card was written against, backed by this plugin's own file.
		*
		* A write optimistically adopts the value it just sent, then confirms with the
		* host's answer (which re-reads the file it wrote), so the card never renders a
		* value the host does not hold.
		*/
		var OwnQuotaSettingsScope = class {
			document;
			listeners = /* @__PURE__ */ new Set();
			snapshot = {
				status: "loading",
				value: void 0,
				writable: true
			};
			/**
			* Load the current document. Call once before the card binds; repeated calls
			* are harmless and re-read the host.
			* @returns the effective values.
			*/
			async load() {
				try {
					this.document = await request({ headers: { accept: "application/json" } });
				} catch {
					return;
				}
				this.publish();
				return this.document.value;
			}
			/** @returns the stable snapshot the card reads (ready once loaded). */
			getSnapshot() {
				return this.snapshot;
			}
			/** @param listener - invoked after every snapshot change. @returns the disposer. */
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			/**
			* Write one field.
			* @param field - field name inside the settings document.
			* @param value - the JSON-shaped value to store.
			* @returns whether the host accepted the write.
			*/
			async set(field, value) {
				return this.patch({ [field]: value });
			}
			/**
			* Clear one field: the value falls back to the schema default.
			* @param field - field name inside the settings document.
			* @returns whether the host accepted the clear.
			*/
			async unset(field) {
				return this.patch({ [field]: null });
			}
			/** Send one patch and adopt the host's answer. */
			async patch(patch) {
				const key = this.document?.key;
				if (key === void 0) return false;
				try {
					this.document = await request({
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-WorkBuddy-Settings-Key": key
						},
						body: JSON.stringify(patch)
					});
					this.publish();
					return true;
				} catch {
					return false;
				}
			}
			/** Rebuild the cached snapshot and notify the subscribers. */
			publish() {
				this.snapshot = {
					status: this.document === void 0 ? "loading" : "ready",
					value: this.document?.value,
					writable: true
				};
				for (const listener of this.listeners) listener();
			}
		};
		//#endregion
		//#region src/client/quota-merge.ts
		/**
		* Group credit accounts by (packageName, packageEndTime) and sum each group.
		*
		* A missing figure counts as 0 (the user's ruling): a package whose total the
		* upstream did not report contributes nothing to the group's `size` rather
		* than poisoning the bar into "unknown". A group whose summed `size` is still
		* 0 keeps an honest "unknown total" rendering in the card — the merge never
		* invents a denominator. `unlimited` is sticky: one unlimited member makes the
		* whole group unlimited, and its sums are not displayed as a quota.
		*
		* MERGE KEY IS THE NAME ALONE (the user's correction): same-named packages
		* whose expiries differ by seconds (stacked purchase batches) must still be
		* one overview row — keying on the expiry exploded 28 same-named packages
		* back into 28 separate bars the moment the host started reporting real
		* dates. The expiry travels on the group (earliest of the members) for the
		* sort/visibility rules; the itemised per-expiry breakdown lives in the
		* dashboard's table.
		*
		* @param accounts - the status document's per-package credit entries.
		* @returns one group per distinct package NAME, in first-seen order.
		*/
		function mergeCreditAccounts(accounts) {
			const groups = /* @__PURE__ */ new Map();
			for (const account of accounts) {
				const key = account.packageName;
				const existing = groups.get(key);
				if (existing === void 0) {
					groups.set(key, {
						packageName: account.packageName,
						packageEndTime: account.packageEndTime,
						remain: account.remain,
						size: account.size,
						unlimited: account.unlimited === true
					});
					continue;
				}
				existing.remain += account.remain;
				existing.size += account.size;
				existing.unlimited = existing.unlimited || account.unlimited === true;
				if (existing.packageEndTime !== void 0 && account.packageEndTime !== void 0) {
					const a = Date.parse(existing.packageEndTime);
					const b = Date.parse(account.packageEndTime);
					if (!Number.isNaN(a) && !Number.isNaN(b) && b < a) existing.packageEndTime = account.packageEndTime;
				} else existing.packageEndTime = existing.packageEndTime ?? account.packageEndTime;
			}
			return [...groups.values()];
		}
		/** Clamp helper shared by the card's percent math. */
		function clampPercent(remain, size) {
			if (!(size > 0)) return void 0;
			const percent = remain / size * 100;
			if (!Number.isFinite(percent)) return void 0;
			return Math.min(100, Math.max(0, percent));
		}
		/** Parse an upstream expiry string ("YYYY-MM-DD HH:mm:ss") into a timestamp; undefined when unparseable. */
		function parseExpiry(value) {
			if (value === void 0) return void 0;
			const parsed = Date.parse(value);
			return Number.isNaN(parsed) ? void 0 : parsed;
		}
		/** Whether a group is spent (remain 0) and NOT unlimited. */
		function isSpent(group) {
			return !group.unlimited && group.remain <= 0;
		}
		/** Whether a spent group's expiry date has already passed (undated → false: no proof of expiry). */
		function isExpired(group, now) {
			if (!isSpent(group)) return false;
			const expiry = parseExpiry(group.packageEndTime);
			return expiry !== void 0 && expiry < now;
		}
		/**
		* SIDEBAR overview rule (the user's spec, restored after it was wrongly
		* applied to the panel):
		*
		* - A group with credit LEFT (remain > 0, or unlimited) renders.
		* - A SPENT group (remain 0) renders ONLY when EVERY group is spent AND it
		*   is not expired — the account's standing quota whose emptiness is itself
		*   the news. When anything still has credit, spent rows are noise.
		* - An EXPIRED group (spent and its expiry date has passed) renders
		*   NOWHERE, whatever the rest of the account looks like.
		*
		* Applied AFTER the merge so the sums are settled before the test.
		* "Now" is injectable for tests.
		*
		* @param groups - merged groups, in first-seen order.
		* @param now - current timestamp (defaults to Date.now()).
		* @returns the groups to display, in first-seen order.
		*/
		function visibleQuotaGroups(groups, now = Date.now()) {
			const hasCredit = groups.some((group) => group.unlimited || group.remain > 0);
			return groups.filter((group) => {
				if (group.unlimited || group.remain > 0) return true;
				return !hasCredit && !isExpired(group, now);
			});
		}
		/**
		* PANEL detail-table ordering (the user's spec): every row renders — the
		* panel is the itemised ledger — but spent-yet-still-active rows sink to the
		* BOTTOM (lowest priority), and expired rows are dropped entirely. Rows keep
		* their first-seen order within each band.
		*
		* @param rows - per-package rows, unmerged, in first-seen order.
		* @param now - current timestamp (defaults to Date.now()).
		*/
		function sortPackageRows(rows, now = Date.now()) {
			const live = [];
			const spent = [];
			for (const row of rows) {
				const unlimited = row.unlimited === true;
				const expiry = parseExpiry(row.packageEndTime);
				if (!unlimited && row.remain <= 0 && expiry !== void 0 && expiry < now) continue;
				if (unlimited || row.remain > 0) live.push(row);
				else spent.push(row);
			}
			return [...live, ...spent];
		}
		//#endregion
		//#region src/client/SidebarQuotaCard.tsx
		/**
		* The sidebar footer quota card + the center-column dashboard it opens.
		*
		* The structure is a direct port of commandcode's plans & quota panel
		* (src/client/panel-view.tsx + panel.ts), which the user held up as the
		* reference: the card IS the button (the shell supplies no chrome), it renders
		* one block per merged package group — the group's remain/total, its
		* percentage and its bar — carries the last-updated time in the card's top
		* row, and opens a dashboard in the layout's keyed `main` slot on click. In
		* the 56px rail it collapses to a 36px icon button carrying the ring.
		*
		* Data comes from the variant's status route (poll, paused while hidden);
		* strings come from the `panel.workbuddy-quota` locale namespace; classes come
		* from `./quota-styles.ts` (`wbp-` prefix).
		*/
		/** Fallback translator: renders keys bare rather than throwing unbound. */
		const fallbackT = (key) => key;
		/** Project the credit accounts into the card's bar list. */
		function buildBars(accounts) {
			const groups = visibleQuotaGroups(mergeCreditAccounts(accounts));
			const bars = [];
			for (const group of groups) {
				const percent = group.unlimited ? void 0 : clampPercent(group.remain, group.size);
				const detail = group.unlimited ? "∞" : percent === void 0 ? `${group.remain.toLocaleString()} · ?` : `${group.remain.toLocaleString()} / ${group.size.toLocaleString()}`;
				bars.push({
					label: group.packageName,
					detail,
					percent: percent === void 0 ? void 0 : `${Math.round(percent)}%`,
					barPercent: percent === void 0 ? 0 : Math.max(2, percent),
					warn: !group.unlimited && percent !== void 0 && percent < 20,
					packageEndTime: group.packageEndTime
				});
			}
			return bars;
		}
		/**
		* The quota ring — commandcode's glyph ported verbatim (`wbp-` classes): a
		* faint track plus an arc whose sweep is the consumption, drawn from 12
		* o'clock. Circumference 2πr = 45.55 at r = 7.25.
		*/
		function Ring({ percent, warn, size }) {
			const clamped = Math.min(100, Math.max(0, percent));
			const circumference = 45.55;
			const dashoffset = Math.round(circumference * (1 - clamped / 100) * 1e3) / 1e3;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "wbp-glyph",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					viewBox: "0 0 20 20",
					width: size,
					height: size,
					focusable: "false",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "10",
						cy: "10",
						r: "7.25",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "1.5",
						opacity: "0.4"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "10",
						cy: "10",
						r: "7.25",
						fill: "none",
						stroke: warn ? "var(--dsw-alias-state-error-primary)" : "currentColor",
						strokeWidth: "2.5",
						strokeLinecap: "round",
						strokeDasharray: String(circumference),
						strokeDashoffset: String(dashoffset),
						transform: "rotate(-90 10 10)"
					})]
				})
			});
		}
		/**
		* The dashboard's detail rows: EVERY package as the upstream reported it —
		* no merging, exhausted ones included. The sidebar card shows the merged
		* overview; this panel is the itemised ledger, so collapsing here would
		* destroy the only place a per-package figure is visible.
		*/
		function buildPackageRows(accounts) {
			return sortPackageRows(accounts).map((account) => {
				const percent = account.unlimited === true ? void 0 : clampPercent(account.remain, account.size);
				return {
					name: account.packageName,
					remain: account.remain,
					size: account.size,
					percent,
					warn: account.unlimited !== true && percent !== void 0 && percent < 20,
					packageEndTime: account.packageEndTime
				};
			});
		}
		/** Time-of-day formatter for the updated stamp. */
		function timeText(ms) {
			return new Date(ms).toLocaleTimeString(void 0, {
				hour: "2-digit",
				minute: "2-digit"
			});
		}
		/** One variant's sidebar quota card. */
		function SidebarQuotaCard(props) {
			const { t = fallbackT, statusPath, open } = props;
			const variantId = statusPath !== void 0 ? variantOfStatusPath(statusPath) : "workbuddy";
			const nameKey = variantId === "workbuddy-ai" ? "quotaCardAI" : "quotaCardCN";
			const wide = props.wide !== false;
			const [failed, setFailed] = (0, react.useState)(false);
			(0, react.useSyncExternalStore)(onQuotaSettingsChange, quotaSettingsRevision);
			const enabled = variantId === "workbuddy" ? quotaToggles().cn : quotaToggles().ai;
			const status = quotaStatus(variantId);
			const signedIn = status?.status === "signed-in";
			(0, react.useEffect)(() => {
				if (statusPath === void 0 || !enabled) return void 0;
				let disposed = false;
				let timer;
				const controller = new AbortController();
				const refresh = async () => {
					try {
						const response = await fetch(statusPath, {
							signal: controller.signal,
							headers: { accept: "application/json" }
						});
						const body = await response.json();
						if (disposed) return;
						if (!response.ok || !isWorkBuddyWebStatus(body)) {
							setFailed(true);
							return;
						}
						setFailed(false);
						noteQuotaStatus(variantId, body);
					} catch {
						if (!disposed) setFailed(true);
					}
				};
				const isHidden = () => typeof document !== "undefined" && document.hidden;
				const loop = () => {
					if (isHidden()) return;
					refresh();
				};
				timer = window.setInterval(loop, Math.max(6e4, quotaPollMs()));
				refresh();
				const onVisible = () => {
					if (!isHidden()) loop();
				};
				if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
				return () => {
					disposed = true;
					controller.abort();
					if (timer !== void 0) window.clearInterval(timer);
					if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
				};
			}, [
				statusPath,
				enabled,
				variantId
			]);
			if (enabled === false) return null;
			const credits = status !== void 0 && "credits" in status ? status.credits : void 0;
			const bars = credits === void 0 ? [] : buildBars(credits.accounts ?? []);
			const lowest = bars.reduce((acc, bar) => {
				if (bar.percent === void 0) return acc;
				const value = Number.parseFloat(bar.percent);
				if (!Number.isFinite(value)) return acc;
				return acc === void 0 ? value : Math.min(acc, value);
			}, void 0);
			const ringPercent = failed || status === void 0 ? 0 : credits?.unlimited === true ? 100 : lowest ?? 0;
			const ringWarn = failed || lowest !== void 0 && lowest < 20;
			const fetchedAt = quotaStatusFetchedAt(variantId);
			const title = [
				t(nameKey),
				...bars.map((bar) => `${bar.label} ${bar.detail}${bar.percent === void 0 ? "" : ` (${bar.percent})`}`),
				fetchedAt !== void 0 ? `${t("quotaUpdated")} ${timeText(fetchedAt)}` : ""
			].filter((part) => part !== "").join(" · ");
			if (!wide) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "wbp-railButton",
				"aria-label": title,
				title,
				disabled: !signedIn,
				onClick: () => {
					if (!signedIn) return;
					open?.();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Ring, {
					percent: ringPercent,
					warn: ringWarn,
					size: 18
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "wbp-foot",
				"aria-label": title,
				title,
				disabled: !signedIn,
				onClick: () => {
					if (!signedIn) return;
					open?.();
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "wbp-footTop",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Ring, {
							percent: ringPercent,
							warn: ringWarn,
							size: 16
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbp-footName",
							children: t(nameKey)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
						fetchedAt !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "wbp-updated",
							children: [
								t("quotaUpdated"),
								" ",
								timeText(fetchedAt)
							]
						}) : null
					]
				}), failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "wbp-footRow",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbp-footLabel",
						children: t("quotaError")
					})
				}) : bars.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "wbp-footRow",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbp-footLabel",
						children: status === void 0 ? "…" : !("credits" in status) ? t("quotaNotSignedIn") : status.creditsError ?? t("quotaError")
					})
				}) : bars.map((bar, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "wbp-footRow",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "wbp-footHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbp-footLabel",
								title: bar.packageEndTime !== void 0 ? `${t("quotaExpires")} ${bar.packageEndTime}` : t("quotaNoExpiry"),
								children: bar.label
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbp-footAmount",
								children: bar.detail
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbp-footPct",
								children: bar.percent ?? ""
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbp-footBar",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: bar.warn ? "wbp-footFill wbp-footFillWarn" : "wbp-footFill",
							style: { width: `${bar.barPercent}%` }
						})
					})]
				}, `${index}\u0000${bar.label}\u0000${bar.packageEndTime ?? ""}`))]
			});
		}
		/**
		* The center-column dashboard, registered into the layout's keyed `main` slot
		* under the id the footer cards select, so card → panel is one navigation
		* entry. One variant at a time, switched by tabs (commandcode's account-tab
		* pattern): CN and international are separate accounts with separate package
		* lists, so mixing them into one column would misattribute every number.
		*
		* The panel fetches BOTH routes itself on mount and on the shared poll
		* interval — a user opening the panel must never wait for the sidebar cards'
		* next tick, and must never see a stale "sign in" just because no poll had
		* run yet. The tab defaults to the variant whose card was clicked.
		*/
		function QuotaDashboard(props) {
			const { t = fallbackT, statusPaths, refresh, close, useQuotaDashboard, onVariantPicked } = props;
			(0, react.useSyncExternalStore)(onQuotaSettingsChange, quotaSettingsRevision);
			const state = useQuotaDashboard((s) => s);
			const followedPath = state.activePath;
			const [userPicked, setUserPicked] = (0, react.useState)(void 0);
			const activePathResolved = userPicked ?? followedPath;
			const activeVariant = variantOfStatusPath(activePathResolved);
			const status = quotaStatus(activeVariant);
			const loading = state.loading;
			const fetchedAt = state.fetchedAt;
			const credits = status !== void 0 && "credits" in status ? status.credits : void 0;
			const rows = credits === void 0 ? [] : buildPackageRows(credits.accounts ?? []);
			const nameKey = activeVariant === "workbuddy-ai" ? "quotaCardAI" : "quotaCardCN";
			const signedIn = status?.status === "signed-in";
			const totalRemain = credits?.total ?? 0;
			const totalSize = credits?.totalSize ?? credits?.accounts.reduce((sum, account) => sum + account.size, 0) ?? 0;
			const totalPercent = clampPercent(totalRemain, totalSize);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "wbp-main",
				role: "region",
				"aria-label": t("quotaDashboardTitle"),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "wbp-mainInner",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
							className: "wbp-header",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "wbp-headerText",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
										className: "wbp-title",
										children: t("quotaDashboardTitle")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "wbp-subtitle",
										children: t("quotaDashboardSubtitle")
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "wbp-spacer" }),
								fetchedAt !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "wbp-meta",
									children: [
										t("quotaUpdated"),
										" ",
										timeText(fetchedAt)
									]
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "wbp-refresh",
									disabled: loading,
									onClick: () => refresh(),
									children: loading ? t("quotaRefreshing") : t("quotaRefresh")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "wbp-close",
									"aria-label": t("quotaClose"),
									title: t("quotaClose"),
									onClick: () => close(),
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										"aria-hidden": "true",
										children: "×"
									})
								})
							]
						}),
						statusPaths.length > 1 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "wbp-tabs",
							role: "tablist",
							"aria-label": t("quotaDashboardTitle"),
							children: statusPaths.map((path) => {
								const key = variantOfStatusPath(path) === "workbuddy-ai" ? "quotaCardAI" : "quotaCardCN";
								return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "tab",
									"aria-selected": path === activePathResolved,
									className: path === activePathResolved ? "wbp-tab wbp-tabActive" : "wbp-tab",
									onClick: () => {
										setUserPicked(path);
										onVariantPicked(path);
									},
									children: t(key)
								}, path);
							})
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "wbp-card",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "wbp-cardHead",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "wbp-avatar",
										children: activeVariant === "workbuddy-ai" ? "AI" : "CN"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "wbp-cardIdentity",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "wbp-cardTitle",
											children: t(nameKey)
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "wbp-cardOwner",
											children: signedIn ? status.nickname ?? "" : t("quotaNotSignedIn")
										})]
									}),
									credits?.unlimited === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "wbp-badge",
										children: t("quotaUnlimited")
									}) : null
								]
							}), !signedIn ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "wbp-notice",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "wbp-noticeTitle",
									children: t("quotaNotSignedIn")
								})
							}) : credits === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "wbp-notice wbp-noticeError",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "wbp-noticeTitle",
									children: t("quotaError")
								})
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: "wbp-totalLine",
									children: [
										t("quotaTotalRemain"),
										" ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
											className: "wbp-totalValue",
											children: totalRemain.toLocaleString()
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "wbp-totalSub",
									children: t("quotaTotalShare", {
										percent: totalPercent === void 0 ? t("quotaUnknownTotal") : `${totalPercent.toFixed(2)}%`,
										remain: totalRemain.toLocaleString(),
										size: totalSize.toLocaleString()
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "wbp-bar",
									role: "progressbar",
									"aria-label": t("quotaTotal"),
									...totalPercent === void 0 ? { "aria-valuetext": t("quotaUnknownTotal") } : {
										"aria-valuemin": 0,
										"aria-valuemax": 100,
										"aria-valuenow": Math.round(totalPercent)
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: totalPercent !== void 0 && totalPercent < 20 ? "wbp-barFill wbp-barFillWarn" : "wbp-barFill",
										style: {
											width: totalPercent === void 0 ? "100%" : `${Math.max(2, totalPercent)}%`,
											opacity: totalPercent === void 0 ? .25 : 1
										}
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
									className: "wbp-blockTitle",
									children: t("quotaByPackage")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
									className: "wbp-table",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("quotaColPackage") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("quotaColRemain") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("quotaColExpiry") })
									] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: rows.map((row, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row.name }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
											className: "wbp-num",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "wbp-numText",
												children: [
													row.remain.toLocaleString(),
													" / ",
													row.size.toLocaleString()
												]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "wbp-miniBar",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: row.warn ? "wbp-footFill wbp-footFillWarn" : "wbp-footFill",
													style: {
														display: "block",
														height: "100%",
														borderRadius: 999,
														width: row.percent === void 0 ? "100%" : `${Math.max(2, row.percent)}%`,
														opacity: row.percent === void 0 ? .25 : 1
													}
												})
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: "wbp-expiry",
											children: row.packageEndTime ?? t("quotaNoExpiry")
										})
									] }, `${index}\u0000${row.name}\u0000${row.packageEndTime ?? ""}`)) })]
								}),
								credits.cycleResetTime !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: "wbp-windowReset",
									children: [
										t("quotaExpires"),
										" ",
										credits.cycleResetTime
									]
								}) : null
							] })]
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/quota-styles.ts
		/**
		* Stylesheet for the WorkBuddy quota surfaces (the sidebar footer card and the
		* dashboard it opens) — a direct translation of commandcode's panel stylesheet
		* (src/client/panel-styles.ts), which the user held up as the reference look.
		* Classes are `wbp-` prefixed to stay clear of commandcode's `ccp-` set: both
		* plugins inject GLOBAL CSS into the same document, so the prefixes must not
		* collide.
		*
		* Same contract as the original: returned as a string (no DOM side effects at
		* import time), installed once by the client entry keyed by `data-plugin-css`,
		* and removed when the plugin's fiber unwinds. Every colour comes from a
		* harness theme alias with a neutral fallback.
		*/
		/** Stylesheet id (the `data-plugin-css` value that makes injection idempotent). */
		const QUOTA_CSS_ID = "dsh-workbuddy-connect/QuotaPanel.module.css";
		/** Install the stylesheet once; returns its disposer. */
		function injectQuotaCss() {
			if (typeof document === "undefined") return () => {};
			if (document.querySelector(`style[data-plugin-css="dsh-workbuddy-connect/QuotaPanel.module.css"]`) !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-workbuddy-connect";
			tag.dataset.pluginCss = QUOTA_CSS_ID;
			tag.textContent = QUOTA_CSS;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}
		/** The quota panel stylesheet. */
		const QUOTA_CSS = `
/* ------------------------------------------------- sidebar footer card */
/* The shell's foot area renders this list ABOVE the Settings seat. The shell
   supplies no chrome: the entry is the button. Deliberately quiet — a surface
   beside Settings should read as part of the column — one hover step and a
   hairline border, exactly like commandcode's card.

   The shell's container is a flex ROW whose occupants each declare a
   full-width line, so as a row it overflows the column. The fix is the same
   load-bearing anchored rule commandcode ships (their issue #48): force the
   sidebar's footer-action container into a column, anchored to "_footArea"
   because "footerActions" is also used by the ask-user-question dialog — an
   unanchored rule would stack THAT dialog's buttons too. Anchoring keeps the
   fix scoped to the sidebar; the descendant combinator survives a wrapper
   appearing between the two. The rule is idempotent when commandcode is also
   installed (same selector, same declaration) and makes this plugin
   self-sufficient when it is not. */
[class*="_footArea"] [class*="_footerActions"]{flex-direction:column}
.wbp-foot{box-sizing:border-box;flex:0 0 auto;width:100%;min-width:0;font:inherit;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;background:0 0;border:1px solid transparent;border-radius:10px;flex-direction:column;gap:6px;margin:0 0 4px;padding:8px;display:flex}
.wbp-foot:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.wbp-foot:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
/* A signed-out variant's card is inert (the click is blocked at the handler):
   it must not invite the click it will ignore, so it drops the pointer cursor
   and the hover tint — the same disabled look the settings switches use. */
.wbp-foot:disabled{opacity:.5;cursor:default}
.wbp-foot:disabled:hover{color:var(--dsw-alias-label-secondary);background:0 0;border-color:transparent}
.wbp-railButton:disabled{opacity:.5;cursor:default}
.wbp-railButton:disabled:hover{color:var(--dsw-alias-label-secondary);background:0 0}
.wbp-footTop{align-items:center;gap:8px;min-width:0;display:flex}
.wbp-footName{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;font-size:13px;font-weight:500;line-height:20px}
.wbp-updated{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;font-variant-numeric:tabular-nums;white-space:nowrap}
/* One block per merged package group: a head line carrying the group's own
   remain/total, then the FULL-WIDTH bar under it. Stacking the two lets the
   card show the figures — the reason this surface exists — without squeezing
   the bar into what is left beside them. */
.wbp-footRow{flex-direction:column;gap:4px;min-width:0;display:flex}
.wbp-footHead{align-items:baseline;gap:8px;min-width:0;display:flex}
.wbp-footLabel{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbp-footAmount{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap}
/* The card's markup must stay PHRASING content — it renders inside the shell's
   own button — so these bars are spans, not divs. display:block is
   load-bearing on BOTH: an inline box ignores width and height outright, so
   without it the fill collapses to 0x0 and the bar shows no usage. */
.wbp-footBar{display:block;background:var(--dsw-alias-bg-layer-2);border-radius:999px;height:5px;overflow:hidden}
.wbp-footFill{display:block;background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.wbp-footFillWarn{background:var(--dsw-alias-state-error-primary)}
.wbp-footPct{flex:none;width:34px;color:var(--dsw-alias-label-secondary);text-align:right;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}

/* The 56px rail: one icon button on the shell's own rail geometry (36px cell),
   so the collapsed column keeps a single glyph like its siblings. */
.wbp-railButton{box-sizing:border-box;width:36px;height:36px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid transparent;border-radius:8px;flex:none;justify-content:center;align-items:center;margin:0 0 4px;padding:0;display:inline-flex}
.wbp-railButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.wbp-railButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

/* The ring glyph. Sized entirely by its own width/height attribute, so the
   footer row and the rail button can each ask for their own. */
.wbp-glyph{flex:none;justify-content:center;align-items:center;display:inline-flex;color:var(--dsw-alias-brand-primary)}
.wbp-ringWarn{color:var(--dsw-alias-state-error-primary)}

/* ------------------------------------------------------------ dashboard */
/* The center column in the layout frame: fill it, scroll the content column,
   and cap the reading width like the harness's own panels. */
.wbp-main{background:var(--dsw-alias-bg-layer-1);width:100%;height:100%;overflow:auto;display:block}
.wbp-mainInner{max-width:760px;margin:0 auto;padding:24px 20px 40px;flex-direction:column;gap:14px;display:flex;color:var(--dsw-alias-label-primary)}
.wbp-header{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.wbp-headerText{flex-direction:column;gap:2px;display:flex;min-width:0}
.wbp-title{margin:0;font-size:18px;font-weight:600;line-height:1.4}
.wbp-subtitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.wbp-spacer{flex:1}
.wbp-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;font-variant-numeric:tabular-nums}
/* The dashboard's exit: an icon-sized glyph button. */
.wbp-close{min-width:28px;justify-content:center;padding-left:0;padding-right:0;box-sizing:border-box;align-items:center;cursor:pointer;font:inherit;color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;height:28px;display:inline-flex}
.wbp-close:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.wbp-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.wbp-close span{font-size:16px;line-height:1}
.wbp-refresh{box-sizing:border-box;align-items:center;cursor:pointer;font:inherit;color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 12px;display:inline-flex;gap:6px;font-size:12px;line-height:18px}
.wbp-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.wbp-refresh:disabled{opacity:.5;cursor:default}
.wbp-refresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

/* Notices: signed-out and error states. */
.wbp-notice{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:12px 14px;flex-direction:column;gap:4px;display:flex}
.wbp-noticeError{border-color:var(--dsw-alias-state-error-primary)}
.wbp-noticeTitle{margin:0;font-size:13px;font-weight:600;line-height:1.5}
.wbp-noticeHint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}

/* One card per variant. */
.wbp-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:14px;padding:16px 18px;flex-direction:column;gap:16px;display:flex}
.wbp-cardHead{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.wbp-avatar{flex:none;width:28px;height:28px;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-module-platform);border-radius:50%;justify-content:center;align-items:center;font-size:12px;font-weight:600;line-height:1;display:inline-flex}
.wbp-cardIdentity{flex-direction:column;gap:1px;min-width:0;display:flex}
.wbp-cardTitle{font-size:13px;font-weight:600;line-height:1.4}
.wbp-cardOwner{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}

/* Quota blocks: each merged group is a label row plus the track. */
.wbp-windows{flex-direction:column;gap:14px;display:flex}
.wbp-window{flex-direction:column;gap:6px;display:flex}
.wbp-windowHead{align-items:baseline;gap:8px;display:flex}
.wbp-windowLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:1.5}
.wbp-windowValue{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums;white-space:nowrap}
.wbp-windowPct{color:var(--dsw-alias-label-primary);min-width:38px;text-align:right;font-size:12px;font-weight:600;line-height:1.5;font-variant-numeric:tabular-nums}
.wbp-bar{overflow:hidden;background:var(--dsw-alias-bg-layer-1);border-radius:999px;height:8px}
.wbp-barFill{background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.wbp-barFillWarn{background:var(--dsw-alias-state-error-primary)}
.wbp-windowReset{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:1.5}

/* Badges. */
.wbp-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-brand-primary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;line-height:17px}
.wbp-badgeError{background:transparent;color:var(--dsw-alias-state-error-primary)}
.wbp-badgeMuted{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;max-width:220px;overflow:hidden;text-overflow:ellipsis}

/* Overall remaining + share line, ahead of the detail table. */
.wbp-totalLine{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.wbp-totalValue{font-size:22px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;margin-left:6px}
.wbp-totalSub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums}

/* Detail table: every package, unmerged. Column heads are the settings
   shell's tertiary smallcaps; numbers are tabular; the mini bar rides under
   the figures in the same cell like the reference layout. */
.wbp-table{width:100%;border-collapse:collapse;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.wbp-table th{text-align:left;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;line-height:1.5;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--dsw-alias-border-l2);padding:4px 8px}
.wbp-table td{padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:top}
.wbp-table tr:last-child td{border-bottom:0}
.wbp-num{min-width:150px}
.wbp-numText{display:block;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-bottom:3px}
.wbp-miniBar{display:block;height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.wbp-expiry{white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}

/* Variant switch: plain buttons, like the settings page's usage carousel. */
.wbp-tabs{flex-wrap:wrap;gap:6px;display:flex}
.wbp-tab{align-items:center;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;display:inline-flex;gap:6px}
.wbp-tab:hover:not(.wbp-tabActive){color:var(--dsw-alias-label-primary)}
.wbp-tabActive{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}

@media (prefers-reduced-motion:reduce){.wbp-footFill,.wbp-barFill{transition:none}}
`;
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
		//#region src/client/usage-format.ts
		/**
		* Format a token count for a compact surface.
		*
		* Rounds DOWN at every step and never promotes a figure to the next unit until
		* it is actually there, so the page never claims more usage than happened —
		* the direction that matters, because an inflated figure reads as overspend.
		*
		* @param value - the raw count.
		* @returns a short label such as `1.2K`, `3.4M`, or `0`.
		*/
		function formatTokens(value) {
			if (!Number.isFinite(value) || value <= 0) return "0";
			for (const unit of [
				{
					limit: 1e9,
					divisor: 1e9,
					suffix: "B"
				},
				{
					limit: 1e6,
					divisor: 1e6,
					suffix: "M"
				},
				{
					limit: 1e3,
					divisor: 1e3,
					suffix: "K"
				}
			]) if (value >= unit.limit) return `${Math.floor(value / unit.divisor * 10) / 10}${unit.suffix}`;
			return String(Math.floor(value));
		}
		/** The total of one bucket set. */
		function tokensTotal(tokens) {
			return tokens.uncachedInput + tokens.output + tokens.cacheRead + tokens.cacheWrite;
		}
		/**
		* The tallest day in a series, floored at 1.
		*
		* The floor is what keeps every bar from dividing by zero on a fresh install,
		* and it is why the chart can render an all-empty week without special-casing.
		*
		* @param days - the series.
		* @returns a positive denominator.
		*/
		function chartCeiling(days) {
			let max = 0;
			for (const day of days) {
				const total = tokensTotal(day.tokens);
				if (total > max) max = total;
			}
			return max > 0 ? max : 1;
		}
		/**
		* A bar's height as a percentage of the ceiling.
		*
		* A NON-ZERO day never renders at zero height. Without the floor, a day with
		* one token beside a day with a million would round to a 0px bar and read as
		* "nothing happened that day" — the exact opposite of the truth, and the one
		* error a usage chart must not make. The minimum is presentation only; the
		* tooltip still carries the real figure.
		*
		* @param tokens - that day's buckets.
		* @param ceiling - the series maximum, from {@link chartCeiling}.
		* @returns a percentage in [0, 100].
		*/
		function barHeightPercent(tokens, ceiling) {
			const total = tokensTotal(tokens);
			if (total <= 0) return 0;
			const percent = total / ceiling * 100;
			return Math.min(100, Math.max(2, percent));
		}
		/** A short `MM-DD` label for a `YYYY-MM-DD` day. */
		function shortDay(day) {
			const parts = day.split("-");
			if (parts.length !== 3) return day;
			return `${parts[1]}-${parts[2]}`;
		}
		/**
		* How much of a quota reading remains, as a 0–1 fraction.
		*
		* Returns `undefined` when the reading cannot express a fraction — an
		* unavailable backend has no figure, an unlimited one has no denominator, and a
		* package set whose sizes were all zero cannot be turned into a percentage
		* without inventing one. `undefined` renders as "no bar"; `0` renders as an
		* empty bar and means "nothing left", which is a different statement.
		*
		* @param quota - the reading, when there is one.
		* @returns the fraction, or undefined when no honest fraction exists.
		*/
		function quotaFraction(quota) {
			if (quota === void 0) return void 0;
			if (quota.kind === "balance") {
				if (quota.size === void 0 || !(quota.size > 0)) return void 0;
				return Math.min(1, Math.max(0, quota.remain / quota.size));
			}
			if (quota.kind === "packages") {
				if (quota.unlimited === true) return void 0;
				if (!(quota.totalSize !== void 0 && quota.totalSize > 0)) return void 0;
				return Math.min(1, Math.max(0, quota.total / quota.totalSize));
			}
		}
		/**
		* One line describing a quota reading.
		*
		* Never returns an empty string: every arm says something, including the arms
		* that mean "we could not find out", because a blank cell on a dashboard reads
		* as a rendering bug rather than as missing data.
		*
		* @param quota - the reading, when there is one.
		* @returns a short human label.
		*/
		function quotaSummary(quota) {
			if (quota === void 0) return "尚未读取";
			switch (quota.kind) {
				case "unavailable": return "不提供额度查询";
				case "error": return `读取失败：${quota.message}`;
				case "balance": return `${formatNumber(quota.remain)}${quota.unit ? " " + quota.unit : ""}`;
				case "packages":
					if (quota.unlimited === true) return "不限量";
					if (quota.totalSize === void 0 || !(quota.totalSize > 0)) return `剩余 ${formatNumber(quota.total)}`;
					return `${formatNumber(quota.total)} / ${formatNumber(quota.totalSize)}`;
			}
		}
		/**
		* Format a number with thousands separators and at most one decimal.
		*
		* `Intl` is deliberately NOT used: the browser bundle is injected into an
		* unknown document, and a locale-sensitive formatter would render differently
		* depending on ambient state the page cannot see. A stable rendering is worth
		* more here than locale-correct separators.
		*
		* @param value - the number.
		* @returns the formatted string.
		*/
		function formatNumber(value) {
			if (!Number.isFinite(value)) return "—";
			const rounded = Math.round(value * 10) / 10;
			const whole = Math.trunc(rounded);
			const fraction = Math.abs(rounded - whole);
			const grouped = String(Math.abs(whole)).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
			const sign = rounded < 0 ? "-" : "";
			return fraction > 0 ? `${sign}${grouped}.${String(Math.round(fraction * 10))}` : `${sign}${grouped}`;
		}
		/** Whether an account's row should carry a warning chip. */
		function accountState(account) {
			if (!account.usable) return {
				label: account.reason ?? "不可用",
				tone: "error"
			};
			const quota = account.quota;
			if (quota?.kind === "error") return {
				label: "额度读取失败",
				tone: "warn"
			};
			if (quota?.kind === "balance" && quota.staleReason !== void 0) return {
				label: "额度可能已过期",
				tone: "warn"
			};
			if (quota?.kind === "unavailable") return {
				label: "不提供额度",
				tone: "muted"
			};
			return {
				label: "正常",
				tone: "ok"
			};
		}
		/**
		* Format an instant as a short local timestamp.
		*
		* @param atMs - epoch milliseconds.
		* @returns `HH:MM` when today, otherwise `MM-DD HH:MM`.
		*/
		function formatFetchedAt(atMs, nowMs) {
			if (atMs === void 0 || !Number.isFinite(atMs)) return void 0;
			const at = new Date(atMs);
			const now = new Date(nowMs);
			const pad = (value) => String(value).padStart(2, "0");
			const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
			return at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate() ? time : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
		}
		//#endregion
		//#region src/client/UsagePanel.tsx
		/**
		* The usage dashboard: what every backend account holds, and what has been
		* spent, in one screen.
		*
		* Reads its document from `WORKBUDDY_USAGE_PATH` and writes through
		* `WORKBUDDY_USAGE_ACTION_PATH`. Both are same-origin plugin routes; the write
		* route additionally requires the in-process key the document hands over.
		*
		* DELIBERATE DIVISION OF LABOUR. This component decides presentation and
		* nothing else: every rule about what a figure MEANS (is a missing balance a
		* zero? is a short bar a small day or an empty one?) lives in
		* `usage-format.ts`, which is tested without a DOM. The component is therefore
		* mostly markup, and a layout change cannot alter what the page claims.
		*
		* @module dsh-workbuddy-connect/client/UsagePanel
		*/
		/** How often the page re-reads the document while it is open. */
		const REFRESH_INTERVAL_MS = 3e4;
		/** One colour per backend in the chart legend; cycles when exhausted. */
		const BACKEND_COLORS = [
			"#4d6bfe",
			"#22a06b",
			"#e8833a",
			"#9b5de5",
			"#00b8d9",
			"#d6455d"
		];
		/** Fetch one document, reporting a failure as a state rather than throwing. */
		async function fetchDocument$1(signal) {
			try {
				const response = await fetch(WORKBUDDY_USAGE_PATH, {
					signal,
					headers: { accept: "application/json" }
				});
				if (!response.ok) return {
					ok: false,
					message: `HTTP ${response.status}`
				};
				return {
					ok: true,
					doc: await response.json()
				};
			} catch (error) {
				if (signal.aborted) return {
					ok: false,
					message: "aborted"
				};
				return {
					ok: false,
					message: error instanceof Error ? error.message : String(error)
				};
			}
		}
		/** The dashboard's top-level component. */
		function UsagePanel() {
			const [doc, setDoc] = (0, react.useState)(void 0);
			const [error, setError] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [message, setMessage] = (0, react.useState)(void 0);
			const [now, setNow] = (0, react.useState)(() => Date.now());
			const controllerRef = (0, react.useRef)(void 0);
			const load = (0, react.useCallback)(async () => {
				controllerRef.current?.abort();
				const controller = new AbortController();
				controllerRef.current = controller;
				const result = await fetchDocument$1(controller.signal);
				if (controller.signal.aborted) return;
				if (result.ok) {
					setDoc(result.doc);
					setError(void 0);
					setNow(Date.now());
				} else setError(result.message);
			}, []);
			(0, react.useEffect)(() => {
				load();
				const timer = setInterval(() => {
					load();
				}, REFRESH_INTERVAL_MS);
				return () => {
					clearInterval(timer);
					controllerRef.current?.abort();
				};
			}, [load]);
			/** Send one write to the action route; the key travels with the document. */
			const act = (0, react.useCallback)(async (action, windowDays) => {
				const key = doc?.actionKey;
				if (key === void 0) return;
				setBusy(true);
				setMessage(void 0);
				try {
					const result = await (await fetch(WORKBUDDY_USAGE_ACTION_PATH, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-workbuddy-key": key
						},
						body: JSON.stringify(windowDays === void 0 ? { action } : {
							action,
							windowDays
						})
					})).json();
					setMessage({
						text: result.message ?? (result.ok ? "已完成" : "失败"),
						ok: result.ok
					});
					await load();
				} catch (error) {
					setMessage({
						text: error instanceof Error ? error.message : String(error),
						ok: false
					});
				} finally {
					setBusy(false);
				}
			}, [doc?.actionKey, load]);
			const ceiling = (0, react.useMemo)(() => chartCeiling(doc?.days ?? []), [doc?.days]);
			const backendColors = (0, react.useMemo)(() => {
				const map = /* @__PURE__ */ new Map();
				doc?.backends.forEach((backend, index) => {
					map.set(backend.backendId, BACKEND_COLORS[index % BACKEND_COLORS.length]);
				});
				return map;
			}, [doc?.backends]);
			if (doc === void 0 && error === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "wbu-root",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "wbu-empty",
					children: "正在读取用量…"
				})
			});
			if (doc === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "wbu-root",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "wbu-empty",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbu-emptyTitle",
						children: "无法读取用量数据"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: error })]
				})
			});
			const windowTotal = tokensTotal(doc.windowTotals);
			const todayTotal = tokensTotal(doc.todayTotals);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "wbu-root",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbu-header",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbu-titleBlock",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								className: "wbu-title",
								children: "用量汇总"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "wbu-subtitle",
								children: [
									doc.fromDay,
									" 至 ",
									doc.toDay,
									"（",
									doc.days.length,
									" 天）· 共 ",
									doc.accounts.length,
									" 个账号"
								]
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbu-actions",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wbu-windowGroup",
									children: USAGE_WINDOW_CHOICES.map((days) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: "wbu-windowButton",
										"data-active": days === doc.windowDays,
										disabled: busy,
										onClick: () => {
											act("set-window", days);
										},
										children: [days, " 天"]
									}, days))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "wbu-button",
									disabled: busy,
									onClick: () => {
										act("refresh-quotas");
									},
									children: "刷新额度"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "wbu-button",
									disabled: busy,
									onClick: () => {
										act("clear-ledger");
									},
									children: "清空记录"
								})
							]
						})]
					}),
					message !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: `wbu-message ${message.ok ? "wbu-messageOk" : "wbu-messageError"}`,
						children: message.text
					}),
					doc.failures !== void 0 && doc.failures.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wbu-failures",
						children: doc.failures.map((failure) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
							"后端 ",
							failure.id,
							" 启动失败：",
							failure.message
						] }, failure.id))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbu-cards",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SummaryCard, {
								label: "窗口内 token",
								value: formatTokens(windowTotal),
								meta: `${doc.windowCalls} 次调用`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SummaryCard, {
								label: "今日 token",
								value: formatTokens(todayTotal),
								meta: doc.toDay
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SummaryCard, {
								label: "可查询额度的账号",
								value: `${doc.accounts.filter((a) => a.quota !== void 0 && a.quota.kind !== "unavailable").length} / ${doc.accounts.length}`,
								meta: doc.anyQuota ? "来自各后端上游" : "当前无后端提供额度"
							})
						]
					}),
					doc.hasHistory ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageChart, {
						days: doc.days,
						ceiling,
						backends: doc.backends.map((backend) => ({
							backendId: backend.backendId,
							backendName: backend.backendName,
							share: backend.share,
							color: backendColors.get(backend.backendId) ?? BACKEND_COLORS[0]
						}))
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbu-empty",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbu-emptyTitle",
							children: "还没有用量记录"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "本插件从此刻起记录每个后端账号的 token 消耗；历史上游不提供按天用量，因此只会计入此后的调用。" })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbu-section",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: "wbu-sectionTitle",
							children: "账号明细"
						}), doc.accounts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbu-empty",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbu-emptyTitle",
								children: "还没有可用的后端账号"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "在「插件配置」中登录或配置一个后端后，这里会显示它的额度与用量。" })]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
							className: "wbu-table",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "后端 / 账号" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "状态" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "剩余额度" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									className: "wbu-num",
									children: "窗口内"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									className: "wbu-num",
									children: "今日"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									className: "wbu-num",
									children: "调用"
								})
							] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: doc.accounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountRow, {
								account,
								nowMs: now
							}, `${account.backendId}/${account.accountId}`)) })]
						})]
					})
				]
			});
		}
		/** One figure in the summary strip. */
		function SummaryCard(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "wbu-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbu-cardLabel",
						children: props.label
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbu-cardValue",
						children: props.value
					}),
					props.meta !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbu-cardMeta",
						children: props.meta
					})
				]
			});
		}
		/** The daily bar chart with its legend. */
		function UsageChart(props) {
			const first = props.days[0]?.day;
			const last = props.days[props.days.length - 1]?.day;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "wbu-chart",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wbu-bars",
						children: props.days.map((day) => {
							const total = tokensTotal(day.tokens);
							const height = barHeightPercent(day.tokens, props.ceiling);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "wbu-bar",
								title: `${day.day}：${formatTokens(total)} token，${day.calls} 次调用`,
								children: total > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "wbu-barFill",
									style: { height: `${height}%` }
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "wbu-barEmpty" })
							}, day.day);
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbu-axis",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: first !== void 0 ? shortDay(first) : "" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: last !== void 0 ? shortDay(last) : "" })]
					}),
					props.backends.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wbu-legend",
						children: props.backends.map((backend) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "wbu-legendItem",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wbu-legendDot",
									style: { background: backend.color }
								}),
								backend.backendName,
								" · ",
								Math.round(backend.share * 100),
								"%"
							]
						}, backend.backendId))
					})
				]
			});
		}
		/** One account's row. */
		function AccountRow(props) {
			const { account } = props;
			const state = accountState(account);
			const fraction = quotaFraction(account.quota);
			const fetchedAt = formatFetchedAt(account.quotaFetchedAtMs, props.nowMs);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "wbu-name",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbu-nameMain",
						children: account.accountLabel
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "wbu-nameSub",
						children: [account.backendName, account.accountDetail !== void 0 ? ` · ${account.accountDetail}` : ""]
					})]
				}) }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: `wbu-chip wbu-chip${toneClass(state.tone)}`,
					children: state.label
				}) }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "wbu-quota",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbu-quotaHead",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: quotaSummary(account.quota) })
						}),
						fraction !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbu-quotaBar",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: `wbu-quotaFill${fraction <= .1 ? " wbu-quotaFillWarn" : ""}`,
								style: { width: `${Math.round(fraction * 100)}%` }
							})
						}),
						fetchedAt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "wbu-quotaNote",
							children: ["读取于 ", fetchedAt]
						})
					]
				}) }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
					className: "wbu-num",
					children: formatTokens(tokensTotal(account.windowTokens))
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
					className: "wbu-num",
					children: formatTokens(tokensTotal(account.todayTokens))
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
					className: "wbu-num",
					children: formatNumber(account.windowCalls)
				})
			] });
		}
		/** Map a tone onto the stylesheet's chip suffix. */
		function toneClass(tone) {
			if (tone === "warn") return "Warn";
			if (tone === "error") return "Error";
			if (tone === "muted") return "Muted";
			return "Ok";
		}
		//#endregion
		//#region src/client/usage-styles.ts
		/**
		* Stylesheet for the usage dashboard.
		*
		* Same contract as `quota-styles.ts`, and a SEPARATE stylesheet id rather than
		* an addition to that one: the quota surface is owned by the WorkBuddy variant
		* path, and the dashboard is owned by the merged-backend path. Shipping them
		* together would mean a change to the dashboard's CSS could not be reasoned
		* about without reading the quota panel's, which is exactly the coupling the
		* backend split exists to avoid.
		*
		* Classes are `wbu-` prefixed. All three of this plugin's stylesheets inject
		* GLOBAL CSS into one document, so the prefixes must not collide: `wbp-` is
		* the quota panel, `wbu-` is this one.
		*
		* Every colour comes from a harness theme alias with a neutral fallback, so the
		* page follows the user's theme instead of pinning its own palette.
		*/
		/** Stylesheet id (the `data-plugin-css` value that makes injection idempotent). */
		const USAGE_CSS_ID = "dsh-workbuddy-connect/UsagePanel.module.css";
		/** Install the stylesheet once; returns its disposer. */
		function injectUsageCss() {
			if (typeof document === "undefined") return () => {};
			if (document.querySelector(`style[data-plugin-css="dsh-workbuddy-connect/UsagePanel.module.css"]`) !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-workbuddy-connect";
			tag.dataset.pluginCss = USAGE_CSS_ID;
			tag.textContent = USAGE_CSS;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}
		/** The usage dashboard stylesheet. */
		const USAGE_CSS = `
.wbu-root{display:flex;flex-direction:column;gap:16px;padding:16px;color:var(--dsw-alias-label-primary,#111);font-size:13px;line-height:20px}

/* ---------------------------------------------------------------- header */
.wbu-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.wbu-titleBlock{display:flex;flex-direction:column;gap:2px;min-width:0}
.wbu-title{margin:0;font-size:15px;font-weight:600;line-height:22px}
.wbu-subtitle{color:var(--dsw-alias-label-tertiary,#888);font-size:12px;line-height:18px}
.wbu-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

/* ----------------------------------------------------------------- cards */
.wbu-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.wbu-card{display:flex;flex-direction:column;gap:4px;padding:12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent)}
.wbu-cardLabel{color:var(--dsw-alias-label-tertiary,#888);font-size:11px;line-height:16px}
.wbu-cardValue{font-size:20px;font-weight:600;line-height:26px;font-variant-numeric:tabular-nums}
.wbu-cardMeta{color:var(--dsw-alias-label-secondary,#666);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}

/* ---------------------------------------------------------------- chart */
.wbu-chart{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px}
/* A fixed height with items END-aligned: the bars grow from the baseline, which
   is the only orientation that reads as a time series. */
.wbu-bars{display:flex;align-items:flex-end;gap:2px;height:120px;min-height:120px}
.wbu-bar{flex:1 1 0;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;height:100%;position:relative;cursor:default}
.wbu-barFill{width:100%;background:var(--dsw-alias-brand-primary,#4d6bfe);border-radius:2px 2px 0 0;min-height:0;transition:height .2s ease}
/* A day with no usage renders a hairline instead of nothing: an empty column is
   indistinguishable from a missing one, and "I used nothing" is information. */
.wbu-barEmpty{width:100%;height:2px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));border-radius:1px}
.wbu-bar:hover .wbu-barFill{filter:brightness(1.1)}
.wbu-axis{display:flex;justify-content:space-between;color:var(--dsw-alias-label-tertiary,#888);font-size:10px;line-height:14px;font-variant-numeric:tabular-nums}
.wbu-legend{display:flex;flex-wrap:wrap;gap:10px}
.wbu-legendItem{display:flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary,#666);font-size:11px;line-height:16px}
.wbu-legendDot{width:8px;height:8px;border-radius:2px;flex:none}

/* --------------------------------------------------------------- tables */
.wbu-section{display:flex;flex-direction:column;gap:8px}
.wbu-sectionTitle{margin:0;font-size:13px;font-weight:600;line-height:20px}
.wbu-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.wbu-table th{text-align:left;color:var(--dsw-alias-label-tertiary,#888);font-size:11px;font-weight:500;line-height:16px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));white-space:nowrap}
.wbu-table td{padding:8px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.05));vertical-align:middle}
.wbu-table tr:last-child td{border-bottom:0}
.wbu-num{text-align:right;white-space:nowrap}
.wbu-name{display:flex;flex-direction:column;gap:1px;min-width:0}
.wbu-nameMain{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbu-nameSub{color:var(--dsw-alias-label-tertiary,#888);font-size:11px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ----------------------------------------------------------------- chips */
.wbu-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:999px;font-size:10px;line-height:16px;white-space:nowrap;border:1px solid transparent}
.wbu-chipOk{color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}
.wbu-chipWarn{color:var(--dsw-alias-state-warning-primary,#b26a00);background:rgba(178,106,0,.1)}
.wbu-chipError{color:var(--dsw-alias-state-error-primary,#c0392b);background:rgba(192,57,43,.1)}
.wbu-chipMuted{color:var(--dsw-alias-label-tertiary,#888);background:transparent;border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.1))}

/* ----------------------------------------------------------------- quota */
.wbu-quota{display:flex;flex-direction:column;gap:3px;min-width:110px}
.wbu-quotaHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.wbu-quotaBar{height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));overflow:hidden}
.wbu-quotaFill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,#4d6bfe);transition:width .3s ease}
.wbu-quotaFillWarn{background:var(--dsw-alias-state-error-primary,#c0392b)}
.wbu-quotaNote{color:var(--dsw-alias-label-tertiary,#888);font-size:10px;line-height:14px}

/* --------------------------------------------------------------- buttons */
.wbu-button{font:inherit;font-size:12px;line-height:18px;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:var(--dsw-alias-label-primary,#111);cursor:pointer}
.wbu-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.wbu-button:disabled{opacity:.5;cursor:default}
.wbu-button:disabled:hover{background:transparent}
.wbu-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}
.wbu-windowGroup{display:inline-flex;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px;overflow:hidden}
.wbu-windowButton{font:inherit;font-size:12px;line-height:18px;padding:5px 9px;border:0;border-right:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer}
.wbu-windowButton:last-child{border-right:0}
.wbu-windowButton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.wbu-windowButton[data-active="true"]{background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}

/* ---------------------------------------------------------------- states */
.wbu-empty{display:flex;flex-direction:column;gap:6px;padding:20px;text-align:center;color:var(--dsw-alias-label-secondary,#666);border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:10px}
.wbu-emptyTitle{font-weight:500;color:var(--dsw-alias-label-primary,#111)}
.wbu-message{padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px}
.wbu-messageOk{color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}
.wbu-messageError{color:var(--dsw-alias-state-error-primary,#c0392b);background:rgba(192,57,43,.08)}
.wbu-failures{display:flex;flex-direction:column;gap:4px;color:var(--dsw-alias-state-warning-primary,#b26a00);font-size:11px;line-height:16px}
`;
		//#endregion
		//#region src/client/usage-registration.tsx
		/**
		* The panel key.
		*
		* Distinct from the quota dashboard's key: two entries under one key would
		* replace each other, and the usage page must be reachable while a WorkBuddy
		* variant's quota panel is also live.
		*/
		const USAGE_PANEL_ID = "dsh-workbuddy-connect-usage";
		/**
		* Register the usage dashboard.
		*
		* @param ctx - the browser plugin context.
		* @param options - injects the panel's face (path and close seam).
		* @returns nothing; registration failures are logged, never thrown, so a
		*   missing seat cannot stop the rest of the browser half from loading.
		*/
		function registerUsagePanel(ctx, options) {
			ctx.effect(() => injectUsageCss(), "dsh-workbuddy-connect: usage styles");
			const face = () => ({
				usagePath: WORKBUDDY_USAGE_PATH,
				close: options.close
			});
			try {
				ctx.slots.inject("main", () => ctx.slots.register({
					name: "main",
					key: options.panelId,
					inject: face
				}, UsagePanel));
			} catch (error) {
				console.error("[dsh-workbuddy-connect] could not register the usage panel:", error);
			}
		}
		//#endregion
		//#region src/backends-paths.ts
		/**
		* The multi-backend configuration wire contract, shared by the host and the
		* browser half.
		*
		* Lives beside `status-paths.ts` and `usage-paths.ts` for the reason both of
		* those do: the two halves are bundled independently, so a route named in one
		* place and spelled differently in the other fails only at runtime, in a
		* browser, for the user.
		*
		* WHAT THIS SURFACE IS FOR, and the one thing it must not do. The merged
		* backends differ in whether the plugin can configure them at all:
		*
		*  - an `api-key` backend (Cline, Command Code) can genuinely be configured
		*    here — the plugin owns the credential, so it can add, list and remove
		*    accounts;
		*  - a `desktop-adoption` backend (Trae, Qoder, CodeBuddy, MiMo, Loomy) reads
		*    ANOTHER application's single login slot. There is nothing to write, so the
		*    card reports status and guidance and offers no "add account" control — a
		*    button with nothing behind it is worse than no button;
		*  - a `managed-runtime` backend (OpenCode) reports whether its runtime is
		*    prepared.
		*
		* `configurable` carries that distinction to the browser so the UI can render
		* the difference rather than guess it from `authKind`.
		*
		* SECRETS NEVER TRAVEL BACK. The host sends `secretMasked` (a short prefix and
		* suffix, for identifying which key is which) and never the stored value. The
		* browser may only SEND a new secret when adding or replacing one.
		*
		* @module dsh-multibuddy-connect/backends-paths
		*/
		/** Same-origin route serving the backend catalogue and its account status. */
		const WORKBUDDY_BACKENDS_PATH = "/plugins/dsh-workbuddy-connect/backends";
		/**
		* Same-origin route accepting configuration writes.
		*
		* Separate from the read route for the same reason the usage action route is:
		* a state-changing endpoint must not be reachable through the unauthenticated
		* GET a page can be tricked into issuing. It therefore also requires the
		* in-process key the document hands the browser.
		*/
		const WORKBUDDY_BACKENDS_ACTION_PATH = "/plugins/dsh-workbuddy-connect/backends/action";
		//#endregion
		//#region src/client/BackendsCard.tsx
		/**
		* The multi-backend configuration card: one settings-page card that lists every
		* merged backend and configures the ones this plugin is allowed to configure.
		*
		* Reads its document from WORKBUDDY_BACKENDS_PATH and writes through
		* WORKBUDDY_BACKENDS_ACTION_PATH. Both are same-origin plugin routes; the write
		* route additionally requires the in-process key the document hands over, sent
		* as the x-workbuddy-key header.
		*
		* WHY THE SAME CARD LOOKS DIFFERENT PER BACKEND. The merged backends do not all
		* own their credentials, and the difference is reported as `configurable`,
		* never guessed from `authKind`. An `api-key` backend stores its keys HERE, so
		* the card shows a real account manager: the stored accounts, a delete control
		* per row, and an add form. A `desktop-adoption` backend (Trae, Qoder,
		* CodeBuddy, MiMo, Loomy) reads ANOTHER application's single login slot, and a
		* `managed-runtime` backend (OpenCode) reports whether its runtime is prepared;
		* for both, there is nothing this plugin could write. A button with nothing
		* behind it is worse than no button: the user clicks, nothing happens, and they
		* conclude the plugin is broken. Those two therefore render a READ-ONLY status
		* line instead — and this file never renders an account control for them, by
		* branching on `configurable` alone.
		*
		* SECRETS NEVER ARRIVE. The host sends `secretMasked` and never a stored value,
		* so the card can only ever DISPLAY a mask and SEND a new secret.
		*
		* @module dsh-workbuddy-connect/client/BackendsCard
		*/
		/** authKind -> the Chinese label the card shows. */
		const AUTH_KIND_LABELS = {
			"device-code": "网页登录",
			"api-key": "API Key",
			"desktop-adoption": "读取客户端登录",
			"managed-runtime": "受管运行时"
		};
		/**
		* Per-authKind explanation for the non-configurable backends.
		*
		* These are the two cases where the credential lives in the OTHER program: a
		* desktop-adoption account belongs to the adopted client (the user signs in
		* there, and this plugin only reads the result), and a managed runtime must be
		* installed locally before the backend can run at all. Neither has a value this
		* plugin could accept, which is why the sentence says what to do INSTEAD of
		* offering a form.
		*/
		const READ_ONLY_NOTES = {
			"desktop-adoption": "这类后端读取的是对应客户端自身的登录状态：需要在那个客户端里登录，本插件只读，无法代为配置账号。",
			"managed-runtime": "这类后端需要先准备好本地运行时；运行时就绪后本插件会自动检测到，无需在此配置账号。"
		};
		/** The badge shown for each resolved availability state. */
		const STATE_PRESENTATION = {
			ready: {
				label: "可用",
				tone: "ready"
			},
			"signed-out": {
				label: "未登录",
				tone: "signedOut"
			},
			unavailable: {
				label: "不可用",
				tone: "unavailable"
			},
			failed: {
				label: "启动失败",
				tone: "failed"
			}
		};
		/** The non-configurable explanation for an authKind with no canned sentence. */
		const READ_ONLY_FALLBACK = "这个后端的账号由它自己管理，本插件只显示探测到的状态。";
		/** Fetch one document, reporting a failure as a value rather than throwing. */
		async function fetchDocument(signal) {
			try {
				const response = await fetch(WORKBUDDY_BACKENDS_PATH, {
					signal,
					headers: { accept: "application/json" }
				});
				if (!response.ok) return {
					ok: false,
					message: "HTTP " + response.status
				};
				return {
					ok: true,
					doc: await response.json()
				};
			} catch (error) {
				if (signal.aborted) return {
					ok: false,
					message: "已取消"
				};
				return {
					ok: false,
					message: error instanceof Error ? error.message : String(error)
				};
			}
		}
		/**
		* One timestamp, rendered compactly and in the LOCAL timezone.
		*
		* Locale-dependent time formatting is deliberately NOT used: the harness ships
		* with a pinned locale, while a stored account's update time is a fact the user
		* compares against their own clock, not prose. Returns undefined for a missing
		* or unparsable value so the row omits the line instead of printing
		* "Invalid Date".
		*/
		function formatStamp(ms) {
			if (ms === void 0 || !Number.isFinite(ms) || ms <= 0) return void 0;
			const date = new Date(ms);
			if (Number.isNaN(date.getTime())) return void 0;
			const pad = (value) => value < 10 ? "0" + String(value) : String(value);
			return String(date.getFullYear()) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
		}
		/**
		* The stored account's update stamp, or undefined when the value is unusable.
		*
		* A named accessor rather than an inline call: the row tests the value for
		* presence and then prints it, and doing that through two expressions would
		* recompute the format on every render.
		*/
		function stampOf(account) {
			return formatStamp(account.updatedAtMs);
		}
		/**
		* A stable id-safe fragment of a backend id.
		*
		* Used to build the htmlFor/id pair that associates each add-account label with
		* its input. Several backends render at once, so the ids must differ; the index
		* is appended by the caller as a tiebreaker for ids that contain nothing usable
		* (or are empty).
		*/
		function idFragment(backendId) {
			const cleaned = backendId.replace(/[^A-Za-z0-9_-]/g, "-");
			return cleaned.length > 0 ? cleaned : "backend";
		}
		/** The multi-backend configuration card. */
		function BackendsCard(props = {}) {
			const title = typeof props.title === "string" ? props.title : "第三方后端配置";
			const subtitle = typeof props.subtitle === "string" ? props.subtitle : "这里列出已合并进本插件的全部后端。可以配置的后端能直接管理账号；凭据属于其他应用的只显示状态。";
			const [doc, setDoc] = (0, react.useState)(void 0);
			const [error, setError] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [message, setMessage] = (0, react.useState)(void 0);
			/** Draft of every add-account form, keyed by backend id. */
			const [drafts, setDrafts] = (0, react.useState)({});
			const controllerRef = (0, react.useRef)(void 0);
			const load = (0, react.useCallback)(async () => {
				controllerRef.current?.abort();
				const controller = new AbortController();
				controllerRef.current = controller;
				const result = await fetchDocument(controller.signal);
				if (controller.signal.aborted) return;
				if (result.ok) {
					setDoc(result.doc);
					setError(void 0);
				} else setError(result.message);
			}, []);
			(0, react.useEffect)(() => {
				load();
				return () => {
					controllerRef.current?.abort();
				};
			}, [load]);
			/**
			* Send one write. The key travels with the document; the route rejects a
			* request without it, so a missing key is reported rather than ignored.
			*/
			const act = (0, react.useCallback)(async (action) => {
				const key = doc?.actionKey;
				if (key === void 0 || key.length === 0) {
					setMessage({
						text: "缺少写入密钥，无法提交；请重新加载页面后再试。",
						ok: false
					});
					return;
				}
				setBusy(true);
				setMessage(void 0);
				try {
					const result = await (await fetch(WORKBUDDY_BACKENDS_ACTION_PATH, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-workbuddy-key": key
						},
						body: JSON.stringify(action)
					})).json();
					setMessage({
						text: result.message ?? (result.ok ? "操作已完成" : "操作失败"),
						ok: result.ok
					});
					await load();
				} catch (caught) {
					setMessage({
						text: caught instanceof Error ? caught.message : String(caught),
						ok: false
					});
				} finally {
					setBusy(false);
				}
			}, [doc?.actionKey, load]);
			/** Store (or replace) one account, then clear the form. */
			const addAccount = (0, react.useCallback)(async (backendId, label, secret) => {
				if (secret.length === 0) {
					setMessage({
						text: "请先填写密钥。",
						ok: false
					});
					return;
				}
				const action = {
					action: "add-account",
					backendId,
					secret
				};
				if (label.length > 0) action.label = label;
				await act(action);
				setDrafts((previous) => ({
					...previous,
					[backendId]: {
						label: "",
						secret: ""
					}
				}));
			}, [act]);
			/** Drop one stored account after an explicit confirmation. */
			const removeAccount = (0, react.useCallback)(async (backendId, account) => {
				if (!(typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm("确定删除账号「" + account.label + "」吗？删除后该密钥将不再可用。") : true)) return;
				await act({
					action: "remove-account",
					backendId,
					accountId: account.id
				});
			}, [act]);
			const failures = doc?.failures ?? [];
			const usableCount = (0, react.useMemo)(() => (doc?.backends ?? []).filter((backend) => backend.state === "ready").length, [doc?.backends]);
			if (doc === void 0 && error === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "wbc-root",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "wbc-empty",
					children: "正在读取后端列表…"
				})
			});
			if (doc === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "wbc-root",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "wbc-empty",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["无法读取后端列表：", error] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "请确认插件的主机半边已启动，然后重试。" })]
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "wbc-root",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbc-header",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbc-titleBlock",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								className: "wbc-title",
								children: title
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "wbc-subtitle",
								children: [
									subtitle,
									" · 共 ",
									doc.backends.length,
									" 个后端，其中 ",
									usableCount,
									" 个可用"
								]
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "wbc-actions",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "wbc-button",
								disabled: busy,
								onClick: () => {
									act({ action: "refresh" });
								},
								children: busy ? "处理中…" : "重新检测"
							})
						})]
					}),
					message !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wbc-message " + (message.ok ? "wbc-messageOk" : "wbc-messageError"),
						role: "status",
						children: message.text
					}),
					failures.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbc-failures",
						role: "status",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
							className: "wbc-failuresTitle",
							children: [
								"以下后端未能启动（",
								failures.length,
								" 个）"
							]
						}), failures.map((failure) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: "wbc-failureLine",
							children: [
								"后端 ",
								failure.id,
								"：",
								failure.message
							]
						}, failure.id))]
					}),
					doc.backends.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wbc-empty",
						children: "还没有合并任何第三方后端。"
					}) : doc.backends.map((backend, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BackendSection, {
						backend,
						index,
						busy,
						draft: drafts[backend.id] ?? {
							label: "",
							secret: ""
						},
						onDraftChange: (next) => {
							setDrafts((previous) => ({
								...previous,
								[backend.id]: next
							}));
						},
						onAdd: (label, secret) => {
							addAccount(backend.id, label, secret);
						},
						onRemove: (account) => {
							removeAccount(backend.id, account);
						}
					}, backend.id))
				]
			});
		}
		/**
		* One backend's section.
		*
		* The single branch that matters is `backend.configurable`:
		*
		*  - true  -> the account manager (stored rows with delete, the add form, envHint);
		*  - false -> the read-only status view (discovered accounts plus the sentence
		*             that says where the credential actually lives).
		*
		* The two arms share nothing but the header, so a future control cannot leak
		* into the read-only arm by accident.
		*/
		function BackendSection(props) {
			const { backend, draft } = props;
			const presentation = STATE_PRESENTATION[backend.state];
			const fieldId = "wbc-add-" + idFragment(backend.id) + "-" + String(props.index);
			const readOnlyNote = READ_ONLY_NOTES[backend.authKind] ?? READ_ONLY_FALLBACK;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "wbc-section",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbc-sectionHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "wbc-sectionTitle",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wbc-name",
									children: backend.displayName
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "wbc-id",
									children: [backend.vendor !== void 0 && backend.vendor.length > 0 ? backend.vendor + " · " : "", backend.id]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "wbc-spacer" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbc-chip",
								children: AUTH_KIND_LABELS[backend.authKind]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbc-badge wbc-badge" + presentation.tone,
								children: presentation.label
							})
						]
					}),
					backend.description !== void 0 && backend.description.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "wbc-hint",
						children: backend.description
					}),
					backend.hint !== void 0 && backend.hint.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "wbc-hint",
						children: backend.hint
					}),
					backend.message !== void 0 && backend.message.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "wbc-messageText",
						children: backend.message
					}),
					backend.configurable ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbc-block",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
								className: "wbc-blockTitle",
								children: [
									"已配置账号（",
									backend.stored.length,
									"）"
								]
							}), backend.stored.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbc-note",
								children: "尚未配置账号。"
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: "wbc-list",
								children: backend.stored.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									className: "wbc-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "wbc-rowMain",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "wbc-rowLabel",
											children: account.label
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "wbc-rowSub",
											children: [account.secretMasked, stampOf(account) === void 0 ? "" : " · 更新于 " + String(stampOf(account))]
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "wbc-button wbc-buttonDanger",
										disabled: props.busy,
										"aria-label": "删除账号 " + account.label,
										onClick: () => {
											props.onRemove(account);
										},
										children: "删除"
									})]
								}, account.id))
							})]
						}),
						backend.envHint !== void 0 && backend.envHint.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: "wbc-envHint",
							children: [
								"未配置账号时会回落到环境变量 ",
								backend.envHint,
								"。若该变量已导出，这里不配置账号也能正常工作， 请不要为此再添加一个重复账号。"
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
							className: "wbc-form",
							onSubmit: (event) => {
								event.preventDefault();
								props.onAdd(draft.label.trim(), draft.secret.trim());
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "wbc-field",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "wbc-label",
										htmlFor: fieldId + "-label",
										children: "显示名称"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: fieldId + "-label",
										className: "wbc-input",
										type: "text",
										value: draft.label,
										placeholder: backend.displayName,
										disabled: props.busy,
										onChange: (event) => {
											props.onDraftChange({
												label: event.target.value,
												secret: draft.secret
											});
										}
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "wbc-field",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "wbc-label",
										htmlFor: fieldId + "-secret",
										children: "密钥（API Key）"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: fieldId + "-secret",
										className: "wbc-input",
										type: "password",
										value: draft.secret,
										autoComplete: "off",
										spellCheck: false,
										disabled: props.busy,
										"aria-label": "为 " + backend.displayName + " 添加账号的密钥",
										onChange: (event) => {
											props.onDraftChange({
												label: draft.label,
												secret: event.target.value
											});
										}
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "wbc-button",
									disabled: props.busy,
									onClick: () => {
										props.onDraftChange({
											label: "",
											secret: ""
										});
									},
									children: "清空"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "submit",
									className: "wbc-button",
									disabled: props.busy,
									children: props.busy ? "提交中…" : "添加账号"
								})
							]
						})
					] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "wbc-note",
							children: readOnlyNote
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbc-block",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
								className: "wbc-blockTitle",
								children: [
									"探测到的账号（",
									backend.accounts.length,
									"）"
								]
							}), backend.accounts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbc-note",
								children: "没有探测到账号。"
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: "wbc-list",
								children: backend.accounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									className: "wbc-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "wbc-rowMain",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "wbc-rowLabel",
											children: account.label
										}), account.detail !== void 0 && account.detail.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "wbc-rowSub",
											children: account.detail
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: account.usable ? "wbc-badge wbc-badgeReady" : "wbc-badge wbc-badgeUnavailable",
										children: account.usable ? "可用" : "不可用"
									})]
								}, account.id))
							})]
						}),
						backend.accounts.map((account) => account.reason !== void 0 && account.reason.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: "wbc-note",
							children: [
								account.label,
								"：",
								account.reason
							]
						}, account.id + "-reason") : null)
					] })
				]
			});
		}
		//#endregion
		//#region src/client/backends-styles.ts
		/**
		* Stylesheet for the multi-backend configuration card (BackendsCard).
		*
		* Same contract as quota-styles.ts and usage-styles.ts, and a SEPARATE
		* stylesheet id rather than an addition to either: this card belongs to the
		* merged-backend configuration path, while the quota panel and the usage
		* dashboard belong to their own surfaces. Folding them together would make a
		* colour change here impossible to review without reading two unrelated
		* panels, and would re-serve the whole sheet on every edit.
		*
		* Classes are wbc- prefixed. All of this plugin's stylesheets inject GLOBAL
		* CSS into one document, so the prefixes must not collide: wbp- is the quota
		* panel, wbu- is the usage dashboard, wbc- is this card.
		*
		* Every colour comes from a harness theme alias WITH a neutral fallback, so
		* the card follows the user's theme instead of pinning a palette of its own.
		*/
		/** Stylesheet id (the data-plugin-css value that makes injection idempotent). */
		const BACKENDS_CSS_ID = "dsh-workbuddy-connect/BackendsCard.module.css";
		/** Install the stylesheet once; returns its disposer. */
		function injectBackendsCss() {
			if (typeof document === "undefined") return () => {};
			if (document.querySelector(`style[data-plugin-css="dsh-workbuddy-connect/BackendsCard.module.css"]`) !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-workbuddy-connect";
			tag.dataset.pluginCss = BACKENDS_CSS_ID;
			tag.textContent = BACKENDS_CSS;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}
		/** The multi-backend configuration card stylesheet. */
		const BACKENDS_CSS = `
/* ------------------------------------------------------------------ card */
/* The card is one column of sections with a hairline between them, matching
   the settings page's own card geometry rather than inventing a new look. */
.wbc-root{display:flex;flex-direction:column;gap:14px;padding:16px;color:var(--dsw-alias-label-primary,#111);font-size:13px;line-height:20px}

/* ----------------------------------------------------------------- head */
.wbc-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.wbc-titleBlock{display:flex;flex-direction:column;gap:2px;min-width:0}
.wbc-title{margin:0;font-size:15px;font-weight:600;line-height:22px}
.wbc-subtitle{color:var(--dsw-alias-label-tertiary,#888);font-size:12px;line-height:18px}
.wbc-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

/* -------------------------------------------------------------- buttons */
.wbc-button{font:inherit;font-size:12px;line-height:18px;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:var(--dsw-alias-label-primary,#111);cursor:pointer}
.wbc-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.wbc-button:disabled{opacity:.5;cursor:default}
.wbc-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}
/* A destructive control is text-first and only colours on hover: a permanently
   red row would make an ordinary account list read as an error state. */
.wbc-buttonDanger{color:var(--dsw-alias-state-error-primary,#c0392b)}
.wbc-buttonDanger:hover:not(:disabled){background:rgba(192,57,43,.08)}

/* --------------------------------------------------------------- states */
.wbc-message{padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px}
.wbc-messageOk{color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}
.wbc-messageError{color:var(--dsw-alias-state-error-primary,#c0392b);background:rgba(192,57,43,.08)}
.wbc-empty{padding:16px;text-align:center;color:var(--dsw-alias-label-secondary,#666);border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:10px}

/* ------------------------------------------------------------- failures */
/* Backends that never constructed: carried outside the entry list because
   there is no descriptor to render. Visually separated so a group that failed
   to load cannot be mistaken for a group that was never merged in. */
.wbc-failures{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--dsw-alias-state-warning-primary,#b26a00);border-radius:10px;background:rgba(178,106,0,.06)}
.wbc-failuresTitle{margin:0;color:var(--dsw-alias-label-primary,#111);font-size:12px;font-weight:600;line-height:18px}
.wbc-failureLine{margin:0;color:var(--dsw-alias-state-warning-primary,#b26a00);font-size:11px;line-height:16px}

/* ------------------------------------------------------------- sections */
.wbc-section{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent)}
.wbc-sectionHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wbc-sectionTitle{flex-direction:column;gap:2px;min-width:0;display:flex}
.wbc-name{font-size:13px;font-weight:600;line-height:20px}
/* The vendor and the id sit under the name as one quiet line: the id is what
   the host's actions address, so it has to be visible when a write fails. */
.wbc-id{color:var(--dsw-alias-label-tertiary,#888);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbc-spacer{flex:1}

/* --------------------------------------------------------------- badges */
.wbc-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;font-size:10px;line-height:16px;white-space:nowrap;border:1px solid transparent;flex:none}
.wbc-badgeReady{color:var(--dsw-alias-state-success-primary,#22a06b);background:rgba(34,160,107,.12)}
.wbc-badgeSignedOut{color:var(--dsw-alias-state-warning-primary,#b26a00);background:rgba(178,106,0,.12)}
.wbc-badgeUnavailable{color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}
.wbc-badgeFailed{color:var(--dsw-alias-state-error-primary,#c0392b);background:rgba(192,57,43,.12)}
.wbc-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;font-size:10px;line-height:16px;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));color:var(--dsw-alias-label-secondary,#666);flex:none}

/* -------------------------------------------------------------- notices */
.wbc-hint{margin:0;color:var(--dsw-alias-label-secondary,#666);font-size:12px;line-height:18px}
.wbc-messageText{margin:0;color:var(--dsw-alias-state-error-primary,#c0392b);font-size:12px;line-height:18px}
.wbc-note{margin:0;color:var(--dsw-alias-label-tertiary,#888);font-size:11px;line-height:16px}
.wbc-envHint{padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#666);font-size:11px;line-height:17px}

/* -------------------------------------------------------------- accounts */
.wbc-block{display:flex;flex-direction:column;gap:6px}
.wbc-blockTitle{margin:0;font-size:12px;font-weight:600;line-height:18px}
.wbc-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.wbc-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.05));border-radius:8px;min-width:0}
.wbc-rowMain{min-width:0;display:flex;flex-direction:column;gap:1px;flex:1}
.wbc-rowLabel{font-weight:500;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbc-rowSub{color:var(--dsw-alias-label-tertiary,#888);font-size:11px;line-height:15px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ----------------------------------------------------------------- form */
.wbc-form{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}
.wbc-field{display:flex;flex-direction:column;gap:3px;min-width:150px}
.wbc-label{color:var(--dsw-alias-label-tertiary,#888);font-size:11px;line-height:16px}
.wbc-input{box-sizing:border-box;font:inherit;font-size:12px;line-height:18px;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-3,transparent);color:var(--dsw-alias-label-primary,#111);min-width:0}
.wbc-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}
`;
		//#endregion
		//#region src/client/UsageEntryButton.tsx
		/** One sidebar row that opens the usage dashboard. */
		function UsageEntryButton(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "wbp-foot",
				title: "查看所有后端的额度与 token 用量",
				onClick: props.open,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "wbp-footTop",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbp-footName",
						children: "用量汇总"
					})
				})
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Plugin-card copy registered under the settings.workbuddy locale namespace. */
		const en = {
			title: "WorkBuddy",
			intro: "Use the models in the WorkBuddy desktop app directly in DSH — zero configuration, ready out of the box.",
			titleAI: "WorkBuddy AI",
			introAI: "Use the models in the WorkBuddy AI international desktop app directly in DSH — zero configuration, ready out of the box.",
			/** The single unified card's title: it owns both variants and the quota settings. */
			unifiedTitle: "WorkBuddy",
			unifiedIntro: "Manage WorkBuddy (China) and WorkBuddy AI (international) models, credentials, and sidebar quota displays.",
			/** The segmented switcher's two halves. */
			variantTabCN: "China",
			variantTabAI: "International",
			expand: "Expand",
			collapse: "Collapse",
			loading: "Loading account…",
			signedOut: "Not signed in",
			signedOutHint: "Sign in to WorkBuddy to use its models in DSH.",
			signedOutHintAI: "Sign in to WorkBuddy AI to use its international models in DSH.",
			signIn: "Sign in",
			signInWaiting: "Waiting for you to finish signing in the browser…",
			signInOpenAgain: "Open the sign-in page again",
			signingIn: "Signing in…",
			signInFailed: "Sign-in failed: {message}",
			signInCancelled: "Sign-in cancelled",
			signOut: "Sign out",
			signingOut: "Signing out…",
			importHeading: "Or use a credential file",
			importHint: "Choose a workbuddy.json you already have. It is validated and stored for this product only.",
			importAction: "Choose file…",
			importing: "Importing…",
			importFailed: "Import failed: {message}",
			importDone: "Imported {account}",
			switchAccount: "Switch account",
			switchingAccount: "Switching…",
			addAccount: "Add account",
			addingAccount: "Adding…",
			addAccountHint: "Sign in to another {product} account. Both share one model group and take turns: when one is rate-limited or out of credit, the other serves.",
			signedInAs: "Signed in as {nickname}",
			accessTokenExpires: "Access token expires {time} (refresh is automatic)",
			creditsHeading: "Remaining credit",
			tabStatus: "Status",
			tabContext: "Context window",
			tabModels: "Model Toggles",
			tabDetails: "Credit details",
			tabCheckIn: "Check-in log",
			checkInLogTime: "Check-in time",
			checkInLogResult: "Result",
			checkInLogAmount: "Credits",
			checkInLogEmpty: "No check-in logs recorded yet.",
			checkInNow: "Check in now",
			checkInChecking: "Checking in…",
			checkInRefresh: "Refresh",
			checkInRefreshing: "Refreshing…",
			checkInClear: "Clear logs",
			checkInClearing: "Clearing…",
			checkInNextRun: "Check-in runs automatically the next time DSH starts.",
			creditsDetailHeading: "By package",
			creditsTotal: "Total: {total}",
			creditsTotalUnlimited: "Total: Unlimited",
			unlimitedQuota: "Unlimited",
			packageEnterprise: "Enterprise quota",
			cycleResetAt: "Resets {time}",
			percentRemaining: "{percent}% remaining",
			percentUnknown: "Remaining share unknown",
			exactRemaining: "{remain} / {size} remaining",
			creditPackageUnknownSize: "{remain} remaining",
			creditsError: "Credit unavailable: {message}",
			activationRequiredTitle: "This account’s free trial is not activated yet",
			activationRequiredBody: "WorkBuddy AI answered that the free trial is not activated, so model calls will fail. Open https://www.workbuddy.ai, sign in with this account and activate the trial — choosing your region is enough — then retry. This notice clears itself once a call succeeds.",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			refreshModels: "Refresh model list",
			refreshingModels: "Refreshing models…",
			catalogLive: "Model list updated {time}",
			catalogSaved: "Showing the saved model list from {time}",
			catalogFallback: "Showing the built-in model list (not yet updated from WorkBuddy)",
			catalogError: "Last update failed: {message}",
			catalogAppVersion: "App version {version}",
			requestFailed: "Request failed",
			statusRefreshFailed: "Refresh failed: {message} — showing the last known state",
			statusResponseInvalid: "WorkBuddy returned an unreadable status reply",
			accountHeading: "Account",
			modelsHeading: "Model offers",
			contextHeading: "Context window",
			contextUpTo: "up to {size}",
			contextDefault: "default {size}",
			useMaximumContextWindow: "Use the largest declared context window",
			useMaximumContextWindowHint: "Applies to WorkBuddy AI models that offer a larger window.",
			freeModel: "Free",
			badgeLimitedFree: "Limited-time free",
			badgeNightDiscount: "Night discount",
			badgeFreeNow: "Free now",
			rate: "{rate} credits per message",
			rateUnknown: "Price unavailable",
			rateExpired: "{rate} ({promo} expired)",
			modelsSearchPlaceholder: "Search models…",
			modelsSelectAll: "Select all",
			modelsEnableAll: "Enable all",
			modelsDisableAll: "Disable all",
			modelsEnabledCount: "{enabled} / {total} models enabled",
			modelsNoMatch: "No matching models found",
			probeLabel: "Reasoning levels",
			probeTooltipIdle: "Detect the reasoning levels {model} accepts",
			probeTooltipVerified: "Accepted levels: {levels} · click to detect again",
			probeTooltipNotValidating: "This model does not check the effort parameter",
			probeTooltipRetry: "Detection did not complete · click to retry",
			probeBubbleBody: "Send test requests to confirm the available reasoning levels. May consume a small amount of credit.",
			probeConfirmAction: "Confirm",
			probeNoteVerified: "Detected: {levels}",
			probeNoteNotValidating: "This model does not check the effort parameter",
			probeNoteUnknown: "Detection did not complete",
			probeNoteDismiss: "Got it",
			probeHeading: "Reasoning effort detection",
			probeResultNoLevels: "No tested levels were accepted.",
			probeIntro: "Some models reason but declare no selectable effort levels. Detecting which levels a model accepts sends a few real requests that may consume credit.",
			probeConsentHint: "Each detection sends test requests to one model to confirm its available reasoning levels, and may consume a small amount of credit.",
			probeStart: "Detect",
			probeRedetect: "Detect again",
			probeRunning: "Detecting {model}…",
			probeRunningGeneric: "Detecting…",
			probeClear: "Clear detected results",
			probeCandidates: "Detectable models: {count}",
			probeConfirmBody: "Send test requests to {model} to confirm its available reasoning levels. May consume a small amount of credit.",
			cancel: "Cancel",
			probeResultVerified: "Verified levels: {levels}",
			probeResultNotValidating: "This model does not check the effort parameter",
			probeResultUnknown: "Detection did not complete",
			probeResultAt: "Detected {time}",
			probeResultEmpty: "No detectable models right now.",
			probeFailed: "Detection failed: {message}",
			quotaSettingsTitle: "WorkBuddy sidebar display",
			quotaSettingsIntro: "Show remaining credit beside the sidebar Settings seat. Each toggle needs its variant signed in.",
			quotaToggleCN: "Show CN credit card",
			quotaToggleAI: "Show international credit card",
			quotaToggleHint: "Show this account’s remaining credit in the sidebar footer.",
			autoCheckInCN: "WorkBuddy (China) auto check-in on startup",
			autoCheckInAI: "WorkBuddy AI (International) auto check-in on startup",
			autoCheckInHintCN: "Claim the China account’s daily benefit once each day when DSH starts.",
			autoCheckInHintAI: "Claim the International account’s daily benefit once each day when DSH starts.",
			autoCheckInStatusClaimed: "Checked in today (+{amount} Credits)",
			autoCheckInStatusAlready: "Already checked in today",
			autoCheckInStatusNoCampaign: "No active benefit campaign today",
			autoCheckInStatusError: "Auto check-in error: {message}",
			quotaSignInRequired: "Sign in first to enable this card.",
			quotaPollLabel: "Refresh interval",
			quotaPollHint: "Applies to both quota cards. Longer is kinder to the billing endpoint.",
			quotaPollUnit: "min",
			quotaSettingsSave: "Save",
			quotaSettingsSaving: "Saving…",
			quotaSettingsDiscard: "Discard",
			quotaSettingsDirty: "Unsaved changes",
			quotaSettingsInvalid: "A value is invalid — fix it before saving",
			quotaSettingsSaveFailed: "Save did not land — retry",
			quotaSettingsSavedHint: "Saved",
			quotaCardCN: "WorkBuddy credit",
			quotaCardAI: "WorkBuddy AI credit",
			quotaUnknownTotal: "total unknown",
			quotaUnlimited: "Unlimited",
			quotaExpires: "Expires",
			quotaNoExpiry: "No expiry",
			quotaError: "Credit unavailable",
			quotaNotSignedIn: "Sign in to see the remaining credit",
			quotaUpdated: "Updated",
			quotaDashboardTitle: "WorkBuddy quota",
			quotaDashboardSubtitle: "Remaining credit by package, per product",
			quotaRefresh: "Refresh",
			quotaRefreshing: "Refreshing…",
			quotaClose: "Close",
			quotaByPackage: "By package",
			quotaTotal: "Total",
			quotaTotalRemain: "Remaining",
			quotaTotalShare: "{percent} of this cycle’s granted total ({remain} / {size})",
			quotaColPackage: "Package",
			quotaColRemain: "Remaining / Total",
			quotaColExpiry: "Expires"
		};
		const zh = {
			title: "WorkBuddy（国内版）",
			intro: "登录 WorkBuddy 国内版后，在侧栏底部查看剩余积分，并直接使用它的模型。",
			titleAI: "WorkBuddy（国际版）",
			introAI: "登录 WorkBuddy AI 国际版后，在侧栏底部查看剩余积分，并直接使用它的模型。",
			unifiedTitle: "WorkBuddy",
			unifiedIntro: "统一管理 WorkBuddy（国内版）与 WorkBuddy AI（国际版）模型、凭证及侧栏额度展示。",
			variantTabCN: "国内版",
			variantTabAI: "国际版",
			expand: "展开",
			collapse: "收起",
			loading: "正在读取账号…",
			signedOut: "未登录",
			signedOutHint: "登录 WorkBuddy 后即可在 DSH 中使用它的模型。",
			signedOutHintAI: "登录 WorkBuddy AI 国际版后即可在 DSH 中使用它的模型。",
			signIn: "登录",
			signInWaiting: "请在浏览器中完成登录…",
			signInOpenAgain: "重新打开登录页面",
			signingIn: "正在登录…",
			signInFailed: "登录失败：{message}",
			signInCancelled: "已取消登录",
			signOut: "退出登录",
			signingOut: "正在退出…",
			switchAccount: "切换账号",
			switchingAccount: "正在切换…",
			addAccount: "添加账号",
			addingAccount: "正在添加…",
			addAccountHint: "登录另一个 {product} 账号，两个账号会在同一个分组下轮换使用；某个账号被限流或额度耗尽时自动切换到另一个。",
			importHeading: "或使用凭证文件",
			importHint: "选择你已有的 workbuddy.json。插件会校验并只保存到本产品名下。",
			importAction: "选择文件…",
			importing: "正在导入…",
			importFailed: "导入失败：{message}",
			importDone: "已导入 {account}",
			signedInAs: "已登录：{nickname}",
			accessTokenExpires: "访问令牌 {time} 过期（自动续期）",
			creditsHeading: "剩余积分",
			tabStatus: "状态",
			tabContext: "上下文窗口",
			tabModels: "模型开关",
			tabDetails: "积分详情",
			tabCheckIn: "签到日志",
			checkInLogTime: "签到时间",
			checkInLogResult: "签到结果",
			checkInLogAmount: "获得额度",
			checkInLogEmpty: "暂无签到日志记录。",
			checkInNow: "立即签到",
			checkInChecking: "正在签到…",
			checkInRefresh: "刷新",
			checkInRefreshing: "正在刷新…",
			checkInClear: "清空日志",
			checkInClearing: "正在清空…",
			checkInNextRun: "下次启动 DSH 时会自动签到。",
			creditsDetailHeading: "按套餐",
			creditsTotal: "合计：{total}",
			creditsTotalUnlimited: "合计：不限额",
			unlimitedQuota: "不限额",
			packageEnterprise: "企业额度",
			cycleResetAt: "重置时间：{time}",
			percentRemaining: "剩余 {percent}%",
			percentUnknown: "剩余占比未知",
			exactRemaining: "剩余 {remain} / {size}",
			creditPackageUnknownSize: "剩余 {remain}",
			creditsError: "积分查询失败：{message}",
			activationRequiredTitle: "该账号的免费试用尚未激活",
			activationRequiredBody: "WorkBuddy AI 返回「试用未激活」，调用模型会失败。请打开 https://www.workbuddy.ai，用当前账号登录并激活免费试用（选择地区即可），然后重试。成功调用一次后此提示会自动消失。",
			refresh: "刷新",
			refreshing: "正在刷新…",
			refreshModels: "刷新模型列表",
			refreshingModels: "正在刷新模型…",
			catalogLive: "模型列表更新于 {time}",
			catalogSaved: "当前显示已保存的模型列表，更新于 {time}",
			catalogFallback: "当前显示内置模型列表（尚未从 WorkBuddy 更新）",
			catalogError: "上次更新失败：{message}",
			catalogAppVersion: "App 版本 {version}",
			requestFailed: "请求失败",
			statusRefreshFailed: "刷新失败：{message} — 当前显示的是上次成功获取的状态",
			statusResponseInvalid: "WorkBuddy 返回的状态数据无法识别",
			accountHeading: "账号",
			modelsHeading: "模型优惠",
			contextHeading: "上下文窗口",
			contextUpTo: "最高 {size}",
			contextDefault: "默认 {size}",
			useMaximumContextWindow: "使用上游声明的最大上下文窗口",
			useMaximumContextWindowHint: "仅作用于 WorkBuddy AI 中声明了更大窗口的模型。",
			freeModel: "免费",
			badgeLimitedFree: "限时免费",
			badgeNightDiscount: "夜间折扣",
			badgeFreeNow: "限时免费",
			rate: "{rate} 积分/次",
			rateUnknown: "价格暂不可用",
			rateExpired: "{rate}（{promo}已过期）",
			modelsSearchPlaceholder: "搜索模型…",
			modelsSelectAll: "全选",
			modelsEnableAll: "批量开启",
			modelsDisableAll: "批量关闭",
			modelsEnabledCount: "已开启 {enabled} / {total} 个模型",
			modelsNoMatch: "未找到匹配的模型",
			probeLabel: "推理等级",
			probeTooltipIdle: "检测 {model} 可用的推理档位",
			probeTooltipVerified: "已接受：{levels} · 点击可重新检测",
			probeTooltipNotValidating: "该模型不校验该参数",
			probeTooltipRetry: "检测未完成 · 点击重试",
			probeBubbleBody: "发送探测请求以确认可用推理档位。可能消耗少量积分。",
			probeConfirmAction: "确认检测",
			probeNoteVerified: "已检测：{levels}",
			probeNoteNotValidating: "该模型不校验该参数",
			probeNoteUnknown: "检测未完成",
			probeNoteDismiss: "知道了",
			probeHeading: "推理档位检测",
			probeResultNoLevels: "本次测试的档位均未被接受。",
			probeIntro: "部分模型具备思考能力，但没有声明可选档位。检测会发送少量真实请求，可能消耗积分。",
			probeConsentHint: "每次检测会向该模型发送探测请求，以确认可用推理档位，可能消耗少量积分。",
			probeStart: "开始检测",
			probeRedetect: "重新检测",
			probeRunning: "正在检测 {model}…",
			probeRunningGeneric: "正在检测…",
			probeClear: "清除已探测结果",
			probeCandidates: "可检测模型：{count} 个",
			probeConfirmBody: "向 {model} 发送探测请求，以确认可用推理档位。可能消耗少量积分。",
			cancel: "取消",
			probeResultVerified: "已验证接受的档位：{levels}",
			probeResultNotValidating: "该模型不校验该参数",
			probeResultUnknown: "检测未完成",
			probeResultAt: "检测于 {time}",
			probeResultEmpty: "当前没有可检测的模型。",
			probeFailed: "检测失败：{message}",
			quotaSettingsTitle: "WorkBuddy侧栏展示",
			quotaSettingsIntro: "在侧栏设置项旁展示剩余积分。开关需要对应账号已登录。",
			quotaToggleCN: "展示国内版额度",
			quotaToggleAI: "展示国际版额度",
			quotaToggleHint: "在侧栏底部展示该账号的剩余积分。",
			autoCheckInCN: "WorkBuddy（国内版）启动时自动签到",
			autoCheckInAI: "WorkBuddy AI（国际版）启动时自动签到",
			autoCheckInHintCN: "每次启动 DSH 时为国内版账号领取当日签到福利（每天只领一次）。",
			autoCheckInHintAI: "每次启动 DSH 时为国际版账号领取当日签到福利（每天只领一次）。",
			autoCheckInStatusClaimed: "今日已自动签到（+{amount} 积分）",
			autoCheckInStatusAlready: "今日已完成签到",
			autoCheckInStatusNoCampaign: "今日无可用签到福利活动",
			autoCheckInStatusError: "自动签到出错：{message}",
			quotaSignInRequired: "请先登录后再开启。",
			quotaPollLabel: "刷新间隔",
			quotaPollHint: "对两张额度卡片同时生效。间隔越长对计费接口越友好。",
			quotaPollUnit: "分钟",
			quotaSettingsSave: "保存",
			quotaSettingsSaving: "保存中…",
			quotaSettingsDiscard: "放弃更改",
			quotaSettingsDirty: "有未保存的更改",
			quotaSettingsInvalid: "有数值不合法，请修正后再保存",
			quotaSettingsSaveFailed: "保存未生效，请重试",
			quotaSettingsSavedHint: "已保存",
			quotaCardCN: "WorkBuddy 积分",
			quotaCardAI: "WorkBuddy AI 积分",
			quotaUnknownTotal: "总量未知",
			quotaUnlimited: "不限量",
			quotaExpires: "到期",
			quotaNoExpiry: "无到期时间",
			quotaError: "积分信息不可用",
			quotaNotSignedIn: "登录后显示剩余积分",
			quotaUpdated: "更新于",
			quotaDashboardTitle: "WorkBuddy 额度",
			quotaDashboardSubtitle: "按套餐展示各产品的剩余积分",
			quotaRefresh: "刷新",
			quotaRefreshing: "刷新中…",
			quotaClose: "关闭",
			quotaByPackage: "按套餐",
			quotaTotal: "合计",
			quotaTotalRemain: "剩余积分",
			quotaTotalShare: "占本轮总额度 {percent}（{remain} / {size}）",
			quotaColPackage: "资源包",
			quotaColRemain: "剩余 / 总量",
			quotaColExpiry: "到期时间"
		};
		//#endregion
		//#region src/plugin-name.ts
		/** The npm package name, as `package.json` declares it. */
		const PLUGIN_PACKAGE_NAME = "dsh-multibuddy-connect";
		//#endregion
		//#region src/client/index.tsx
		/** Browser half: WorkBuddy account status, quota cards, and plugin settings. */
		/**
		* Stable browser-plugin name.
		*/
		const name = "dsh-workbuddy-connect-client";
		/**
		* Client services required by the Plugin configuration contribution.
		*
		* DSH 0.1.2 removed `@deepseek-ai/dsh-client-runtime` (the package that used to
		* hold the browser `ClientContext` alias and the `slots` service). The services
		* this card relies on now come from narrower packages: the `slots` registry
		* moved to `@deepseek-ai/dsh-client-ui-renderer`, `locale` stayed in
		* `@deepseek-ai/dsh-client-locale`. Both are named in the package's
		* `dsh.client.inject` list, so cordis has activated them before this plugin's
		* fiber starts.
		*
		* The CONFIGURATION service is deliberately NOT here either: configuration
		* reads and writes ride this plugin's own settings face (an HTTP route served
		* by the host half over the plugin's own file), so no host configuration
		* service — 0.1.5's `settingsScope`, removed in 0.1.7, or 0.1.7's `configForms`
		* — is a static dependency of this bundle at all.
		*/
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.session"
		];
		/**
		* This plugin's package name.
		*
		* Used as the entry `id` inside the shared 《插件设置》 block and as the
		* `plugins.bundle.config` slot key. The latter must spell the package name
		* exactly — the plugin manager's configuration ledger reads that key to decide
		* whether this bundle's settings section renders at all — so it comes from the
		* build-time constant rather than a literal that a rename would leave behind.
		*/
		const PACKAGE_NAME = PLUGIN_PACKAGE_NAME;
		/**
		* The shared 《插件设置》 container the three connect plugins agree on: slot
		* `settings.section`, entry id `plugin-settings`, child slot
		* `plugin-settings.item`. The id and the child slot name must stay identical
		* across the three plugins — a mismatch would produce two half-empty blocks,
		* or a container whose child slot nobody declared.
		*/
		const PLUGIN_SETTINGS_SECTION_ID = "plugin-settings";
		const PLUGIN_SETTINGS_ITEM_SLOT = "plugin-settings.item";
		/**
		* The plugin manager's bundle-configuration seat, and this bundle's key in it.
		*
		* The sidebar's Plugins panel (the `plugins` main panel the Host's plugin
		* manager registers) renders one bundle's own configuration on the bundle's
		* detail page — between the description and the component rows — through the
		* `plugins.bundle.config` keyed slot. The key must spell this package's name
		* exactly: it is the same key the page's configuration ledger reads to decide
		* whether the configuration section shows at all. The slot itself is declared
		* by the Host (see `plugin-manager-slots.ts` for the structural restatement),
		* so registering before that declaration exists is a no-op by construction —
		* `ctx.slots.inject` defers the factory until the seat is committed.
		*/
		const PLUGIN_MANAGER_SLOT = "plugins.bundle.config";
		/**
		* The container component of the shared 《插件设置》 block.
		*
		* It owns no content of its own: every attached plugin registers a card into
		* the child slot this entry declares, and the container renders them. Only the
		* plugin that wins the container registration mounts this; a plugin that lost
		* the race registers into the winner's container and never mounts it.
		*/
		function PluginSettingsSection(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 6,
					padding: 0,
					listStyle: "none"
				},
				children: props.renderSlot(PLUGIN_SETTINGS_ITEM_SLOT, {})
			});
		}
		/** The settings namespaces each variant's card and section use (host-side constants, mirrored for paths). */
		const VARIANT_STATUS = {
			workbuddy: WORKBUDDY_STATUS_PATH,
			"workbuddy-ai": WORKBUDDY_AI_STATUS_PATH
		};
		/**
		* Register card copy, the unified WorkBuddy card, and the sidebar quota cards.
		*
		* The entire body is wrapped so that a DSH slot-API breaking change (for
		* example the rc.6 to rc.7 `id` to `key` / `order` to `priority` rename) degrades
		* to a `console.error` instead of throwing into the DSH loader and raising
		* the red "Failed to load plugins" banner. The host provider keeps working:
		* the `workbuddy` model channel is unaffected, and `dsh-workbuddy-connect
		* status` reports host health via the heartbeat file.
		*
		* Card ORDER: the shared block dispatches its `list` entries by `order`
		* ascending, so the unified card keeps the seat the shared quota-settings card
		* held: session-prompt 10 / workbuddy 20 / qoder 30 — this card is 20.
		*
		* NOTE: the try/catch boundary of this function is mirrored (duplicated) in
		* `tests/client-fallback.spec.ts`, because the real client entry imports
		* browser-only DSH packages that cannot load in the Node test environment.
		* That test therefore does not import this function; it replicates its
		* shape. If you change the guarded body or the `console.error` message here,
		* update the mirrored `apply()` in that spec too, or the fallback test will
		* silently diverge from this real implementation.
		*/
		function apply(ctx) {
			try {
				const namespace = "settings.workbuddy";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-workbuddy-connect: settings copy");
				const t = ctx.locale.bind(namespace);
				let quotaScope;
				const adoptQuotaScope = (scope) => {
					if (scope === void 0) return;
					quotaScope = scope;
					const applySnapshot = () => {
						const value = scope.getSnapshot().value;
						setQuotaToggles(value?.sidebarQuotaCN === true, value?.sidebarQuotaAI === true);
						if (typeof value?.quotaPollMs === "number") setQuotaPollMs(value.quotaPollMs);
					};
					applySnapshot();
					scope.subscribe(applySnapshot);
				};
				const ownQuotaScope = new OwnQuotaSettingsScope();
				ownQuotaScope.load().catch(() => {});
				adoptQuotaScope(ownQuotaScope);
				/**
				* The unified card's inject face, shared by every surface that mounts it:
				* the shared 《插件设置》 block and this bundle's page in the sidebar's
				* Plugins panel. One factory keeps both of them reading the same live
				* values — the same scope, the same sign-in fact, the same `unified`
				* layout — so a save on either surface is a save for both, exactly as the
				* reference implementation does it.
				*
				* `defaultOpen` is the one per-surface difference: the Plugins-panel page
				* has room for the whole configuration, so that registration opens the
				* card at once; the settings block lists it collapsed. The fold state
				* stays the viewer's afterwards — the two surfaces do not share it.
				*/
				const unifiedCardInject = (defaultOpen = false) => ({
					t,
					scope: quotaScope,
					signedIn: () => quotaSignInState(),
					unified: true,
					defaultOpen
				});
				try {
					registerPluginSettings();
				} catch (error) {
					console.error("[dsh-workbuddy-connect] plugin settings block registration failed (host provider unaffected):", error);
				}
				/**
				* Register the same unified card on this bundle's page in the sidebar's
				* Plugins panel, beside its enable switch and component rows.
				*
				* `ctx.slots.inject` defers the factory until the Host's plugin manager
				* declares the seat (its `main` registration commits the child table), so
				* a deployment that ships no plugin manager — or loads it after this
				* bundle — never throws: the callback simply never runs, and the shared
				* 《插件设置》 block stays the single surface, exactly as before. The keyed
				* key is this package's name, the same key the page's configuration ledger
				* reads to decide whether the configuration section shows.
				*
				* Its own boundary mirrors the dashboard and footer-card ones: a slot-API
				* breaking change degrades to a console.error instead of taking the
				* settings block or the model channel with it.
				*/
				function joinPluginManagerBlock() {
					ctx.slots.inject(PLUGIN_MANAGER_SLOT, () => ctx.slots.register({
						name: PLUGIN_MANAGER_SLOT,
						key: PACKAGE_NAME,
						inject: () => unifiedCardInject(true)
					}, WorkBuddyPluginCard));
				}
				try {
					joinPluginManagerBlock();
				} catch (error) {
					console.error("[dsh-workbuddy-connect] plugin manager page registration failed (host provider unaffected):", error);
				}
				/**
				* Register this plugin's seat in the shared 《插件设置》 block.
				*
				* `settings.section` is a list slot owned by the settings shell, and a
				* slot's CHILDREN are declared exactly once, by one entry — so three
				* plugins cannot each create "their" block. They agree on one container
				* instead: entry id `plugin-settings`, which declares the child slot
				* `plugin-settings.item`, and each plugin contributes one card into that
				* child with its own package name as the entry id. The protocol:
				*
				* 1. wait for the shell to declare `settings.section`;
				* 2. probe whether a sibling already registered the `plugin-settings` entry;
				* 3. if so, attach this plugin's card to the sibling's container;
				* 4. otherwise register the container (which declares the child slot) and
				*    then attach to it — losing that race throws, and the loser takes
				*    step 3.
				*/
				function registerPluginSettings() {
					const registerItem = () => ctx.slots.register({
						name: PLUGIN_SETTINGS_ITEM_SLOT,
						id: PACKAGE_NAME,
						order: 20,
						inject: unifiedCardInject
					}, WorkBuddyPluginCard);
					/**
					* The merged backends' configuration card.
					*
					* A SEPARATE entry rather than more sections inside the WorkBuddy card:
					* that card belongs to the two WorkBuddy products, whose sign-in this
					* plugin performs itself. The merged backends are a different subject —
					* most of them cannot be configured here at all, because their credential
					* belongs to another application — and folding them into the WorkBuddy
					* card would present two unrelated kinds of thing under one heading.
					*/
					const registerBackendsItem = () => ctx.slots.register({
						name: PLUGIN_SETTINGS_ITEM_SLOT,
						id: PACKAGE_NAME + "-backends",
						order: 21,
						inject: () => ({})
					}, BackendsCard);
					/** Both of this plugin's cards in the shared block, in render order. */
					const registerItems = () => [registerItem(), registerBackendsItem()];
					ctx.slots.inject("settings.section", () => {
						if (ctx.slots.entries("settings.section").some((entry) => entry.options?.id === PLUGIN_SETTINGS_SECTION_ID)) return registerItems();
						try {
							return [ctx.slots.register({
								name: "settings.section",
								id: PLUGIN_SETTINGS_SECTION_ID,
								order: 900,
								label: () => "插件设置",
								children: { [PLUGIN_SETTINGS_ITEM_SLOT]: {
									kind: "list",
									scope: "root"
								} }
							}, PluginSettingsSection), ...registerItems()];
						} catch {
							return registerItems();
						}
					});
				}
				const QUOTA_PANEL_ID = "workbuddy-quota-panel";
				const CONVERSATION_PANEL_ID = "conversation";
				const dashboardDocuments = {
					cn: void 0,
					ai: void 0
				};
				let dashboardFetchedAt;
				let dashboardLoading = false;
				let dashboardRequestedPath = WORKBUDDY_STATUS_PATH;
				/** Whether the dashboard is the CURRENT center panel (its mount owns this). */
				let quotaPanelOpen = false;
				const dashboardListeners = /* @__PURE__ */ new Set();
				/**
				* The observable source the dashboard reads through the inject face's
				* `hooks` compartment. The renderer caches an inject face ONCE per entry
				* and SPREADS it into props — a face getter is read exactly once and
				* frozen, which is why face-carried documents/activePath went stale. The
				* hooks channel survives: `bindInjectSources` converts each hooks member
				* into a `use<Name>` selector hook, and the hook reads the CURRENT
				* snapshot on every render (the same mechanism commandcode's usage store
				* rides).
				*
				* STABILITY CONTRACT: useSyncExternalStore requires getSnapshot() to
				* return the SAME reference between changes — a fresh object per call
				* re-renders forever and React kills the entry (error #185, the same
				* class of crash the settings card's unstable projection caused). So the
				* snapshot is a CACHED object, replaced wholesale by publish(); every
				* mutator builds the next snapshot and publishes exactly once.
				*/
				let dashboardSnap = {
					documents: [void 0, void 0],
					fetchedAt: void 0,
					loading: false,
					activePath: WORKBUDDY_STATUS_PATH
				};
				const rebuildSnapshot = () => {
					const next = {
						documents: [dashboardDocuments.cn, dashboardDocuments.ai],
						fetchedAt: dashboardFetchedAt,
						loading: dashboardLoading,
						activePath: dashboardRequestedPath
					};
					if (JSON.stringify(next) !== JSON.stringify(dashboardSnap)) {
						dashboardSnap = next;
						for (const listener of dashboardListeners) listener();
					}
				};
				const dashboardSource = {
					getSnapshot: () => dashboardSnap,
					subscribe: (listener) => {
						dashboardListeners.add(listener);
						return () => {
							dashboardListeners.delete(listener);
						};
					}
				};
				const notifyDashboard = () => {
					rebuildSnapshot();
				};
				/**
				* Refresh ONE variant's document (the one the panel is showing) — not
				* both. The earlier version fetched both routes on every panel mount, so
				* clicking the CN card also refreshed the AI card's data and timestamp;
				* the user ruled each click refreshes only what it shows.
				*
				* Freshness rule (also the user's): if the shared document for THIS
				* variant is newer than the configured interval, the fetch is SKIPPED —
				* a click shows the cached numbers instead of re-billing upstream. A
				* variant with NO result yet always fetches. A manual Refresh click
				* (force=true) bypasses the freshness check: an explicit user action
				* always re-reads.
				*/
				const refreshDashboard = async (options = {}) => {
					if (dashboardLoading) return;
					const variantId = variantOfStatusPath(dashboardRequestedPath);
					if (options.force !== true && quotaStatusIsFresh(variantId, quotaPollMs())) return;
					dashboardLoading = true;
					rebuildSnapshot();
					try {
						const result = await (variantId === "workbuddy" ? fetchStatusDocument(WORKBUDDY_STATUS_PATH) : fetchStatusDocument(WORKBUDDY_AI_STATUS_PATH));
						if (result !== void 0) noteQuotaStatus(variantId, result);
						dashboardFetchedAt = Date.now();
					} finally {
						dashboardLoading = false;
						rebuildSnapshot();
					}
				};
				let dashboardTimer;
				const startDashboardPoll = () => {
					if (dashboardTimer !== void 0) return;
					refreshDashboard();
					dashboardTimer = window.setInterval(() => {
						if (document.hidden) return;
						refreshDashboard();
					}, Math.max(6e4, quotaPollMs()));
				};
				const stopDashboardPoll = () => {
					if (dashboardTimer === void 0) return;
					window.clearInterval(dashboardTimer);
					dashboardTimer = void 0;
				};
				async function fetchStatusDocument(path) {
					try {
						const response = await fetch(path, { headers: { accept: "application/json" } });
						const body = await response.json();
						return response.ok && isWorkBuddyWebStatus(body) ? body : void 0;
					} catch {
						return;
					}
				}
				function QuotaDashboardWithLifecycle(props) {
					(0, react.useEffect)(() => {
						quotaPanelOpen = true;
						startDashboardPoll();
						return () => {
							quotaPanelOpen = false;
							stopDashboardPoll();
						};
					}, []);
					return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaDashboard, { ...props });
				}
				const panelFace = () => ({
					hooks: { quotaDashboard: dashboardSource },
					t,
					statusPaths: [WORKBUDDY_STATUS_PATH, WORKBUDDY_AI_STATUS_PATH],
					refresh: () => {
						refreshDashboard({ force: true });
					},
					onVariantPicked: (path) => {
						dashboardRequestedPath = path;
						notifyDashboard();
						refreshDashboard();
					},
					close: () => {
						const layout = ctx.get("layout");
						if (typeof layout?.selectPanel !== "function") return;
						try {
							layout.selectPanel(null);
						} catch {
							try {
								layout.selectPanel(CONVERSATION_PANEL_ID);
							} catch (error) {
								console.error("[dsh-workbuddy-connect] could not close the quota panel:", error);
							}
						}
					}
				});
				ctx.effect(() => injectQuotaCss(), "dsh-workbuddy-connect: quota styles");
				ctx.effect(() => injectBackendsCss(), "dsh-workbuddy-connect: backend card styles");
				try {
					ctx.slots.inject("main", () => ctx.slots.register({
						name: "main",
						key: QUOTA_PANEL_ID,
						locale: "panel.workbuddy-quota",
						inject: panelFace
					}, QuotaDashboardWithLifecycle));
				} catch (error) {
					console.error("[dsh-workbuddy-connect] could not register the quota dashboard:", error);
				}
				ctx.inject(["layout"], (layoutCtx) => {
					if (typeof layoutCtx.get("layout")?.selectPanel !== "function") return;
					try {
						for (const variant of CARD_VARIANTS) {
							const statusPath = VARIANT_STATUS[variant.id];
							if (statusPath === void 0) continue;
							const injected = {
								t,
								statusPath,
								open: () => {
									const current = layoutCtx.get("layout");
									if (typeof current?.selectPanel !== "function") return;
									if (quotaPanelOpen && dashboardRequestedPath === statusPath) {
										current.selectPanel(null);
										return;
									}
									dashboardRequestedPath = statusPath;
									notifyDashboard();
									refreshDashboard();
									current.selectPanel(QUOTA_PANEL_ID);
								}
							};
							layoutCtx.slots.inject("sidebar.footer.action", () => layoutCtx.slots.register({
								name: "sidebar.footer.action",
								id: variant.id === "workbuddy" ? "workbuddy-quota" : "workbuddy-quota-ai",
								order: variant.id === "workbuddy" ? 20 : 21,
								locale: "panel.workbuddy-quota",
								inject: () => injected
							}, SidebarQuotaCard));
						}
					} catch (error) {
						console.error("[dsh-workbuddy-connect] could not register the sidebar footer card:", error);
					}
				});
				ctx.inject(["layout"], (layoutCtx) => {
					const openUsage = () => {
						const layout = layoutCtx.get("layout");
						if (typeof layout?.selectPanel !== "function") return;
						layout.selectPanel(USAGE_PANEL_ID);
					};
					const closeUsage = () => {
						const layout = layoutCtx.get("layout");
						if (typeof layout?.selectPanel !== "function") return;
						try {
							layout.selectPanel(null);
						} catch {
							try {
								layout.selectPanel(CONVERSATION_PANEL_ID);
							} catch (error) {
								console.error("[dsh-workbuddy-connect] could not close the usage panel:", error);
							}
						}
					};
					try {
						registerUsagePanel(layoutCtx, {
							panelId: USAGE_PANEL_ID,
							close: closeUsage
						});
					} catch (error) {
						console.error("[dsh-workbuddy-connect] could not register the usage panel:", error);
					}
					try {
						layoutCtx.slots.inject("sidebar.footer.action", () => layoutCtx.slots.register({
							name: "sidebar.footer.action",
							id: "workbuddy-usage",
							order: 22,
							locale: "panel.workbuddy-quota",
							inject: () => ({ open: openUsage })
						}, UsageEntryButton));
					} catch (error) {
						console.error("[dsh-workbuddy-connect] could not register the usage entry:", error);
					}
				});
				ctx.inject(["modelDirectories"], (scope) => {
					scope.slots.inject("conversation.input.right", () => scope.slots.register({
						name: "conversation.input.right",
						id: "workbuddy-probe",
						order: 10,
						inject: (sessionId) => ({
							directory: scope.modelDirectories.directoryFor(sessionId).store,
							t
						})
					}, WorkBuddyProbeControl));
				});
			} catch (error) {
				console.error("[dsh-workbuddy-connect] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
