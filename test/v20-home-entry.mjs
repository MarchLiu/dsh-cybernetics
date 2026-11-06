// Offline harness test for dsh-cybernetics v0.18.3: the「对话 / Conversation」
// entry on the「目标 / Goal」and「控制 / Control」tabs is now a「回到主对话 /
// home」navigation — from ANY agent it returns to the ROOT (main) session's
// chat view, like a site's「回到主页」link, instead of switching the CURRENT
// (sub agent) session's tab.
//
// Mechanism under test (see the v0.18.2 conversation-entry region in
// lib/client.js):
//   1. `homeSessionOf(list, sessionId)` = last element of the ancestor chain
//      (empty chain / no list → the current session);
//   2. on a child session the click drops a ONE-SHOT request
//      (`requestHome(rootId)`) and calls the injected
//      `openHome(rootId)` (→ uiWorkspace.openSession(rootId));
//   3. the root session's GoalView / ControlView effect calls
//      `consumeHomeRequest(sessionId)` (read-and-delete, ~4 s TTL) and, on a
//      hit, `openView('chat', 'cybernetics-home')` — its OWN view switch.
//
// This harness's fake react executes `useEffect(fn)` immediately (the v19
// harness stubs it out), which is exactly the mount-time consumption the real
// host performs after the commit.
//
// Covers:
//   (a) homeSessionOf: multi-level chain, catalog fallback for a missing
//       parentId, cycle safety, no list / empty id / root session;
//   (b) root session click: only openView('chat', 'cybernetics-home') — no
//       openHome call, no queued request;
//   (c) child session click: openHome(rootId) once with the ROOT id, no
//       openView at click time; rendering the root's GoalView then fires
//       openView exactly once, a second render does not repeat it, a request
//       addressed to another session is ignored, and a stale (>4 s) request
//       never fires;
//   (d) control tab consumes the same request; without openView the entry is
//       not rendered and nothing throws; without openHome the click degrades
//       to the local chat switch (no cross-session hop, no stale request);
//   (e) request/consume primitives: invalid ids, one-shot delete, TTL boundary;
//   (f) regression: the entry is still the first child, goal rows/agent chips
//       keep their exact props and behavior when the entry is visible.
// Run: node test/v20-home-entry.mjs

import assert from 'node:assert/strict'

// --- recording jsx harness (effects run immediately) ------------------------
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
// v19 stubs useEffect; here it RUNS the callback (mount-time consumption).
const react = {
  useState: (v) => [v, () => {}],
  useEffect: (fn) => { fn() },
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const mod = loadedModule.factory((id) => {
  if (id === 'react') return react
  if (id === 'react/jsx-runtime') return jsxRuntime
  throw new Error('unexpected require: ' + id)
})
const { homeSessionOf, requestHome, consumeHomeRequest } = mod

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
  // Injectable workspace service: records the target it is asked to open.
  uiWorkspace: { openSession: (target) => { opened.push(target) } },
  configForms: { get: () => undefined, whileServed: (_ns, register) => { register(new Set()); return () => {} } },
}
const opened = []
mod.apply(ctx)

const goalSeat = seats.find((entry) => entry.name === 'conversation.view' && entry.seat.id === 'cybernetics-goal')
assert.ok(goalSeat, 'goal tab seat registered')
const GoalView = goalSeat.seat.__component
const controlSeat = seats.find((entry) => entry.name === 'conversation.view' && entry.seat.id === 'cybernetics-control')
assert.ok(controlSeat, 'control tab seat registered')
const ControlView = controlSeat.seat.__component

// The seats' inject is what wires openHome; exercise it with the fake ctx so
// the uiWorkspace → openHome bridge itself is covered (section d2).
const goalInject = goalSeat.seat.inject('root')
assert.equal(typeof goalInject.openHome, 'function', 'goal inject wires openHome when uiWorkspace.openSession exists')
const controlInject = controlSeat.seat.inject('root')
assert.equal(typeof controlInject.openHome, 'function', 'control inject wires openHome too')
opened.length = 0
goalInject.openHome('root')
controlInject.openHome('root')
assert.deepEqual(opened, ['root', 'root'], 'openHome forwards the plain root session id to uiWorkspace.openSession')
assert.doesNotThrow(() => { goalInject.openHome(''); goalInject.openHome(null) }, 'openHome ignores empty/malformed ids')
assert.deepEqual(opened, ['root', 'root'], 'ignored ids never reach the workspace service')

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
const t = makeT(false)

function face(snapshot) {
  return { subscribe: () => () => {}, getSnapshot: () => snapshot }
}

function listFace(byId, projectionsBySession) {
  const snap = { ids: Object.keys(byId), byId, projectionsBySession: projectionsBySession ?? {} }
  return { subscribe: () => () => {}, getSnapshot: () => snap }
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

function goalViewProps({ sessionId, list, own, single, open, openView, openHome }) {
  return {
    t,
    goals: face(own ?? { goals: [] }),
    goal: face(single),
    sessionId,
    open: open ?? (() => {}),
    ...(list !== undefined ? { sessions: { list } } : { sessions: { list: listFace({}) } }),
    ...(openView !== undefined ? { openView } : {}),
    ...(openHome !== undefined ? { openHome } : {}),
  }
}

function controlViewProps({ sessionId, list, openView, openHome }) {
  return {
    t,
    sessionId,
    goals: face({ goals: [] }),
    sessions: { list: list ?? listFace({}) },
    ...(openView !== undefined ? { openView } : {}),
    ...(openHome !== undefined ? { openHome } : {}),
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

const NEW_HINT_ZH = '回到主 agent 的对话'
const NEW_HINT_EN = "Back to the main agent's conversation"

function homeEntryButtons(nodes) {
  return nodes.filter((n) => n.type === 'button' && typeof n.props['aria-label'] === 'string'
    && (n.props['aria-label'].includes(NEW_HINT_ZH)
      || n.props['aria-label'].includes(NEW_HINT_EN)
      || n.props['aria-label'].includes('view.chatEntry')))
}

function drain(sessionId) {
  // Read-and-delete: one call clears, further calls answer false.
  let hits = 0
  while (consumeHomeRequest(sessionId)) hits += 1
  return hits
}

// --- (a) homeSessionOf -------------------------------------------------------
{
  // Multi-level parent chain via byId.parentId: child → mid → root.
  const chainList = {
    byId: {
      child: { id: 'child', parentId: 'mid' },
      mid: { id: 'mid', parentId: 'root' },
      root: { id: 'root' },
    },
    projectionsBySession: {},
  }
  assert.equal(homeSessionOf(chainList, 'child'), 'root', 'child resolves to the root of a 3-level chain')
  assert.equal(homeSessionOf(chainList, 'mid'), 'root', 'mid resolves to the root')
  assert.equal(homeSessionOf(chainList, 'root'), 'root', 'a root is its own home')

  // Missing parentId on the lowest row → the owning session's subagentCatalog.
  const catalogList = {
    byId: {
      child: { id: 'child' }, // no parentId: must come from the catalog
      mid: { id: 'mid', parentId: 'root' },
      root: { id: 'root' },
    },
    projectionsBySession: {
      mid: { values: { subagentCatalog: [{ id: 'child', mode: 'task' }] } },
      root: { values: {} },
    },
  }
  assert.equal(homeSessionOf(catalogList, 'child'), 'root', 'catalog fallback resolves the parent, then walks on')

  // No list at all / unusable list → the current session, never a throw.
  assert.equal(homeSessionOf(null, 'child'), 'child', 'null list → current session')
  assert.equal(homeSessionOf(undefined, 'child'), 'child', 'undefined list → current session')
  assert.equal(homeSessionOf({}, 'child'), 'child', 'list without rows → current session')
  assert.equal(homeSessionOf(chainList, ''), '', 'empty id → itself (no throw)')
  assert.doesNotThrow(() => homeSessionOf('garbage', 'child'), 'non-object list never throws')

  // Cycle: a ↔ b. The visited guard terminates; the chain head is 'b'.
  const cycleList = { byId: { a: { id: 'a', parentId: 'b' }, b: { id: 'b', parentId: 'a' } }, projectionsBySession: {} }
  let cyc
  assert.doesNotThrow(() => { cyc = homeSessionOf(cycleList, 'a') }, 'a parent cycle never throws or hangs')
  assert.equal(cyc, 'b', 'the visited guard stops at the last unvisited ancestor')
  console.log('✓ a homeSessionOf: multi-level, catalog fallback, no-list, empty id, cycle')
}

// --- (b) root session: one-step switch, no session hop ----------------------
{
  drain('root')
  const opens = []
  const homes = []
  const rootList = listFace({ root: { id: 'root' } })
  const out = render(GoalView, goalViewProps({
    sessionId: 'root',
    list: rootList,
    own: { goals: [goalWire('g-root')] },
    openView: (v, f) => opens.push([v, f]),
    openHome: (id) => homes.push(id),
  }))
  const entries = homeEntryButtons(out.nodes)
  assert.equal(entries.length, 1, 'exactly one entry on the root goal tab')
  assert.equal(out.tree.props.children[0], entries[0], 'entry is still the first child')
  entries[0].props.onClick()
  assert.deepEqual(opens, [['chat', 'cybernetics-home']], 'root click: one-step openView(chat, cybernetics-home)')
  assert.deepEqual(homes, [], 'root click never asks for a session hop')
  assert.equal(consumeHomeRequest('root'), false, 'root click queues no request')
  console.log('✓ b root session: one-step openView("chat", "cybernetics-home"), no openHome, no request')
}

// --- (c) child session: two-legged home navigation --------------------------
{
  drain('root'); drain('child')
  const childList = listFace({
    root: { id: 'root', displayTitle: '主会话' },
    child: { id: 'child', parentId: 'root' },
  }, { root: { values: { cyberneticsGoals: { goals: [goalWire('g-root')] } } } })

  const childOpens = []
  const homes = []
  const childOut = render(GoalView, goalViewProps({
    sessionId: 'child',
    list: childList,
    own: { goals: [] }, // child board empty → ancestor board renders, entry above it
    openView: (v, f) => childOpens.push([v, f]),
    openHome: (id) => homes.push(id),
  }))
  const entries = homeEntryButtons(childOut.nodes)
  assert.equal(entries.length, 1, 'the child goal tab carries the entry')
  assert.match(childOut.text, /显示「主会话」的目标板/, 'the ancestor board still renders under the entry')
  entries[0].props.onClick()
  assert.deepEqual(homes, ['root'], 'child click: openHome(rootId) once, with the ROOT id')
  assert.deepEqual(childOpens, [], 'child click does not switch the child session view')

  // Any depth: a grandchild resolves the same root and hands THAT id over.
  const deepList = listFace({
    root: { id: 'root' },
    mid: { id: 'mid', parentId: 'root' },
    deep: { id: 'deep', parentId: 'mid' },
  })
  const deepHomes = []
  const deepOut = render(GoalView, goalViewProps({
    sessionId: 'deep',
    list: deepList,
    own: { goals: [] },
    openView: () => { throw new Error('the deep click must not switch the local view') },
    openHome: (id) => deepHomes.push(id),
  }))
  homeEntryButtons(deepOut.nodes)[0].props.onClick()
  assert.deepEqual(deepHomes, ['root'], 'a grandchild click opens the ROOT, not its direct parent')
  assert.equal(requestHome('__probe__'), true, 'provider sanity: a fresh request is accepted')
  assert.equal(consumeHomeRequest('__probe__'), true, 'provider sanity: read-and-delete')
  assert.equal(consumeHomeRequest('__probe__'), false, 'provider sanity: second read is gone')

  // Root GoalView mounts (the host selected the root session): the pending
  // request fires openView exactly once.
  const rootOpens = []
  const rootProps = goalViewProps({
    sessionId: 'root',
    list: childList,
    own: { goals: [goalWire('g-root')] },
    openView: (v, f) => rootOpens.push([v, f]),
  })
  render(GoalView, rootProps)
  assert.deepEqual(rootOpens, [['chat', 'cybernetics-home']], 'the root view consumes the request and switches to chat')
  // Re-render: consumed → no duplicate switch.
  render(GoalView, rootProps)
  assert.equal(rootOpens.length, 1, 'a second render does not repeat the switch (one-shot request)')
  render(GoalView, rootProps)
  assert.equal(rootOpens.length, 1, 'further renders stay quiet')

  // A request addressed to ANOTHER session never triggers this session.
  assert.equal(requestHome('someone-else'), true)
  render(GoalView, rootProps)
  assert.equal(rootOpens.length, 1, 'a request for another session does not fire here')
  assert.equal(consumeHomeRequest('someone-else'), true, 'the unrelated request is still pending for its own session')

  // Stale request (older than the 4 s TTL) is dropped, never fired.
  const realNow = Date.now
  const base = realNow()
  Date.now = () => base
  assert.equal(requestHome('root'), true)
  Date.now = () => base + 4001
  render(GoalView, rootProps)
  Date.now = realNow
  assert.equal(rootOpens.length, 1, 'a stale (>4000 ms) request never fires')
  assert.equal(consumeHomeRequest('root'), false, 'the stale request was cleared on read')
  console.log('✓ c child session: requestHome + openHome(root); root GoalView consumes once, no repeat, no cross-session, TTL')
}

// --- (d) control tab + guards ------------------------------------------------
{
  drain('root'); drain('child')
  const rootList = listFace({ root: { id: 'root' } })

  // Control tab consumes the same one-shot request.
  assert.equal(requestHome('root'), true)
  const opens = []
  const controlProps = controlViewProps({ sessionId: 'root', list: rootList, openView: (v, f) => opens.push([v, f]) })
  render(ControlView, controlProps)
  assert.deepEqual(opens, [['chat', 'cybernetics-home']], 'the control tab consumes the request too')
  render(ControlView, controlProps)
  assert.equal(opens.length, 1, 'the control tab switches once, not per render')

  // openView absent → no entry, no throw, pre-v0.18.1 shape.
  const bare = render(GoalView, goalViewProps({
    sessionId: 'child',
    list: listFace({ root: { id: 'root' }, child: { id: 'child', parentId: 'root' } }),
    own: { goals: [goalWire('g-bare')] },
  }))
  assert.equal(homeEntryButtons(bare.nodes).length, 0, 'no openView → no entry')
  assert.equal(bare.tree.props.children[0].props.style.display, 'flex', 'the board\'s first child is the pre-v0.18.1 badge row')

  // openHome absent (older host with uiWorkspace missing) → local switch,
  // no cross-session hop, and no stale home request.
  drain('root')
  const fallbackOpens = []
  const childList = listFace({ root: { id: 'root' }, child: { id: 'child', parentId: 'root' } })
  const out = render(GoalView, goalViewProps({
    sessionId: 'child',
    list: childList,
    openView: (v, f) => fallbackOpens.push([v, f]),
  }))
  const entry = homeEntryButtons(out.nodes)[0]
  assert.ok(entry, 'entry still renders when only openView is available')
  assert.doesNotThrow(() => entry.props.onClick(), 'missing openHome never throws')
  assert.deepEqual(fallbackOpens, [['chat', 'cybernetics-home']], 'missing openHome degrades to the local chat switch')
  assert.equal(consumeHomeRequest('root'), false, 'the degraded path queues no request for the root')

  // A throwing workspace service must not make the click dead.
  drain('root')
  const throwOpens = []
  const out2 = render(GoalView, goalViewProps({
    sessionId: 'child',
    list: childList,
    openView: (v, f) => throwOpens.push([v, f]),
    openHome: () => { throw new Error('workspace offline') },
  }))
  const entry2 = homeEntryButtons(out2.nodes)[0]
  assert.doesNotThrow(() => entry2.props.onClick(), 'a throwing openHome is contained')
  assert.deepEqual(throwOpens, [['chat', 'cybernetics-home']], 'the click falls back to the local chat switch')
  consumeHomeRequest('root') // the failed hop's request is left to expire; clear it here
  console.log('✓ d control consume + guards: no openView → no entry; missing/throwing openHome → local fallback')
}

// --- (e) request/consume primitives -----------------------------------------
{
  const realNow = Date.now
  const base = realNow()
  Date.now = () => base

  assert.equal(requestHome(''), false, 'empty id is rejected')
  assert.equal(requestHome(null), false, 'null id is rejected')
  assert.equal(requestHome(undefined), false, 'undefined id is rejected')
  assert.equal(requestHome(42), false, 'non-string id is rejected')
  assert.equal(consumeHomeRequest(''), false, 'empty id consumes nothing')
  assert.equal(consumeHomeRequest('never-requested'), false, 'unknown id consumes nothing')

  assert.equal(requestHome('prim'), true)
  assert.equal(consumeHomeRequest('prim'), true, 'a fresh request is consumed once')
  assert.equal(consumeHomeRequest('prim'), false, 'the key is deleted after consumption')

  // TTL boundary: exactly 4000 ms is still valid, 4001 ms is stale.
  assert.equal(requestHome('ttl-ok'), true)
  Date.now = () => base + 4000
  assert.equal(consumeHomeRequest('ttl-ok'), true, 'age == TTL is accepted')
  Date.now = () => base
  assert.equal(requestHome('ttl-stale'), true)
  Date.now = () => base + 4001
  assert.equal(consumeHomeRequest('ttl-stale'), false, 'age > TTL is rejected')
  assert.equal(consumeHomeRequest('ttl-stale'), false, 'and the stale key was deleted')

  Date.now = realNow
  console.log('✓ e primitives: invalid ids, one-shot delete, TTL boundary')
}

// --- (f) regression: entry first, goal rows + chips untouched ---------------
{
  drain('root')
  const clicks = []
  const own = {
    goals: [goalWire('g-chip', {
      updatedAt: 9,
      agents: [{ id: 'child-1', role: 'task', label: 'task:default', startedAt: 1 }],
    })],
  }
  const list = listFace({ root: { id: 'root' }, 'child-1': { id: 'child-1', parentId: 'root' } })
  const opens = []
  const out = render(GoalView, goalViewProps({
    sessionId: 'root',
    list,
    own,
    open: (agent) => clicks.push(agent),
    openView: (v, f) => opens.push([v, f]),
  }))
  const entries = homeEntryButtons(out.nodes)
  assert.equal(entries.length, 1, 'entry visible with goal data present')
  assert.equal(out.tree.props.children[0], entries[0], 'entry remains the first child of the tab content')
  assert.equal(entries[0].props.type, 'button', 'still a native button (keyboard reachable)')
  assert.equal(entries[0].props['aria-label'], '对话 · 回到主 agent 的对话', 'zh aria-label carries the new home hint')
  assert.match(textOf(entries[0]), /回到主 agent 的对话/, 'the hint states the destination')

  const rows = out.nodes.filter((n) => typeof n.type === 'function' && n.type.name === 'GoalRow')
  assert.equal(rows.length, 1, 'one goal row')
  assert.deepEqual(Object.keys(rows[0].props).sort(), ['goal', 'list', 'open', 'sessionId', 't', 'titles'],
    'GoalRow keeps exactly the pre-v0.18.3 props')
  const chip = out.nodes.find((n) => n.type === 'button' && typeof n.props['aria-label'] === 'string'
    && (n.props['aria-label'].includes('点击进入该智能体的对话界面') || n.props['aria-label'].includes('agents.openTip')))
  assert.ok(chip, 'the agent chip still renders')
  chip.props.onClick()
  assert.equal(clicks[0].id, 'child-1', 'the chip seam is unchanged')
  assert.equal(opens.length, 0, 'the chip never triggers the view switch')
  entries[0].props.onClick()
  assert.deepEqual(opens, [['chat', 'cybernetics-home']], 'the entry and the chips stay separate seams')
  console.log('✓ f regression: entry first, GoalRow props and chip behavior unchanged')
}

console.log('\nALL v0.18.3 HOME-ENTRY CHECKS PASSED')
