/**
 * Goal→agent association (v0.14): records every child agent a goal's rounds
 * spawn onto that goal's LoopState, so the「目标」tab can render an
 * 「关联智能体」line per goal with live run state and click-through.
 *
 * Three seams, one fold:
 * 1. Workflow children (ephemeral rounds, and the persistent substrate's
 *    verify/triage runs): the host engine dispatches `workflow/agent-start` /
 *    `workflow/agent-end` on its context (dsh-workflow WorkflowEngine,
 *    dsh-tool-workflow already listens the same way). The plugin registers
 *    listeners in `apply()`; events carry `{id, meta}` + `{seq, label,
 *    childId}`. A run is correlated to its goal because THIS plugin starts
 *    every run: `linkRunToGoal()` stores the mapping at launch (both executors
 *    call it), and `workflow/end` drops it.
 * 2. Persistent teammates (Agent Teams members): not workflow children —
 *    `executor.ts` records the spawned member's session id directly via
 *    `noteTeamMember()`.
 * 3. Session publish: the goal board lives in index.ts's `boards` map; the
 *    tracker reaches it through the `setBoardSource()` seam (no import cycle —
 *    index.ts wires it at module init) and republishes the whole board with
 *    `publishGoals`, so the client value updates live with zero polling.
 *
 * Role derivation: round.js labels its `agent()` calls `task:<role>`,
 * `verify`, `triage` — the same identifiers the acceptance criteria name.
 * Observability only: every failure mode is contained (a tracking problem can
 * never fail a round).
 * @module dsh-cybernetics/agents
 */

import type { GoalAgentRecord, LoopState } from './controller.ts'
import { goalsFromBoard, publishGoals } from './projection.ts'

/** run id → the session + goal whose round started that run. */
const runLinks = new Map<string, { session: unknown; goalId: string }>()

/** Bound on the link table: two maps per round, so 512 in-flight links is generous. */
const MAX_RUN_LINKS = 512

/** index.ts's board registry, wired at module init. */
let boardSource: (() => Map<unknown, Map<string, LoopState>>) | undefined

/**
 * Wire the board source (index.ts's module-level `boards` map). Called once at
 * index module init; a second call replaces it (tests).
 */
export function setBoardSource(source: (() => Map<unknown, Map<string, LoopState>>) | undefined): void {
  boardSource = source
}

/**
 * Correlate one workflow run with the goal whose round started it. Called by
 * both executors right after `engine.start(...)`; `workflow/end` (or the cap)
 * retires the entry. Best-effort: a link that cannot be stored just means the
 * run's agents are not tracked.
 */
export function linkRunToGoal(runId: unknown, session: unknown, goalId: string | undefined): void {
  const id = typeof runId === 'string' && runId.length > 0 ? runId : String(runId ?? '')
  if (id.length === 0 || typeof session !== 'object' || session === null) return
  if (typeof goalId !== 'string' || goalId.length === 0) return
  if (runLinks.size >= MAX_RUN_LINKS && !runLinks.has(id)) {
    // Drop the OLDEST entry (first inserted) so a hot controller cannot grow
    // the table without bound; a dropped link only costs future tracking.
    const oldest = runLinks.keys().next().value
    if (typeof oldest === 'string') runLinks.delete(oldest)
  }
  runLinks.set(id, { session, goalId })
}

/** Retire one run link (the `workflow/end` listener). */
export function unlinkRun(runId: unknown): void {
  const id = typeof runId === 'string' && runId.length > 0 ? runId : String(runId ?? '')
  if (id.length > 0) runLinks.delete(id)
}

/**
 * Workflow agent label → role identifier. round.js labels: `task:<role>`,
 * `verify`, `triage`; anything else (a default prompt-snippet label) is a task
 * agent call whose script author skipped the label.
 */
export function roleOfLabel(label: string): string {
  if (label === 'verify') return 'verify'
  if (label === 'triage') return 'triage'
  if (label.startsWith('task:')) return 'task'
  return 'task'
}

/**
 * Append/update one agent record on a goal's loop. Dedupe by child id (one
 * agent = one record regardless of how many events arrive); idempotent for
 * repeated starts.
 */
function recordAgent(
  loop: LoopState,
  childId: string,
  role: string,
  label: string,
  outcome: 'completed' | 'failed' | 'cancelled' | undefined,
): boolean {
  if (loop.goalId === undefined) return false
  const now = Date.now()
  const agents = loop.agents ?? (loop.agents = [])
  let record = agents.find((a) => a.id === childId)
  if (record === undefined) {
    record = { id: childId, role, label, startedAt: now }
    agents.push(record)
  } else {
    record.role = role
    record.label = label
  }
  if (outcome !== undefined && record.outcome === undefined) {
    record.outcome = outcome
    record.endedAt = now
  }
  return true
}

/**
 * Publish the whole board of `session` (idempotent; never throws). Returns
 * whether a publish was attempted with a live session log.
 */
function publish(session: unknown): void {
  try {
    const board = boardSource?.().get(session)
    if (board === undefined) return
    publishGoals(session, goalsFromBoard(board.values()))
  } catch {
    // Publishing is observability (projection.ts's own contract): never throw.
  }
}

/**
 * The `workflow/agent-start` / `workflow/agent-end` listener body. Payloads:
 * `info` = WorkflowRunInfo `{id, meta}`, `agent` = WorkflowAgentInfo
 * `{seq, label, phase?, childId}` (+ `outcome` on end). Only runs THIS plugin
 * started are correlated; everything else is ignored silently so a shared
 * engine's other workflows never leak into a goal board.
 * @returns true when a goal record changed (diagnostics/tests only).
 */
export function noteWorkflowAgent(
  info: unknown,
  agent: unknown,
  outcome: 'completed' | 'failed' | 'cancelled' | undefined,
): boolean {
  try {
    const runId = info !== null && typeof info === 'object' ? (info as { id?: unknown }).id : undefined
    const link = typeof runId === 'string' ? runLinks.get(runId) : undefined
    if (link === undefined) return false
    const child = agent !== null && typeof agent === 'object' ? (agent as { childId?: unknown; label?: unknown }) : undefined
    const childId = typeof child?.childId === 'string' ? child.childId : ''
    if (childId.length === 0) return false
    const label = typeof child?.label === 'string' ? child.label : ''
    const board = boardSource?.().get(link.session)
    const loop = board?.get(link.goalId)
    if (loop === undefined) return false
    const changed = recordAgent(loop, childId, roleOfLabel(label), label, outcome)
    if (changed) publish(link.session)
    return changed
  } catch {
    return false
  }
}

/**
 * Record a persistent teammate (Agent Teams member) as the goal's task agent.
 * Called by executor.ts with the spawned/resolved member session id — those
 * children never pass through the workflow engine, so no run link applies.
 * @returns true when a goal record changed.
 */
export function noteTeamMember(
  session: unknown,
  goalId: string | undefined,
  childId: string,
  label: string,
): boolean {
  try {
    if (typeof session !== 'object' || session === null) return false
    if (typeof goalId !== 'string' || goalId.length === 0 || childId.length === 0) return false
    const board = boardSource?.().get(session)
    const loop = board?.get(goalId)
    if (loop === undefined) return false
    const changed = recordAgent(loop, childId, 'task', label, undefined)
    if (changed) publish(session)
    return changed
  } catch {
    return false
  }
}

/** Test/diagnostic seam: drop the session board's goal records is NOT needed —
 * records live on the loop and fold into the board snapshot naturally. */
export type { GoalAgentRecord }
