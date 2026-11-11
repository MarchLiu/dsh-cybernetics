// Offline harness test for dsh-cybernetics v0.18.1 (updated v0.18.3): the
//「对话 / Conversation」entry at the top of the「目标 / Goal」tab content (and
// the「控制 / Control」tab). v0.18.3 turned it into a「回到主对话 / home」
// navigation: on the ROOT session it stays a one-step view switch through the
// conversation.view owner-prop seam props.openView('chat', 'cybernetics-home')
// (the host's chat view id is the constant 'chat'); from a CHILD session the
// cross-session leg is covered by test/v20-home-entry.mjs. The root-session
// path here has no session list (or a list that says "already root"), which is
// exactly the one-step branch. SPA-only: no reload, no URL change, no new
// session, no server API.
//
// Covers:
//   (1) locale parity: zh/en dictionaries carry the same key set; the two
//       v0.18.1 keys exist on both sides with the exact (v0.18.3) copy,
//   (2) multi-goal (self board): the entry renders as the FIRST child with the
//       zh copy, native button semantics, and clicking invokes openView
//       ('chat', 'cybernetics-home') exactly once,
//   (3) English locale: same entry with the English copy,
//   (4) guard: without the openView owner prop the entry is NOT rendered and
//       nothing throws — the goal rows keep the pre-v0.18.1 prop/child shape,
//   (5) single-goal branch: entry present above the goal,
//   (6) empty board fallback: entry present above the dimmed no-goal text,
//   (7) projections in flight (both faces empty, single undefined): the entry
//       still renders alone and stays clickable,
//   (8) ancestor board (v0.18): entry above the subagent-board banner,
//   (9) control tab: entry present, click invokes openView('chat',
//       'cybernetics-home'); without openView the agent tree still renders,
//   (10) coexistence: with the entry visible the goal rows/chips render exactly
//       as before (goal data and layout untouched by the feature).
// Run: node test/v19-conversation-entry.mjs

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// --- recording jsx harness ---------------------------------------------------
// Same contract as test/v14-goal-agents.mjs / test/v18-subagent-goal-board.mjs:
// function components are invoked immediately (depth first), so the tree is
// assertable offline.
const rendered = []
globalThis.window = globalThis.window || {}
let loadedModule
globalThis.window.__ModuleLoader__ = {
  load(def) { loadedModule = def },
}
await import('../lib/client.js')
assert.ok(loadedModule, 'client module registered with the ModuleLoader')

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
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const mod = loadedModule.factory((id) => {
  if (id === 'react') return react
if (id === 'react/jsx-runtime') return jsxRuntime
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: null }
  throw new Error('unexpected require: ' + id)
})

// --- fake host ctx -----------------------------------------------------------
const dicts = { zh: {}, en: {} }
const seats = []
const ctx = {
  effect: (fn) => fn(),
  locale: {
    register: (_ns, dictionaries) => {
      Object.assign(dicts.zh, dictionaries.zh ?? {})
      Object.assign(dicts.en, dictionaries.en ?? {})
    },
    bind: () => (key, params) => {
      let s = dicts.zh[key]
      if (typeof s !== 'string') return key
      if (params) {
        for (const [k, v] of Object.entries(params)) s = s.replaceAll('{' + k + '}', String(v))
      }
      return s
    },
  },
  slots: {
    inject: (name, fn) => seats.push({ name, seat: fn() }),
    register: (spec, component) => { spec.__component = component; return spec },
  },
  sessions: {
    binding: () => ({
      session: { projections: { faceOf: () => ({ subscribe: () => () => {}, getSnapshot: () => undefined }) } },
    }),
    list: {
      subscribe: () => () => {},
      getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: {} }),
    },
  },
  uiWorkspace: { openSession: () => {} },
  configForms: { get: () => undefined, whileServed: (_ns, register) => { register(new Set()); return () => {} } },
}
mod.apply(ctx)

const goalSeat = seats.find((entry) => entry.name === 'conversation.view' && entry.seat.id === 'cybernetics-goal')
assert.ok(goalSeat, 'goal tab seat registered')
const GoalView = goalSeat.seat.__component
assert.equal(typeof GoalView, 'function', 'seat carries the GoalView component')
const controlSeat = seats.find((entry) => entry.name === 'conversation.view' && entry.seat.id === 'cybernetics-control')
assert.ok(controlSeat, 'control tab seat registered')
const ControlView = controlSeat.seat.__component
assert.equal(typeof ControlView, 'function', 'seat carries the ControlView component')

// Locale-bound t (zh by default; section 3 swaps to en via dictZh=false).
function makeT(useEn) {
  const dict = useEn ? dicts.en : dicts.zh
  return (key, params) => {
    let s = dict[key]
    if (typeof s !== 'string') return key
    if (params) {
      for (const [k, v] of Object.entries(params)) s = s.replaceAll('{' + k + '}', String(v))
    }
    return s
  }
}

function face(snapshot) {
  return { subscribe: () => () => {}, getSnapshot: () => snapshot }
}

function goalWire(goalId, extra = {}) {
  return {
    goalId,
    title: 'Goal ' + goalId,
    objective: 'objective ' + goalId,
    status: 'running',
    depth: 'full',
    executor: 'ephemeral',
    round: 1,
    updatedAt: 1,
    ...extra,
  }
}

function goalViewProps({ sessionId, own, single, open, openView, t }) {
  return {
    t,
    goals: face(own),
    goal: face(single),
    sessionId,
    open: open ?? (() => {}),
    ...(openView !== undefined ? { openView } : {}),
    sessions: {
      list: { subscribe: () => () => {}, getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: {} }) },
    },
  }
}

function controlViewProps({ sessionId, openView, t }) {
  return {
    t,
    sessionId,
    goals: face({ goals: [] }),
    sessions: {
      list: { subscribe: () => () => {}, getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: {} }) },
    },
    ...(openView !== undefined ? { openView } : {}),
  }
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

function render(view, props) {
  rendered.length = 0
  const tree = view(props)
  const nodes = rendered.slice()
  return { tree, nodes, text: textOf(tree) }
}

function chatEntryButtons(nodes) {
  return nodes.filter((n) => n.type === 'button' && typeof n.props['aria-label'] === 'string'
    && (n.props['aria-label'].includes('回到主 agent 的对话')
      || n.props['aria-label'].includes('Back to the main agent\'s conversation')
      || n.props['aria-label'].includes('view.chatEntry')))
}

// --- 1. locale parity + exact copy ------------------------------------------
{
  const keys = (dict) => Object.keys(dict).sort()
  assert.deepEqual(keys(dicts.zh), keys(dicts.en), 'zh/en dictionaries expose the same key set')
  for (const key of ['view.chatEntry', 'view.chatEntryHint']) {
    assert.equal(typeof dicts.zh[key], 'string', key + ' exists in zh')
    assert.equal(typeof dicts.en[key], 'string', key + ' exists in en')
    assert.ok(dicts.zh[key].length > 0 && dicts.en[key].length > 0, key + ' is non-empty in both locales')
    assert.match(dicts.zh[key], /[^\x00-\x7f]/, key + ' zh copy is Chinese')
    assert.doesNotMatch(dicts.en[key], /[^\x00-\x7f]/, key + ' en copy is ASCII')
  }
  assert.equal(dicts.zh['view.chatEntry'], '对话', 'exact zh label')
  assert.equal(dicts.zh['view.chatEntryHint'], '回到主 agent 的对话', 'exact zh hint')
  assert.equal(dicts.en['view.chatEntry'], 'Conversation', 'exact en label')
  assert.equal(dicts.en['view.chatEntryHint'], 'Back to the main agent\'s conversation', 'exact en hint')

  // Source-level pins: the guarded owner-prop seam, the stable view id and the
  // v0.18.3 home focus/one-shot consume point.
  const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(src, /typeof props\.openView !== 'function'\) return null/, 'the entry is guarded (no openView → no render)')
  assert.match(src, /const CHAT_VIEW_ID = 'chat'/, "the chat view id is pinned to 'chat'")
  assert.match(src, /const HOME_VIEW_FOCUS = 'cybernetics-home'/, 'the home focus tag is stable')
  assert.match(src, /props\.openView\(CHAT_VIEW_ID, HOME_VIEW_FOCUS\)/, 'click invokes openView(chat, cybernetics-home)')
  assert.match(src, /function homeSessionOf\(list, sessionId\)/, 'the root-session resolver exists')
  assert.match(src, /function requestHome\(sessionId\)/, 'the one-shot request provider exists')
  assert.match(src, /function consumeHomeRequest\(sessionId\)/, 'the one-shot request consumer exists')
  assert.match(src, /consumeHomeRequest\(props\.sessionId\)/, 'both tabs consume a pending home request')
  console.log('✓ 1 locale parity: key sets equal, exact zh/en copy, guarded seam + view id/focus pins')
}

// --- 2. multi-goal self board: entry first, zh copy, click seam --------------
{
  const t = makeT(false)
  const opens = []
  const own = { goals: [goalWire('g-a'), goalWire('g-b', { updatedAt: 2 })] }
  const out = render(GoalView, goalViewProps({ sessionId: 'root', own, single: undefined, openView: (v, f) => opens.push([v, f]), t }))
  const entries = chatEntryButtons(out.nodes)
  assert.equal(entries.length, 1, 'exactly one conversation entry on the goal tab')
  const entry = entries[0]
  assert.equal(out.tree.props.children[0], entry, 'the entry is the FIRST child of the tab content')
  assert.equal(entry.props.type, 'button', 'native button (keyboard reachable)')
  assert.equal(entry.props.disabled, undefined, 'not disabled')
  assert.equal(entry.props.style.display, 'inline-flex', 'tab-item styling applied')
  assert.match(entry.props.style.border, /rgba\(127,127,127/, 'hairline border from the shared style system')
  assert.match(textOf(entry), /对话/, 'zh label renders inside the button')
  assert.match(textOf(entry), /回到主 agent 的对话/, 'zh hint renders inside the button')
  assert.equal(entry.props['aria-label'], '对话 · 回到主 agent 的对话', 'aria-label carries label + hint')
  assert.equal(opens.length, 0, 'no openView call on render')
  entry.props.onClick()
  assert.deepEqual(opens, [['chat', 'cybernetics-home']], 'click switches the CURRENT session to the chat view')
  assert.doesNotThrow(() => entry.props.onClick(), 'repeated clicks are safe')
  assert.deepEqual(opens, [['chat', 'cybernetics-home'], ['chat', 'cybernetics-home']], 'every click hands (chat, focus)')
  // The board itself is untouched by the feature.
  assert.match(out.text, /Goal g-a/, 'goal rows still render')
  assert.match(out.text, /Goal g-b/, 'every goal renders')
  console.log('✓ 2 multi-goal board: first-child entry with zh copy + openView("chat", "cybernetics-home") on click')
}

// --- 3. English locale -------------------------------------------------------
{
  const t = makeT(true)
  const opens = []
  const out = render(GoalView, goalViewProps({ sessionId: 'root', own: { goals: [goalWire('g-a')] }, single: undefined, openView: (v, f) => opens.push([v, f]), t }))
  const entries = chatEntryButtons(out.nodes)
  assert.equal(entries.length, 1, 'one entry in the en locale')
  assert.match(textOf(entries[0]), /Conversation/, 'en label renders')
  assert.match(textOf(entries[0]), /Back to the main agent\'s conversation/, 'en hint renders')
  assert.equal(entries[0].props['aria-label'], 'Conversation · Back to the main agent\'s conversation', 'en aria-label')
  entries[0].props.onClick()
  assert.deepEqual(opens, [['chat', 'cybernetics-home']], 'en click hits the same seam')
  console.log('✓ 3 English locale: Conversation / Back to the main agent\'s conversation, same seam')
}

// --- 4. guard: openView absent → no entry, byte-stable board -----------------
{
  const t = makeT(false)
  const own = { goals: [goalWire('g-a', { updatedAt: 7 }), goalWire('g-b', { updatedAt: 3, status: 'paused' })] }
  let out
  assert.doesNotThrow(() => {
    out = render(GoalView, goalViewProps({ sessionId: 'root', own, single: undefined, t }))
  }, 'rendering without the openView owner prop never throws')
  assert.equal(chatEntryButtons(out.nodes).length, 0, 'no conversation entry without openView')
  // Pre-v0.18.1 shape: badge row first, hint last; GoalRow props untouched.
  const first = out.tree.props.children[0]
  assert.equal(first.props.style.display, 'flex', 'the count badge row is still the first child without openView')
  const rows = out.nodes.filter((n) => typeof n.type === 'function' && n.type.name === 'GoalRow')
  assert.equal(rows.length, 2, 'both goal rows render without openView')
  assert.deepEqual(Object.keys(rows[0].props).sort(), ['goal', 'list', 'open', 'sessionId', 't', 'titles'],
    'GoalRow keeps exactly the pre-v0.18 props')
  assert.match(out.text, /agent 通过 cybernetics 工具推进/, 'the trailing hint is still last')
  console.log('✓ 4 guard: openView absent → silent, no entry, pre-v0.18.1 props and child order')
}

// --- 5. single-goal branch ---------------------------------------------------
{
  const t = makeT(false)
  const opens = []
  const single = { current: { goal: { objective: '聚焦目标', phase: 'active' }, roundsStarted: 2 } }
  const out = render(GoalView, goalViewProps({ sessionId: 'root', own: { goals: [] }, single, openView: (v, f) => opens.push([v, f]), t }))
  const entries = chatEntryButtons(out.nodes)
  assert.equal(entries.length, 1, 'the entry renders on the single-goal branch')
  assert.equal(out.tree.props.children[0], entries[0], 'the entry is the first child above the goal')
  assert.match(out.text, /聚焦目标/, 'the single goal still renders')
  assert.match(out.text, /对话/, 'zh copy present')
  entries[0].props.onClick()
  assert.deepEqual(opens, [['chat', 'cybernetics-home']], 'single-goal entry clicks the same seam')
  console.log('✓ 5 single-goal branch: entry above the goal, same seam')
}

// --- 6. empty board fallback (goal === null) ---------------------------------
{
  const t = makeT(false)
  const opens = []
  const out = render(GoalView, goalViewProps({ sessionId: 'root', own: { goals: [] }, single: null, openView: (v, f) => opens.push([v, f]), t }))
  const entries = chatEntryButtons(out.nodes)
  assert.equal(entries.length, 1, 'the entry renders on the EMPTY board')
  assert.equal(out.tree.props.children[0], entries[0], 'the entry is the first child of the empty board')
  assert.match(out.text, /当前会话没有目标/, 'the dimmed no-goal text follows the entry')
  entries[0].props.onClick()
  assert.deepEqual(opens, [['chat', 'cybernetics-home']], 'the empty-board entry is clickable')
  console.log('✓ 6 empty board: entry visible + clickable above the no-goal text')
}

// --- 7. projections in flight (single === undefined) -------------------------
{
  const t = makeT(false)
  const opens = []
  const out = render(GoalView, goalViewProps({ sessionId: 'root', own: { goals: [] }, single: undefined, openView: (v, f) => opens.push([v, f]), t }))
  const entries = chatEntryButtons(out.nodes)
  assert.equal(entries.length, 1, 'the entry renders even while projections load')
  assert.match(out.text, /对话/, 'zh copy present during load')
  entries[0].props.onClick()
  assert.deepEqual(opens, [['chat', 'cybernetics-home']], 'clickable before any goal data arrives')
  console.log('✓ 7 projections in flight: entry-only render stays visible + clickable')
}

// --- 8. ancestor board (v0.18): entry above the banner ----------------------
{
  const t = makeT(false)
  const opens = []
  const list = {
    ids: ['child', 'root'],
    byId: { child: { id: 'child', displayTitle: 'Child', parentId: 'root' }, root: { id: 'root', displayTitle: '主会话' } },
    projectionsBySession: {
      root: { values: { cyberneticsGoals: { goals: [goalWire('g-root', { agents: [{ id: 'child', role: 'task', startedAt: 1 }] })] } } },
      child: { values: {} },
    },
  }
  const props = goalViewProps({ sessionId: 'child', own: { goals: [] }, single: undefined, openView: (v, f) => opens.push([v, f]), t })
  props.sessions = { list: { subscribe: () => () => {}, getSnapshot: () => list } }
  const out = render(GoalView, props)
  const entries = chatEntryButtons(out.nodes)
  assert.equal(entries.length, 1, 'the entry renders on the ancestor board too')
  assert.equal(out.tree.props.children[0], entries[0], 'the entry precedes the subagent-board banner')
  assert.match(out.text, /显示「主会话」的目标板/, 'the ancestor banner still renders')
  assert.match(out.text, /Goal g-root/, 'the board goals still render')
  entries[0].props.onClick()
  assert.deepEqual(opens, [['chat', 'cybernetics-home']], 'ancestor-board entry uses the same seam')
  console.log('✓ 8 ancestor board: entry above the banner, same seam')
}

// --- 9. control tab: same entry, own focus string ----------------------------
{
  const t = makeT(false)
  const opens = []
  const out = render(ControlView, controlViewProps({ sessionId: 'root', openView: (v, f) => opens.push([v, f]), t }))
  const entries = chatEntryButtons(out.nodes)
  assert.equal(entries.length, 1, 'the control tab carries the entry as well')
  assert.equal(out.tree.props.children[0], entries[0], 'the entry is the control tab\'s first child')
  assert.match(out.text, /对话/, 'zh copy on the control tab')
  entries[0].props.onClick()
  assert.deepEqual(opens, [['chat', 'cybernetics-home']], 'the control entry hands the shared home focus')

  // Without openView the control tab renders exactly as before.
  const bare = render(ControlView, controlViewProps({ sessionId: 'root', t }))
  assert.equal(chatEntryButtons(bare.nodes).length, 0, 'no entry without the owner prop')
  assert.match(bare.text, /个 agent 运行中/, 'the agent tree still renders')
  console.log('✓ 9 control tab: entry + openView("chat", "cybernetics-home"); guard keeps the bare tree')
}

// --- 10. coexistence: goal data/chips untouched when the entry shows ---------
{
  const t = makeT(false)
  const opens = []
  const clicks = []
  const own = {
    goals: [goalWire('g-chip', { updatedAt: 9, agents: [{ id: 'child-1', role: 'task', label: 'task:default', startedAt: 1 }] })],
  }
  const out = render(GoalView, goalViewProps({
    sessionId: 'root', own, single: undefined, t,
    openView: (v, f) => opens.push([v, f]),
    open: (agent) => clicks.push(agent),
  }))
  const entries = chatEntryButtons(out.nodes)
  assert.equal(entries.length, 1, 'entry present with chips in play')
  const rows = out.nodes.filter((n) => typeof n.type === 'function' && n.type.name === 'GoalRow')
  assert.equal(rows.length, 1, 'one goal row')
  assert.deepEqual(Object.keys(rows[0].props).sort(), ['goal', 'list', 'open', 'sessionId', 't', 'titles'],
    'the goal row keeps its prop contract with the entry visible')
  const chip = out.nodes.find((n) => n.type === 'button' && typeof n.props['aria-label'] === 'string'
    && (n.props['aria-label'].includes('点击进入该智能体的对话界面') || n.props['aria-label'].includes('agents.openTip')))
  assert.ok(chip, 'the agent chip still renders next to the entry')
  assert.equal(chip.props.disabled, false, 'chip stays clickable')
  chip.props.onClick()
  assert.equal(clicks[0].id, 'child-1', 'the chip click hands over the agent record (unchanged)')
  assert.equal(opens.length, 0, 'the chip did not trigger the view switch')
  entries[0].props.onClick()
  assert.deepEqual(opens, [['chat', 'cybernetics-home']], 'the entry click did not touch the agent seam')
  console.log('✓ 10 coexistence: goal rows + agent chips behave exactly as before with the entry visible')
}

console.log('\nALL v0.18.1 CONVERSATION-ENTRY CHECKS PASSED')
