/**
 * SlotMap merge for the quota panel's two seats — a structural re-statement of
 * commandcode's `panel-slots.ts`, which does the same for its own panel: the
 * layout's keyed `main` seat and the sidebar's footer-action list are declared
 * by packages this plugin does not depend on, so the slots are re-declared
 * here to make them type-check. Import this module (for its side effect) in
 * any file that registers or renders into either seat.
 *
 * The declarations must stay STRUCTURALLY IDENTICAL to upstream's: when a peer
 * package ships its own merge, a duplicate conflicting member would fail
 * compilation — the guard against drift.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The layout's center-column panel registry. Declared by
     * `@deepseek-ai/dsh-client-ui-layout` (not a dependency of this bundle);
     * the sidebar footer card's `open()` selects a key from this registry.
     */
    'main': { kind: 'keyed'; scope: 'root' }
    /**
     * The sidebar-foot action list, rendered inside the foot area directly
     * ABOVE the Settings seat (`footArea` renders `footerActions` then
     * `settingsArea`). Declared by `@deepseek-ai/dsh-client-ui-sidebar`; the
     * owner passes only the column state.
     */
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
    /**
     * One plugin's card inside the shared 《插件设置》 block (DSH 0.1.7, where
     * the Plugins page's own `settings.plugin.item` seat no longer exists).
     *
     * Not declared by any host package: the CONTAINER entry declares it, and
     * whichever of the connect plugins registers the container first is that
     * container (see the container/back-off protocol in `./index.tsx`). Every
     * plugin then contributes one entry whose `id` is its package name, so the
     * blocks never collide. Restated here because the child key has to exist in
     * `SlotMap` for the container's `renderSlot` call to type-check.
     */
    'plugin-settings.item': { kind: 'list'; scope: 'root' }
  }
}

/** Owner share of a sidebar footer action: only the column display state. */
export interface SidebarFooterActionOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}
