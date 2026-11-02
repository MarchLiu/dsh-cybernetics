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

/** Progress of one loop in the calling session; the durable objective lives in dsh-goal. */
export interface LoopState {
  round: number
  doneSummary: string
  subgoal: string
  role: string
  /** Session goal this loop belongs to; a different id resets the state. */
  goalId?: string
  paused?: { reason: ResumableReason; note: string }
}

/** Append one round's structured result to the per-workspace audit log. */
async function writeRoundLog(root: string, round: number, result: unknown): Promise<void> {
  await mkdir(join(root, STATE_DIR), { recursive: true })
  await writeFile(join(root, STATE_DIR, `round-${round}.json`), JSON.stringify(result, null, 2))
}

/**
 * Run one round end to end: execute the workflow script against the session's
 * goal, log, and decide. Throws only on infrastructure failure — child-agent
 * failure is a `failed` decision, not a throw.
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
  const round = state.round + 1
  const run = engine.start({
    script: await readFile(config.roundScriptPath, 'utf8'),
    meta: { name: 'cybernetics-round', description: `cybernetics round ${round}: ${state.subgoal}` },
    args: {
      goal: { objective: goal.objective },
      state: { round, doneSummary: state.doneSummary },
      subgoal: state.subgoal,
      role: state.role,
      roles: config.roles ?? {},
    },
    parent,
    signal,
    // maxTotalAgents stays at the engine default; a round starts at most 3 children.
  })
  let result: RoundResult
  try {
    const settled = await run.result
    if (settled.stopReason !== 'completed') {
      result = { round, failed: `workflow run ${settled.stopReason}${'error' in settled && settled.error ? `: ${settled.error}` : ''}` }
    } else {
      result = settled.value as RoundResult
    }
  } finally {
    await run.dispose()
  }

  await writeRoundLog(root, round, result)
  return { result, decision: decide(result, state, config) }
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
