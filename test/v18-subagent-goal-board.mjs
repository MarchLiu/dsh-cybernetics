// Offline harness test for dsh-cybernetics v0.18: the「目标 / Goal」tab on a
// SUBAGENT session (workflow task/verify/triage child, Agent Teams teammate).
// A child session has an empty `cyberneticsGoals` board of its own, so the tab
// used to render nothing. v0.18 renders the nearest ancestor session's board,
// marks + scrolls the goal that spawned this session, and routes the agent
// chips through the board session (their real parent) — so from any sub agent
// you can jump to the session's other agents.
//
// Covers:
//   (1) harness + locale parity: zh/en dictionaries carry the same key set and
//       the three v0.18 keys exist on both sides,
//   (2) ancestor board via byId.parentId (grandchild → nearest non-empty
//       ancestor, skipping an empty middle board), banner + current marker +
//       scroll-into-view exactly once (re-render does not re-scroll; a focus
//       change does),
//   (3) nearest non-empty ancestor wins over a farther non-empty one,
//   (4) the catalog-only parent path (no byId.parentId) + parentId precedence,
//   (5) cycle protection (no throw, no banner, single-goal fallback),
//   (6) missing session-list store → pre-v0.18 behavior,
//   (7) root session's own board: no banner, no scroll, no current marker and
//       exactly the pre-v0.18 GoalRow props,
//   (8) chips: board session as navigation parent + board catalog for liveness,
//   (9) focus fallback through the ancestor chain (grandchild finds the goal
//       that spawned its parent) + robustness (no scrollIntoView, null ref),
//   (10) late-arriving list snapshot appears without a remount, subscribe /
//        unsubscribe safety.
// Run: node test/v18-subagent-goal-board.mjs

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// --- recording jsx harness ---------------------------------------------------
// Same contract as test/v14-goal-agents.mjs: function components are invoked
// immediately (depth first), so the tree is assertable offline.
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
const hookSubscribes = []
const react = {
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useSyncExternalStore: (subscribe, getSnapshot) => { hookSubscribes.push(subscribe); return getSnapshot() },
}
const mod = loadedModule.factory((id) => {
  if (id === 'react') return react
if (id === 'react/jsx-runtime') return jsxRuntime
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: null }
  throw new Error('unexpected require: ' + id)
})

// --- fake host ctx -----------------------------------------------------------
const dicts = { zh: {}, en: {} }
const subscribeCalls = []
const unsubscribeCalls = []
let sessionListSnapshot = { ids: [], byId: {}, projectionsBySession: {} }
const listStore = {
  subscribe: (cb) => {
    subscribeCalls.push(cb)
    return () => unsubscribeCalls.push(cb)
  },
  getSnapshot: () => sessionListSnapshot,
}
const sessions = {
  binding: () => ({
    session: { projections: { faceOf: () => ({ subscribe: () => () => {}, getSnapshot: () => undefined }) } },
  }),
  list: listStore,
}
const addresses = []
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
  sessions,
  uiWorkspace: { openSession: (address) => addresses.push(address) },
  configForms: { get: () => undefined, whileServed: (_ns, register) => { register(new Set()); return () => {} } },
}
mod.apply(ctx)

const goalSeat = seats.find((entry) => entry.name === 'conversation.view' && entry.seat.id === 'cybernetics-goal')
assert.ok(goalSeat, 'goal tab seat registered')
const GoalView = goalSeat.seat.__component
assert.equal(typeof GoalView, 'function', 'seat carries the GoalView component')

// --- helpers -----------------------------------------------------------------
function t(key, params) {
  if (!params) return key
  return key + ' ' + Object.keys(params).map((k) => k + '=' + String(params[k])).join(' ')
}

function face(snapshot) {
  return { subscribe: () => () => {}, getSnapshot: () => snapshot }
}

function goalViewProps({ sessionId, own, single, list, open, sessionsProp }) {
  const props = {
    t,
    goals: face(own),
    goal: face(single),
    sessionId,
    open: open ?? (() => {}),
  }
  if (sessionsProp !== undefined) props.sessions = sessionsProp
  else props.sessions = {
    list: { subscribe: listStore.subscribe, getSnapshot: () => list },
  }
  return props
}

function walkTree(node, fn) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const n of node) walkTree(n, fn)
    return
  }
  if (typeof node !== 'object') return
  fn(node)
  if (node.props && node.props.children !== undefined) walkTree(node.props.children, fn)
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

function render(props) {
  rendered.length = 0
  const tree = GoalView(props)
  const nodes = rendered.slice()
  return { tree, nodes, text: textOf(tree) }
}

function goalRows(nodes) {
  return nodes.filter((n) => typeof n.type === 'function' && n.type.name === 'GoalRow')
}

function chips(nodes) {
  return nodes.filter((n) => n.type === 'button' && typeof n.props['aria-label'] === 'string'
    && (n.props['aria-label'].includes('agents.openTip') || n.props['aria-label'].includes('agents.openUnavailable')))
}

function currentCards(nodes) {
  return nodes.filter((n) => n.props['data-cyb-current'] === 'true')
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

const ROOT_BOARD = {
  goals: [
    goalWire('g-child', { updatedAt: 10, agents: [{ id: 'child', role: 'task', label: 'task:default', startedAt: 1 }] }),
    goalWire('g-sibling', { updatedAt: 5, agents: [{ id: 'sibling', role: 'verify', label: 'verify', startedAt: 2, outcome: 'completed' }] }),
  ],
}

function ancestorList(overrides = {}) {
  return {
    ids: ['child', 'mid', 'root'],
    byId: {
      child: { id: 'child', displayTitle: 'Child', parentId: 'mid' },
      mid: { id: 'mid', displayTitle: 'Middle', parentId: 'root' },
      root: { id: 'root', displayTitle: '主会话', running: true },
    },
    projectionsBySession: {
      root: { values: { cyberneticsGoals: ROOT_BOARD } },
      mid: { values: { cyberneticsGoals: { goals: [] } } },
      child: { values: {} },
    },
    ...overrides,
  }
}

// --- 1. locale parity --------------------------------------------------------
{
  const keys = (dict) => Object.keys(dict).sort()
  assert.deepEqual(keys(dicts.zh), keys(dicts.en), 'zh/en dictionaries expose the same key set')
  for (const key of ['goal.current', 'goal.subagentBoard', 'goal.jumpHint']) {
    assert.equal(typeof dicts.zh[key], 'string', key + ' exists in zh')
    assert.equal(typeof dicts.en[key], 'string', key + ' exists in en')
    assert.ok(dicts.zh[key].length > 0 && dicts.en[key].length > 0, key + ' is non-empty in both locales')
    assert.match(dicts.zh[key], /[^\x00-\x7f]/, key + ' zh copy is Chinese')
    assert.doesNotMatch(dicts.en[key], /[^\x00-\x7f]/, key + ' en copy is ASCII')
  }
  assert.match(dicts.zh['goal.subagentBoard'], /\{title\}/, 'the board banner interpolates the board session title')
  assert.match(dicts.en['goal.subagentBoard'], /\{title\}/, 'the board banner interpolates the board session title (en)')

  // Source-level pins: the tab subscribes the session-list store and the seat's
  // open seam takes the board session as its second argument.
  const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(src, /function \(agent, boardSessionId\)/, 'the open seam takes (agent, boardSessionId)')
  assert.match(src, /readableSessionList\(props\.sessions\)/, 'GoalView reads the optional session list store')
  assert.match(src, /__cybFocusedGoal/, 'the one-shot scroll dedupe marker exists')
  console.log('✓ 1 locale parity: zh/en key sets equal, v0.18 keys present + Chinese/English copy, wiring pins')
}

// --- 2. ancestor board + focus + one-shot scroll -----------------------------
{
  let list = ancestorList()
  const props = goalViewProps({
    sessionId: 'child',
    own: { goals: [] },
    single: undefined,
    list,
    open: () => {},
  })
  let out = render(props)
  assert.match(out.text, /goal\.subagentBoard title=主会话/, 'ancestor board banner names the board session title')
  assert.match(out.text, /goal\.jumpHint/, 'ancestor board banner carries the jump hint')
  assert.match(out.text, /Goal g-child/, 'the ancestor board goals render')
  assert.match(out.text, /Goal g-sibling/, 'every board goal renders')
  assert.doesNotMatch(out.text, /noGoal/, 'no empty fallback in ancestor board mode')
  assert.equal(goalRows(out.nodes).length, 2, 'one GoalRow per board goal')

  const current = currentCards(out.nodes)
  assert.equal(current.length, 1, 'exactly one current goal card')
  assert.equal(current[0].props.style.borderLeft, '3px solid #58a6ff', 'current card has the accent left border')
  assert.match(out.text, /goal\.current/, 'current card shows the「当前」badge')
  const currentRow = goalRows(out.nodes).find((n) => n.props.goal.goalId === 'g-child')
  assert.equal(currentRow.props.current, true, 'the goal whose agents contain this session is the focus goal')

  // Scroll: exactly once, block center, then never again for the same
  // container+focus (the card remounts on live updates: key carries updatedAt).
  const scrolls = []
  const container = {}
  const el = { parentNode: container, scrollIntoView: (opts) => scrolls.push(opts) }
  assert.equal(typeof current[0].props.ref, 'function', 'the current card carries the scroll ref')
  current[0].props.ref(el)
  assert.deepEqual(scrolls, [{ block: 'center' }], 'scrollIntoView called once with block:center')
  assert.equal(container.__cybFocusedGoal, 'g-child', 'the container marker records the focused goal')
  assert.equal(container.__cybFocusedBoard, 'root', 'the container marker records the board session')

  // Live update: same board, same focus, new updatedAt → new nodes.
  list = ancestorList()
  list.projectionsBySession.root.values.cyberneticsGoals.goals[0].updatedAt = 11
  out = render(goalViewProps({ sessionId: 'child', own: { goals: [] }, single: undefined, list }))
  const again = currentCards(out.nodes)
  assert.equal(again.length, 1, 'still one current card after the live update')
  const el2 = { parentNode: container, scrollIntoView: (opts) => scrolls.push(opts) }
  again[0].props.ref(el2)
  assert.equal(scrolls.length, 1, 'the same container + focus never scrolls twice')

  // Focus change (this session now appears in ANOTHER goal) → scroll again.
  list = ancestorList()
  list.projectionsBySession.root.values.cyberneticsGoals.goals[1].agents.push({ id: 'child', role: 'task', label: 'task:default', startedAt: 3 })
  list.projectionsBySession.root.values.cyberneticsGoals.goals[0].agents = []
  out = render(goalViewProps({ sessionId: 'child', own: { goals: [] }, single: undefined, list }))
  const moved = currentCards(out.nodes)
  assert.equal(moved.length, 1, 'one current card after the focus moved')
  assert.equal(goalRows(out.nodes).find((n) => n.props.goal.goalId === 'g-sibling').props.current, true, 'focus follows the goal containing this session')
  moved[0].props.ref({ parentNode: container, scrollIntoView: (opts) => scrolls.push(opts) })
  assert.equal(scrolls.length, 2, 'a focus change scrolls the new goal into view once')
  assert.equal(container.__cybFocusedGoal, 'g-sibling', 'the marker follows the new focus')

  // Non-object refs are ignored (React calls ref(null) on unmount).
  assert.doesNotThrow(() => moved[0].props.ref(null), 'a null ref is ignored')
  console.log('✓ 2 ancestor board: banner + current marker + one-shot scroll (idempotent on re-render, re-scrolls on focus change)')
}

// --- 3. nearest non-empty ancestor wins --------------------------------------
{
  const near = ancestorList()
  near.projectionsBySession.mid.values.cyberneticsGoals = { goals: [goalWire('g-mid', { agents: [{ id: 'child', role: 'task', startedAt: 1 }] })] }
  let out = render(goalViewProps({ sessionId: 'child', own: { goals: [] }, single: undefined, list: near }))
  assert.match(out.text, /goal\.subagentBoard title=Middle/, 'the nearest non-empty ancestor board wins over the root')
  assert.match(out.text, /Goal g-mid/, 'the middle board renders')
  assert.doesNotMatch(out.text, /Goal g-child/, 'the farther root board is not rendered')
  assert.equal(goalRows(out.nodes).length, 1, 'only the nearest board is rendered')

  // Grandchild skipping TWO levels (mid has no board at all).
  const far = ancestorList()
  delete far.projectionsBySession.mid.values.cyberneticsGoals
  out = render(goalViewProps({ sessionId: 'child', own: { goals: [] }, single: undefined, list: far }))
  assert.match(out.text, /goal\.subagentBoard title=主会话/, 'the nearest non-empty ancestor is found with an empty middle board')
  console.log('✓ 3 board resolution: nearest non-empty ancestor board (skips empty levels)')
}

// --- 4. both parent-resolution paths + precedence ---------------------------
{
  // (a) no byId.parentId at all: the owning session's subagentCatalog names the
  // parent (the dsh-client-ui-subagent fallback).
  const catalogOnly = {
    ids: ['child', 'root'],
    byId: { child: { id: 'child', displayTitle: 'Child' }, root: { id: 'root', displayTitle: '主会话' } },
    projectionsBySession: {
      root: {
        values: {
          cyberneticsGoals: { goals: [goalWire('g-root', { agents: [{ id: 'child', role: 'task', startedAt: 1 }] })] },
          subagentCatalog: [{ id: 'child', mode: 'continuable', label: 'task:default' }],
        },
      },
      child: { values: {} },
    },
  }
  let out = render(goalViewProps({ sessionId: 'child', own: { goals: [] }, single: undefined, list: catalogOnly }))
  assert.match(out.text, /goal\.subagentBoard title=主会话/, 'catalog ownership resolves the parent without byId.parentId')
  assert.equal(currentCards(out.nodes).length, 1, 'the catalog-resolved board marks the current goal')

  // (b) byId.parentId wins over a catalog entry that points elsewhere.
  const precedence = ancestorList()
  precedence.projectionsBySession.root.values.subagentCatalog = [{ id: 'child', mode: 'continuable' }]
  precedence.projectionsBySession.mid.values.cyberneticsGoals = { goals: [goalWire('g-mid')] }
  out = render(goalViewProps({ sessionId: 'child', own: { goals: [] }, single: undefined, list: precedence }))
  assert.match(out.text, /goal\.subagentBoard title=Middle/, 'byId.parentId precedes the catalog scan')
  assert.doesNotMatch(out.text, /goal\.subagentBoard title=主会话/, 'the catalog fallback did not hijack the chain')
  console.log('✓ 4 parent resolution: byId.parentId first, subagentCatalog fallback, precedence')
}

// --- 5. cycle protection -----------------------------------------------------
{
  const cyclic = {
    ids: ['a', 'b'],
    byId: { a: { id: 'a', parentId: 'b' }, b: { id: 'b', parentId: 'a' } },
    projectionsBySession: { a: { values: {} }, b: { values: {} } },
  }
  let out
  assert.doesNotThrow(() => {
    out = render(goalViewProps({
      sessionId: 'a',
      own: { goals: [] },
      single: { current: { goal: { objective: '聚焦目标', phase: 'active' }, roundsStarted: 1 } },
      list: cyclic,
    }))
  }, 'a parent cycle never loops or throws')
  assert.doesNotMatch(out.text, /goal\.subagentBoard/, 'no board banner without a non-empty ancestor board')
  assert.match(out.text, /聚焦目标/, 'the single-goal fallback still renders')
  console.log('✓ 5 cycles: visited guard ends the walk, empty fallback intact')
}

// --- 6. no session-list store (older host) ----------------------------------
{
  const full = ancestorList()
  // sessions with a list object lacking subscribe/getSnapshot: treated as absent.
  const out = render(goalViewProps({
    sessionId: 'child',
    own: { goals: [] },
    single: { current: { goal: { objective: '聚焦目标', phase: 'active' }, roundsStarted: 2 } },
    sessionsProp: { list: { getSnapshot: () => full } },
  }))
  assert.doesNotMatch(out.text, /goal\.subagentBoard/, 'no ancestor board without a usable list store')
  assert.match(out.text, /聚焦目标/, 'pre-v0.18 single-goal fallback renders')

  const none = render(goalViewProps({
    sessionId: 'child',
    own: { goals: [] },
    single: { current: { goal: { objective: '聚焦目标2', phase: 'active' }, roundsStarted: 1 } },
    sessionsProp: {},
  }))
  assert.match(none.text, /聚焦目标2/, 'absent sessions namespace still renders the fallback')
  console.log('✓ 6 compatibility: absent/damaged session-list store keeps the pre-v0.18 fallback')
}

// --- 7. root session with its own board: byte-equal pre-v0.18 render --------
{
  const own = {
    goals: [goalWire('g-root', { updatedAt: 7 }), goalWire('g-other', { updatedAt: 3, status: 'paused' })],
  }
  // The ROOT session id appears in no goal's agents → no focus marker at all.
  const out = render(goalViewProps({
    sessionId: 'root',
    own,
    single: undefined,
    list: ancestorList(),
    open: () => {},
  }))
  assert.doesNotMatch(out.text, /goal\.subagentBoard/, 'self board shows no ancestor banner')
  assert.doesNotMatch(out.text, /goal\.jumpHint/, 'self board shows no jump hint')
  assert.equal(currentCards(out.nodes).length, 0, 'self board has no current marker')
  assert.equal(out.nodes.filter((n) => n.props && n.props.ref !== undefined && n.type !== 'function').length, 0, 'self board attaches no scroll ref')
  // Pre-v0.18 GoalRow props exactly (no current/boardSessionId/scrollRef keys).
  const row = goalRows(out.nodes).find((n) => n.props.goal.goalId === 'g-root')
  assert.deepEqual(Object.keys(row.props).sort(), ['goal', 'list', 'open', 'sessionId', 't', 'titles'],
    'self-board GoalRow receives exactly the pre-v0.18 props')
  // Same children shape as before: badge row first, hint last, no banner slot.
  const root = out.tree
  const first = root.props.children[0]
  assert.equal(first.props.style.display, 'flex', 'the count badge row is still the first child')
  assert.match(out.text, /goals\.count count=2/, 'the goal count renders')
  console.log('✓ 7 root/self board: no banner, no marker, no scroll, pre-v0.18 props and children shape')
}

// --- 8. chips: board session as parent + board catalog liveness --------------
{
  const list = ancestorList()
  // Live catalog of the BOARD session marks this agent running; the viewing
  // child's own catalog knows nothing about it. The recorded outcome is
  // 'completed', so only the board catalog can flip the chip to running.
  list.projectionsBySession.root.values.subagentCatalog = [{ id: 'sibling', mode: 'continuable', activity: 'running' }]
  list.projectionsBySession.child.values.subagentCatalog = [{ id: 'sibling', mode: 'continuable', activity: 'idle' }]
  const opens = []
  const out = render(goalViewProps({
    sessionId: 'child',
    own: { goals: [] },
    single: undefined,
    list,
    open: (agent, boardSessionId) => opens.push([agent.id, boardSessionId]),
  }))
  const chipNodes = chips(out.nodes)
  assert.equal(chipNodes.length, 2, 'one chip per agent of the board')
  const siblingChip = chipNodes.find((n) => n.props['aria-label'].includes('verify'))
  assert.ok(siblingChip, 'the sibling verify chip renders')
  assert.match(siblingChip.props['aria-label'], /agentStatus\.running/, 'liveness is read from the BOARD session catalog')
  siblingChip.props.onClick()
  assert.deepEqual(opens, [['sibling', 'root']], 'the chip hands the board session to the open seam')
  assert.equal(siblingChip.props.disabled, false, 'chips stay clickable in ancestor mode')

  // The seat's open seam: second argument = board session (parent + catalog
  // key); omitted = the viewing session (v0.14 behavior). The seam reads the
  // host's own list snapshot, so point it at this fixture.
  sessionListSnapshot = list
  const injected = goalSeat.seat.inject('child')
  assert.equal(typeof injected.open, 'function', 'open seam injected')
  addresses.length = 0
  injected.open({ id: 'sibling' })
  assert.deepEqual(addresses[0], { parentSessionId: 'child', childSessionId: 'sibling', mode: 'continuable' }, 'omitted board → the viewing session is the parent (its catalog supplies the mode)')
  addresses.length = 0
  injected.open({ id: 'sibling' }, 'root')
  assert.deepEqual(addresses[0], { parentSessionId: 'root', childSessionId: 'sibling', mode: 'continuable' }, 'board session is the parent and the catalog key')
  console.log('✓ 8 chips: board-session navigation parent + board catalog liveness + open-seam default')
}

// --- 9. focus through the ancestor chain (grandchild) + robustness ----------
{
  // This session's id is in NO goal; its parent 'mid' is — the focus falls
  // back along the chain so a grandchild still lands on the right goal.
  const list = ancestorList()
  list.projectionsBySession.root.values.cyberneticsGoals = {
    goals: [
      goalWire('g-parent', { agents: [{ id: 'mid', role: 'task', startedAt: 1 }] }),
      goalWire('g-unrelated', { agents: [{ id: 'nobody', role: 'task', startedAt: 1 }] }),
    ],
  }
  const out = render(goalViewProps({ sessionId: 'child', own: { goals: [] }, single: undefined, list }))
  const current = goalRows(out.nodes).filter((n) => n.props.current === true)
  assert.equal(current.length, 1, 'one focus goal via the ancestor chain')
  assert.equal(current[0].props.goal.goalId, 'g-parent', 'the nearest ancestor hit wins (grandchild case)')

  // A host without scrollIntoView: silent, no throw, marker still recorded.
  const container = {}
  const scrollRef = currentCards(out.nodes)[0].props.ref
  assert.doesNotThrow(() => scrollRef({ parentNode: container }), 'absent scrollIntoView is silent')
  assert.equal(container.__cybFocusedGoal, 'g-parent', 'the marker is set even without the method (scroll attempted once)')

  // A throwing scrollIntoView is contained.
  const throwing = { parentNode: {}, scrollIntoView: () => { throw new Error('boom') } }
  assert.doesNotThrow(() => scrollRef(throwing), 'a throwing scrollIntoView is contained')
  assert.equal(throwing.parentNode.__cybFocusedGoal, 'g-parent', 'the marker is set before the attempt')

  // No focus at all → no ref anywhere (no scrolling for an unrelated board).
  const noFocus = render(goalViewProps({ sessionId: 'child', own: { goals: [] }, single: undefined, list: ancestorList() }))
  assert.equal(currentCards(noFocus.nodes).length, 1, 'control: the fixture does have a focus')
  const unrelated = ancestorList()
  unrelated.projectionsBySession.root.values.cyberneticsGoals.goals.forEach((g) => { g.agents = [] })
  const emptyFocus = render(goalViewProps({ sessionId: 'child', own: { goals: [] }, single: undefined, list: unrelated }))
  assert.equal(currentCards(emptyFocus.nodes).length, 0, 'no current marker without a matching agent')
  const refs = emptyFocus.nodes.filter((n) => n.type !== 'function' && n.props.ref !== undefined)
  assert.equal(refs.length, 0, 'no scroll ref is attached without a focus goal')
  console.log('✓ 9 focus: ancestor-chain fallback (grandchild) + silent/contained scroll failures + no focus → no ref')
}

// --- 10. late list arrival + subscription safety ----------------------------
{
  sessionListSnapshot = { ids: [], byId: {}, projectionsBySession: {} }
  const own = { goals: [] }
  const props = goalViewProps({ sessionId: 'child', own, single: undefined, list: sessionListSnapshot })
  // The list store the component subscribes is `sessions.list` (snapshot read
  // each render), so the harness's mutable snapshot drives the update.
  props.sessions = sessions
  let out = render(props)
  assert.doesNotMatch(out.text, /goal\.subagentBoard/, 'no board while the list snapshot is empty')

  sessionListSnapshot = ancestorList()
  out = render(props)
  assert.match(out.text, /goal\.subagentBoard title=主会话/, 'a late-arriving list snapshot shows the ancestor board on the next render')
  assert.match(out.text, /Goal g-child/, 'the late board renders its goals')

  assert.ok(hookSubscribes.includes(listStore.subscribe), 'the session list store is subscribed reactively')
  assert.equal(typeof listStore.subscribe(() => {}), 'function', 'subscribe returns an unsubscribe function')
  assert.doesNotThrow(() => listStore.subscribe(() => {})(), 'unsubscribe is safe to call')
  console.log('✓ 10 reactivity: late list snapshot renders the board; list subscription/unsubscribe safe')
}

console.log('\nALL v0.18.0 SUBAGENT GOAL-BOARD CHECKS PASSED')
