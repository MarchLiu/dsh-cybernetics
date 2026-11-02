// Offline harness test for dsh-cybernetics v0.3: exercises every tool action
// (list / round / start / collect / cancel) against a fake host ctx and a
// controllable fake workflow engine — no DSH runtime required.
// Run: node test/v03-offline.mjs

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'

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

console.log('\nALL 16 CHECKS PASSED')
