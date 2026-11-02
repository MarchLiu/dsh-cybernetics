// Offline harness test for dsh-cybernetics v0.3: exercises every tool action
// (list / round / start / collect / cancel) against a fake host ctx and a
// controllable fake workflow engine — no DSH runtime required.
// Run: node test/v03-offline.mjs

import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { apply, loadBoardFile, saveBoardFile } from '../src/index.ts'
import { agentTeamsOf, startTeamRound, teamExecutorAvailable } from '../src/executor.ts'
import { cyberneticsGoalsProjection, goalsFromBoard, publishGoals, setRecordAppender, EVENT_TYPE, LEGACY_EVENT_TYPE, resolveHostSessionCopy, hostSessionStatus, setPublishDebugRoot, DEBUG_DIR, DEBUG_FILE } from '../src/projection.ts'

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
// Each host gets its own session id by default so board persistence (v0.6) is
// scoped per session: reusing one id across independent hosts would rehydrate
// the previous host's goals from the shared workspace snapshot.
function fakeHost(engine, { activeGoal, sessionId = 'sess-test' } = {}) {
  const tools = []
  const followups = []
  const createdGoals = []
  const parent = {
    session: { id: sessionId },
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
  const childAgent = { id: 'agent-child', session: { header: { parentSession: 'sess-root' } } }
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
  const state1 = unit.apply(state0, { type: 'plugin:cybernetics/goals', data: { goals: [goalV] } })
  assert.notStrictEqual(state1, state0, 'owned event produces a new state')
  assert.equal(state1.goals.length, 1)
  assert.equal(state1.goals[0].goalId, 'cyb-1')
  assert.strictEqual(unit.apply(state1, { type: 'user/message', data: {} }), state1,
    'unrelated event: same state reference (host zero-work fast path)')
  assert.strictEqual(unit.apply(state1, { type: 'goal/change', data: {} }), state1,
    'dsh-goal events are not ours')
  const legacy = unit.apply(state0, { type: 'cybernetics/goals', data: { goals: [goalV] } })
  assert.notStrictEqual(legacy, state0, 'pre-fix event name still folds (older logs restore)')
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
  setRecordAppender((session, type, data) => {
    appends.push({ type, data: JSON.parse(JSON.stringify(data)), seq: appends.length + 1 })
  })
  const tool8 = tools8[0]
  const exec8 = { agent: parent8, signal: undefined }
  const goalEvents = () => appends.filter((e) => e.type === EVENT_TYPE)

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
  assert.equal(publishGoals({ id: 'no-append' }, { goals: [] }), 'skipped', 'object without record seam: no-op')
  const written = []
  setRecordAppender((session, type, data) => { written.push({ type, data }) })
  const sess = { id: 'fake-session', append: () => ({}) }
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
  assert.equal(written[0].type, EVENT_TYPE)
  assert.equal(EVENT_TYPE, 'plugin:cybernetics/goals', 'plugin-record namespace is loadable after restart')
  assert.equal(LEGACY_EVENT_TYPE, 'cybernetics/goals')
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

// --- offline client render harness (shared by the client render checks) ------
// Loads lib/client.js exactly as the ModuleLoader would, with stubbed
// react/jsx-runtime, and returns the registered「目标 / 控制」tabs, the locale
// dict and the mutable session-list snapshot the control tab subscribes to.
async function loadClientTab() {
  const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded
  globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m } } }
  new Function('window', src)(globalThis.window)
  assert.ok(loaded, 'client module registered with the ModuleLoader')
  // The registration id must be the package manifest name: the client-modules
  // boot graph keys every row by that name and materializes a row only when its
  // bundle registered under exactly that id. The short plugin row id
  // (`dsh-cybernetics`) is not it — a stale id loads the script and then fails
  // boot with `could not load "@mars.liu/dsh-cybernetics": loaded without registering`.
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(loaded.id, pkg.name, 'bundle registration id equals the package name (boot graph row id)')

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
  // Session-list snapshot the control tab renders its agent tree from.
  const listSnapshot = { byId: {}, projectionsBySession: {} }
  mod.apply({
    effect: (fn) => fn(),
    locale: { register: (_ns, dictionaries) => Object.assign(dict, dictionaries.zh), bind: () => t },
    slots: { inject: (_name, cb) => cb(), register: (spec, view) => { registered.push({ spec, view }) } },
    sessions: {
      binding: () => ({
        session: { projections: { faceOf: (key) => ({ getSnapshot: () => values[key], subscribe: () => () => {} }) } },
      }),
      list: { subscribe: () => () => {}, getSnapshot: () => listSnapshot },
    },
  })
  const tab = registered.find((entry) => entry.spec.id === 'cybernetics-goal')
  assert.ok(tab, '目标 tab registered')
  const control = registered.find((entry) => entry.spec.id === 'cybernetics-control')
  assert.ok(control, '控制 tab registered')
  return {
    src, flatten, values, dict, t, tab, injected: tab.spec.inject('sess-client'),
    control, injectedControl: control.spec.inject('sess-client'), listSnapshot,
  }
}

// 22. v0.6 client tab render (offline, stubbed react/jsx-runtime): the multi-goal
//     list renders every goal in the projection's order with its badges, and an
//     absent projection falls back to the dsh-goal single-goal rendering
{
  const { flatten, values, t, tab, injected } = await loadClientTab()

  // Server order: unfinished group first, newest inside the group.
  values.cyberneticsGoals = {
    goals: [
      { goalId: 'cyb-new', title: '新任务', objective: 'o', status: 'running', depth: 'quick', executor: 'persistent', round: 0, revisions: [], updatedAt: 300 },
      { goalId: 'cyb-old', title: '旧任务', objective: 'o', status: 'paused', depth: 'full', executor: 'ephemeral', round: 2, subgoal: '缺口X', revisions: [], updatedAt: 100 },
    ],
  }
  values.goal = { current: null }
  const text = flatten(tab.view({ ...injected, t })).join('\n')
  assert.ok(text.indexOf('新任务') < text.indexOf('旧任务'), 'renders the server order verbatim')
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
  console.log('✓ 22 client render: multi-goal rows in projection order, fallback single goal intact')
}

// 23. v0.6 append-only revision: 'revise' creates a successor goal (lineage),
//     freezes the old goal as superseded, records the revision audit line and
//     starts the successor's first round — also when the old goal was completed
{
  const engine23 = fakeEngine()
  const host = fakeHost(engine23, { sessionId: 'sess-test-23' })
  host.ctx.workingDirectory = { get: () => root }
  apply(host.ctx, {})
  const tool23 = host.tools[0]
  const exec23 = { agent: host.parent, signal: undefined }
  const metRound = {
    round: 1,
    report: { summary: '完成', done: true, artifacts: [], evidence: 'e', nextStepThoughts: [] },
    verdict: { met: true, criteria: [], gaps: [], goalItselfQuestionable: false },
    triage: { auto: [], defer: [], reject: [], human: [] },
  }

  const a = await tool23.execute({ action: 'start', title: '修订前任务', brief: '旧委托书' }, exec23)
  engine23.runs[0].settle({ stopReason: 'completed', value: metRound })
  await new Promise((r) => setImmediate(r))
  await tool23.execute({ action: 'collect', goalId: a.goalId }, exec23)

  const runsBefore = engine23.runs.length
  const r = await tool23.execute({
    action: 'revise', goalId: a.goalId, reason: '用户校准：目标改为 Y',
    objective: '新目标 Y', title: '修订后任务', depth: 'quick',
  }, exec23)
  assert.equal(r.revised, true)
  assert.notEqual(r.goalId, a.goalId, 'revision mints a NEW goal id')
  assert.equal(r.previousGoalId, a.goalId)
  assert.equal(r.round, 1, 'successor starts its own round 1')
  assert.equal(r.started, true)
  assert.equal(engine23.runs.length, runsBefore + 1, 'successor round launched in the background')
  const newRun = engine23.runs.at(-1)
  assert.equal(newRun.request.args.goal.objective, '新目标 Y', 'new objective reaches the task agent')
  assert.equal(newRun.request.args.depth, 'quick', 'depth override honored')
  assert.equal(newRun.request.args.role, 'default', 'role inherited from the old goal')

  const board = (await tool23.execute({ action: 'list' }, exec23)).board
  const previous = board.find((g) => g.goalId === a.goalId)
  const successor = board.find((g) => g.goalId === r.goalId)
  assert.equal(previous.status, 'superseded', 'old goal keeps its final state as superseded')
  assert.equal(previous.supersededBy, r.goalId, 'old goal points at its successor')
  assert.equal(previous.objective, '旧委托书', 'old goal objective is never rewritten in place')
  assert.equal(successor.parentGoalId, a.goalId, 'successor records its lineage')
  assert.equal(successor.status, 'running')
  assert.equal(successor.title, '修订后任务')
  assert.equal(successor.objective, '新目标 Y')

  const logPath = join(root, '.cybernetics', `revisions-${r.goalId}.jsonl`)
  const lines = (await readFile(logPath, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 1, 'one revision audit line per transition')
  const record = JSON.parse(lines[0])
  assert.equal(record.from, a.goalId)
  assert.equal(record.to, r.goalId)
  assert.equal(record.reason, '用户校准：目标改为 Y')
  assert.equal(typeof record.at, 'number', 'revision timestamp recorded')

  // A COMPLETED goal revised → same append-only rule; unspecified fields inherit.
  newRun.settle({ stopReason: 'completed', value: metRound })
  await new Promise((r2) => setImmediate(r2))
  const settled = await tool23.execute({ action: 'collect', goalId: r.goalId }, exec23)
  assert.equal(settled.decision.reason, 'met')
  const r2 = await tool23.execute({ action: 'revise', goalId: r.goalId, reason: '完成后发现目标需再调整' }, exec23)
  const board2 = (await tool23.execute({ action: 'list' }, exec23)).board
  const completedGoal = board2.find((g) => g.goalId === r.goalId)
  const third = board2.find((g) => g.goalId === r2.goalId)
  assert.equal(completedGoal.status, 'superseded', 'a completed goal is superseded, not edited')
  assert.equal(completedGoal.supersededBy, r2.goalId)
  assert.equal(third.parentGoalId, r.goalId)
  assert.equal(third.objective, '新目标 Y', 'objective inherited when the revision omits it')
  assert.equal(third.title, '修订后任务', 'title inherited when the revision omits it')
  assert.equal(engine23.runs.at(-1).request.args.depth, 'quick', 'depth inherited across the revision')
  console.log('✓ 23 revise: successor goal + lineage + superseded old goal + revision audit (completed goal included)')
}

// 24. v0.6 revise/abortPrevious: the SESSION agent decides whether the old goal's
//     in-flight task agent is interrupted (default false); bad revisions are rejected
{
  const engine24 = fakeEngine()
  const host = fakeHost(engine24, { sessionId: 'sess-test-24' })
  host.ctx.workingDirectory = { get: () => root }
  apply(host.ctx, {})
  const tool24 = host.tools[0]
  const exec24 = { agent: host.parent, signal: undefined }

  const a = await tool24.execute({ action: 'start', title: '打断任务', brief: 'b' }, exec24)
  const runA = engine24.runs[0]
  const ra = await tool24.execute({
    action: 'revise', goalId: a.goalId, reason: '方向错误', abortPrevious: true,
  }, exec24)
  assert.equal(runA.cancelled, true, 'abortPrevious=true cancels the old in-flight run')
  assert.equal(runA.disposed, true, 'the cancelled run is disposed (no leaked handle)')
  assert.match(ra.aborted ?? '', /中止/)

  const b = await tool24.execute({ action: 'start', title: '等待任务', brief: 'b' }, exec24)
  const runB = engine24.runs.at(-1)
  const runsBefore = engine24.runs.length
  const rb = await tool24.execute({ action: 'revise', goalId: b.goalId, reason: '补充要求' }, exec24)
  assert.equal(runB.cancelled, false, 'default: the old task agent keeps running')
  assert.equal(engine24.runs.length, runsBefore + 1, 'the successor still starts its own round')
  assert.equal(rb.aborted, undefined)

  await assert.rejects(
    () => tool24.execute({ action: 'revise', goalId: b.goalId, objective: 'x' }, exec24),
    /requires a non-empty "reason"/,
    'reason is mandatory',
  )
  await assert.rejects(
    () => tool24.execute({ action: 'revise', goalId: a.goalId, reason: '再改一次' }, exec24),
    /already superseded/,
    'a superseded goal cannot be revised again (no lineage forking)',
  )

  // The superseded goal's late round settles silently: no collect notice, and
  // the frozen goal can no longer be collected/driven.
  runB.settle({ stopReason: 'cancelled', error: 'user' })
  await new Promise((r) => setImmediate(r))
  assert.equal(
    host.followups.filter((f) => f.source?.goalId === b.goalId).length, 0,
    'a superseded goal queues no collect notice for its late round',
  )
  await assert.rejects(
    () => tool24.execute({ action: 'collect', goalId: b.goalId }, exec24),
    /superseded/,
    'a superseded goal is frozen history: collect is rejected',
  )
  console.log('✓ 24 revise abortPrevious: true cancels the old run, default false leaves it running; guards hold')
}

// 25. v0.6 goalsFromBoard ordering: unfinished goals first, completed goals after,
//     newest update first inside each segment
{
  const loop = (goalId, status, extra = {}) => ({
    goalId, title: goalId, objective: 'o', round: 1, doneSummary: '', subgoal: 's', role: 'default',
    status, ...extra,
  })
  const loops = [
    loop('g-met', 'met'),
    loop('g-running', 'running'),
    loop('g-superseded', 'superseded', { supersededBy: 'g-running' }),
    loop('g-pending', undefined),
    loop('g-failed', 'paused', { paused: { reason: 'failed', note: 'boom' } }),
    loop('g-paused', 'paused'),
  ]
  // Stamp distinct updatedAt values (per-object content fingerprints).
  loops.forEach((l, i) => goalsFromBoard([l], 1000 + i))
  const snap = goalsFromBoard(loops, 9000)
  assert.deepEqual(
    snap.goals.map((g) => g.goalId),
    ['g-paused', 'g-failed', 'g-pending', 'g-running', 'g-superseded', 'g-met'],
    'two segments: running/paused/pending/failed first, then cancelled/met/superseded; newest update first inside each',
  )
  const completed = new Set(['met', 'cancelled', 'superseded'])
  let seenCompleted = false
  for (const g of snap.goals) {
    if (completed.has(g.status)) seenCompleted = true
    else assert.equal(seenCompleted, false, `unfinished goal ${g.goalId} must precede the completed segment`)
  }
  for (let i = 1; i < snap.goals.length; i++) {
    const prev = snap.goals[i - 1]
    const cur = snap.goals[i]
    if (completed.has(prev.status) !== completed.has(cur.status)) continue
    assert.ok(prev.updatedAt >= cur.updatedAt, `segment order is updatedAt desc (${prev.goalId} -> ${cur.goalId})`)
  }
  assert.deepEqual(
    goalsFromBoard(loops, 99999).goals.map((g) => g.goalId),
    snap.goals.map((g) => g.goalId),
    'unchanged board keeps a stable order across publishes',
  )
  console.log('✓ 25 goalsFromBoard order: unfinished segment first, completed after, updatedAt desc inside')
}

// 26. v0.6 projection GoalView lineage: parentGoalId/supersededBy survive the wire
//     and 'superseded' maps through status normalization (absent lineage stays absent)
{
  const previousLoop = {
    goalId: 'g-old', title: '旧', objective: 'o1', round: 2, doneSummary: '', subgoal: 's-old',
    role: 'default', status: 'superseded', supersededBy: 'g-new',
  }
  const successorLoop = {
    goalId: 'g-new', title: '新', objective: 'o2', round: 0, doneSummary: '', subgoal: 's-new',
    role: 'default', status: 'running', parentGoalId: 'g-old', depth: 'quick', executor: 'persistent',
  }
  const snap = goalsFromBoard([previousLoop, successorLoop], 1000)
  assert.equal(snap.goals[0].goalId, 'g-new', 'running goal precedes the superseded one')
  const prevView = snap.goals.find((g) => g.goalId === 'g-old')
  const nextView = snap.goals.find((g) => g.goalId === 'g-new')
  assert.equal(prevView.status, 'superseded', "'superseded' is a first-class GoalStatus")
  assert.equal(prevView.supersededBy, 'g-new')
  assert.equal('parentGoalId' in prevView, false, 'absent lineage keys are omitted, not undefined')
  assert.equal(nextView.parentGoalId, 'g-old')
  assert.equal(nextView.status, 'running')
  assert.equal(nextView.depth, 'quick')
  assert.equal(nextView.executor, 'persistent')

  const unit = cyberneticsGoalsProjection()
  const folded = unit.apply(unit.init(), {
    type: EVENT_TYPE,
    data: { goals: [{ ...prevView, updatedAt: 100 }, { ...nextView, updatedAt: 200 }] },
  })
  assert.equal(folded.goals.find((g) => g.goalId === 'g-old').status, 'superseded')
  assert.equal(folded.goals.find((g) => g.goalId === 'g-old').supersededBy, 'g-new')
  assert.equal(folded.goals.find((g) => g.goalId === 'g-new').parentGoalId, 'g-old')
  const plain = unit.apply(unit.init(), {
    type: EVENT_TYPE,
    data: {
      goals: [{
        goalId: 'g-plain', title: 'p', objective: 'o', status: 'running', depth: 'full',
        executor: 'ephemeral', round: 0, revisions: [], updatedAt: 1,
      }],
    },
  })
  assert.equal('parentGoalId' in plain.goals[0], false, 'legacy payloads fold without invented lineage')
  assert.equal('supersededBy' in plain.goals[0], false)
  console.log('✓ 26 projection lineage: parentGoalId/supersededBy on the wire, superseded status folded')
}

// 27. v0.6 client lineage render: superseded/revised lines resolve titles, the
//     superseded badge and locales exist, and the client never re-sorts
{
  const { src, flatten, values, t, tab, injected, dict } = await loadClientTab()
  assert.ok(dict['goalStatus.superseded'], 'zh locale has the superseded badge')
  assert.ok(dict['goal.supersededBy'], 'zh locale has the "superseded by" line')
  assert.ok(dict['goal.revisedFrom'], 'zh locale has the "revised from" line')
  assert.ok(!/\.slice\(\)\.sort/.test(src), 'client never re-sorts the projection order')

  values.goal = { current: null }
  // Deliberately NOT newest-first: a re-sorting client would flip this payload.
  values.cyberneticsGoals = {
    goals: [
      { goalId: 'cyb-a', title: '甲任务', objective: 'o', status: 'paused', depth: 'full', executor: 'ephemeral', round: 1, revisions: [], updatedAt: 100 },
      { goalId: 'cyb-b', title: '乙任务', objective: 'o', status: 'paused', depth: 'full', executor: 'ephemeral', round: 1, revisions: [], updatedAt: 900 },
    ],
  }
  const ordered = flatten(tab.view({ ...injected, t })).join('\n')
  assert.ok(ordered.indexOf('甲任务') < ordered.indexOf('乙任务'), 'client keeps the projection order verbatim')

  values.cyberneticsGoals = {
    goals: [
      { goalId: 'cyb-2', title: '新目标', objective: 'o2', status: 'running', depth: 'full', executor: 'ephemeral', round: 0, parentGoalId: 'cyb-1', revisions: [], updatedAt: 300 },
      { goalId: 'cyb-1', title: '旧目标', objective: 'o1', status: 'superseded', depth: 'full', executor: 'ephemeral', round: 2, supersededBy: 'cyb-2', revisions: [], updatedAt: 100 },
    ],
  }
  const lineage = flatten(tab.view({ ...injected, t })).join('\n')
  assert.match(lineage, /已被「新目标」取代/, 'superseded goal names its successor title')
  assert.match(lineage, /修订自「旧目标」/, 'revised goal names its parent title')
  assert.match(lineage, /已被取代/, 'superseded status badge rendered')
  console.log('✓ 27 client lineage: successor/parent lines with titles, superseded badge, projection order preserved')
}


// 28. v0.6 TeamExecutor (persistent, quick): spawns one fresh teammate on the
//     first round, captures its output via subagent/end, derives the verdict
{
  const appends = []
  setRecordAppender((_s, type, data) => { appends.push({ type, data }) })
  const handlers = []
  const spawned = []
  const messages = []
  const tools9 = []
  const engine9 = fakeEngine()
  const parent9 = { session: { id: 'sess-team' }, followup() {} }
  const ctx9 = {
    tools: { register: (d) => { tools9.push(d); return () => {} } },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null, create: () => ({ id: 'goal-focused' }) },
    workingDirectory: { get: () => root },
    agentPresets: { serviceFor: (a, n) => (n === 'workflowEngine' ? engine9 : undefined) },
    agents: { roots: () => [] },
    sessionProjections: { register: () => () => {} },
    on: (event, fn) => { if (event === 'subagent/end') handlers.push(fn); return () => {} },
    agentTeams: {
      spawnTeammate: async (_caller, req) => {
        spawned.push(req)
        return { member: { id: 'child-team-1', name: req.name, status: 'running' } }
      },
      sendMessage: async (_caller, req) => { messages.push(req); return { messageId: 'm-1' } },
      interrupt: () => ({ previousStatus: 'running' }),
      listMembers: () => [{ id: 'child-team-1', name: spawned[0]?.name, status: 'inactive' }],
    },
  }
  apply(ctx9, {})
  const tool9 = tools9[0]
  const exec9 = { agent: parent9, signal: undefined }

  const started = await tool9.execute({ action: 'start', title: '持久分析', brief: '分析 X', executor: 'persistent', depth: 'quick' }, exec9)
  assert.equal(spawned.length, 1, 'first persistent round spawns exactly one teammate')
  assert.equal(spawned[0].context, 'fresh', 'teammates are provisioned, never forked')
  assert.deepEqual(spawned[0].prompt.length, 1)
  assert.match(spawned[0].prompt[0].text, /输出契约/)
  assert.ok(spawned[0].name.startsWith('cyb-'), 'member name derives from the goal id')

  // the teammate settles its turn
  for (const h of handlers) h({ id: 'child-team-1', lastAssistantMessage: [{ type: 'text', text: '分析完成：X 的结论 {"done": true, "summary": "X ok", "evidence": "tool out"}' }] })
  await new Promise((r) => setImmediate(r))
  const collected = await tool9.execute({ action: 'collect', goalId: started.goalId }, exec9)
  assert.equal(collected.decision.reason, 'met', 'quick verdict derives from the report')
  assert.equal(collected.result.verdict.quick, true)
  assert.match(collected.result.report.summary, /X ok/)
    console.log('✓ 28 persistent quick round: one fresh teammate, verdict derived from its output')

// 29. v0.6 TeamExecutor round 2+: the peer message steers the SAME member
//     (brief amendment), no second spawn
{
  const p = tool9.execute({ action: 'round', goalId: started.goalId }, exec9)
  for (let i = 0; i < 100 && messages.length === 0; i++) await new Promise((r) => setImmediate(r))
  assert.equal(messages.length, 1, 'second round sends one amendment message')
  assert.equal(messages[0].target, spawned[0].name, 'the same durable member is addressed')
  assert.match(messages[0].content[0].text, /委托书修订/)
  assert.equal(spawned.length, 1, 'no second spawn')
  for (const h of handlers) h({ id: 'child-team-1', lastAssistantMessage: [{ type: 'text', text: '第二轮完成 {"done": true, "summary": "round2 ok", "evidence": "e2"}' }] })
  const out2 = await p
  assert.equal(out2.round, 2)
  assert.equal(out2.decision.reason, 'met')
  console.log('✓ 29 persistent round 2: brief amendment to the same member, no respawn')
}

// 30. v0.6 TeamExecutor cancel: interrupts the teammate and releases the goal
{
  let interrupts = 0
  ctx9.agentTeams.interrupt = () => { interrupts++; return { previousStatus: 'running' } }
  const t = await tool9.execute({ action: 'start', title: '可取消任务', brief: 'B', executor: 'persistent', depth: 'quick' }, exec9)
  await new Promise((r) => setImmediate(r))
  const c = await tool9.execute({ action: 'cancel', goalId: t.goalId }, exec9)
  assert.match(String(c.cancelled), /已请求中止/)
  assert.equal(interrupts, 1, 'cancel interrupts the persistent teammate')
  console.log('✓ 30 persistent cancel: interrupt issued to the member')
}

// 31. v0.6 TeamExecutor full depth: the teammate's report is handed to
//     round.js as taskReport so verify/triage stay ephemeral and independent
{
  const runsBefore = engine9.runs.length
  const t = await tool9.execute({ action: 'start', title: '持久完整轮', brief: 'C', executor: 'persistent', depth: 'full' }, exec9)
  for (const h of handlers) h({ id: 'child-team-1', lastAssistantMessage: [{ type: 'text', text: '完成 {"done": true, "summary": "full ok", "evidence": "ev"}' }] })
  for (let i = 0; i < 200 && engine9.runs.length === runsBefore; i++) await new Promise((r) => setImmediate(r))
  assert.equal(engine9.runs.length, runsBefore + 1, 'verify/triage workflow run started')
  const req = engine9.runs.at(-1).request
  assert.equal(req.args.taskReport.summary, 'full ok', 'report passed as taskReport')
  assert.equal(req.args.taskReport.done, true)
  engine9.runs.at(-1).settle({
    stopReason: 'completed',
    value: {
      round: 1,
      report: { summary: 'full ok', done: true, artifacts: [], evidence: 'ev', nextStepThoughts: [] },
      verdict: { met: true, criteria: [], gaps: [], goalItselfQuestionable: false },
      triage: { auto: [], defer: [], reject: [], human: [] },
    },
  })
  await new Promise((r) => setImmediate(r))
  const col = await tool9.execute({ action: 'collect', goalId: t.goalId }, exec9)
  assert.equal(col.decision.reason, 'met')
  console.log('✓ 31 persistent full: taskReport handed to round.js for independent verify')
}
}

// 32. round.js taskReport branch: the task agent is skipped entirely
{
  const code = await readFile(new URL('../workflows/round.js', import.meta.url), 'utf8')
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push(opts?.label ?? '?')
    if (calls.length === 1) return { met: true, criteria: [], gaps: [], goalItselfQuestionable: false }
    return { auto: [], defer: [], reject: [], human: [] }
  }
  const fn = new (async function () {}.constructor)('agent', 'phase', 'args', 'log', code)
  const out = await fn(agent, async () => {}, {
    goal: { objective: 'O' }, state: { round: 1, doneSummary: '' },
    subgoal: 'S', brief: 'B', roles: {},
    taskReport: { summary: 'from teammate', done: true, artifacts: [], evidence: 'e', nextStepThoughts: [] },
  }, () => {})
  assert.deepEqual(calls, ['verify', 'triage'], 'task agent skipped; verify+triage ran')
  assert.equal(out.report.summary, 'from teammate')
  assert.equal(out.verdict.met, true)
  console.log('✓ 32 round.js taskReport: task agent skipped, verify/triage over the given report')
}

// 33. v0.4 execution gate: an unadvertised mutation call from a ROOT agent is
//     DENIED at dispatch (assembly filtering alone only hides the name)
{
  const rootAgent = { id: 'agent-root', session: { header: {} } }
  const childAgent = { id: 'agent-child', session: { header: { parentSession: 'sess-root' } } }
  const listeners5 = []
  const ctx5 = {
    tools: { register: () => () => {} },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null },
    workingDirectory: { get: () => root },
    agentPresets: { serviceFor: () => undefined },
    agents: { roots: () => [rootAgent] },
    on: (event, fn) => { listeners5.push({ event, fn }); return () => {} },
    sessionProjections: { register: () => () => {} },
  }
  apply(ctx5, { hardGate: true, gateMode: 'allowlist' })
  const gate5 = listeners5.find((l) => l.event === 'tools/pre-execute')
  assert.ok(gate5, 'execution gate listener registered')
  const allow = async () => ({ kind: 'allow' })
  const run = (agent, name) => gate5.fn({ agent, name }, allow)
  const bashDenied = await run(rootAgent, 'bash')
  assert.equal(bashDenied.kind, 'deny', 'root agent: bash denied at dispatch')
  assert.match(bashDenied.reason, /hard gate/, 'denial tells the model to delegate')
  assert.equal((await run(rootAgent, 'farm_unregister')).kind, 'deny', 'root agent: mutation denied at dispatch')
  assert.equal((await run(rootAgent, 'read')).kind, 'allow', 'root agent: read tools pass')
  assert.equal((await run(rootAgent, 'cybernetics')).kind, 'allow', 'the orchestrator verb always passes')
  assert.equal((await run(childAgent, 'bash')).kind, 'allow', 'delegated child agents keep full execution')
  assert.equal((await run(undefined, 'bash')).kind, 'allow', 'calls without an agent identity are untouched')
  console.log('✓ 33 execution gate: root mutation calls denied at dispatch; children unaffected')
}

// 34. v0.6 board persistence: every publish snapshots the session board to
//     <workspace>/.cybernetics/board-<sessionId>.json — creation and settlement
//     are both write points, and the snapshot carries the full LoopState
let boardSnapshot
{
  const persistRoot = await mkdtemp(join(tmpdir(), 'cyb-board-'))
  const engine34 = fakeEngine()
  const host34 = fakeHost(engine34, { sessionId: 'sess-persist' })
  host34.ctx.workingDirectory = { get: () => persistRoot }
  apply(host34.ctx, {})
  const tool34 = host34.tools[0]
  const exec34 = { agent: host34.parent, signal: undefined }

  const started = await tool34.execute({
    action: 'start', title: '持久化任务', brief: '委托书P', depth: 'quick',
  }, exec34)
  const boardFile = join(persistRoot, '.cybernetics', 'board-sess-persist.json')
  const saved = JSON.parse(await readFile(boardFile, 'utf8'))
  assert.equal(saved.version, 1, 'snapshot carries a format version')
  assert.equal(saved.sessionId, 'sess-persist')
  assert.equal(typeof saved.savedAt, 'number')
  const entry = saved.goals.find((g) => g.goalId === started.goalId)
  assert.ok(entry, 'created goal is on disk')
  assert.equal(entry.title, '持久化任务')
  assert.equal(entry.objective, '委托书P')
  assert.equal(entry.depth, 'quick')
  assert.equal(entry.status, 'running', 'in-flight round persisted as running')
  assert.equal(entry.round, 0)

  engine34.runs[0].settle({
    stopReason: 'completed',
    value: {
      round: 1,
      report: { summary: 'P 半成', done: false, artifacts: [], evidence: 'e', nextStepThoughts: [] },
      verdict: { met: false, criteria: [], gaps: ['缺口P'], goalItselfQuestionable: false },
      triage: { auto: [], defer: [], reject: [], human: [] },
    },
  })
  await new Promise((r) => setImmediate(r))
  await tool34.execute({ action: 'collect', goalId: started.goalId }, exec34)
  const after = JSON.parse(await readFile(boardFile, 'utf8'))
  const settled = after.goals.find((g) => g.goalId === started.goalId)
  assert.equal(settled.round, 1, 'settlement write point persists the advanced round')
  assert.equal(settled.status, 'paused')
  assert.match(settled.subgoal, /缺口P/)
  boardSnapshot = { root: persistRoot, sessionId: 'sess-persist', goalId: started.goalId }
  console.log('✓ 34 board persistence: create + settle write .cybernetics/board-<session>.json')
}

// 35. v0.6 rehydrate round-trip: a fresh process (new ctx, empty memory board,
//     same workspace + session id) recovers the history from disk AND
//     republishes it, so the「目标」tab is not empty after a host restart
{
  assert.ok(boardSnapshot, 'prior test wrote a snapshot')
  const appends = []
  setRecordAppender((_session, type, data) => {
    appends.push({ type, data: JSON.parse(JSON.stringify(data)) })
  })
  const host35 = fakeHost(fakeEngine(), { sessionId: boardSnapshot.sessionId })
  const engine35 = host35.ctx.agentPresets.serviceFor(undefined, 'workflowEngine')
  // A loggable session (publishGoals only writes to a real Session-shaped
  // target); the appender above records the event it would append.
  host35.parent.session.append = () => ({})
  host35.ctx.workingDirectory = { get: () => boardSnapshot.root }
  apply(host35.ctx, {})
  const tool35 = host35.tools[0]
  const exec35 = { agent: host35.parent, signal: undefined }

  const out = await tool35.execute({ action: 'list' }, exec35)
  assert.equal(out.board.length, 1, 'the whole history is rebuilt from the snapshot')
  const restored = out.board.find((g) => g.goalId === boardSnapshot.goalId)
  assert.ok(restored, 'historical goal recovered from disk')
  assert.equal(restored.title, '持久化任务')
  assert.equal(restored.objective, '委托书P')
  assert.equal(restored.round, 1)
  assert.equal(restored.status, 'paused')
  assert.match(restored.subgoal, /缺口P/)
  assert.equal(restored.executor, 'ephemeral', 'list reports the restored substrate')

  const published = appends.filter((e) => e.type === EVENT_TYPE)
  assert.equal(published.length, 1, 'rehydrate republishes the restored board exactly once')
  assert.equal(published[0].data.goals.length, 1)
  assert.equal(published[0].data.goals[0].goalId, boardSnapshot.goalId)
  assert.equal(published[0].data.goals[0].round, 1, 'the recovered round reaches the tab')

  // Idempotent: the board is no longer empty, so a second call neither
  // rehydrates nor publishes again.
  const out2 = await tool35.execute({ action: 'list' }, exec35)
  assert.equal(out2.board.length, 1)
  assert.equal(appends.filter((e) => e.type === EVENT_TYPE).length, 1)

  // A restored goal must remain DRIVABLE: it continues at the next round with
  // the persisted work order, not at round 1 with an empty brief.
  const next = await tool35.execute({ action: 'start', goalId: boardSnapshot.goalId }, exec35)
  assert.equal(next.round, 2, 'restored goal continues at round 2')
  assert.equal(engine35.runs.at(-1).request.args.state.round, 2, 'workflow receives the next round')
  assert.equal(engine35.runs.at(-1).request.args.brief, '委托书P', 'the persisted work order reaches the next round')
  setRecordAppender(undefined)
  console.log('✓ 35 rehydrate: fresh ctx recovers the board, republishes once, and stays drivable (round 2)')
}

// 36. v0.6 rehydrate is failure-tolerant: invalid JSON, a foreign format
//     version, unusable goal records and a missing file all mean "empty board",
//     never a throw
{
  const corruptRoot = await mkdtemp(join(tmpdir(), 'cyb-corrupt-'))
  await mkdir(join(corruptRoot, '.cybernetics'), { recursive: true })
  await writeFile(join(corruptRoot, '.cybernetics', 'board-sess-corrupt.json'), '{"version": 1, "goals": [ not json ,,,')
  await writeFile(
    join(corruptRoot, '.cybernetics', 'board-sess-oldver.json'),
    JSON.stringify({ version: 99, sessionId: 'sess-oldver', savedAt: 1, goals: [{ goalId: 'g-old', round: 1 }] }),
  )
  await writeFile(
    join(corruptRoot, '.cybernetics', 'board-sess-junk.json'),
    JSON.stringify({ version: 1, sessionId: 'sess-junk', savedAt: 1, goals: [null, 42, { title: 'no id' }, { goalId: '' }] }),
  )
  for (const sessionId of ['sess-corrupt', 'sess-oldver', 'sess-junk', 'sess-missing']) {
    const host36 = fakeHost(fakeEngine(), { sessionId })
    host36.ctx.workingDirectory = { get: () => corruptRoot }
    apply(host36.ctx, {})
    const out = await host36.tools[0].execute({ action: 'list' }, { agent: host36.parent, signal: undefined })
    assert.deepEqual(out.board, [], `${sessionId}: unusable snapshot degrades to an empty board`)
  }
  console.log('✓ 36 corrupt / foreign-version / junk / missing snapshot: empty board, no throw')
}

// 37. v0.6 GoalView.memberName: the durable teammate's name rides the wire,
//     survives the projection fold and round-trips through the board snapshot
{
  const persistentLoop = {
    goalId: 'g-member', title: '持久目标', objective: 'o', round: 2, doneSummary: '', subgoal: 's',
    role: 'default', status: 'running', executor: 'persistent', memberName: 'cyb-member-1',
  }
  const ephemeralLoop = {
    goalId: 'g-plain', title: '临时目标', objective: 'o', round: 1, doneSummary: '', subgoal: 's',
    role: 'default', status: 'paused', executor: 'ephemeral',
  }
  const snap = goalsFromBoard([persistentLoop, ephemeralLoop], 500)
  const member = snap.goals.find((g) => g.goalId === 'g-member')
  const plain = snap.goals.find((g) => g.goalId === 'g-plain')
  assert.equal(member.memberName, 'cyb-member-1', 'persistent goal exposes its teammate name')
  assert.equal(member.executor, 'persistent')
  assert.equal('memberName' in plain, false, 'no durable member ⇒ no field on the wire')

  const unit = cyberneticsGoalsProjection()
  const folded = unit.apply(unit.init(), {
    type: EVENT_TYPE,
    data: { goals: JSON.parse(JSON.stringify(snap.goals)) },
  })
  assert.equal(folded.goals.find((g) => g.goalId === 'g-member').memberName, 'cyb-member-1',
    'projection fold keeps the member name')
  assert.equal('memberName' in folded.goals.find((g) => g.goalId === 'g-plain'), false)

  const memberRoot = await mkdtemp(join(tmpdir(), 'cyb-member-'))
  await saveBoardFile(memberRoot, 'sess-m', [persistentLoop])
  const loaded = await loadBoardFile(memberRoot, 'sess-m')
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].memberName, 'cyb-member-1', 'snapshot round-trip keeps the member name')
  assert.equal(loaded[0].executor, 'persistent')
  console.log('✓ 37 GoalView.memberName: wire + projection + snapshot round-trip preserve the teammate name')
}

// 38. v0.6 control tab executor rows: every goal listed with status, executor
//     (ephemeral/persistent), the durable member name when present and the
//     round; unfinished goals first, finished after
{
  const { flatten, values, t, control, injectedControl, dict } = await loadClientTab()
  assert.ok(control, '控制 tab registered')
  assert.ok(dict['goal.member'], 'zh locale has the member line')
  assert.ok(dict['goal.executor.persistent'], 'zh locale has the persistent executor label')
  assert.ok(dict['control.goals'], 'zh locale has the control goal header')

  // Deliberately completed-first: the control tab must group, not trust order.
  values.cyberneticsGoals = {
    goals: [
      { goalId: 'cyb-done', title: '已完成目标', objective: 'o', status: 'met', depth: 'full', executor: 'ephemeral', round: 3, revisions: [], updatedAt: 900 },
      { goalId: 'cyb-live', title: '持久分析', objective: 'o', status: 'running', depth: 'full', executor: 'persistent', round: 2, memberName: 'cyb-live-1', revisions: [], updatedAt: 100 },
    ],
  }
  const text = flatten(control.view({ ...injectedControl, t })).join('\n')
  assert.ok(text.indexOf('持久分析') < text.indexOf('已完成目标'), 'unfinished goals render before completed ones')
  assert.match(text, /持久执行者/)
  assert.match(text, /临时执行者/)
  assert.match(text, /成员 cyb-live-1/, 'the durable teammate name is shown')
  assert.match(text, /第 2 轮/)
  assert.match(text, /第 3 轮/)
  assert.match(text, /已完成/)
  assert.equal((text.match(/成员 /g) ?? []).length, 1, 'only goals with a durable member show the member tag')
  assert.match(text, /主控|sess-client/, 'the agent tree stays rendered below the goal rows')
  console.log('✓ 38 control tab: goal rows show executor + teammate name + round, unfinished first')
}

// 39. v0.6 soft Agent Teams probe: a Cordis-style context THROWS when the
//     un-injected `agentTeams` property is read. Requesting persistent there
//     must reject with the structured "needs Agent Teams" error (pointing at
//     the ephemeral fallback), never with the proxy exception; the same ctx
//     still starts an ephemeral round.
{
  const engine39 = fakeEngine()
  const host39 = fakeHost(engine39, { sessionId: 'sess-soft-probe' })
  const root39 = await mkdtemp(join(tmpdir(), 'cyb-soft-'))
  host39.ctx.workingDirectory = { get: () => root39 }
  // Faithful Cordis behaviour: reading a service that was not injected does
  // not return undefined — the context proxy throws. This is exactly the
  // production failure (`cannot get property "agentTeams" without inject`).
  let probes = 0
  Object.defineProperty(host39.ctx, 'agentTeams', {
    configurable: true,
    enumerable: false,
    get() {
      probes++
      throw new Error('cannot get property "agentTeams" without inject')
    },
  })
  apply(host39.ctx, {})
  const tool39 = host39.tools[0]
  const exec39 = { agent: host39.parent, signal: undefined }

  let rejected
  try {
    await tool39.execute({ action: 'round', title: '无团队任务', brief: '做 X', executor: 'persistent' }, exec39)
  } catch (error) { rejected = error }
  assert.ok(rejected instanceof Error, 'persistent on a team-less ctx rejects')
  assert.match(rejected.message, /needs Agent Teams/, 'structured soft-integration error')
  assert.match(rejected.message, /agentTeams/, 'the error names the missing service')
  assert.match(rejected.message, /ephemeral/, 'the error points at the fallback executor')
  assert.doesNotMatch(rejected.message, /without inject/, 'never leaks the Cordis proxy exception')

  // The accessor itself is exception-safe and reports "unavailable".
  assert.equal(agentTeamsOf(host39.ctx), undefined, 'agentTeamsOf swallows the thrown property access')
  assert.equal(teamExecutorAvailable(host39.ctx), false, 'availability probe answers false, not throw')
  assert.ok(probes > 0, 'the throwing getter really was hit')

  // Same ctx, executor omitted (ephemeral): the round still starts.
  const runsBefore39 = engine39.runs.length
  const started39 = await tool39.execute({ action: 'start', title: '无团队临时任务', brief: '做 Y' }, exec39)
  assert.equal(started39.started, true)
  assert.equal(engine39.runs.length, runsBefore39 + 1, 'ephemeral round started on the team-less ctx')
  assert.match(started39.goalId, /^cyb-/)
  console.log('✓ 39 soft Agent Teams probe: un-injected service → structured error, ephemeral fallback still starts')
}

// 40. startTeamRound's own guard: called directly (bypassing index.ts's
//     pre-check) it still refuses with the same structured error — the soft
//     probe is enforced at the executor boundary too, not only at the tool.
{
  const ctx40 = { on: () => () => {} }
  Object.defineProperty(ctx40, 'agentTeams', {
    configurable: true,
    get() { throw new Error('cannot get property "agentTeams" without inject') },
  })
  const loop40 = {
    goalId: 'cyb-direct', title: 't', objective: 'o', round: 0, doneSummary: '',
    subgoal: 's', role: 'default', status: 'running', executor: 'persistent',
  }
  let err40
  try {
    await startTeamRound(ctx40, {}, loop40, { roundScriptPath: '/nonexistent/round.js', roles: {} })
  } catch (error) { err40 = error }
  assert.ok(err40 instanceof Error, 'startTeamRound rejects without Agent Teams')
  assert.match(err40.message, /needs Agent Teams/)
  assert.match(err40.message, /ephemeral/, 'tells the caller to fall back')
  assert.doesNotMatch(err40.message, /without inject/, 'not a Cordis proxy exception')
  console.log('✓ 40 startTeamRound guard: direct call refuses with the structured fallback error')
}

// 41. v0.6 reflection seam (positive): a real Cordis ctx exposes an
//     un-injected service ONLY through `ctx.reflect.get(name)` — the inject-free
//     read — while the property access still throws. The probe must take the
//     reflection seam, never touch the throwing property, and a persistent
//     round must run end to end through the reflected service.
{
  const tools41 = []
  const handlers41 = []
  const spawned41 = []
  const engine41 = fakeEngine()
  const parent41 = { session: { id: 'sess-reflect-team' }, followup() {} }
  const root41 = await mkdtemp(join(tmpdir(), 'cyb-reflect-team-'))

  const messages41 = []
  const team41 = {
    spawnTeammate: async (_caller, req) => {
      spawned41.push(req)
      return { member: { id: 'child-reflect-1', name: req.name, status: 'running' } }
    },
    sendMessage: async (_caller, req) => { messages41.push(req); return { messageId: 'm-1' } },
    interrupt: () => ({ previousStatus: 'running' }),
    listMembers: () => [{ id: 'child-reflect-1', name: spawned41[0]?.name, status: 'inactive' }],
  }
  const reflected41 = []
  let propertyProbes41 = 0
  const ctx41 = {
    tools: { register: (d) => { tools41.push(d); return () => {} } },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null, create: () => ({ id: 'goal-focused' }) },
    workingDirectory: { get: () => root41 },
    agentPresets: { serviceFor: () => engine41 },
    on: (event, fn) => { if (event === 'subagent/end') handlers41.push(fn); return () => {} },
    // Cordis' reflection read: get(name, strict = true) → service value | undefined,
    // no `inject` required and no throw when nothing provides the service.
    reflect: {
      get(name) {
        reflected41.push(name)
        return name === 'agentTeams' ? team41 : undefined
      },
    },
  }
  Object.defineProperty(ctx41, 'agentTeams', {
    configurable: true,
    enumerable: false,
    get() {
      propertyProbes41++
      throw new Error('cannot get property "agentTeams" without inject')
    },
  })
  apply(ctx41, {})
  const tool41 = tools41[0]
  const exec41 = { agent: parent41, signal: undefined }

  assert.equal(teamExecutorAvailable(ctx41), true, 'the reflection seam proves the service available')
  assert.equal(agentTeamsOf(ctx41), team41, 'agentTeamsOf returns the reflected service value')
  assert.ok(reflected41.includes('agentTeams'), 'the service was probed by name through reflect.get')
  assert.equal(propertyProbes41, 0, 'the throwing property access is never reached when reflect answers')

  const started41 = await tool41.execute(
    { action: 'start', title: '反射团队任务', brief: '做 Z', executor: 'persistent', depth: 'quick' },
    exec41,
  )
  assert.equal(spawned41.length, 1, 'persistent round spawned its teammate through the reflected service')
  assert.equal(spawned41[0].context, 'fresh', 'teammates stay provisioned, never forked')
  assert.ok(spawned41[0].name.startsWith('cyb-'), 'member name derives from the goal id')

  for (const h of handlers41) h({ id: 'child-reflect-1', lastAssistantMessage: [{ type: 'text', text: '分析完成 {"done": true, "summary": "reflect ok", "evidence": "e"}' }] })
  await new Promise((r) => setImmediate(r))
  const collected41 = await tool41.execute({ action: 'collect', goalId: started41.goalId }, exec41)
  assert.equal(collected41.decision.reason, 'met', 'quick verdict derives from the reflected teammate output')
  assert.match(collected41.result.report.summary, /reflect ok/)
  console.log('✓ 41 reflection seam: reflect.get supplies agentTeams (throwing property unused), persistent round completes')
}

// 42. v0.6 reflection seam (negative): `reflect.get` answers undefined (no
//     provider) AND the property access throws. Availability must be false, the
//     persistent request must fail with the structured fallback error, and the
//     same ctx must still start an ephemeral round.
{
  const engine42 = fakeEngine()
  const host42 = fakeHost(engine42, { sessionId: 'sess-reflect-absent' })
  const root42 = await mkdtemp(join(tmpdir(), 'cyb-reflect-absent-'))
  host42.ctx.workingDirectory = { get: () => root42 }
  const reflected42 = []
  host42.ctx.reflect = {
    get(name) { reflected42.push(name); return undefined },
  }
  let propertyProbes42 = 0
  Object.defineProperty(host42.ctx, 'agentTeams', {
    configurable: true,
    enumerable: false,
    get() {
      propertyProbes42++
      throw new Error('cannot get property "agentTeams" without inject')
    },
  })
  apply(host42.ctx, {})
  const tool42 = host42.tools[0]
  const exec42 = { agent: host42.parent, signal: undefined }

  assert.equal(agentTeamsOf(host42.ctx), undefined, 'absent reflected service → undefined, not a throw')
  assert.equal(teamExecutorAvailable(host42.ctx), false, 'availability false when reflect answers undefined')
  assert.ok(reflected42.includes('agentTeams'), 'the reflection seam really was consulted first')
  assert.ok(propertyProbes42 > 0, 'the compatibility property access was then attempted and swallowed')

  let rejected42
  try {
    await tool42.execute({ action: 'round', title: '无团队任务', brief: '做 X', executor: 'persistent' }, exec42)
  } catch (error) { rejected42 = error }
  assert.ok(rejected42 instanceof Error, 'persistent on a service-less ctx rejects')
  assert.match(rejected42.message, /needs Agent Teams/, 'structured soft-integration error')
  assert.match(rejected42.message, /ephemeral/, 'the error points at the fallback executor')
  assert.doesNotMatch(rejected42.message, /without inject/, 'never leaks the Cordis proxy exception')

  const runsBefore42 = engine42.runs.length
  const started42 = await tool42.execute({ action: 'start', title: '临时任务', brief: '做 Y' }, exec42)
  assert.equal(started42.started, true)
  assert.equal(engine42.runs.length, runsBefore42 + 1, 'ephemeral round still starts on the service-less ctx')
  assert.match(started42.goalId, /^cyb-/)
  console.log('✓ 42 reflection seam absent: structured error for persistent, ephemeral round still starts')
}

// 43. v0.6 subagent/end capture field (regression): the host's
//     `SubagentRunEndInfo` carries the child's final output as
//     `lastAssistantMessage` (ContentBlock[]); `output` does not exist on that
//     payload. Reading the wrong field made every persistent report empty and
//     the quick verdict unmet. Assert the real field is consumed, and that the
//     legacy `output` shape still works as a compatibility fallback.
{
  const handlers43 = []
  const spawned43 = []
  const tools43 = []
  const root43 = await mkdtemp(join(tmpdir(), 'cyb-capture-'))
  const ctx43 = {
    tools: { register: (d) => { tools43.push(d); return () => {} } },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null, create: () => ({ id: 'goal-focused' }) },
    workingDirectory: { get: () => root43 },
    agentPresets: { serviceFor: () => fakeEngine() },
    on: (event, fn) => { if (event === 'subagent/end') handlers43.push(fn); return () => {} },
    agentTeams: {
      spawnTeammate: async (_caller, req) => {
        spawned43.push(req)
        return { member: { id: `child-capture-${spawned43.length}`, name: req.name, status: 'running' } }
      },
      sendMessage: async () => ({ messageId: 'm-1' }),
      interrupt: () => ({ previousStatus: 'running' }),
      listMembers: () => [{ id: `child-capture-${spawned43.length}`, name: spawned43.at(-1)?.name, status: 'inactive' }],
    },
  }
  apply(ctx43, {})
  const tool43 = tools43[0]
  const exec43 = { agent: { session: { id: 'sess-capture' }, followup() {} }, signal: undefined }

  // (a) the real host payload shape: lastAssistantMessage
  const started43 = await tool43.execute(
    { action: 'start', title: '捕获回归', brief: '做 R', executor: 'persistent', depth: 'quick' },
    exec43,
  )
  for (const h of handlers43) {
    h({
      runId: 'run-43',
      provider: 'spawn',
      id: 'child-capture-1',
      local: true,
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: '任务完成 {"done": true, "summary": "captured ok", "evidence": "e"}' }],
    })
  }
  await new Promise((r) => setImmediate(r))
  const collected43 = await tool43.execute({ action: 'collect', goalId: started43.goalId }, exec43)
  assert.notEqual(collected43.result.report.summary, '', 'lastAssistantMessage reaches the report (empty before the fix)')
  assert.match(collected43.result.report.summary, /captured ok/, 'the child text was parsed from the real host field')
  assert.equal(collected43.result.verdict.met, true, 'quick verdict is met when the real field carries done:true')
  assert.equal(collected43.decision.reason, 'met')

  // (b) compatibility fallback: the legacy/test shape only carries `output`
  const started43b = await tool43.execute(
    { action: 'start', title: '兼容回退', brief: '做 L', executor: 'persistent', depth: 'quick' },
    exec43,
  )
  for (const h of handlers43) {
    h({ id: 'child-capture-2', output: [{ type: 'text', text: '旧形状完成 {"done": true, "summary": "legacy ok", "evidence": "e2"}' }] })
  }
  await new Promise((r) => setImmediate(r))
  const collected43b = await tool43.execute({ action: 'collect', goalId: started43b.goalId }, exec43)
  assert.match(collected43b.result.report.summary, /legacy ok/, 'legacy `output` payload still readable (compat fallback)')
  assert.equal(collected43b.result.verdict.met, true, 'compat fallback still yields a met verdict')
  console.log('✓ 43 subagent/end capture: lastAssistantMessage is the source; legacy `output` still works')
}

// 44. Host-copy resolver: the same file must SKIP the dynamic import (the
//     static import already binds the host copy), and the one-shot resolution
//     record lands in `<workspace>/.cybernetics/publish-debug.log`.
//     Root cause this guards: the plugin's own copy lives under the profile's
//     node_modules, while the running host's Session class comes from the copy
//     bundled with the dsh install. `appendPluginRecord` commits through a
//     module-private `#appendRecord`, so the other copy rejects a Session with
//     `TypeError: Receiver must be an instance of class Session`; the event
//     never lands and the tab falls back to dsh-goal's single slot.
{
  const status = hostSessionStatus()
  assert.equal(status.needsHostImport, false,
    'this process resolves one dsh-session copy: no dynamic import needed')
  assert.equal(status.ownPath, status.hostPath, 'own and host resolution agree on the same file')
  assert.match(status.ownPath, /dsh-session[\\/]lib[\\/]index\.js$/,
    'ownPath points at the dsh-session entry file')
  assert.equal(status.hostAppendReady, false, 'same-file case leaves the static import in charge')

  // A fake host entry that cannot resolve the specifier: the failure is
  // recorded, never thrown, and no dynamic import is attempted.
  const missing = resolveHostSessionCopy('/tmp/cyb-no-such-host-entry.mjs')
  assert.equal(missing.needsHostImport, false, 'unresolvable host copy: no import attempted')
  assert.equal(missing.hostPath, undefined)
  assert.equal(missing.resolvedFrom, undefined)
  assert.ok(typeof missing.error === 'string' && missing.error.length > 0,
    'resolution failure is captured for the debug record')

  // A fake host entry inside this repo resolves the SAME copy → also skipped.
  const sameTree = resolveHostSessionCopy(fileURLToPath(new URL('../src/projection.ts', import.meta.url)))
  assert.equal(sameTree.needsHostImport, false, 'same-file host entry: dynamic import skipped')
  assert.equal(sameTree.hostPath, sameTree.ownPath)

  // Launcher symlinks are followed: `node` keeps argv[1] as the INVOKED path
  // (dsh is started via /opt/homebrew/bin/dsh -> .../lib/bin.js), and resolving
  // from the symlink's own directory cannot find the package.
  const linkDir = await mkdtemp(join(tmpdir(), 'cyb-symlink-entry-'))
  const linkPath = join(linkDir, 'dsh-launcher.mjs')
  const realScript = fileURLToPath(new URL('../test/v03-offline.mjs', import.meta.url))
  await symlink(realScript, linkPath)
  const viaLink = resolveHostSessionCopy(linkPath)
  assert.equal(realpathSync(viaLink.resolvedFrom), realpathSync(realScript),
    'a symlinked entry is resolved through its realpath')
  assert.equal(viaLink.hostPath, viaLink.ownPath, 'still the same copy, so the import is skipped')
  assert.equal(viaLink.needsHostImport, false)
  assert.equal(viaLink.error, undefined, 'following the launcher symlink leaves nothing to report')

  // One-shot record: written once, under the workspace, with no payload data.
  const ws = await mkdtemp(join(tmpdir(), 'cyb-publish-debug-'))
  setPublishDebugRoot(ws)
  const injected = []
  setRecordAppender((_session, type, data) => { injected.push({ type, data }) })
  const dbgSession = { id: 'dbg-session', append: () => ({}), header: { cwd: ws } }
  assert.equal(publishGoals(dbgSession, { goals: [] }), 'published')
  assert.equal(injected.length, 1, 'injected appender still receives publishGoals writes')

  const logPath = join(ws, DEBUG_DIR, DEBUG_FILE)
  assert.equal(DEBUG_DIR, '.cybernetics')
  assert.equal(DEBUG_FILE, 'publish-debug.log')
  assert.ok(existsSync(logPath), 'resolution record written under <workspace>/.cybernetics')
  const lines = (await readFile(logPath, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 1, 'exactly one append-only line per workspace root')
  const record = JSON.parse(lines[0])
  assert.equal(record.event, 'host-session')
  assert.equal(record.specifier, '@deepseek-ai/dsh-session')
  assert.equal(record.needsHostImport, false)
  assert.equal(record.hostAppendReady, false)
  assert.equal(record.ownPath, record.hostPath)
  assert.equal(record.error, null)
  assert.ok(!('data' in record) && !('state' in record), 'no goal payload in the debug record')

  // One line per workspace root, and revisiting a root never appends again.
  const otherWs = await mkdtemp(join(tmpdir(), 'cyb-publish-debug-other-'))
  setPublishDebugRoot(otherWs)
  const otherLines = (await readFile(join(otherWs, DEBUG_DIR, DEBUG_FILE), 'utf8')).trim().split('\n')
  assert.equal(otherLines.length, 1, 'another workspace gets its own single line')
  setPublishDebugRoot(ws)
  assert.equal((await readFile(logPath, 'utf8')).trim().split('\n').length, 1,
    'revisiting a recorded workspace root appends nothing')
  setRecordAppender(undefined)
  console.log('✓ 44 host-copy resolver: same file skips the dynamic import; one line per workspace root')
}

// 45. Production shape, end to end in a child process: `process.argv[1]` is the
//     real dsh launcher (a symlink, exactly as the host is started), so
//     resolution follows it to the HOST copy of dsh-session; that copy's
//     appendPluginRecord lands the event on a host-copy Session (this is the
//     exact call that threw before the fix).
{
  const DSH_PKG = process.env.CYB_HOST_DSH_PKG
    ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'
  const DSH_BIN = join(DSH_PKG, 'lib', 'bin.js')
  // Prefer the launcher symlink (the real invocation path); fall back to bin.js.
  const HOST_ENTRY = existsSync('/opt/homebrew/bin/dsh') ? '/opt/homebrew/bin/dsh' : DSH_BIN
  const HOST_COPY = join(DSH_PKG, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')

  if (!existsSync(DSH_BIN) || !existsSync(HOST_COPY)) {
    // Deterministic skip: another machine may have a single copy only.
    const solo = resolveHostSessionCopy(HOST_ENTRY)
    assert.equal(solo.needsHostImport, false, 'no second copy: nothing to import (static import stays)')
    console.log('✓ 45 cross-copy publish: skipped (this machine has a single dsh-session copy)')
  } else {
    const ws = await mkdtemp(join(tmpdir(), 'cyb-host-copy-'))
    const script = join(ws, 'probe.mjs')
    const projectionPath = fileURLToPath(new URL('../src/projection.ts', import.meta.url))
    await writeFile(script, `
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'

const [workspace, projectionFile, hostEntry, hostCopy] = process.argv.slice(2)
// Pretend to be the host process: the resolver starts from the entry script.
process.argv[1] = hostEntry
const projection = await import(pathToFileURL(projectionFile).href)
// The host-copy import is fire-and-forget; wait until it settles.
for (let i = 0; i < 300; i += 1) {
  const s = projection.hostSessionStatus()
  if (s.hostAppendReady === true || s.loadError !== undefined) break
  await new Promise((resolve) => setTimeout(resolve, 10))
}
projection.setPublishDebugRoot(workspace)
const status = projection.hostSessionStatus()
const core = await import(pathToFileURL(hostCopy).href)
const session = core.Session.create('host-copy-probe')
const result = projection.publishGoals(session, { goals: [{
  goalId: 'cyb-host', title: 'H', objective: 'o', status: 'running', depth: 'full',
  executor: 'ephemeral', round: 1, revisions: [], updatedAt: 1,
}] })
const event = session.log.at(-1)
const debug = await readFile(workspace + '/.cybernetics/publish-debug.log', 'utf8')
console.log(JSON.stringify({
  status,
  result,
  event: event === undefined ? null : { type: event.type, seq: event.seq, ignorable: event.ignorable },
  debug,
}))
`, 'utf8')

    const child = spawnSync(process.execPath, [script, ws, projectionPath, HOST_ENTRY, HOST_COPY], {
      cwd: ws,
      encoding: 'utf8',
      timeout: 90_000,
    })
    assert.equal(child.status, 0, `cross-copy probe failed: ${child.stderr || child.stdout}`)
    const out = JSON.parse(child.stdout.trim().split('\n').at(-1))

    assert.equal(out.status.needsHostImport, true,
      'host entry script resolves a DIFFERENT dsh-session copy')
    assert.equal(out.status.hostAppendReady, true, 'host-copy appendPluginRecord loaded')
    assert.equal(out.status.loadError, undefined, 'host-copy import did not fail')
    assert.equal(out.status.argv1, HOST_ENTRY, 'resolution started from the invoked entry path')
    assert.equal(realpathSync(out.status.resolvedFrom), realpathSync(HOST_ENTRY),
      'the launcher symlink was followed to its real script')
    assert.equal(realpathSync(out.status.hostPath), realpathSync(HOST_COPY),
      'the loaded copy is the host install\'s own file')
    assert.notEqual(realpathSync(out.status.ownPath), realpathSync(HOST_COPY),
      'the plugin\'s static import binds the profile copy (the mismatch being fixed)')
    assert.equal(out.result, 'published',
      'publishGoals returns published (before the fix: cross-copy TypeError → failed)')
    assert.equal(out.event.type, EVENT_TYPE, 'the cybernetics/goals event landed on the host session')
    assert.equal(out.event.seq, 0, 'first event in the session log')
    assert.equal(out.event.ignorable, true, 'plugin record stays ignorable (restart-safe)')

    const debugLine = JSON.parse(out.debug.trim())
    assert.equal(debugLine.needsHostImport, true, 'debug record shows the host copy was imported')
    assert.equal(debugLine.hostAppendReady, true)
    assert.equal(realpathSync(debugLine.hostPath), realpathSync(HOST_COPY))
    assert.equal(realpathSync(debugLine.resolvedFrom), realpathSync(HOST_ENTRY))
    console.log('✓ 45 cross-copy publish: launcher symlink followed, host copy loaded, event lands on a host Session')
  }
}

console.log('\nALL 45 CHECKS PASSED')
