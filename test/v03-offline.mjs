// Offline harness test for dsh-cybernetics v0.3: exercises every tool action
// (list / round / start / collect / cancel) against a fake host ctx and a
// controllable fake workflow engine — no DSH runtime required.
// Run: node test/v03-offline.mjs

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { cyberneticsGoalsProjection, goalsFromBoard, publishGoals } from '../src/projection.ts'

// --- fake workflow engine ---------------------------------------------------
function fakeEngine() {
  const runs = []
  return {
    runs,
    start(request) {
      let settle
      const result = new Promise((resolve) => { settle = resolve })
      const run = {
        request,
        result,
        cancelled: false,
        disposed: false,
        settle(value) { settle(value) },
        cancel(reason) {
          run.cancelled = true
          settle({ stopReason: 'cancelled', error: reason })
        },
        async dispose() { run.disposed = true },
      }
      runs.push(run)
      return run
    },
  }
}

// --- fake host ctx ------------------------------------------------------------
function fakeHost(engine, { activeGoal } = {}) {
  const tools = []
  const followups = []
  const createdGoals = []
  const parent = {
    session: { id: 'sess-test' },
    followup(message) { followups.push(message) },
  }
  const rootPromise = mkdtemp(join(tmpdir(), 'cyb-test-'))
  const ctx = {
    tools: { register: (d) => { tools.push(d); return () => {} } },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: {
      get: () => activeGoal ?? null,
      create: (_agent, input) => { createdGoals.push(input); return { id: 'goal-focused' } },
    },
    workingDirectory: { get: () => '__PENDING__' },
    agentPresets: { serviceFor: (_agent, name) => (name === 'workflowEngine' ? engine : undefined) },
  }
  // workingDirectory.get must be sync in the plugin; pre-resolve the tmp dir.
  return { ctx, tools, followups, createdGoals, parent, rootPromise }
}

const engine = fakeEngine()
const { ctx, tools, followups, createdGoals, parent } = fakeHost(engine)
const root = await mkdtemp(join(tmpdir(), 'cyb-test-'))
ctx.workingDirectory = { get: () => root }

let section
ctx.systemPrompt.section = (s) => { section = s }
apply(ctx, {})
const tool = tools[0]
const exec = { agent: parent, signal: undefined }

// 1. list on an empty board
{
  const out = await tool.execute({ action: 'list' }, exec)
  assert.deepEqual(out.board, [], 'empty board')
  console.log('✓ 1 list: empty board')
}

// 2. round with no goal anywhere → guard error
{
  await assert.rejects(
    () => tool.execute({ action: 'round' }, exec),
    /no active session goal/,
  )
  console.log('✓ 2 guard: no goal resolved → structured error')
}

// 3. start creates a new goal and launches a background round
let goalId
{
  const out = await tool.execute({
    action: 'start', title: '测试任务A', brief: '完整工作委托书：做 X，验收 Y',
  }, exec)
  assert.equal(out.started, true)
  assert.match(out.goalId, /^cyb-/)
  assert.equal(out.round, 1)
  goalId = out.goalId
  assert.equal(engine.runs.length, 1, 'one workflow run started')
  assert.equal(engine.runs[0].request.args.brief, '完整工作委托书：做 X，验收 Y', 'brief passed through')
  assert.equal(createdGoals.length, 1, 'focus goal synced into dsh-goal (slot was free)')
  assert.match(createdGoals[0].objective, /测试任务A/)
  console.log('✓ 3 start: goal created, background round launched, brief透传, focus synced')
}

// 4. collect before settle → pending
{
  const out = await tool.execute({ action: 'collect', goalId }, exec)
  assert.equal(out.pending, true)
  console.log('✓ 4 collect (running): pending')
}

// 5. settle the run → completion notice queued into the session inbox
{
  const roundResult = {
    round: 1,
    report: { summary: '做完了一半', done: false, artifacts: [], evidence: 'e', nextStepThoughts: ['继续另一半'] },
    verdict: { met: false, criteria: [], gaps: ['另一半没做'], goalItselfQuestionable: false },
    triage: { auto: [], defer: [], reject: [], human: [] },
  }
  engine.runs[0].settle({ stopReason: 'completed', value: roundResult })
  await new Promise((r) => setImmediate(r))
  assert.equal(followups.length, 1, 'one completion notice queued')
  assert.equal(followups[0].role, 'user')
  assert.equal(followups[0].source.kind, 'cybernetics')
  assert.equal(followups[0].source.goalId, goalId)
  assert.match(followups[0].content[0].text, /collect/)
  console.log('✓ 5 settle: agent.followup completion notice queued')
}

// 6. collect folds the settled round into a continue decision + audit log
{
  const out = await tool.execute({ action: 'collect', goalId }, exec)
  assert.equal(out.decision.action, 'continue')
  assert.match(out.decision.subgoal, /另一半没做/, 'subgoal derived from gaps')
  const log = JSON.parse(await readFile(join(root, '.cybernetics', `round-${goalId}-1.json`), 'utf8'))
  assert.equal(log.report.summary, '做完了一半', 'audit log written (goal-scoped filename)')
  console.log(`✓ 6 collect: continue decision from gaps, round-${goalId}-1.json audit log落盘`)
}

// 7. start a second round then cancel it (correction-interrupt path)
{
  const out = await tool.execute({ action: 'start', goalId, brief: '修正：方向改为 Z' }, exec)
  assert.equal(out.round, 2)
  const c = await tool.execute({ action: 'cancel', goalId, brief: '用户打断：方向改为 Z' }, exec)
  assert.ok(c.cancelled)
  await new Promise((r) => setImmediate(r))
  const collected = await tool.execute({ action: 'collect', goalId }, exec)
  assert.equal(collected.decision.action, 'pause')
  assert.equal(collected.decision.reason, 'failed')
  assert.match(collected.result.failed, /cancelled/)
  console.log('✓ 7 cancel: in-flight round aborted, collect folds cancelled outcome')
}

// 8. blocking round on a SECOND goal; met verdict → pause(met), status tracked
// (blocking: schedule the settle first, then await the execute promise)
{
  const p = tool.execute({ action: 'round', title: '测试任务B', brief: '委托书B' }, exec)
  // Wait until the execute path has actually started the run (readFile is async).
  const before = engine.runs.length
  for (let i = 0; i < 100 && engine.runs.length === before; i++) {
    await new Promise((r) => setImmediate(r))
  }
  const runB = engine.runs.at(-1)
  runB.settle({
    stopReason: 'completed',
    value: {
      round: 1,
      report: { summary: 'B 全部完成', done: true, artifacts: ['x'], evidence: 'e', nextStepThoughts: [] },
      verdict: { met: true, criteria: [], gaps: [], goalItselfQuestionable: false },
      triage: { auto: [], defer: [], reject: [], human: [] },
    },
  })
  const out = await p
  assert.equal(out.decision.action, 'pause')
  assert.equal(out.decision.reason, 'met')
  assert.ok(out.goalId !== goalId, 'second goal has its own id')
  console.log('✓ 8 round (blocking): second goal, met → pause(met)')
}

// 9. list shows both goals with divergent status
{
  const out = await tool.execute({ action: 'list' }, exec)
  assert.equal(out.board.length, 2)
  const a = out.board.find((g) => g.goalId === goalId)
  const b = out.board.find((g) => g.goalId !== goalId)
  assert.equal(a.round, 2)
  assert.equal(a.running, false)
  assert.match(a.subgoal, /另一半没做/, 'goal A keeps its own subgoal across B\'s rounds')
  assert.equal(b.status, 'met')
  console.log('✓ 9 list: two goals coexist with independent state')
}

// 10. guidance section encodes the orchestrator protocol
{
  assert.match(section.text, /never execute task work/i)
  assert.match(section.text, /TRIVIAL READ-ONLY QUESTION/)
  assert.match(section.text, /LIGHTWEIGHT ANALYSIS/)
  assert.match(section.text, /COMPLEX ANALYSIS/)
  assert.match(section.text, /CORRECTION/)
  assert.match(section.text, /cancel/)
  console.log('✓ 10 guidance: orchestrator protocol injected')
}

// 11. hard gate: assemble waterfall strips execution tools from ROOT agents only
{
  const rootAgent = { id: 'agent-root' }
  const childAgent = { id: 'agent-child' }
  const listeners = []
  const ctx2 = {
    tools: { register: () => () => {} },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null },
    workingDirectory: { get: () => root },
    agentPresets: { serviceFor: () => undefined },
    agents: { roots: () => [rootAgent] },
    on: (event, fn) => { listeners.push({ event, fn }); return () => {} },
  }
  apply(ctx2, { hardGate: true })
  const gate = listeners.find((l) => l.event === 'system-prompt/assemble')
  assert.ok(gate, 'hard gate listener registered')
  const mkAssembly = () => ({
    tools: [{ name: 'bash' }, { name: 'edit' }, { name: 'write' }, { name: 'read' }, { name: 'cybernetics' }],
  })
  // root agent: gated tools stripped, orchestration/read tools kept
  const a1 = mkAssembly()
  await gate.fn(a1, { scope: rootAgent }, () => a1)
  assert.deepEqual(a1.tools.map((t) => t.name), ['read', 'cybernetics'])
  // workflow child agent: untouched
  const a2 = mkAssembly()
  await gate.fn(a2, { scope: childAgent }, () => a2)
  assert.equal(a2.tools.length, 5)
  // scope-less assembly: untouched
  const a3 = mkAssembly()
  await gate.fn(a3, {}, () => a3)
  assert.equal(a3.tools.length, 5)
  console.log('✓ 11 hard gate: root agent stripped of bash/edit/write; child agents untouched')
}

// 12. hard gate off by default: no listener registered
{
  const listeners2 = []
  const ctx3 = {
    tools: { register: () => () => {} },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null },
    workingDirectory: { get: () => root },
    agentPresets: { serviceFor: () => undefined },
    agents: { roots: () => [] },
    on: (event, fn) => { listeners2.push({ event, fn }); return () => {} },
  }
  apply(ctx3, {})
  assert.equal(listeners2.filter((l) => l.event === 'system-prompt/assemble').length, 0)
  console.log('✓ 12 hard gate off by default: no assemble listener')
}

// 13. allowlist mode: only reads/orchestration survive on root agents;
//     farm_unregister (the live-found gap) is hidden; cybernetics always survives
{
  const rootAgent = { id: 'agent-root' }
  const listeners3 = []
  const ctx4 = {
    tools: { register: () => () => {} },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null },
    workingDirectory: { get: () => root },
    agentPresets: { serviceFor: () => undefined },
    agents: { roots: () => [rootAgent] },
    on: (event, fn) => { listeners3.push({ event, fn }); return () => {} },
  }
  apply(ctx4, { hardGate: true, gateMode: 'allowlist' })
  const gate3 = listeners3.find((l) => l.event === 'system-prompt/assemble')
  const assembly = {
    tools: [
      { name: 'farm_unregister' }, { name: 'farm_status' }, { name: 'taskboard_update' },
      { name: 'taskboard_list' }, { name: 'knowledge_save' }, { name: 'knowledge_query' },
      { name: 'bash' }, { name: 'edit' }, { name: 'read' }, { name: 'subagent' },
      { name: 'cybernetics' }, { name: 'create_goal' }, { name: 'schedule_create' },
    ],
  }
  await gate3.fn(assembly, { scope: rootAgent }, () => assembly)
  const names = assembly.tools.map((t) => t.name)
  assert.deepEqual(names.sort(), ['create_goal', 'cybernetics', 'farm_status', 'knowledge_query', 'read', 'taskboard_list'].sort(),
    'mutations hidden, reads/orchestration survive')
  console.log('✓ 13 allowlist mode: farm_unregister/subagent/bash hidden; reads+cybernetics survive')
}

// 14. round.js depth='quick': only the task agent runs; verdict derived from report
{
  const code = await readFile(new URL('../workflows/round.js', import.meta.url), 'utf8')
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push(opts?.label ?? '?')
    return { summary: '轻量分析结论', done: true, artifacts: [], evidence: 'e', nextStepThoughts: [] }
  }
  const fn = new (async function () {}.constructor)('agent', 'phase', 'args', 'log', code)
  const out = await fn(agent, async () => {}, {
    goal: { objective: 'O' }, state: { round: 1, doneSummary: '' },
    subgoal: 'S', brief: 'B', depth: 'quick', roles: {},
  }, () => {})
  assert.deepEqual(calls, ['task:default'], 'quick: only task agent')
  assert.equal(out.verdict.met, true)
  assert.equal(out.verdict.quick, true)
  console.log('✓ 14 quick depth: single task agent, verdict derived, verify/triage skipped')
}

// 15. round.js depth='full' (default): all three agents run in order
{
  const code = await readFile(new URL('../workflows/round.js', import.meta.url), 'utf8')
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push(opts?.label ?? '?')
    if (calls.length === 1) return { summary: 's', done: true, artifacts: [], evidence: 'e', nextStepThoughts: [] }
    if (calls.length === 2) return { met: true, criteria: [], gaps: [], goalItselfQuestionable: false }
    return { auto: [], defer: [], reject: [], human: [] }
  }
  const fn = new (async function () {}.constructor)('agent', 'phase', 'args', 'log', code)
  const out = await fn(agent, async () => {}, {
    goal: { objective: 'O' }, state: { round: 1, doneSummary: '' },
    subgoal: 'S', brief: 'B', roles: {},
  }, () => {})
  assert.deepEqual(calls, ['task:default', 'verify', 'triage'], 'full: three agents in order')
  assert.equal(out.verdict.met, true)
  console.log('✓ 15 full depth (default): task→verify→triage complete loop')
}

// 16. gateAllowlistExtra unions onto the default survival set
{
  const rootAgent = { id: 'agent-root' }
  const listeners4 = []
  const ctx5 = {
    tools: { register: () => () => {} },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null },
    workingDirectory: { get: () => root },
    agentPresets: { serviceFor: () => undefined },
    agents: { roots: () => [rootAgent] },
    on: (event, fn) => { listeners4.push({ event, fn }); return () => {} },
  }
  apply(ctx5, { hardGate: true, gateMode: 'allowlist', gateAllowlistExtra: ['spawn_teammate', 'send_message'] })
  const gate4 = listeners4.find((l) => l.event === 'system-prompt/assemble')
  const assembly = {
    tools: [{ name: 'spawn_teammate' }, { name: 'send_message' }, { name: 'farm_unregister' }, { name: 'read' }, { name: 'cybernetics' }],
  }
  await gate4.fn(assembly, { scope: rootAgent }, () => assembly)
  assert.deepEqual(assembly.tools.map((t) => t.name).sort(), ['cybernetics', 'read', 'send_message', 'spawn_teammate'].sort())
  console.log('✓ 16 gateAllowlistExtra: team verbs join the default allowlist')
}

// 17. v0.6 projection unit: registered under `cyberneticsGoals`, folds its own
//     whole-value events, keeps state identity for every unrelated event
{
  const registered = []
  const ctx7 = {
    tools: { register: () => () => {} },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null },
    workingDirectory: { get: () => root },
    agentPresets: { serviceFor: () => undefined },
    agents: { roots: () => [] },
    sessionProjections: {
      register: (definition) => { registered.push(definition); return () => {} },
    },
  }
  apply(ctx7, { implicitTrigger: false })
  assert.equal(registered.length, 1, 'projection unit registered exactly once')
  const unit = registered[0]
  assert.equal(unit.key, 'cyberneticsGoals', 'projection key drives client faceOf()')
  assert.deepEqual(unit.init(), { goals: [] }, 'empty session starts with an empty board')
  assert.equal(Number.isInteger(unit.stateVersion), true, 'stateVersion declared for the persisted cache')
  assert.equal(typeof unit.wire.view, 'function')
  assert.equal(typeof unit.wire.viewSchema.parse, 'function', 'wire schema is a .parse duck type')
  const goalV = {
    goalId: 'cyb-1', title: 'T', objective: 'O', status: 'running', depth: 'full',
    executor: 'ephemeral', round: 1, subgoal: 'S', revisions: [], updatedAt: 123,
  }
  const state0 = unit.init()
  const state1 = unit.apply(state0, { type: 'cybernetics/goals', data: { goals: [goalV] } })
  assert.notStrictEqual(state1, state0, 'owned event produces a new state')
  assert.equal(state1.goals.length, 1)
  assert.equal(state1.goals[0].goalId, 'cyb-1')
  assert.strictEqual(unit.apply(state1, { type: 'user/message', data: {} }), state1,
    'unrelated event: same state reference (host zero-work fast path)')
  assert.strictEqual(unit.apply(state1, { type: 'goal/change', data: {} }), state1,
    'dsh-goal events are not ours')
  assert.strictEqual(unit.wire.view(unit.wire.viewSchema.parse(state1)), state1, 'wire view is a passthrough')
  console.log('✓ 17 projection unit: key cyberneticsGoals, whole-value fold, unrelated events keep reference')
}

// 18. v0.6 write points: goal creation + round start + settlement each append a
//     `cybernetics/goals` event carrying the session's WHOLE board
{
  const appends = []
  const tools8 = []
  const engine8 = fakeEngine()
  const parent8 = {
    session: {
      id: 'sess-proj',
      append(type, data) {
        const event = { type, data: JSON.parse(JSON.stringify(data)), seq: appends.length + 1 }
        appends.push(event)
        return event
      },
    },
    followup() {},
  }
  const ctx8 = {
    tools: { register: (d) => { tools8.push(d); return () => {} } },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null, create: () => ({ id: 'goal-focused' }) },
    workingDirectory: { get: () => root },
    agentPresets: { serviceFor: () => engine8 },
    agents: { roots: () => [] },
    sessionProjections: { register: () => () => {} },
  }
  apply(ctx8, {})
  const tool8 = tools8[0]
  const exec8 = { agent: parent8, signal: undefined }
  const goalEvents = () => appends.filter((e) => e.type === 'cybernetics/goals')

  // creation + background round start
  const a = await tool8.execute({ action: 'start', title: '投影任务A', brief: '委托书A' }, exec8)
  assert.ok(goalEvents().length >= 1, 'goal creation published a cybernetics/goals event')
  const atStart = goalEvents().at(-1).data
  assert.equal(atStart.goals.length, 1, 'payload carries the whole board')
  assert.equal(atStart.goals[0].goalId, a.goalId)
  assert.equal(atStart.goals[0].title, '投影任务A')
  assert.equal(atStart.goals[0].status, 'running', 'in-flight round is visible as running')
  assert.equal(atStart.goals[0].round, 0)

  // round settlement folded by collect
  engine8.runs[0].settle({
    stopReason: 'completed',
    value: {
      round: 1,
      report: { summary: 'A 半成', done: false, artifacts: [], evidence: 'e', nextStepThoughts: [] },
      verdict: { met: false, criteria: [], gaps: ['缺口X'], goalItselfQuestionable: false },
      triage: { auto: [], defer: [], reject: [], human: [] },
    },
  })
  await new Promise((r) => setImmediate(r))
  await tool8.execute({ action: 'collect', goalId: a.goalId }, exec8)
  const afterSettle = goalEvents().at(-1).data
  assert.equal(afterSettle.goals.length, 1)
  assert.equal(afterSettle.goals[0].round, 1, 'settlement publish carries the advanced round')
  assert.equal(afterSettle.goals[0].status, 'paused')
  assert.match(afterSettle.goals[0].subgoal, /缺口X/)

  // a second goal: the same event now carries BOTH goals (multi-goal invariant)
  const p = tool8.execute({ action: 'round', title: '投影任务B', brief: '委托书B' }, exec8)
  const before = engine8.runs.length
  for (let i = 0; i < 100 && engine8.runs.length === before; i++) await new Promise((r) => setImmediate(r))
  engine8.runs.at(-1).settle({
    stopReason: 'completed',
    value: {
      round: 1,
      report: { summary: 'B 完成', done: true, artifacts: [], evidence: 'e', nextStepThoughts: [] },
      verdict: { met: true, criteria: [], gaps: [], goalItselfQuestionable: false },
      triage: { auto: [], defer: [], reject: [], human: [] },
    },
  })
  const b = await p
  const afterB = goalEvents().at(-1).data
  assert.equal(afterB.goals.length, 2, 'every publish is a whole-board snapshot')
  assert.deepEqual(
    afterB.goals.map((g) => g.goalId).sort(),
    [a.goalId, b.goalId].sort(),
    'both goals of the session are tracked',
  )
  assert.equal(afterB.goals.find((g) => g.goalId === b.goalId).status, 'met')
  console.log(`✓ 18 write points: creation/start/collect append cybernetics/goals (${goalEvents().length} publishes, whole board)`)
}

// 19. v0.6 publishGoals: safe without a session, idempotent for the same state
{
  assert.equal(publishGoals(undefined, { goals: [] }), 'skipped', 'no session: no-op')
  assert.equal(publishGoals(null, { goals: [] }), 'skipped', 'null session: no-op')
  assert.equal(publishGoals({ id: 'no-append' }, { goals: [] }), 'skipped', 'session without append: no-op')
  const written = []
  const sess = { append: (type, data) => { written.push({ type, data }); return {} } }
  const state = {
    goals: [{
      goalId: 'cyb-x', title: 'X', objective: 'o', status: 'paused', depth: 'full',
      executor: 'ephemeral', round: 2, revisions: [], updatedAt: 7,
    }],
  }
  assert.equal(publishGoals(sess, state), 'published')
  assert.equal(publishGoals(sess, JSON.parse(JSON.stringify(state))), 'unchanged',
    'same state republished: no duplicate event')
  assert.equal(written.length, 1)
  assert.equal(written[0].type, 'cybernetics/goals')
  assert.equal(written[0].data.goals[0].goalId, 'cyb-x')
  console.log('✓ 19 publishGoals: session-less no-op, identical republish is a true no-op')
}

// 20. v0.6 goalsFromBoard: status mapping, defaults, stable updatedAt (sort key)
{
  const loops = [
    {
      goalId: 'g-failed', title: 'F', objective: 'of', round: 2, doneSummary: '', subgoal: 'sf',
      role: 'default', status: 'paused', paused: { reason: 'failed', note: 'boom' }, depth: 'quick',
    },
    { goalId: 'g-new', title: 'N', objective: 'on', round: 0, doneSummary: '', subgoal: 'sn', role: 'default' },
  ]
  const snap = goalsFromBoard(loops, 1000)
  assert.equal(snap.goals.length, 2)
  const failed = snap.goals.find((g) => g.goalId === 'g-failed')
  const fresh = snap.goals.find((g) => g.goalId === 'g-new')
  assert.equal(failed.status, 'failed', 'paused(failed) surfaces as failed for the tab badge')
  assert.equal(failed.depth, 'quick')
  assert.equal(failed.executor, 'ephemeral', 'executor defaults to the workflow agent until v0.6 adapter')
  assert.deepEqual(failed.revisions, [])
  assert.equal(fresh.status, 'pending', 'a board goal with no round yet is pending')
  assert.equal(fresh.depth, 'full', 'depth defaults to full')
  assert.equal(failed.updatedAt, 1000)
  const again = goalsFromBoard(loops, 2000)
  assert.equal(again.goals.find((g) => g.goalId === 'g-failed').updatedAt, 1000,
    'unchanged content keeps its updatedAt (idempotent publish precondition)')
  console.log('✓ 20 goalsFromBoard: status/depth/executor mapping, stable updatedAt ordering key')
}

// 21. v0.6 client tab wiring: reads the multi-goal face, keeps the single-goal
//     fallback (client.js is loaded verbatim by the ModuleLoader — text check)
{
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /faceOf\('cyberneticsGoals'\)/, '目标 tab subscribes to the multi-goal projection')
  assert.match(client, /faceOf\('goal'\)/, 'dsh-goal single-slot face kept as fallback')
  assert.match(client, /goalStatus\.running/, 'status badge locale keys present')
  assert.match(client, /useSyncExternalStore/, 'in-place updates via projection snapshots, no polling')
  console.log('✓ 21 client tab: cyberneticsGoals face + goal fallback, live snapshots, status locales')
}

// 22. v0.6 client tab render (offline, stubbed react/jsx-runtime): the multi-goal
//     list renders every goal newest-first with its badges, and an absent
//     projection falls back to the dsh-goal single-goal rendering
{
  const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded
  globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m } } }
  new Function('window', src)(globalThis.window)
  assert.ok(loaded, 'client module registered with the ModuleLoader')

  const flatten = (node, out = []) => {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
    if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
    if (typeof node.type === 'function') { flatten(node.type(node.props), out); return out }
    if (node.props && node.props.children !== undefined) flatten(node.props.children, out)
    return out
  }
  const values = {}
  const react = { useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot() }
  const jsx = {
    jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
    jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
  }
  const mod = loaded.factory((req) => {
    if (req === 'react') return react
    if (req === 'react/jsx-runtime') return jsx
    throw new Error('unexpected require: ' + req)
  })
  const dict = {}
  const t = (key, params) => {
    let text = dict[key] ?? key
    if (params) for (const name of Object.keys(params)) text = text.replaceAll('{' + name + '}', String(params[name]))
    return text
  }
  const registered = []
  mod.apply({
    effect: (fn) => fn(),
    locale: { register: (_ns, dictionaries) => Object.assign(dict, dictionaries.zh), bind: () => t },
    slots: { inject: (_name, cb) => cb(), register: (spec, view) => { registered.push({ spec, view }) } },
    sessions: {
      binding: () => ({
        session: { projections: { faceOf: (key) => ({ getSnapshot: () => values[key], subscribe: () => () => {} }) } },
      }),
    },
  })
  const tab = registered.find((entry) => entry.spec.id === 'cybernetics-goal')
  assert.ok(tab, '目标 tab registered')
  const injected = tab.spec.inject('sess-client')

  values.cyberneticsGoals = {
    goals: [
      { goalId: 'cyb-old', title: '旧任务', objective: 'o', status: 'paused', depth: 'full', executor: 'ephemeral', round: 2, subgoal: '缺口X', revisions: [], updatedAt: 100 },
      { goalId: 'cyb-new', title: '新任务', objective: 'o', status: 'running', depth: 'quick', executor: 'persistent', round: 0, revisions: [], updatedAt: 300 },
    ],
  }
  values.goal = { current: null }
  const text = flatten(tab.view({ ...injected, t })).join('\n')
  assert.ok(text.indexOf('新任务') < text.indexOf('旧任务'), 'goals render newest-updatedAt first')
  assert.match(text, /进行中/)
  assert.match(text, /已暂停/)
  assert.match(text, /第 2 轮/)
  assert.match(text, /缺口X/)
  assert.match(text, /完整/)
  assert.match(text, /临时执行者/)
  assert.match(text, /2 个目标/)

  values.cyberneticsGoals = undefined
  values.goal = { current: { goal: { objective: '单一焦点目标', phase: 'active', maxGoalRounds: 5 }, roundsStarted: 1 } }
  const fallback = flatten(tab.view({ ...injected, t })).join('\n')
  assert.match(fallback, /单一焦点目标/, 'absent projection falls back to dsh-goal rendering')
  console.log('✓ 22 client render: multi-goal rows newest-first, fallback single goal intact')
}

console.log('\nALL 22 CHECKS PASSED')
