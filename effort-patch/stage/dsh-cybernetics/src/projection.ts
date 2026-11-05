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

import { appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
/** Directory (inside a workspace root) that receives the record. */
export const DEBUG_DIR = '.cybernetics'
/** File name of the resolution/publish record. */
export const DEBUG_FILE = 'publish-debug.log'
/** Longest error excerpt kept per candidate in the publish record. */
export const MAX_DEBUG_ERROR_CHARS = 300

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Outcome of resolving the host's own copy of `@deepseek-ai/dsh-session`. */
export interface HostSessionResolution {
  /** Entry script the host resolution started from (`process.argv[1]`). */
  argv1: string | undefined
  /** File this module's static import binds to (its own copy). */
  ownPath: string | undefined
  /** File the host's entry script resolves `@deepseek-ai/dsh-session` to. */
  hostPath: string | undefined
  /**
   * True when the host copy is a DIFFERENT file from this module's static
   * import. Diagnostic only: both dynamic candidates are loaded regardless
   * (a same-file resolution never proved the Session brand matched).
   */
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

/**
 * Resolve the copy of `@deepseek-ai/dsh-session` that sits under THIS package's
 * own `node_modules` (this repo checks that path in as a symlink to the
 * profile's install). It is a separate candidate from the host entry's copy:
 * the Session instance the plugin is handed may come from either install, and
 * only the copy that DEFINED the instance's class can pass
 * `appendPluginRecord`'s private-field brand check.
 *
 * Zero-dep and pure: existence checks only, no import. Walks up to the package
 * root (the first ancestor with a `package.json`) and then looks for the
 * conventional nested path there.
 * @param selfUrl - this module's URL; defaults to `import.meta.url`.
 */
export function resolvePluginSessionCopy(selfUrl: string = import.meta.url): string | undefined {
  try {
    let dir = dirname(fileURLToPath(selfUrl))
    let packageRoot: string | undefined
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(join(dir, 'package.json'))) {
        packageRoot = dir
        break
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    if (packageRoot === undefined) return undefined
    const candidate = join(packageRoot, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')
    return existsSync(candidate) ? candidate : undefined
  } catch {
    // A virtual/foreign URL: no third candidate, the other two still try.
    return undefined
  }
}

/** One module copy loaded (or being loaded) for the appender candidates. */
interface DynamicCopy {
  /** The callable once the import settled successfully. */
  appender?: RecordAppender
  /** Load failure text (diagnostics only, never payload data). */
  error?: string
}

/** Loaded copies by realpath: one import per distinct file. */
const dynamicCopies = new Map<string, DynamicCopy>()
/** Dynamic imports still in flight. */
let dynamicPending = 0
/** True once every dynamic candidate settled (successfully or not). */
let hostSettled = false
/** Workspace root for the records; supplied by the caller. */
let debugRoot: string | undefined
/** Roots already carrying the one-shot resolution line. */
const debugWritten = new Set<string>()

/** Append one JSON line to `<workspace>/.cybernetics/publish-debug.log`. */
function appendDebugRecord(record: Record<string, unknown>): void {
  const root = debugRoot
  if (root === undefined) return
  try {
    mkdirSync(join(root, DEBUG_DIR), { recursive: true })
    appendFileSync(join(root, DEBUG_DIR, DEBUG_FILE), `${JSON.stringify(record)}\n`)
  } catch {
    // A read-only workspace still publishes; the record is best-effort.
  }
}

/** One appender candidate, tried in list order until one accepts the record. */
export interface AppenderCandidate {
  /** 0-based position in the active list (part of the debug label). */
  index: number
  /** Where the appender comes from. */
  kind: 'static' | 'host' | 'plugin' | 'test'
  /** Path summary of the module behind it (a path, never payload data). */
  path: string
  /** The callable, or undefined while its dynamic import is still pending. */
  get(): RecordAppender | undefined
}

/** Test-only shape: one appender with the label it reports. */
export interface AppenderCandidateInput {
  kind?: 'static' | 'host' | 'plugin' | 'test'
  path?: string
  append: RecordAppender
}

function candidateLabel(candidate: AppenderCandidate): string {
  return `#${candidate.index} ${candidate.kind} ${candidate.path}`
}

/**
 * Start the dynamic import of one module copy.
 *
 * Deliberately ungated: BOTH dynamic candidates are always attempted. The old
 * `needsHostImport === false → skip` short-circuit is exactly what left the
 * host copy unloaded (`needsHostImport:false, hostAppendReady:false` in
 * publish-debug.log) while the statically imported copy kept rejecting the
 * host's Session with `TypeError: Receiver must be an instance of class
 * Session`. Distinct files are deduplicated by realpath so one file is
 * imported at most once.
 */
function loadDynamicCopy(
  path: string | undefined,
  label: string,
): { real: string; copy: DynamicCopy } | undefined {
  if (typeof path !== 'string' || path.length === 0) return undefined
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return undefined
  }
  const existing = dynamicCopies.get(real)
  if (existing !== undefined) return { real, copy: existing }
  const copy: DynamicCopy = {}
  dynamicCopies.set(real, copy)
  dynamicPending += 1
  // Fire-and-forget: publishing must never wait on a module load; a candidate
  // whose import is still pending is simply skipped for that publish.
  import(pathToFileURL(real).href)
    .then((loaded: { appendPluginRecord?: unknown }) => {
      if (typeof loaded.appendPluginRecord === 'function') {
        copy.appender = loaded.appendPluginRecord as RecordAppender
      } else {
        copy.error = `${label}: module exports no appendPluginRecord`
      }
    })
    .catch((cause: unknown) => {
      copy.error = `${label}: ${errorText(cause)}`
    })
    .finally(() => {
      dynamicPending -= 1
      settleDynamicImports()
    })
  return { real, copy }
}

function settleDynamicImports(): void {
  if (hostSettled || dynamicPending > 0) return
  hostSettled = true
  flushPublishDebug()
}

/** Load errors across the dynamic candidates (diagnostics only). */
function dynamicLoadError(): string | undefined {
  const errors: string[] = []
  for (const copy of dynamicCopies.values()) {
    if (typeof copy.error === 'string') errors.push(copy.error)
  }
  return errors.length > 0 ? errors.join('; ') : undefined
}

// Both dynamic candidates are loaded unconditionally (dedup is by realpath,
// inside `loadDynamicCopy`); the static import stays first in the list.
const pluginSessionCopyPath = resolvePluginSessionCopy()
const hostCopy = loadDynamicCopy(resolution.hostPath, 'host copy')
const pluginCopy = loadDynamicCopy(pluginSessionCopyPath, 'plugin copy')

function buildProductionCandidates(): AppenderCandidate[] {
  const raw: Array<Pick<AppenderCandidate, 'kind' | 'path' | 'get'>> = [
    {
      kind: 'static',
      path: resolution.ownPath ?? 'static import',
      get: () => appendPluginRecord as unknown as RecordAppender,
    },
  ]
  if (hostCopy !== undefined) {
    raw.push({ kind: 'host', path: hostCopy.real, get: () => hostCopy.copy.appender })
  }
  if (pluginCopy !== undefined) {
    raw.push({ kind: 'plugin', path: pluginCopy.real, get: () => pluginCopy.copy.appender })
  }
  return raw.map((candidate, index) => ({ ...candidate, index }))
}

const productionCandidates: AppenderCandidate[] = buildProductionCandidates()

// No dynamic candidate at all → the resolution record is ready immediately;
// otherwise it is flushed when the last in-flight import settles.
settleDynamicImports()

/** Test-only candidate override; `undefined` restores production. */
let testCandidates: AppenderCandidate[] | undefined

/**
 * Test seam: replace the candidate sequence (pass undefined to restore the
 * production list). Lets a test prove the fallback chain — first candidate
 * rejects the Session brand, second accepts — without a second real install.
 */
export function setAppenderCandidatesForTest(inputs: readonly AppenderCandidateInput[] | undefined): void {
  if (inputs === undefined) {
    testCandidates = undefined
    return
  }
  testCandidates = inputs.map((input, index) => ({
    index,
    kind: input.kind ?? 'test',
    path: input.path ?? input.kind ?? `candidate-${index}`,
    get: () => input.append,
  }))
}

function activeCandidates(): AppenderCandidate[] {
  return testCandidates ?? productionCandidates
}

interface AttemptReport {
  /** Debug label of the candidate that accepted the record (null on failure). */
  candidate: string | null
  /** One truncated error excerpt per rejected candidate. */
  errors: string[]
}

/** Outcome of the last `defaultAppender` call (read by `publishGoals`). */
let lastAttempt: AttemptReport | undefined

/**
 * Append the resolution/load outcome to
 * `<workspace>/.cybernetics/publish-debug.log` (one JSON line, append mode).
 * Written at most once per workspace root, as soon as both the root and the
 * dynamic-candidate outcome are known — a multi-workspace host gets one line
 * per workspace, each readable after a restart. Observability only: any
 * failure is ignored.
 */
function flushPublishDebug(): void {
  const root = debugRoot
  if (root === undefined || !hostSettled || debugWritten.has(root)) return
  debugWritten.add(root)
  appendDebugRecord({
    at: new Date().toISOString(),
    event: 'host-session',
    specifier: MODULE_SPECIFIER,
    argv1: resolution.argv1 ?? null,
    ownPath: resolution.ownPath ?? null,
    hostPath: resolution.hostPath ?? null,
    resolvedFrom: resolution.resolvedFrom ?? null,
    needsHostImport: resolution.needsHostImport,
    hostAppendReady: hostCopy?.copy.appender !== undefined,
    pluginPath: pluginSessionCopyPath ?? null,
    pluginAppendReady: pluginCopy?.copy.appender !== undefined,
    error: resolution.error ?? dynamicLoadError() ?? null,
  })
}

/**
 * Point the records at a workspace root (only the caller knows it — a session
 * header's `cwd`, or dsh's working directory service). The resolution line is
 * idempotent per root; publish lines are appended per publish.
 */
export function setPublishDebugRoot(root: string | undefined): void {
  if (typeof root !== 'string' || root.length === 0) return
  debugRoot = root
  flushPublishDebug()
}

/** Diagnostic view of the copy resolution / load state (no side effects). */
export function hostSessionStatus(): HostSessionResolution & {
  hostAppendReady: boolean
  pluginAppendReady: boolean
  pluginPath?: string
  loadError?: string
} {
  const loadError = dynamicLoadError()
  return {
    ...resolution,
    hostAppendReady: hostCopy?.copy.appender !== undefined,
    pluginAppendReady: pluginCopy?.copy.appender !== undefined,
    ...(pluginSessionCopyPath !== undefined ? { pluginPath: pluginSessionCopyPath } : {}),
    ...(loadError !== undefined ? { loadError } : {}),
  }
}

/**
 * Production appender: try every candidate in order, first success wins. The
 * Session class comes from exactly one module copy, so the static import can
 * reject the host's Session while the host copy accepts it (or vice versa).
 * Only when every candidate rejects do we throw the LAST error — the publish
 * contract (`failed`, round unaffected) is unchanged.
 */
const defaultAppender: RecordAppender = (session, type, data) => {
  const errors: string[] = []
  let lastError: unknown
  for (const candidate of activeCandidates()) {
    const append = candidate.get()
    if (append === undefined) continue
    try {
      const result = append(session, type, data)
      lastAttempt = { candidate: candidateLabel(candidate), errors }
      return result
    } catch (cause) {
      lastError = cause
      errors.push(`${candidateLabel(candidate)}: ${truncate(errorText(cause), MAX_DEBUG_ERROR_CHARS)}`)
    }
  }
  lastAttempt = { candidate: null, errors }
  throw lastError ?? new Error('no appender candidate is available')
}
let recordAppender: RecordAppender = defaultAppender
/** Test seam: replace the plugin-record appender (pass undefined to restore). */
export function setRecordAppender(appender: RecordAppender | undefined): void {
  recordAppender = appender ?? defaultAppender
}

/**
 * Append one per-session mode override as an ignorable plugin record
 * (`plugin:cybernetics/mode { enabled }`). The plain `Session.append` path the
 * v0.9.0 `/cybernetics` command used persists the event WITHOUT the envelope
 * `ignorable` marker, so any harness build that does not know the type
 * fail-closes on load (storage-contract.ts:75) and the whole session becomes
 * unloadable. `appendPluginRecord` stamps `ignorable: true`, which every
 * reader may safely skip. Throws on failure — the caller surfaces the error
 * to the user instead of silently losing the override.
 * @param session - the invoking agent's session.
 * @param type - the plugin record type (kept a parameter so this zero-dep
 *   module stays free of a sessionMode.ts value import; the caller passes
 *   `MODE_EVENT_TYPE` = `plugin:cybernetics/mode`).
 * @param data - the payload ({ enabled }).
 */
export function appendModeRecord(session: unknown, type: string, data: unknown): unknown {
  return recordAppender(session, type, data)
}

/** Outcome of one publish attempt. */
export type PublishResult = 'published' | 'unchanged' | 'skipped' | 'failed'

/**
 * Record the outcome of one publish. Paths/results only: the goal payload is
 * never written to the log.
 */
function appendPublishRecord(result: 'published' | 'failed', report: AttemptReport | undefined): void {
  appendDebugRecord({
    at: new Date().toISOString(),
    event: 'publish',
    result,
    candidate: report?.candidate ?? null,
    errors: report?.errors ?? [],
  })
}

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
  // Best-effort workspace hint for the debug records: a real Session carries
  // its cwd in the header, so the log lands in the right `.cybernetics/` even
  // when the caller cannot pass the root itself.
  const cwd = target.header?.cwd
  if (typeof cwd === 'string') setPublishDebugRoot(cwd)
  const json = JSON.stringify(state)
  if (published.get(target) === json) return 'unchanged'
  const usingCandidates = recordAppender === defaultAppender
  try {
    recordAppender(target, EVENT_TYPE, state)
  } catch (cause) {
    // A non-loggable payload (or a session mid-teardown) must not fail the
    // round that produced it; the tab simply keeps the previous snapshot.
    appendPublishRecord('failed', usingCandidates
      ? lastAttempt
      : { candidate: null, errors: [`injected: ${truncate(errorText(cause), MAX_DEBUG_ERROR_CHARS)}`] })
    return 'failed'
  }
  published.set(target, json)
  appendPublishRecord('published', usingCandidates ? lastAttempt : { candidate: 'injected', errors: [] })
  return 'published'
}
