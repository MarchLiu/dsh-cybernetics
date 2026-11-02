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
