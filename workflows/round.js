// One cybernetics round, run as a dsh-workflow script: task agent -> verify agent -> triage agent.
// args = {
//   goal:   { objective: string },                  // the session's durable goal (dsh-goal), model-authored
//   state:  { round: number, doneSummary: string }, // carried context
//   subgoal: string,                                // this round's bounded subgoal
//   role:   string,                                 // task agent role key (default 'default')
//   roles:  { [role]: { provider?, model? } },      // per-role LLM overrides (deployment config)
// }
// Returns { round, report, verdict, triage } — the controller folds this into the decision.

const { goal, state, subgoal, role, roles } = args

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

await phase('task')

const report = await agent(
  [
    `你是 task agent，只面向以下有限目标工作，不继承任何对话历史。`,
    ``,
    `总目标：${goal.objective}`,
    ``,
    `本轮子目标：${subgoal}`,
    ``,
    `已完成的既往工作摘要（不要重做）：`,
    state.doneSummary || '（无，这是第一轮）',
    ``,
    `完成后交付：summary、done、artifacts、evidence、nextStepThoughts。`,
    `nextStepThoughts 只记录"值得做但超出本轮子目标"的后续工作线索，不要执行它们。`,
  ].join('\n'),
  { label: `task:${role ?? 'default'}`, ...specFor(role ?? 'default'), schema: {
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
  return { round: state.round, failed: 'task agent 失败，本轮无结果' }
}

await phase('verify')

const verdict = await agent(
  [
    `你是 verify agent，独立验收 task agent 的交付。你只对照目标判定达成度，把目标拆成可判定的方面逐条列出并判定，每个判断必须给出证据；`,
    `不重做工作，不接受"大概完成了"。`,
    ``,
    `总目标：${goal.objective}`,
    `本轮子目标：${subgoal}`,
    ``,
    `task agent 交付报告：`,
    JSON.stringify(report, null, 2),
    ``,
    `若你认为是目标本身有问题（而非执行缺口），置 goalItselfQuestionable=true。`,
  ].join('\n'),
  { label: 'verify', ...specFor('verify'), schema: {
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
  return { round: state.round, failed: 'verify agent 失败，本轮无结果', report }
}

await phase('triage')

const triage = await agent(
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
  { label: 'triage', ...specFor('triage'), schema: {
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

return { round: state.round, report, verdict, triage: triage ?? { auto: [], defer: [], reject: [], human: [] } }
