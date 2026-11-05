/**
 * Round executors (v0.6): the substrate that runs one goal round's task work.
 *
 * Two substrates, one contract. `WorkflowExecutor` is the v0.5 path: the
 * controller starts `workflows/round.js` through the agent's workflowEngine and
 * the whole task→verify→triage loop runs as ephemeral subagents. `TeamExecutor`
 * replaces only the TASK agent with a persistent Agent Teams teammate
 * (context:'fresh' — identity persists, conversation history does not), while
 * verify/triage stay ephemeral workflow agents fed with the teammate's report
 * (`args.taskReport`) so verification never inherits the task narrative.
 *
 * Capture seam: a teammate's final output for one turn is delivered by the
 * host as `subagent/end` (info.id = the child session id, info.lastAssistantMessage
 * = ContentBlock[] — the host's `SubagentRunEndInfo` field; the legacy `output`
 * shape is still accepted as a fallback). The event can settle before
 * `spawnTeammate` resolves, so the listener is installed before the first spawn
 * and every settled child is buffered by id until consumed.
 *
 * Soft integration: the Agent Teams service is probed at call time through
 * `agentTeamsOf()`. Two seams, in priority order:
 *
 * 1. `ctx.reflect.get('agentTeams')` — Cordis' reflection read ("Read a
 *    service from the store without the inject requirement") returns the
 *    service value or `undefined` and needs no `inject` declaration. This is
 *    the correct seam for a soft/optional integration: it neither pends boot
 *    nor throws when nothing provides the service.
 * 2. `ctx.agentTeams` — an exception-safe fallback for older hosts and for
 *    hand-built test contexts that have no `reflect` seam. Cordis' context
 *    proxy THROWS on an un-injected service property ("cannot get property
 *    ... without inject"), which would surface as an internal proxy error, so
 *    the read is wrapped.
 *
 * Whichever seam answers, "not available" is reported as `undefined`: a
 * session without Agent Teams keeps working with executor 'ephemeral';
 * requesting 'persistent' there fails with a pointed, structured error
 * (pointing at ephemeral) instead of a Cordis proxy exception or a hang.
 * @module dsh-cybernetics/executor
 */

import type { ControllerConfig, LoopState, RoundResult } from './controller.ts'

/** Everything one round needs from the goal board (a plain snapshot). */
export interface TeamRoundInput {
  goalId: string
  title?: string
  objective: string
  round: number
  subgoal: string
  brief?: string
  depth: 'quick' | 'full'
  doneSummary: string
}

/** Run-like handle shared by both executors' consumers. */
export interface TeamRunHandle {
  round: number
  memberName: string
  result: Promise<{ stopReason: string; value?: unknown; error?: unknown }>
  cancel(reason?: string): void
  dispose(): Promise<void>
}

/**
 * Read a service through Cordis' reflection seam, if this context has one.
 *
 * `ctx.reflect.get(name)` is the documented read that bypasses the `inject`
 * requirement (vendor/cordis/src/reflect.ts): it returns the service value, or
 * `undefined` when no fiber currently provides it. It is deliberately called
 * with the default `strict = true`, so only an ACTIVE provider counts — a
 * service that is mid-teardown must not be handed to an executor.
 *
 * Contexts without a reflection seam (older hosts, plain test doubles) have no
 * `reflect` at all; a malformed or throwing seam is treated the same way.
 * Every failure mode means "no answer from this seam", never an error.
 */
function reflectedService(ctx: unknown, name: string): unknown {
  try {
    const reflect = (ctx as { reflect?: { get?: (name: string) => unknown } } | undefined)?.reflect
    if (reflect === undefined || reflect === null || typeof reflect.get !== 'function') return undefined
    return reflect.get(name)
  } catch {
    // Un-audited reflection implementation: soft integration ⇒ no answer.
    return undefined
  }
}

/**
 * Read the Agent Teams service without tripping Cordis' proxy guard.
 *
 * The reflection seam is tried first — it answers "available" and "absent"
 * without an `inject`, which is what a soft integration needs. The property
 * read is only the compatibility fallback: Cordis' context proxy throws
 * `cannot get property "X" without inject` for a service that was not injected,
 * so "not available" must be reported as `undefined`, not as a proxy error.
 * Returns `any` on purpose — the service shape is only known to the host that
 * mounts it.
 */
export function agentTeamsOf(ctx: unknown): any {
  const reflected = reflectedService(ctx, 'agentTeams')
  if (reflected !== undefined) return reflected
  try {
    return (ctx as { agentTeams?: unknown } | undefined)?.agentTeams
  } catch {
    // Un-injected service: Cordis threw. Soft integration ⇒ unavailable.
    return undefined
  }
}

/** Whether this context can host persistent (teammate) executors. */
export function teamExecutorAvailable(ctx: unknown): boolean {
  const teams = agentTeamsOf(ctx) as { spawnTeammate?: unknown } | undefined
  return teams !== undefined && typeof teams.spawnTeammate === 'function'
}

/** The pointed, structured error for a persistent round without Agent Teams. */
export function teamExecutorUnavailableError(): Error {
  return new Error(
    'cybernetics: executor "persistent" needs Agent Teams (agentTeams) in this session — ' +
    'the service is not injected here; fall back to executor "ephemeral" for this goal',
  )
}

/** ContentBlock text join (the host's output blocks are already text-only here). */
function outputText(output: unknown): string {
  if (!Array.isArray(output)) return ''
  const parts: string[] = []
  for (const block of output) {
    if (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.length > 0) parts.push(text)
    }
  }
  return parts.join('\n')
}

/**
 * Parse the task agent's output contract: the final message ends with one
 * single-line JSON object `{"done": true|false, "summary": "...", ...}`.
 * Missing/invalid marker → not done (the controller then continues or pauses
 * instead of pretending a turn succeeded).
 */
export function parseTaskOutput(text: string): { done: boolean; summary: string; evidence: string } {
  const marker = /\{[^{}]*"done"\s*:[^{}]*\}/gu
  let match: RegExpExecArray | null = null
  for (let m = marker.exec(text); m !== null; m = marker.exec(text)) match = m
  if (match !== null) {
    try {
      const parsed = JSON.parse(match[0]) as { done?: unknown; summary?: unknown; evidence?: unknown }
      if (typeof parsed.done === 'boolean') {
        return {
          done: parsed.done,
          summary: typeof parsed.summary === 'string' && parsed.summary.length > 0 ? parsed.summary : text.slice(0, 2000),
          evidence: typeof parsed.evidence === 'string' && parsed.evidence.length > 0 ? parsed.evidence : text,
        }
      }
    } catch {
      // fall through to the not-done default
    }
  }
  return { done: false, summary: text.slice(0, 2000), evidence: text }
}

/** The work order a persistent task agent receives on its first round. */
export function buildWorkOrder(input: TeamRoundInput, roles: ControllerConfig['roles']): string {
  const lines = [
    '你是一名持久 task agent（teammate）：你不继承任何会话历史，本委托书是你获得的全部任务信息；',
    '你在本轮结束后保持存活，后续会收到「委托书修订」，那些消息是同一 goal 的增量要求。',
    '',
    '【本轮委托书】',
    `目标：${input.objective}`,
    `本轮子目标：${input.subgoal}`,
    ...(input.brief && input.brief.trim().length > 0 ? ['', input.brief] : []),
    ...(input.doneSummary && input.doneSummary.trim().length > 0 ? ['', '【既往轮次摘要（不要重做，可依赖其产物）】', input.doneSummary] : []),
    '',
    '【执行纪律】',
    '- 你不是在写计划：必须实际调用工具完成工作，并给出可复现的证据。',
    '- 完成判定必须可验证：每项交付附上证据（命令输出、文件路径、查询结果）。',
    '- 被环境阻塞时如实停止，不要编造结果。',
    '',
    '【输出契约（必须遵守）】',
    '你的最终回复必须是结构化的，并且最后一行必须是单行 JSON：',
    '{"done": true|false, "summary": "一句话结果摘要", "evidence": "证据说明"}',
    'done 只在交付物确实完成且可验证时为 true。',
  ]
  return lines.join('\n')
}

/** Per-context capture state: buffered child outputs + waiters. */
interface CaptureState {
  buffer: Map<string, unknown[]>
  waiters: Map<string, Array<{ resolve: (value: unknown) => void; live: boolean }>>
}

const captures = new WeakMap<object, CaptureState>()
const installed = new WeakSet<object>()

function captureState(ctx: object): CaptureState {
  let state = captures.get(ctx)
  if (state === undefined) {
    state = { buffer: new Map(), waiters: new Map() }
    captures.set(ctx, state)
  }
  if (!installed.has(ctx)) {
    installed.add(ctx)
    ;(ctx as { on?: (event: string, fn: (info: unknown) => void) => (() => void) | void }).on?.('subagent/end', (info: unknown) => {
      const id = (info as { id?: unknown })?.id
      if (typeof id !== 'string') return
      const pending = state!.waiters.get(id)
      while (pending !== undefined && pending.length > 0) {
        const waiter = pending.shift()!
        if (waiter.live) { waiter.resolve(info); return }
      }
      const queue = state!.buffer.get(id) ?? []
      queue.push(info)
      state!.buffer.set(id, queue)
    })
  }
  return state
}

/**
 * Consume the next settled output for one child id (buffer first). The
 * returned dispose() marks the waiter dead and resolves it, so a cancelled
 * round can never steal the next turn's subagent/end from its successor.
 */
function nextSettled(ctx: object, childId: string): { promise: Promise<unknown>; dispose: () => void } {
  const state = captureState(ctx)
  const buffered = state.buffer.get(childId)
  if (buffered !== undefined && buffered.length > 0) {
    const value = buffered.shift()!
    return { promise: Promise.resolve(value), dispose: () => {} }
  }
  let waiter: { resolve: (value: unknown) => void; live: boolean }
  const promise = new Promise<unknown>((resolve) => {
    waiter = { resolve, live: true }
    const queue = state.waiters.get(childId) ?? []
    queue.push(waiter)
    state.waiters.set(childId, queue)
  })
  return {
    promise,
    dispose: () => {
      waiter!.live = false
      waiter!.resolve(undefined)
    },
  }
}

/**
 * Start one persistent round: spawn the teammate on the goal's first round,
 * otherwise steer a brief amendment into the same member; await its settled
 * output; then either derive the verdict (quick) or run verify+triage through
 * round.js with the report as `taskReport` (full).
 */
export async function startTeamRound(
  ctx: any,
  parent: any,
  state: LoopState,
  config: ControllerConfig,
  signal?: AbortSignal,
): Promise<TeamRunHandle> {
  const input: TeamRoundInput = {
    goalId: state.goalId ?? 'cyb',
    title: state.title,
    objective: state.objective ?? '',
    round: state.round + 1,
    subgoal: state.subgoal,
    brief: state.brief,
    depth: state.depth === 'quick' ? 'quick' : 'full',
    doneSummary: state.doneSummary,
  }
  const workOrder = buildWorkOrder(input, config.roles)
  // Soft integration probe (same accessor as teamExecutorAvailable): a missing
  // service is a structured, actionable failure — the caller/protocol falls
  // back to executor 'ephemeral' — never a Cordis proxy exception.
  const teams = agentTeamsOf(ctx)
  if (teams === undefined || typeof teams.spawnTeammate !== 'function') {
    throw teamExecutorUnavailableError()
  }
  // Install the subagent/end listener BEFORE the first spawn: a teammate can
  // settle before spawnTeammate resolves, and the buffered output must not be
  // lost. (Registration is idempotent per ctx.)
  captureState(ctx as object)
  const memberName = state.memberName ?? `cyb-${input.goalId.replace(/^cyb-/, '')}`

  let cancelled = false
  let resolveCancel: (() => void) | undefined
  let disposeWait: (() => void) | undefined
  const cancelGate = new Promise<void>((resolve) => { resolveCancel = resolve })

  const roundPromise = (async (): Promise<{ stopReason: string; value?: unknown; error?: unknown }> => {
    try {
      let childId: string
      if (state.memberName === undefined) {
        const spawned = await teams.spawnTeammate(parent, {
          name: memberName,
          description: (input.title ?? input.subgoal).slice(0, 200),
          prompt: [{ type: 'text', text: workOrder }],
          context: 'fresh',
          provider: 'spawn',
          signal: signal ?? new AbortController().signal,
        })
        childId = String(spawned?.member?.id ?? '')
        state.memberName = memberName
        if (childId.length === 0) throw new Error('TeamExecutor: spawnTeammate returned no member id')
      } else {
        await teams.sendMessage(parent, {
          target: state.memberName,
          content: [{ type: 'text', text: `【委托书修订（第 ${input.round} 轮）】\n本轮子目标：${input.subgoal}\n${state.brief ?? '（承接上一轮的委托书与已验证结果）'}` }],
          signal: signal ?? new AbortController().signal,
        })
        childId = ''
      }
      // For round 2+ we need the child id: listMembers resolves the durable member.
      if (childId.length === 0) {
        const members = teams.listMembers(parent) as Array<{ name?: string; id?: string }>
        childId = String(members.find((m) => m.name === state.memberName)?.id ?? '')
        if (childId.length === 0) throw new Error(`TeamExecutor: teammate "${state.memberName}" not found in the roster`)
      }
      if (cancelled) return { stopReason: 'cancelled', error: 'interrupted by session agent' }

      const wait = nextSettled(ctx, childId)
      disposeWait = wait.dispose
      const info = await wait.promise
      disposeWait = undefined
      if (cancelled) return { stopReason: 'cancelled', error: 'interrupted by session agent' }
      // The host's SubagentRunEndInfo carries the child's final output as
      // `lastAssistantMessage` (ContentBlock[]) — NOT `output`, which does not
      // exist on that payload. Reading the wrong field silently produced an
      // empty report, so read the real field first and keep `output` only as a
      // compatibility fallback for older/test shapes; an empty real field also
      // falls through instead of shadowing usable legacy text.
      const settledInfo = info as { lastAssistantMessage?: unknown; output?: unknown } | undefined
      const text = outputText(settledInfo?.lastAssistantMessage) || outputText(settledInfo?.output)
      const parsed = parseTaskOutput(text)
      const report = {
        summary: parsed.summary,
        done: parsed.done,
        artifacts: [],
        evidence: parsed.evidence,
        nextStepThoughts: [],
      }
      if (input.depth === 'quick') {
        const result: RoundResult = {
          round: input.round,
          report,
          verdict: {
            met: parsed.done,
            quick: true,
            criteria: [],
            gaps: parsed.done ? [] : ['task agent 未报告 done=true（quick 轮无 verify，详见 report）'],
            goalItselfQuestionable: false,
          },
          triage: { auto: [], defer: [], reject: [], human: [] },
        }
        return { stopReason: 'completed', value: result }
      }
      // full depth: verify + triage stay ephemeral and independent of the
      // teammate's narrative — they receive the report as a data input.
      const engine = ctx.agentPresets?.serviceFor(parent, 'workflowEngine')
      if (!engine) throw new Error('TeamExecutor: workflowEngine unavailable for verify/triage')
      const run = engine.start({
        script: await (await import('node:fs/promises')).readFile(config.roundScriptPath, 'utf8'),
        meta: { name: 'cybernetics-verify', description: `verify round ${input.round}: ${input.subgoal}` },
        args: {
          goal: { objective: input.objective },
          state: { round: input.round, doneSummary: input.doneSummary },
          subgoal: input.subgoal,
          // Same binder rule as controller.startRound: an own property with
          // value undefined is kept by structuredClone and rejected by the
          // host-side json() — omit the key when there is no work order.
          ...(state.brief !== undefined ? { brief: state.brief } : {}),
          depth: 'full',
          role: state.role,
          roles: config.roles ?? {},
          taskReport: report,
        },
        parent,
        signal,
      })
      try {
        const settled = await run.result
        if (settled.stopReason !== 'completed') {
          return { stopReason: 'completed', value: { round: input.round, failed: `verify run ${settled.stopReason}${settled.error ? `: ${settled.error}` : ''}` } }
        }
        return { stopReason: 'completed', value: settled.value }
      } finally {
        await run.dispose()
      }
    } catch (error) {
      return { stopReason: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  })()

  const result = Promise.race([
    roundPromise,
    cancelGate.then(() => ({ stopReason: 'cancelled', error: 'interrupted by session agent' })),
  ])

  return {
    round: input.round,
    memberName,
    result,
    cancel(_reason?: string) {
      cancelled = true
      // Drop this round's waiter first: a cancelled round must not consume the
      // next turn's subagent/end (it would hang the successor round).
      disposeWait?.()
      disposeWait = undefined
      resolveCancel?.()
      try { teams.interrupt(parent, state.memberName ?? memberName) } catch { /* best effort */ }
    },
    async dispose() {
      // The member persists across rounds by design; nothing to release here.
    },
  }
}
