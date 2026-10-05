/* eslint-disable @typescript-eslint/no-explicit-any */
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyPluginCard, type WorkBuddyPluginCardProps } from '../src/client/WorkBuddyPluginCard.tsx'
import { QuotaSettingsContent } from '../src/client/QuotaSettingsCard.tsx'
import { SidebarQuotaCard } from '../src/client/SidebarQuotaCard.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { WorkBuddySettingsKey } from '../src/client/locales.ts'
import { noteQuotaSignIn, noteQuotaStatus, setQuotaToggles } from '../src/client/quota-settings-store.ts'
import {
  WORKBUDDY_AI_LOGIN_PATH,
  WORKBUDDY_AI_STATUS_PATH,
  WORKBUDDY_LOGIN_PATH,
  WORKBUDDY_STATUS_PATH,
} from '../src/status-paths.ts'
import type { WorkBuddyWebStatus } from '../src/status-paths.ts'

/**
 * The unified WorkBuddy settings card, mirroring dsh-qoder-connect's
 * 8f2063d (one card: quota settings + a segmented variant switcher) and
 * e890abb (defense in depth: no surface may enable or open a quota display
 * for an account nobody is signed into).
 */

const t = (key: WorkBuddySettingsKey, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

/** One card body, expanded: header first, then quota switches, then variant tabs. */
async function expand(view: ReactTestRenderer): Promise<void> {
  const header = view.root.findAllByType('button')[0]!
  await act(async () => { header.props.onClick() })
}

function switches(view: ReactTestRenderer): any[] {
  return view.root.findAll(node => node.props.role === 'switch')
}

function variantTabs(view: ReactTestRenderer): any[] {
  const list = view.root.find(
    n => n.props.role === 'tablist' && n.props['aria-label'] === 'WorkBuddy Version Selection',
  )
  return list.findAllByType('button')
}

describe('unified WorkBuddy plugin card', () => {
  let view: ReactTestRenderer | undefined
  const request = vi.fn()

  /** The document served for one status route on the next read. */
  const docs: { cn: Record<string, unknown>; ai: Record<string, unknown> } = {
    cn: { status: 'signed-in', nickname: 'cn-user', credits: { total: 100, accounts: [] }, models: [] },
    ai: { status: 'signed-out', loginKey: 'ai-login-key' },
  }

  beforeEach(() => {
    docs.cn = { status: 'signed-in', nickname: 'cn-user', credits: { total: 100, accounts: [] }, models: [] }
    docs.ai = { status: 'signed-out', loginKey: 'ai-login-key' }
    request.mockReset().mockImplementation(async (url: string) => {
      const path = String(url)
      if (path === WORKBUDDY_STATUS_PATH) return { ok: true, status: 200, json: async () => docs.cn }
      if (path === WORKBUDDY_AI_STATUS_PATH) return { ok: true, status: 200, json: async () => docs.ai }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      open: () => null,
    })
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })
  })

  afterEach(() => {
    act(() => view?.unmount())
    view = undefined
    // The store is module state: a leaked toggle or sign-in fact would decide
    // the next test's expectations instead of this one's setup.
    setQuotaToggles(false, false)
    noteQuotaSignIn('workbuddy', false)
    noteQuotaSignIn('workbuddy-ai', false)
    vi.unstubAllGlobals()
  })

  function mount(props: Record<string, unknown>): Promise<void> {
    return act(async () => {
      view = create(createElement(WorkBuddyPluginCard, props as unknown as WorkBuddyPluginCardProps))
    })
  }

  const quotaScope = (set = vi.fn(), value: Record<string, unknown> = {}) => ({
    getSnapshot: () => ({
      status: 'ready' as const,
      writable: true,
      value: { sidebarQuotaCN: false, sidebarQuotaAI: false, quotaPollMs: 300_000, ...value },
    }),
    subscribe: () => () => {},
    set,
  })

  it('names the collapsed card with the unified title and intro', async () => {
    await mount({ t, unified: true, scope: quotaScope(), signedIn: () => ({ cn: true, ai: false }) })
    const json = JSON.stringify(view!.toJSON())
    expect(json).toContain(en.unifiedTitle)
    expect(json).toContain(en.unifiedIntro)
    // A variant's own intro must not appear: the unified card owns both, and
    // the collapsed header states that once.
    expect(json).not.toContain(en.introAI)
  })

  it('expands to quota settings first, then the variant tabs', async () => {
    await mount({ t, unified: true, scope: quotaScope(), signedIn: () => ({ cn: true, ai: false }) })
    await expand(view!)
    const json = JSON.stringify(view!.toJSON())
    // 1. The embedded sidebar-display settings. The card's own title belongs
    // to the standalone shell, so the content is proved by its rows.
    expect(json).toContain(en.quotaToggleCN)
    expect(json).toContain(en.quotaToggleAI)
    expect(json).toContain(en.quotaPollLabel)
    // 2. The segmented switcher, labelled in both languages' terms.
    expect(json).toContain(en.variantTabCN)
    expect(json).toContain(en.variantTabAI)
    // 3. CN is the default segment, and it shows the CN account.
    expect(json).toContain(t('signedInAs', { nickname: 'cn-user' }))
  })

  it('switches the body between the CN and AI variants', async () => {
    await mount({ t, unified: true, scope: quotaScope(), signedIn: () => ({ cn: true, ai: false }) })
    await expand(view!)

    const tabs = variantTabs(view!)
    expect(tabs).toHaveLength(2)

    await act(async () => { tabs[1]!.props.onClick() })
    let json = JSON.stringify(view!.toJSON())
    // The AI segment shows the AI account, not the CN one that was on screen.
    expect(json).toContain(en.signedOutHintAI)
    expect(json).not.toContain('cn-user')

    await act(async () => { tabs[0]!.props.onClick() })
    json = JSON.stringify(view!.toJSON())
    expect(json).toContain(t('signedInAs', { nickname: 'cn-user' }))
  })

  it('disables both quota switches while neither variant is signed in', async () => {
    await mount({ t, unified: true, scope: quotaScope(), signedIn: () => ({ cn: false, ai: false }) })
    await expand(view!)

    const [cn, ai] = switches(view!)
    expect(cn!.props.disabled).toBe(true)
    expect(ai!.props.disabled).toBe(true)
  })

  it('never writes an enabled toggle for a signed-out variant', async () => {
    const set = vi.fn()
    await mount({ t, unified: true, scope: quotaScope(set), signedIn: () => ({ cn: false, ai: false }) })
    await expand(view!)

    // A direct handler call is the attack this guards: the switch is rendered
    // disabled, so nothing but the component's own gate can reach the write.
    await act(async () => {
      for (const row of switches(view!)) row.props.onClick()
    })
    expect(set).not.toHaveBeenCalled()
  })

  it('drops an optimistic sign-in fact once the account has signed out', async () => {
    // The shared store says CN is in (a fact left over from an earlier poll),
    // but the document now on screen says it is out. The gate follows the
    // document, because that is the account the sidebar card could display.
    noteQuotaSignIn('workbuddy', true)
    docs.cn = { status: 'signed-out', loginKey: 'cn-login-key' }
    const set = vi.fn()
    await mount({ t, unified: true, scope: quotaScope(set) })
    await expand(view!)

    const cn = switches(view!)[0]!
    expect(cn.props.disabled).toBe(true)
    await act(async () => { cn.props.onClick() })
    expect(set).not.toHaveBeenCalled()
  })

  it('enables the CN switch as soon as a credential is adopted', async () => {
    // CN starts out signed in; the import above is what the gate reacts to, so
    // the fetch must not hand the card a session it did not earn.
    let adopted = false
    request.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = String(url)
      if (init?.method === 'POST' && path === WORKBUDDY_LOGIN_PATH) {
        adopted = true
        return { ok: true, status: 200, json: async () => ({ status: 'imported', nickname: 'cn-user' }) }
      }
      if (path === WORKBUDDY_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => adopted ? ({
            status: 'signed-in',
            nickname: 'cn-user',
            loginKey: 'cn-login-key',
            credits: { total: 100, accounts: [] },
            models: [],
          }) : ({ status: 'signed-out', loginKey: 'cn-login-key' }),
        }
      }
      if (path === WORKBUDDY_AI_STATUS_PATH) {
        return { ok: true, status: 200, json: async () => ({ status: 'signed-out', loginKey: 'ai-login-key' }) }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })
    // No `signedIn` prop: the card must learn CN is signed in on its own.
    await mount({ t, unified: true, scope: quotaScope() })
    await expand(view!)

    expect(switches(view!)[0]!.props.disabled).toBe(true)

    const file = { text: async () => '{}' } as unknown as File
    const input = view!.root.find(n => n.type === 'input' && n.props.type === 'file')
    await act(async () => {
      input.props.onChange({ target: { files: [file], value: '' } })
    })

    expect(switches(view!)[0]!.props.disabled).toBe(false)
  })

  it('renders a context-window row as one line: the window and its note side by side', async () => {
    // The 1M / 默认 300K case: with the maximum selected, the row's right cell
    // carries BOTH figures. They must sit on one line, not stacked — a stacked
    // pair reads as two separate models.
    docs.cn = {
      status: 'signed-in',
      nickname: 'cn-user',
      credits: { total: 100, accounts: [] },
      models: [{
        id: 'hy4-preview',
        name: 'Hy4 preview',
        contextWindow: 1_000_000,
        defaultContextWindow: 300_000,
      }],
    }
    await mount({ t, unified: true, scope: quotaScope(), signedIn: () => ({ cn: true, ai: false }) })
    await expand(view!)
    // The figure lives in the 'context' tab, so visit it. A section tab's only
    // child is its label, matched directly — stringify a test instance and
    // react-test-renderer walks into its Fiber, which is circular.
    const contextTab = view!.root
      .findAll(n => n.props.role === 'tab')
      .find(tab => tab.props.children === en.tabContext)!
    await act(async () => { contextTab.props.onClick() })

    const json = JSON.stringify(view!.toJSON())
    expect(json).toContain('1M')
    expect(json).toContain(t('contextDefault', { size: '300K' }))

    const cells = view!.root.findAll(
      n => n.props.style?.justifyContent === 'flex-end' && n.type === 'span',
    )
    expect(cells.length).toBe(1)
    const cell = cells[0]!
    const figures = (Array.isArray(cell.props.children) ? cell.props.children : [cell.props.children])
      .filter((child: any) => child !== null && child !== undefined)
    // 横向：容器不再是 column，数值也不再靠 textAlign 自己撑右。
    expect(cell.props.style.flexDirection).toBeUndefined()
    expect(figures[0].props.children).toBe('1M')
    expect(figures[0].props.style?.textAlign).toBeUndefined()
  })

  it('keeps the standalone quota card working without a sign-in reader', async () => {
    let standalone: ReactTestRenderer | undefined
    await act(async () => {
      standalone = create(createElement(QuotaSettingsContent, { t, scope: quotaScope() } as any))
    })
    const found = switches(standalone!)
    expect(found.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(standalone!.toJSON())).toContain(en.quotaToggleAI)
    act(() => standalone?.unmount())
  })

  it('carries the unified copy in both languages', () => {
    const keys = ['unifiedTitle', 'unifiedIntro', 'variantTabCN', 'variantTabAI'] as const
    for (const key of keys) {
      expect(en[key]).toBeTruthy()
      expect(zh[key]).toBeTruthy()
    }
    // The switcher reads as the two products, not as two feature names.
    expect(zh.variantTabCN).toBe('国内版')
    expect(zh.variantTabAI).toBe('国际版')
  })

  describe('sidebar cards stay inert when signed out', () => {
    const mountSidebar = async (statusPath: string, open: () => void, wide: boolean): Promise<ReactTestRenderer> => {
      let card: ReactTestRenderer | undefined
      await act(async () => {
        card = create(createElement(SidebarQuotaCard, { t, statusPath, open, wide } as any))
      })
      return card!
    }

    /** Serve one variant's route as signed out; every other read as signed out too. */
    const answerBoth = (cn: Record<string, unknown>): void => {
      request.mockImplementation(async (url: string) => {
        const path = String(url)
        if (path === WORKBUDDY_STATUS_PATH) return { ok: true, status: 200, json: async () => cn }
        return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
      })
    }

    it('blocks the rail and footer clicks, and opens once signed in', async () => {
      setQuotaToggles(true, true)
      // The card polls on mount and publishes what it reads, so the mock and
      // the store must tell the same story — otherwise the first fetch quietly
      // signs the variant back in and the gate under test never engages.
      answerBoth({ status: 'signed-out' })
      noteQuotaStatus('workbuddy', { status: 'signed-out' } as WorkBuddyWebStatus)
      noteQuotaSignIn('workbuddy', false)
      const open = vi.fn()

      const wide = await mountSidebar(WORKBUDDY_STATUS_PATH, open, true)
      const foot = wide.root.findByProps({ className: 'wbp-foot' })
      expect(foot.props.disabled).toBe(true)
      await act(async () => { foot.props.onClick() })
      expect(open).not.toHaveBeenCalled()
      act(() => wide.unmount())

      const rail = await mountSidebar(WORKBUDDY_STATUS_PATH, open, false)
      const railButton = rail.root.findByProps({ className: 'wbp-railButton' })
      expect(railButton.props.disabled).toBe(true)
      await act(async () => { railButton.props.onClick() })
      expect(open).not.toHaveBeenCalled()
      act(() => rail.unmount())

      // Signed in, the same click opens the dashboard.
      answerBoth({ status: 'signed-in', credits: { total: 100, accounts: [] }, models: [] })
      noteQuotaStatus('workbuddy', {
        status: 'signed-in',
        credits: { total: 100, accounts: [] },
      } as unknown as WorkBuddyWebStatus)
      noteQuotaSignIn('workbuddy', true)
      const signedIn = await mountSidebar(WORKBUDDY_STATUS_PATH, open, true)
      const enabled = signedIn.root.findByProps({ className: 'wbp-foot' })
      expect(enabled.props.disabled).toBe(false)
      await act(async () => { enabled.props.onClick() })
      expect(open).toHaveBeenCalledTimes(1)
      act(() => signedIn.unmount())
    })
  })
})
