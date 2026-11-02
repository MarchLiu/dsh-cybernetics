/**
 * The session projection that carries the plugin's WHOLE multi-goal board to
 * the client, plus the whole-value event writer that feeds it.
 *
 * Why a projection and not a route: dsh-goal's own `goal` projection is
 * single-slot (one focus goal per session), so the「目标 / Goal」tab could
 * never show the `cyb-*` goals this plugin keeps in its own `boards` map.
 * The host's projection registry (ctx.sessionProjections) is the sanctioned
 * seam: one pure synchronous fold per registered key, driven eagerly over
 * committed session events, with the client value pushed live — no polling.
 *
 * Whole-value event rule (upstream contract, load-bearing): a state-carrying
 * event MUST carry the complete post-change state, never a delta. Every
 * publish therefore snapshots the session's entire goal board.
 *
 * Zero runtime dependencies: the real `ProjectionDefinition` comes from
 * @deepseek-ai/dsh-session-projection (a Zod schema and a Zod view schema).
 * That package is not installed in this checkout (the plugin is `link:`ed
 * into a dsh profile), and the host only ever calls `.parse(...)` on both
 * schemas, so a duck-typed `{ parse: (v) => v }` is behaviourally exact.
 * `src/upstream.d.ts` declares the two host modules just so the type-merge
 * below type-checks standalone; the shape mirrors upstream's own
 * merge-extensible tables.
 * @module dsh-cybernetics/projection
 */

import type { LoopState } from './controller.ts'

/** One goal revision (v0.6 outer loop: agent proposes, the user confirms). */
export interface GoalRevisionView {
  /** Monotonic revision number within the goal. */
  version: number
  /** Why the goal changed. */
  reason: string
  /** Epoch milliseconds of the revision. */
  at: number
}

/** Lifecycle as the tab renders it. */
export type GoalStatus = 'running' | 'paused' | 'met' | 'cancelled' | 'failed' | 'pending'

/** Execution substrate (v0.6: orthogonal to depth). */
export type GoalExecutor = 'ephemeral' | 'persistent'

/** One goal as the client tab renders it (wire-safe plain JSON). */
export interface GoalView {
  goalId: string
  title: string
  objective: string
  status: GoalStatus
  depth: 'quick' | 'full'
  executor: GoalExecutor
  /** Rounds completed (the next round is `round + 1`). */
  round: number
  /** Current subgoal of the inner correction loop. */
  subgoal?: string
  revisions: GoalRevisionView[]
  /** Epoch milliseconds of the last content change (ordering key for the tab). */
  updatedAt: number
}

/** Fold state / wire value of the `cyberneticsGoals` projection. */
export interface CyberneticsGoalsState {
  goals: GoalView[]
}

// Type merge into the host's projection tables (compile-time only).
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    cyberneticsGoals: CyberneticsGoalsState
  }
  interface SessionProjectionMap {
    cyberneticsGoals: CyberneticsGoalsState
  }
}

// Type merge for the session event this plugin appends. The host accepts any
// registered event type at runtime (`Session.append(type, data)`); the merge
// keeps that call site typed instead of `any`.
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'cybernetics/goals': CyberneticsGoalsState
  }
}

/** Projection key; also the session event type (one key, one event). */
export const PROJECTION_KEY = 'cyberneticsGoals' as const
export const EVENT_TYPE = 'cybernetics/goals' as const
/** Persisted-cache invalidation version of the fold. */
export const STATE_VERSION = 1

/** Duck-typed Zod stand-in: the host only calls `parse`. */
interface SchemaLike<T> {
  parse(value: unknown): T
}

const passThrough = <T>(): SchemaLike<T> => ({ parse: (value) => value as T })

/**
 * Structural replica of the host's `ProjectionDefinition` (fields we use).
 * Kept local because the upstream package is not a dependency of this
 * zero-dep plugin; `cyberneticsGoalsProjection()` is handed to
 * `ctx.sessionProjections.register()` where the host's own typing applies.
 */
export interface ProjectionDefinitionLike {
  key: typeof PROJECTION_KEY
  stateSchema: SchemaLike<CyberneticsGoalsState>
  init(header: unknown, inheritedEventCount: number): CyberneticsGoalsState
  apply(state: CyberneticsGoalsState, event: { type: string; data?: unknown }): CyberneticsGoalsState
  wire: {
    viewSchema: SchemaLike<CyberneticsGoalsState>
    view(state: CyberneticsGoalsState): CyberneticsGoalsState
  }
  stateVersion: number
}

/** Empty fold state (a fresh session with no goals yet). */
export function emptyGoalsState(): CyberneticsGoalsState {
  return { goals: [] }
}

function isGoalView(value: unknown): value is GoalView {
  if (value === null || typeof value !== 'object') return false
  const g = value as Record<string, unknown>
  return typeof g.goalId === 'string' && typeof g.status === 'string'
}

/** Normalize one wire goal into a fresh plain-JSON object. */
function normalizeGoal(goal: GoalView): GoalView {
  return {
    goalId: String(goal.goalId),
    title: typeof goal.title === 'string' ? goal.title : String(goal.goalId),
    objective: typeof goal.objective === 'string' ? goal.objective : '',
    status: goal.status,
    depth: goal.depth === 'quick' ? 'quick' : 'full',
    executor: goal.executor === 'persistent' ? 'persistent' : 'ephemeral',
    round: Number.isFinite(goal.round) ? Number(goal.round) : 0,
    ...(typeof goal.subgoal === 'string' && goal.subgoal.length > 0 ? { subgoal: goal.subgoal } : {}),
    revisions: Array.isArray(goal.revisions)
      ? goal.revisions.map((r) => ({
        version: Number.isFinite(r?.version) ? Number(r.version) : 0,
        reason: typeof r?.reason === 'string' ? r.reason : '',
        at: Number.isFinite(r?.at) ? Number(r.at) : 0,
      }))
      : [],
    updatedAt: Number.isFinite(goal.updatedAt) ? Number(goal.updatedAt) : 0,
  }
}

/**
 * The `cyberneticsGoals` projection unit: `{goals: [...]}` rebuilt from each
 * whole-value `cybernetics/goals` event, byte-identical for unrelated events
 * (same state reference — the host's zero-work fast path).
 */
export function cyberneticsGoalsProjection(): ProjectionDefinitionLike {
  return {
    key: PROJECTION_KEY,
    stateSchema: passThrough<CyberneticsGoalsState>(),
    init: () => emptyGoalsState(),
    apply(state, event) {
      if (event?.type !== EVENT_TYPE) return state
      const data = event.data as CyberneticsGoalsState | undefined
      if (data === null || typeof data !== 'object' || !Array.isArray(data.goals)) return state
      const goals = data.goals.filter(isGoalView).map(normalizeGoal)
      // A fresh object per owned event: the wire view is the state itself, and
      // the host republishes only when the view reference changes.
      return { goals }
    },
    wire: {
      viewSchema: passThrough<CyberneticsGoalsState>(),
      view: (state) => state,
    },
    stateVersion: STATE_VERSION,
  }
}

/**
 * Content fingerprint -> last-change timestamp, per loop object. `updatedAt`
 * must move only when a goal's content moves (the tab sorts by it, and an
 * unchanged republish must stay a no-op); deriving it from the fingerprint
 * keeps that invariant in one place instead of sprinkling clock writes over
 * every mutation site.
 */
const goalStamps = new WeakMap<object, { fingerprint: string; at: number }>()

function statusOf(loop: LoopState): GoalStatus {
  const status = loop.status
  if (status === undefined) return 'pending'
  if (status === 'paused' && loop.paused?.reason === 'failed') return 'failed'
  return status
}

/** Project one loop onto the client view (fresh plain JSON). */
function toGoalView(loop: LoopState, now: number): GoalView {
  const goalId = loop.goalId ?? ''
  const revisions = Array.isArray(loop.revisions) ? loop.revisions : []
  const view: GoalView = {
    goalId,
    title: loop.title ?? goalId,
    objective: loop.objective ?? '',
    status: statusOf(loop),
    depth: loop.depth === 'quick' ? 'quick' : 'full',
    executor: loop.executor === 'persistent' ? 'persistent' : 'ephemeral',
    round: Number.isFinite(loop.round) ? loop.round : 0,
    ...(loop.subgoal ? { subgoal: loop.subgoal } : {}),
    revisions: revisions.map((r) => ({ version: r.version, reason: r.reason, at: r.at })),
    updatedAt: 0,
  }
  const fingerprint = JSON.stringify({ ...view, updatedAt: 0 })
  const stamp = goalStamps.get(loop)
  const at = stamp !== undefined && stamp.fingerprint === fingerprint ? stamp.at : now
  goalStamps.set(loop, { fingerprint, at })
  return { ...view, updatedAt: at }
}

/**
 * Snapshot one session's whole goal board as the projection's wire value.
 * @param loops - every loop on the session's board.
 * @param now - epoch milliseconds (injectable for tests).
 */
export function goalsFromBoard(loops: Iterable<LoopState>, now = Date.now()): CyberneticsGoalsState {
  const goals: GoalView[] = []
  for (const loop of loops) {
    if (loop.goalId === undefined) continue
    goals.push(toGoalView(loop, now))
  }
  goals.sort((a, b) => b.updatedAt - a.updatedAt)
  return { goals }
}

/** Last successfully published JSON per session (idempotence guard). */
const published = new WeakMap<object, string>()

/** Outcome of one publish attempt. */
export type PublishResult = 'published' | 'unchanged' | 'skipped' | 'failed'

/**
 * Append the whole goal board as one `cybernetics/goals` session event. The
 * projection folds it into the client value; the host pushes the change to
 * the tab. Publishing is observability, never workflow control: a missing or
 * unhappy session degrades to a no-op instead of breaking a round.
 *
 * Idempotent by contract: republishing a byte-identical state appends
 * nothing.
 * @param session - the agent session whose tab shows the board (may be absent).
 * @param state - the complete post-change board.
 */
export function publishGoals(session: unknown, state: CyberneticsGoalsState): PublishResult {
  const target = session as { append?: (type: string, data: unknown) => unknown } | null | undefined
  if (target === null || target === undefined || typeof target !== 'object') return 'skipped'
  if (typeof target.append !== 'function') return 'skipped'
  const json = JSON.stringify(state)
  if (published.get(target) === json) return 'unchanged'
  try {
    target.append(EVENT_TYPE, state)
  } catch {
    // A non-loggable payload (or a session mid-teardown) must not fail the
    // round that produced it; the tab simply keeps the previous snapshot.
    return 'failed'
  }
  published.set(target, json)
  return 'published'
}
