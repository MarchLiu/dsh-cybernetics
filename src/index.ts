/**
 * The `dsh-cybernetics` plugin entry: registers the `cybernetics` tool that
 * runs one goal-driven work round (task agent -> verify agent -> triage
 * agent) against the SESSION's durable goal (dsh-goal service), then reports
 * the controller's continue/pause decision.
 *
 * Design (v0.2):
 * - The goal is the session agent's own thinking product, persisted via the
 *   dsh-goal service (create/edit are model verbs). Users calibrate through
 *   conversation; the calling model revises the goal. No goal file.
 * - Implicit triggering: a system-prompt section tells the model to maintain
 *   a session goal for substantial tasks and advance it with this tool
 *   without an explicit ask.
 * - Roles: `roles` config maps sub-agent roles ('default'/'verify'/'triage'
 *   or named task roles like 'frontend') to provider/model overrides.
 *
 * Zero runtime dependencies on @deepseek-ai packages: the tool registers a
 * plain ToolDefinition (raw JSON Schema, inline validation) so this directory
 * can be `link:`-installed into a dsh profile without its own node_modules.
 * Type-only imports are erased by Node's type stripping. Node >= 23.6.
 * @module dsh-cybernetics
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import {
  STATE_DIR, createGoal, decideAbort, foldRound, parseAgentModelSpec, runRound, startRound, supersedeGoal, writeRevisionLog,
} from './controller.ts'
import type {
  ControllerConfig, ControllerDecision, LoopState, ResumableReason, RoundResult, RolesConfig,
} from './controller.ts'
import { startTeamRound, teamExecutorAvailable, teamExecutorUnavailableError } from './executor.ts'
import { cyberneticsGoalsProjection, goalsFromBoard, publishGoals, setPublishDebugRoot } from './projection.ts'

export const name = 'dsh-cybernetics'

export const inject = [
  'tools',
  'systemPrompt',
  'goals',
  'workingDirectory',
  'agentPresets',
  'agents',
  'sessionProjections',
] as const
// All seven are ROOT-level services (goal / working-directory / agent-preset-registry
// / agents / session-projection registry are top-level loader entries) — static
// inject cannot pend at boot. `sessionProjections` is the registry dsh-goal
// itself injects at root; this plugin registers the `cyberneticsGoals` unit
// there so every goal on the board reaches the「目标」tab (v0.6).
// `workflowEngine` is different: it is published inside each Agent's preset
// mount (the `delegation` group with isolate workflowEngine: true), invisible
// to the root scope. It is resolved per call via
// `ctx.agentPresets.serviceFor(agent, 'workflowEngine')` — the registry API
// built exactly for reading preset-isolated services from the root realm.
// History: statically injecting workflowEngine at a top-level entry hung boot
// ("waiting for service: workflowEngine"), and mounting the whole plugin
// inside preset-standard hid it from the client-module scan (the「目标」tab
// never registered because the boot graph enumerates only top-level entries).

/** Deployment-varying choices; protocol bounds live in docs/protocol.md. */
export interface Config extends ControllerConfig {
  /** Model-facing tool name (default `cybernetics`). */
  toolName?: string
  /** Inject the implicit goal-loop guidance section (default true). */
  implicitTrigger?: boolean
  /** Per-role sub-agent model/provider overrides. */
  roles?: RolesConfig
  /** Flat task-agent model override ("provider/model" or bare model); empty = inherit session agent. */
  taskAgentModel?: string
  /** Flat verify-agent model override (same format); empty = inherit session agent. */
  verifyAgentModel?: string
  /** Flat triage-agent model override (same format); empty = inherit session agent. */
  triageAgentModel?: string
  /**
   * Hard orchestration gate (default false): hide execution tools from
   * TOP-LEVEL session agents at prompt-assembly time, so the session agent
   * structurally cannot do task work itself — every task must go through a
   * cybernetics goal + task agent. Task/verify/triage subagents (never in
   * `agents.roots()`) are unaffected and keep full tool access.
   */
  hardGate?: boolean
  /** Tool names hidden from gated agents (default ['bash', 'edit', 'write']). */
  gatedTools?: string[]
  /**
   * Gate semantics: 'denylist' hides `gatedTools`; 'allowlist' keeps ONLY
   * `gateAllowlist` (default DEFAULT_GATE_ALLOWLIST) plus the cybernetics
   * tool itself — the robust stance against the long tail of mutation tools
   * (farm_*, taskboard_*, knowledge_save, schedule_*, ...).
   */
  gateMode?: 'denylist' | 'allowlist'
  /** Allowlist-mode survival set; defaults to DEFAULT_GATE_ALLOWLIST. */
  gateAllowlist?: string[]
  /** Extra tool names unioned onto the allowlist (default or gateAllowlist). */
  gateAllowlistExtra?: string[]
  /**
   * All-goals mode (v0.7, default false): EVERY user request — including
   * trivial read-only questions and lightweight analysis — must go through a
   * cybernetics goal first; in-place analysis by the session agent is banned.
   * Off (default) keeps the v0.6 implicit-trigger behavior exactly unchanged.
   */
  allGoalsMode?: boolean
  /**
   * Max concurrent rounds across ALL sessions (default 0 = unlimited): a new
   * round (blocking, 'start' or 'revise') is refused while this many rounds
   * are in flight, protecting the host from parallel-agent storms.
   */
  maxConcurrentRounds?: number
}

// Under the host's 0.1.7 settings model, an exported schemastery `Config`
// schema IS the plugin entry's settings page: the Web editor derives the
// plugin config form from it and serves it through the shared configuration
// forms (see @linxin666/dsh-ssh and @linxin666/dsh-usage for the same
// pattern). At least one field must be `.volatile()` for the page to be
// served at all; a volatile edit is committed into the running fiber's
// reference without a remount and announced via `loader/volatile-update`.
// The user-facing knobs (taskAgentModel / verifyAgentModel / triageAgentModel /
// roundsPerSubgoal / maxConcurrentRounds / allGoalsMode) are all
// volatile so they are visible AND writable in the settings panel and take
// effect on the next goal round. roles stays in the schema but is NOT
// volatile (v0.8.4): the panel serves only volatile fields, so it no longer
// shows in the GUI — advanced users (agent-guided) configure it directly in
// the profile config yaml; a host reload applies it. hardGate and the gate fields stay non-volatile: the panel
// cannot write them (they change structural wiring — tool stripping listener —
// so they belong in the profile config document instead).
export const Config = z.object({
  /** Model-facing tool name. */
  toolName: z.string().default('cybernetics').description('模型侧工具名（缺省 cybernetics）。'),
  /** Inject the implicit goal-loop guidance section. */
  implicitTrigger: z.boolean().default(true).description('注入隐式 goal-loop 系统提示段（缺省开启）。'),
  /**
   * Per-role sub-agent model/provider overrides: role -> {provider, model}.
   * v0.8.4: NOT volatile — the settings card no longer exposes the roles JSON
   * textarea (hand-editing JSON in the GUI is unfriendly), and the host panel
   * serves only volatile fields, so a non-volatile roles simply disappears
   * from the GUI while remaining configurable in the profile config yaml
   * (save triggers a plugin-row remount / host reload, which is fine for an
   * advanced setting an agent guides the user through). Runtime semantics are
   * unchanged: readConfigField accepts a plain object (non-volatile) exactly
   * like a live reference (volatile), and named task roles keep working.
   */
  roles: z.dict(z.object({
    provider: z.string(),
    model: z.string(),
  })).description('按角色的子 agent provider/model 覆盖：role -> {provider, model}（如 default/verify/triage/frontend）。高级配置：直接编辑 profile 配置 yaml 后需宿主重载生效（GUI 不再提供此字段的编辑控件）。'),
  /**
   * Flat task-agent model override ("provider/model" or a bare model name).
   * Empty = inherit the session agent. Merged over roles.default at wiring
   * time (parseAgentModelSpec) — the flat fields are the settings-panel face;
   * roles stays the canonical runtime shape the round script consumes.
   * Volatile (v0.7.7): the host settings form (@deepseek-ai/dsh-settings
   * volatileForm, lib/index.js:122-131) serves ONLY `.volatile()` fields, and
   * its write() refuses any non-volatile path ("Config field ... is not
   * volatile") — a plain field is invisible AND unwritable on the plugins
   * page. Volatile commit keeps the running instance live; the value is read
   * per round start (readConfigField unwrap below), so an edit takes effect
   * on the next goal round without a remount.
   */
  taskAgentModel: z.string().default('').volatile().description('task agent 模型覆盖（「provider/model」或裸模型名）；留空 = 与 session agent 一致。保存后下一轮 goal 即生效，无需重载。'),
  /** Flat verify-agent model override; same format, fallback and volatile semantics as taskAgentModel. */
  verifyAgentModel: z.string().default('').volatile().description('verify agent 模型覆盖（「provider/model」或裸模型名）；留空 = 与 session agent 一致。保存后下一轮 goal 即生效，无需重载。'),
  /**
   * Flat triage-agent model override (v0.8.2); identical shape, fallback and
   * volatile semantics as taskAgentModel/verifyAgentModel. The triage role
   * reads the task/verify results and produces the round's convergence
   * decision (met / continue / human-input / ...); quick-depth rounds skip
   * verify+triage entirely, so this override only ever fires on full rounds.
   */
  triageAgentModel: z.string().default('').volatile().description('triage agent 模型覆盖（「provider/model」或裸模型名）；留空 = 与 session agent 一致。triage 角色读 task/verify 结果输出本轮收敛决策（met/continue/human-input 等）；quick 轮不启用。保存后下一轮 goal 即生效，无需重载。'),
  /**
   * Max consecutive rounds per subgoal before the loop pauses for the user
   * (controller round-cap, default 3). Volatile: read per round start, so the
   * panel edit governs the very next goal round without a remount.
   */
  roundsPerSubgoal: z.number().default(3).volatile().description('同一子目标的最大连续轮数（递归深度上限，缺省 3）：超过即暂停并升级给用户。保存后下一轮 goal 即生效，无需重载。'),
  /**
   * Max concurrent rounds across all sessions (default 0 = unlimited).
   * Volatile: enforced at every launch, live on the next tool call.
   */
  maxConcurrentRounds: z.number().default(0).volatile().description('全局并行轮数上限（缺省 0 = 不限）：在跑轮数达到上限时拒绝启动新一轮，防止并行风暴。保存后即时生效，无需重载。'),
  /** Hard orchestration gate (default false). */
  hardGate: z.boolean().default(false).description('硬编排门：装配期从顶层 session agent 摘除执行工具，所有改动必须经 cybernetics goal + task agent。修改会触发插件重载。'),
  /** Tool names hidden in denylist mode (default DEFAULT_GATED_TOOLS). */
  gatedTools: z.array(z.string()).description('denylist 模式下隐藏的工具名（缺省内置 DEFAULT_GATED_TOOLS）。'),
  /** Gate semantics. */
  gateMode: z.union(['denylist', 'allowlist'] as const).default('denylist').description('门语义：denylist 隐藏 gatedTools；allowlist 只保留 gateAllowlist（+gateAllowlistExtra）与 cybernetics 工具本身。'),
  /** Allowlist-mode survival set (default DEFAULT_GATE_ALLOWLIST). */
  gateAllowlist: z.array(z.string()).description('allowlist 模式生存工具集（缺省内置 DEFAULT_GATE_ALLOWLIST）。'),
  /** Extra tool names unioned onto the allowlist. */
  gateAllowlistExtra: z.array(z.string()).description('并集追加进 allowlist 的额外工具名。'),
  /**
   * All-goals mode (v0.7, default false): every user request must go through
   * a cybernetics goal first. Volatile: the settings-panel toggle commits
   * into the running instance without a remount.
   */
  allGoalsMode: z.boolean().default(false).volatile()
    .description('全目标模式（v0.7，缺省关）：所有用户请求（含只读问题）都必须先经 cybernetics goal。开关在面板上保存后即时生效，无需重载。'),
})

/** One resolved config field: a live reference (volatile), or a plain value. */
type ConfigField<T> = { get(): T } | T

/** Read one resolved config field, following the live reference the schema produces for volatile fields. */
function readConfigField<T>(field: ConfigField<T> | undefined, fallback: T): T {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof (field as { get?: unknown }).get === 'function') {
    const value = (field as { get(): T }).get()
    return value === undefined ? fallback : value
  }
  return field as T
}

/**
 * Multi-goal loop registry: session -> goalId -> loop. v0.3 lifts the
 * single-goal limit of dsh-goal (one slot per session) by keeping the
 * plugin's own goal board; the dsh-goal slot remains the FOCUS goal (GUI
 * tab + goal-round-driver auto-continuation) and is synced best-effort.
 */
const boards = new Map<unknown, Map<string, LoopState>>()

/** One in-flight async round (action 'start'), keyed by goalId. */
interface RunningRound {
  goalId: string
  round: number
  parent: any
  root: string
  loop: LoopState
  config: ControllerConfig
  run: { result: Promise<any>; cancel(reason?: string): void; dispose(): Promise<void> }
  settled?: { stopReason: string; value?: unknown; error?: unknown }
  /** Set once the run has been disposed (cancel-by-revision and collect can race). */
  disposed?: boolean
}
const running = new Map<string, RunningRound>()

/** Dispose a run at most once; disposal is best-effort observability cleanup. */
async function disposeOnce(handle: RunningRound): Promise<void> {
  if (handle.disposed) return
  handle.disposed = true
  try {
    await handle.run.dispose()
  } catch {
    // An already-settled or torn-down run must not fail the calling action.
  }
}

// --- v0.6 board persistence / rehydrate -------------------------------------
// The `boards` map above is process memory, and the `cyberneticsGoals`
// projection only replays session events written by SOME process. After a host
// restart the map is empty and — when the previous process never published (or
// the log was not yet replayed) — so is the tab: every historical goal seems to
// have vanished and the user can no longer track goals separately. Each
// session's board therefore snapshots itself next to the round logs at
// `<workspace>/.cybernetics/board-<sessionId>.json`, and the first tool call of
// a session with an empty memory board restores it and republishes once.
//
// Persistence is durability, never workflow control: both directions swallow
// their errors (a read-only workspace still runs rounds; a corrupt snapshot
// degrades to a fresh board instead of failing the call).

/** Snapshot format version; a mismatch is treated as "no snapshot". */
export const BOARD_FILE_VERSION = 1

/** On-disk board snapshot: the controller's whole goal board for one session. */
export interface BoardFile {
  version: number
  sessionId: string
  /** Epoch milliseconds of the snapshot write. */
  savedAt: number
  goals: LoopState[]
}

const BOARD_STATUSES: ReadonlySet<string> = new Set(['running', 'paused', 'met', 'cancelled', 'superseded'])
const PAUSE_REASONS: ReadonlySet<string> = new Set([
  'goal-questionable', 'human-input', 'round-cap', 'failed', 'no-goal',
])
const UNSAFE_FILENAME = /[^a-zA-Z0-9._-]/g

/** Snapshot file name for one session (ids are slugged: never a path escape). */
export function boardFileName(sessionId: string): string {
  return `board-${sessionId.replace(UNSAFE_FILENAME, '_')}.json`
}

/** Absolute snapshot path under the workspace root. */
export function boardFilePath(root: string, sessionId: string): string {
  return join(root, STATE_DIR, boardFileName(sessionId))
}

/**
 * Normalize one persisted goal back into a LoopState. Anything that is not a
 * usable goal record (no goalId, wrong shape) is dropped, so a partially
 * hand-edited or half-written snapshot still yields a usable board.
 */
function restoreLoop(raw: unknown): LoopState | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const g = raw as Record<string, unknown>
  if (typeof g.goalId !== 'string' || g.goalId.length === 0) return undefined
  const loop: LoopState = {
    goalId: g.goalId,
    round: typeof g.round === 'number' && Number.isFinite(g.round) ? g.round : 0,
    doneSummary: typeof g.doneSummary === 'string' ? g.doneSummary : '',
    subgoal: typeof g.subgoal === 'string' ? g.subgoal : '',
    role: typeof g.role === 'string' && g.role.length > 0 ? g.role : 'default',
  }
  if (typeof g.title === 'string') loop.title = g.title
  if (typeof g.objective === 'string') loop.objective = g.objective
  if (typeof g.brief === 'string') loop.brief = g.brief
  if (g.depth === 'quick' || g.depth === 'full') loop.depth = g.depth
  if (g.executor === 'ephemeral' || g.executor === 'persistent') loop.executor = g.executor
  if (typeof g.memberName === 'string' && g.memberName.length > 0) loop.memberName = g.memberName
  if (typeof g.status === 'string' && BOARD_STATUSES.has(g.status)) loop.status = g.status as LoopState['status']
  if (g.paused !== null && typeof g.paused === 'object' && !Array.isArray(g.paused)) {
    const p = g.paused as Record<string, unknown>
    if (typeof p.reason === 'string' && PAUSE_REASONS.has(p.reason) && typeof p.note === 'string') {
      loop.paused = { reason: p.reason as ResumableReason, note: p.note }
    }
  }
  if (typeof g.parentGoalId === 'string' && g.parentGoalId.length > 0) loop.parentGoalId = g.parentGoalId
  if (typeof g.supersededBy === 'string' && g.supersededBy.length > 0) loop.supersededBy = g.supersededBy
  if (Array.isArray(g.revisions)) {
    loop.revisions = []
    for (const entry of g.revisions) {
      if (entry === null || typeof entry !== 'object') continue
      const r = entry as Record<string, unknown>
      loop.revisions.push({
        version: typeof r.version === 'number' && Number.isFinite(r.version) ? r.version : 0,
        reason: typeof r.reason === 'string' ? r.reason : '',
        at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0,
      })
    }
  }
  return loop
}

/**
 * Read one session's board snapshot. Missing file, unreadable file, invalid
 * JSON, a different format version or a foreign session id all mean "no
 * history" — this function never throws.
 */
export async function loadBoardFile(root: string, sessionId: string): Promise<LoopState[] | undefined> {
  let text: string
  try {
    text = await readFile(boardFilePath(root, sessionId), 'utf8')
  } catch {
    return undefined // no snapshot: a genuinely fresh session
  }
  try {
    const parsed = JSON.parse(text) as Partial<BoardFile> | null
    if (parsed === null || typeof parsed !== 'object') return undefined
    if (parsed.version !== BOARD_FILE_VERSION) return undefined
    if (typeof parsed.sessionId === 'string' && parsed.sessionId !== sessionId) return undefined
    if (!Array.isArray(parsed.goals)) return undefined
    const out: LoopState[] = []
    const seen = new Set<string>()
    for (const raw of parsed.goals) {
      const loop = restoreLoop(raw)
      if (loop === undefined || loop.goalId === undefined || seen.has(loop.goalId)) continue
      seen.add(loop.goalId)
      out.push(loop)
    }
    return out
  } catch {
    return undefined // corrupt snapshot: behave like an empty board
  }
}

/**
 * Atomically snapshot one session's board (temp file + rename, so a concurrent
 * reader never sees a half-written JSON). Returns the snapshot path, or
 * undefined when the write failed — never throws.
 */
export async function saveBoardFile(
  root: string,
  sessionId: string,
  loops: Iterable<LoopState>,
): Promise<string | undefined> {
  const file = boardFilePath(root, sessionId)
  const payload: BoardFile = {
    version: BOARD_FILE_VERSION,
    sessionId,
    savedAt: Date.now(),
    goals: [...loops],
  }
  const tmp = `${file}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`
  try {
    await mkdir(join(root, STATE_DIR), { recursive: true })
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
    return file
  } catch {
    return undefined
  }
}

/** Minimal required-field validation the omitted dsh-tools wrapper would do. */
function requireFields(args: Record<string, unknown>, names: string[]): void {
  for (const n of names) {
    if (args[n] === undefined) throw new Error(`cybernetics: missing required argument "${n}"`)
  }
}

const IMPLICIT_GUIDANCE = `Goal-driven orchestration (cybernetics). You are the SESSION agent: you never execute task work
yourself — you manage goals and the task agents that execute them. Classify each user input:
- TRIVIAL READ-ONLY QUESTION (a fact your read tools answer directly, no computation) → answer inline, no goal.
- LIGHTWEIGHT ANALYSIS (a bounded query/lookup needing tool work but no multi-step planning) → create a goal
  with depth 'quick': one task-agent round, feed the result back directly.
- COMPLEX ANALYSIS (data fetching to disk, datasets, statistics, multi-step query planning) and ANY
  WORLD-CHANGING TASK → create a goal with depth 'full' (default): the work-verify loop must confirm the
  result before you deliver it. Never shortcut a change or a complex analysis through a quick round.
- For goals: call cybernetics with action 'start' (non-blocking) or 'round' (blocking), a short title, and
  a brief — the COMPLETE work order extracted from the request (background, paths, constraints, acceptance
  criteria). The task agent is an independent subagent with NO conversation history; the brief must be
  detailed enough for it to finish the work unaided. One session supports multiple concurrent goals.
- EXECUTOR (new): pass executor 'persistent' for goals whose rounds should accumulate context across
  iterations (multi-turn analysis by a durable teammate — the member keeps its identity and findings
  while you keep the dialogue). Default 'ephemeral' runs each round as fresh workflow subagents, which
  is right for one-shot work and changes. Persistent rounds still verify (full depth) through ephemeral
  verifiers, so verification never inherits the task narrative.
- CORRECTION to an existing task → an APPEND-ONLY goal revision: call action 'revise' with the old goalId, a
  required reason, the new objective when the goal itself changed (omit it to inherit), and optionally a new
  title / depth / executor. 'revise' creates a NEW goal (parentGoalId = old goal) and starts its first round;
  the old goal keeps its final state as 'superseded'. Pass abortPrevious: true only when the session agent
  decides the old goal's in-flight task agent must be interrupted (default: let it finish; the abort reuses
  the 'cancel' path, and 'cancel' on its own still stops a round without revising the goal).
  NEVER edit a goal's objective in place — 'revise' is the only goal-change verb, and only after the user
  has confirmed the change in conversation.
- FEEDBACK arrives as the tool result ('round') or, for async rounds, as a queued notification followed by
  action 'collect'. Then choose: summarize the outcome to the user; start a verification round; or start a
  corrective round whose brief is built from the verdict gaps. On decision 'continue', launch the next
  round with the returned subgoal. On 'pause': 'met' = report and wait for user confirmation;
  'goal-questionable' = re-examine the goal through dialogue; 'human-input' = surface the question;
  'round-cap'/'failed' = report status. Never mark a goal complete yourself; completion is the user's act.
Use action 'list' to see every goal on this session's board with its status, round and subgoal.`

/**
 * v0.7 all-goals mode addendum: turns the implicit trigger from "suggest a
 * goal for substantial tasks" into "every request is a goal". Contains the
 * four routing rules the protocol and tests pin down:
 * (1) everything enters a goal; (2) simple read-only → 'quick' single round;
 * (3) complex analysis / write tasks → progressive multi-round ('full');
 * (4) the revise auto-abort decision tree.
 */
const ALL_GOALS_GUIDANCE = `
ALL-GOALS MODE ACTIVE (routing protocol — no exceptions, no in-place analysis):
- RULE 1 — EVERYTHING ENTERS A GOAL: for ANY user request (question, lookup, analysis, change), first
  create a goal via cybernetics (action 'start' with title + brief), then let the task agent produce the
  answer. NEVER answer a request by doing the task work yourself with read tools — even a one-file lookup
  or a quick calculation goes through the loop. If a change is requested while the hard gate is off, the
  protocol still forbids in-place edits: delegate.
- RULE 2 — SIMPLE READ-ONLY REQUEST → depth 'quick': one task-agent round, no verify/triage, feed the
  result straight back to the user (bounded lookups, single-file reads, small queries).
- RULE 3 — COMPLEX ANALYSIS or WRITE TASK → depth 'full', progressive multi-round: launch with action
  'start' (async), then 'collect' each settled round and advance the subgoal round by round (task →
  verify → triage). Analysis: data fetching to disk, datasets, statistics, multi-step query planning.
  Write tasks additionally rely on the hard gate: the session agent must NEVER execute a change itself —
  delegation through the goal loop is the only path, however small the change.
- RULE 4 — REVISE DECISION TREE (updating an existing goal stays append-only: a new goal with
  parentGoalId, old goal superseded; 'revise' is the only goal-change verb). Decide abortPrevious by the
  old task agent's state (check with action 'list'):
  (a) old round STILL RUNNING and the revision contradicts it (objective/depth rewritten — conflicting
      goals / write-domain overlap) → let 'revise' auto-abort: do not pass abortPrevious; the plugin
      cancels the old round automatically;
  (b) old round STILL RUNNING but the correction keeps the objective (brief/title/role only) and the old
      work stays valuable / parallelizable / reusable → do not pass abortPrevious; the plugin waits for
      the old round to finish naturally;
  (c) old task agent ALREADY FINISHED (goal not running on the board) → just call 'revise'; no abort is
      needed and none is attempted.
  The chosen branch and its reason are recorded in the .cybernetics/revisions-<newGoalId>.jsonl audit
  line (abort.mode = auto|explicit + basis). Passing abortPrevious explicitly keeps manual control.`

/** Tool names hidden from top-level session agents when the hard gate is on. */
const DEFAULT_GATED_TOOLS = ['bash', 'edit', 'write']

/**
 * Allowlist-mode survival set for top-level orchestrator agents: pure reads,
 * conversation, presentation and goal/orchestration verbs. Anything that
 * changes the world — files, services, boards, knowledge, schedules, docs,
 * other agents' work — is absent, so the session agent must delegate it to a
 * cybernetics task agent. The cybernetics tool itself is always re-added.
 */
const DEFAULT_GATE_ALLOWLIST = [
  // local reads & search
  'read', 'read_image', 'read_pdf', 'glob', 'grep', 'working_directory',
  // web reads
  'web_fetch', 'web_search', 'websearch',
  // conversation & presentation
  'ask_user_question', 'skill', 'todo_write',
  'render_ui', 'validate_dsh_ui', 'visualize', 'ui_present', 'present', 'sidebar_open',
  // goal verbs (orchestrator's own)
  'create_goal', 'update_goal', 'get_goal',
  // knowledge reads
  'knowledge_query', 'knowledge_get', 'knowledge_search', 'knowledge_graph',
  'knowledge_status', 'knowledge_stats', 'knowledge_chart',
  // photostory (read-only plugin)
  'photostory_search', 'photostory_search_text', 'photostory_photo_get',
  'photostory_photo_faces', 'photostory_person_get', 'photostory_person_query',
  'photostory_person_search', 'photostory_tags', 'photostory_stats',
  'photostory_status', 'photostory_zdisk_list', 'photostory_zdisk_file',
  'photostory_download',
  // service/board reads
  'farm_status', 'farm_logs', 'taskboard_list', 'taskboard_get', 'taskboard_comments',
  // team/session reads
  'list_agents', 'wait_agent', 'team_task_list', 'team_task_get',
  'graft_read', 'graft_search', 'graft_sessions', 'dsh_im_group_history', 'dsh_im_group_file',
  // misc reads
  'schedule_list', 'job_list', 'job_output', 'audit_status',
  'config_list_snapshots', 'uno_read', 'uno_status',
  'univer_api', 'univer_inspect', 'univer_status', 'univer_lint', 'univer_resources',
  'browser_tabs', 'browser_snapshot', 'browser_console', 'browser_network',
  'browser_screenshot', 'browser_navigate', 'browser_scroll',
]

const HARD_GATE_GUIDANCE = `
HARD GATE ACTIVE: your tool list is restricted to reading, searching, conversation, presentation and
goal/orchestration verbs — every tool that CHANGES the world (edit/write/bash, service lifecycle,
board/knowledge/schedule writes, spawning other workers, ...) is STRUCTURALLY unavailable to you.
Answering a read-only question directly is fine and needs no goal; but the moment the user asks for a
change — however small — that is your signal to delegate: create a cybernetics goal (action 'start'
with title+brief) and let a task agent execute it. Never tell the user a change is "too small for the
loop": the loop is the only way changes get done. If you look for a tool to perform a change and do
not find it, that is the gate working as intended — delegate instead.`

export function apply(ctx: any, config: Partial<Config> = {}) {
  const toolName = config.toolName ?? 'cybernetics'
  const hardGate = config.hardGate === true
  // allGoalsMode is a volatile field: under the loader's schema resolution it
  // arrives as a live reference whose value the settings panel commits in
  // place (no remount), so read it at use time instead of capturing it once.
  const allGoalsMode = () => readConfigField(config.allGoalsMode, false) === true
  const disposers: Array<() => void> = []

  // v0.6: register the multi-goal session projection, so every goal on the
  // session board — not just dsh-goal's single focus slot — reaches the
  // 「目标 / Goal」tab. The registration rides this plugin's fiber: unloading
  // the plugin removes the key and the tab falls back to the `goal` face.
  // Guarded because the offline harness (and any host without the projection
  // seam) builds a ctx without `sessionProjections`.
  const projections = ctx.sessionProjections as
    | { register?: (definition: unknown) => () => void }
    | undefined
  if (projections !== undefined && typeof projections.register === 'function') {
    const projectionDisposer = projections.register(cyberneticsGoalsProjection())
    if (typeof projectionDisposer === 'function') disposers.push(projectionDisposer)
  }

  // The implicit guidance section embeds the volatile allGoalsMode wording,
  // so it must be re-derived when a settings-panel toggle is committed into
  // the running instance (the loader announces loader/volatile-update on this
  // fiber instead of remounting; same re-derive pattern as dsh-ssh's sync()).
  let disposeSection: (() => void) | undefined
  function registerGuidanceSection() {
    if (disposeSection !== undefined) disposeSection()
    disposeSection = undefined
    if (config.implicitTrigger === false) return
    disposeSection = ctx.systemPrompt.section({
      name: `tool:${toolName}`,
      order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
      text: IMPLICIT_GUIDANCE + (allGoalsMode() ? ALL_GOALS_GUIDANCE : '') + (hardGate ? HARD_GATE_GUIDANCE : ''),
    })
  }
  registerGuidanceSection()
  disposers.push(() => { if (disposeSection !== undefined) disposeSection() })
  ctx.on?.('loader/volatile-update', () => { registerGuidanceSection() })

  if (hardGate) {
    // The hard gate: a system-prompt/assemble waterfall listener that strips
    // execution tools from TOP-LEVEL agents' assemblies. Workflow subagents
    // (task/verify/triage) and team teammates are never in agents.roots(),
    // so their assemblies pass through untouched with full tool access.
    const allowlistMode = config.gateMode === 'allowlist'
    // NOTE: schema-resolved config turns an unset z.array field into [] (not
    // undefined), so fall back on length, not on ?? — otherwise the gate
    // would silently keep/gate nothing.
    const keep = new Set([
      ...(config.gateAllowlist?.length ? config.gateAllowlist : DEFAULT_GATE_ALLOWLIST),
      ...(config.gateAllowlistExtra ?? []),
      toolName,
    ])
    const gated = new Set(config.gatedTools?.length ? config.gatedTools : DEFAULT_GATED_TOOLS)
    const listenerDisposer = ctx.on('system-prompt/assemble', (assembly: any, context: any, next: () => unknown) => {
      const scope = context?.scope
      if (!scope) return next()
      let roots: unknown[] = []
      try { roots = ctx.agents?.roots?.() ?? [] } catch { roots = [] }
      const isRoot = roots.some((r: any) =>
        r === scope || r?.id === scope || (r?.id && r.id === scope?.id))
      // Fallback for agents the registry does not list as roots (a resumed
      // session's agent, for example): a session with no parentSession is a
      // top-level session and belongs on the orchestrator side of the gate.
      // Delegated children (workflow subagents, team members) carry
      // `origin: subagent` + `parentSession` and keep their full tool set.
      const parentSession = (scope as any)?.session?.header?.parentSession
      const isSessionRoot = parentSession === undefined
      if (!isRoot && !isSessionRoot) return next()
      if (Array.isArray(assembly.tools)) {
        assembly.tools = allowlistMode
          ? assembly.tools.filter((t: any) => keep.has(t?.name))
          : assembly.tools.filter((t: any) => !gated.has(t?.name))
      }
      return next()
    })
    disposers.push(() => listenerDisposer?.())

    // Execution-layer gate (the assembly filter above only hides names; the
    // host resolves any registered tool by name, so an unadvertised call must
    // be denied here too). Same root/child rule: a session with no
    // parentSession is orchestrated by the gate; delegated children pass.
    const isGatedAgent = (agent: any): boolean => {
      if (agent === undefined || agent === null || typeof agent !== 'object') return false
      let roots: unknown[] = []
      try { roots = ctx.agents?.roots?.() ?? [] } catch { roots = [] }
      if (roots.some((r: any) => r === agent || r?.id === agent || (r?.id && r.id === agent?.id))) return true
      return agent?.session?.header?.parentSession === undefined
    }
    const preDisposer = ctx.on('tools/pre-execute', (exec: any, next: () => Promise<unknown>) => {
      const name = exec?.name
      if (typeof name !== 'string') return next()
      if (!isGatedAgent(exec?.agent)) return next()
      const blocked = allowlistMode ? !keep.has(name) : gated.has(name)
      if (!blocked) return next()
      return Promise.resolve({
        kind: 'deny',
        reason:
          `cybernetics hard gate: tool "${name}" is not available to the session agent. ` +
          'Delegate the change: create a cybernetics goal (action "start" with title+brief) and let a task agent execute it.',
      })
    })
    disposers.push(() => preDisposer?.())
  }

  const disposer = (ctx.tools as { register: (d: unknown) => () => void }).register({
    name: toolName,
    description:
      'Goal-driven orchestration for the SESSION agent, which never executes task work itself: it manages ' +
      'goals and the independent task agents that execute them. Actions: round (default, blocking) runs one ' +
      'full round (task agent -> verify agent -> triage agent) and returns the controller decision; start ' +
      'launches the round in the background and returns immediately (a completion notice is queued into this ' +
      'session); collect folds a finished background round into its decision; cancel aborts a running round ' +
      '(use when a user correction must interrupt the current task agent); list shows every goal on this ' +
      'session board. New task: pass title + brief (a complete, self-contained work order — the task agent ' +
      'has NO conversation history) to create a goal; one session supports multiple concurrent goals. ' +
      'revise is the ONLY goal-change verb and it is append-only: it creates a NEW goal (parentGoalId = old ' +
      'goal, inherited depth/executor/role/objective unless overridden), starts that goal\'s first round, and ' +
      'marks the old goal superseded (supersededBy = new goal) — it never rewrites the objective in place. ' +
      'Existing goal: pass its goalId. The controller never marks a goal complete — that is the user\'s act.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['round', 'start', 'collect', 'cancel', 'revise', 'list'],
          description: 'round=同步执行一轮（默认）| start=后台启动一轮并立即返回 | collect=折叠已完成的后台轮 | cancel=中止正在运行的轮（修正场景）| revise=追加式修正：为新目标建新 goal 并启动第 1 轮，旧 goal 置 superseded | list=查看本会话全部 goal。',
        },
        goalId: {
          type: 'string',
          description: '目标 goal（list/之前调用返回）；缺省 = 当前 dsh-goal 焦点 goal，或配合 title 新建。',
        },
        title: {
          type: 'string',
          description: '新任务的短标题；提供即创建新 goal（多 goal 并存，各自由 task agent 执行）。',
        },
        brief: {
          type: 'string',
          description:
            '本轮任务的详细内容描述（独立 task agent 的工作委托书）：从当前任务/对话中提取，' +
            '详细到 subagent 无需对话历史即可完整执行——含背景、路径、验收标准。修正场景：把修正内容写进新的 brief。',
        },
        subgoal: {
          type: 'string',
          description: '本轮子目标；缺省沿用上轮决策（首轮取自 goal 本身）。',
        },
        depth: {
          type: 'string',
          enum: ['quick', 'full'],
          description:
            '本轮深度：quick=轻量分析，只跑 task agent 单 agent 一轮出结果直接反馈（跳过 verify/triage）；' +
            'full=完整工作-验证循环（默认）——复杂分析（取数/下载/统计/多步查询规划）与一切变更类任务必须用 full。',
        },
        role: {
          type: 'string',
          description: '本轮 task agent 的角色（对应部署配置 roles 表，如 frontend/backend/writer）；缺省 default。',
        },
        reason: {
          type: 'string',
          description:
            'revise 必填：修订原因（写进 .cybernetics/revisions-<新goalId>.jsonl 审计，并向用户解释为什么换目标）。',
        },
        objective: {
          type: 'string',
          description: 'revise：新 goal 的目标文本；缺省继承旧 goal 的 objective（用于「目标本身被校准」的修订）。',
        },
        abortPrevious: {
          type: 'boolean',
          description:
            'revise：是否中止旧 goal 正在运行的 task agent 轮。缺省时按决策树自动判断（查 goal 板：旧轮在跑且目标被改写→自动中止；旧轮在跑但目标不变→等待自然结束；旧轮未跑→直启）；' +
            '显式传 true/false 保持人工控制（true 复用 cancel 路径）。',
        },
        executor: {
          type: 'string',
          enum: ['ephemeral', 'persistent'],
          description: 'revise：新 goal 的执行者基质，缺省继承旧 goal（当前均为 ephemeral）。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          goalId: { type: 'string' },
          previousGoalId: { type: 'string' },
          revised: { type: 'boolean' },
          abort: { type: 'object' },
          revision: { type: 'object' },
          round: { type: 'number' },
          decision: { type: 'object' },
          result: { type: 'object' },
        },
      },
      render: (_args: unknown, value: any) => {
        if (value.board) {
          const lines = (value.board as any[]).map((g) =>
            `${g.goalId} [${g.status}${g.running ? '/running' : ''}] R${g.round} ${g.title ?? ''} — ${g.subgoal}`)
          return [{ type: 'text', text: lines.length ? lines.join('\n') : '（goal 板为空）' }]
        }
        if (value.revised) {
          return [{
            type: 'text',
            text:
              `goal ${value.previousGoalId} 已置 superseded → 新 goal ${value.goalId}` +
              `（修订自 ${value.previousGoalId}${value.aborted ? '，旧轮已中止' : ''}）；` +
              `新 goal 第 ${value.round} 轮已后台启动，完成后将通知本会话`,
          }]
        }
        if (value.started) return [{ type: 'text', text: `goal ${value.goalId} 第 ${value.round} 轮已后台启动，完成后将通知本会话` }]
        if (value.pending) return [{ type: 'text', text: `goal ${value.goalId} 第 ${value.round} 轮仍在运行` }]
        if (value.cancelled) return [{ type: 'text', text: `goal ${value.goalId} 第 ${value.round} 轮已请求中止：${value.cancelled}` }]
        const d = value.decision
        const line = d?.action === 'continue'
          ? `goal ${value.goalId} 第 ${value.round} 轮完成，继续：${d.subgoal}`
          : `goal ${value.goalId} 第 ${value.round} 轮完成，暂停（${d?.reason}）：${d?.note}`
        return [{ type: 'text', text: line }]
      },
    },
    async execute(args: {
      action?: 'round' | 'start' | 'collect' | 'cancel' | 'revise' | 'list'
      goalId?: string
      title?: string
      brief?: string
      subgoal?: string
      depth?: 'quick' | 'full'
      role?: string
      reason?: string
      objective?: string
      abortPrevious?: boolean
      executor?: 'ephemeral' | 'persistent'
    }, exec: any) {
      requireFields(args as Record<string, unknown>, [])
      const goals = ctx.goals
      const workingDirectory = ctx.workingDirectory
      if (!goals) throw new Error('cybernetics: goals service unavailable — is dsh-goal loaded?')
      if (!workingDirectory) throw new Error('cybernetics: workingDirectory service unavailable')
      const parent = exec.agent
      if (!parent?.session) throw new Error('cybernetics tool requires a calling agent session')
      const root = workingDirectory.get(parent.session)
      const action = args.action ?? 'round'

      const sessionId = typeof parent.session?.id === 'string' && parent.session.id.length > 0
        ? parent.session.id
        : undefined
      const board = boards.get(parent.session) ?? new Map<string, LoopState>()
      boards.set(parent.session, board)

      // v0.6 write point: publish the session's WHOLE board as one
      // `cybernetics/goals` event, so the「目标」tab tracks every goal of this
      // session (dsh-goal's single-slot `goal` projection cannot). Idempotent:
      // republishing an unchanged board appends nothing and never throws.
      // Then snapshot the same board to `<workspace>/.cybernetics/board-<id>.json`
      // so a restarted controller can rehydrate it (see loadBoardFile).
      const publishBoard = async (): Promise<void> => {
        // The workspace root is authoritative here (the working-directory
        // service resolved it); hand it to the projection so the one-shot
        // host-copy resolution record lands in `<workspace>/.cybernetics/`
        // even if a session header carries no cwd.
        if (typeof root === 'string' && root.length > 0) setPublishDebugRoot(root)
        publishGoals(parent.session, goalsFromBoard(board.values()))
        if (sessionId !== undefined && typeof root === 'string' && root.length > 0) {
          await saveBoardFile(root, sessionId, board.values())
        }
      }

      // v0.6 read point: first touch of a session after a host restart (empty
      // memory board). Restore the snapshot and republish it once, so the tab
      // shows the recovered history immediately instead of waiting for the next
      // round. A missing/corrupt/foreign snapshot leaves the board empty.
      if (board.size === 0 && sessionId !== undefined && typeof root === 'string' && root.length > 0) {
        const restored = await loadBoardFile(root, sessionId)
        if (restored !== undefined && restored.length > 0) {
          for (const restoredLoop of restored) {
            if (restoredLoop.goalId !== undefined) board.set(restoredLoop.goalId, restoredLoop)
          }
          await publishBoard()
        }
      }

      // 'list' needs no goal resolution and no workflow engine.
      if (action === 'list') {
        return {
          board: [...board.values()].map((g) => ({
            goalId: g.goalId, title: g.title, objective: g.objective, status: g.status ?? 'paused',
            running: running.has(g.goalId!), round: g.round, subgoal: g.subgoal,
            depth: g.depth ?? 'full',
            executor: g.executor ?? 'ephemeral',
            ...(g.memberName ? { memberName: g.memberName } : {}),
            ...(g.parentGoalId ? { parentGoalId: g.parentGoalId } : {}),
            ...(g.supersededBy ? { supersededBy: g.supersededBy } : {}),
          })),
        }
      }

      // The workflow engine lives in the Agent's preset mount (delegation group
      // isolate); read it through the registry's sanctioned root-realm accessor.
      const engine = ctx.agentPresets.serviceFor(parent, 'workflowEngine')
      if (!engine) {
        throw new Error(
          'cybernetics: workflowEngine unavailable in the session preset mount — ' +
          'does the active agent preset contain workflow-ptc (the standard preset does)?',
        )
      }

      const goalView = goals.get(parent)

      // --- Resolve the target loop for this call ------------------------------
      // Priority: explicit goalId > new goal (title) > active dsh-goal focus.
      // 'revise' is excluded from the title branch: there `title` names the NEW
      // goal's title while the call targets the OLD goal.
      let loop: LoopState | undefined
      if (args.goalId) {
        loop = board.get(args.goalId)
        if (!loop && goalView && goalView.id === args.goalId && goalView.phase === 'active') {
          loop = {
            goalId: goalView.id, title: goalView.objective.split('\n')[0].slice(0, 60),
            objective: goalView.objective, round: 0, doneSummary: '',
            subgoal: goalView.objective, role: 'default', status: 'paused',
          }
          board.set(loop.goalId!, loop)
        }
        if (!loop) throw new Error(`cybernetics: goal "${args.goalId}" not on this session's board (try action "list")`)
      } else if (args.title && action !== 'revise') {
        // New task: create a registry goal. dsh-goal stays single-slot; when it
        // is free, focus the new goal into it (GUI tab + round-driver pickup).
        const goalId = `cyb-${randomUUID().slice(0, 8)}`
        const objective = args.brief ?? args.title
        loop = createGoal(undefined, {
          goalId,
          title: args.title,
          objective,
          ...(args.subgoal ? { subgoal: args.subgoal } : {}),
        })
        board.set(goalId, loop)
        // Goal creation is a projection write point: the tab gains the goal
        // immediately, before the first round settles.
        await publishBoard()
        if (!goalView || goalView.phase !== 'active') {
          try { goals.create(parent, { objective: `${args.title}\n\n${objective}` }) } catch { /* focus sync is best-effort */ }
        }
      } else {
        // Legacy single-goal path: drive the active dsh-goal.
        if (!goalView || goalView.phase !== 'active') {
          // goals.get() keeps returning a view for completed/paused/blocked
          // goals — "current" is not "active". Only phase "active" may drive rounds.
          throw new Error(
            `no active session goal (phase: ${goalView?.phase ?? 'none'}): pass title+brief to create one, ` +
            'goalId to drive an existing board goal, or create a dsh-goal first (create_goal).',
          )
        }
        loop = board.get(goalView.id)
        if (!loop) {
          loop = {
            goalId: goalView.id, title: goalView.objective.split('\n')[0].slice(0, 60),
            objective: goalView.objective, round: 0, doneSummary: '',
            subgoal: goalView.objective, role: 'default', status: 'paused',
          }
          board.set(goalView.id, loop)
        }
      }

      // Per-call overrides.
      if (args.subgoal) loop.subgoal = args.subgoal
      if (args.brief) loop.brief = args.brief
      if (args.depth) loop.depth = args.depth
      if (args.executor) loop.executor = args.executor
      if (args.role) loop.role = args.role

      // A goal adopted from the dsh-goal focus slot joins the board here; make
      // it visible in the tab even when this call changes nothing else.
      await publishBoard()

      // Flat settings-panel model fields fold into the canonical roles shape:
      // an unset field leaves its role untouched = inherit the session agent.
      // All three fields are volatile (task/verify v0.7.7, triage v0.8.2), so
      // the loader hands back live references — unwrap through readConfigField
      // ('' = inherit) exactly like the allGoalsMode live ref above.
      // roles may be volatile (a live reference, pre-0.8.3 configs) or a plain
      // object (non-volatile since v0.8.4, configured via profile yaml) —
      // readConfigField handles both shapes: a live ref is unwrapped, a plain
      // object is returned as-is (hardGate and friends take the same path).
      const roleOverrides: RolesConfig = { ...readConfigField(config.roles, {} as RolesConfig) }
      const taskSpec = parseAgentModelSpec(readConfigField(config.taskAgentModel, ''))
      if (taskSpec) roleOverrides.default = { ...roleOverrides.default, ...taskSpec }
      const verifySpec = parseAgentModelSpec(readConfigField(config.verifyAgentModel, ''))
      if (verifySpec) roleOverrides.verify = { ...roleOverrides.verify, ...verifySpec }
      const triageSpec = parseAgentModelSpec(readConfigField(config.triageAgentModel, ''))
      if (triageSpec) roleOverrides.triage = { ...roleOverrides.triage, ...triageSpec }
      const controllerConfig: ControllerConfig = {
        roundScriptPath: config.roundScriptPath ?? fileURLToPath(new URL('../workflows/round.js', import.meta.url)),
        // Volatile schema fields surface as live references — unwrap per round
        // start so a settings-panel edit governs the next round (0/undefined
        // falls back to the controller's built-in default).
        roundsPerSubgoal: Math.max(1, Math.floor(readConfigField(config.roundsPerSubgoal, 3))),
        roles: roleOverrides,
      }
      // Concurrent-round cap (0 = unlimited), read live at every launch.
      const maxConcurrentRounds = () => {
        const raw = Math.floor(readConfigField(config.maxConcurrentRounds, 0))
        return Number.isFinite(raw) && raw > 0 ? raw : 0
      }
      const concurrentCapError = () => {
        const cap = maxConcurrentRounds()
        return cap > 0 && running.size >= cap
          ? `cybernetics: 已有 ${running.size} 个运行中的轮，达到全局并行上限 ${cap}（可在设置面板调高 maxConcurrentRounds 或等待完成）`
          : undefined
      }
      const objective = loop.objective ?? goalView?.objective ?? loop.title ?? ''

      /**
       * Start one round on the goal's chosen substrate. Ephemeral (default) is
       * the v0.5 workflow run; persistent uses an Agent Teams teammate that
       * survives across rounds. Both return the same run-like handle, so the
       * async/blocking/cancel paths below stay substrate-agnostic.
       */
      const startAnyRound = async (target: LoopState, signal?: AbortSignal): Promise<any> => {
        if (target.executor === 'persistent') {
          // Soft probe: never read ctx.agentTeams directly here — Cordis throws
          // on an un-injected service property, which would surface as an
          // internal proxy error instead of "unsupported, use ephemeral".
          if (!teamExecutorAvailable(ctx)) throw teamExecutorUnavailableError()
          return startTeamRound(ctx, parent, target, controllerConfig, signal)
        }
        const started = await startRound(engine, parent, root, target, controllerConfig, { objective: target.objective ?? '' }, signal)
        return {
          round: started.round,
          result: started.run.result,
          cancel: (reason?: string) => started.run.cancel(reason),
          dispose: () => started.run.dispose(),
          run: started.run,
        }
      }

      /**
       * Start one goal's round in the background (action 'start' and `revise`
       * share this): install the handle, then queue the completion notice. The
       * goal's status is already 'running' when this is called.
       */
      const launchBackground = async (target: LoopState): Promise<{ round: number }> => {
        const blocked = concurrentCapError()
        if (blocked) throw new Error(blocked)
        const controller = new AbortController()
        if (exec.signal) {
          if (exec.signal.aborted) controller.abort()
          else exec.signal.addEventListener('abort', () => controller.abort(), { once: true })
        }
        const started: any = await startAnyRound(target, controller.signal)
        const round = started.round as number
        const handle: RunningRound = { goalId: target.goalId!, round, parent, root, loop: target, config: controllerConfig, run: started }
        running.set(target.goalId!, handle)
        started.result.then(async (settled: any) => {
          handle.settled = settled
          // Superseded goal (revise with abortPrevious: false): the successor
          // carries the work from here — no collect notice, and release the run
          // so a finished-but-replaced round cannot leak the handle.
          if (target.supersededBy !== undefined) {
            if (running.get(target.goalId!) === handle) {
              running.delete(target.goalId!)
              await disposeOnce(handle)
            }
            return
          }
          notifyRoundSettled(parent, target, round)
        }).catch(() => { /* result never rejects by contract; belt and braces */ })
        return { round }
      }

      // --- revise (append-only goal model) ------------------------------------
      // A goal change NEVER rewrites the objective in place: it creates a
      // successor goal (parentGoalId = old), starts that goal's first round, and
      // freezes the old goal as superseded (supersededBy = new). The session
      // agent decides whether the old goal's in-flight task agent is aborted.
      if (action === 'revise') {
        const previous = loop
        const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
        if (reason.length === 0) {
          throw new Error('cybernetics: action "revise" requires a non-empty "reason" — record why the goal changed')
        }
        if (previous.supersededBy !== undefined) {
          throw new Error(
            `cybernetics: goal "${previous.goalId}" was already superseded by "${previous.supersededBy}" — ` +
            'revise the successor goal instead of forking the lineage',
          )
        }
        // v0.7 abort policy: explicit abortPrevious keeps the v0.6 manual
        // semantics; when the caller omits it, all-goals mode auto-decides via
        // the decision tree (see decideAbort). With allGoalsMode off, the
        // omitted flag means false exactly as before (backward compat) and the
        // audit records that legacy default instead of a fabricated decision.
        const roundInFlight = running.has(previous.goalId!)
        const abortDecision = decideAbort(previous, roundInFlight, args)
        const legacyDefault = args.abortPrevious === undefined && !allGoalsMode()
        const effectiveAbort = legacyDefault
          ? { abort: false, mode: 'explicit' as const, basis: 'all-goals 模式未开启：abortPrevious 缺省沿用 v0.6 默认 false（不中止旧轮）' }
          : abortDecision
        const abortPrevious = args.abortPrevious !== undefined
          ? args.abortPrevious === true
          : (allGoalsMode() ? abortDecision.abort : false)
        const previousHandle = running.get(previous.goalId!)
        let aborted: string | undefined
        if (abortPrevious && previousHandle) {
          previousHandle.run.cancel(args.brief ?? `goal 被修订取代：${reason}`)
          running.delete(previous.goalId!)
          await disposeOnce(previousHandle)
          aborted = '旧 goal 的在跑轮已中止'
        }
        const newGoalId = `cyb-${randomUUID().slice(0, 8)}`
        const next = createGoal(previous, {
          goalId: newGoalId,
          ...(args.title ? { title: args.title } : {}),
          ...(args.objective ? { objective: args.objective } : {}),
          ...(args.depth ? { depth: args.depth } : {}),
          ...(args.executor ? { executor: args.executor } : {}),
          ...(args.role ? { role: args.role } : {}),
          subgoal: args.objective ?? previous.objective ?? previous.title ?? newGoalId,
        })
        // A revision inherits the previous work order unless a corrected brief
        // is supplied; the round-1 task agent reads `next.brief` verbatim.
        if (args.brief ?? previous.brief) next.brief = args.brief ?? previous.brief
        board.set(newGoalId, next)
        supersedeGoal(previous, newGoalId)
        await publishBoard()
        const at = Date.now()
        let revisionLog: string | undefined
        try {
          revisionLog = await writeRevisionLog(root, newGoalId, {
            from: previous.goalId!, to: newGoalId, reason, at,
            abort: effectiveAbort,
          })
        } catch {
          // Audit is observability: a read-only workspace must not break the
          // revision (the lineage fields on the board still carry the change).
        }
        const { round } = await launchBackground(next)
        return {
          goalId: newGoalId,
          previousGoalId: previous.goalId,
          revised: true,
          round,
          started: true,
          ...(aborted ? { aborted } : {}),
          abort: effectiveAbort,
          revision: { from: previous.goalId, to: newGoalId, reason, at },
          ...(revisionLog ? { revisionLog } : {}),
        }
      }

      // A superseded goal is frozen history: only the successor may be driven.
      if (loop.supersededBy !== undefined) {
        throw new Error(
          `cybernetics: goal "${loop.goalId}" is superseded by "${loop.supersededBy}" — ` +
          'drive the successor goal (see action "list")',
        )
      }

      // --- cancel -------------------------------------------------------------
      if (action === 'cancel') {
        const h = running.get(loop.goalId!)
        if (!h) return { goalId: loop.goalId, cancelled: '该 goal 当前没有运行中的轮' }
        loop.status = 'cancelled'
        h.run.cancel(args.brief ?? 'session agent 决定终止（用户修正）')
        await publishBoard()
        return { goalId: loop.goalId, round: h.round, cancelled: '已请求中止；完成通知到达后请 collect 折叠结果' }
      }

      // --- collect ------------------------------------------------------------
      if (action === 'collect') {
        const h = running.get(loop.goalId!)
        if (!h) throw new Error(`cybernetics: goal "${loop.goalId}" has no background round to collect`)
        if (!h.settled) return { goalId: loop.goalId, round: h.round, pending: true }
        const { result, decision } = await foldRound(h.root, h.round, h.settled, h.loop, h.config)
        applyDecision(h.loop, h.round, result, decision)
        running.delete(loop.goalId!)
        await disposeOnce(h)
        // Round settlement decision applied — republish (round / status / subgoal).
        await publishBoard()
        return { goalId: loop.goalId, round: h.round, decision, result }
      }

      // --- round / start ------------------------------------------------------
      if (running.has(loop.goalId!)) {
        throw new Error(`cybernetics: goal "${loop.goalId}" already has a round in flight — collect or cancel it first`)
      }
      const blocked = concurrentCapError()
      if (blocked) throw new Error(blocked)
      loop.status = 'running'
      // In-flight visibility: the blocking 'round' path can run for minutes, so
      // publish before awaiting it (the async path needs no second publish —
      // the state did not change).
      await publishBoard()

      if (action === 'start') {
        const { round } = await launchBackground(loop)
        return { goalId: loop.goalId, round, started: true }
      }

      // Blocking round (default). Both substrates expose {round, result, dispose}.
      const handle: any = await startAnyRound(loop, exec.signal)
      let settled: any
      try {
        settled = await handle.result
      } finally {
        await handle.dispose()
      }
      const { result, decision } = await foldRound(root, handle.round, settled, loop, controllerConfig)
      applyDecision(loop, result.round, result, decision)
      // Round settlement decision applied — republish (round / status / subgoal).
      await publishBoard()
      return { goalId: loop.goalId, round: result.round, decision, result }
    },
  })

  return () => { disposer(); disposers.forEach((d) => d()) }
}

/** Fold a controller decision back into the loop's durable-ish state. */
function applyDecision(loop: LoopState, round: number, result: RoundResult, decision: ControllerDecision): void {
  loop.round = round
  const summary = (result.report as { summary?: string } | undefined)?.summary
  if (summary) {
    loop.doneSummary = `${loop.doneSummary ? `${loop.doneSummary}\n` : ''}R${round}: ${summary}`.slice(-6000)
  }
  if (decision.action === 'continue') {
    loop.subgoal = decision.subgoal
    loop.status = 'paused'
    loop.paused = undefined
  } else {
    loop.status = decision.reason === 'met' ? 'met' : 'paused'
    loop.paused = decision.reason === 'met' ? undefined : { reason: decision.reason, note: decision.note }
  }
}

/**
 * Queue a completion notice into the session agent's own inbox, so an async
 * round's feedback reaches the session agent even while it is doing something
 * else. Zero-dependency replica of dsh-llm's createUserMessage
 * ({id, role:'user', content, source}) + Agent.followup, the same mechanism
 * dsh-goal-round-driver uses to admit continuation rounds.
 */
function notifyRoundSettled(parent: any, loop: LoopState, round: number): void {
  try {
    parent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text:
          `<cybernetics_round>\nGoal: ${JSON.stringify(loop.goalId)} (${loop.title ?? ''})\nRound: ${round}\n\n` +
          `该 goal 的后台轮已结束。调用 cybernetics { action: "collect", goalId: ${JSON.stringify(loop.goalId)} } 折叠结果，然后按协议处理反馈：向用户总结 / 启动验证轮 / 带缺口启动修正轮。\n</cybernetics_round>`,
      }],
      source: { kind: 'cybernetics', goalId: loop.goalId, round },
    })
  } catch {
    // The notice is a convenience; the session agent can still collect on its
    // next turn. Never let notification failure break the round lifecycle.
  }
}
