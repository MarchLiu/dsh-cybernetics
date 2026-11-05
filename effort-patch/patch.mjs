#!/usr/bin/env node
// Apply the "per-sub-agent reasoning effort" patch to STAGED copies of:
//   - @deepseek-ai/dsh-workflow-ptc/lib/index.js  (engine seam: allow + forward reasoningEffort)
//   - @mars.liu/dsh-cybernetics  (schema, controller, round script, settings UI)
// Every replacement asserts its expected occurrence count before writing.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), 'stage')
const apply = (rel, pairs) => {
  const file = join(root, rel)
  let text = readFileSync(file, 'utf8')
  for (const { name, from, to, expected = 1 } of pairs) {
    const count = text.split(from).length - 1
    if (count !== expected) throw new Error(`${rel}: pattern ${name} matched ${count}x (expected ${expected})`)
    text = text.replace(from, to)
  }
  writeFileSync(file, text)
  console.log(`patched ${rel} (${pairs.length} replacements)`)
}

// ---------------------------------------------------------------------------
// 1. Engine seam: dsh-workflow-ptc guest runtime + host childRequest/startChild
//    NOTE: the guest runtime lives inside the embedded WORKFLOW_GUEST_SOURCE
//    string, so its raw text contains literal backslash-n / backslash-t escapes.
// ---------------------------------------------------------------------------
// Guest-string raw text: newlines are the two-char escape `\n`, quotes are
// the two-char escape `\"`, tabs are REAL tab characters.
const E = '\\n'
const T = '\t'
const Q = '\\"'
const OPTS = ['label', 'phase', 'schema', 'provider', 'model']
  .map((k) => `${E}${T}${Q}${k}${Q}`)
  .join(',')
const OPTS_WITH_EFFORT = ['label', 'phase', 'schema', 'provider', 'model', 'reasoningEffort']
  .map((k) => `${E}${T}${Q}${k}${Q}`)
  .join(',')
const STR_KEYS = ['label', 'phase', 'provider', 'model', 'reasoningEffort']
  .map((k) => `${E}${T}${T}${T}${Q}${k}${Q}`)
  .join(',')
const STR_KEYS_ORIG = ['label', 'phase', 'provider', 'model']
  .map((k) => `${E}${T}${T}${T}${Q}${k}${Q}`)
  .join(',')
apply('dsh-workflow-ptc/lib/index.js', [
  {
    name: 'guest SUPPORTED_AGENT_OPTIONS',
    from: `const SUPPORTED_AGENT_OPTIONS = new Set([${OPTS}${E}]);`,
    to:   `const SUPPORTED_AGENT_OPTIONS = new Set([${OPTS_WITH_EFFORT}${E}]);`,
  },
  {
    name: 'guest string-type check list',
    from: `for (const key of [${STR_KEYS_ORIG}${E}${T}${T}]) if (record[key] !== void 0 && typeof record[key] !== ${Q}string${Q})`,
    to:   `for (const key of [${STR_KEYS}${E}${T}${T}]) if (record[key] !== void 0 && typeof record[key] !== ${Q}string${Q})`,
  },
  {
    name: 'guest readAgentOptions return bag',
    from: `...record.model !== void 0 ? { model: record.model } : {},`,
    to:   `...record.model !== void 0 ? { model: record.model } : {},${E}${T}${T}...record.reasoningEffort !== void 0 ? { reasoningEffort: record.reasoningEffort } : {},`,
  },
  {
    name: 'guest startAgent request spread',
    from: `...opts.model !== void 0 ? { model: opts.model } : {}${E}${T}${T}${T}${T}});`,
    to:   `...opts.model !== void 0 ? { model: opts.model } : {},${E}${T}${T}${T}${T}...opts.reasoningEffort !== void 0 ? { reasoningEffort: opts.reasoningEffort } : {}${E}${T}${T}${T}${T}});`,
  },
  {
    name: 'host childRequest parse',
    from: `const model = request.model === void 0 ? void 0 : text(request.model, "model");`,
    to:   `const model = request.model === void 0 ? void 0 : text(request.model, "model");\n\tconst reasoningEffort = request.reasoningEffort === void 0 ? void 0 : text(request.reasoningEffort, "reasoningEffort");`,
  },
  {
    name: 'host childRequest return',
    from: `\t\t...model === void 0 ? {} : { model },`,
    to:   `\t\t...model === void 0 ? {} : { model },\n\t\t...reasoningEffort === void 0 ? {} : { reasoningEffort },`,
  },
  {
    name: 'host startChild agentOptions gate + spread',
    from: `\t\t\t\t...request.provider === void 0 && request.model === void 0 ? {} : { agentOptions: {\n\t\t\t\t\t...request.provider === void 0 ? {} : { provider: request.provider },\n\t\t\t\t\t...request.model === void 0 ? {} : { model: request.model }\n\t\t\t\t} }`,
    to:   `\t\t\t\t...request.provider === void 0 && request.model === void 0 && request.reasoningEffort === void 0 ? {} : { agentOptions: {\n\t\t\t\t\t...request.provider === void 0 ? {} : { provider: request.provider },\n\t\t\t\t\t...request.model === void 0 ? {} : { model: request.model },\n\t\t\t\t\t...request.reasoningEffort === void 0 ? {} : { reasoningEffort: request.reasoningEffort }\n\t\t\t\t} }`,
  },
])

// ---------------------------------------------------------------------------
// 2. Round script: carry reasoningEffort in the agent() opts bag; the existing
//    call-level fallback already strips the whole override bag on retry.
// ---------------------------------------------------------------------------
apply('dsh-cybernetics/workflows/round.js', [
  {
    name: 'specFor',
    from: `const specFor = (key) => {
  const s = (roles ?? {})[key]
  return s && (s.provider || s.model)
    ? { ...(s.provider ? { provider: s.provider } : {}), ...(s.model ? { model: s.model } : {}) }
    : {}
}`,
    to: `const specFor = (key) => {
  const s = (roles ?? {})[key]
  // v0.14: reasoningEffort rides the same override bag as provider/model; an
  // effort-only override (no model) is valid — it applies to the inherited
  // session model. An effort the model does not support fails the child call
  // and the v0.8 fallback below retries on the session default (no bag).
  const effort = s && typeof s.reasoningEffort === 'string' && s.reasoningEffort.trim() !== ''
    ? s.reasoningEffort.trim()
    : undefined
  return s && (s.provider || s.model || effort)
    ? {
        ...(s.provider ? { provider: s.provider } : {}),
        ...(s.model ? { model: s.model } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
      }
    : {}
}`,
  },
  {
    name: 'specLabel',
    from: `const specLabel = (spec) => [spec.provider, spec.model].filter(Boolean).join('/')`,
    to: `const specLabel = (spec) => [spec.provider, spec.model, spec.reasoningEffort ? 'effort:' + spec.reasoningEffort : ''].filter(Boolean).join('/')`,
  },
  {
    name: 'overridden check',
    from: `const overridden = !!(spec.provider || spec.model)`,
    to: `const overridden = !!(spec.provider || spec.model || spec.reasoningEffort)`,
  },
  {
    name: 'availability pattern for unsupported effort',
    from: `  /model not found|no such model|unknown model|invalid model|not subscribed|model .*not (?:available|enabled|found)/i,`,
    to: `  /model not found|no such model|unknown model|invalid model|not subscribed|model .*not (?:available|enabled|found)/i,
  /reasoning effort|thinking level/i,                                             // 配置的思考强度档位该模型不支持（v0.14，回退默认档位）`,
  },
])

// ---------------------------------------------------------------------------
// 3. Controller: RoleSpec gains reasoningEffort.
// ---------------------------------------------------------------------------
apply('dsh-cybernetics/src/controller.ts', [
  {
    name: 'RoleSpec',
    from: `export interface RoleSpec {
  provider?: string
  model?: string
}`,
    to: `export interface RoleSpec {
  provider?: string
  model?: string
  /**
   * Reasoning-effort override for this role's child calls (v0.14). The value
   * is an adapter-opaque effort id exactly as offered by the model catalog
   * (session.modelCatalog -> model.reasoning.efforts[].id) — the same source
   * the conversation model picker renders. Absent/empty = send no effort, the
   * adapter applies the model's default. An effort the model rejects fails
   * the child call once and the round's call-level fallback retries on the
   * session default (the override bag is stripped whole).
   */
  reasoningEffort?: string
}`,
  },
])

// ---------------------------------------------------------------------------
// 4. Plugin schema + config fold.
// ---------------------------------------------------------------------------
apply('dsh-cybernetics/src/index.ts', [
  {
    name: 'Config interface fields',
    from: `  /** Flat triage-agent model override (same format); empty = inherit session agent. */
  triageAgentModel?: string`,
    to: `  /** Flat triage-agent model override (same format); empty = inherit session agent. */
  triageAgentModel?: string
  /** Flat task-agent reasoning-effort override (catalog effort id); empty = adapter default. */
  taskAgentReasoningEffort?: string
  /** Flat verify-agent reasoning-effort override (catalog effort id); empty = adapter default. */
  verifyAgentReasoningEffort?: string
  /** Flat triage-agent reasoning-effort override (catalog effort id); empty = adapter default. */
  triageAgentReasoningEffort?: string`,
  },
  {
    name: 'schema verifyAgentReasoningEffort',
    from: `  /** Flat verify-agent model override; same format, fallback and volatile semantics as taskAgentModel. */
  verifyAgentModel: z.string().default('').volatile().description('verify agent 模型覆盖（「provider/model」或裸模型名）；留空 = 与 session agent 一致。保存后下一轮 goal 即生效，无需重载。'),`,
    to: `  /** Flat verify-agent model override; same format, fallback and volatile semantics as taskAgentModel. */
  verifyAgentModel: z.string().default('').volatile().description('verify agent 模型覆盖（「provider/model」或裸模型名）；留空 = 与 session agent 一致。保存后下一轮 goal 即生效，无需重载。'),
  verifyAgentReasoningEffort: z.string().default('').volatile().description('verify agent 思考强度覆盖（模型目录 reasoning.efforts 的档位 id）；留空 = 不发送该参数，按模型默认档位。选项随该 sub agent 所选模型动态变化；配置了模型不支持的档位时按模型默认处理。保存后下一轮 goal 即生效，无需重载。'),`,
  },
  {
    name: 'schema taskAgentReasoningEffort placement',
    from: `  taskAgentModel: z.string().default('').volatile().description('task agent 模型覆盖（「provider/model」或裸模型名）；留空 = 与 session agent 一致。保存后下一轮 goal 即生效，无需重载。'),`,
    to: `  taskAgentModel: z.string().default('').volatile().description('task agent 模型覆盖（「provider/model」或裸模型名）；留空 = 与 session agent 一致。保存后下一轮 goal 即生效，无需重载。'),
  taskAgentReasoningEffort: z.string().default('').volatile().description('task agent 思考强度覆盖（模型目录 reasoning.efforts 的档位 id）；留空 = 不发送该参数，按模型默认档位。选项随该 sub agent 所选模型动态变化；配置了模型不支持的档位时按模型默认处理。保存后下一轮 goal 即生效，无需重载。'),`,
  },
  {
    name: 'schema triageAgentReasoningEffort',
    from: `  triageAgentModel: z.string().default('').volatile().description('triage agent 模型覆盖（「provider/model」或裸模型名）；留空 = 与 session agent 一致。triage 角色读 task/verify 结果输出本轮收敛决策（met/continue/human-input 等）；quick 轮不启用。保存后下一轮 goal 即生效，无需重载。'),`,
    to: `  triageAgentModel: z.string().default('').volatile().description('triage agent 模型覆盖（「provider/model」或裸模型名）；留空 = 与 session agent 一致。triage 角色读 task/verify 结果输出本轮收敛决策（met/continue/human-input 等）；quick 轮不启用。保存后下一轮 goal 即生效，无需重载。'),
  triageAgentReasoningEffort: z.string().default('').volatile().description('triage agent 思考强度覆盖（模型目录 reasoning.efforts 的档位 id）；留空 = 不发送该参数，按模型默认档位。选项随该 sub agent 所选模型动态变化；配置了模型不支持的档位时按模型默认处理。保存后下一轮 goal 即生效，无需重载。'),`,
  },
  {
    name: 'config fold',
    from: `      const roleOverrides: RolesConfig = { ...readConfigField(config.roles, {} as RolesConfig) }
      const taskSpec = parseAgentModelSpec(readConfigField(config.taskAgentModel, ''))
      if (taskSpec) roleOverrides.default = { ...roleOverrides.default, ...taskSpec }
      const verifySpec = parseAgentModelSpec(readConfigField(config.verifyAgentModel, ''))
      if (verifySpec) roleOverrides.verify = { ...roleOverrides.verify, ...verifySpec }
      const triageSpec = parseAgentModelSpec(readConfigField(config.triageAgentModel, ''))
      if (triageSpec) roleOverrides.triage = { ...roleOverrides.triage, ...triageSpec }`,
    to: `      const roleOverrides: RolesConfig = { ...readConfigField(config.roles, {} as RolesConfig) }
      // v0.14: the flat reasoning-effort fields ride the same fold. Sanitize:
      // only a non-empty trimmed string is forwarded (anything else, including
      // a corrupted config value, degrades to "no effort" = adapter default);
      // an id the model does not offer is rejected by the adapter and the
      // round's call-level fallback retries on the session default.
      const readEffort = (raw: unknown): string => {
        const value = typeof raw === 'string' ? raw.trim() : ''
        return value
      }
      const taskSpec = parseAgentModelSpec(readConfigField(config.taskAgentModel, ''))
      const taskEffort = readEffort(readConfigField(config.taskAgentReasoningEffort, ''))
      if (taskSpec || taskEffort) roleOverrides.default = { ...roleOverrides.default, ...taskSpec, ...(taskEffort ? { reasoningEffort: taskEffort } : {}) }
      const verifySpec = parseAgentModelSpec(readConfigField(config.verifyAgentModel, ''))
      const verifyEffort = readEffort(readConfigField(config.verifyAgentReasoningEffort, ''))
      if (verifySpec || verifyEffort) roleOverrides.verify = { ...roleOverrides.verify, ...verifySpec, ...(verifyEffort ? { reasoningEffort: verifyEffort } : {}) }
      const triageSpec = parseAgentModelSpec(readConfigField(config.triageAgentModel, ''))
      const triageEffort = readEffort(readConfigField(config.triageAgentReasoningEffort, ''))
      if (triageSpec || triageEffort) roleOverrides.triage = { ...roleOverrides.triage, ...triageSpec, ...(triageEffort ? { reasoningEffort: triageEffort } : {}) }`,
  },
])

console.log('all patches applied')
