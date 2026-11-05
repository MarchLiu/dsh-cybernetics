// Offline harness test for dsh-cybernetics v0.14: per-goal「关联智能体」.
// Covers:
//   - server tracking (src/agents.ts): run→goal correlation, workflow
//     agent-start/agent-end folding, role derivation from labels, foreign-run
//     isolation, teammate recording, unlink semantics, live publishes,
//   - the projection wire (src/projection.ts): GoalView.agents normalization
//     and pass-through (both server fold and event-replay normalize),
//   - the client (lib/client.js): the agents line renders role + live status
//     chips from the projection + session list join; click-through is wired
//     through the injected open seam and disabled without it.
// Run: node test/v14-goal-agents.mjs

import assert from 'node:assert/strict'

// Client factory harness with a recording jsx (section 3 renders the seat's
// GoalView through it).
let factoryResult
const rendered = []
globalThis.window = globalThis.window || {}
globalThis.window.__ModuleLoader__ = {
  load(def) {
    const require = (id) => {
      if (id === 'react') {
        return {
          useState: (v) => [v, () => {}],
          useEffect: () => {},
          useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
        }
      }
      if (id === 'react/jsx-runtime') {
        // Recording jsx that INVOKES function components immediately (depth
        // first), so the rendered tree below is assertable offline.
        const record = (type, props) => {
          const node = { type, props }
          rendered.push(node)
          if (typeof type === 'function') node.result = type(props)
          return node.result !== undefined ? node.result : node
        }
        return {
          jsx: (type, props) => record(type, props),
          jsxs: (type, props) => record(type, props),
        }
      }
      throw new Error('unexpected require: ' + id)
    }
    factoryResult = def.factory(require)
  },
}
await import('../lib/client.js')

// The seat registration's component capture (populated in section 4, used by
// section 3's render — sections run in file order, so declare the binding here).
let section4GoalView

// --- 1. server tracking ------------------------------------------------------
const agentMod = await import('../src/agents.ts')
const { setRecordAppender } = await import('../src/projection.ts')
{
  const sess = { id: 'sess-1', append() {} }
  const loop = { goalId: 'cyb-a', round: 0, doneSummary: '', subgoal: 's', role: 'default' }
  const boards = new Map([[sess, new Map([['cyb-a', loop]])]])
  agentMod.setBoardSource(() => boards)
  const published = []
  setRecordAppender((session, type, data) => { published.push({ type, goals: data.goals }) })

  agentMod.linkRunToGoal('run-a', sess, 'cyb-a')
  const started = agentMod.noteWorkflowAgent({ id: 'run-a' }, { seq: 1, label: 'task:default', childId: 'child-task' }, undefined)
  assert.ok(started, 'agent-start folds when the run is correlated')
  const verified = agentMod.noteWorkflowAgent({ id: 'run-a' }, { seq: 2, label: 'verify', childId: 'child-verify' }, undefined)
  const triaged = agentMod.noteWorkflowAgent({ id: 'run-a' }, { seq: 3, label: 'triage', childId: 'child-triage' }, undefined)
  const ended = agentMod.noteWorkflowAgent({ id: 'run-a' }, { seq: 3, label: 'triage', childId: 'child-triage' }, 'completed')
  assert.ok(verified && triaged && ended, 'agent-end folds the outcome')

  // Foreign runs (other workflows sharing the engine) never leak in.
  const foreign = agentMod.noteWorkflowAgent({ id: 'someone-else' }, { label: 'x', childId: 'zzz' }, undefined)
  assert.ok(!foreign, 'uncorrelated run ignored')

  // Dedupe by child id: a re-recorded verify stays one record.
  agentMod.noteWorkflowAgent({ id: 'run-a' }, { seq: 2, label: 'verify', childId: 'child-verify' }, 'failed')
  const verifyRec = loop.agents.find((a) => a.id === 'child-verify')
  assert.equal(loop.agents.filter((a) => a.id === 'child-verify').length, 1, 'one record per child id')
  // Outcome folds once (first settlement wins; re-ends never rewrite it).
  agentMod.noteWorkflowAgent({ id: 'run-a' }, { seq: 2, label: 'verify', childId: 'child-verify' }, 'completed')
  assert.equal(verifyRec.outcome, 'failed', 'first settlement wins')

  // Roles derive from round.js labels.
  const roles = Object.fromEntries(loop.agents.map((a) => [a.childId ?? a.id, a.role]))
  assert.equal(roles['child-task'], 'task')
  assert.equal(roles['child-verify'], 'verify')
  assert.equal(roles['child-triage'], 'triage')
  assert.equal(agentMod.roleOfLabel('task:frontend'), 'task', 'named task role maps to task')
  assert.equal(agentMod.roleOfLabel('some prompt snippet'), 'task', 'default label maps to task')

  // Persistent teammate records directly (no run link applies).
  const member = agentMod.noteTeamMember(sess, 'cyb-a', 'member-1', 'cyb-a')
  assert.ok(member, 'teammate recorded')
  assert.ok(loop.agents.some((a) => a.id === 'member-1' && a.role === 'task'), 'teammate role = task')

  // Publishes are live per change and carry the whole wire board.
  assert.equal(published.length, 6, 'one publish per tracked change')
  assert.equal(published[0].type, 'plugin:cybernetics/goals', 'the goals event type')
  const wireAgents = published[5].goals.find((g) => g.goalId === 'cyb-a').agents
  assert.equal(wireAgents.length, 4, 'wire carries the aggregated agents')

  // unlink stops tracking for the retired run.
  agentMod.unlinkRun('run-a')
  const afterUnlink = agentMod.noteWorkflowAgent({ id: 'run-a' }, { label: 'x', childId: 'post-end' }, undefined)
  assert.ok(!afterUnlink, 'unlinked run ignored')

  // Malformed events are contained (never throw, never record).
  assert.ok(!agentMod.noteWorkflowAgent(null, null, undefined), 'null payloads contained')
  assert.ok(!agentMod.noteWorkflowAgent({ id: 'run-a' }, { childId: '' }, undefined), 'empty childId contained')

  console.log('✓ 1 server tracking: correlation, roles, dedupe, teammate, publish, containment')
}

// --- 2. projection wire ------------------------------------------------------
const proj = await import('../src/projection.ts')
{
  const state = proj.goalsFromBoard([{
    goalId: 'cyb-b', round: 2, doneSummary: '', subgoal: 's', role: 'default',
    agents: [
      { id: 'a1', role: 'task', label: 'task:default', startedAt: 1 },
      { id: 'a2', role: 'verify', label: 'verify', startedAt: 2, outcome: 'failed', endedAt: 3 },
      { id: '', role: 'task', label: 'x', startedAt: 4 }, // dropped: no id
    ],
  }])
  const goal = state.goals[0]
  assert.equal(goal.agents.length, 2, 'malformed agent entries dropped in the server fold')
  assert.equal(goal.agents[1].outcome, 'failed', 'outcome passes through')

  // Event-replay normalization: the projection's apply() normalizes a wire
  // board exactly like the server fold (the restarted-host path).
  const definition = proj.cyberneticsGoalsProjection()
  const replayed = definition.apply(proj.emptyGoalsState(), {
    type: 'plugin:cybernetics/goals',
    data: { goals: [{ goalId: 'cyb-b', status: 'running', round: 1, depth: 'full', executor: 'ephemeral', updatedAt: 5, agents: [{ id: 'a1', role: 'verify', label: 'verify', startedAt: 1 }] }] },
  })
  assert.equal(replayed.goals[0].agents.length, 1, 'agents survive the replay fold')
  assert.equal(replayed.goals[0].agents[0].role, 'verify', 'replayed agent fields normalized')

  // Legacy event type folds too; unrelated events keep the state reference.
  const legacy = definition.apply(proj.emptyGoalsState(), {
    type: 'cybernetics/goals',
    data: { goals: [{ goalId: 'g', status: 'paused', round: 0, depth: 'quick', executor: 'ephemeral', updatedAt: 1, agents: [] }] },
  })
  assert.equal(legacy.goals[0].agents.length, 0, 'legacy event type accepted')
  assert.equal(definition.apply(replayed, { type: 'unrelated/event' }), replayed, 'unrelated events keep the reference')

  console.log('✓ 2 projection wire: server fold + replay normalization + legacy type')
}

// --- 4. seat apply: the goal tab passes list/sessionId/open ------------------
{
  const seats = []
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => {}, bind: () => (k) => k },
    slots: {
      inject: (name, fn) => seats.push({ name, seat: fn() }),
      register: (def, component) => { def.__component = component; return def },
    },
    sessions: {
      binding: (id) => ({ session: { projections: { faceOf: (key) => ({ key, subscribe: () => () => {}, getSnapshot: () => ({ goals: [] }) }) } } }),
      list: { getSnapshot: () => ({ byId: {}, projectionsBySession: {} }) },
    },
    uiWorkspace: { openSession: () => {} },
  }
  factoryResult.apply(ctx)
  const goalSeat = seats.find((s) => s.name === 'conversation.view' && s.seat.id === 'cybernetics-goal')
  assert.ok(goalSeat, 'goal tab seat registered')
  assert.equal(typeof goalSeat.seat.__component, 'function', 'seat carries the GoalView component')
  section4GoalView = goalSeat.seat.__component
  const injected = goalSeat.seat.inject('root')
  assert.ok(injected.sessionId === 'root', 'goal tab receives sessionId')
  assert.ok(injected.sessions === ctx.sessions, 'goal tab receives the sessions store')
  assert.equal(typeof injected.open, 'function', 'open seam provided when uiWorkspace exists')
  // The open seam routes through uiWorkspace.openSession with a durable
  // direct-parent subagent address (mode from the catalog, else 'unknown').
  let address
  ctx.uiWorkspace.openSession = (a) => { address = a }
  injected.open({ id: 'child-1' })
  assert.deepEqual(address, { parentSessionId: 'root', childSessionId: 'child-1', mode: 'unknown' }, 'unknown-mode address for unlisted children')
  ctx.sessions.list.getSnapshot = () => ({ byId: {}, projectionsBySession: { root: { values: { subagentCatalog: [{ id: 'child-1', mode: 'continuable' }] } } } })
  injected.open({ id: 'child-1' })
  assert.equal(address.mode, 'continuable', 'catalog mode wins when listed')
  // Without the uiWorkspace namespace the open seam is undefined (chips render
  // disabled instead of throwing).
  delete ctx.uiWorkspace
  const seats2 = []
  ctx.slots.inject = (name, fn) => seats2.push({ name, seat: fn() })
  factoryResult.apply(ctx)
  const goalSeat2 = seats2.find((s) => s.name === 'conversation.view' && s.seat.id === 'cybernetics-goal')
  assert.equal(goalSeat2.seat.inject('root').open, undefined, 'open undefined without uiWorkspace')
  console.log('✓ 4 seat apply: list/sessionId/open wiring + address shape + absent-namespace fallback')
}

// --- 3. client rendering: the goal agents line -------------------------------
{
  const t = (key) => key
  const goalsFace = { subscribe: () => () => {}, getSnapshot: () => ({
    goals: [
      {
        goalId: 'cyb-x', title: 'T', objective: '', status: 'running', depth: 'full', executor: 'ephemeral',
        round: 1, updatedAt: 1,
        agents: [
          { id: 'a-live', role: 'task', label: 'task:default', startedAt: 1 },
          { id: 'a-done', role: 'verify', label: 'verify', startedAt: 1, outcome: 'completed', endedAt: 2 },
          { id: 'a-bad', role: 'triage', label: 'triage', startedAt: 1, outcome: 'failed', endedAt: 2 },
          { id: 'a-ghost', role: 'task', label: 'task:default', startedAt: 1 },
        ],
      },
      { goalId: 'cyb-plain', title: 'P', objective: '', status: 'paused', depth: 'quick', executor: 'ephemeral', round: 0, updatedAt: 0 },
    ],
  }) }
  const goalFace = { subscribe: () => () => {}, getSnapshot: () => undefined }
  const list = {
    byId: { 'a-live': { running: true } },
    projectionsBySession: { root: { values: { subagentCatalog: [{ id: 'a-live', mode: 'continuable', activity: 'running' }] } } },
  }
  const clicks = []
  rendered.length = 0
  const seat = { __component: null }
  // Drive the registered GoalView component directly (captured in section 4's
  // shape; register() recorded it via def.__component).
  // Render through the same props shape the seat inject returns.
  const props = { t, goals: goalsFace, goal: goalFace, sessionId: 'root', list, open: (a) => clicks.push(a) }
  // GoalView is closure-private; the seat apply below proves the wiring, and
  // here we render the GoalsList path through the registered component captured
  // from the previous section run. To keep this harness self-contained, invoke
  // the component captured by the seat registration in section 4 — order
  // matters, so this section runs AFTER section 4 populated goalSeat.
  assert.ok(section4GoalView !== undefined, 'GoalView captured by the seat registration')
  section4GoalView(props)
  // The agents line renders once per goal with agents, none for the plain goal.
  const agentLines = rendered.filter((n) => n.props && n.props.style === undefined && n.props.agents !== undefined)
  assert.ok(clicks.length === 0, 'no clicks on render')
  // Find the chips in the rendered tree: buttons with an aria-label naming the
  // status, one per agent of cyb-x only.
  const chips = rendered.filter((n) => n.type === 'button' && typeof n.props['aria-label'] === 'string'
    && (n.props['aria-label'].includes('agentStatus.running')
      || n.props['aria-label'].includes('agentStatus.completed')
      || n.props['aria-label'].includes('agentStatus.failed')
      || n.props['aria-label'].includes('agentStatus.unknown')))
  assert.equal(chips.length, 4, 'one chip per recorded agent')
  // Live join: a-listed running wins over the absent outcome (a-live has no
  // outcome but IS running in the session list → running, and clickable).
  const live = chips.find((n) => n.props['aria-label'].includes('task:default') && n.props['aria-label'].includes('agentStatus.running'))
  assert.ok(live, 'live agent renders the running status')
  assert.equal(live.props.disabled, false, 'clickable when the open seam exists')
  live.props.onClick()
  // Section 3's `open` is a recording stub: the chip hands over the agent
  // record; the seat-level address mapping is proven in section 4.
  assert.equal(clicks.length, 1, 'chip click invokes the open seam once')
  assert.equal(clicks[0].id, 'a-live', 'chip click hands over the clicked agent record')
  // Outcome statuses render without a live row.
  assert.ok(chips.some((n) => n.props['aria-label'].includes('agentStatus.completed')), 'completed status renders')
  assert.ok(chips.some((n => n.props['aria-label'].includes('agentStatus.failed'))), 'failed status renders')
  console.log('✓ 3 client rendering: agents line chips with live status + click-through')
}


console.log('\nALL v0.14.0 GOAL-AGENTS CHECKS PASSED')
