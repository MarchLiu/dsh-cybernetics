/**
 * The cybernetics controller: the between-rounds state machine. The durable
 * goal lives in the SESSION (dsh-goal service), not in a file; each round is
 * one `ctx.workflowEngine.start()` run executing the round script. The
 * controller folds the structured result into the round audit log and decides
 * continue / pause / escalate. It never marks a goal complete on its own —
 * user confirmation is a separate act, and goal revisions are the calling
 * model's act (user calibrates through conversation).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkflowEngine } from '@deepseek-ai/dsh-workflow'

/** Directory holding per-round audit logs, relative to the workspace root. */
export const STATE_DIR = '.cybernetics'

/** One executed round, as returned by the workflow run. */
export interface RoundResult {
  round: number
  report?: unknown
  verdict?: unknown
  triage?: unknown
  failed?: string
}

/** LLM target overrides for one sub-agent role; workflow `agent()` opts subset. */
export interface RoleSpec {
  provider?: string
  model?: string
}

/** Per-role sub-agent configuration: 'default'/'verify'/'triage' plus named task roles. */
export interface RolesConfig {
  default?: RoleSpec
  verify?: RoleSpec
  triage?: RoleSpec
  [role: string]: RoleSpec | undefined
}

/** Controller configuration; deployment-varying values are caller-supplied, never hardcoded here. */
export interface ControllerConfig {
  /** Consecutive iterations allowed per subgoal before the loop pauses (default 3). */
  roundsPerSubgoal?: number
  /** Absolute path of the workflow round script (the bundled `workflows/round.js`). */
  roundScriptPath: string
  /** Per-role model/provider overrides handed to the round script. */
  roles?: RolesConfig
}

/** What the controller decided after folding one round. */
export type ControllerDecision =
  | { action: 'continue'; subgoal: string; note: string }
  | { action: 'pause'; reason: 'met' | 'goal-questionable' | 'human-input' | 'round-cap' | 'failed' | 'no-goal'; note: string }

/** Reason a paused loop can resume: never `met` — completion needs user confirmation, not a resume. */
export type ResumableReason = 'goal-questionable' | 'human-input' | 'round-cap' | 'failed' | 'no-goal'

/** Progress of one goal's loop in the calling session; multi-goal: one per goalId. */
export interface LoopState {
  /** Registry id of this goal (dsh-goal id when adopted, else `cyb-*`). */
  goalId?: string
  /** Short human title for the goal board. */
  title?: string
  /** The goal's durable work order (falls back to dsh-goal objective when adopted). */
  objective?: string
  round: number
  doneSummary: string
  subgoal: string
  role: string
  /** Detailed per-round work order extracted by the calling model; passed to the task agent verbatim. */
  brief?: string
  /** Round depth: 'quick' = task agent only (lightweight analysis); 'full' = task→verify→triage (default). */
  depth?: 'quick' | 'full'
  /** Lifecycle: running (a round in flight) / paused / met (verify passed, awaits user) / cancelled. */
  status?: 'running' | 'paused' | 'met' | 'cancelled'
  paused?: { reason: ResumableReason; note: string }
  /**
   * Execution substrate (v0.6, orthogonal to depth): the Executor adapter is
   * not implemented yet, so every goal reports 'ephemeral' (workflow agent).
   * Present on the loop state now so the session projection's GoalView shape
   * needs no breaking change when the adapter lands.
   */
  executor?: 'ephemeral' | 'persistent'
  /** Outer-loop goal revisions (v0.6: agent proposes, the user confirms). */
  revisions?: Array<{ version: number; reason: string; at: number }>
}

/** Append one round's structured result to the per-workspace audit log. */
async function writeRoundLog(root: string, goalId: string | undefined, round: number, result: unknown): Promise<void> {
  await mkdir(join(root, STATE_DIR), { recursive: true })
  // Multi-goal: several goals share the workspace log dir, and each numbers
  // its rounds from 1 — without the goalId in the name, concurrent goals
  // overwrite each other's audit trail (found in the v0.3 live test).
  const slug = (goalId ?? 'goal').replace(/[^a-zA-Z0-9._-]/g, '_')
  await writeFile(join(root, STATE_DIR, `round-${slug}-${round}.json`), JSON.stringify(result, null, 2))
}

/**
 * Start one round's workflow run without awaiting it. Returns the round
 * number and the live run; the caller either awaits `run.result` itself
 * (blocking 'round' action) or stores the handle for later collection
 * (async 'start'/'collect'/'cancel' actions).
 */
export async function startRound(
  engine: WorkflowEngine,
  parent: unknown,
  root: string,
  state: LoopState,
  config: ControllerConfig,
  goal: { objective: string },
  signal?: AbortSignal,
): Promise<{ round: number; run: ReturnType<WorkflowEngine['start']> }> {
  const round = state.round + 1
  const run = engine.start({
    script: await readFile(config.roundScriptPath, 'utf8'),
    meta: { name: 'cybernetics-round', description: `cybernetics round ${round}: ${state.subgoal}` },
    args: {
      goal: { objective: goal.objective },
      state: { round, doneSummary: state.doneSummary },
      subgoal: state.subgoal,
      brief: state.brief,
      depth: state.depth ?? 'full',
      role: state.role,
      roles: config.roles ?? {},
    },
    parent,
    signal,
    // maxTotalAgents stays at the engine default; a round starts at most 3 children.
  })
  return { round, run }
}

/**
 * Fold a settled workflow run into the round result + controller decision:
 * normalize the outcome, append the audit log. Pure w.r.t. loop state —
 * the caller applies the decision to its LoopState.
 */
export async function foldRound(
  root: string,
  round: number,
  settled: { stopReason: string; value?: unknown; error?: unknown },
  state: LoopState,
  config: ControllerConfig,
): Promise<{ result: RoundResult; decision: ControllerDecision }> {
  let result: RoundResult
  if (settled.stopReason !== 'completed') {
    result = { round, failed: `workflow run ${settled.stopReason}${settled.error ? `: ${settled.error}` : ''}` }
  } else {
    result = settled.value as RoundResult
  }
  await writeRoundLog(root, state.goalId, round, result)
  return { result, decision: decide(result, state, config) }
}

/**
 * Run one round end to end (blocking): start, await, fold, dispose.
 * Throws only on infrastructure failure — child-agent failure is a
 * `failed` decision, not a throw.
 */
export async function runRound(
  engine: WorkflowEngine,
  parent: unknown,
  root: string,
  state: LoopState,
  config: ControllerConfig,
  goal: { objective: string },
  signal?: AbortSignal,
): Promise<{ result: RoundResult; decision: ControllerDecision }> {
  const { round, run } = await startRound(engine, parent, root, state, config, goal, signal)
  try {
    const settled = await run.result
    return await foldRound(root, round, settled, state, config)
  } finally {
    await run.dispose()
  }
}

/** Fold one round result into a continue/pause decision. Pure. */
function decide(result: RoundResult, state: LoopState, config: ControllerConfig): ControllerDecision {
  if (result.failed) {
    return { action: 'pause', reason: 'failed', note: `第 ${result.round} 轮失败：${result.failed}` }
  }
  const verdict = result.verdict as { met?: boolean; goalItselfQuestionable?: boolean; gaps?: string[] } | undefined
  if (verdict && verdict.goalItselfQuestionable) {
    return { action: 'pause', reason: 'goal-questionable', note: 'verify 判定目标本身可能有问题，需通过对话重新校准' }
  }
  if (verdict?.met) {
    return { action: 'pause', reason: 'met', note: '验收全部通过；等待用户确认完成' }
  }
  const triage = result.triage as { human?: { question?: string; step: string }[]; auto?: { step: string }[] } | undefined
  const human = triage?.human ?? []
  if (human.length > 0) {
    return { action: 'pause', reason: 'human-input', note: `待用户裁定：${human.map((h) => h.question ?? h.step).join('；')}` }
  }
  const cap = config.roundsPerSubgoal ?? 3
  if (state.round >= cap) {
    return { action: 'pause', reason: 'round-cap', note: `同一子目标已迭代 ${state.round} 轮仍未达成，升级用户` }
  }
  const gaps = verdict?.gaps ?? []
  const auto = triage?.auto ?? []
  const nextSubgoal = gaps.length > 0
    ? `修复缺口：${gaps.join('；')}`
    : auto.length > 0
      ? auto.map((s) => s.step).join('；')
      : state.subgoal
  return { action: 'continue', subgoal: nextSubgoal, note: `进入第 ${state.round + 1} 轮` }
}
