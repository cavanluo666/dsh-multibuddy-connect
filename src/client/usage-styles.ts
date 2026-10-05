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
export const USAGE_CSS_ID = 'dsh-workbuddy-connect/UsagePanel.module.css'

/** Install the stylesheet once; returns its disposer. */
export function injectUsageCss(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin-css="${USAGE_CSS_ID}"]`) !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-workbuddy-connect'
  tag.dataset.pluginCss = USAGE_CSS_ID
  tag.textContent = USAGE_CSS
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}

/** The usage dashboard stylesheet. */
export const USAGE_CSS = `
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
`
