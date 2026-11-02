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
  /** Execution substrate used for this round (v0.6 audit). */
  executor?: 'ephemeral' | 'persistent'
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
  /** Execution substrate: 'ephemeral' (workflow subagents, default) or 'persistent' (Agent Teams teammate). */
  executor?: 'ephemeral' | 'persistent'
  /** Persistent teammate name, set on the first persistent round and reused afterwards. */
  memberName?: string
  /**
   * Lifecycle: running (a round in flight) / paused / met (verify passed, awaits
   * user) / cancelled / superseded (a revision created a successor goal; this
   * goal keeps its final state and is never driven again).
   */
  status?: 'running' | 'paused' | 'met' | 'cancelled' | 'superseded'
  paused?: { reason: ResumableReason; note: string }
  /**
   * Append-only goal lineage (v0.6, user 2026-11-02): a revision never edits the
   * objective in place — it creates a NEW goal, and the old one keeps its final
   * state. `parentGoalId` = the goal this one was revised from.
   */
  parentGoalId?: string
  /** Set on a superseded goal: the id of the successor that replaced it. */
  supersededBy?: string
  /**
   * In-place revision log kept for wire compatibility (pre-append-only shape).
   * v0.6 append-only model: a revision creates a successor goal instead, so new
   * revisions are recorded as `parentGoalId`/`supersededBy` plus the
   * `.cybernetics/revisions-<newGoalId>.jsonl` audit line, and this stays empty.
   */
  revisions?: Array<{ version: number; reason: string; at: number }>
}

/** One `revise` transition as written to `.cybernetics/revisions-<newGoalId>.jsonl`. */
export interface GoalRevisionRecord {
  /** Superseded goal id. */
  from: string
  /** Newly created successor goal id. */
  to: string
  /** Why the goal changed (required on the `revise` action). */
  reason: string
  /** Epoch milliseconds of the revision. */
  at: number
}

/** Input for the append-only goal creation path. */
export interface GoalSeed {
  goalId: string
  title?: string
  /** Overrides the inherited objective when present. */
  objective?: string
  /** Goal this one was revised from (lineage link). */
  parentGoalId?: string
  depth?: 'quick' | 'full'
  executor?: 'ephemeral' | 'persistent'
  role?: string
  subgoal?: string
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
 * Append one revision line to `.cybernetics/revisions-<newGoalId>.jsonl`.
 * One line per transition, so a revision chain is readable (and greppable)
 * without reconstructing it from per-goal fields. The directory is created
 * lazily; the caller treats a write failure as non-fatal (see `revise`).
 */
export async function writeRevisionLog(root: string, newGoalId: string, record: GoalRevisionRecord): Promise<string> {
  await mkdir(join(root, STATE_DIR), { recursive: true })
  const slug = newGoalId.replace(/[^a-zA-Z0-9._-]/g, '_')
  const file = join(root, STATE_DIR, `revisions-${slug}.jsonl`)
  await writeFile(file, `${JSON.stringify(record)}\n`, { flag: 'a' })
  return file
}

/**
 * Build the successor goal of an append-only revision. Everything the old goal
 * owned that is not per-round state — title, objective, depth, executor, role —
 * is inherited unless a seed field overrides it; the new goal starts at round 0
 * and carries `parentGoalId`. Pure: it neither mutates nor registers anything.
 */
export function createGoal(previous: LoopState | undefined, seed: GoalSeed): LoopState {
  const objective = seed.objective ?? previous?.objective ?? previous?.title ?? ''
  const title = seed.title ?? previous?.title ?? objective.split('\n')[0].slice(0, 60)
  const goal: LoopState = {
    goalId: seed.goalId,
    title,
    objective,
    round: 0,
    doneSummary: '',
    subgoal: seed.subgoal ?? (objective.length > 0 ? objective : title),
    role: seed.role ?? previous?.role ?? 'default',
    status: 'running',
  }
  const depth = seed.depth ?? previous?.depth
  if (depth !== undefined) goal.depth = depth
  const executor = seed.executor ?? previous?.executor
  if (executor !== undefined) goal.executor = executor
  const parentGoalId = seed.parentGoalId ?? previous?.goalId
  if (parentGoalId !== undefined) goal.parentGoalId = parentGoalId
  return goal
}

/**
 * Freeze a goal as superseded by a successor. Mutates the loop in place (the
 * registry holds the same object); the paused marker is dropped so the view
 * does not mix "awaiting human" with "replaced".
 */
export function supersedeGoal(previous: LoopState, newGoalId: string): LoopState {
  previous.status = 'superseded'
  previous.supersededBy = newGoalId
  previous.paused = undefined
  return previous
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
  // v0.6 audit: record which substrate ran the round.
  const logged: RoundResult = { ...result, executor: state.executor ?? 'ephemeral' }
  await writeRoundLog(root, state.goalId, round, logged)
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
