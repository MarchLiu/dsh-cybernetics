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
import { apply, Config, loadBoardFile, saveBoardFile } from '../src/index.ts'
import z from '@deepseek-ai/schemastery'
import { decideAbort, parseAgentModelSpec } from '../src/controller.ts'
import { agentTeamsOf, startTeamRound, teamExecutorAvailable } from '../src/executor.ts'
import { cyberneticsGoalsProjection, goalsFromBoard, publishGoals, setRecordAppender, setAppenderCandidatesForTest, EVENT_TYPE, LEGACY_EVENT_TYPE, resolveHostSessionCopy, hostSessionStatus, setPublishDebugRoot, DEBUG_DIR, DEBUG_FILE, MAX_DEBUG_ERROR_CHARS } from '../src/projection.ts'

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
// v0.9.0: section.text is a FUNCTION of the requesting session; a session
// with no projection state inherits the global config (allGoalsMode default
// false here) and still receives the implicit guidance verbatim.
{
  const guidance = section.text({ agent: { session: { id: 'sess-test' } } })
  assert.match(guidance, /never execute task work/i)
  assert.match(guidance, /TRIVIAL READ-ONLY QUESTION/)
  assert.match(guidance, /LIGHTWEIGHT ANALYSIS/)
  assert.match(guidance, /COMPLEX ANALYSIS/)
  assert.match(guidance, /CORRECTION/)
  assert.match(guidance, /cancel/)
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

// 16b. v0.8.6 default-safe gate semantics + mode-accurate guidance:
//      hardGate:true WITHOUT gateMode must resolve to allowlist (structural);
//      an explicit gateMode:'denylist' is still honored verbatim (partial);
//      hardGate:false installs no gate; guidance must state the real mode and
//      never repeat the pre-v0.8.6 false "all change tools are unavailable"
//      claim while denylist leaves bsk_*/taskboard_*/... callable.
{
  const rootAgent = { id: 'agent-root' }
  const mkCtx = (listeners, sections) => ({
    tools: { register: () => () => {} },
    systemPrompt: { section: (s) => { sections.push(s); return () => {} }, getSectionOrder: () => 0 },
    goals: { get: () => null },
    workingDirectory: { get: () => root },
    agentPresets: { serviceFor: () => undefined },
    agents: { roots: () => [rootAgent] },
    on: (event, fn) => { listeners.push({ event, fn }); return () => {} },
  })
  const longTailWrites = [
    'bash', 'edit', 'write',
    'farm_unregister', 'farm_start', 'taskboard_create', 'taskboard_update',
    'schedule_create', 'bsk_session', 'uno_edit', 'ppt_create', 'config_restore', 'subagent',
  ]
  const safeTools = ['read', 'cybernetics', 'create_goal', 'taskboard_list', 'browser_snapshot']
  const allNames = [...longTailWrites, ...safeTools]

  // (a) hardGate:true, gateMode absent → allowlist wins (default-safe)
  // v0.9.0: section.text is a function of the requesting session; resolve it
  // against a bare session (no projection state = global config decides).
  const sectionText = (s) => (typeof s.text === 'function' ? s.text({ agent: { session: { id: 'gate-test' } } }) : s.text)
  {
    const listeners = []
    const sections = []
    apply(mkCtx(listeners, sections), { hardGate: true })
    const gate = listeners.find((l) => l.event === 'system-prompt/assemble')
    assert.ok(gate, 'default-safe: gate listener registered for hardGate:true alone')
    const assembly = { tools: allNames.map((name) => ({ name })) }
    await gate.fn(assembly, { scope: rootAgent }, () => assembly)
    assert.deepEqual(assembly.tools.map((t) => t.name).sort(), safeTools.slice().sort(),
      'hardGate:true + no gateMode → allowlist survival set (bsk_*/taskboard_*/schedule_*/farm_*/uno_*/ppt_*/config_restore removed)')
    const exec = listeners.find((l) => l.event === 'tools/pre-execute')
    const denied = await exec.fn({ agent: rootAgent, name: 'farm_start' }, async () => ({ kind: 'allow' }))
    assert.equal(denied.kind, 'deny', 'default-safe: long-tail write denied at dispatch, not just hidden')
    // The live symptom was a 121-tool top-level assembly: under the old
    // denylist default 118 of them survived. The default allowlist collapses
    // such an assembly to the survival set.
    const bulk = {
      tools: [
        ...Array.from({ length: 119 }, (_, i) => ({ name: `bsk_tool_${i}` })),
        { name: 'read' }, { name: 'cybernetics' },
      ],
    }
    await gate.fn(bulk, { scope: rootAgent }, () => bulk)
    assert.deepEqual(bulk.tools.map((t) => t.name).sort(), ['cybernetics', 'read'],
      '121-tool assembly collapses to the allowlist survival set (2 kept, 119 long-tail removed)')
    const text = sectionText(sections.at(-1))
    assert.match(text, /HARD GATE ACTIVE \(allowlist mode\)/, 'guidance names allowlist mode')
    assert.match(text, /STRUCTURALLY\s+unavailable/, 'allowlist guidance keeps the strong structural claim')
  }

  // (b) hardGate:true + explicit gateMode:'denylist' → honored (only gatedTools)
  {
    const listeners = []
    const sections = []
    apply(mkCtx(listeners, sections), { hardGate: true, gateMode: 'denylist' })
    const gate = listeners.find((l) => l.event === 'system-prompt/assemble')
    const assembly = { tools: allNames.map((name) => ({ name })) }
    await gate.fn(assembly, { scope: rootAgent }, () => assembly)
    assert.deepEqual(assembly.tools.map((t) => t.name).sort(),
      allNames.filter((n) => !['bash', 'edit', 'write'].includes(n)).sort(),
      'explicit denylist: only bash/edit/write removed; long-tail writes survive (residual risk, no silent upgrade)')
    const exec = listeners.find((l) => l.event === 'tools/pre-execute')
    const allowed = await exec.fn({ agent: rootAgent, name: 'farm_start' }, async () => ({ kind: 'allow' }))
    assert.equal(allowed.kind, 'allow', 'explicit denylist: ungated long-tail write still dispatched')
    const text = sectionText(sections.at(-1))
    assert.match(text, /HARD GATE ACTIVE \(denylist mode\)/, 'guidance names denylist mode')
    assert.match(text, /gatedTools/, 'denylist guidance says exactly what is removed')
    assert.match(text, /PARTIAL, not structural/, 'denylist guidance admits the partial stance')
    assert.ok(!/STRUCTURALLY\s+unavailable/.test(text),
      'denylist guidance must NOT repeat the false "all change tools structurally unavailable" claim')
    assert.match(text, /bypasses the goal loop/, 'denylist guidance still forbids routing around the loop')
  }

  // (c) hardGate:false → no gate installed, no hard-gate guidance
  {
    const listeners = []
    const sections = []
    apply(mkCtx(listeners, sections), {})
    assert.equal(listeners.filter((l) => l.event === 'system-prompt/assemble').length, 0,
      'hardGate:false installs no assemble gate (behavior unchanged)')
    assert.equal(listeners.filter((l) => l.event === 'tools/pre-execute').length, 0,
      'hardGate:false installs no execution gate')
    assert.ok(!sectionText(sections[0]).includes('HARD GATE ACTIVE'),
      'hardGate:false injects no hard-gate guidance')
  }

  // (d) schema leaves gateMode unset (silence preserved for apply() to resolve)
  {
    const silent = Config['~standard'].validate({}).value
    assert.equal(silent.gateMode, undefined, 'schema has no gateMode default (an absent user value stays absent)')
    assert.equal(silent.hardGate.get?.(), true, 'hardGate still defaults on (volatile: live reference)')
    assert.equal(Config['~standard'].validate({ gateMode: 'denylist' }).value.gateMode, 'denylist',
      'explicit denylist survives schema resolution (user intent preserved)')
  }
  console.log('✓ 16b v0.8.6 default-safe gate: hardGate alone → allowlist; explicit denylist honored verbatim; hardGate off → no gate; guidance states the real mode (no false structural claim in denylist)')
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
  // v0.9.0: two projections register — cyberneticsGoals + cyberneticsMode.
  assert.equal(registered.length, 2, 'projection units registered (goals + mode)')
  const unit = registered.find((d) => d.key === 'cyberneticsGoals')
  assert.ok(unit, 'goals projection registered')
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
  const react = { useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(), useState: (v) => [v, () => {}] }
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
  // v0.7.2: configForms stub — whileServed runs its register callback once
  // (namespace served), get returns undefined the settings card guards on.
  const configForms = {
    get: () => undefined,
    whileServed: (_namespaces, register) => { register(new Set()); return () => {} },
  }
  mod.apply({
    effect: (fn) => fn(),
    configForms,
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
  // v0.7.2: the plugins-page list card registers into the official `plugins.item`
  // seat (the 内置插件配置 group) with id = settings namespace id.
  const settings = registered.find((entry) => entry.spec.name === 'plugins.item')
  assert.ok(settings, 'plugins.item settings card registered (内置插件配置 group)')
  assert.equal(settings.spec.id, 'dsh-cybernetics', 'plugins.item id equals the settings namespace')
  const formStub = {
    getSnapshot: () => ({ status: 'ready', value: { allGoalsMode: true }, writable: true }),
    subscribe: () => () => {},
    set: async () => true,
  }
  const summary = settings.view({ ...settings.spec.inject(), t, form: formStub, view: 'summary' })
  assert.match(flatten(summary).join('\n'), /开/, 'settings summary reflects allGoalsMode=true')
  return {
    src, flatten, values, dict, t, tab, injected: tab.spec.inject('sess-client'),
    control, injectedControl: control.spec.inject('sess-client'), listSnapshot, settings,
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

// 44. Host-copy resolver: BOTH dynamic candidates are loaded unconditionally
//     (the old "same path → skip" short-circuit is gone), and the one-shot
//     resolution record lands in `<workspace>/.cybernetics/publish-debug.log`.
//     Root cause this guards: the plugin's own copy lives under the profile's
//     node_modules, while the running host's Session class comes from the copy
//     bundled with the dsh install. `appendPluginRecord` commits through a
//     module-private `#appendRecord`, so the other copy rejects a Session with
//     `TypeError: Receiver must be an instance of class Session`; the event
//     never lands and the tab falls back to dsh-goal's single slot.
{
  const status = hostSessionStatus()
  assert.equal(status.needsHostImport, false,
    'this process resolves one dsh-session copy (both candidates are still loaded)')
  assert.equal(status.ownPath, status.hostPath, 'own and host resolution agree on the same file')
  assert.match(status.ownPath, /dsh-session[\\/]lib[\\/]index\.js$/,
    'ownPath points at the dsh-session entry file')
  // Policy change (v0.6+): the "same path → skip the dynamic import"
  // short-circuit is GONE. Both dynamic candidates are loaded unconditionally
  // (deduped by realpath), because the host copy resolving to the same file as
  // our static import did NOT mean the host's Session class came from it.
  assert.equal(status.hostAppendReady, true,
    'dynamic candidates load even when they resolve to the static import copy')
  assert.equal(status.pluginAppendReady, true, 'the plugin-package copy is loaded as the third candidate')
  assert.match(status.pluginPath, /dsh-session[\\/]lib[\\/]index\.js$/,
    'the third candidate is <packageRoot>/node_modules/@deepseek-ai/dsh-session/lib/index.js')

  // A fake host entry that cannot resolve the specifier: the failure is
  // recorded, never thrown, and only the static/plugin candidates remain.
  const missing = resolveHostSessionCopy('/tmp/cyb-no-such-host-entry.mjs')
  assert.equal(missing.needsHostImport, false, 'unresolvable host copy: no host candidate')
  assert.equal(missing.hostPath, undefined)
  assert.equal(missing.resolvedFrom, undefined)
  assert.ok(typeof missing.error === 'string' && missing.error.length > 0,
    'resolution failure is captured for the debug record')

  // A fake host entry inside this repo resolves the SAME copy — resolution
  // still reports it truthfully; loading is no longer gated on that.
  const sameTree = resolveHostSessionCopy(fileURLToPath(new URL('../src/projection.ts', import.meta.url)))
  assert.equal(sameTree.needsHostImport, false, 'same-file host entry resolves one copy')
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
  assert.equal(viaLink.hostPath, viaLink.ownPath, 'still the same copy')
  assert.equal(viaLink.needsHostImport, false)
  assert.equal(viaLink.error, undefined, 'following the launcher symlink leaves nothing to report')

  // Records: one one-shot resolution line per workspace root, plus one publish
  // result line per publish. No payload data in either.
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
  assert.ok(existsSync(logPath), 'records written under <workspace>/.cybernetics')
  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const hostLines = lines.filter((line) => line.event === 'host-session')
  assert.equal(hostLines.length, 1, 'exactly one resolution line per workspace root')
  const publishLines = lines.filter((line) => line.event === 'publish')
  assert.equal(publishLines.length, 1, 'one publish-result line per publish')
  const record = hostLines[0]
  assert.equal(record.specifier, '@deepseek-ai/dsh-session')
  assert.equal(record.needsHostImport, false)
  assert.equal(record.hostAppendReady, true)
  assert.equal(record.pluginAppendReady, true)
  assert.equal(record.ownPath, record.hostPath)
  assert.equal(record.error, null)
  assert.equal(publishLines[0].result, 'published')
  assert.equal(publishLines[0].candidate, 'injected', 'the test-injected appender is labelled')
  assert.ok(!('data' in record) && !('state' in record), 'no goal payload in the debug record')
  assert.ok(!('data' in publishLines[0]) && !('state' in publishLines[0]),
    'no goal payload in the publish record')

  // One resolution line per workspace root, and revisiting a root never
  // appends another one (publish lines are per publish, by design).
  const otherWs = await mkdtemp(join(tmpdir(), 'cyb-publish-debug-other-'))
  setPublishDebugRoot(otherWs)
  const otherLines = (await readFile(join(otherWs, DEBUG_DIR, DEBUG_FILE), 'utf8')).trim().split('\n')
  assert.equal(otherLines.length, 1, 'another workspace gets its own single resolution line')
  setPublishDebugRoot(ws)
  const afterRevisit = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(afterRevisit.filter((line) => line.event === 'host-session').length, 1,
    'revisiting a recorded workspace root appends no second resolution line')
  assert.equal(afterRevisit.length, 2, 'resolution line + one publish line only')
  setRecordAppender(undefined)
  console.log('✓ 44 host-copy resolver: both copies load unconditionally; resolution + publish records')
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
    assert.equal(solo.needsHostImport, false, 'no second copy: host and static candidates coincide')
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
// Both dynamic candidates are fire-and-forget; wait until they settle.
for (let i = 0; i < 300; i += 1) {
  const s = projection.hostSessionStatus()
  if ((s.hostAppendReady === true && s.pluginAppendReady === true) || s.loadError !== undefined) break
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
const debug = (await readFile(workspace + '/.cybernetics/publish-debug.log', 'utf8'))
  .trim().split('\\n').map((line) => JSON.parse(line))
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
    assert.equal(out.status.pluginAppendReady, true, 'the plugin-package copy loaded too')
    assert.equal(out.status.loadError, undefined, 'dynamic candidate imports did not fail')
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

    const debugHost = out.debug.find((line) => line.event === 'host-session')
    const debugPublish = out.debug.find((line) => line.event === 'publish')
    assert.ok(debugHost !== undefined, 'resolution record present')
    assert.ok(debugPublish !== undefined, 'publish-result record present')
    assert.equal(debugHost.needsHostImport, true, 'debug record shows the host copy was imported')
    assert.equal(debugHost.hostAppendReady, true)
    assert.equal(realpathSync(debugHost.hostPath), realpathSync(HOST_COPY))
    assert.equal(realpathSync(debugHost.resolvedFrom), realpathSync(HOST_ENTRY))
    assert.equal(debugPublish.result, 'published')
    assert.match(debugPublish.candidate, /^#1 host /,
      'the host copy is the winning candidate (static import was candidate #0)')
    assert.equal(realpathSync(debugPublish.candidate.replace(/^#\d+ \w+ /, '')), realpathSync(HOST_COPY),
      'the winner label carries the host copy path')
    assert.ok(Array.isArray(debugPublish.errors) && debugPublish.errors.length >= 1,
      'the rejected static-import candidate left its error behind')
    assert.match(debugPublish.errors[0], /Receiver must be an instance of class Session/,
      'the recorded error is the exact cross-copy brand rejection')
    assert.ok(!('data' in debugPublish) && !('state' in debugPublish),
      'no goal payload in the publish record')
    console.log('✓ 45 cross-copy publish: launcher symlink followed, host copy wins, event lands on a host Session')
  }
}

// 46. Candidate chain: the static import rejects a foreign Session with the
//     private-field brand error, the NEXT candidate accepts it. Publishing
//     succeeds and the debug record names the winning candidate.
{
  const ws = await mkdtemp(join(tmpdir(), 'cyb-candidates-'))
  setPublishDebugRoot(ws)
  setRecordAppender(undefined)
  const accepted = []
  setAppenderCandidatesForTest([
    {
      kind: 'static',
      path: '/fake/core/@deepseek-ai/dsh-session/lib/index.js',
      append: () => { throw new TypeError('Receiver must be an instance of class Session') },
    },
    {
      kind: 'host',
      path: '/fake/profile/@deepseek-ai/dsh-session/lib/index.js',
      append: (_session, type, data) => { accepted.push({ type, data }); return { ok: true } },
    },
  ])
  const session = { id: 'candidate-session', append: () => ({}), header: { cwd: ws } }
  const state = {
    goals: [{
      goalId: 'cyb-cand', title: 'C', objective: 'o', status: 'running', depth: 'full',
      executor: 'ephemeral', round: 1, revisions: [], updatedAt: 1,
    }],
  }
  assert.equal(publishGoals(session, state), 'published',
    'second candidate accepts the record after the first rejects the brand')
  assert.equal(accepted.length, 1, 'exactly one candidate landed the record')
  assert.equal(accepted[0].type, EVENT_TYPE)

  const lines = (await readFile(join(ws, DEBUG_DIR, DEBUG_FILE), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line))
  const publish = lines.filter((line) => line.event === 'publish').at(-1)
  assert.equal(publish.result, 'published')
  assert.equal(publish.candidate, '#1 host /fake/profile/@deepseek-ai/dsh-session/lib/index.js',
    'the debug record names the winning candidate (index + kind + path)')
  assert.equal(publish.errors.length, 1, 'the rejected candidate is still reported')
  assert.match(publish.errors[0], /^#0 static /)
  assert.match(publish.errors[0], /Receiver must be an instance of class Session/)
  assert.ok(!('data' in publish) && !('state' in publish), 'no goal payload in the publish record')
  setAppenderCandidatesForTest(undefined)
  setRecordAppender(undefined)
  console.log('✓ 46 candidate chain: brand rejection falls through; winning candidate recorded')
}

// 47. Every candidate rejects: the publish degrades to `failed` (a publish must
//     never break the round) and the debug record keeps each truncated error.
{
  const ws = await mkdtemp(join(tmpdir(), 'cyb-candidates-fail-'))
  setPublishDebugRoot(ws)
  setRecordAppender(undefined)
  const long = 'x'.repeat(900)
  setAppenderCandidatesForTest([
    {
      kind: 'static',
      path: '/fake/a/lib/index.js',
      append: () => { throw new TypeError('Receiver must be an instance of class Session') },
    },
    {
      kind: 'host',
      path: '/fake/b/lib/index.js',
      append: () => { throw new Error(`host exploded ${long}`) },
    },
  ])
  const session = { id: 'allfail-session', append: () => ({}), header: { cwd: ws } }
  assert.equal(publishGoals(session, { goals: [] }), 'failed',
    'all candidates rejecting is a failed publish, not a thrown round')
  const lines = (await readFile(join(ws, DEBUG_DIR, DEBUG_FILE), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line))
  const publish = lines.filter((line) => line.event === 'publish').at(-1)
  assert.equal(publish.result, 'failed')
  assert.equal(publish.candidate, null, 'no winning candidate when every candidate fails')
  assert.equal(publish.errors.length, 2, 'one error excerpt per rejected candidate')
  assert.match(publish.errors[0], /Receiver must be an instance of class Session/)
  assert.match(publish.errors[1], /host exploded/)
  for (const entry of publish.errors) {
    const detail = entry.replace(/^#\d+ \w+ [^:]*: /, '')
    assert.ok(detail.length <= MAX_DEBUG_ERROR_CHARS,
      `error excerpt truncated to ${MAX_DEBUG_ERROR_CHARS} chars`)
  }
  setAppenderCandidatesForTest(undefined)
  setRecordAppender(undefined)
  console.log('✓ 47 all candidates reject: publish reports failed, debug record carries truncated errors')
}

// 48. v0.7 all-goals mode: the injected prompt section carries the four routing
//     rules (everything enters a goal / quick single round / progressive
//     multi-round for analysis + write tasks / revise auto-abort decision tree);
//     with the mode off the section is absent
{
  const toolsOff = []
  const ctxOff = {
    tools: { register: (d) => { toolsOff.push(d); return () => {} } },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null },
    workingDirectory: { get: () => root },
    agentPresets: { serviceFor: () => undefined },
  }
  let sectionOff
  ctxOff.systemPrompt.section = (s) => { sectionOff = s }
  apply(ctxOff, {})
  assert.ok(sectionOff, 'implicit trigger section still injected')
  assert.ok(!/ALL-GOALS MODE ACTIVE/.test(sectionOff.text({ agent: { session: { id: 'allgoals-test' } } })), 'mode off: no all-goals routing section (behavior unchanged)')

  const toolsOn = []
  const ctxOn = { ...ctxOff, tools: { register: (d) => { toolsOn.push(d); return () => {} } } }
  let sectionOn
  ctxOn.systemPrompt.section = (s) => { sectionOn = s }
  apply(ctxOn, { allGoalsMode: true })
  assert.ok(sectionOn, 'section injected in all-goals mode')
  const t = sectionOn.text({ agent: { session: { id: 'allgoals-test' } } })
  assert.match(t, /ALL-GOALS MODE ACTIVE/, 'rule 1: the mode header is present')
  assert.match(t, /EVERYTHING ENTERS A GOAL/, 'rule 1: every request enters a goal, no in-place analysis')
  assert.match(t, /SIMPLE READ-ONLY REQUEST → depth 'quick'/, 'rule 2: quick single-round routing')
  assert.match(t, /COMPLEX ANALYSIS or WRITE TASK → depth 'full', progressive multi-round/, 'rule 3: progressive multi-round routing')
  assert.match(t, /RULE 4 — REVISE DECISION TREE/, 'rule 4: revise auto decision tree present')
  assert.match(t, /\(a\) old round STILL RUNNING and the revision contradicts it/, 'rule 4a: conflict → auto-abort')
  assert.match(t, /\(b\) old round STILL RUNNING but the correction keeps the objective/, 'rule 4b: valuable/parallel → wait')
  assert.match(t, /\(c\) old task agent ALREADY FINISHED/, 'rule 4c: finished → start directly')
  console.log('✓ 48 all-goals mode prompt: four routing rules injected only when the mode is on')
}

// 49. v0.7 revise auto-abort decision tree (pure helper): explicit flag wins;
//     not running → start directly; running + retarget → abort; running +
//     same objective → wait
{
  const loop = (depth) => ({ goalId: 'g', status: 'running', depth })
  const explicit = decideAbort(loop('full'), true, { abortPrevious: true })
  assert.deepEqual([explicit.abort, explicit.mode], [true, 'explicit'])
  const keep = decideAbort(loop('full'), true, { abortPrevious: false })
  assert.deepEqual([keep.abort, keep.mode], [false, 'explicit'])
  // (c) finished agent → no abort
  const c = decideAbort(loop('full'), false, {})
  assert.deepEqual([c.abort, c.mode], [false, 'auto'])
  assert.match(c.basis, /无在跑轮|直接启动/)
  // (a) running + objective rewritten → abort
  const a = decideAbort(loop('full'), true, { objective: '新目标' })
  assert.deepEqual([a.abort, a.mode], [true, 'auto'])
  assert.match(a.basis, /冲突|中止/)
  const a2 = decideAbort(loop('full'), true, { depth: 'quick' })
  assert.deepEqual([a2.abort, a2.mode], [true, 'auto'], 'depth change also retargets')
  const a3 = decideAbort(loop('quick'), true, { depth: 'quick' })
  assert.deepEqual([a3.abort, a3.mode], [false, 'auto'], 'same-depth override does not retarget')
  // (b) running + brief-only correction → wait
  const b = decideAbort(loop('full'), true, {})
  assert.deepEqual([b.abort, b.mode], [false, 'auto'])
  assert.match(b.basis, /等待|自然结束/)
  console.log('✓ 49 revise auto-abort helper: explicit/manual preserved; finished→direct start, retarget→abort, correction→wait')
}

// 50. v0.7 revise with allGoalsMode on: omitted abortPrevious auto-aborts a
//     contradicting in-flight round (goal rewritten), waits for a same-objective
//     correction, starts directly after the old agent finished — and the audit
//     jsonl line records the decision mode + basis in all three states
{
  const metRound = {
    round: 1,
    report: { summary: '完成', done: true, artifacts: [], evidence: 'e', nextStepThoughts: [] },
    verdict: { met: true, criteria: [], gaps: [], goalItselfQuestionable: false },
    triage: { auto: [], defer: [], reject: [], human: [] },
  }
  const mk = async () => {
    const e = fakeEngine()
    const host = fakeHost(e, { sessionId: `sess-test-50-${Math.random().toString(36).slice(2, 8)}` })
    host.ctx.workingDirectory = { get: () => root }
    apply(host.ctx, { allGoalsMode: true })
    return { tool: host.tools[0], exec: { agent: host.parent, signal: undefined }, e }
  }
  const auditLine = async (goalId) =>
    JSON.parse((await readFile(join(root, '.cybernetics', `revisions-${goalId}.jsonl`), 'utf8')).trim().split('\n').at(-1))

  // (a) running + objective rewritten → auto abort
  {
    const { tool, exec, e } = await mk()
    const g = await tool.execute({ action: 'start', title: '旧方向', brief: 'b' }, exec)
    const oldRun = e.runs[0]
    const r = await tool.execute({ action: 'revise', goalId: g.goalId, reason: '目标被校准，旧方向作废', objective: '新目标' }, exec)
    assert.equal(oldRun.cancelled, true, 'auto: contradicting in-flight round is cancelled')
    assert.equal(r.abort.mode, 'auto')
    assert.equal(r.abort.abort, true)
    assert.match(r.abort.basis, /冲突|中止/)
    const rec = await auditLine(r.goalId)
    assert.equal(rec.abort.abort, true, 'audit records the abort decision')
    assert.equal(rec.abort.mode, 'auto')
    assert.match(rec.abort.basis, /冲突|中止/, 'audit records the decision basis')
    oldRun.settle({ stopReason: 'cancelled', error: 'superseded' })
  }

  // (b) running + same objective → wait (old run untouched, audit says auto/false)
  {
    const { tool, exec, e } = await mk()
    const g = await tool.execute({ action: 'start', title: '可复用任务', brief: 'b' }, exec)
    const oldRun = e.runs[0]
    const r = await tool.execute({ action: 'revise', goalId: g.goalId, reason: '补充验收标准' }, exec)
    assert.equal(oldRun.cancelled, false, 'auto: valuable in-flight round keeps running')
    assert.deepEqual([r.abort.abort, r.abort.mode], [false, 'auto'])
    assert.match(r.abort.basis, /等待|自然结束/)
    const rec = await auditLine(r.goalId)
    assert.deepEqual([rec.abort.abort, rec.abort.mode], [false, 'auto'])
    assert.match(rec.abort.basis, /等待|自然结束/)
    // settle the successor so the fixture exits cleanly; old run settles silently (superseded)
    e.runs.at(-1).settle({ stopReason: 'completed', value: metRound })
    oldRun.settle({ stopReason: 'cancelled', error: 'superseded' })
  }

  // (c) old agent finished → direct start, no abort attempted
  {
    const { tool, exec, e } = await mk()
    const g = await tool.execute({ action: 'start', title: '已完成任务', brief: 'b' }, exec)
    e.runs[0].settle({ stopReason: 'completed', value: metRound })
    await new Promise((r) => setImmediate(r))
    await tool.execute({ action: 'collect', goalId: g.goalId }, exec)
    const r = await tool.execute({ action: 'revise', goalId: g.goalId, reason: '完成后微调' }, exec)
    assert.deepEqual([r.abort.abort, r.abort.mode], [false, 'auto'])
    assert.match(r.abort.basis, /无在跑轮|直接启动/)
    const rec = await auditLine(r.goalId)
    assert.match(rec.abort.basis, /无在跑轮|直接启动/)
    e.runs.at(-1).settle({ stopReason: 'completed', value: metRound })
  }

  // Backward compat: allGoalsMode OFF, omitted flag → still no abort (v0.6 default).
  {
    const e = fakeEngine()
    const host = fakeHost(e, { sessionId: 'sess-test-50-off' })
    host.ctx.workingDirectory = { get: () => root }
    apply(host.ctx, {})
    const tool = host.tools[0]
    const exec = { agent: host.parent, signal: undefined }
    const g = await tool.execute({ action: 'start', title: '兼容任务', brief: 'b' }, exec)
    const oldRun = e.runs[0]
    const r = await tool.execute({ action: 'revise', goalId: g.goalId, reason: '目标重写', objective: '全新目标' }, exec)
    assert.equal(oldRun.cancelled, false, 'mode off: omitted abortPrevious still defaults to false (unchanged)')
    assert.deepEqual([r.abort.abort, r.abort.mode], [false, 'explicit'], 'mode off: explicit-false semantics recorded')
    const rec = await auditLine(r.goalId)
    assert.equal(rec.abort.abort, false)
    oldRun.settle({ stopReason: 'cancelled', error: 'superseded' })
    e.runs.at(-1).settle({ stopReason: 'completed', value: metRound })
  }
  console.log('✓ 50 revise auto policy: contradicting→abort, correction→wait, finished→direct; audit lines carry mode+basis; mode off unchanged')
}

// --- v0.7.1: settings-panel Config schema (schemastery) ----------------------
// The Web editor's plugin config panel derives the form from the exported
// schemastery `Config` (0.1.7 settings model); the loader validates the raw
// patch config through Config['~standard'].validate before apply() runs.
{
  assert.equal(typeof Config, 'function', 'Config schema is exported (callable schemastery schema)')
  assert.equal(Config.dict.allGoalsMode.meta?.volatile, true, 'allGoalsMode is volatile (live panel toggle, no remount)')
  assert.equal(Config.dict.hardGate.meta?.volatile, true, 'hardGate is volatile (v0.8.10: settings-card toggle, gate listeners hot-installed/disposed)')
  // Loader-path validation of the shipped patch config (cordis.patch.yml values).
  const patch = { hardGate: true, gateMode: 'allowlist', gateAllowlistExtra: ['spawn_teammate', 'send_message', 'interrupt_agent'], roles: { default: { provider: 'p', model: 'm' } } }
  const v = Config['~standard'].validate(patch).value
  assert.equal(v.issues, undefined)
  assert.equal(v.hardGate.get?.(), true, 'volatile hardGate resolves to a live reference (patch value true)')
  assert.equal(v.allGoalsMode.get?.(), false, 'volatile boolean resolves to a live reference (default off)')
  assert.equal(Config.dict.roles.meta?.volatile, undefined, 'roles is NOT volatile since v0.8.4 (gone from the panel; configured via profile yaml)')
  assert.equal(Config.dict.roundsPerSubgoal.meta?.volatile, true, 'roundsPerSubgoal is volatile (panel-editable)')
  assert.equal(Config.dict.maxConcurrentRounds.meta?.volatile, true, 'maxConcurrentRounds is volatile (panel-editable)')
  assert.equal(Config.dict.noticePolicy.meta?.volatile, true, 'noticePolicy is volatile (v0.13.0: panel-editable, live on the very next settled round)')
  assert.deepEqual(v.roles.default, { provider: 'p', model: 'm' }, 'non-volatile roles resolves to a plain object (survives schema resolution)')
  // Schema-resolved arrays arrive as [] when unset — apply() must fall back to
  // the built-in gate sets, otherwise the hard gate would keep/gate nothing.
  assert.deepEqual(v.gatedTools, [])
  const sections = []
  const ctx = {
    tools: { register: () => () => {} },
    systemPrompt: { section: (s) => { sections.push(s); return () => {} }, getSectionOrder: () => 0 },
    goals: { get: () => null },
    workingDirectory: { get: () => '/tmp' },
    agentPresets: { serviceFor: () => undefined },
    on: () => () => {},
  }
  apply(ctx, v)
  assert.ok(typeof sections[0].text === 'function' && sections[0].text({ agent: { session: { id: 'loader-test' } } }).includes('HARD GATE ACTIVE'), 'loader-path hardGate:true renders hard-gate guidance')
  // Plain-config path (no schema resolution — offline harness style) unchanged.
  const plain = []
  apply({ tools: { register: () => () => {} }, systemPrompt: { section: (s) => { plain.push(s); return () => {} }, getSectionOrder: () => 0 } }, { allGoalsMode: true })
  assert.ok(plain[0].text({ agent: { session: { id: 'loader-test' } } }).length > 300, 'plain-config allGoalsMode:true still injects guidance')
  console.log('✓ 51 settings-panel Config schema: volatile allGoalsMode + hardGate refs, loader-path gate defaults intact')
}

// 52. v0.7.2 plugins-page settings card: plugins.row.config / plugins.bundle.config
//     seats registered with the right dispatch keys and bound to the row's
//     ConfigForm; the toggle writes allGoalsMode through form.set; the summary
//     view renders the current state; an unserved namespace degrades gracefully.
{
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /plugins\.row\.config/, 'row config seat registered (plugins.page 配置 control)')
  assert.match(client, /plugins\.bundle\.config/, 'bundle config seat registered (bundle page)')
  assert.match(client, /bundleKey \+ '#' \+ SETTINGS_ENTRY_ID/, 'row seat key is <bundle>#<row id>')
  assert.match(client, /configForms\.get\(SETTINGS_ENTRY_ID\)/, 'binds the row namespace ConfigForm')

  let loaded
  globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m } } }
  new Function('window', client)(globalThis.window)
  const jsx = {
    jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
    jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
  }
  const react = { useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(), useState: (v) => [v, () => {}] }
  const mod = loaded.factory((req) => (req === 'react' ? react : jsx))

  // Fake ConfigForm for the `dsh-cybernetics` namespace (ConfigForm contract:
  // getSnapshot / subscribe / set / mutate / unset).
  let snap = { status: 'ready', value: { allGoalsMode: false }, writable: true }
  const listeners = new Set()
  const writes = []
  const form = {
    getSnapshot: () => snap,
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    set: async (field, value) => {
      writes.push({ field, value })
      snap = { ...snap, value: { ...snap.value, [field]: value } }
      listeners.forEach((cb) => cb())
      return true
    },
    mutate: async () => true,
    unset: async () => true,
  }
  const registered = []
  const t = (key) => key
  mod.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => t },
    slots: { inject: (_n, cb) => cb(), register: (spec, view) => { registered.push({ spec, view }) } },
    sessions: {},
    configForms: {
      get: (id) => { assert.equal(id, 'dsh-cybernetics'); return form },
      whileServed: (_namespaces, register) => { register(new Set()); return () => {} },
    },
  })
  const rowSeat = registered.find((e) => e.spec.name === 'plugins.row.config' && e.spec.key === 'dsh-cybernetics#dsh-cybernetics')
  const rowSeatScoped = registered.find((e) => e.spec.key === '@mars.liu/dsh-cybernetics#dsh-cybernetics')
  const bundleSeat = registered.find((e) => e.spec.name === 'plugins.bundle.config' && e.spec.key === 'dsh-cybernetics')
  assert.ok(rowSeat && bundleSeat && rowSeatScoped, 'all three seats registered with dispatch keys')

  const flatten = (node, out = []) => {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
    if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
    if (typeof node.type === 'function') { flatten(node.type(node.props), out); return out }
    if (node.props && node.props.children !== undefined) flatten(node.props.children, out)
    return out
  }
  const findSwitch = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return undefined
    if (node.props && node.props.role === 'switch') return node
    if (Array.isArray(node)) { for (const n of node) { const hit = findSwitch(n); if (hit) return hit } return undefined }
    if (node.props && node.props.children !== undefined) return findSwitch(node.props.children)
    return undefined
  }
  const face = { form, view: 'page', t }
  const pageText = flatten(rowSeat.view(face)).join('\n')
  assert.match(pageText, /settings\.title/, 'page view renders the toggle row')
  const rendered = findSwitch(rowSeat.view(face))
  assert.ok(rendered, 'toggle exposes role=switch')
  assert.equal(rendered.props['aria-checked'], false, 'reflects the accepted value (off)')
  // Toggle write path: clicking the switch calls form.set on the field.
  rendered.props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(writes, [{ field: 'allGoalsMode', value: true }], 'toggle writes allGoalsMode via ConfigForm.set')
  assert.equal(findSwitch(rowSeat.view(face)).props['aria-checked'], true, 'next snapshot reflects the accepted write')
  // Summary view: one-liner only.
  const summary = flatten(rowSeat.view({ ...face, view: 'summary' })).join('\n')
  assert.match(summary, /settings\.summaryOn/, 'summary view renders the state one-liner')
  // Degrades without a served namespace.
  const none = flatten(rowSeat.view({ form: undefined, view: 'page', t })).join('\n')
  assert.match(none, /settings\.unavailable/, 'absent form renders the unavailable state, no crash')
  console.log('✓ 52 plugins-page settings card: seats + keys + ConfigForm toggle write + summary + unavailable fallback')
}

// 53. v0.7.3 settings card host-form shape: on the plugins.item / plugins.row.config
//     detail pages the OWNER prop form wins over the injected one (renderer
//     renderEntry spreads ...injected, ...ownerProps) and carries the host's
//     ConfigPageForm { state, mutate } instead of a live ConfigForm. The card
//     must render from `state` and write through `mutate` (never touching
//     `.subscribe`, which this shape lacks — the v0.7.2 crash).
{
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded
  globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m } } }
  new Function('window', client)(globalThis.window)
  const jsx = {
    jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
    jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
  }
  const react = { useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(), useState: (v) => [v, () => {}] }
  const mod = loaded.factory((req) => (req === 'react' ? react : jsx))
  const registered = []
  const t = (key) => key
  mod.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => t },
    slots: { inject: (_n, cb) => cb(), register: (spec, view) => { registered.push({ spec, view }) } },
    sessions: {},
    configForms: {
      get: () => { throw new Error('namespace not served in this harness') },
      whileServed: (_namespaces, register) => { register(new Set()); return () => {} },
    },
  })
  const itemSeat = registered.find((e) => e.spec.name === 'plugins.item')
  assert.ok(itemSeat, 'plugins.item seat registered through whileServed')

  const flatten = (node, out = []) => {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
    if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
    if (typeof node.type === 'function') { flatten(node.type(node.props), out); return out }
    if (node.props && node.props.children !== undefined) flatten(node.props.children, out)
    return out
  }
  const findSwitch = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return undefined
    if (node.props && node.props.role === 'switch') return node
    if (Array.isArray(node)) { for (const n of node) { const hit = findSwitch(n); if (hit) return hit } return undefined }
    if (node.props && node.props.children !== undefined) return findSwitch(node.props.children)
    return undefined
  }

  // Host ConfigPageForm: a frozen snapshot + mutate; NO subscribe/getSnapshot/set.
  const mutations = []
  let state = { status: 'ready', value: { allGoalsMode: false }, writable: true, revision: 7 }
  const hostForm = {
    get state() { return state },
    mutate: async (ops, revision) => {
      mutations.push({ ops, revision })
      state = { ...state, value: { ...state.value, allGoalsMode: ops[0].value }, revision: revision + 1 }
      return true
    },
  }
  const face = { form: hostForm, view: 'page', t }
  const pageText = flatten(itemSeat.view(face)).join('\n')
  assert.match(pageText, /settings\.title/, 'host-shape form renders the toggle row (no crash on missing subscribe)')
  const rendered = findSwitch(itemSeat.view(face))
  assert.ok(rendered, 'host-shape toggle exposes role=switch')
  assert.equal(rendered.props['aria-checked'], false, 'host-shape reflects state.value (off)')
  rendered.props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(mutations, [{ ops: [{ op: 'set', path: ['allGoalsMode'], value: true }], revision: 7 }],
    'host-shape toggle writes allGoalsMode via ConfigPageForm.mutate carrying the snapshot revision')
  assert.equal(findSwitch(itemSeat.view(face)).props['aria-checked'], true, 're-rendered host state reflects the accepted write')
  // An owner form of undefined (namespace momentarily unserved) degrades gracefully.
  const none = flatten(itemSeat.view({ form: undefined, view: 'page', t })).join('\n')
  assert.match(none, /settings\.unavailable/, 'absent owner form renders the unavailable state, no crash')
  console.log('✓ 53 settings card host ConfigPageForm shape: state render + mutate write + no-subscribe crash regression')
}

// 54. v0.7.6 path-(b) settings write: the host ConfigFormController collapses
//     a refusal into a bare `false` and swallows the host RemoteError message.
//     The card must retry ONCE through the plugin's own remote.settings.mutate
//     (the SAME write path: SettingsForms.write → configEditor.edit → the USER
//     patch row `{id, name, config}` in the profile cordis.patch.yml, applied
//     by reconcileProfilePatches) with NO expectedRevision — so a stale
//     revision heals and a hard refusal surfaces its exact host message via
//     settings.saveFailedDetail. A primary success must NOT touch the fallback.
{
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /'remote\.settings'/, 'client module declares the remote.settings inject')
  assert.match(client, /settingsDirectMutate/, 'apply binds the direct settings transport into the card props')
  assert.match(client, /settings\.saveFailedDetail/, 'card renders the host refusal detail line')

  let loaded
  globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m } } }
  new Function('window', client)(globalThis.window)
  const jsx = {
    jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
    jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
  }
  // Stateful react stub: useState slots persist across renders so the failure
  // detail line (set asynchronously inside toggle) is observable.
  const slotsMem = []
  let slotIndex = 0
  const react = {
    useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(),
    useState: (initial) => {
      const i = slotIndex++
      if (slotsMem[i] === undefined) {
        slotsMem[i] = {
          value: initial,
          set: (nv) => { slotsMem[i].value = typeof nv === 'function' ? nv(slotsMem[i].value) : nv },
        }
      }
      return [slotsMem[i].value, slotsMem[i].set]
    },
  }
  const mod = loaded.factory((req) => (req === 'react' ? react : jsx))
  const registered = []
  const t = (key, params) => key + (params && params.message !== undefined ? ':' + params.message : '')
  mod.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => t },
    slots: { inject: (_n, cb) => cb(), register: (spec, view) => { registered.push({ spec, view }) } },
    sessions: {},
    configForms: {
      get: () => undefined,
      whileServed: (_namespaces, register) => { register(new Set()); return () => {} },
    },
    // No ctx.remote in the harness: apply must guard and leave it undefined.
  })
  const seat = registered.find((e) => e.spec.name === 'plugins.item')
  assert.ok(seat, 'plugins.item seat registered')
  const flatten = (node, out = []) => {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
    if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
    if (typeof node.type === 'function') { flatten(node.type(node.props), out); return out }
    if (node.props && node.props.children !== undefined) flatten(node.props.children, out)
    return out
  }
  const findSwitch = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return undefined
    if (node.props && node.props.role === 'switch') return node
    if (Array.isArray(node)) { for (const n of node) { const hit = findSwitch(n); if (hit) return hit } return undefined }
    if (node.props && node.props.children !== undefined) return findSwitch(node.props.children)
    return undefined
  }
  const render = (f) => { slotIndex = 0; return flatten(seat.view(f ?? face)).join('\n') }

  // Case A: primary write refuses, direct fallback reports ok:false with the
  // host message — the card must carry the message into saveFailedDetail and
  // call the fallback with NO expectedRevision (unconditional write).
  {
    const directCalls = []
    let state = { status: 'ready', value: { allGoalsMode: false }, writable: true, revision: 7 }
    var face = {
      form: {
        get state() { return state },
        mutate: async () => false, // host ConfigFormController refusal: bare false
      },
      directMutate: async (ops, expectedRevision) => {
        directCalls.push({ ops, expectedRevision })
        return { ok: false, error: { message: 'Config field "allGoalsMode" is not volatile' } }
      },
      view: 'page',
      t,
    }
    const before = render()
    assert.match(before, /settings\.title/, 'case A renders the toggle row')
    slotIndex = 0
    findSwitch(seat.view(face)).props.onClick()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(directCalls, [{ ops: [{ op: 'set', path: ['allGoalsMode'], value: true }], expectedRevision: undefined }],
      'case A fallback retries once through remote.settings.mutate with no expectedRevision (user patch row path)')
    const after = render()
    assert.match(after, /settings\.saveFailedDetail:Config field "allGoalsMode" is not volatile/,
      'case A surfaces the exact host refusal message')
  }

  // Case B: fallback write SUCCEEDS ({ok:true}) — no failure line renders.
  {
    slotsMem.length = 0
    let state = { status: 'ready', value: { allGoalsMode: false }, writable: true, revision: 7 }
    const faceB = {
      form: { get state() { return state }, mutate: async () => false },
      directMutate: async () => ({ ok: true, value: { revision: 8 } }),
      view: 'page',
      t,
    }
    slotIndex = 0
    findSwitch(seat.view(faceB)).props.onClick()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    slotIndex = 0
    const face0 = faceB
    assert.doesNotMatch(flatten(seat.view(face0)).join('\n'), /settings\.saveFailed/, 'case B healed write renders no failure line')
  }

  // Case C: primary write succeeds — the fallback must never be invoked.
  {
    slotsMem.length = 0
    let directCalled = false
    let state = { status: 'ready', value: { allGoalsMode: false }, writable: true, revision: 7 }
    const faceC = {
      form: {
        get state() { return state },
        mutate: async (ops) => { state = { ...state, value: { ...state.value, allGoalsMode: ops[0].value } }; return true },
      },
      directMutate: async () => { directCalled = true; return { ok: true } },
      view: 'page',
      t,
    }
    slotIndex = 0
    findSwitch(seat.view(faceC)).props.onClick()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    assert.equal(directCalled, false, 'case C accepted primary write never touches the fallback')
    slotIndex = 0
    assert.doesNotMatch(flatten(seat.view(faceC)).join('\n'), /settings\.saveFailed/, 'case C renders no failure line')
  }

  // Case D: no directMutate prop (host without remote.settings) — degrades to
  // the v0.7.4 hint-only failure, no crash.
  {
    slotsMem.length = 0
    let state = { status: 'ready', value: { allGoalsMode: false }, writable: true, revision: 7 }
    const faceD = {
      form: { get state() { return state }, mutate: async () => false },
      view: 'page',
      t,
    }
    slotIndex = 0
    findSwitch(seat.view(faceD)).props.onClick()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    slotIndex = 0
    assert.match(flatten(seat.view(faceD)).join('\n'), /settings\.saveFailed(?!Detail)/, 'case D degrades to the hint-only failure state')
  }

  console.log('✓ 54 path-(b) settings write: unconditional user-patch-row fallback retry + host refusal message surfaced')
}

// 55. v0.7.7 acceptance: flat agent-model fields on the settings schema —
//     task/verify agent model overrides ("provider/model" or bare model),
//     empty = inherit the session agent; wired into roles.default/.verify.
//     v0.7.7: BOTH fields are volatile — the host settings form
//     (@deepseek-ai/dsh-settings volatileForm, lib/index.js:122-131) serves
//     only `.volatile()` fields and its write() refuses any non-volatile
//     path ("Config field ... is not volatile"), so a plain field is both
//     invisible and unwritable on the plugins page. Volatile commit is live:
//     the value is read per round start through readConfigField unwrap.
{
  assert.ok(Config.dict.taskAgentModel, 'Config schema exposes the flat taskAgentModel field')
  assert.ok(Config.dict.verifyAgentModel, 'Config schema exposes the flat verifyAgentModel field')
  assert.equal(Config.dict.taskAgentModel.meta?.volatile, true, 'taskAgentModel is volatile (host form serves + accepts volatile paths only)')
  assert.equal(Config.dict.verifyAgentModel.meta?.volatile, true, 'verifyAgentModel is volatile (host form serves + accepts volatile paths only)')
  // Parser: "provider/model" splits, a bare name is a model-only override,
  // anything empty (unset field) inherits the session agent (no override).
  assert.deepEqual(parseAgentModelSpec('glm-5.3/glm-5.3-flash'), { provider: 'glm-5.3', model: 'glm-5.3-flash' })
  assert.deepEqual(parseAgentModelSpec(' bare-model '), { model: 'bare-model' })
  assert.equal(parseAgentModelSpec(undefined), undefined, 'unset = inherit session agent')
  assert.equal(parseAgentModelSpec('   '), undefined, 'blank = inherit session agent')
  assert.equal(parseAgentModelSpec(''), undefined, 'empty string (volatile default) = inherit session agent')
  assert.deepEqual(parseAgentModelSpec('a/'), { model: 'a/' }, 'trailing slash is not a provider split')
  assert.deepEqual(parseAgentModelSpec('/m'), { model: '/m' }, 'leading slash is not a provider split')
  // Loader-path validation: flat string fields survive schemastery resolution
  // alongside the roles dict they merge into; volatile fields resolve to live
  // references, exactly like allGoalsMode.
  const v = Config['~standard'].validate({ taskAgentModel: 'p/m', verifyAgentModel: 'v-model' }).value
  assert.equal(v.issues, undefined)
  assert.equal(v.taskAgentModel.get?.(), 'p/m', 'volatile taskAgentModel resolves to a live reference')
  assert.equal(v.verifyAgentModel.get?.(), 'v-model', 'volatile verifyAgentModel resolves to a live reference')
  // Wiring: the flat fields are read per round start through readConfigField
  // (live-ref unwrap, '' = inherit) and merge over roles.default / roles.verify.
  const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(index, /parseAgentModelSpec\(readConfigField\(config\.taskAgentModel, ''\)\)/, 'taskAgentModel read unwraps the volatile live reference')
  assert.match(index, /parseAgentModelSpec\(readConfigField\(config\.verifyAgentModel, ''\)\)/, 'verifyAgentModel read unwraps the volatile live reference')
  assert.match(index, /roleOverrides\.default = \{ \.\.\.roleOverrides\.default, \.\.\.taskSpec \}/)
  assert.match(index, /roleOverrides\.verify = \{ \.\.\.roleOverrides\.verify, \.\.\.verifySpec \}/)
  console.log('✓ 55 flat agent-model fields: volatile (host-form writable), live-ref unwrap, provider/model parser + roles merge wiring (empty = session-agent inheritance)')
}

// 56. path-(b) write LANDING: the card's toggle write must survive every host
//     pre-write gate of @deepseek-ai/dsh-settings SettingsForms.write
//     (lib/index.js:504-534) and produce the exact USER patch row shape that
//     @deepseek-ai/dsh-config-editor ConfigEditor.edit (lib/index.js:150-155)
//     appends to the profile cordis.patch.yml: `{id, name, config}` with NO
//     `insert` key — the only landing reconcileProfilePatches accepts. This
//     test replays the host gates verbatim against the REAL Config schema:
//     volatileForm (lib/index.js:122-131), isVolatilePath
//     (lib/index.js:173-179), projectForm (lib/index.js:160-165), the mutate
//     op reduce (lib/index.js:488-497), validatePaths + strip + mergeLayers
//     (lib/index.js:517-533), and schemastery validation (cordis
//     resolveConfig, lib/index.js:956-962). A non-volatile path is the
//     negative control: the same gates must refuse it pre-write, untouched
//     file — the observed v0.7.4/v0.7.5 refusal signature.
{
  // --- faithful replicas of the dsh-settings helpers (lib/index.js) ---
  const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  const volatileForm = (schema) => {
    if (schema.meta?.volatile) {
      const plain = new z(schema.toJSON())
      const stripMeta = (node) => {
        delete node.meta.volatile
        for (const child of Object.values(node.dict ?? {})) stripMeta(child)
        if (node.inner) stripMeta(node.inner)
        for (const child of node.list ?? []) stripMeta(child)
      }
      stripMeta(plain)
      return plain
    }
    if (schema.type === 'object') {
      const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([k, child]) => {
        const field = volatileForm(child)
        return field === undefined ? [] : [[k, field]]
      }))
      return Object.keys(dict).length === 0 ? undefined : z.object(dict)
    }
    return undefined
  }
  const isVolatilePath = (schema, path) => {
    if (schema.meta?.volatile) return true
    const [key, ...rest] = path
    const child = key === undefined ? undefined : schema.dict?.[key]
    return child !== undefined && isVolatilePath(child, rest)
  }
  const projectForm = (schema, value) => {
    if (schema.type === 'object' && value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([k, child]) => {
        const field = Reflect.get(value, k)
        return field === undefined ? [] : [[k, projectForm(child, field)]]
      }))
    }
    return value
  }
  const mergeLayers = (under, over) => {
    if (!isPlainObject(under) || !isPlainObject(over)) return over
    const merged = { ...under }
    for (const [k, v] of Object.entries(over)) merged[k] = Object.hasOwn(merged, k) ? mergeLayers(merged[k], v) : v
    return merged
  }
  const validatePaths = (schema, value, node, path = []) => {
    for (const [key, child] of Object.entries(value)) {
      const target = [...path, key]
      if (isVolatilePath(schema, target)) continue
      const field = Object.hasOwn(node.dict, key) ? node.dict[key] : undefined
      if (isPlainObject(child) && field !== undefined) validatePaths(schema, child, field, target)
      else throw new Error(`Config field "${target.join('.')}" is not volatile`)
    }
  }
  const strip = (schema, value, node, path = []) => {
    if (isVolatilePath(schema, path)) return {}
    const result = { ...value }
    for (const [key, field] of Object.entries(node.dict)) {
      const target = [...path, key]
      if (isVolatilePath(schema, target)) Reflect.deleteProperty(result, key)
      else if (isPlainObject(result[key])) result[key] = strip(schema, result[key], field, target)
    }
    return result
  }
  // --- the gates, against the REAL shipped Config schema ---
  const form = volatileForm(Config)
  assert.ok(form, 'the Config schema yields a volatile form (host serves the plugins-page card at all)')
  const served = Object.keys(form.dict ?? {}).sort()
  assert.ok(served.includes('allGoalsMode'), 'volatile form serves allGoalsMode')
  assert.ok(served.includes('taskAgentModel') && served.includes('verifyAgentModel'),
    'volatile form serves the flat agent-model fields')
  assert.equal(isVolatilePath(Config, ['allGoalsMode']), true, 'the toggle op path passes the write() volatile gate')
  assert.equal(isVolatilePath(Config, ['taskAgentModel']), true, 'taskAgentModel op path passes the write() volatile gate')
  assert.equal(isVolatilePath(Config, ['hardGate']), true, 'hardGate passes the write() volatile gate (v0.8.10: settings-card toggle)')
  assert.equal(isVolatilePath(Config, ['gateMode']), false, 'gateMode stays non-volatile (refused by the write gate, negative control)')
  assert.equal(isVolatilePath(Config, ['gateApprovalRelay']), false, 'gateApprovalRelay stays non-volatile (config-document field)')
  // The bundle insert row's raw config (cordis.patch.yml) as the loader holds it.
  const rawEntryConfig = {
    hardGate: true, gateMode: 'allowlist', gateAllowlistExtra: ['spawn_teammate', 'send_message', 'interrupt_agent'],
    allGoalsMode: false,
  }
  // Host write(): change = mutate ops over projectForm(raw) — the card's exact op.
  const current = projectForm(form, rawEntryConfig)
  const op = { op: 'set', path: ['allGoalsMode'], value: true }
  const next = [op].reduce((value, o) => (o.op === 'set' ? { ...value, [o.path[0]]: o.value } : value), current)
  assert.doesNotThrow(() => validatePaths(Config, next, form), 'validatePaths accepts the volatile-only next section')
  // strip(raw) + mergeLayers(next): the persisted user patch row config.
  const persisted = mergeLayers(strip(Config, rawEntryConfig, form), next)
  assert.equal(persisted.allGoalsMode, true, 'volatile value lands in the persisted config')
  assert.equal(persisted.hardGate, true, 'non-volatile bundle config is preserved in the persisted config')
  assert.deepEqual(persisted.gateAllowlistExtra, rawEntryConfig.gateAllowlistExtra, 'non-volatile arrays preserved')
  // schemastery validation = cordis resolveConfig's exact check in edit().
  const validated = Config['~standard'].validate(persisted)
  assert.equal(validated.issues, undefined, 'resolveConfig accepts the persisted config (no pre-write ValidationError)')
  // The row ConfigEditor.edit appends: {id, name, config}, NO insert key —
  // the user patch row reconcileProfilePatches accepts (dsh-config-editor
  // lib/index.js findLastIndex guard: `!item.has("insert")`).
  const patchRow = { id: 'dsh-cybernetics', name: '@mars.liu/dsh-cybernetics', config: persisted }
  assert.equal(Object.hasOwn(patchRow, 'insert'), false, 'the landed row carries NO insert key (user patch row, not a bundle insert row)')
  assert.equal(patchRow.id, 'dsh-cybernetics', 'row id matches the loader entry id')
  assert.equal(patchRow.name, '@mars.liu/dsh-cybernetics', 'row name matches the loader entry name')
  // Negative control end-to-end: a non-volatile gate-field op must die at the
  // write() gate before any document mutation (the v0.7.4/0.7.5 refusal
  // signature). v0.8.10: hardGate itself is volatile (writable from the card);
  // gateMode remains the refused path.
  assert.throws(() => { if (!isVolatilePath(Config, ['gateMode'])) throw new Error('Config field "gateMode" is not volatile') },
    /not volatile/, 'a non-volatile op is refused pre-write, file untouched')
  console.log('✓ 56 write landing: toggle write survives every host pre-write gate and lands as the user patch row {id, name, config} (no insert)')
}

// 57. v0.7.9 panel-fidelity: replicate the REAL host serving path end-to-end.
//     (a) dsh-app-boot validateVolatilePlacement (lib/index.js:2606-2621) — the
//     native containment check every plugin Config passes when its settings
//     schema is projected: a volatile field must sit on a fixed object path
//     with no enclosing volatile field. The current schema (SIX volatile
//     fields since v0.8.4 — roles became non-volatile) must pass.
//     (b) dsh-settings volatileForm over the REAL shipped schema must serve
//     exactly the SIX fields — taskAgentModel / verifyAgentModel /
//     triageAgentModel / roundsPerSubgoal / maxConcurrentRounds /
//     allGoalsMode — and roles must NO LONGER be served (nor writable):
//     the GUI no longer exposes the roles JSON textarea, the advanced
//     configuration path is the profile yaml (agent-guided, README).
//     (c) STALE-RUNTIME CONTROL: the running host imports the plugin's
//     link: source ONCE at boot (loader module cache; no source watcher), so
//     a host process booted before the v0.7.7 commit serves the pre-0.7.7
//     runtime where ONLY allGoalsMode is volatile. Reproducing that face
//     yields a form with exactly one field — which is precisely the user's
//     screenshot (面板只显示「全目标模式」). Root cause of "new fields not
//     rendered": stale runtime, fix = restart the host; NOT a schema defect.
{
  const validateVolatilePlacement = (node, path, blocked = false, seen = new Map()) => {
    const states = seen.get(node) ?? new Set()
    if (states.has(blocked)) return
    states.add(blocked)
    seen.set(node, states)
    if (node.meta?.volatile && blocked) throw new Error(`${path}: volatile fields require a fixed object path without an enclosing volatile field`)
    const nested = blocked || !!node.meta?.volatile
    for (const [key, child] of Object.entries(node.dict ?? {})) validateVolatilePlacement(child, `${path}/${key}`, nested, seen)
    if (node.sKey) validateVolatilePlacement(node.sKey, `${path}/keys`, true, seen)
    if (node.inner) validateVolatilePlacement(node.inner, `${path}/inner`, true, seen)
    for (const [index, child] of (node.list ?? []).entries()) validateVolatilePlacement(child, `${path}/${index}`, true, seen)
  }
  assert.doesNotThrow(() => validateVolatilePlacement(Config, 'config'),
    'the Config passes the host native volatile-containment check (all volatile fields on fixed object paths)')
  // Negative control: a volatile field INSIDE a volatile dict would be refused.
  const nestedVolatile = z.dict(z.object({ provider: z.string().volatile() })).volatile()
  assert.throws(() => validateVolatilePlacement(z.object({ roles: nestedVolatile }), 'config'),
    /fixed object path/, 'volatile under an enclosing volatile node is refused by the same check')
  // volatileForm over the REAL schema serves exactly the six volatile fields.
  const isPlainObject57 = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  const volatileForm57 = (schema) => {
    if (schema.meta?.volatile) return new z(schema.toJSON())
    if (schema.type === 'object') {
      const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([k, child]) => {
        const field = volatileForm57(child)
        return field === undefined ? [] : [[k, field]]
      }))
      return Object.keys(dict).length === 0 ? undefined : z.object(dict)
    }
    return undefined
  }
  const isVolatilePath57 = (schema, path) => {
    if (schema.meta?.volatile) return true
    const [key, ...rest] = path
    const child = key === undefined ? undefined : schema.dict?.[key]
    return child !== undefined && isVolatilePath57(child, rest)
  }
  const form57 = volatileForm57(Config)
  assert.deepEqual(Object.keys(form57.dict ?? {}).sort(),
    ['allGoalsMode', 'hardGate', 'inputPolicy', 'maxConcurrentRounds', 'noticePolicy', 'roundsPerSubgoal', 'taskAgentModel', 'triageAgentModel', 'verifyAgentModel'],
    'the served settings form exposes exactly the nine volatile fields (v0.13.0 adds noticePolicy on top of v0.9.0 inputPolicy; roles still not served since v0.8.4)')
  assert.equal(isVolatilePath57(Config, ['roles']), false,
    'a roles write path is NOT volatile (v0.8.4): the panel neither serves nor writes it')
  // STALE-RUNTIME CONTROL: the pre-0.7.7 runtime face (only allGoalsMode
  // volatile, the other five plain) reproduces the user's exact screenshot:
  // the plugins page shows 全目标模式 alone.
  const staleFace = z.object({
    toolName: z.string().default('cybernetics'),
    implicitTrigger: z.boolean().default(true),
    roles: z.dict(z.object({ provider: z.string(), model: z.string() })),
    taskAgentModel: z.string().default(''),
    verifyAgentModel: z.string().default(''),
    roundsPerSubgoal: z.number().default(3),
    maxConcurrentRounds: z.number().default(0),
    hardGate: z.boolean().default(false),
    gateMode: z.union(['denylist', 'allowlist']).default('denylist'),
    gatedTools: z.array(z.string()),
    gateAllowlist: z.array(z.string()),
    gateAllowlistExtra: z.array(z.string()),
    allGoalsMode: z.boolean().default(false).volatile(),
  })
  const staleForm = volatileForm57(staleFace)
  assert.deepEqual(Object.keys(staleForm.dict ?? {}), ['allGoalsMode'],
    'a host serving the pre-0.7.7 runtime shows exactly one field (全目标模式) — the observed panel')
  // REAL-MODULE cross-check (conditional, same portability pattern as test
  // 58's inode probe): when the host profile is present, drive the host's OWN
  // volatileForm/isVolatilePath (dsh-settings/lib/types/schema.js — the exact
  // functions describe()/write() call) against the live Config schema instead
  // of the replicas above. This pins the simulation to the shipped host code:
  // any future host change to the serving/write gates fails here first.
  const hostSchemaJs = '/Users/mars/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-settings/lib/types/schema.js'
  if (existsSync(hostSchemaJs)) {
    const hostSchema = await import(pathToFileURL(hostSchemaJs).href)
    const hostForm = hostSchema.volatileForm(Config)
    assert.notEqual(hostForm, undefined, 'host volatileForm serves a form for the current schema')
    assert.deepEqual(Object.keys(hostForm.dict ?? {}).sort(),
      ['allGoalsMode', 'hardGate', 'inputPolicy', 'maxConcurrentRounds', 'noticePolicy', 'roundsPerSubgoal', 'taskAgentModel', 'triageAgentModel', 'verifyAgentModel'],
      'the REAL host volatileForm serves exactly the nine volatile fields (v0.13.0 adds noticePolicy; roles is off the panel since v0.8.4)')
    assert.equal(Object.hasOwn(hostForm.dict ?? {}, 'roles'), false, 'the host form does not serve roles any more')
    for (const path of [['roundsPerSubgoal'], ['maxConcurrentRounds'], ['taskAgentModel'], ['verifyAgentModel'], ['triageAgentModel'], ['allGoalsMode'], ['hardGate'], ['inputPolicy'], ['noticePolicy']]) {
      assert.equal(hostSchema.isVolatilePath(Config, path), true, `host write gate accepts ${path.join('.')}`)
    }
    for (const path of [['roles', 'default', 'model'], ['gateMode'], ['gateApprovalRelay'], ['toolName'], ['implicitTrigger']]) {
      assert.equal(hostSchema.isVolatilePath(Config, path), false, `host write gate keeps non-volatile ${path.join('.')} unwritable`)
      if (path.length === 1) assert.equal(Object.hasOwn(hostForm.dict ?? {}, path[0]), false, `host form does not serve non-volatile ${path[0]}`)
    }
    // The stale-runtime face through the REAL host function reproduces the
    // one-field panel identically.
    assert.deepEqual(Object.keys(hostSchema.volatileForm(staleFace)?.dict ?? {}), ['allGoalsMode'],
      'real host volatileForm over the pre-0.7.7 face serves exactly 全目标模式 — the observed panel')
  } else {
    console.log('  (skipping the real-host volatileForm cross-check: host profile absent)')
  }
  console.log('✓ 57 panel fidelity: volatile placement legal, volatileForm serves exactly the six volatile fields (roles off the panel since v0.8.4); stale-runtime control reproduces the one-field (全目标模式) panel — render root cause is the boot-time module cache (restart required), not the schema')
}

// 58. ROOT-INCLUDE ENTRY refusal: the exact user-observed save rejection
//     ("dsh: profile reload requires the root Include entry") is thrown by
//     dsh-app-boot recompose (lib/index.js:3803) when `bootstrapIncludes.get`
//     (a module-GLOBAL WeakMap) misses the root context. bootstrapIncludes is
//     keyed by MODULE INSTANCE: the booted CLI registers the root Include in
//     ITS copy of dsh-app-boot, while the profile's dsh-config-editor calls
//     reconcileProfilePatches through ITS OWN copy — two physical module
//     instances (npm-global CLI tree vs pnpm profile tree, different inodes)
//     means the lookup can NEVER hit, and EVERY plugin settings write dies.
//     This test proves the mechanism and the preflight ordering that matches
//     the observed "file untouched, fast rejection" signature.
{
  const ROOT = { ctx: 'root-context' }
  const ENTRY = { id: 'include' }
  // Two distinct instances of the dsh-app-boot module = two WeakMaps.
  const bootCopyIncludes = new WeakMap() // the CLI's copy — boot() registers here
  const editorCopyIncludes = new WeakMap() // the profile's copy — configEditor reads here
  bootCopyIncludes.set(ROOT, ENTRY) // mountRootInclude: bootstrapIncludes.set(ctx, entry)
  const editorCopyLookup = () => editorCopyIncludes.get(ROOT)
  // configEditor.edit (dsh-config-editor lib/index.js:69-131) runs its
  // preflight reconcileProfilePatches BEFORE reading/writing the patch file —
  // so the miss aborts the write pre-落盘, leaving the file untouched (the
  // observed signature: profile cordis.patch.yml mtime unchanged, fast reject).
  const preflightReconcile = (includes) => {
    if (includes.get(ROOT) === undefined) throw new Error('dsh: profile reload requires the root Include entry')
    return 'reconciled'
  }
  const documentWritten = []
  const editLikeConfigEditor = (includes) => {
    preflightReconcile(includes) // line 74-75: BEFORE any document access
    documentWritten.push('patch-row') // line 123: writeFileAtomic — never reached on miss
  }
  assert.throws(() => editLikeConfigEditor(editorCopyIncludes),
    /profile reload requires the root Include entry/,
    'dual dsh-app-boot instances: the editor copy misses the boot-registered root Include — the exact user-observed refusal')
  assert.deepEqual(documentWritten, [],
    'the refusal fires BEFORE the patch document write — profile file untouched, matching the observed fast-reject signature')
  // DEDUPE CONTROL: when both sides share ONE module instance (single copy),
  // the same write path succeeds.
  const dedupedIncludes = bootCopyIncludes // one physical module
  assert.doesNotThrow(() => editLikeConfigEditor(dedupedIncludes), 'a deduped dsh-app-boot copy lets the same write path proceed')
  assert.deepEqual(documentWritten, ['patch-row'], 'the deduped write lands the patch row')
  // REAL-ENVIRONMENT probe (conditional so the suite stays portable): the
  // npm-global CLI tree and the pnpm profile tree hold physically distinct
  // dsh-app-boot copies — the deployed condition this test models.
  const cliCopy = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'
  const profileCopy = '/Users/mars/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'
  if (existsSync(cliCopy) && existsSync(profileCopy)) {
    const a = realpathSync(cliCopy); const b = realpathSync(profileCopy)
    if (a === b) {
      // The v0.7.10 remedy APPLIED (user, 2026-11-04): both sides resolve one
      // module instance, the bootstrapIncludes WeakMap lookup hits and panel
      // saves proceed. The dual-instance mechanism above stays proven by the
      // two-WeakMap replica; the probe now certifies the healed deployment.
      console.log('  (deployed environment healed: CLI and profile resolve the SAME dsh-app-boot copy — the v0.7.10 symlink remedy is in effect)')
    } else {
      assert.notEqual(a, b, 'deployed environment: CLI-boot copy and profile-editor copy of dsh-app-boot are distinct module instances')
    }
  } else {
    console.log('  (skipping the real-environment inode probe: host paths absent)')
  }
  console.log('✓ 58 root-include refusal: module-global bootstrapIncludes WeakMap is keyed per module copy — CLI boot copy vs profile editor copy can never meet, every settings write dies pre-write; save root cause is host module duplication (dedupe/restart assembly), not the plugin schema')
}

// --- v0.8: 调用级模型回退（call-level model fallback） -------------------------
// Shared round.js driver: load the script once per scenario, run it with mock
// agent/phase/log hooks exactly like tests 14/15/32.
const roundCode = await readFile(new URL('../workflows/round.js', import.meta.url), 'utf8')
const driveRound = (agent, roundArgs, logs = []) =>
  new (async function () {}.constructor)('agent', 'phase', 'args', 'log', roundCode)(
    agent, async () => {}, roundArgs, (m) => logs.push(m),
  )
const okReport = { summary: 's', done: true, artifacts: [], evidence: 'e', nextStepThoughts: [] }
const okVerdict = { met: true, criteria: [], gaps: [], goalItselfQuestionable: false }
const okTriage = { auto: [], defer: [], reject: [], human: [] }
const baseArgs = (extra = {}) => ({
  goal: { objective: 'O' }, state: { round: 1, doneSummary: '' },
  subgoal: 'S', brief: 'B', ...extra,
})

// 59. fallback 触发（AGENT_START）：task 角色的覆盖 provider 未注册 → agent()
//     抛出 WorkflowError(AGENT_START) → 撤销覆盖（不传 provider/model = 继承
//     session agent）重试一次；回退记录进轮结果并经 log() 可见
{
  const calls = []
  const logs = []
  const agent = async (_prompt, opts) => {
    calls.push(opts)
    if (calls.length === 1) {
      const err = new Error('agent() could not start a child: no subagent provider registered for "glm-5.3"')
      err.code = 'AGENT_START' // workflow runtime 的错误类型（dsh-workflow WorkflowError.code）
      throw err
    }
    if (calls.length === 2) return okReport
    if (calls.length === 3) return okVerdict
    return okTriage
  }
  const out = await driveRound(agent, baseArgs({
    roles: { default: { provider: 'glm-5.3', model: 'glm-5.3-flash' } },
  }), logs)
  assert.equal(calls.length, 4, 'task retry + verify + triage')
  assert.equal(calls[0].provider, 'glm-5.3', 'first attempt uses the configured override')
  assert.equal(calls[0].model, 'glm-5.3-flash')
  assert.equal(calls[1].provider, undefined, 'fallback target: NO provider opt = inherit session agent')
  assert.equal(calls[1].model, undefined, 'fallback target: NO model opt = inherit session agent')
  assert.equal(calls[2].provider, undefined, 'verify has no override → single direct call')
  assert.equal(out.fallbacks.length, 1, 'one fallback recorded on the round result')
  assert.equal(out.fallbacks[0].role, 'default')
  assert.equal(out.fallbacks[0].trigger, 'availability-error')
  assert.deepEqual(out.fallbacks[0].from, { provider: 'glm-5.3', model: 'glm-5.3-flash' })
  assert.match(out.fallbacks[0].reason, /no subagent provider registered/)
  assert.ok(logs.some((m) => /fallback/.test(m) && /session agent/.test(m)), 'fallback narrated into workflow/log')
  assert.equal(out.verdict.met, true, 'the round completes normally after the fallback')
  console.log('✓ 59 fallback on AGENT_START: override bypassed, session-model retry succeeds, event recorded + logged')
}

// 60. fallback 触发（verify 角色，AGENT_RESULT + quota 消息）：verify 的覆盖
//     模型限额耗尽 → child agent run failed: 429/quota → 仅 verify 回退，task
//     无覆盖不重试
{
  const calls = []
  const agent = async (_prompt, opts) => {
    calls.push(opts)
    if (opts.label === 'verify' && calls.filter((c) => c.label === 'verify').length === 1) {
      const err = new Error('child agent run failed: Error: HTTP 429 too many requests: quota exhausted')
      err.code = 'AGENT_RESULT'
      throw err
    }
    if (opts.label?.startsWith('task:')) return okReport
    if (opts.label === 'verify') return okVerdict
    return okTriage
  }
  const out = await driveRound(agent, baseArgs({
    roles: { verify: { provider: 'v-prov', model: 'v-model' } },
  }))
  const taskCalls = calls.filter((c) => c.label?.startsWith('task:'))
  const verifyCalls = calls.filter((c) => c.label === 'verify')
  assert.equal(taskCalls.length, 1, 'task agent has no override → no retry')
  assert.equal(taskCalls[0].provider, undefined, 'task agent ran on the inherited session model')
  assert.equal(verifyCalls.length, 2, 'verify retried once')
  assert.equal(verifyCalls[0].provider, 'v-prov', 'first verify attempt uses the override')
  assert.equal(verifyCalls[1].provider, undefined, 'verify retry inherits the session agent')
  assert.equal(out.fallbacks.length, 1)
  assert.equal(out.fallbacks[0].role, 'verify')
  assert.equal(out.fallbacks[0].trigger, 'availability-error')
  assert.match(out.fallbacks[0].reason, /429|quota/)
  assert.equal(out.verdict.met, true)
  console.log('✓ 60 fallback on verify quota (AGENT_RESULT + 429/quota): only the failing role falls back')
}

// 61. 不触发场景（逻辑失败）：(a) task agent 正常交付 done=false 报告——逻辑
//     失败是返回值层面的判定，哪怕配置了覆盖也绝不重试换模型；(b) 非可用性抛错
//     （UNSUPPORTED_SCHEMA 等脚本/守卫错误）原样上抛；(c) 无覆盖时 agent()
//     返回 null 维持原失败语义（无处可退，不重试）
{
  // (a) done=false report with an override configured: exactly one task call
  const callsA = []
  const outA = await driveRound(async (_p, opts) => {
    callsA.push(opts)
    if (opts.label?.startsWith('task:')) return { ...okReport, done: false, summary: '做了一半' }
    if (opts.label === 'verify') return { met: false, criteria: [], gaps: ['另一半没做'], goalItselfQuestionable: false }
    return okTriage
  }, baseArgs({ roles: { default: { provider: 'p', model: 'm' } } }))
  assert.equal(callsA.filter((c) => c.label?.startsWith('task:')).length, 1, 'logic failure: no model swap retry')
  assert.deepEqual(outA.fallbacks, [], 'logic failure records no fallback')
  assert.equal(outA.verdict.met, false, 'the unmet verdict flows through normally')

  // (b) non-availability thrown error propagates (no retry, round errors)
  let threw61 = false
  const callsB = []
  try {
    await driveRound(async (_p, opts) => {
      callsB.push(opts)
      const err = new Error('agent() schema is outside the supported subset — schema.type must be "object"')
      err.code = 'UNSUPPORTED_SCHEMA'
      throw err
    }, baseArgs({ roles: { default: { provider: 'p', model: 'm' } } }))
  } catch { threw61 = true }
  assert.equal(threw61, true, 'script/guard errors propagate unchanged')
  assert.equal(callsB.length, 1, 'no retry on non-availability errors')

  // (c) null WITHOUT an override: no retry (already on the session model)
  const callsC = []
  const outC = await driveRound(async (_p, opts) => { callsC.push(opts); return null }, baseArgs())
  assert.equal(callsC.length, 1, 'null without an override does not retry')
  assert.match(outC.failed, /task agent 失败/, 'the original failure semantics are preserved')
  assert.deepEqual(outC.fallbacks, [])
  console.log('✓ 61 no-fallback: done=false 逻辑失败 / 非可用性抛错 / 无覆盖 null 均不换模型')
}

// 62. null-result 回退：覆盖模型执行后 agent() 返回 null（runtime 把子 run
//     stopReason ≠ completed 压成 null，不透传原因——限额/网络/provider 报错
//     的常见形态）→ 撤销覆盖以 session 模型重试一次；重试再败降级为原失败路径
//     且回退记录仍可见
{
  const calls = []
  const out = await driveRound(async (_p, opts) => {
    calls.push(opts)
    if (opts.label?.startsWith('task:') && opts.model === 'weak-model') return null // 覆盖模型无产出
    if (opts.label?.startsWith('task:')) return okReport
    if (opts.label === 'verify') return okVerdict
    return okTriage
  }, baseArgs({ roles: { default: { model: 'weak-model' } } }))
  const taskCalls = calls.filter((c) => c.label?.startsWith('task:'))
  assert.equal(taskCalls.length, 2, 'null with an override retries once')
  assert.equal(taskCalls[0].model, 'weak-model')
  assert.equal(taskCalls[1].model, undefined, 'retry inherits the session agent model')
  assert.equal(out.fallbacks.length, 1)
  assert.equal(out.fallbacks[0].trigger, 'null-result')
  assert.equal(out.fallbacks[0].role, 'default')
  assert.equal(out.verdict.met, true, 'the retry rescues the round')

  // Retry also yields null → original failure path, fallback record survives
  const outFail = await driveRound(async () => null, baseArgs({ roles: { default: { model: 'weak-model' } } }))
  assert.match(outFail.failed, /task agent 失败/, 'a failed retry degrades to the original failure')
  assert.equal(outFail.fallbacks.length, 1, 'the fallback stays visible even when the retry fails')
  assert.equal(outFail.fallbacks[0].trigger, 'null-result')
  console.log('✓ 62 null-result fallback: override bypassed on null, retry rescues / degrades with the record intact')
}

// 63. 可用性判定矩阵：quota（中英文）/ 网络不可达 / 5xx / AGENT_RESULT 配额 →
//     回退；非匹配消息（含 AGENT_RESULT 包裹的逻辑错误）与 INVALID_ARGUMENT →
//     原样上抛。判定信号 = workflow runtime agent() hook 的错误类型/消息
{
  const triggers = [
    Object.assign(new Error('agent() could not start a child: spawn EACCES'), { code: 'AGENT_START' }),
    Object.assign(new Error('child agent run failed: 429 rate limit'), { code: 'AGENT_RESULT' }),
    Object.assign(new Error('child agent run failed: quota exceeded，账户余额不足'), { code: 'AGENT_RESULT' }),
    new Error('fetch failed: connect ECONNREFUSED 10.0.0.1:443'), // 无 code：按消息模式判定
    new Error('503 Service Unavailable: model overloaded'),
    new Error('ETIMEDOUT network unreachable'),
    // v0.8.3: deleted-subscription shapes — provider removed (AGENT_START, the
    // runtime's NO_PROVIDER wrap) and model removed while the provider stays
    // (model-level error surfaces as AGENT_RESULT or a bare throw).
    new Error('no subagent provider registered for "p"'),
    Object.assign(new Error('child agent run failed: 400 model not found: m'), { code: 'AGENT_RESULT' }),
    new Error('unknown model: m (subscription was removed)'),
  ]
  for (const trigger of triggers) {
    const calls = []
    const out = await driveRound(async (_p, opts) => {
      calls.push(opts)
      if (calls.length === 1) throw trigger
      return okReport
    }, baseArgs({ depth: 'quick', roles: { default: { provider: 'p', model: 'm' } } }))
    assert.equal(calls.length, 2, `${trigger.message.slice(0, 40)}: availability failure retried`)
    assert.equal(calls[1].provider, undefined)
    assert.equal(out.fallbacks.length, 1)
    assert.equal(out.fallbacks[0].trigger, 'availability-error')
    assert.equal(out.report.summary, 's', 'quick round completes on the session model')
  }
  const nonTriggers = [
    Object.assign(new Error('child agent run failed: some internal logic boom'), { code: 'AGENT_RESULT' }),
    Object.assign(new Error('agent() option "effort" is deferred and not supported by this engine'), { code: 'UNSUPPORTED_OPTION' }),
    Object.assign(new Error('this run reached its total agent cap (1000)'), { code: 'AGENT_CAP' }),
  ]
  for (const trigger of nonTriggers) {
    let threw = false
    const calls = []
    try {
      await driveRound(async (_p, opts) => { calls.push(opts); throw trigger }, baseArgs({ depth: 'quick', roles: { default: { provider: 'p', model: 'm' } } }))
    } catch { threw = true }
    assert.equal(threw, true, `${trigger.message.slice(0, 40)}: non-availability error propagates`)
    assert.equal(calls.length, 1, 'no model swap on non-availability errors')
  }
  console.log('✓ 63 availability matrix: quota/network/5xx/AGENT_START → fallback; 逻辑错误/cap/option 错误 → 上抛不换模型')
}

// 64. 回退可见性（controller 层）：轮结果里的 fallbacks 追加进决策 note（工具
//     结果行可见）并随 round-<goal>-<n>.json 审计日志落盘
{
  const engine64 = fakeEngine()
  const host64 = fakeHost(engine64, { sessionId: 'sess-test-64' })
  host64.ctx.workingDirectory = { get: () => root }
  apply(host64.ctx, {})
  const tool64 = host64.tools[0]
  const exec64 = { agent: host64.parent, signal: undefined }

  const started = await tool64.execute({ action: 'start', title: '回退可见性', brief: 'b' }, exec64)
  engine64.runs[0].settle({
    stopReason: 'completed',
    value: {
      round: 1,
      report: okReport,
      verdict: okVerdict,
      triage: okTriage,
      fallbacks: [{
        role: 'default', from: { provider: 'glm-5.3', model: 'glm-5.3-flash' },
        trigger: 'availability-error', reason: 'agent() could not start a child: no subagent provider registered for "glm-5.3"',
      }],
    },
  })
  await new Promise((r) => setImmediate(r))
  const collected = await tool64.execute({ action: 'collect', goalId: started.goalId }, exec64)
  assert.equal(collected.decision.reason, 'met')
  assert.match(collected.decision.note, /模型回退 1 次/, 'the decision note surfaces the fallback')
  assert.match(collected.decision.note, /default\(glm-5.3\/glm-5.3-flash→session 模型/, 'the note names role + failed override + fallback target')
  const log64 = JSON.parse(await readFile(join(root, '.cybernetics', `round-${started.goalId}-1.json`), 'utf8'))
  assert.equal(log64.fallbacks.length, 1, 'the audit log carries the fallback record')
  assert.equal(log64.fallbacks[0].role, 'default')
  assert.equal(log64.fallbacks[0].trigger, 'availability-error')

  // No fallback → the note stays clean (no suffix regression).
  const plain = await tool64.execute({ action: 'start', title: '无回退任务', brief: 'b' }, exec64)
  engine64.runs.at(-1).settle({
    stopReason: 'completed',
    value: { round: 1, report: okReport, verdict: okVerdict, triage: okTriage, fallbacks: [] },
  })
  await new Promise((r) => setImmediate(r))
  const plainCollected = await tool64.execute({ action: 'collect', goalId: plain.goalId }, exec64)
  assert.doesNotMatch(plainCollected.decision.note, /模型回退/, 'no fallback → no note suffix')
  console.log('✓ 64 fallback visibility: decision note suffix + round-*.json audit record; clean rounds unaffected')
}

// --- v0.8.1: 设置卡片全字段覆盖（all six volatile fields editable） ------------
// Shared loader for the settings-card checks: identical ModuleLoader replay as
// tests 52–54, with the STATEFUL useState stub (drafts persist across renders
// exactly like React) and a node walker for finding controls by aria-label.
async function loadSettingsCard(formForApply) {
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded
  globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m } } }
  new Function('window', client)(globalThis.window)
  const jsx = {
    jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
    jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
  }
  const slotsMem = []
  let slotIndex = 0
  const react = {
    useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(),
    useState: (initial) => {
      const i = slotIndex++
      if (slotsMem[i] === undefined) {
        slotsMem[i] = {
          value: initial,
          set: (nv) => { slotsMem[i].value = typeof nv === 'function' ? nv(slotsMem[i].value) : nv },
        }
      }
      return [slotsMem[i].value, slotsMem[i].set]
    },
  }
  const mod = loaded.factory((req) => (req === 'react' ? react : jsx))
  const registered = []
  const t = (key, params) => key + (params && params.message !== undefined ? ':' + params.message : '')
  mod.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => t },
    slots: { inject: (_n, cb) => cb(), register: (spec, view) => { registered.push({ spec, view }) } },
    sessions: {},
    configForms: {
      get: formForApply,
      whileServed: (_namespaces, register) => { register(new Set()); return () => {} },
    },
  })
  const seat = registered.find((e) => e.spec.name === 'plugins.item')
  assert.ok(seat, 'plugins.item seat registered')
  const flatten = (node, out = []) => {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
    if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
    if (typeof node.type === 'function') { flatten(node.type(node.props), out); return out }
    if (node.props && node.props.children !== undefined) flatten(node.props.children, out)
    return out
  }
  const walk = (node, fn) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const n of node) walk(n, fn); return }
    fn(node)
    if (node.props && node.props.children !== undefined) walk(node.props.children, fn)
  }
  // React semantics: after an onChange the component re-renders and the DOM
  // node carries FRESH handlers — always re-render + re-find before the next
  // interaction, never reuse a stale node's props.
  const render = (face) => { slotIndex = 0; return seat.view(face) }
  const findByLabel = (face, label) => {
    let hit
    walk(render(face), (n) => { if (n.props && n.props['aria-label'] === label) hit = n })
    return hit
  }
  const findApply = (face) => {
    let hit
    walk(render(face), (n) => { if (n.type === 'button' && n.props && n.props.children === 'settings.apply') hit = n })
    return hit
  }
  return { t, render, flatten, walk, findByLabel, findApply, resetState: () => { slotsMem.length = 0 } }
}

// 65. v0.8.1/v0.8.2 settings card full volatile coverage (live ConfigForm
//     shape): the page view renders editable controls for ALL volatile fields
//     (allGoalsMode toggle + task/verify/triage model text + rounds/cap
//     numbers), and every control writes through the SAME live ConfigForm
//     (set / unset / mutate sugar) — number parsing and range validation,
//     blank = unset (restore default), unchanged = no write. v0.8.4: the roles
//     JSON textarea + Apply button are GONE from the card (hand-editing JSON
//     in the GUI is unfriendly); the card's field list is back to six, and
//     roles is configured via the profile yaml instead (agent-guided). Root-cause backdrop (verified against the
//     running host 2026-11-04): the host Plugins page (ItemDetail in
//     dsh-client-ui-plugin-manager) renders a plugin's configuration ONLY
//     through its slot cards and draws no fields itself;
//     dsh-client-ui-settings ships the configForms SERVICE (transport +
//     volatileForm gates) with NO generic field renderer, and
//     dsh-client-ui-settings-plugins is a read-only inventory shell — so any
//     volatile field this card did not render was editable nowhere in the GUI
//     (the v0.7.9–v0.8.0 panel gap).
{
  const sets = []
  const unsets = []
  let snap = {
    status: 'ready',
    value: {
      allGoalsMode: false, taskAgentModel: '', verifyAgentModel: 'v-prov/v-model', triageAgentModel: 't-model',
      roundsPerSubgoal: 3, maxConcurrentRounds: 0, roles: {},
    },
    writable: true,
  }
  const form = {
    getSnapshot: () => snap,
    subscribe: () => () => {},
    set: async (field, value) => {
      sets.push({ field, value })
      snap = { ...snap, value: { ...snap.value, [field]: value } }
      return true
    },
    unset: async (field) => {
      unsets.push(field)
      const value = { ...snap.value }
      delete value[field]
      snap = { ...snap, value }
      return true
    },
    mutate: async () => true,
  }
  const h = await loadSettingsCard((id) => { assert.equal(id, 'dsh-cybernetics'); return form })
  const face = { form, view: 'page', t: h.t }

  // (a) Field清单：the SIX card fields render their labels (roles is NOT one
  // of them since v0.8.4), and the non-toggle fields render their controls
  // showing the snapshot values.
  const text = h.flatten(h.render(face)).join('\n')
  for (const key of ['settings.title', 'settings.taskAgentModel', 'settings.verifyAgentModel', 'settings.triageAgentModel',
    'settings.roundsPerSubgoal', 'settings.maxConcurrentRounds']) {
    assert.ok(text.includes(key), `page view renders the ${key} row`)
  }
  assert.equal(h.findByLabel(face, 'settings.roles'), undefined, 'no roles JSON textarea on the card since v0.8.4')
  assert.equal(h.findApply(face), undefined, 'no Apply button on the card since v0.8.4 (roles JSON editing removed)')
  assert.equal(h.findByLabel(face, 'settings.roundsPerSubgoal').props.value, '3', 'number input shows the snapshot value')
  assert.equal(h.findByLabel(face, 'settings.verifyAgentModel').props.value, 'v-prov/v-model', 'text input shows the snapshot value')
  assert.equal(h.findByLabel(face, 'settings.taskAgentModel').props.value, '', 'empty model field renders blank')
  assert.equal(h.findByLabel(face, 'settings.triageAgentModel').props.value, 't-model', 'triage model input shows the snapshot value')

  // (b) Number write: edit + Enter → ConfigForm.set with the parsed integer.
  h.findByLabel(face, 'settings.roundsPerSubgoal').props.onChange({ target: { value: '5' } })
  h.findByLabel(face, 'settings.roundsPerSubgoal').props.onKeyDown({ key: 'Enter' })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(sets, [{ field: 'roundsPerSubgoal', value: 5 }], 'Enter commits a parsed integer through ConfigForm.set')
  assert.equal(h.findByLabel(face, 'settings.roundsPerSubgoal').props.value, '5', 'accepted write clears the draft; control shows the new snapshot')

  // (c) Blank = restore default: an emptied number field writes an `unset` op.
  h.findByLabel(face, 'settings.roundsPerSubgoal').props.onChange({ target: { value: '' } })
  h.findByLabel(face, 'settings.roundsPerSubgoal').props.onBlur()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(unsets, ['roundsPerSubgoal'], 'blank input restores the default via ConfigForm.unset')
  assert.equal(h.findByLabel(face, 'settings.roundsPerSubgoal').props.value, '', 'unset field renders blank (schema default applies server-side)')

  // (d) Range validation: 0 is below roundsPerSubgoal's ≥1 floor — no write,
  // the invalid hint renders and the draft is kept for correction.
  h.findByLabel(face, 'settings.maxConcurrentRounds').props.onChange({ target: { value: '-2' } })
  h.findByLabel(face, 'settings.maxConcurrentRounds').props.onBlur()
  await new Promise((r) => setImmediate(r))
  assert.equal(sets.filter((s) => s.field === 'maxConcurrentRounds').length, 0, 'out-of-range number never reaches the write path')
  assert.match(h.flatten(h.render(face)).join('\n'), /settings\.invalidNumber/, 'the invalid hint renders under the field')
  assert.equal(h.findByLabel(face, 'settings.maxConcurrentRounds').props.value, '-2', 'the rejected draft is kept for correction')
  // Escape reverts the draft.
  h.findByLabel(face, 'settings.maxConcurrentRounds').props.onKeyDown({ key: 'Escape' })
  assert.equal(h.findByLabel(face, 'settings.maxConcurrentRounds').props.value, '0', 'Escape reverts to the snapshot value')

  // (e) Text write: blur commits a "provider/model" string verbatim.
  h.findByLabel(face, 'settings.taskAgentModel').props.onChange({ target: { value: 'glm-5.3/glm-5.3-flash' } })
  h.findByLabel(face, 'settings.taskAgentModel').props.onBlur()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(sets.at(-1), { field: 'taskAgentModel', value: 'glm-5.3/glm-5.3-flash' }, 'blur commits the text field through ConfigForm.set')

  // (e2) Triage text write: Enter commits the bare model name; a blank triage
  // field restores the schema default (inherit the session agent) via unset.
  h.findByLabel(face, 'settings.triageAgentModel').props.onChange({ target: { value: 't-prov/t-model-2' } })
  h.findByLabel(face, 'settings.triageAgentModel').props.onKeyDown({ key: 'Enter' })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(sets.at(-1), { field: 'triageAgentModel', value: 't-prov/t-model-2' }, 'Enter commits the triage field through ConfigForm.set')
  h.findByLabel(face, 'settings.triageAgentModel').props.onChange({ target: { value: '' } })
  h.findByLabel(face, 'settings.triageAgentModel').props.onBlur()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(unsets.at(-1), 'triageAgentModel', 'a blank triage field restores the default (inherit) via ConfigForm.unset')

  // (f) Unchanged edit = no write: draft equals the snapshot value.
  const setsBefore = sets.length
  h.findByLabel(face, 'settings.taskAgentModel').props.onChange({ target: { value: 'glm-5.3/glm-5.3-flash' } })
  h.findByLabel(face, 'settings.taskAgentModel').props.onBlur()
  await new Promise((r) => setImmediate(r))
  assert.equal(sets.length, setsBefore, 'an unchanged draft never writes')

  // (g) roles is NOT panel-editable since v0.8.4 — a card write to the roles
  // field is impossible by construction (no control exists); assert the
  // snapshot roles value never reaches any control.
  const setsBeforeBad = sets.length
  assert.equal(h.findByLabel(face, 'settings.roles'), undefined, 'roles edits cannot even be attempted on the card')
  assert.equal(sets.length, setsBeforeBad, 'no roles write path exists on the card')
  console.log('✓ 65 settings card full coverage (live ConfigForm): six volatile fields rendered (roles JSON textarea removed in v0.8.4); set/unset writes, number validation, blank=unset, unchanged=no-write')
}

// 66. v0.8.1 settings card field writes on the HOST ConfigPageForm shape
//     (plugins.item / plugins.row.config detail pages): every field write goes
//     through host.mutate carrying the snapshot revision; a refused field write
//     retries ONCE through directMutate with no expectedRevision and surfaces
//     the host message; an unserved namespace renders labels + the unavailable
//     line with NO controls (never a crash).
{
  const mutations = []
  let state = {
    status: 'ready',
    value: { allGoalsMode: false, taskAgentModel: '', roundsPerSubgoal: 3, maxConcurrentRounds: 0, roles: {} },
    writable: true,
    revision: 11,
  }
  const hostForm = {
    get state() { return state },
    mutate: async (ops, revision) => {
      mutations.push({ ops, revision })
      return true
    },
  }
  const h = await loadSettingsCard(() => { throw new Error('namespace not served in this harness') })
  const face = { form: hostForm, view: 'page', t: h.t }

  // (a) Number field write on the host shape: mutate([set], revision).
  h.findByLabel(face, 'settings.maxConcurrentRounds').props.onChange({ target: { value: '4' } })
  h.findByLabel(face, 'settings.maxConcurrentRounds').props.onKeyDown({ key: 'Enter' })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(mutations, [{ ops: [{ op: 'set', path: ['maxConcurrentRounds'], value: 4 }], revision: 11 }],
    'host-shape number write goes through ConfigPageForm.mutate carrying the snapshot revision')

  // (b) Blank on the host shape: the restore-default write is an `unset` op.
  h.findByLabel(face, 'settings.roundsPerSubgoal').props.onChange({ target: { value: ' ' } })
  h.findByLabel(face, 'settings.roundsPerSubgoal').props.onBlur()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(mutations.at(-1), { ops: [{ op: 'unset', path: ['roundsPerSubgoal'] }], revision: 11 },
    'host-shape blank write is an unset op carrying the revision')

  // (c) Refusal → one directMutate retry (no expectedRevision) → the host's
  // exact message renders in the failure line. Field writes share the
  // v0.7.6 path-(b) fallback with the toggle.
  h.resetState()
  const directCalls = []
  const refusing = {
    get state() { return state },
    mutate: async () => false,
  }
  const faceRefused = {
    form: refusing,
    directMutate: async (ops, expectedRevision) => {
      directCalls.push({ ops, expectedRevision })
      return { ok: false, error: { message: 'Config field "taskAgentModel" is not volatile' } }
    },
    view: 'page',
    t: h.t,
  }
  h.findByLabel(faceRefused, 'settings.taskAgentModel').props.onChange({ target: { value: 'p/m' } })
  h.findByLabel(faceRefused, 'settings.taskAgentModel').props.onBlur()
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(directCalls, [{ ops: [{ op: 'set', path: ['taskAgentModel'], value: 'p/m' }], expectedRevision: undefined }],
    'a refused field write retries once through directMutate with no expectedRevision')
  assert.match(h.flatten(h.render(faceRefused)).join('\n'), /settings\.saveFailedDetail:Config field "taskAgentModel" is not volatile/,
    'the host refusal message surfaces verbatim for field writes too')

  // (d) Unserved namespace: labels render, the unavailable line shows, and NO
  // input/textarea is mounted — the card degrades instead of crashing.
  h.resetState()
  const unready = { form: { get state() { return { status: 'loading', value: undefined, writable: false } }, mutate: async () => true }, view: 'page', t: h.t }
  const unreadyText = h.flatten(h.render(unready)).join('\n')
  assert.match(unreadyText, /settings\.unavailable/, 'not-ready snapshot renders the unavailable line')
  assert.match(unreadyText, /settings\.roundsPerSubgoal/, 'field labels still render (structure visible)')
  assert.equal(h.findByLabel(unready, 'settings.roundsPerSubgoal'), undefined, 'no number input while not ready')
  assert.equal(h.findByLabel(unready, 'settings.roles'), undefined, 'no roles textarea while not ready')
  console.log('✓ 66 settings card host shape: field writes via mutate(revision), blank=unset op, refusal → directMutate retry + verbatim message, unavailable = labels only, no controls')
}

// 67. v0.8.2 triageAgentModel: the third flat agent-model field, isomorphic to
//     taskAgentModel/verifyAgentModel — volatile on the schema (host form
//     serves + accepts it), "provider/model" or bare-name parsing, live-ref
//     unwrap + merge into roles.triage at round wiring (empty = inherit the
//     session agent), the v0.8.0 callRoleAgent fallback on the triage call
//     point (override + availability failure → one session-model retry; no
//     override → no retry, no phantom fallback), quick rounds never invoke
//     triage at all, and the settings card renders the field.
{
  // (a) Schema: volatile, default '', description names the triage role's job.
  assert.ok(Config.dict.triageAgentModel, 'Config schema exposes the flat triageAgentModel field')
  assert.equal(Config.dict.triageAgentModel.meta?.volatile, true, 'triageAgentModel is volatile (host form serves + accepts volatile paths only)')
  assert.match(Config.dict.triageAgentModel.meta?.description ?? '', /triage/, 'the description names the triage role')
  assert.match(Config.dict.triageAgentModel.meta?.description ?? '', /quick/, 'the description notes quick rounds skip triage')
  const v67 = Config['~standard'].validate({ triageAgentModel: 't-prov/t-model' }).value
  assert.equal(v67.issues, undefined)
  assert.equal(v67.triageAgentModel.get?.(), 't-prov/t-model', 'volatile triageAgentModel resolves to a live reference')
  const v67default = Config['~standard'].validate({}).value
  assert.equal(v67default.triageAgentModel.get?.(), '', 'unset triageAgentModel defaults to "" (inherit the session agent)')

  // (b) Wiring: parsed through parseAgentModelSpec (same parser as task/verify)
  //     and merged over roles.triage at round start, after the live-ref unwrap.
  const index67 = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(index67, /parseAgentModelSpec\(readConfigField\(config\.triageAgentModel, ''\)\)/,
    'triageAgentModel read unwraps the volatile live reference')
  assert.match(index67, /roleOverrides\.triage = \{ \.\.\.roleOverrides\.triage, \.\.\.triageSpec \}/,
    'triageAgentModel merges over roles.triage exactly like task/verify')
  assert.deepEqual(parseAgentModelSpec('t-prov/t-model'), { provider: 't-prov', model: 't-model' })
  assert.equal(parseAgentModelSpec(''), undefined, 'empty triageAgentModel = inherit session agent (no override)')

  // (c) Fallback on the triage call point: override + availability failure →
  //     one retry on the inherited session model, recorded with role 'triage'.
  const calls67 = []
  const out67 = await driveRound(async (_p, opts) => {
    calls67.push(opts)
    if (opts.label === 'triage' && opts.provider === 't-prov') {
      const err = new Error('child agent run failed: Error: HTTP 503 service unavailable: model overloaded')
      err.code = 'AGENT_RESULT'
      throw err
    }
    if (opts.label?.startsWith('task:')) return okReport
    if (opts.label === 'verify') return okVerdict
    return okTriage
  }, baseArgs({ roles: { triage: { provider: 't-prov', model: 't-model' } } }))
  const triageCalls67 = calls67.filter((c) => c.label === 'triage')
  assert.equal(triageCalls67.length, 2, 'triage retried once on availability failure')
  assert.equal(triageCalls67[0].provider, 't-prov', 'first triage attempt uses the override')
  assert.equal(triageCalls67[1].provider, undefined, 'triage retry inherits the session agent (no provider/model opts)')
  assert.equal(triageCalls67[1].model, undefined)
  assert.equal(out67.fallbacks.length, 1)
  assert.equal(out67.fallbacks[0].role, 'triage')
  assert.equal(out67.fallbacks[0].trigger, 'availability-error')
  assert.deepEqual(out67.fallbacks[0].from, { provider: 't-prov', model: 't-model' })
  assert.equal(out67.verdict.met, true, 'the round completes normally after the triage fallback')

  // (d) No override (empty triageAgentModel): a null triage result does NOT
  //     retry — there is nowhere to fall back to, and no phantom record.
  const calls67d = []
  const out67d = await driveRound(async (_p, opts) => {
    calls67d.push(opts)
    if (opts.label?.startsWith('task:')) return okReport
    if (opts.label === 'verify') return okVerdict
    return null // triage无产出
  }, baseArgs())
  assert.equal(calls67d.filter((c) => c.label === 'triage').length, 1, 'no override → no triage retry')
  assert.deepEqual(out67d.fallbacks, [], 'no override → no fallback record')
  assert.deepEqual(out67d.triage, { auto: [], defer: [], reject: [], human: [] }, 'null triage degrades to the empty triage shape')

  // (e) quick depth never invokes triage (the field only fires on full rounds).
  const calls67e = []
  await driveRound(async (_p, opts) => { calls67e.push(opts); return okReport },
    baseArgs({ depth: 'quick', roles: { triage: { provider: 't-prov', model: 't-model' } } }))
  assert.equal(calls67e.length, 1, 'quick round runs the task agent only')
  assert.equal(calls67e.some((c) => c.label === 'triage'), false, 'quick round never calls triage')

  // (f) The settings card renders the field (source-level pin; the rendered
  //     row itself is asserted in test 65). v0.8.3: model fields are now
  //     kind 'model' (catalog-backed datalist + invalid-model warning).
  const client67 = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client67, /\{ field: 'triageAgentModel', labelKey: 'settings\.triageAgentModel', hintKey: 'settings\.triageModelHint', kind: 'model' \}/,
    'the card field list includes triageAgentModel as a model field')
  assert.ok(client67.includes("'settings.triageModelHint'"), 'the triage hint string exists (role duty + quick-round note)')
  console.log('✓ 67 triageAgentModel: volatile schema field, parse + live-ref unwrap + roles.triage merge, triage fallback / no-override no-retry, quick rounds skip triage, card renders the field')
}

// 68. v0.8.3 model dropdown + invalid-model handling: the three model fields
//     read the host catalog (remote.session.modelCatalog, refreshed on
//     llm/adapters-updated) into a datalist dropdown while keeping free manual
//     entry; a configured value no longer in the catalog (deleted
//     subscription) renders an "unavailable → runtime falls back to the
//     session agent" warning plus an explicit one-click Clear that writes an
//     unset op — never a silent auto-unset; a failed catalog never warns.
{
  // Harness: same loader as 65, with ctx.remote wired (session.modelCatalog
  // + the $on invalidation bus).
  async function loadWithCatalog({ catalogPayload, onUpdated } = {}) {
    const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
    let loaded
    globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m } } }
    new Function('window', client)(globalThis.window)
    const jsx = {
      jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
      jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
    }
    const slotsMem = []
    let slotIndex = 0
    const react = {
      useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(),
      useState: (initial) => {
        const i = slotIndex++
        if (slotsMem[i] === undefined) {
          slotsMem[i] = { value: initial, set: (nv) => { slotsMem[i].value = typeof nv === 'function' ? nv(slotsMem[i].value) : nv } }
        }
        return [slotsMem[i].value, slotsMem[i].set]
      },
    }
    const mod = loaded.factory((req) => (req === 'react' ? react : jsx))
    const registered = []
    const t = (key, params) => key + (params && params.message !== undefined ? ':' + params.message : '')
    let catalogCalls = 0
    const session = {
      modelCatalog: async () => {
        catalogCalls += 1
        if (typeof catalogPayload === 'function') return catalogPayload(catalogCalls)
        return catalogPayload
      },
    }
    const updatedHandlers = []
    mod.apply({
      effect: (fn) => fn(),
      locale: { register: () => () => {}, bind: () => t },
      slots: { inject: (_n, cb) => cb(), register: (spec, view) => { registered.push({ spec, view }) } },
      sessions: {},
      remote: {
        $on: (event, cb) => { updatedHandlers.push(cb); if (onUpdated) onUpdated(event) },
        session,
      },
      configForms: { get: () => undefined, whileServed: (_ns, register) => { register(new Set()); return () => {} } },
    })
    const seat = registered.find((e) => e.spec.name === 'plugins.item')
    assert.ok(seat, 'plugins.item seat registered')
    const walk = (node, fn) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (Array.isArray(node)) { for (const n of node) walk(n, fn); return }
      fn(node)
      if (node.props && node.props.children !== undefined) walk(node.props.children, fn)
    }
    const render = (face) => { slotIndex = 0; return seat.view(face) }
    const findByLabel = (face, label) => {
      let hit
      walk(render(face), (n) => { if (n.props && n.props['aria-label'] === label) hit = n })
      return hit
    }
    // Same flatten contract as the shared harness above: strings/numbers are
    // leaves, function-typed nodes are components called with their props.
    const flatten = (node, out = []) => {
      if (node === null || node === undefined || typeof node === 'boolean') return out
      if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
      if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
      if (typeof node.type === 'function') { flatten(node.type(node.props), out); return out }
      if (node.props && node.props.children !== undefined) flatten(node.props.children, out)
      return out
    }
    return {
      t, render, walk, flatten, findByLabel,
      catalogCalls: () => catalogCalls,
      triggerAdapterUpdate: () => { for (const h of updatedHandlers) h() },
      resetState: () => { slotsMem.length = 0 },
    }
  }

  const CATALOG = {
    ok: true,
    value: {
      groups: [
        { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }, { id: 'glm-5.3', name: 'GLM 5.3' }] },
        { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
      ],
      failures: [],
    },
  }

  // (a) Dropdown data source: with the catalog served, each model input gains
  //     list=<datalist> and the datalist carries one option per catalog model,
  //     labeled `providerName · provider/model`; manual entry stays possible
  //     (the control is still a free text input, not a locked <select>).
  {
    const h = await loadWithCatalog({ catalogPayload: CATALOG })
    assert.equal(h.catalogCalls(), 1, 'catalog fetched once at apply time')
    const snap = { status: 'ready', writable: true, value: { allGoalsMode: false, taskAgentModel: '', verifyAgentModel: '', triageAgentModel: '', roundsPerSubgoal: 3, maxConcurrentRounds: 0, roles: {} } }
    const form = { getSnapshot: () => snap, subscribe: () => () => {}, set: async () => true, unset: async () => true, mutate: async () => true }
    const face = { form, view: 'page', t: h.t, catalog: { subscribe: (cb) => { h.__subs = (h.__subs ?? new Set()); h.__subs.add(cb); return () => h.__subs.delete(cb) }, getSnapshot: () => ({ status: 'ready', options: [
      { value: 'deepseek/glm-5.3-flash', provider: 'deepseek', model: 'glm-5.3-flash', label: 'DeepSeek · deepseek/glm-5.3-flash' },
      { value: 'deepseek/glm-5.3', provider: 'deepseek', model: 'glm-5.3', label: 'DeepSeek · deepseek/glm-5.3' },
      { value: 'openai/gpt-5', provider: 'openai', model: 'gpt-5', label: 'OpenAI · openai/gpt-5' },
    ] }) } }
    const taskInput = h.findByLabel(face, 'settings.taskAgentModel')
    assert.equal(taskInput.props.list, 'cybernetics-models-taskAgentModel', 'model input binds the catalog datalist')
    assert.equal(typeof taskInput.props.onChange, 'function', 'model input keeps free manual entry (text input, not a locked select)')
    let datalist
    h.walk(h.render(face), (n) => { if (n.type === 'datalist') datalist = n })
    assert.ok(datalist, 'datalist rendered')
    const options = datalist.props.children
    assert.equal(options.length, 3, 'one option per catalog model')
    assert.deepEqual(options.map((o) => o.props.value), ['deepseek/glm-5.3-flash', 'deepseek/glm-5.3', 'openai/gpt-5'], 'option values are provider/model routes')
    assert.equal(options[0].props.label, 'DeepSeek · deepseek/glm-5.3-flash', 'options label providerName · provider/model')

    // (b) Invalid configured model (deleted subscription): provider/model value
    //     not in the catalog → warning text + Clear button; Clear writes an
    //     unset op (explicit user action, NOT a silent auto-unset on render).
    const unsets = []
    const snapInvalid = { status: 'ready', writable: true, value: { allGoalsMode: false, taskAgentModel: 'deepseek/gone-model', verifyAgentModel: 'bare-gone-model', triageAgentModel: '', roundsPerSubgoal: 3, maxConcurrentRounds: 0, roles: {} } }
    const formInvalid = { ...form, getSnapshot: () => snapInvalid, unset: async (field) => { unsets.push(field); return true } }
    const faceInvalid = { ...face, form: formInvalid }
    const warnText = h.flatten(h.render(faceInvalid)).join('\n')
    assert.ok(warnText.includes('settings.modelUnavailable'), 'unavailable warning rendered for a catalog-missing provider/model value')
    assert.ok(warnText.includes('settings.modelUnavailable'), 'bare-name value also warned when no option matches')
    let clearBtn
    h.walk(h.render(faceInvalid), (n) => {
      if (n.type === 'button' && n.props && typeof n.props['aria-label'] === 'string' && n.props['aria-label'].startsWith('settings.modelClear') && clearBtn === undefined) clearBtn = n
    })
    assert.ok(clearBtn, 'Clear button rendered next to the warning')
    const unsetsBefore = unsets.length
    clearBtn.props.onClick()
    assert.equal(unsets.length, unsetsBefore + 1, 'Clear performs exactly one unset write')
    assert.equal(unsets[unsets.length - 1], 'taskAgentModel', 'Clear unsets the field whose model is unavailable')
    // Rendering alone never writes: a fresh render with the invalid value and
    // no click performs no unset.
    const h2 = await loadWithCatalog({ catalogPayload: CATALOG })
    const snapB = { status: 'ready', writable: true, value: { allGoalsMode: false, taskAgentModel: 'deepseek/gone-model', verifyAgentModel: '', triageAgentModel: '', roundsPerSubgoal: 3, maxConcurrentRounds: 0, roles: {} } }
    const formB = { getSnapshot: () => snapB, subscribe: () => () => {}, set: async () => true, unset: async () => { throw new Error('render must not write') }, mutate: async () => true }
    h2.render({ form: formB, view: 'page', t: h2.t, catalog: face.catalog })
    // (no throw = render never auto-unsets)

    // (c) Valid configured model: no warning. provider/model exact match and
    //     bare-name match both count as available.
    const snapValid = { status: 'ready', writable: true, value: { allGoalsMode: false, taskAgentModel: 'deepseek/glm-5.3', verifyAgentModel: 'gpt-5', triageAgentModel: '', roundsPerSubgoal: 3, maxConcurrentRounds: 0, roles: {} } }
    const faceValid = { form: { ...form, getSnapshot: () => snapValid }, view: 'page', t: h.t, catalog: face.catalog }
    const textValid2 = h.flatten(h.render(faceValid)).join('\n')
    assert.ok(!textValid2.includes('settings.modelUnavailable'), 'valid provider/model value → no warning')
    assert.ok(!textValid2.includes('settings.modelClear'), 'valid value → no Clear button')

    // (d) Failed/absent catalog never warns (no false positives when the host
    //     does not serve the model directory or discovery errored).
    const faceErr = { form: formInvalid, view: 'page', t: h.t, catalog: { subscribe: () => () => {}, getSnapshot: () => ({ status: 'error', options: [] }) } }
    assert.ok(!h.flatten(h.render(faceErr)).join('\n').includes('settings.modelUnavailable'), 'catalog error → no warning')
    const faceNoCat = { form: formInvalid, view: 'page', t: h.t, catalog: undefined }
    assert.ok(!h.flatten(h.render(faceNoCat)).join('\n').includes('settings.modelUnavailable'), 'no catalog prop → no warning')

    // (e) The invalidation bus is subscribed: an llm/adapters-updated event
    //     refetches the catalog (the deleted-subscription case flips live).
    h.triggerAdapterUpdate()
    assert.ok(h.catalogCalls() >= 2, 'llm/adapters-updated refetches the model catalog')
    console.log('✓ 68 model dropdown + invalid-model handling: catalog datalist with manual entry, unavailable warning + explicit Clear (unset op, never silent), no warning on valid/failed catalog, adapters-updated refetch')
  }
}

// 69. v0.8.4: roles advanced configuration — off the panel, alive via yaml.
//     The GUI decision: hand-editing a JSON object in the settings card is
//     unfriendly, so the card drops the roles textarea + Apply button and the
//     schema drops the `.volatile()` mark. Consequences locked here:
//     (a) schema semantics — roles is non-volatile, so the host panel neither
//     serves nor writes it (already covered by test 57); a profile yaml
//     value survives schemastery resolution as a PLAIN object (live config
//     path), while named task roles keep their shape.
//     (b) runtime semantics — readConfigField in src/index.ts unwraps BOTH
//     shapes: a volatile live reference ({get}) AND a plain object; the
//     plain-object roles then merge with the flat panel fields into the
//     canonical roleOverrides the round script consumes (named roles such as
//     'frontend' pass through untouched).
//     (c) the yaml documentation path exists: README documents editing the
//     profile config yaml `config.roles` and the host-reload requirement.
{
  // (a) yaml-shaped profile config resolves cleanly; roles stays a plain object.
  const yamlConfig = Config['~standard'].validate({
    roles: {
      default: { provider: 'deepseek', model: 'glm-5.3' },
      frontend: { provider: 'openai', model: 'gpt-5' },
    },
  }).value
  assert.equal(yamlConfig.issues, undefined, 'a roles-bearing profile config passes schema validation')
  assert.equal(Config.dict.roles.meta?.volatile, undefined, 'roles carries no volatile mark (host panel drops it)')
  assert.ok(!yamlConfig.roles?.get, 'roles resolves to a PLAIN object (not a live reference) once non-volatile')
  assert.deepEqual(yamlConfig.roles.default, { provider: 'deepseek', model: 'glm-5.3' })
  assert.deepEqual(yamlConfig.roles.frontend, { provider: 'openai', model: 'gpt-5' }, 'named task roles keep their {provider, model} shape')

  // (b) runtime: the wiring reads roles through readConfigField, which accepts
  //     a plain object exactly like a volatile live ref — verify against the
  //     real function semantics replicated here plus the source wiring.
  const readConfigField69 = (field, fallback) => {
    if (field === undefined) return fallback
    if (typeof field === 'object' && field !== null && typeof field.get === 'function') {
      const value = field.get()
      return value === undefined ? fallback : value
    }
    return field
  }
  const plainRoles = { default: { provider: 'deepseek', model: 'glm-5.3' }, frontend: { provider: 'openai', model: 'gpt-5' } }
  assert.deepEqual(readConfigField69(plainRoles, {}), plainRoles, 'non-volatile roles: the plain object is returned as-is')
  assert.deepEqual(readConfigField69({ get: () => plainRoles }, {}), plainRoles, 'volatile roles (legacy config): the live ref is unwrapped')
  assert.deepEqual(readConfigField69(undefined, {}), {}, 'absent roles falls back to an empty dict')
  const indexSrc = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(indexSrc, /\{\ \.\.\.readConfigField\(config\.roles, \{\}\ as RolesConfig\)\ \}/,
    'the wiring spreads roles through readConfigField (plain object or live ref)')
  assert.match(indexSrc, /roleOverrides\.default = \{ \.\.\.roleOverrides\.default, \.\.\.taskSpec \}/,
    'flat taskAgentModel still merges over the yaml-configured roles.default')
  // The flat panel field overrides only its one role; the named role survives.
  const roleOverrides = { ...readConfigField69(plainRoles, {}) }
  const taskSpec = parseAgentModelSpec('zai-coding-cn/glm-5.3-flash')
  roleOverrides.default = { ...roleOverrides.default, ...taskSpec }
  assert.deepEqual(roleOverrides.default, { provider: 'zai-coding-cn', model: 'glm-5.3-flash' }, 'panel flat field overrides roles.default')
  assert.deepEqual(roleOverrides.frontend, { provider: 'openai', model: 'gpt-5' }, 'named task role survives the merge')

  // (c) docs: the README advanced-configuration section records the yaml path
  //     and the host-reload requirement (both language editions).
  for (const [file, mustMatch] of [
    ['../README.md', /roles[\s\S]{0,2000}cordis\.patch\.yml[\s\S]{0,2000}(reload|Restart|restart)/],
    ['../README.zh-CN.md', /roles[\s\S]{0,2000}(cordis\.patch\.yml|profile)[\s\S]{0,2000}(重载|重启)/],
  ]) {
    const md = await readFile(new URL(file, import.meta.url), 'utf8')
    assert.match(md, mustMatch, `${file} documents the roles yaml configuration path + reload requirement`)
  }
  console.log('✓ 69 roles advanced configuration: non-volatile schema (plain-object resolution), readConfigField dual semantics (plain object + legacy live ref), named roles survive the flat-field merge, README yaml path documented')
}

// 70. v0.8.5 gateApprovalRelay: delegated-child approval relay to the
//     TOP-LEVEL session agent's NATIVE approval panel (last-hop fix).
//     The host pins every delegated child's approval policy to 'never'
//     (dsh-subagent captureDelegatedPolicyOverrides → ApprovalService
//     short-circuit 'rejected' before any answerer), so a task agent's sandbox
//     escalation can never reach the user. Relay wiring locked here:
//     (a) agent/created — a delegated child (session.header.origin
//         'subagent') gets one plain `approval/policy {policy:'ask'}`
//         appended to its session (later events win over the
//         delegation-seeded pin); top-level agents and lineage-only forks are
//         untouched; an append throw never fails creation.
//     (b) approval/request — registered OUTERMOST (`prepend: true`). The host's
//         api-remotes registers an approval/request forwarder at boot and the
//         browser's per-session approval answerer claims a child request
//         without ever delegating, so a listener registered later is INNER and
//         never runs (the pre-fix last-hop defect, reproduced by the negative
//         control below). The relay re-issues the child request ON THE
//         TOP-LEVEL LIVE ANCESTOR through ctx.get('approval').request — the
//         native Allow once / Reject panel of the watched conversation — with
//         the child identity in displayReason and NO child callId.
//     (c) fallback order: native approval panel → user-questions on the same
//         agent (top-level turn closed) → native chain (no live top-level
//         agent). Allow → 'allowed-once'; anything else → 'rejected'; ask
//         delivery failure → explicit 'rejected'; aborted child run →
//         'cancelled'.
//     (d) root-agent requests pass straight through (next called).
//     (e) gateApprovalRelay:false registers neither listener.
//     (f) schema/docs: gateApprovalRelay defaults true, is non-volatile, the
//         obsolete bounded-window field is gone, and both READMEs document the
//         native-panel relay as config-file maintained.
{
  // Faithful-enough cordis waterfall: listeners run OUTERMOST-first in
  // registration order; `prepend` unshifts; a listener that never calls next()
  // vetoes every listener behind it (cordis/lib/index.js:317-325).
  const waterfallBus = () => {
    const hooks = new Map()
    return {
      on(event, fn, options) {
        const opts = typeof options === 'object' && options !== null ? options : { prepend: options === true }
        const list = hooks.get(event) ?? []
        if (opts.prepend) list.unshift({ fn })
        else list.push({ fn })
        hooks.set(event, list)
        return () => {
          const index = list.findIndex((hook) => hook.fn === fn)
          if (index >= 0) list.splice(index, 1)
        }
      },
      run(event, request, terminal) {
        const list = [...(hooks.get(event) ?? [])]
        const next = (() => {
          const step = () => {
            const head = list.shift()
            return head === undefined ? terminal(request) : head.fn(request, step)
          }
          return step
        })()
        return next()
      },
    }
  }

  const rootAgent = { id: 'session-root', session: { header: { id: 'session-root' } } }
  const midAgent = {
    id: 'session-mid',
    session: { header: { id: 'session-mid', origin: 'subagent', parentSession: 'session-root', delegationDepth: 1 } },
  }
  const childSessionAppends = []
  const childAgent = {
    id: 'session-child',
    session: {
      header: { id: 'session-child', origin: 'subagent', parentSession: 'session-mid', delegationDepth: 2 },
      append: (type, body) => { childSessionAppends.push({ type, body }) },
    },
  }
  // A fork keeps parentSession for lineage but is an independent root: it must
  // NOT be treated as a delegated child.
  const forkAgent = { id: 'session-fork', session: { header: { id: 'session-fork', parentSession: 'session-root', delegationDepth: 0 } } }

  const listeners = []
  let approvalRequests = []
  let approvalImpl = async () => 'allowed-once'
  let askedQuestions = null
  const baseCtx = () => ({
    tools: { register: () => () => {} },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null },
    workingDirectory: { get: () => root },
    agentPresets: { serviceFor: () => undefined },
    agents: {
      get: (id) => {
        if (id === 'session-root') return rootAgent
        if (id === 'session-mid') return midAgent
        return undefined
      },
      roots: () => [rootAgent],
    },
    get: (name) => name === 'approval'
      ? { request: async (request) => { approvalRequests.push(request); return approvalImpl(request) } }
      : undefined,
    userQuestions: {
      ask: async (request) => {
        askedQuestions = request
        return { answers: [{ id: request.questions[0].id, selected: ['允许一次（Allow once）'] }] }
      },
    },
    on: (event, fn, options) => { listeners.push({ event, fn, options }); return () => {} },
  })
  const ctx70 = baseCtx()
  apply(ctx70, { hardGate: true })

  const created = listeners.find((l) => l.event === 'agent/created')
  const relayEntry = listeners.find((l) => l.event === 'approval/request')
  assert.ok(created && relayEntry, 'relay listeners registered under hardGate')
  assert.deepEqual(relayEntry.options, { prepend: true },
    'relay registered OUTERMOST — the last-hop ordering fix (api-remotes forwards earlier)')
  const relay = relayEntry.fn

  // (a) child creation flips the pinned policy; top-level + fork untouched.
  created.fn({ agent: childAgent })
  created.fn({ agent: rootAgent })
  created.fn({ agent: forkAgent })
  assert.deepEqual(childSessionAppends, [{ type: 'approval/policy', body: { policy: 'ask' } }],
    'delegated child policy unpinned to ask, root/fork untouched')
  created.fn({ agent: { id: 'x', session: { header: { origin: 'subagent', parentSession: 'session-root' }, append: () => { throw new Error('boom') } } } })

  // (b1) the relay asks the TOP-LEVEL ancestor (child → mid → root) through the
  //      host's native approval service; the native chain is NOT consulted.
  let nextCalls = 0
  const firstSignal = new AbortController().signal
  const outNative = await relay(
    { agent: childAgent, toolName: 'write', reason: 'write ~/.dsh/profiles/web/cordis.patch.yml', signal: firstSignal },
    async () => { nextCalls++; return 'unavailable' },
  )
  assert.equal(outNative, 'allowed-once')
  assert.equal(nextCalls, 0, 'native chain bypassed: the request goes to the watched conversation panel, not the hidden child panel')
  assert.equal(approvalRequests.length, 1)
  assert.equal(approvalRequests[0].agent, rootAgent, 'relay climbs to the top-level live ancestor')
  assert.equal(approvalRequests[0].toolName, 'write')
  assert.match(approvalRequests[0].reason, /session-child/, 'audit reason names the sub-agent')
  assert.match(approvalRequests[0].reason, /cordis\.patch\.yml/)
  assert.match(approvalRequests[0].displayReason.zh, /子代理/)
  assert.match(approvalRequests[0].displayReason.zh, /write/)
  assert.match(approvalRequests[0].displayReason.en, /Sub-agent/)
  assert.equal(approvalRequests[0].callId, undefined, 'child ToolCallId never leaks into the parent transcript')
  assert.equal(approvalRequests[0].signal, firstSignal, 'child cancellation lifetime is forwarded')

  // (b2) the user rejects in the parent panel → explicit 'rejected'.
  approvalImpl = async () => 'rejected'
  const outReject = await relay({ agent: childAgent, toolName: 'bash' }, async () => { nextCalls++; return 'unavailable' })
  assert.equal(outReject, 'rejected')
  assert.equal(nextCalls, 0)

  // (b3) top-level turn closed (approval.request throws) → user-questions on
  //      the same agent; Allow → allowed-once, Reject → rejected.
  approvalImpl = async () => { throw new Error('approval.request() outside an open turn') }
  approvalRequests = []
  const outQuestion = await relay({ agent: childAgent, toolName: 'write', reason: 'outside workspace' }, async () => 'unavailable')
  assert.equal(outQuestion, 'allowed-once')
  assert.equal(askedQuestions?.agent, rootAgent, 'question fallback targets the same top-level agent')
  assert.match(askedQuestions?.questions?.[0]?.question, /write/)
  assert.match(askedQuestions?.questions?.[0]?.detail, /outside workspace/)

  ctx70.userQuestions.ask = async (request) => ({ answers: [{ id: request.questions[0].id, selected: ['拒绝（Reject）'] }] })
  approvalImpl = async () => { throw new Error('no open turn') }
  const outQuestionReject = await relay({ agent: childAgent, toolName: 'bash' }, async () => 'unavailable')
  assert.equal(outQuestionReject, 'rejected')

  // (b3c) v0.8.8 DESIGN-GAP FIX: the native panel answering 'unavailable'
  //      (no client claimed the frame — the exact live failure: asked →
  //      decided unavailable in 9 ms) is NOT terminal; the relay still falls
  //      through to the user-questions card so the user gets a VISIBLE prompt.
  approvalImpl = async () => 'unavailable'
  ctx70.userQuestions.ask = async (request) => {
    askedQuestions = request
    return { answers: [{ id: request.questions[0].id, selected: ['允许一次（Allow once）'] }] }
  }
  const outUnavailable = await relay({ agent: childAgent, toolName: 'write', reason: 'outside workspace' }, async () => { nextCalls++; return 'unavailable' })
  assert.equal(outUnavailable, 'allowed-once',
    'native unavailable falls through to the visible question card instead of failing the child in 9ms')
  assert.equal(nextCalls, 0, 'the native chain is still bypassed on the unavailable fall-through')
  assert.equal(askedQuestions?.agent, rootAgent, 'the question card targets the top-level agent')

  // (b3d) both channels unavailable → terminal 'unavailable' (fail-closed,
  //      explicit, never a hang and never a silent success).
  const savedAsk = ctx70.userQuestions.ask
  ctx70.userQuestions = undefined
  const outBothGone = await relay({ agent: childAgent, toolName: 'bash' }, async () => { nextCalls++; return 'unavailable' })
  assert.equal(outBothGone, 'unavailable', 'no approval channel and no question channel → explicit terminal unavailable')
  assert.equal(nextCalls, 0, 'terminal unavailable is answered by the relay, not passed to the native chain')
  ctx70.userQuestions = { ask: savedAsk }

  // (b4) question delivery fails → explicit 'rejected' (never silent success).
  ctx70.userQuestions.ask = async () => { throw new Error('no answerer') }
  const outError = await relay({ agent: childAgent, toolName: 'bash' }, async () => 'unavailable')
  assert.equal(outError, 'rejected')

  // (b5) child run already aborted → 'cancelled', no approval ask, no question.
  approvalImpl = async () => 'allowed-once'
  askedQuestions = null
  approvalRequests = []
  const outAbort = await relay({ agent: childAgent, toolName: 'bash', signal: { aborted: true } }, async () => 'unavailable')
  assert.equal(outAbort, 'cancelled')
  assert.equal(approvalRequests.length, 0)
  assert.equal(askedQuestions, null)

  // (b6) no live top-level agent (parent chain dead) → native chain, verbatim.
  const orphan = { id: 'session-orphan', session: { header: { id: 'session-orphan', origin: 'subagent', parentSession: 'session-gone', delegationDepth: 1 } } }
  let orphanNext = 0
  const outOrphan = await relay({ agent: orphan, toolName: 'bash' }, async () => { orphanNext++; return 'unavailable' })
  assert.equal(outOrphan, 'unavailable')
  assert.equal(orphanNext, 1, 'no live top-level agent falls through to the native chain')

  // (d) root-agent approval requests pass straight through.
  let rootNext = 0
  const outRoot = await relay({ agent: rootAgent, toolName: 'bash' }, async () => { rootNext++; return 'allowed-once' })
  assert.equal(outRoot, 'allowed-once')
  assert.equal(rootNext, 1)

  // (b7) LAST-HOP REGRESSION, full chain: an api-remotes-shaped forwarder
  //      registered BEFORE the plugin claims the request for the invisible
  //      child panel and never delegates. The plugin's prepended relay still
  //      answers through the top-level approval service.
  const bus = waterfallBus()
  let claimedByHiddenPanel = 0
  bus.on('approval/request', () => { claimedByHiddenPanel++; return new Promise(() => {}) })
  const busApprovals = []
  const busCtx = { ...baseCtx(), on: bus.on, get: (name) => name === 'approval'
    ? { request: async (request) => { busApprovals.push(request); return 'allowed-once' } }
    : undefined }
  apply(busCtx, { hardGate: true })
  const raced = await Promise.race([
    bus.run('approval/request', { agent: childAgent, toolName: 'write', reason: 'outside workspace' }, async () => 'unavailable'),
    new Promise((resolve) => setTimeout(() => resolve('HUNG'), 100)),
  ])
  assert.equal(raced, 'allowed-once', 'prepended relay answers even though the earlier forwarder claimed the request')
  assert.equal(claimedByHiddenPanel, 0, 'hidden child panel never claims: the relay answers before the forwarder')
  assert.equal(busApprovals.length, 1)
  assert.equal(busApprovals[0].agent, rootAgent)

  // (b8) negative control: the SAME relay wired WITHOUT prepend sits behind the
  //      hanging forwarder and never runs — the exact pre-fix last-hop defect.
  const negative = waterfallBus()
  negative.on('approval/request', () => new Promise(() => {}))
  negative.on('approval/request', async () => 'allowed-once')
  const hung = await Promise.race([
    negative.run('approval/request', { agent: childAgent, toolName: 'write' }, async () => 'unavailable'),
    new Promise((resolve) => setTimeout(() => resolve('HUNG'), 40)),
  ])
  assert.equal(hung, 'HUNG', 'an inner relay is unreachable behind the boot-time forwarder (reproduced)')

  // (e) opt-out registers neither listener.
  const listenersOff = []
  const ctxOff = { ...baseCtx(), agents: { get: () => undefined, roots: () => [] }, on: (event, fn, options) => { listenersOff.push({ event, options }); return () => {} } }
  apply(ctxOff, { hardGate: true, gateApprovalRelay: false })
  assert.equal(listenersOff.filter((l) => l.event === 'agent/created' || l.event === 'approval/request').length, 0)

  // (f) schema defaults + docs (both languages).
  const parsed = Config({ toolName: 'cybernetics' })
  assert.equal(parsed.gateApprovalRelay, true, 'gateApprovalRelay defaults true')
  assert.equal('gateApprovalRelayTimeoutMs' in Config({ toolName: 'cybernetics' }), false,
    'the obsolete bounded-window field is gone (relay is not a race)')
  const indexSrc70 = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(indexSrc70, /gateApprovalRelay: z\.boolean\(\)\.default\(true\)/, 'schema field present, default true, non-volatile (no .volatile())')
  assert.match(indexSrc70, /\{ prepend: true \}/, 'relay listener registered with prepend:true in source')
  assert.doesNotMatch(indexSrc70, /gateApprovalRelayTimeoutMs/, 'no stale bounded-window field in source')
  for (const file of ['../README.md', '../README.zh-CN.md']) {
    const md = await readFile(new URL(file, import.meta.url), 'utf8')
    assert.match(md, /gateApprovalRelay/, `${file} documents gateApprovalRelay`)
    assert.match(md, /prepend|outermost|最外层|原生审批面板|native approval panel/i, `${file} documents the outermost/relay-first channel`)
    assert.match(md, /unavailable/, `${file} documents the unavailable fall-through semantics`)
    assert.match(md, /排障|troubleshoot|Troubleshoot|debug log|调试日志/i, `${file} documents relay troubleshooting / observability`)
    assert.doesNotMatch(md, /gateApprovalRelayTimeoutMs/, `${file} has no stale relay-window documentation`)
  }
  console.log('✓ 70 gateApprovalRelay: child policy unpin at creation, OUTERMOST relay to the top-level session agent\'s native approval panel (child->mid->root climb, no child callId, question fallback, native-unavailable → visible question card, dual-unavailable → terminal unavailable, explicit cancel/reject semantics, ordering regression + negative control), root pass-through, opt-out, schema+README')
}

// 71. v0.8.10 hot-toggle hardGate: the volatile settings-card toggle installs /
//     disposes the gate wiring live via loader/volatile-update (no remount):
//     (a) false→true: assemble strips bash, pre-execute denies, guidance gains
//         the HARD GATE segment;
//     (b) true→false: tools restored (listener disposed), pre-execute passes,
//         guidance drops the segment;
//     (c) repeated toggles are idempotent — never more than one listener set;
//     (d) gateMode/gatedTools/gateAllowlist stay non-volatile (schema).
{
  const rootAgent = { id: 'agent-root' }
  const registered = []
  const sections = []
  // Live-reference face of a volatile field (what schema resolution gives
  // apply() when the settings card commits a toggle without a remount).
  const config = { hardGate: { get: () => gateValue } }
  let gateValue = false
  const ctx = {
    tools: { register: () => () => {} },
    systemPrompt: { section: (s) => { sections.push(s); return () => {} }, getSectionOrder: () => 0 },
    goals: { get: () => null },
    workingDirectory: { get: () => root },
    agentPresets: { serviceFor: () => undefined },
    agents: { roots: () => [rootAgent] },
    on: (event, fn) => { registered.push({ event, fn }); return () => {} },
  }
  apply(ctx, config)
  const volatileUpdate = registered.find((l) => l.event === 'loader/volatile-update')
  assert.ok(volatileUpdate, 'apply() listens on loader/volatile-update')
  const gateListeners = (event) => registered.filter((l) => l.event === event && l.alive !== false)
  const fire = (assembly, next = () => assembly) => {
    const gate = gateListeners('system-prompt/assemble').at(-1)
    if (gate === undefined) return assembly
    return gate.fn(assembly, { scope: rootAgent }, next)
  }
  const preExecute = async (name) => {
    const exec = gateListeners('tools/pre-execute').at(-1)
    if (exec === undefined) return { kind: 'allow' }
    return exec.fn({ agent: rootAgent, name }, async () => ({ kind: 'allow' }))
  }
  // v0.9.0: section.text is a function of the requesting session.
  const latestSectionText = () => {
    const t = sections.at(-1)?.text
    return typeof t === 'function' ? t({ agent: { session: { id: 'hotgate-test' } } }) : (t ?? '')
  }
  const countAlive = (event) => registered.filter((l) => l.event === event && l.alive !== false).length
  const disposeOf = (l) => { l.disposer?.(); l.alive = false }
  // Track disposers: rewrap ctx.on to capture each listener's disposer.
  // (Redo the apply with a capturing ctx for dispose assertions.)
  const registered2 = []
  const ctx2 = {
    ...ctx,
    on: (event, fn) => { const entry = { event, fn, alive: true }; const d = () => { entry.alive = false }; entry.disposer = d; registered2.push(entry); return d },
  }
  apply(ctx2, config)
  const vu = registered2.find((l) => l.event === 'loader/volatile-update')
  const alive2 = (event) => registered2.filter((l) => l.event === event && l.alive !== false)
  const fire2 = (assembly) => {
    const gates = alive2('system-prompt/assemble')
    if (gates.length === 0) return assembly
    return gates.at(-1).fn(assembly, { scope: rootAgent }, () => assembly)
  }
  const pre2 = async (name) => {
    const execs = alive2('tools/pre-execute')
    if (execs.length === 0) return { kind: 'allow' }
    return execs.at(-1).fn({ agent: rootAgent, name }, async () => ({ kind: 'allow' }))
  }

  // (a) initial hardGate=false → no gate; volatile toggle to true (panel save).
  assert.equal(alive2('system-prompt/assemble').length, 0, 'initial hardGate=false installs no gate')
  gateValue = true
  vu.fn()
  assert.equal(alive2('system-prompt/assemble').length, 1, 'false→true hot toggle installs exactly one assemble gate')
  assert.equal(alive2('tools/pre-execute').length, 1, 'false→true hot toggle installs exactly one pre-execute gate')
  const stripped = fire2({ tools: [{ name: 'bash' }, { name: 'edit' }, { name: 'read' }, { name: 'cybernetics' }] })
  assert.deepEqual(stripped.tools.map((t) => t.name), ['read', 'cybernetics'], 'hot-enabled gate strips bash/edit from the root assembly')
  const denied = await pre2('bash')
  assert.equal(denied.kind, 'deny', 'hot-enabled gate denies bash at tools/pre-execute')
  assert.match(latestSectionText(), /HARD GATE ACTIVE/, 'guidance gains the HARD GATE segment on hot enable')

  // (b) true→false: tools restored, listeners disposed.
  gateValue = false
  vu.fn()
  assert.equal(alive2('system-prompt/assemble').length, 0, 'true→false hot toggle disposes the assemble gate')
  assert.equal(alive2('tools/pre-execute').length, 0, 'true→false hot toggle disposes the pre-execute gate')
  const restored = fire2({ tools: [{ name: 'bash' }, { name: 'read' }] })
  assert.deepEqual(restored.tools.map((t) => t.name), ['bash', 'read'], 'gate off: assembly keeps bash (tool restored)')
  const allowed = await pre2('bash')
  assert.equal(allowed.kind, 'allow', 'gate off: pre-execute passes bash through')
  assert.doesNotMatch(latestSectionText(), /HARD GATE ACTIVE/, 'guidance drops the HARD GATE segment on hot disable')

  // (c) repeated toggles are idempotent — one listener set at most, and the
  //     disposed previous listener is never invoked again.
  for (const value of [true, true, false, false, true, false, true]) {
    gateValue = value
    vu.fn()
  }
  assert.equal(alive2('system-prompt/assemble').length, 1, 'repeated toggles leave exactly one live assemble gate (idempotent, no double registration)')
  assert.equal(alive2('tools/pre-execute').length, 1, 'repeated toggles leave exactly one live pre-execute gate')
  const afterToggles = await pre2('bash')
  assert.equal(afterToggles.kind, 'deny', 'the surviving gate after repeated toggles still denies (final state hardGate=true)')

  // (d) the fine-grained gate fields stay non-volatile.
  assert.equal(Config.dict.gateMode.meta?.volatile, undefined, 'gateMode stays non-volatile')
  assert.equal(Config.dict.gatedTools.meta?.volatile, undefined, 'gatedTools stays non-volatile')
  assert.equal(Config.dict.gateAllowlist.meta?.volatile, undefined, 'gateAllowlist stays non-volatile')
  assert.equal(Config.dict.gateApprovalRelay.meta?.volatile, undefined, 'gateApprovalRelay stays non-volatile')
  assert.equal(Config.dict.hardGate.meta?.volatile, true, 'hardGate is the volatile toggle')

  console.log('✓ 71 hot-toggle hardGate: false→true installs gate (bash stripped, pre-execute denies, HARD GATE guidance), true→false restores tools + disposes listeners, repeated toggles idempotent, gate fields stay non-volatile')
}

// 72. brief omission regression (fix A): a goal WITHOUT a work order must not
//     hand the workflow binder an own property whose value is undefined —
//     structuredClone keeps it and the host-side json() (snapshotJsonValue)
//     rejects nested undefined, killing the round at bind time with
//     "workflow binding value must be lossless JSON" (the live failure).
//     The result must also flag the briefless launch (fix C warning).
{
  const engine72 = fakeEngine()
  const host72 = fakeHost(engine72, { sessionId: 'sess-test-72' })
  host72.ctx.workingDirectory = { get: () => root }
  apply(host72.ctx, {})
  const tool72 = host72.tools[0]
  const exec72 = { agent: host72.parent, signal: undefined }
  const metRound72 = {
    round: 1,
    report: { summary: '完成', done: true, artifacts: [], evidence: 'e', nextStepThoughts: [] },
    verdict: { met: true, criteria: [], gaps: [], goalItselfQuestionable: false },
    triage: { auto: [], defer: [], reject: [], human: [] },
  }

  // (a) background start without brief: no own `brief` key reaches the binder.
  const s = await tool72.execute({ action: 'start', title: '无委托书任务' }, exec72)
  assert.equal(s.started, true)
  assert.equal(Object.hasOwn(engine72.runs.at(-1).request.args, 'brief'), false,
    'briefless start: workflow args carry no own `brief` property (undefined would kill the bind)')
  assert.match(s.warning ?? '', /没有工作委托书/, 'briefless start carries the no-work-order warning')

  engine72.runs.at(-1).settle({ stopReason: 'completed', value: metRound72 })
  await new Promise((r) => setImmediate(r))
  await tool72.execute({ action: 'collect', goalId: s.goalId }, exec72)

  // (b) blocking round without brief: the same binder rule on the sync path.
  const p = tool72.execute({ action: 'round', goalId: s.goalId }, exec72)
  const before72 = engine72.runs.length
  for (let i = 0; i < 100 && engine72.runs.length === before72; i++) await new Promise((r) => setImmediate(r))
  assert.equal(Object.hasOwn(engine72.runs.at(-1).request.args, 'brief'), false,
    'briefless blocking round: workflow args carry no own `brief` property')
  engine72.runs.at(-1).settle({ stopReason: 'completed', value: { ...metRound72, round: 2 } })
  const out72 = await p
  assert.match(out72.warning ?? '', /没有工作委托书/, 'briefless blocking round carries the warning too')

  // (c) control: a briefed goal still passes its brief through (test-3 invariant).
  const c = await tool72.execute({ action: 'start', title: '有委托书任务', brief: '完整委托书' }, exec72)
  assert.equal(engine72.runs.at(-1).request.args.brief, '完整委托书', 'briefed goal: brief still passed through')
  assert.equal(c.warning, undefined, 'briefed launch carries no warning')
  console.log('✓ 72 brief omission: no own `brief` key in workflow args (start + blocking round); warning surfaces; briefed control intact')
}

// 73. revise brief hygiene (fix B): a revision's new brief lands on the
//     SUCCESSOR goal only — it must never rewrite the frozen old goal — and
//     the revise result echoes the effective work order (fix C workOrder).
{
  const engine73 = fakeEngine()
  const host73 = fakeHost(engine73, { sessionId: 'sess-test-73' })
  host73.ctx.workingDirectory = { get: () => root }
  apply(host73.ctx, {})
  const tool73 = host73.tools[0]
  const exec73 = { agent: host73.parent, signal: undefined }
  const metRound73 = {
    round: 1,
    report: { summary: '完成', done: true, artifacts: [], evidence: 'e', nextStepThoughts: [] },
    verdict: { met: true, criteria: [], gaps: [], goalItselfQuestionable: false },
    triage: { auto: [], defer: [], reject: [], human: [] },
  }

  const a = await tool73.execute({ action: 'start', title: '旧任务', brief: '旧委托书内容' }, exec73)
  engine73.runs[0].settle({ stopReason: 'completed', value: metRound73 })
  await new Promise((r) => setImmediate(r))
  await tool73.execute({ action: 'collect', goalId: a.goalId }, exec73)

  const newBrief = `新委托书：方向改为 Y，验收标准 Z（${'x'.repeat(120)}）`
  const r = await tool73.execute({ action: 'revise', goalId: a.goalId, reason: '补充新委托书', brief: newBrief }, exec73)
  assert.equal(r.workOrder?.present, true, 'revise echoes the effective work order')
  assert.equal(r.workOrder.chars, newBrief.length, 'workOrder reports the brief length')
  assert.equal(r.workOrder.preview, newBrief.slice(0, 80), 'workOrder previews the first 80 chars')
  assert.equal(r.warning, undefined, 'a briefed successor carries no warning')
  assert.equal(engine73.runs.at(-1).request.args.brief, newBrief, 'successor round receives the new brief')

  // The FROZEN old goal must keep ITS brief — read the persisted board, the
  // exact surface the「目标」tab and rehydration consume.
  const saved73 = JSON.parse(await readFile(join(root, '.cybernetics', 'board-sess-test-73.json'), 'utf8'))
  const oldEntry73 = saved73.goals.find((g) => g.goalId === a.goalId)
  assert.equal(oldEntry73.status, 'superseded')
  assert.equal(oldEntry73.brief, '旧委托书内容',
    'the old goal keeps ITS brief — a revision must not rewrite frozen history')
  const newEntry73 = saved73.goals.find((g) => g.goalId === r.goalId)
  assert.equal(newEntry73.brief, newBrief, 'the successor carries the new brief')

  // A revision WITHOUT a new brief inherits the previous work order
  // (documented behavior) and reports it through workOrder.
  engine73.runs.at(-1).settle({ stopReason: 'completed', value: metRound73 })
  await new Promise((r2) => setImmediate(r2))
  await tool73.execute({ action: 'collect', goalId: r.goalId }, exec73)
  const r2 = await tool73.execute({ action: 'revise', goalId: r.goalId, reason: '仅微调标题', title: '换名任务' }, exec73)
  assert.equal(r2.workOrder?.present, true, 'inherited brief is reported as present')
  assert.equal(r2.workOrder.chars, newBrief.length)
  assert.equal(engine73.runs.at(-1).request.args.brief, newBrief, 'unspecified brief inherits the previous work order')
  console.log('✓ 73 revise brief hygiene: old goal unpolluted, successor carries/inherits brief, workOrder echoed')
}

// 74. revise warning (fix C): revising a briefless goal without supplying a
//     brief launches a briefless successor — the result must say so
//     (workOrder.present=false + warning), and the successor round must still
//     bind cleanly (no undefined brief key, fix A on the revise path).
{
  const engine74 = fakeEngine()
  const host74 = fakeHost(engine74, { sessionId: 'sess-test-74' })
  host74.ctx.workingDirectory = { get: () => root }
  apply(host74.ctx, {})
  const tool74 = host74.tools[0]
  const exec74 = { agent: host74.parent, signal: undefined }

  const a = await tool74.execute({ action: 'start', title: '无委托书旧任务' }, exec74)
  const r = await tool74.execute({ action: 'revise', goalId: a.goalId, reason: '修正但忘了带委托书' }, exec74)
  assert.equal(r.workOrder?.present, false, 'no brief anywhere: workOrder reports absent')
  assert.match(r.warning ?? '', /没有工作委托书/, 'the briefless successor is flagged')
  assert.equal(Object.hasOwn(engine74.runs.at(-1).request.args, 'brief'), false,
    'the successor round still binds cleanly (no own `brief` key)')
  console.log('✓ 74 revise warning: briefless lineage → workOrder.present=false + warning + clean args')
}

console.log('\nALL 75 CHECKS PASSED')
