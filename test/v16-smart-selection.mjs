// v0.16 offline tests: smart agent model selection (smartAgentModelSelection).
//
// Feature under test (user ruling 2026-11-06): a volatile boolean toggle; when
// on, every round start classifies the work order (brief/subgoal/objective)
// and fills the role rows that carry NO explicit provider/model from the
// host's LIVE model catalog — trivial work on light models, hard work on the
// top tier, writing on a model advertising writing strength; explicit role
// config always wins; any failure (catalog unavailable, nothing suitable)
// keeps the session-agent inheritance and records WHY in the round audit
// (`smartSelection` on the round record, same observability seam as v0.8
// fallbacks). Persistent teammates (spawnTeammate) reject model overrides, so
// the task row is skipped with an explicit audit reason.
//
// Layers pinned here, all offline:
//   (1) classification rules + precedence (src/modelSelection.ts);
//   (2) capability tiering (generic signals, session route = ceiling);
//   (3) per-class desired picks (trivial/writing/hard/standard);
//   (4) merge priority: explicit provider/model > effort-only pin > smart;
//       named task roles; quick depth = task row only; persistent = task skip;
//   (5) fallbacks: empty catalog, no-lighter-model, same-route pick;
//   (6) host probes: ctx.llm soft read (isolated provider failure, missing
//       service, throwing transport) + session route resolution;
//   (7) threading: controller.startRound args, workflows/round.js echo (all
//       four result shapes), executor quick/full paths;
//   (8) plugin end-to-end on the fake host: feature off = byte-identical
//       legacy args; on = merged roles + audit; revise classifies the
//       SUCCESSOR's brief; round audit file carries the trail;
//   (9) settings card: boolean toggle renders, zh/en locale keys complete,
//       write path hits the volatile field.
import assert from 'node:assert/strict'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/index.ts'
import { startRound } from '../src/controller.ts'
import { computeSmartSelection, classifyTaskText, modelTier, picksForClass, probeCatalogOptions, sessionRouteOf } from '../src/modelSelection.ts'
import { startTeamRound } from '../src/executor.ts'

// --- fixtures -----------------------------------------------------------------

/** A catalog shaped like the host's live directory (generic tiers, no real names). */
const CATALOG = [
  { provider: 'p-light', model: 'qwen-8b', name: 'Qwen 8B', description: 'compact local model' },
  { provider: 'p-light', model: 'glm-4-flash', name: 'GLM 4 Flash' },
  { provider: 'p-mid', model: 'mid-30b', name: 'Mid 30B' },
  { provider: 'p-top', model: 'ultra-72b', name: 'Ultra 72B', description: 'flagship reasoning model' },
  { provider: 'p-top', model: 'writer-pro', name: 'Writer Pro', description: 'writing, docs and reports' },
]
const SESSION = { provider: 'p-top', model: 'session-flagship' }

// (1) classification ------------------------------------------------------------
{
  assert.equal(classifyTaskText('删除 src/old.p 文件并验证文件不存在'), 'trivial')
  assert.equal(classifyTaskText('Delete the build directory, then confirm the file is missing'), 'trivial')
  assert.equal(classifyTaskText('git commit 并 push 到远程仓库'), 'trivial')
  assert.equal(classifyTaskText('修复 README 里的一个 typo'), 'trivial')
  assert.equal(classifyTaskText('重命名 config.js 为 config.ts'), 'trivial')
  assert.equal(classifyTaskText('为新的 API 写一份文档并润色'), 'writing')
  assert.equal(classifyTaskText('Write the changelog and a short report for this release'), 'writing')
  assert.equal(classifyTaskText('把这篇周报翻译成英文'), 'writing')
  assert.equal(classifyTaskText('用 Rust 实现一个并发运行时并验证正确性'), 'hard')
  assert.equal(classifyTaskText('证明一个非平凡的数学命题'), 'hard')
  assert.equal(classifyTaskText('实现一个支持 lock-free 队列的调度器'), 'hard')
  assert.equal(classifyTaskText('Haskell 写一个类型检查器'), 'hard')
  assert.equal(classifyTaskText('从零实现一个编译器前端'), 'hard')
  assert.equal(classifyTaskText('调查 dsh-goal 服务的启动流程并写调查报告'), 'standard',
    'hard/writing precedence: plain investigation+report stays standard when no strong signal hits')
  assert.equal(classifyTaskText('统计这个 CSV 的季度销售额'), 'standard')
  assert.equal(classifyTaskText(''), 'standard', 'empty input → standard (inherit)')
  assert.equal(classifyTaskText(undefined), 'standard', 'non-string input → standard, never throws')
  console.log('✓ v16 (1) classification rules: trivial/writing/hard/standard + precedence + guards')
}

// (2) tiering ---------------------------------------------------------------------
{
  assert.equal(modelTier({ provider: 'x', model: 'qwen2.5:7b' }, SESSION), 'light')
  assert.equal(modelTier({ provider: 'x', model: 'llama-3.3-70b' }, SESSION), 'high')
  assert.equal(modelTier({ provider: 'x', model: 'qwen3-32b' }, SESSION), 'mid')
  assert.equal(modelTier({ provider: 'x', model: 'glm-4-flash' }, SESSION), 'light')
  assert.equal(modelTier({ provider: 'x', model: 'deepseek-reasoner' }, SESSION), 'high')
  assert.equal(modelTier({ provider: 'x', model: 'mystery-model' }, SESSION), 'mid', 'no signals → mid (never a pick target)')
  assert.equal(modelTier({ provider: SESSION.provider, model: SESSION.model }, SESSION), 'high',
    'the session route is the reference ceiling')
  assert.equal(modelTier({ provider: 'other', model: SESSION.model }, SESSION), 'high',
    'bare-model session match also pins the ceiling')
  console.log('✓ v16 (2) tiering: size tokens beat name tokens, light/high/mid, session route = ceiling')
}

// (3) per-class picks -------------------------------------------------------------
{
  const picks = picksForClass('trivial', CATALOG, SESSION)
  assert.equal(picks.task?.model, 'qwen-8b', 'trivial task → first light model')
  assert.equal(picks.verify?.model, 'qwen-8b', 'trivial verify → light (file-exists checks)')
  assert.equal(picks.triage?.model, 'qwen-8b', 'trivial triage → light')
  const hard = picksForClass('hard', CATALOG, SESSION)
  assert.equal(hard.task?.model, 'ultra-72b', 'hard task → top tier')
  assert.equal(hard.verify?.model, 'ultra-72b', 'hard verify → top tier')
  assert.equal(hard.triage?.model, 'qwen-8b', 'hard triage still light (bucketing)')
  const writing = picksForClass('writing', CATALOG, SESSION)
  assert.equal(writing.task?.model, 'writer-pro', 'writing task → the writing-advertised model')
  assert.equal(writing.verify, undefined, 'writing verify inherits (session model = strongest reviewer)')
  assert.equal(writing.triage?.model, 'qwen-8b')
  assert.deepEqual(picksForClass('standard', CATALOG, SESSION), {}, 'standard decides nothing (inherit)')
  assert.deepEqual(picksForClass('trivial', [], SESSION), {}, 'empty catalog → no picks')
  console.log('✓ v16 (3) per-class picks: trivial→light×3, hard→top task+verify + light triage, writing→writer + inherit verify')
}

// (4) merge priority ----------------------------------------------------------------
{
  // Explicit provider/model row wins on its role only.
  {
    const out = computeSmartSelection({
      text: '删除 build 目录并验证文件不存在', depth: 'full', executor: 'ephemeral',
      taskRoleKey: 'default', explicit: { default: { provider: 'p-x', model: 'explicit-task' } },
      options: CATALOG, session: SESSION,
    })
    const byRole = Object.fromEntries(out.audit.roles.map((r) => [r.role, r]))
    assert.equal(byRole.default.decision, 'kept-explicit', 'explicit task model outranks smart selection')
    assert.equal(byRole.verify.decision, 'selected')
    assert.equal(byRole.triage.decision, 'selected')
    assert.equal(out.overrides.default, undefined, 'no override merged for the explicit row')
    assert.equal(out.overrides.verify?.model, 'qwen-8b')
    console.log('✓ v16 (4a) explicit provider/model row wins; smart fills only unconfigured roles')
  }
  // Effort-only row stays on its inherited route.
  {
    const out = computeSmartSelection({
      text: '删除 build 目录', depth: 'full', executor: 'ephemeral',
      taskRoleKey: 'default', explicit: { default: { reasoningEffort: 'high' } },
      options: CATALOG, session: SESSION,
    })
    const byRole = Object.fromEntries(out.audit.roles.map((r) => [r.role, r]))
    assert.equal(byRole.default.decision, 'kept-inherit', 'effort-only pin is not re-routed')
    assert.match(byRole.default.reason, /思考强度/)
    assert.equal(out.overrides.default, undefined)
    console.log('✓ v16 (4b) effort-only row kept on the inherited route (pinned effort would mismatch)')
  }
  // Named task roles decide the row the task agent actually reads.
  {
    const out = computeSmartSelection({
      text: 'git commit 并 push', depth: 'full', executor: 'ephemeral',
      taskRoleKey: 'frontend', explicit: { frontend: { provider: 'p-x', model: 'explicit-frontend' } },
      options: CATALOG, session: SESSION,
    })
    const roles = out.audit.roles.map((r) => r.role)
    assert.deepEqual(roles, ['frontend', 'verify', 'triage'], 'named task role row decided')
    assert.equal(out.audit.roles[0].decision, 'kept-explicit')
    console.log('✓ v16 (4c) named task role: the frontend row is the decided task row')
  }
  // Session-route-only catalog: pickers exclude the session route itself
  // (inheriting achieves the identical route AND preserves the inherited
  // effort), so hard keeps inheriting with the explicit ceiling reason.
  {
    const options = [{ provider: 'p-light', model: 'qwen-8b' }, { provider: SESSION.provider, model: SESSION.model }]
    const hard = picksForClass('hard', options, SESSION)
    assert.equal(hard.task, undefined, 'no independent top-tier model → no pick (inherit = ceiling)')
    assert.equal(hard.triage?.model, 'qwen-8b', 'triage still gets the light model')
    const out = computeSmartSelection({
      text: '证明一个非平凡的数学命题', depth: 'full', executor: 'ephemeral',
      taskRoleKey: 'default', explicit: {}, options, session: SESSION,
    })
    const byRole = Object.fromEntries(out.audit.roles.map((r) => [r.role, r]))
    assert.equal(byRole.default.decision, 'kept-inherit')
    assert.match(byRole.default.reason, /顶配参照/, 'the ceiling reason names the session route as the reference')
    assert.equal(byRole.verify.decision, 'kept-inherit')
    assert.equal(byRole.triage.decision, 'selected', 'triage still selected')
    console.log('✓ v16 (4d) session-route-only top tier: stand down with the ceiling reason; triage still selected')
  }
}

// (5) fallbacks ----------------------------------------------------------------------
{
  // Empty catalog: unavailable + everything inherits.
  {
    const out = computeSmartSelection({
      text: '删除 build 目录', depth: 'full', executor: 'ephemeral',
      taskRoleKey: 'default', explicit: {}, options: [], session: SESSION,
    })
    assert.equal(out.audit.catalogStatus, 'unavailable')
    assert.ok(out.audit.roles.length === 3, 'all decided roles recorded')
    assert.ok(out.audit.roles.every((r) => r.decision === 'kept-inherit'))
    assert.deepEqual(out.overrides, {})
    console.log('✓ v16 (5a) empty catalog → catalogStatus unavailable + full kept-inherit audit')
  }
  // No lighter model than the session route: trivial keeps inheriting with a reason.
  {
    const out = computeSmartSelection({
      text: '删除 build 目录', depth: 'full', executor: 'ephemeral',
      taskRoleKey: 'default', explicit: {}, options: [CATALOG[3]], session: SESSION,
    })
    assert.ok(out.audit.roles.every((r) => r.decision === 'kept-inherit'), 'no light model → keep inherit')
    assert.match(out.audit.roles[0].reason, /更轻/)
    console.log('✓ v16 (5b) no lighter model in the catalog → kept-inherit with the reason recorded')
  }
  // Non-array options / weird text never throw.
  {
    const out = computeSmartSelection({
      text: 42, depth: 'quick', executor: 'ephemeral', taskRoleKey: 'default',
      explicit: {}, options: 42, session: SESSION,
    })
    assert.equal(out.audit.taskClass, 'standard')
    assert.equal(out.audit.catalogSize, 0)
    assert.equal(out.audit.catalogStatus, 'unavailable')
    console.log('✓ v16 (5c) malformed inputs degrade to inherit, never throw')
  }
}

// (6) audit shape + quick/persistent semantics ----------------------------------------
{
  const text = '删除 build 目录并验证文件不存在\n第二轮：清理产物'
  const out = computeSmartSelection({
    text, depth: 'full', executor: 'ephemeral', taskRoleKey: 'default',
    explicit: {}, options: CATALOG, session: SESSION,
  })
  assert.equal(out.audit.enabled, true)
  assert.equal(out.audit.taskClass, 'trivial')
  assert.equal(out.audit.inputChars, text.length)
  assert.equal(out.audit.inputPreview, '删除 build 目录并验证文件不存在 第二轮：清理产物', 'newlines flattened in the preview')
  assert.equal(out.audit.catalogSize, CATALOG.length)
  assert.equal(out.audit.catalogStatus, 'ok')
  assert.deepEqual(out.audit.roles.map((r) => r.role), ['default', 'verify', 'triage'])
  assert.ok(out.audit.roles.every((r) => typeof r.reason === 'string' && r.reason.length > 0))
  assert.deepEqual(out.audit.roles[0].picked, { provider: 'p-light', model: 'qwen-8b' })

  const quick = computeSmartSelection({
    text, depth: 'quick', executor: 'ephemeral', taskRoleKey: 'default',
    explicit: {}, options: CATALOG, session: SESSION,
  })
  assert.deepEqual(quick.audit.roles.map((r) => r.role), ['default'], 'quick depth: task row only')

  const persistentFull = computeSmartSelection({
    text: '证明一个非平凡的数学命题', depth: 'full', executor: 'persistent', taskRoleKey: 'default',
    explicit: {}, options: CATALOG, session: SESSION,
  })
  const byRole = Object.fromEntries(persistentFull.audit.roles.map((r) => [r.role, r]))
  assert.equal(byRole.default.decision, 'skipped', 'persistent task teammate: explicit skip')
  assert.match(byRole.default.reason, /spawnTeammate/)
  assert.equal(byRole.verify.decision, 'selected', 'persistent full: verify still ephemeral + selected')
  assert.equal(byRole.verify.picked?.model, 'ultra-72b')
  assert.equal(byRole.triage.decision, 'selected')

  const persistentQuick = computeSmartSelection({
    text, depth: 'quick', executor: 'persistent', taskRoleKey: 'default',
    explicit: {}, options: CATALOG, session: SESSION,
  })
  assert.deepEqual(persistentQuick.audit.roles.map((r) => [r.role, r.decision]), [['default', 'skipped']],
    'persistent quick: only the skipped task row, no phantom verify/triage')
  console.log('✓ v16 (6) audit shape; quick = task-only; persistent = task skipped with reason')
}

// (7) host probes ----------------------------------------------------------------------
{
  const llm = {
    listProviders: () => [{ id: 'p-a', name: 'A' }, { id: 'p-bad', name: 'Broken' }, { id: 'p-b', name: 'B' }],
    listModels: async (pid) => {
      if (pid === 'p-bad') throw new Error('adapter offline')
      if (pid === 'p-a') return [{ provider: pid, id: 'm-1', name: 'M1' }, { provider: pid, id: 'm-2', name: 'M2', description: 'd' }]
      return []
    },
  }
  const good = await probeCatalogOptions({ llm })
  assert.equal(good.ok, true)
  assert.deepEqual(good.options.map((o) => `${o.provider}/${o.model}`), ['p-a/m-1', 'p-a/m-2'], 'provider failure isolated, rest collected')
  const missing = await probeCatalogOptions({})
  assert.deepEqual(missing, { options: [], ok: false }, 'no llm service → nothing to pick from')
  const throwing = await probeCatalogOptions({ llm: { listProviders: () => { throw new Error('boom') }, listModels: () => [] } })
  assert.deepEqual(throwing, { options: [], ok: false })
  const malformed = await probeCatalogOptions({ llm: { listProviders: () => 'nope', listModels: () => [] } })
  assert.deepEqual(malformed, { options: [], ok: false })
  // Cordis-style throwing property read must degrade silently.
  const proxyCtx = new Proxy({}, { get() { throw new Error('cannot get property "llm" without inject') } })
  const guarded = await probeCatalogOptions(proxyCtx)
  assert.deepEqual(guarded, { options: [], ok: false })

  const parentWithHeader = { session: { requestHeader: () => ({ config: { provider: 'p-top', model: 'session-flagship' } }) }, options: { provider: 'old', model: 'stale' } }
  assert.deepEqual(sessionRouteOf(parentWithHeader), SESSION, 'request header wins (latest selection)')
  assert.deepEqual(sessionRouteOf({ session: {}, options: { provider: 'p-top', model: 'session-flagship' } }), SESSION, 'options fallback')
  assert.deepEqual(sessionRouteOf({}), {}, 'absent seams → empty route')
  console.log('✓ v16 (7) host probes: isolated provider failure, missing/throwing service, session route resolution')
}

// (8) controller.startRound + workflows/round.js + executor threading -------------------
{
  // startRound carries the audit + merged roles into the workflow args; off = key absent.
  const engineReq = []
  const fakeEngine = { start(request) { engineReq.push(request); return { result: new Promise(() => {}), async dispose() {} } } }
  const state = { goalId: 'g', round: 0, doneSummary: '', subgoal: 'S', role: 'default' }
  const scriptPath = fileURLToPath(new URL('../workflows/round.js', import.meta.url))
  await startRound(fakeEngine, {}, '/tmp', state, {
    roundScriptPath: scriptPath,
    roles: { default: { provider: 'p-light', model: 'qwen-8b' }, verify: { provider: 'p-light', model: 'qwen-8b' }, triage: { provider: 'p-light', model: 'qwen-8b' } },
    smartSelection: { enabled: true, taskClass: 'trivial', inputChars: 10, inputPreview: 'x', catalogSize: 5, catalogStatus: 'ok', roles: [] },
  }, { objective: 'O' })
  assert.equal(engineReq[0].args.smartSelection.taskClass, 'trivial', 'startRound passes the audit into workflow args')
  assert.equal(engineReq[0].args.roles.default.model, 'qwen-8b')
  await startRound(fakeEngine, {}, '/tmp', state, { roundScriptPath: scriptPath, roles: {} }, { objective: 'O' })
  assert.equal('smartSelection' in engineReq[1].args, false, 'feature off → no smartSelection key (binder rejects undefined)')
  console.log('✓ v16 (8a) controller.startRound threads smartSelection + merged roles into args (absent when off)')
}
{
  const code = await readFile(new URL('../workflows/round.js', import.meta.url), 'utf8')
  const audit = { enabled: true, taskClass: 'trivial', inputChars: 3, inputPreview: 'B', catalogSize: 2, catalogStatus: 'ok', roles: [{ role: 'default', decision: 'selected', reason: 'r' }] }
  const run = async (args) => {
    const calls = []
    const agent = async (_p, opts) => {
      calls.push(opts?.label ?? '?')
      if (calls.length === 1) return { summary: 's', done: true, artifacts: [], evidence: 'e', nextStepThoughts: [] }
      if (calls.length === 2) return { met: true, criteria: [], gaps: [], goalItselfQuestionable: false }
      return { auto: [], defer: [], reject: [], human: [] }
    }
    const fn = new (async function () {}.constructor)('agent', 'phase', 'args', 'log', code)
    return { out: await fn(agent, async () => {}, args, () => {}), calls }
  }
  const quickOn = await run({ goal: { objective: 'O' }, state: { round: 1, doneSummary: '' }, subgoal: 'S', brief: 'B', depth: 'quick', roles: {}, smartSelection: audit })
  assert.equal(quickOn.out.smartSelection.taskClass, 'trivial', 'quick result echoes the audit')
  const quickOff = await run({ goal: { objective: 'O' }, state: { round: 1, doneSummary: '' }, subgoal: 'S', brief: 'B', depth: 'quick', roles: {} })
  assert.equal('smartSelection' in quickOff.out, false, 'no audit in args → no audit in the result')
  const fullOn = await run({ goal: { objective: 'O' }, state: { round: 1, doneSummary: '' }, subgoal: 'S', brief: 'B', roles: {}, smartSelection: audit })
  assert.equal(fullOn.out.smartSelection.enabled, true, 'full result echoes the audit')
  const reportOn = await run({
    goal: { objective: 'O' }, state: { round: 1, doneSummary: '' }, subgoal: 'S', brief: 'B', roles: {}, smartSelection: audit,
    taskReport: { summary: 'from teammate', done: true, artifacts: [], evidence: 'e', nextStepThoughts: [] },
  })
  assert.deepEqual(reportOn.calls, ['verify', 'triage'])
  assert.equal(reportOn.out.smartSelection.taskClass, 'trivial', 'taskReport result echoes the audit (persistent full)')
  console.log('✓ v16 (8b) round.js echoes smartSelection on quick/full/taskReport paths, absent when off')
}
{
  // executor quick path: the result carries the audit (task row inside is 'skipped').
  const handlers = []
  const spawned = []
  const ctx = {
    agentPresets: { serviceFor: () => undefined },
    on: (event, fn) => { if (event === 'subagent/end') handlers.push(fn); return () => {} },
    agentTeams: {
      spawnTeammate: async (_c, req) => { spawned.push(req); return { member: { id: 'child-x', name: req.name, status: 'running' } } },
      sendMessage: async () => ({}), interrupt: () => ({}), listMembers: () => [{ id: 'child-x', name: 'cyb-x', status: 'inactive' }],
    },
  }
  const audit = { enabled: true, taskClass: 'trivial', inputChars: 3, inputPreview: 'B', catalogSize: 2, catalogStatus: 'ok', roles: [{ role: 'default', decision: 'skipped', reason: 'persistent teammate takes no overrides' }] }
  const state = { goalId: 'cyb-x', objective: 'O', round: 0, doneSummary: '', subgoal: 'S', brief: 'B', depth: 'quick' }
  const handle = await startTeamRound(ctx, { session: { id: 's' } }, state, { roundScriptPath: '/tmp/round.js', roles: {}, smartSelection: audit })
  for (const h of handlers) h({ id: 'child-x', lastAssistantMessage: [{ type: 'text', text: 'ok {"done": true, "summary": "s", "evidence": "e"}' }] })
  const settled = await handle.result
  assert.equal(settled.value.smartSelection.roles[0].decision, 'skipped', 'persistent quick result carries the audit')
  console.log('✓ v16 (8c) executor quick path carries smartSelection into the round record')
}
{
  // executor FULL path: the audit rides the round.js args handed the teammate's
  // report (verify/triage decisions in the audit are live there, the task row
  // inside is 'skipped').
  const realRoundScript = fileURLToPath(new URL('../workflows/round.js', import.meta.url))
  const handlers2 = []
  const runs = []
  const engine = { start(request) { let settle; const result = new Promise((r) => { settle = r }); const run = { request, result, settle, cancel() {}, async dispose() {} }; runs.push(run); return run } }
  const ctx2 = {
    agentPresets: { serviceFor: () => engine },
    on: (event, fn) => { if (event === 'subagent/end') handlers2.push(fn); return () => {} },
    agentTeams: {
      spawnTeammate: async (_c, req) => ({ member: { id: 'child-y', name: req.name, status: 'running' } }),
      sendMessage: async () => ({}), interrupt: () => ({}), listMembers: () => [{ id: 'child-y', name: 'cyb-y', status: 'inactive' }],
    },
  }
  const auditFull = { enabled: true, taskClass: 'hard', inputChars: 9, inputPreview: '证明命题', catalogSize: 2, catalogStatus: 'ok', roles: [{ role: 'default', decision: 'skipped', reason: 'persistent teammate takes no overrides' }, { role: 'verify', decision: 'selected', reason: 'hard verify', picked: { provider: 'p-top', model: 'ultra-72b' } }] }
  const state2 = { goalId: 'cyb-y', objective: 'O', round: 0, doneSummary: '', subgoal: 'S', brief: 'B', depth: 'full' }
  const handle2 = await startTeamRound(ctx2, { session: { id: 's2' } }, state2, { roundScriptPath: realRoundScript, roles: {}, smartSelection: auditFull })
  for (const h of handlers2) h({ id: 'child-y', lastAssistantMessage: [{ type: 'text', text: 'ok {"done": true, "summary": "s", "evidence": "e"}' }] })
  for (let i = 0; i < 200 && runs.length === 0; i++) await new Promise((r) => setImmediate(r))
  assert.equal(runs.length, 1, 'verify/triage workflow run started from the teammate report')
  const req = runs[0].request
  assert.equal(req.args.taskReport.summary, 's', 'full path hands the report to round.js')
  assert.equal(req.args.smartSelection.taskClass, 'hard', 'full path round.js args carry the audit')
  assert.deepEqual(req.args.smartSelection.roles[1].picked, { provider: 'p-top', model: 'ultra-72b' }, 'verify row decision rides along')
  runs[0].settle({
    stopReason: 'completed',
    value: { round: 1, report: { summary: 's', done: true, artifacts: [], evidence: 'e', nextStepThoughts: [] }, verdict: { met: true, criteria: [], gaps: [], goalItselfQuestionable: false }, triage: { auto: [], defer: [], reject: [], human: [] } },
  })
  const settled2 = await handle2.result
  assert.equal(settled2.stopReason, 'completed')
  console.log('✓ v16 (8d) executor full path: round.js args carry smartSelection alongside taskReport')
}

// (9) plugin end-to-end on the fake host --------------------------------------------
function fakeEngine() {
  const runs = []
  return {
    runs,
    start(request) {
      let settle
      const result = new Promise((resolve) => { settle = resolve })
      const run = {
        request, result, disposed: false, settle(value) { settle(value) },
        cancel(reason) { run.cancelled = true; settle({ stopReason: 'cancelled', error: reason }) },
        async dispose() { run.disposed = true },
      }
      runs.push(run)
      return run
    },
  }
}

/** A fake `ctx.llm` in the HOST's wire shape (listModels entries keyed `id`). */
function hostCatalogMock() {
  return {
    listProviders: () => [{ id: 'p-light', name: 'Light' }, { id: 'p-top', name: 'Top' }],
    listModels: async (pid) => pid === 'p-light'
      ? [{ provider: pid, id: 'qwen-8b', name: 'Qwen 8B', description: 'compact local model' }]
      : [{ provider: pid, id: 'ultra-72b', name: 'Ultra 72B', description: 'flagship reasoning model' }],
  }
}

/** Same wire shape, one provider, light model only. */
function hostCatalogLightOnly() {
  return {
    listProviders: () => [{ id: 'p-light', name: 'Light' }],
    listModels: async (pid) => [{ provider: pid, id: 'qwen-8b', name: 'Qwen 8B', description: 'compact local model' }],
  }
}

async function makeHost({ llm, config = {}, brief, title = '任务' } = {}) {
  const tools = []
  const engine = fakeEngine()
  const parent = { session: { id: `sess-v16-${Math.random().toString(36).slice(2, 8)}` }, followup() {} }
  const root = await mkdtemp(join(tmpdir(), 'cyb-v16-'))
  const ctx = {
    tools: { register: (d) => { tools.push(d); return () => {} } },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null, create: () => ({ id: 'goal-focused' }) },
    workingDirectory: { get: () => root },
    agentPresets: { serviceFor: (_a, n) => (n === 'workflowEngine' ? engine : undefined) },
    agents: { roots: () => [] },
    sessionProjections: { register: () => () => {} },
    on: () => () => {},
    ...(llm !== undefined ? { llm } : {}),
  }
  apply(ctx, config)
  const tool = tools[0]
  const out = await tool.execute({ action: 'start', title, brief }, { agent: parent, signal: undefined })
  return { engine, tool, parent, root, goalId: out.goalId, out }
}

const liveRef = (value) => ({ get: () => value })

{
  // Feature OFF: legacy behavior byte-for-byte (no roles merge, no audit key).
  const { engine } = await makeHost({ llm: { listProviders: () => [], listModels: () => [] }, brief: '删除 build 目录' })
  assert.equal('smartSelection' in engine.runs[0].request.args, false)
  assert.deepEqual(engine.runs[0].request.args.roles, {})
  console.log('✓ v16 (9a) toggle off: args identical to legacy (no smartSelection key, roles untouched)')
}
{
  // Feature ON, trivial brief: roles filled with light models + audit attached.
  const llm = hostCatalogMock()
  const { engine } = await makeHost({ llm, config: { smartAgentModelSelection: true }, brief: '删除 build 目录并验证文件不存在' })
  const args = engine.runs[0].request.args
  assert.equal(args.roles.default?.model, 'qwen-8b', 'task row auto-picked (light)')
  assert.equal(args.roles.verify?.model, 'qwen-8b', 'verify row auto-picked (light)')
  assert.equal(args.roles.triage?.model, 'qwen-8b', 'triage row auto-picked (light)')
  assert.equal(args.smartSelection.enabled, true)
  assert.equal(args.smartSelection.taskClass, 'trivial')
  assert.equal(args.smartSelection.catalogSize, 2)
  assert.equal(args.smartSelection.roles[0].decision, 'selected')
  console.log('✓ v16 (9b) trivial round: task/verify/triage auto-assigned the light model + audit in args')
}
{
  // Feature ON, hard brief: top-tier task+verify; explicit config outranks.
  const { engine } = await makeHost({ llm: hostCatalogMock(), config: { smartAgentModelSelection: true }, brief: '用 Rust 实现一个并发运行时并验证正确性' })
  const args = engine.runs[0].request.args
  assert.equal(args.roles.default?.model, 'ultra-72b', 'hard task → top tier')
  assert.equal(args.roles.verify?.model, 'ultra-72b', 'hard verify → top tier')
  assert.equal(args.roles.triage?.model, 'qwen-8b', 'hard triage → light')
  console.log('✓ v16 (9c) hard round: task/verify on the top tier, triage light')
}
{
  // Explicit flat-field config + smart ON: explicit rows win, audit says so.
  const llm = hostCatalogLightOnly()
  const { engine } = await makeHost({
    llm, config: { smartAgentModelSelection: true, taskAgentModel: 'p-explicit/explicit-model' },
    brief: 'git commit 并 push 到远程',
  })
  const args = engine.runs[0].request.args
  assert.equal(args.roles.default?.model, 'explicit-model', 'explicit task model survives smart selection')
  assert.equal(args.roles.verify?.model, 'qwen-8b', 'unconfigured verify row still auto-picked')
  const taskRow = args.smartSelection.roles.find((r) => r.role === 'default')
  assert.equal(taskRow.decision, 'kept-explicit')
  assert.match(taskRow.reason, /显式配置优先/)
  console.log('✓ v16 (9d) explicit flat field outranks smart selection; audit records kept-explicit')
}
{
  // Live volatile reference (the settings-card write shape): toggling true governs the next launch.
  const llm = hostCatalogLightOnly()
  const { engine } = await makeHost({ llm, config: { smartAgentModelSelection: liveRef(true) }, brief: '删除 build 目录' })
  assert.equal(engine.runs[0].request.args.roles.default?.model, 'qwen-8b', 'volatile live ref unwrapped per launch')
  console.log('✓ v16 (9e) volatile live reference (panel write) takes effect on the next launch')
}
{
  // No ctx.llm (offline harness shape): silent fallback + audit recorded, round proceeds.
  const { engine } = await makeHost({ config: { smartAgentModelSelection: true }, brief: '删除 build 目录' })
  const args = engine.runs[0].request.args
  assert.deepEqual(args.roles, {}, 'no catalog → no overrides merged')
  assert.equal(args.smartSelection.catalogStatus, 'unavailable')
  assert.ok(args.smartSelection.roles.every((r) => r.decision === 'kept-inherit'))
  console.log('✓ v16 (9f) missing llm service → silent inherit fallback + unavailable audit, round not blocked')
}
{
  // revise: the audit classifies the SUCCESSOR's brief, not the old goal's.
  const llm = hostCatalogMock()
  const tools = []
  const engine = fakeEngine()
  const parent = { session: { id: 'sess-v16-revise' }, followup() {} }
  const root = await mkdtemp(join(tmpdir(), 'cyb-v16-'))
  const ctx = {
    tools: { register: (d) => { tools.push(d); return () => {} } },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null, create: () => ({ id: 'goal-focused' }) },
    workingDirectory: { get: () => root },
    agentPresets: { serviceFor: (_a, n) => (n === 'workflowEngine' ? engine : undefined) },
    agents: { roots: () => [] },
    sessionProjections: { register: () => () => {} },
    on: () => () => {},
    llm,
  }
  apply(ctx, { smartAgentModelSelection: true })
  const tool = tools[0]
  const exec = { agent: parent, signal: undefined }
  const first = await tool.execute({ action: 'start', title: '简单任务', brief: '删除 build 目录' }, exec)
  assert.equal(engine.runs[0].request.args.smartSelection.taskClass, 'trivial', 'round 1 classified from its own brief')
  await tool.execute({
    action: 'revise', goalId: first.goalId, reason: '目标变更为困难任务',
    objective: '用 Rust 实现一个并发运行时并验证正确性', brief: '用 Rust 实现一个并发运行时并验证正确性',
  }, exec)
  const reviseArgs = engine.runs.at(-1).request.args
  assert.equal(reviseArgs.smartSelection.taskClass, 'hard', 'revise classifies the successor brief (hard)')
  assert.equal(reviseArgs.roles.verify?.model, 'ultra-72b', 'successor round gets the hard-class picks')
  assert.notEqual(engine.runs[0].request.args.roles.verify?.model, 'ultra-72b', 'the old goal\'s launch was untouched (per-launch config)')
  console.log('✓ v16 (9g) revise: per-launch classification of the successor brief; earlier launches untouched')
}
{
  // Round audit file: foldRound persists the trail into .cybernetics/round-*.json.
  const llm = hostCatalogLightOnly()
  const { engine, tool, parent, root, goalId } = await makeHost({ llm, config: { smartAgentModelSelection: true }, brief: '删除 build 目录' })
  // round.js (see (8b)) echoes args.smartSelection into its result; simulate
  // that echo so the fold carries the trail the real script would deliver.
  const launched = engine.runs[0]
  launched.settle({
    stopReason: 'completed',
    value: {
      round: 1,
      report: { summary: 's', done: true, artifacts: [], evidence: 'e', nextStepThoughts: [] },
      verdict: { met: true, criteria: [], gaps: [], goalItselfQuestionable: false },
      triage: { auto: [], defer: [], reject: [], human: [] },
      smartSelection: launched.request.args.smartSelection,
      fallbacks: [],
    },
  })
  const collected = await tool.execute({ action: 'collect', goalId }, { agent: parent, signal: undefined })
  assert.equal(collected.decision.reason, 'met')
  const log = JSON.parse(await readFile(join(root, '.cybernetics', `round-${goalId}-1.json`), 'utf8'))
  assert.equal(log.smartSelection.taskClass, 'trivial', 'round audit file carries the smart-selection trail')
  assert.equal(log.smartSelection.roles[0].picked.model, 'qwen-8b')
  console.log('✓ v16 (9h) .cybernetics/round-<goal>-<N>.json contains the smartSelection audit (collect path)')
}

// (10) settings card -------------------------------------------------------------------
{
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded
  globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m } } }
  new Function('window', client)(globalThis.window)
  const jsx = { jsx: (type, props, key) => ({ type, props: props ?? {}, key }), jsxs: (type, props, key) => ({ type, props: props ?? {}, key }) }
  const registered = []
  const dicts = {}
  const react = {
    useSyncExternalStore: (_s, getSnapshot) => getSnapshot(),
    useState: (initial) => { const slot = { value: initial }; return [slot.value, (nv) => { slot.value = typeof nv === 'function' ? nv(slot.value) : nv }] },
  }
  const mod = loaded.factory((req) => (req === 'react' ? react : jsx))
  mod.apply({
    effect: (fn) => fn(),
    locale: {
      register: (_ns, d) => { Object.assign(dicts, d) },
      bind: () => (key, params) => {
        let text = dicts.zh?.[key] ?? key
        if (params) for (const name of Object.keys(params)) text = text.replaceAll('{' + name + '}', String(params[name]))
        return text
      },
    },
    slots: { inject: (_n, cb) => cb(), register: (spec, view) => { registered.push({ spec, view }) } },
    sessions: {}, remote: { $on: () => {} },
    configForms: { get: () => undefined, whileServed: (_ns, r) => { r(new Set()); return () => {} } },
  })
  for (const lang of ['zh', 'en']) {
    assert.equal(typeof dicts[lang]['settings.smartAgentModelSelection'], 'string', `${lang} locale has the toggle label`)
    assert.equal(typeof dicts[lang]['settings.smartAgentModelSelectionHint'], 'string', `${lang} locale has the toggle hint`)
  }
  assert.match(dicts.zh['settings.smartAgentModelSelectionHint'], /保持继承/)
  assert.match(dicts.en['settings.smartAgentModelSelectionHint'], /keeps? inheriting|keeps inheriting/)
  const order = [
    client.indexOf("field: 'hardGate'"),
    client.indexOf("field: 'smartAgentModelSelection'"),
    client.indexOf("field: 'groupTask'"),
  ]
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2],
    'card order: hardGate → smartAgentModelSelection → the per-agent groups')
  // Render: the toggle appears with role=switch and defaults off; flipping writes the volatile field.
  const seat = registered.find((e) => e.spec.name === 'plugins.item')
  const t = (key) => dicts.zh?.[key] ?? key
  const snap = { status: 'ready', writable: true, value: { allGoalsMode: false, hardGate: false, smartAgentModelSelection: false, roundsPerSubgoal: 3, maxConcurrentRounds: 0 } }
  const writes = []
  const form = {
    getSnapshot: () => snap, subscribe: () => () => {},
    set: async (field, value) => { writes.push([field, value]); return true },
    unset: async () => true, mutate: async () => true,
  }
  const flatten = (node, out = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return out
    if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
    out.push(node)
    if (node.props && node.props.children !== undefined) flatten(node.props.children, out)
    return out
  }
  const rendered = flatten(seat.view({ view: 'page', t, form }))
  const switchNode = rendered.find((n) => n.props && n.props.role === 'switch' && n.props['aria-label'] === t('settings.smartAgentModelSelection'))
  assert.ok(switchNode, 'smart-selection toggle rendered on the card')
  assert.equal(switchNode.props['aria-checked'], false, 'defaults off')
  await switchNode.props.onClick()
  assert.deepEqual(writes, [['smartAgentModelSelection', true]], 'flipping writes the volatile field (same path as allGoalsMode)')
  console.log('✓ v16 (10) settings card: toggle renders (off by default), zh/en keys complete, write path hits the volatile field')
}

console.log('✓ v16-smart-selection: all checks passed')
