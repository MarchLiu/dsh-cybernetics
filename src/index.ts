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
import { fileURLToPath } from 'node:url'
import { runRound, startRound, foldRound } from './controller.ts'
import type { ControllerConfig, ControllerDecision, LoopState, RoundResult, RolesConfig } from './controller.ts'

export const name = 'dsh-cybernetics'

export const inject = [
  'tools',
  'systemPrompt',
  'goals',
  'workingDirectory',
  'agentPresets',
  'agents',
] as const
// All six are ROOT-level services (goal / working-directory / agent-preset-registry
// / agents are top-level loader entries) — static inject cannot pend at boot.
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
}

// No `Config` export: this cordis requires a schemastery schema there// (Config.validate), which a zero-dependency plugin cannot import. The raw
// patch config object passes through to apply() unvalidated; fields are
// optional and read defensively (toolName, roundsPerSubgoal, roundScriptPath,
// implicitTrigger, roles).

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
}
const running = new Map<string, RunningRound>()

/** Minimal required-field validation the omitted dsh-tools wrapper would do. */
function requireFields(args: Record<string, unknown>, names: string[]): void {
  for (const n of names) {
    if (args[n] === undefined) throw new Error(`cybernetics: missing required argument "${n}"`)
  }
}

const IMPLICIT_GUIDANCE = `Goal-driven orchestration (cybernetics). You are the SESSION agent: you never execute task work
yourself — you manage goals and the task agents that execute them. Classify each user input:
- NEW task → create a goal and launch a task agent: call cybernetics with action 'start' (non-blocking) or
  'round' (blocking), a short title, and a brief — the COMPLETE work order extracted from the request
  (background, paths, constraints, acceptance criteria). The task agent is an independent subagent with NO
  conversation history; the brief must be detailed enough for it to finish the work unaided. One session
  supports multiple concurrent goals; each returns its own goalId.
- CORRECTION to an existing task → decide: interrupt (action 'cancel' on that goalId, then start a fresh
  round whose brief carries the correction) or wait (collect the running round, then start a corrective
  round addressing it).
- FEEDBACK arrives as the tool result ('round') or, for async rounds, as a queued notification followed by
  action 'collect'. Then choose: summarize the outcome to the user; start a verification round; or start a
  corrective round whose brief is built from the verdict gaps. On decision 'continue', launch the next
  round with the returned subgoal. On 'pause': 'met' = report and wait for user confirmation;
  'goal-questionable' = re-examine the goal through dialogue; 'human-input' = surface the question;
  'round-cap'/'failed' = report status. Never mark a goal complete yourself; completion is the user's act.
Use action 'list' to see every goal on this session's board with its status, round and subgoal.`

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
  const disposers: Array<() => void> = []

  if (config.implicitTrigger !== false) {
    ctx.systemPrompt.section({
      name: `tool:${toolName}`,
      order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
      text: IMPLICIT_GUIDANCE + (hardGate ? HARD_GATE_GUIDANCE : ''),
    })
  }

  if (hardGate) {
    // The hard gate: a system-prompt/assemble waterfall listener that strips
    // execution tools from TOP-LEVEL agents' assemblies. Workflow subagents
    // (task/verify/triage) and team teammates are never in agents.roots(),
    // so their assemblies pass through untouched with full tool access.
    const allowlistMode = config.gateMode === 'allowlist'
    const keep = new Set([...(config.gateAllowlist ?? DEFAULT_GATE_ALLOWLIST), toolName])
    const gated = new Set(config.gatedTools ?? DEFAULT_GATED_TOOLS)
    const listenerDisposer = ctx.on('system-prompt/assemble', (assembly: any, context: any, next: () => unknown) => {
      const scope = context?.scope
      if (!scope) return next()
      let roots: unknown[] = []
      try { roots = ctx.agents?.roots?.() ?? [] } catch { return next() }
      const isRoot = roots.some((r: any) =>
        r === scope || r?.id === scope || (r?.id && r.id === scope?.id))
      if (!isRoot) return next()
      if (Array.isArray(assembly.tools)) {
        assembly.tools = allowlistMode
          ? assembly.tools.filter((t: any) => keep.has(t?.name))
          : assembly.tools.filter((t: any) => !gated.has(t?.name))
      }
      return next()
    })
    disposers.push(() => listenerDisposer?.())
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
      'Existing goal: pass its goalId. The controller never marks a goal complete — that is the user\'s act.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['round', 'start', 'collect', 'cancel', 'list'],
          description: 'round=同步执行一轮（默认）| start=后台启动一轮并立即返回 | collect=折叠已完成的后台轮 | cancel=中止正在运行的轮（修正场景）| list=查看本会话全部 goal。',
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
        role: {
          type: 'string',
          description: '本轮 task agent 的角色（对应部署配置 roles 表，如 frontend/backend/writer）；缺省 default。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          goalId: { type: 'string' },
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
      action?: 'round' | 'start' | 'collect' | 'cancel' | 'list'
      goalId?: string
      title?: string
      brief?: string
      subgoal?: string
      role?: string
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

      const board = boards.get(parent.session) ?? new Map<string, LoopState>()
      boards.set(parent.session, board)

      // 'list' needs no goal resolution and no workflow engine.
      if (action === 'list') {
        return {
          board: [...board.values()].map((g) => ({
            goalId: g.goalId, title: g.title, status: g.status ?? 'paused',
            running: running.has(g.goalId!), round: g.round, subgoal: g.subgoal,
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
      } else if (args.title) {
        // New task: create a registry goal. dsh-goal stays single-slot; when it
        // is free, focus the new goal into it (GUI tab + round-driver pickup).
        const goalId = `cyb-${randomUUID().slice(0, 8)}`
        const objective = args.brief ?? args.title
        loop = {
          goalId, title: args.title, objective, round: 0, doneSummary: '',
          subgoal: args.subgoal ?? args.title, role: 'default', status: 'paused',
        }
        board.set(goalId, loop)
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
      if (args.role) loop.role = args.role

      const controllerConfig: ControllerConfig = {
        roundScriptPath: config.roundScriptPath ?? fileURLToPath(new URL('../workflows/round.js', import.meta.url)),
        roundsPerSubgoal: config.roundsPerSubgoal,
        roles: config.roles,
      }
      const objective = loop.objective ?? goalView?.objective ?? loop.title ?? ''

      // --- cancel -------------------------------------------------------------
      if (action === 'cancel') {
        const h = running.get(loop.goalId!)
        if (!h) return { goalId: loop.goalId, cancelled: '该 goal 当前没有运行中的轮' }
        loop.status = 'cancelled'
        h.run.cancel(args.brief ?? 'session agent 决定终止（用户修正）')
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
        await h.run.dispose()
        return { goalId: loop.goalId, round: h.round, decision, result }
      }

      // --- round / start ------------------------------------------------------
      if (running.has(loop.goalId!)) {
        throw new Error(`cybernetics: goal "${loop.goalId}" already has a round in flight — collect or cancel it first`)
      }
      loop.status = 'running'

      if (action === 'start') {
        const controller = new AbortController()
        if (exec.signal) {
          if (exec.signal.aborted) controller.abort()
          else exec.signal.addEventListener('abort', () => controller.abort(), { once: true })
        }
        const { round, run } = await startRound(
          engine, parent, root, loop, controllerConfig, { objective }, controller.signal,
        )
        const handle: RunningRound = { goalId: loop.goalId!, round, parent, root, loop, config: controllerConfig, run }
        running.set(loop.goalId!, handle)
        run.result.then((settled: any) => {
          handle.settled = settled
          notifyRoundSettled(parent, loop, round)
        }).catch(() => { /* result never rejects by contract; belt and braces */ })
        return { goalId: loop.goalId, round, started: true }
      }

      // Blocking round (default).
      const { result, decision } = await runRound(
        engine, parent, root, loop, controllerConfig, { objective }, exec.signal,
      )
      applyDecision(loop, result.round, result, decision)
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
