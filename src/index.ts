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

import { fileURLToPath } from 'node:url'
import { runRound } from './controller.ts'
import type { ControllerConfig, LoopState, RolesConfig } from './controller.ts'

export const name = 'dsh-cybernetics'

export const inject = [
  'tools',
  'systemPrompt',
  'goals',
  'workingDirectory',
  'agentPresets',
] as const
// All five are ROOT-level services (goal / working-directory / agent-preset-registry
// are top-level loader entries) — static inject cannot pend at boot.
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
}

// No `Config` export: this cordis requires a schemastery schema there// (Config.validate), which a zero-dependency plugin cannot import. The raw
// patch config object passes through to apply() unvalidated; fields are
// optional and read defensively (toolName, roundsPerSubgoal, roundScriptPath,
// implicitTrigger, roles).

/** Session-scoped loop state; the durable objective lives in dsh-goal. */
const loops = new Map<unknown, LoopState>()

/** Minimal required-field validation the omitted dsh-tools wrapper would do. */
function requireFields(args: Record<string, unknown>, names: string[]): void {
  for (const n of names) {
    if (args[n] === undefined) throw new Error(`cybernetics: missing required argument "${n}"`)
  }
}

const IMPLICIT_GUIDANCE = `Goal-driven work loop (cybernetics): for any substantial task, first persist the
working objective with the goal tools (create_goal / goal edit) — the goal is YOUR synthesis of the user's
request, not a document the user edits; users calibrate through conversation and you revise the goal
accordingly. While a session goal is active, advance it by calling the cybernetics tool WITHOUT waiting for
an explicit ask: each call runs one full round (task agent -> verify agent -> triage agent) and returns a
continue/pause decision. On 'continue', call cybernetics again with the returned subgoal. On 'pause', read
the reason: 'met' means report to the user and wait for confirmation; 'goal-questionable' means re-examine
and revise the goal through dialogue; 'human-input' means surface the question; 'round-cap'/'failed' mean
report status. Choose the round's task role with the role argument when the deployment configures per-role models.`

export function apply(ctx: any, config: Partial<Config> = {}) {
  const toolName = config.toolName ?? 'cybernetics'

  if (config.implicitTrigger !== false) {
    ctx.systemPrompt.section({
      name: `tool:${toolName}`,
      order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
      text: IMPLICIT_GUIDANCE,
    })
  }

  const disposer = (ctx.tools as { register: (d: unknown) => () => void }).register({
    name: toolName,
    description:
      'Run ONE cybernetics round against the session goal: a task agent executes the current subgoal, ' +
      'a verify agent judges goal attainment with evidence, a triage agent sorts next-step thoughts, ' +
      'then the controller decides continue or pause. Call repeatedly to advance the loop; never marks ' +
      'the goal complete itself. Requires an active session goal (create one with the goal tools first).',
    parameters: {
      type: 'object',
      properties: {
        subgoal: {
          type: 'string',
          description: '本轮子目标；缺省沿用上轮决策（首轮取自当前 session goal）。',
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
          round: { type: 'number' },
          decision: { type: 'object' },
          result: { type: 'object' },
        },
        required: ['round', 'decision'],
      },
      render: (_args: unknown, value: any) => {
        const d = value.decision
        const line = d.action === 'continue'
          ? `第 ${value.round} 轮完成，继续：${d.subgoal}`
          : `第 ${value.round} 轮完成，暂停（${d.reason}）：${d.note}`
        return [{ type: 'text', text: line }]
      },
    },
    async execute(args: { subgoal?: string; role?: string }, exec: any) {
      requireFields(args as Record<string, unknown>, [])
      const goals = ctx.goals
      const workingDirectory = ctx.workingDirectory
      if (!goals) throw new Error('cybernetics: goals service unavailable — is dsh-goal loaded?')
      if (!workingDirectory) throw new Error('cybernetics: workingDirectory service unavailable')
      const parent = exec.agent
      if (!parent?.session) throw new Error('cybernetics tool requires a calling agent session')
      const root = workingDirectory.get(parent.session)

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
      if (!goalView || goalView.phase !== 'active') {
        // goals.get() keeps returning a view for completed/paused/blocked
        // goals — "current" is not "active". Verified live 2026-11-02: after
        // goal complete, the old null-check ran a stray round instead of
        // rejecting. Only phase "active" may drive rounds.
        throw new Error(
          `no active session goal (phase: ${goalView?.phase ?? 'none'}): create one first ` +
          '(goal tools: create_goal; a paused/blocked goal must be resumed by its owner), then call cybernetics. ' +
          'The goal is your synthesis of the user request, refined through conversation.',
        )
      }

      // A new goal id restarts the loop state; rounds do not carry across goals.
      const prev = loops.get(parent.session)
      const state = !prev || (prev as any).goalId !== goalView.id
        ? { round: 0, doneSummary: '', subgoal: args.subgoal ?? goalView.objective, role: 'default', goalId: goalView.id }
        : prev
      if (args.subgoal) state.subgoal = args.subgoal
      if (args.role) state.role = args.role

      const { result, decision } = await runRound(
        engine,
        parent,
        root,
        state,
        {
          roundScriptPath: config.roundScriptPath ?? fileURLToPath(new URL('../workflows/round.js', import.meta.url)),
          roundsPerSubgoal: config.roundsPerSubgoal,
          roles: config.roles,
        },
        { objective: goalView.objective },
        exec.signal,
      )
      state.round = result.round
      if (decision.action === 'continue') {
        state.subgoal = decision.subgoal
      } else {
        state.paused = decision.reason === 'met' ? undefined : { reason: decision.reason, note: decision.note }
      }
      loops.set(parent.session, state)
      return { round: result.round, decision, result }
    },
  })

  return () => disposer()
}
