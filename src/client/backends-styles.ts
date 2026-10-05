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
export const BACKENDS_CSS_ID = 'dsh-workbuddy-connect/BackendsCard.module.css'

/** Install the stylesheet once; returns its disposer. */
export function injectBackendsCss(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin-css="${BACKENDS_CSS_ID}"]`) !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-workbuddy-connect'
  tag.dataset.pluginCss = BACKENDS_CSS_ID
  tag.textContent = BACKENDS_CSS
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}

/** The multi-backend configuration card stylesheet. */
export const BACKENDS_CSS = `
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
`
