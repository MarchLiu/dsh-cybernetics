// v0.21.0 offline tests: per-role effective-model audit (`agents`) in the round
// record + `models` mirror on the board snapshot / projection.
//
// Background (user ruling, §7.12.1): all 213 historical round-cyb-*.json files
// carry NO structured model/reasoningEffort fields, and the board snapshot
// (board-session-*.json) holds only {goals, savedAt, sessionId, version} — so
// "what actually ran on what" was unrecoverable for auditing. v0.21 records,
 // from the next round on, each role's EFFECTIVE LLM target:
//   - round file: `agents` = {[roleKey]: {provider?, model?, reasoningEffort?,
//     source, fallbackChain?}} written by workflows/round.js (script rows),
//     synthesized by controller.foldRound from config.roles + fallbacks when
//     the script did not supply them (old script / failed / persistent run);
//   - board mirror: `goal.models = {round, agents}` — LATEST round only
//     (lightweight; full history stays in the round files), carried through
//     the board snapshot (restoreLoop/saveBoardFile) and the projection
//     (GoalView.models / normalizeGoal).
// Honest-source semantics: the workflow runtime does not expose the child
// session's final model id, so today every row is config-derived
// (`source: 'config'`; 'observed' is reserved for a future child-log seam).
// A role that fell back (v0.8 call-level fallback) ENDS on the session model:
// its override fields are omitted and the bypassed spec is preserved in
// `fallbackChain`; a role with no override inherits the session model (fields
// omitted, no chain). Backward compat: old round files / snapshots without
// the fields must keep loading everywhere.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBoardFile, saveBoardFile } from '../src/index.ts'
import { buildAgentAudit, foldRound, mergeAgentAudit } from '../src/controller.ts'
import { cyberneticsGoalsProjection, goalsFromBoard, emptyGoalsState } from '../src/projection.ts'

const okReport = { summary: 's', done: true, artifacts: [], evidence: 'e', nextStepThoughts: [] }
const okVerdict = { met: true, criteria: [], gaps: [], goalItselfQuestionable: false }
const okTriage = { auto: [], defer: [], reject: [], human: [] }

/** Execute workflows/round.js with a mocked agent() seam (same harness as v03). */
async function driveRound(agent, args, logs = []) {
  const code = await readFile(new URL('../workflows/round.js', import.meta.url), 'utf8')
  const fn = new (async function () {}.constructor)('agent', 'phase', 'args', 'log', code)
  return fn(agent, async () => {}, args, (m) => logs.push(m))
}

const baseArgs = (extra = {}) => ({
  goal: { objective: 'O' }, state: { round: 1, doneSummary: '' },
  subgoal: 'S', brief: 'B', ...extra,
})

// 1. full depth, no overrides: agents carries all three roles, session-inherit
//    rows (no fields), source 'config'
{
  const agent = async (_p, opts) => {
    if (opts?.label === 'verify') return okVerdict
    if (opts?.label === 'triage') return okTriage
    return okReport
  }
  const out = await driveRound(agent, baseArgs({ roles: {} }))
  assert.deepEqual(Object.keys(out.agents).sort(), ['default', 'triage', 'verify'])
  assert.deepEqual(out.agents.default, { source: 'config' }, 'task role: session-inherit row')
  assert.deepEqual(out.agents.verify, { source: 'config' })
  assert.deepEqual(out.agents.triage, { source: 'config' })
  console.log('✓ 1 full depth no overrides: agents = three session-inherit config rows')
}

// 2. full depth with a task override (provider/model + effort): untouched
//    override recorded verbatim on the effective row
{
  const agent = async (_p, opts) => {
    if (opts?.label === 'verify') return okVerdict
    if (opts?.label === 'triage') return okTriage
    return okReport
  }
  const out = await driveRound(agent, baseArgs({
    roles: { default: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'high' } },
  }))
  assert.deepEqual(out.agents.default, {
    source: 'config',
    provider: 'zai-coding-cn',
    model: 'glm-5.3-flash',
    reasoningEffort: 'high',
  })
  console.log('✓ 2 override ran untouched: provider/model/reasoningEffort recorded, source config')
}

// 3. fallback (AGENT_START availability failure): the EFFECTIVE call is the
//    session model — override fields omitted, bypassed spec in fallbackChain
{
  const calls = []
  const agent = async (_p, opts) => {
    calls.push(opts?.provider ?? '(inherit)')
    if (calls.length === 1) {
      const err = new Error('agent() could not start a child: no subagent provider registered for "glm-5.3"')
      err.code = 'AGENT_START'
      throw err
    }
    if (calls.length === 2) return okReport
    if (calls.length === 3) return okVerdict
    return okTriage
  }
  const out = await driveRound(agent, baseArgs({
    roles: { default: { provider: 'glm-5.3', model: 'glm-5.3-flash', reasoningEffort: 'high' } },
  }))
  const row = out.agents.default
  assert.equal(row.source, 'config')
  assert.equal(row.provider, undefined, 'fell back → effective provider omitted')
  assert.equal(row.model, undefined, 'fell back → effective model omitted')
  assert.equal(row.reasoningEffort, undefined, 'fell back → effective effort omitted')
  assert.equal(row.fallbackChain.length, 1)
  assert.deepEqual(row.fallbackChain[0].from, { provider: 'glm-5.3', model: 'glm-5.3-flash', reasoningEffort: 'high' })
  assert.equal(row.fallbackChain[0].trigger, 'availability-error')
  assert.ok(out.fallbacks.length === 1, 'legacy fallbacks array intact')
  console.log('✓ 3 fallback: effective row ends on session model, bypassed override in fallbackChain')
}

// 4. quick depth: only the task role row exists (verify/triage never called)
{
  const out = await driveRound(async () => okReport, baseArgs({ depth: 'quick', roles: {} }))
  assert.deepEqual(Object.keys(out.agents), ['default'])
  assert.deepEqual(out.agents.default, { source: 'config' })
  console.log('✓ 4 quick depth: agents carries only the task row')
}

// 5. buildAgentAudit (controller synthesis): config rows + fallback-derived
//    effective rows; named task role keys honored
{
  const config = { roles: { coder: { provider: 'p1', model: 'm1' }, verify: { model: 'v1', reasoningEffort: 'low' } } }
  const audit = buildAgentAudit(config, { role: 'coder' }, [
    { role: 'coder', from: { provider: 'p1', model: 'm1' }, trigger: 'null-result', reason: 'r' },
  ])
  assert.deepEqual(audit.coder, {
    source: 'config',
    fallbackChain: [{ from: { provider: 'p1', model: 'm1' }, trigger: 'null-result', reason: 'r' }],
  }, 'coder fell back: fields omitted, chain kept')
  assert.deepEqual(audit.verify, { source: 'config', model: 'v1', reasoningEffort: 'low' })
  assert.deepEqual(audit.triage, { source: 'config' })
  console.log('✓ 5 buildAgentAudit: config synthesis + fallback effective semantics')
}

// 6. mergeAgentAudit: script rows win; corrupt rows (no valid source) dropped;
//    missing roles filled from synthesis
{
  const config = { roles: { default: { model: 'm0' } } }
  const merged = mergeAgentAudit(config, { role: 'default' }, {
    agents: {
      default: { source: 'observed', model: 'real-model' },
      bogus: { model: 'x' }, // no valid source → dropped
    },
    fallbacks: [{ role: 'verify', from: { model: 'v1' }, trigger: 'availability-error', reason: 'r' }],
  })
  assert.deepEqual(merged.default, { source: 'observed', model: 'real-model' }, 'script row wins')
  assert.equal(merged.bogus, undefined, 'corrupt row dropped')
  assert.equal(merged.verify.fallbackChain.length, 1, 'missing role synthesized from fallbacks')
  console.log('✓ 6 mergeAgentAudit: script wins, corrupt dropped, gaps synthesized')
}

// 7. foldRound: round FILE on disk carries `agents`; the returned (logged)
//    result carries the same audit even for a failed run (synthesis path)
{
  const root = await mkdtemp(join(tmpdir(), 'cyb-v22-'))
  const state = { goalId: 'g-1', round: 0, doneSummary: '', subgoal: 'S', role: 'coder' }
  const config = { roundScriptPath: '/nonexistent', roles: { coder: { provider: 'p', model: 'm' } } }
  const settled = {
    stopReason: 'completed',
    value: { round: 1, report: okReport, verdict: okVerdict, triage: okTriage, fallbacks: [] },
  }
  const { result } = await foldRound(root, 1, settled, state, config)
  assert.deepEqual(result.agents.coder, { source: 'config', provider: 'p', model: 'm' })
  assert.deepEqual(result.agents.verify, { source: 'config' })
  const text = await readFile(join(root, '.cybernetics', 'round-g-1-1.json'), 'utf8')
  const onDisk = JSON.parse(text)
  assert.deepEqual(onDisk.agents.coder, { source: 'config', provider: 'p', model: 'm' })
  assert.equal(onDisk.round, 1)

  // failed run: script supplied nothing → synthesis still fills the audit
  const failed = await foldRound(root, 2, { stopReason: 'error', error: 'boom' }, state, config)
  assert.deepEqual(failed.result.agents.coder, { source: 'config', provider: 'p', model: 'm' })
  const onDisk2 = JSON.parse(await readFile(join(root, '.cybernetics', 'round-g-1-2.json'), 'utf8'))
  assert.equal(onDisk2.failed !== undefined, true)
  assert.ok(onDisk2.agents && onDisk2.agents.triage, 'failed round still audited')
  console.log('✓ 7 foldRound: round file + returned result carry agents (success AND failed runs)')
}

// 8. board snapshot round-trip: loop.models survives saveBoardFile/loadBoardFile
{
  const root = await mkdtemp(join(tmpdir(), 'cyb-v22-'))
  const loop = {
    goalId: 'g-1', round: 2, doneSummary: '', subgoal: 'S', role: 'default',
    models: {
      round: 2,
      agents: {
        default: { source: 'config', provider: 'p', model: 'm', reasoningEffort: 'high' },
        verify: { source: 'config', fallbackChain: [{ from: { model: 'v1' }, trigger: 'null-result', reason: 'r' }] },
        triage: { source: 'config' },
      },
    },
  }
  const file = await saveBoardFile(root, 'sess-1', [loop])
  assert.ok(file, 'snapshot written')
  const restored = await loadBoardFile(root, 'sess-1')
  assert.equal(restored.length, 1)
  assert.deepEqual(restored[0].models, loop.models, 'models mirror round-trips verbatim')
  console.log('✓ 8 board snapshot: models mirror survives save/load round-trip')
}

// 9. backward compat: a PRE-v0.21 snapshot (no models field, version 1) still
//    loads; a snapshot with a malformed mirror degrades to no mirror, not a
//    dead board
{
  const root = await mkdtemp(join(tmpdir(), 'cyb-v22-'))
  await mkdir(join(root, '.cybernetics'), { recursive: true })
  const legacy = {
    version: 1, sessionId: 'old', savedAt: 1,
    goals: [{ goalId: 'g-1', round: 3, doneSummary: '', subgoal: 'S', role: 'default' }],
  }
  await writeFile(join(root, '.cybernetics', 'board-old.json'), JSON.stringify(legacy))
  const restored = await loadBoardFile(root, 'old')
  assert.equal(restored.length, 1)
  assert.equal(restored[0].models, undefined, 'old snapshot: models absent, loads fine')

  await writeFile(join(root, '.cybernetics', 'board-bad.json'), JSON.stringify({
    version: 1, sessionId: 'bad', savedAt: 1,
    goals: [{ goalId: 'g-2', round: 1, doneSummary: '', subgoal: 'S', role: 'default', models: { round: 'x', agents: 42 } }],
  }))
  const restoredBad = await loadBoardFile(root, 'bad')
  assert.equal(restoredBad.length, 1, 'malformed mirror does not kill the goal')
  console.log('✓ 9 old snapshot without models loads; malformed mirror degrades safely')
}

// 10. projection: toGoalView mirrors loop.models; normalizeGoal sanitizes a
//     corrupt wire row (drop row, keep goal) and drops a malformed mirror
{
  const loop = {
    goalId: 'g-1', round: 1, doneSummary: '', subgoal: 'S', role: 'default',
    models: { round: 1, agents: { default: { source: 'config', model: 'm' } } },
  }
  const state = goalsFromBoard([loop])
  assert.deepEqual(state.goals[0].models, loop.models, 'board → wire mirror')

  const proj = cyberneticsGoalsProjection()
  const applied = proj.apply(emptyGoalsState(), {
    type: 'plugin:cybernetics/goals',
    data: { goals: [{ goalId: 'g-2', status: 'running', depth: 'full', executor: 'ephemeral', round: 1, revisions: [], updatedAt: 1,
      models: { round: 1, agents: { default: { source: 'nonsense' }, verify: { source: 'observed', model: 'real' } } } }] },
  })
  const g2 = applied.goals.find((g) => g.goalId === 'g-2')
  assert.deepEqual(g2.models.agents, { verify: { source: 'observed', model: 'real' } },
    'invalid row dropped, valid row kept')

  const appliedBad = proj.apply(emptyGoalsState(), {
    type: 'plugin:cybernetics/goals',
    data: { goals: [{ goalId: 'g-3', status: 'running', depth: 'full', executor: 'ephemeral', round: 1, revisions: [], updatedAt: 1,
      models: 'garbage' }] },
  })
  assert.equal(appliedBad.goals.find((g) => g.goalId === 'g-3').models, undefined,
    'malformed mirror degrades to absent')
  console.log('✓ 10 projection: models mirrored on GoalView; wire sanitize drops corrupt rows only')
}

// 11. legacy round record without agents: mergeAgentAudit tolerates and fills
//     (the old-file reader tolerance contract, round-side)
{
  const merged = mergeAgentAudit({ roles: {} }, { role: 'default' }, {})
  assert.deepEqual(merged, {
    default: { source: 'config' }, verify: { source: 'config' }, triage: { source: 'config' },
  })
  console.log('✓ 11 old round record without agents: audit synthesized, readers do not throw')
}

console.log('v22-agent-model-audit: all groups passed')
