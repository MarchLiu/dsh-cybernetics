// Offline harness test for dsh-cybernetics v0.25.6: the「目标 / Goal」tab
// renders goal content (objective / subgoal) through the host's Markdown
// primitive (`@deepseek-ai/dsh-client-ui-primitives` → MarkdownText) instead
// of a plain div, so headings, lists and code blocks read like Markdown.
//
// Covers:
//  (1) locale parity: the six `md.*` chrome keys exist on both zh and en,
//  (2) SingleGoalView renders a Markdown objective through MarkdownText with
//      text + labels (code chrome + footnotes) and keeps badge/meta/hint,
//  (3) GoalRow renders the subgoal text through MarkdownText inside the
//      「当前子目标」 line,
//  (4) a host without a MarkdownText primitive (MarkdownText: null) falls back
//      to the pre-markdown plain div — no throw, same text.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const clientSrc = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

// --- (1) locale parity --------------------------------------------------------
const zhKeys = [...clientSrc.matchAll(/'((?:md|goal)\.[a-zA-Z.]+)':/g)].map((m) => m[1])
// crude per-dict extraction: the zh dict comes first, en second.
const firstHalf = clientSrc.slice(0, clientSrc.indexOf("'Current subgoal'"))
const secondHalf = clientSrc.slice(clientSrc.indexOf("'Current subgoal'"))
const mdKey = (s) => [...s.matchAll(/'(md\.[a-zA-Z]+)':/g)].map((m) => m[1])
const zhMd = mdKey(firstHalf)
const enMd = mdKey(secondHalf)
assert.deepEqual(zhMd.sort(), enMd.sort(), 'zh/en md.* key parity')
for (const k of ['md.copy', 'md.copied', 'md.code', 'md.wrap', 'md.unwrap', 'md.footnotes']) {
  assert.ok(zhMd.includes(k), 'zh has ' + k)
}

// --- recording jsx harness (same contract as v18) ------------------------------
function boot(markdownText) {
  const rendered = []
  globalThis.window = globalThis.window || {}
  let loadedModule
  globalThis.window.__ModuleLoader__ = { load(def) { loadedModule = def } }
  return (async () => {
    const modUrl = new URL('../lib/client.js?boot=' + Math.random().toString(36).slice(2), import.meta.url).href
    await import(modUrl)
    assert.ok(loadedModule, 'client module registered')
    function record(type, props) {
      const node = { type, props: props ?? {} }
      rendered.push(node)
      if (typeof type === 'function') node.result = type(node.props)
      return node.result !== undefined ? node.result : node
    }
    const jsxRuntime = { jsx: record, jsxs: record }
    const react = {
      useState: (v) => [v, () => {}],
      useEffect: () => {},
      useSyncExternalStore: (subscribe, getSnapshot) => { return getSnapshot() },
    }
    const mod = loadedModule.factory((id) => {
      if (id === 'react') return react
      if (id === 'react/jsx-runtime') return jsxRuntime
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: markdownText }
      throw new Error('unexpected require: ' + id)
    })
    const dicts = { zh: {}, en: {} }
    const seats = []
    const ctx = {
      effect: (fn) => fn(),
      locale: {
        register: (_ns, dictionaries) => {
          Object.assign(dicts.zh, dictionaries.zh ?? {})
          Object.assign(dicts.en, dictionaries.en ?? {})
        },
        bind: () => t,
      },
      slots: {
        inject: (name, fn) => seats.push({ name, seat: fn() }),
        register: (spec, component) => { spec.__component = component; return spec },
      },
      sessions: {
        binding: () => ({ session: { projections: { faceOf: () => ({ subscribe: () => () => {}, getSnapshot: () => undefined }) } } }),
      },
      uiWorkspace: { openSession: () => {} },
      configForms: { get: () => undefined, whileServed: (_ns, register) => { register(new Set()); return () => {} } },
    }
    mod.apply(ctx)
    const goalSeat = seats.find((entry) => entry.name === 'conversation.view' && entry.seat.id === 'cybernetics-goal')
    assert.ok(goalSeat, 'goal tab seat registered')
    const GoalView = goalSeat.seat.__component

    function t(key, params) {
      if (!params) return key
      return key + ' ' + Object.keys(params).map((k) => k + '=' + String(params[k])).join(' ')
    }
    const face = (snapshot) => ({ subscribe: () => () => {}, getSnapshot: () => snapshot })
    function render(props) {
      rendered.length = 0
      const tree = GoalView(props)
      return { tree, nodes: rendered.slice() }
    }
    function textOf(node) {
      const out = []
      const walk = (value) => {
        if (value === null || value === undefined || typeof value === 'boolean') return
        if (typeof value === 'string' || typeof value === 'number') { out.push(String(value)); return }
        if (Array.isArray(value)) { for (const v of value) walk(v); return }
        if (value && value.props && value.props.children !== undefined) walk(value.props.children)
      }
      if (node !== null && node !== undefined && typeof node === 'object' && node.props) walk(node.props.children)
      return out.join('\n')
    }
    return { render, textOf, t, face, dicts }
  })()
}

const MARKDOWN = '# 目标\n\n- 第一步\n- 第二步\n\n```js\nconsole.log("hi")\n```'

// --- (2) + (3): MarkdownText path ---------------------------------------------
const markdownTexts = []
function MarkdownText(props) { markdownTexts.push(props); return { type: 'div', props: { 'data-markdown': 'true', children: props.text } } }
const md = await boot(MarkdownText)

{
  // SingleGoalView: markdown objective
  const { render, textOf, face } = md
  const out = render({
    t: md.t,
    goals: face({ goals: [] }),
    goal: face({ current: { goal: { objective: MARKDOWN, phase: 'active' }, roundsStarted: 2 } }),
    sessionId: 's1',
    open: () => {},
  })
  const mdNodes = out.nodes.filter((n) => n.type === MarkdownText)
  assert.equal(mdNodes.length, 1, 'SingleGoalView renders one MarkdownText')
  assert.equal(mdNodes[0].props.text, MARKDOWN, 'objective text passed through')
  const labels = mdNodes[0].props.labels
  assert.equal(labels.code.copyLabel, 'md.copy', 'code chrome labels present')
  assert.equal(labels.code.toolbarLabels.codeLabel, 'md.code')
  assert.equal(labels.footnotes, 'md.footnotes')
  assert.ok(textOf(out.tree).includes('rounds'), 'meta line kept')
  assert.ok(textOf(out.tree).includes('loopHint'), 'hint kept')
}

{
  // GoalRow: markdown subgoal
  const { render, face } = md
  markdownTexts.length = 0
  const out = render({
    t: md.t,
    goals: face({ goals: [{
      goalId: 'g1', title: 'Goal g1', objective: MARKDOWN, subgoal: '## 子目标\n1. 采集\n2. 验证',
      status: 'running', depth: 'full', executor: 'ephemeral', round: 1, updatedAt: 1, agents: [],
    }] }),
    goal: face(undefined),
    sessionId: 's1',
    open: () => {},
  })
  const mdNodes = out.nodes.filter((n) => n.type === MarkdownText)
  assert.equal(mdNodes.length, 1, 'GoalRow renders one MarkdownText for the subgoal')
  assert.ok(mdNodes[0].props.text.includes('子目标'), 'subgoal text passed through')
}

// --- (4): fallback path (MarkdownText: null) -----------------------------------
const fb = await boot(null)
{
  const { render, textOf, face } = fb
  const out = render({
    t: fb.t,
    goals: face({ goals: [] }),
    goal: face({ current: { goal: { objective: MARKDOWN, phase: 'active' }, roundsStarted: 0 } }),
    sessionId: 's1',
    open: () => {},
  })
  assert.equal(out.nodes.filter((n) => n.type === MarkdownText).length, 0, 'no MarkdownText without the primitive')
  assert.ok(textOf(out.tree).includes('# 目标'), 'objective text still rendered (plain div fallback)')
  assert.ok(!textOf(out.tree).includes('noGoal'), 'no empty-state text when an objective exists')
}

console.log('✓ v0.25.6 goal content renders through MarkdownText (objective + subgoal) with code/footnote labels; plain-div fallback keeps the text when the primitive is absent')
