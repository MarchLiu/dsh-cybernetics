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

import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
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
export type GoalStatus = 'running' | 'paused' | 'met' | 'cancelled' | 'superseded' | 'failed' | 'pending'

/** Execution substrate (v0.6: orthogonal to depth). */
export type GoalExecutor = 'ephemeral' | 'persistent'

/**
 * Statuses that END a goal's life. The tab's two-segment ordering puts the
 * unfinished group first and this group last (user 2026-11-02 append-only model).
 */
export const COMPLETED_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set<GoalStatus>(['met', 'cancelled', 'superseded'])

/** One goal as the client tab renders it (wire-safe plain JSON). */
export interface GoalView {
  goalId: string
  title: string
  objective: string
  status: GoalStatus
  depth: 'quick' | 'full'
  executor: GoalExecutor
  /**
   * Name of the durable Agent Teams teammate executing this goal (v0.6
   * `executor: 'persistent'`). Present only once a persistent round has
   * provisioned the member; ephemeral goals never carry it.
   */
  memberName?: string
  /** Rounds completed (the next round is `round + 1`). */
  round: number
  /** Current subgoal of the inner correction loop. */
  subgoal?: string
  /** Append-only lineage: the goal this one was revised from. */
  parentGoalId?: string
  /** Set when a revision replaced this goal: the successor's goalId. */
  supersededBy?: string
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
  interface PluginRecordMap {
    'plugin:cybernetics/goals': CyberneticsGoalsState
  }
}

/** Projection key; also the session event type (one key, one event). */
export const PROJECTION_KEY = 'cyberneticsGoals' as const
/**
 * The persisted record type. The host's persistence loader FAIL-CLOSES on an
 * unknown, non-ignorable session event (validateStoredEvents →
 * SessionFormatUnsupportedError), so this board must travel as a plugin
 * record: `appendPluginRecord` writes `{type, data, ignorable: true}`, which
 * every reader may safely skip when it does not know the type.
 */
export const EVENT_TYPE = 'plugin:cybernetics/goals' as const
/** Pre-fix event name; accepted on restore so older logs still fold. */
export const LEGACY_EVENT_TYPE = 'cybernetics/goals' as const
/** Persisted-cache invalidation version of the fold. */
export const STATE_VERSION = 2

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
    ...(typeof goal.memberName === 'string' && goal.memberName.length > 0
      ? { memberName: goal.memberName }
      : {}),
    round: Number.isFinite(goal.round) ? Number(goal.round) : 0,
    ...(typeof goal.subgoal === 'string' && goal.subgoal.length > 0 ? { subgoal: goal.subgoal } : {}),
    ...(typeof goal.parentGoalId === 'string' && goal.parentGoalId.length > 0
      ? { parentGoalId: goal.parentGoalId }
      : {}),
    ...(typeof goal.supersededBy === 'string' && goal.supersededBy.length > 0
      ? { supersededBy: goal.supersededBy }
      : {}),
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
      if (event?.type !== EVENT_TYPE && event?.type !== LEGACY_EVENT_TYPE) return state
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
    ...(loop.memberName ? { memberName: loop.memberName } : {}),
    round: Number.isFinite(loop.round) ? loop.round : 0,
    ...(loop.subgoal ? { subgoal: loop.subgoal } : {}),
    ...(loop.parentGoalId ? { parentGoalId: loop.parentGoalId } : {}),
    ...(loop.supersededBy ? { supersededBy: loop.supersededBy } : {}),
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
 * Tab order (user 2026-11-02): unfinished goals first, finished goals after;
 * inside each segment the most recently changed goal leads. Total and stable:
 * `goalId` breaks exact `updatedAt` ties so the wire value never flips between
 * publishes that carry identical timestamps.
 */
function compareGoals(a: GoalView, b: GoalView): number {
  const groupA = COMPLETED_GOAL_STATUSES.has(a.status) ? 1 : 0
  const groupB = COMPLETED_GOAL_STATUSES.has(b.status) ? 1 : 0
  if (groupA !== groupB) return groupA - groupB
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  return a.goalId.localeCompare(b.goalId)
}

/**
 * Snapshot one session's whole goal board as the projection's wire value.
 * The array is pre-sorted (two segments, see `compareGoals`) so the client can
 * render it verbatim without re-ordering.
 * @param loops - every loop on the session's board.
 * @param now - epoch milliseconds (injectable for tests).
 */
export function goalsFromBoard(loops: Iterable<LoopState>, now = Date.now()): CyberneticsGoalsState {
  const goals: GoalView[] = []
  for (const loop of loops) {
    if (loop.goalId === undefined) continue
    goals.push(toGoalView(loop, now))
  }
  goals.sort(compareGoals)
  return { goals }
}

/** Last successfully published JSON per session (idempotence guard). */
const published = new WeakMap<object, string>()

/** Record appender seam. */
export type RecordAppender = (session: unknown, type: string, data: unknown) => unknown

const MODULE_SPECIFIER = '@deepseek-ai/dsh-session'
/** Directory (inside a workspace root) that receives the one-shot record. */
export const DEBUG_DIR = '.cybernetics'
/** File name of the one-shot host-copy resolution record. */
export const DEBUG_FILE = 'publish-debug.log'

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** Outcome of resolving the host's own copy of `@deepseek-ai/dsh-session`. */
export interface HostSessionResolution {
  /** Entry script the host resolution started from (`process.argv[1]`). */
  argv1: string | undefined
  /** File this module's static import binds to (its own copy). */
  ownPath: string | undefined
  /** File the host's entry script resolves `@deepseek-ai/dsh-session` to. */
  hostPath: string | undefined
  /** True when the host copy is a DIFFERENT file → a dynamic import is required. */
  needsHostImport: boolean
  /** The base that actually resolved (differs from `argv1` for a launcher symlink). */
  resolvedFrom?: string
  /** Resolution failure text (diagnostics only, never payload data). */
  error?: string
}

/**
 * Resolve the host's copy of `@deepseek-ai/dsh-session` WITHOUT importing it.
 *
 * Why this is load-bearing: the plugin is loaded through the profile's
 * `node_modules` (a symlink), while the running host keeps its Session class
 * in the copy bundled with the `dsh` install. `appendPluginRecord` commits
 * through a module-private `#appendRecord`, and a Session instance from the
 * other copy cannot satisfy that brand — the call throws
 * `TypeError: Receiver must be an instance of class Session`, no
 * `plugin:cybernetics/goals` event lands, and the「目标」tab silently falls
 * back to dsh-goal's single slot.
 *
 * Resolution starts from the host's entry script (`process.argv[1]`), which is
 * how the host itself finds the module — but node keeps `argv[1]` as the
 * INVOKED path, and `dsh` is normally started through a launcher symlink
 * (`/opt/homebrew/bin/dsh -> .../dsh/lib/bin.js`). Resolving from the symlink's
 * own directory cannot find the package, so the realpath is tried next. Pure:
 * only `require.resolve` runs, so tests can drive it with a fake `argv1`.
 * @param argv1 - entry script; defaults to `process.argv[1]`.
 * @param selfUrl - this module's URL; defaults to `import.meta.url`.
 */
export function resolveHostSessionCopy(
  argv1: string | undefined = process.argv[1],
  selfUrl: string = import.meta.url,
): HostSessionResolution {
  const entry = typeof argv1 === 'string' && argv1.length > 0 ? argv1 : undefined
  const bases: string[] = []
  if (entry === undefined) {
    bases.push(selfUrl)
  } else {
    bases.push(entry)
    try {
      const real = realpathSync(entry)
      if (real !== entry) bases.push(real)
    } catch {
      // Not a readable file: nothing to follow, the entry base stays alone.
    }
  }
  let ownPath: string | undefined
  let ownError: string | undefined
  try {
    // `require.resolve` returns the realpath, exactly like the ESM resolver
    // that bound this module's static import — so the two are comparable.
    ownPath = createRequire(selfUrl).resolve(MODULE_SPECIFIER)
  } catch (cause) {
    ownError = `own copy: ${errorText(cause)}`
  }
  let hostPath: string | undefined
  let resolvedFrom: string | undefined
  const failures: string[] = []
  for (const base of bases) {
    try {
      hostPath = createRequire(base).resolve(MODULE_SPECIFIER)
      resolvedFrom = base
      break
    } catch (cause) {
      failures.push(`${base}: ${errorText(cause)}`)
    }
  }
  const needsHostImport = hostPath !== undefined && hostPath !== ownPath
  // Only a hard failure is an `error`: an unresolvable INVOKED path followed by
  // a successful realpath (the launcher symlink) is the normal host shape.
  const problems = [...(ownError !== undefined ? [ownError] : []), ...failures]
  return {
    argv1: entry,
    ownPath,
    hostPath,
    needsHostImport,
    ...(resolvedFrom !== undefined ? { resolvedFrom } : {}),
    ...(hostPath === undefined && problems.length > 0 ? { error: problems.join('; ') } : {}),
  }
}

/** Resolution performed once, at module init, from the host's entry script. */
const resolution = resolveHostSessionCopy()
/** Host-copy appender; undefined until the dynamic import settles. */
let hostAppend: RecordAppender | undefined
let hostLoadError: string | undefined
/** True once the host-copy import settled (or was correctly skipped). */
let hostSettled = !resolution.needsHostImport
/** Workspace root for the one-shot record; supplied by the caller. */
let debugRoot: string | undefined
/** Roots already recorded (one line per workspace root, never repeated). */
const debugWritten = new Set<string>()

/**
 * Append the resolution/load outcome to
 * `<workspace>/.cybernetics/publish-debug.log` (one JSON line, append mode).
 * Written at most once per workspace root, as soon as both the root and the
 * host-copy outcome are known — a multi-workspace host gets one line per
 * workspace, each readable after a restart. Observability only: any failure is
 * ignored.
 */
function flushPublishDebug(): void {
  const root = debugRoot
  if (root === undefined || !hostSettled || debugWritten.has(root)) return
  debugWritten.add(root)
  try {
    mkdirSync(join(root, DEBUG_DIR), { recursive: true })
    appendFileSync(
      join(root, DEBUG_DIR, DEBUG_FILE),
      `${JSON.stringify({
        at: new Date().toISOString(),
        event: 'host-session',
        specifier: MODULE_SPECIFIER,
        argv1: resolution.argv1 ?? null,
        ownPath: resolution.ownPath ?? null,
        hostPath: resolution.hostPath ?? null,
        resolvedFrom: resolution.resolvedFrom ?? null,
        needsHostImport: resolution.needsHostImport,
        hostAppendReady: hostAppend !== undefined,
        error: resolution.error ?? hostLoadError ?? null,
      })}\n`,
    )
  } catch {
    // A read-only workspace still publishes; the record is best-effort.
  }
}

/**
 * Point the resolution record at a workspace root (only the caller knows it —
 * a session header's `cwd`, or dsh's working directory service). Idempotent:
 * each workspace root receives at most one line.
 */
export function setPublishDebugRoot(root: string | undefined): void {
  if (typeof root !== 'string' || root.length === 0) return
  debugRoot = root
  flushPublishDebug()
}

/** Diagnostic view of the host-copy resolution (no side effects). */
export function hostSessionStatus(): HostSessionResolution & { hostAppendReady: boolean; loadError?: string } {
  return {
    ...resolution,
    hostAppendReady: hostAppend !== undefined,
    ...(hostLoadError !== undefined ? { loadError: hostLoadError } : {}),
  }
}

if (resolution.needsHostImport && resolution.hostPath !== undefined) {
  // Fire-and-forget: publishing must never wait on a module load, and the
  // static import keeps working until (and unless) this settles.
  import(pathToFileURL(resolution.hostPath).href)
    .then((loaded: { appendPluginRecord?: unknown }) => {
      if (typeof loaded.appendPluginRecord !== 'function') {
        hostLoadError = 'host copy exports no appendPluginRecord'
        return
      }
      hostAppend = loaded.appendPluginRecord as RecordAppender
    })
    .catch((cause: unknown) => {
      hostLoadError = errorText(cause)
    })
    .finally(() => {
      hostSettled = true
      flushPublishDebug()
    })
}

/**
 * Production appender: the host's own copy first (the only copy that can
 * satisfy the Session private-field brand), this module's static import as the
 * fallback. A rejected host-copy call falls back so a publish is never lost.
 */
const defaultAppender: RecordAppender = (session, type, data) => {
  if (hostAppend !== undefined) {
    try {
      return hostAppend(session, type, data)
    } catch (hostError) {
      try {
        return appendPluginRecord(session as never, type as never, data as never)
      } catch {
        throw hostError
      }
    }
  }
  return appendPluginRecord(session as never, type as never, data as never)
}
let recordAppender: RecordAppender = defaultAppender
/** Test seam: replace the plugin-record appender (pass undefined to restore). */
export function setRecordAppender(appender: RecordAppender | undefined): void {
  recordAppender = appender ?? defaultAppender
}

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
  const target = session as { append?: unknown; header?: { cwd?: unknown } } | null | undefined
  if (target === null || target === undefined || typeof target !== 'object') return 'skipped'
  // A real Session exposes `append`; anything else is not a log we may write.
  if (typeof target.append !== 'function') return 'skipped'
  // Best-effort workspace hint for the one-shot host-copy record: a real
  // Session carries its cwd in the header, so the log lands in the right
  // `.cybernetics/` even when the caller cannot pass the root itself.
  const cwd = target.header?.cwd
  if (typeof cwd === 'string') setPublishDebugRoot(cwd)
  const json = JSON.stringify(state)
  if (published.get(target) === json) return 'unchanged'
  try {
    recordAppender(target, EVENT_TYPE, state)
  } catch {
    // A non-loggable payload (or a session mid-teardown) must not fail the
    // round that produced it; the tab simply keeps the previous snapshot.
    return 'failed'
  }
  published.set(target, json)
  return 'published'
}
