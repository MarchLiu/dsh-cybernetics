/**
 * Shared JSON Schema constants for the cybernetics loop. The same objects are
 * passed to workflow `agent()` calls (which validate child results) and used
 * as the TypeScript shapes in `controller.ts`, so the workflow script and the
 * plugin cannot drift apart. Plain JSON Schema objects — no runtime deps.
 */

/** One acceptance criterion with its verify verdict. */
export interface CriterionVerdict {
  criterion: string
  pass: boolean
  evidence: string
}

/** Structured verdict produced by the verify agent. */
export interface Verdict {
  met: boolean
  criteria: CriterionVerdict[]
  gaps: string[]
  /** True when verify judges the goal itself wrong, not the execution — the loop must stop and ask the user. */
  goalItselfQuestionable: boolean
}

/** One triaged next-step thought. */
export interface TriagedStep {
  step: string
  rationale: string
  /** Only on `human` items: the concrete question the user must answer. */
  question?: string
}

/** Structured triage of the task agent's next-step thoughts. */
export interface Triage {
  auto: TriagedStep[]
  defer: TriagedStep[]
  reject: TriagedStep[]
  human: TriagedStep[]
}

/**
 * v0.21: one role's actually-effective LLM target for a round, as recorded in
 * the round audit file (`agents.<role>`) and mirrored onto the board snapshot
 * / projection (`goal.models.agents`). `source: 'config'` = the fields come
 * from the configured per-role override (or absence of one = session-agent
 * inherit) — the workflow runtime does not expose the child session's final
 * model id, so today every row is config-derived; `source: 'observed'` is
 * reserved for rows read back from actual child-session logs (future seam).
 * When a call-level fallback (v0.8) fired, the EFFECTIVE call inherited the
 * session model: the provider/model/reasoningEffort fields are then omitted
 * and the bypassed override is preserved verbatim in `fallbackChain`.
 */
export interface AgentModelAudit {
  provider?: string
  model?: string
  reasoningEffort?: string
  source: 'config' | 'observed'
  /** Bypassed overrides that fell back to the session model this round. */
  fallbackChain?: Array<{
    from: { provider?: string; model?: string; reasoningEffort?: string }
    trigger: 'availability-error' | 'null-result'
    reason: string
  }>
}

/** Per-role model audit of one round, keyed by agent() role key. */
export type AgentsModelAudit = Record<string, AgentModelAudit>

/** Board-side mirror of a goal's most recent round's model audit. */
export interface GoalModelsMirror {
  /** Round number the audit belongs to. */
  round: number
  agents: AgentsModelAudit
}

/** JSON Schema for {@link AgentModelAudit} (documentation/diagnostic use). */
export const agentModelAuditSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source'],
  properties: {
    provider: { type: 'string' },
    model: { type: 'string' },
    reasoningEffort: { type: 'string' },
    source: { enum: ['config', 'observed'] },
    fallbackChain: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'trigger', 'reason'],
        properties: {
          from: {
            type: 'object',
            additionalProperties: false,
            properties: { provider: { type: 'string' }, model: { type: 'string' }, reasoningEffort: { type: 'string' } },
          },
          trigger: { enum: ['availability-error', 'null-result'] },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const

/** Structured delivery report produced by the task agent. */
export interface TaskReport {
  summary: string
  done: boolean
  artifacts: string[]
  evidence: string
  nextStepThoughts: string[]
}

/** JSON Schema for {@link TaskReport}; passed to workflow `agent()`. */
export const taskReportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'done', 'artifacts', 'evidence', 'nextStepThoughts'],
  properties: {
    summary: { type: 'string' },
    done: { type: 'boolean' },
    artifacts: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'string' },
    nextStepThoughts: { type: 'array', items: { type: 'string' } },
  },
} as const

/** JSON Schema for {@link Verdict}; passed to workflow `agent()`. */
export const verdictSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['met', 'criteria', 'gaps', 'goalItselfQuestionable'],
  properties: {
    met: { type: 'boolean' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'pass', 'evidence'],
        properties: {
          criterion: { type: 'string' },
          pass: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
    gaps: { type: 'array', items: { type: 'string' } },
    goalItselfQuestionable: { type: 'boolean' },
  },
} as const

/** JSON Schema for {@link Triage}; passed to workflow `agent()`. */
export const triageSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['auto', 'defer', 'reject', 'human'],
  properties: {
    auto: { $ref: '#/$defs/steps' },
    defer: { $ref: '#/$defs/steps' },
    reject: { $ref: '#/$defs/steps' },
    human: { $ref: '#/$defs/steps' },
  },
  $defs: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step', 'rationale'],
        properties: {
          step: { type: 'string' },
          rationale: { type: 'string' },
          question: { type: 'string' },
        },
      },
    },
  },
} as const
