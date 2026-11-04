// One cybernetics round, run as a dsh-workflow script: task agent -> verify agent -> triage agent.
// args = {
//   goal:   { objective: string },                  // the session's durable goal (dsh-goal), model-authored
//                                                   // — authored to be a COMPLETE work order: detailed enough
//                                                   // for a fresh subagent to finish the whole job unaided
//   state:  { round: number, doneSummary: string }, // carried context
//   subgoal: string,                                // this round's bounded subgoal
//   brief:  string,                                 // per-round detailed task description extracted by the
//                                                   // calling model from the live conversation; the task agent's
//                                                   // primary work order (falls back to the objective)
//   role:   string,                                 // task agent role key (default 'default')
//   roles:  { [role]: { provider?, model? } },      // per-role LLM overrides (deployment config)
//   taskReport?: object,                            // v0.6 TeamExecutor: the persistent teammate's
//                                                   // report — when present the task agent is skipped
//                                                   // and verify/triage run over it directly
//   depth:  'quick' | 'full',                       // quick = task agent only (lightweight analysis:
//                                                   // one agent, one round, direct feedback — no
//                                                   // verify/triage); full = the whole loop (default,
//                                                   // for complex analysis and any world change)
// }
// Returns { round, report, verdict, triage } — the controller folds this into the decision.

const { goal, state, subgoal, brief, role, roles, depth, taskReport } = args

// One triaged step; shared by the four triage buckets (plain data, no $ref).
const stepsItem = {
  type: 'object', additionalProperties: false,
  required: ['step', 'rationale'],
  properties: { step: { type: 'string' }, rationale: { type: 'string' }, question: { type: 'string' } },
}

const specFor = (key) => {
  const s = (roles ?? {})[key]
  return s && (s.provider || s.model)
    ? { ...(s.provider ? { provider: s.provider } : {}), ...(s.model ? { model: s.model } : {}) }
    : {}
}

// --- v0.8 调用级模型回退（call-level model fallback） --------------------------
// 判定信号来自 workflow runtime（@deepseek-ai/dsh-workflow-ptc）的 agent() hook：
//  - 抛出 WorkflowError：code AGENT_START（消息 `agent() could not start a child: …`，
//    provider 解析 / 子 agent spawn / 首调失败——恒为可用性失败）或 AGENT_RESULT
//    （`child agent run failed: …`，消息内嵌失败原因，需命中可用性模式才回退）；
//    其余抛出（INVALID_ARGUMENT / UNSUPPORTED_* / AGENT_CAP 等脚本或守卫错误）
//    原样上抛，绝不换模型。离线 harness 的 mock 错误没有 code 时按消息模式判定。
//  - 返回 null：runtime 把子 agent 的失败压成 null 且不透传原因（子 run
//    stopReason ≠ 'completed' —— LLM 调用中途失败（限额/网络/provider 报错经
//    dsh-subagent 的 agent/error → stopReason 'error'）或无结构化产出）。仅当该
//    角色配置了模型覆盖时，把 null 视为「覆盖模型疑似不可调用」，撤销覆盖以
//    session agent 模型重试一次（无覆盖时 null 维持原失败语义——本来就跑在
//    session 模型上，无处可退）。
// 逻辑失败是返回值层面的判定（task agent 正常交付 done=false 的报告、verify
// 给出未达成 verdict），从不触发回退。每次回退记录进 fallbacks（轮结果携带，
// 随审计日志落盘），并经 log() 出现在 workflow/log 事件流。
const fallbacks = []

const errorTextOf = (err) => {
  try { return String((err && (err.stack || err.message)) || err) } catch { return '' }
}

// 模型可用性失败的消息模式：限流/quota/鉴权/服务端不可用/网络/provider 解析。
const AVAILABILITY_PATTERNS = [
  /could not start a child/i,                                                    // AGENT_START 包装
  /no subagent provider registered/i,                                            // 覆盖的 provider 未注册
  // v0.8.3：配置的模型在模型设置里删除订阅（provider 仍在但该 model 不可路由）时
  // 的典型报错形态（AGENT_RESULT 内嵌或无 code 的直抛），与既有模式互补。
  /model not found|no such model|unknown model|invalid model|not subscribed|model .*not (?:available|enabled|found)/i,
  /rate.?limit|\b429\b|too many requests/i,                                      // 限流
  /quota|insufficient|额度|余额|配额/i,                                           // 限额 / quota 耗尽
  /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication/i,      // 鉴权
  /overloaded|service unavailable|temporarily unavailable|\b502\b|\b503\b|\b529\b/i, // 服务端不可用
  /ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|network/i, // 网络不可达
]

const isAvailabilityFailure = (err) => {
  const code = err && typeof err === 'object' ? err.code : undefined
  if (code === 'AGENT_START') return true // 子 agent 启动即失败恒为可用性失败
  const text = errorTextOf(err)
  return AVAILABILITY_PATTERNS.some((re) => re.test(text))
}

const specLabel = (spec) => [spec.provider, spec.model].filter(Boolean).join('/')

/**
 * 以角色模型覆盖调用 agent()；覆盖模型不可用（可用性错误或 null 无产出）时
 * 回退到 session agent 的模型配置重试一次（不传 provider/model = 继承调用方）。
 * 无覆盖 = 直接调用（无回退必要）；非可用性错误原样上抛；重试再失败降级为
 * null（沿用既有「本轮无结果」路径，回退记录仍可见）。
 */
const callRoleAgent = async (roleKey, prompt, opts) => {
  const spec = specFor(roleKey)
  const overridden = !!(spec.provider || spec.model)
  try {
    const result = await agent(prompt, { ...opts, ...spec })
    if (result === null && overridden) {
      const reason = 'agent() 返回 null（runtime 未透传原因：子 agent 未完成或无结构化产出），疑似覆盖模型不可调用'
      fallbacks.push({ role: roleKey, from: spec, trigger: 'null-result', reason })
      log(`[cybernetics fallback] ${roleKey} 角色覆盖模型 ${specLabel(spec)} 执行无产出，回退到 session agent 模型重试`)
      try { return await agent(prompt, opts) } catch { return null }
    }
    return result
  } catch (err) {
    if (overridden && isAvailabilityFailure(err)) {
      const reason = errorTextOf(err).split('\n')[0].slice(0, 300)
      fallbacks.push({ role: roleKey, from: spec, trigger: 'availability-error', reason })
      log(`[cybernetics fallback] ${roleKey} 角色覆盖模型 ${specLabel(spec)} 调用失败（${reason}），回退到 session agent 模型重试`)
      try { return await agent(prompt, opts) } catch { return null }
    }
    throw err
  }
}

/** 轮结果统一携带回退记录（空数组 = 未发生回退）。 */
const withFallbacks = (out) => ({ ...out, fallbacks })

// v0.6 TeamExecutor: the persistent teammate already did the task work; the
// controller hands its report in as `taskReport`. Skip the task agent entirely
// and go straight to verify/triage (quick depth returns the derived verdict).
if (taskReport && typeof taskReport === 'object') {
  const report = taskReport
  if (depth === 'quick') {
    return withFallbacks({
      round: state.round,
      report,
      verdict: {
        met: report.done === true,
        quick: true,
        criteria: [],
        gaps: report.done === true ? [] : ['task agent 报告 done=false（quick 轮无 verify，详见 report）'],
        goalItselfQuestionable: false,
      },
      triage: { auto: [], defer: [], reject: [], human: [] },
    })
  }
  await phase('verify')
  const verdict = await callRoleAgent('verify',
    [
      `你是独立的 verify agent：你没有、也不应获得 task agent 的叙述过程。`,
      `下面是目标、工作委托书和 task agent 的报告，请基于证据判定本轮是否达成目标。`,
      ``,
      `【目标】`,
      goal.objective,
      ``,
      `【工作委托书】`,
      (brief && brief.trim()) || goal.objective,
      ``,
      `【task agent 的报告】`,
      JSON.stringify(report, null, 2),
      ``,
      `判定标准：证据是否支撑报告的每一项结论；是否覆盖了本轮子目标；是否存在未验证的断言。`,
    ].join('\n'),
    { label: 'verify', schema: {
      type: 'object', additionalProperties: false,
      required: ['met', 'criteria', 'gaps', 'goalItselfQuestionable'],
      properties: {
        met: { type: 'boolean' },
        criteria: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['criterion', 'pass', 'evidence'], properties: { criterion: { type: 'string' }, pass: { type: 'boolean' }, evidence: { type: 'string' } } } },
        gaps: { type: 'array', items: { type: 'string' } },
        goalItselfQuestionable: { type: 'boolean' },
      },
    } },
  )
  await phase('triage')
  const triage = await callRoleAgent('triage',
    [
      `你是 triage agent：把 verify 的缺口拆成四类处置建议。`,
      ``,
      `【verify 判定】`,
      JSON.stringify(verdict, null, 2),
      ``,
      `【本轮子目标】`,
      subgoal || '',
    ].join('\n'),
    { label: 'triage', schema: {
      type: 'object', additionalProperties: false,
      required: ['auto', 'defer', 'reject', 'human'],
      properties: {
        auto: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['step', 'rationale'], properties: { step: { type: 'string' }, rationale: { type: 'string' } } } },
        defer: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['step', 'rationale'], properties: { step: { type: 'string' }, rationale: { type: 'string' } } } },
        reject: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['step', 'rationale'], properties: { step: { type: 'string' }, rationale: { type: 'string' } } } },
        human: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['step', 'rationale'], properties: { step: { type: 'string' }, rationale: { type: 'string' }, question: { type: 'string' } } } },
      },
    } },
  )
  if (verdict === null || triage === null) {
    return withFallbacks({ round: state.round, report, failed: 'verify/triage agent 失败，本轮无结论' })
  }
  return withFallbacks({ round: state.round, report, verdict, triage })
}

await phase('task')

// The task agent is an INDEPENDENT subagent: it inherits no conversation
// history, so everything it needs must be in this one prompt. The work order
// is `brief` (the calling model's extraction of the current task, detailed
// enough to fully drive execution) falling back to the durable objective.
const workOrder = (brief && brief.trim()) || goal.objective

const report = await callRoleAgent(role ?? 'default',
  [
    `你是一个独立的 task agent：不继承任何对话历史，从零开始工作。`,
    `下面这份工作委托书是你可以获得的全部任务信息，它被要求详细到足以让你独立完成当前工作；`,
    `如委托书与现实不符，以工作区/代码/工具的真实状态为准，并把偏差写进报告。`,
    ``,
    `【工作委托书】`,
    workOrder,
    ``,
    `【本轮子目标（在委托书范围内的本轮边界）】`,
    subgoal || '（未单独给出：以委托书的下一步未完成项为准）',
    ``,
    `【已完成的既往工作摘要（不要重做，但可依赖其产物）】`,
    state.doneSummary || '（无，这是第一轮）',
    ``,
    `【执行纪律】`,
    `- 你不是在写计划：必须实际调用工具完成工作（读写代码、运行命令、执行测试），产出真实的磁盘/服务状态变化。`,
    `- 完成的判定是可验证的：每项交付都要有可复现证据（命令输出、测试结果、文件路径），不接受"应该可以了"。`,
    `- 被环境阻塞（依赖缺失、权限不足、需要人类决策）时如实停止并在 nextStepThoughts/human 线索中写明阻塞点，不要伪装完成。`,
    ``,
    `完成后交付：summary、done、artifacts、evidence、nextStepThoughts。`,
    `nextStepThoughts 只记录"值得做但超出本轮子目标"的后续工作线索，不要执行它们。`,
  ].join('\n'),
  { label: `task:${role ?? 'default'}`, schema: {
    type: 'object', additionalProperties: false,
    required: ['summary', 'done', 'artifacts', 'evidence', 'nextStepThoughts'],
    properties: {
      summary: { type: 'string' }, done: { type: 'boolean' },
      artifacts: { type: 'array', items: { type: 'string' } },
      evidence: { type: 'string' },
      nextStepThoughts: { type: 'array', items: { type: 'string' } },
    },
  } },
)

if (report === null) {
  return withFallbacks({ round: state.round, failed: 'task agent 失败，本轮无结果' })
}

// quick depth: lightweight analysis — one agent, one round, direct feedback.
// Skip verify/triage entirely; derive a verdict-shaped outcome from the
// task report so the controller's decision logic works unchanged.
if (depth === 'quick') {
  return withFallbacks({
    round: state.round,
    report,
    verdict: {
      met: report.done === true,
      quick: true,
      criteria: [],
      gaps: report.done === true ? [] : ['task agent 报告 done=false（quick 轮无 verify，详见 report）'],
      goalItselfQuestionable: false,
    },
    triage: { auto: [], defer: [], reject: [], human: [] },
  })
}

await phase('verify')

const verdict = await callRoleAgent('verify',
  [
    `你是 verify agent，独立验收 task agent 的交付。你只对照目标判定达成度，把目标拆成可判定的方面逐条列出并判定，每个判断必须给出证据；`,
    `不重做工作，不接受"大概完成了"。`,
    ``,
    `总目标：${goal.objective}`,
    brief ? `本轮工作委托书：${brief}` : '',
    `本轮子目标：${subgoal}`,
    ``,
    `task agent 交付报告：`,
    JSON.stringify(report, null, 2),
    ``,
    `若你认为是目标本身有问题（而非执行缺口），置 goalItselfQuestionable=true。`,
  ].join('\n'),
  { label: 'verify', schema: {
    type: 'object', additionalProperties: false,
    required: ['met', 'criteria', 'gaps', 'goalItselfQuestionable'],
    properties: {
      met: { type: 'boolean' },
      criteria: { type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['criterion', 'pass', 'evidence'],
        properties: { criterion: { type: 'string' }, pass: { type: 'boolean' }, evidence: { type: 'string' } },
      } },
      gaps: { type: 'array', items: { type: 'string' } },
      goalItselfQuestionable: { type: 'boolean' },
    },
  } },
)

if (verdict === null) {
  return withFallbacks({ round: state.round, failed: 'verify agent 失败，本轮无结果', report })
}

await phase('triage')

const triage = await callRoleAgent('triage',
  [
    `你是 goal agent。对 task agent 提出的后续工作线索做三分拣：`,
    `- auto：目标内、低风险、可自动执行的下一步工作`,
    `- defer：可能值得做但需要更多信息或更好时机，排入队列`,
    `- reject：与目标无关或明显不值得，驳回并说明理由`,
    `- human：影响目标方向、超出授权范围、或需要用户裁量的事项，写出具体问题`,
    `分拣纪律：宁可多给 human，不许把方向性改动归入 auto。`,
    ``,
    `总目标：${goal.objective}`,
    `verify 结果：${verdict.met ? '已达成' : `未达成，缺口：${verdict.gaps.join('；')}`}`,
    ``,
    `待分拣线索：`,
    ...report.nextStepThoughts.map((s, i) => `${i + 1}. ${s}`),
  ].join('\n'),
  { label: 'triage', schema: {
    type: 'object', additionalProperties: false,
    required: ['auto', 'defer', 'reject', 'human'],
    properties: {
      // NOTE: no $ref/$defs — the engine's enforced schema subset rejects them; inline instead.
      auto: { type: 'array', items: stepsItem },
      defer: { type: 'array', items: stepsItem },
      reject: { type: 'array', items: stepsItem },
      human: { type: 'array', items: stepsItem },
    },
  } },
)

return withFallbacks({ round: state.round, report, verdict, triage: triage ?? { auto: [], defer: [], reject: [], human: [] } })
