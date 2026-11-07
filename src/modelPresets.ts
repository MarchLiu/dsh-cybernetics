/**
 * v0.17 preset plans (预置方案): a data-driven registry of model combinations
 * for the cybernetics sub-agent loop, surfaced on the settings card as a
 * dropdown. Two kinds of entries share one structure:
 *
 *  - `auto` — 「根据现有配置自动推荐」: read the host's LIVE model catalog
 *    (`probeCatalogOptions`, the same directory the smart selection uses),
 *    build a recommendation BRIEF that embeds the catalog, the current
 *    role config and the cross-vendor principles, and HAND THE BRIEF to the
 *    SESSION AGENT through the plugin-registered `preset_recommend` tool —
 *    the session agent reads the live catalog in its OWN context, picks the
 *    per-role answers itself, and submits them back through the same tool.
 *    v0.18.2 (user ruling 2026-11-06): the previous design ran one guarded
 *    one-shot LLM call (`ctx.llm.prepareCall().stream()`) on an explicit
 *    route — that re-submits the whole context a second time (time and cost)
 *    and spawns a parallel decision path, so the explicit-route config knob
 *    and the one-shot call were removed entirely:
 *    the plugin now only builds/validates/writes (parseRecommendation →
 *    validatePickEfforts → recommendationApplyOps), it never calls an LLM
 *    and never spawns an agent.
 *  - vendor entries (OpenAI / Claude / Gemini / DeepSeek / Kimi / Qwen /
 *    火山 Coding Plan / Minimax) — per-vendor recommended combinations with
 *    full data: per-role model + reasoning effort (heterogeneous tokens:
 *    OpenAI/Minimax five-level low/medium/high/xhigh/max, DeepSeek thinking
 *    switch, others model default), upgrade tier, availability fallback,
 *    per-role rationale, per-vendor note (⚠️ caveats), and VARIANTS (Claude
 *    常规/高要求, Qwen A/B/C, DeepSeek 仅本家/verify 外置, Kimi 长期/最高验收,
 *    火山 A/B). Selecting a preset applies its DEFAULT variant (variants[0]);
 *    the outcome record discloses the variant applied and the remaining ones.
 *
 * SESSION SCOPE (user ruling 2026-11-06, highest priority): the session agent
 * is NOT part of this feature. The user manages the session model themselves
 * at any time, so:
 *  - selecting a preset applies ONLY task/verify/triage — the ops builders
 *    are structurally limited to the six flat sub-agent fields
 *    (ALLOWED_OP_PATHS, asserted in tests);
 *  - the auto recommendation outputs ONLY the three sub-agent roles — the
 *    prompt forbids a `session` key and the parser drops one with an explicit
 *    note if a model emits it anyway;
 *  - every vendor's session suggestion is kept in the registry as REFERENCE
 *    data (variant.session, rendered in the card's vendor detail) but carries
 *    sessionNote「由用户自行管理，方案不应用此项」 and can never reach an op.
 * The pre-existing cross-vendor principle notes about session behavior
 * (verify floor, 主脑不降) remain background knowledge only — no code path
 * reads or writes the session agent's configuration here.
 *
 * Design constraints (mirroring src/modelSelection.ts):
 * - Model names are NOT invented: vendor entries carry the vendor-published
 *   combination data verbatim (including Gemini's family-latest ids that the
 *   brief explicitly wants resolved at runtime, and Kimi's K2 avoidance
 *   note); the auto flow's brief lets the session agent pick only models
 *   present in the live catalog, and the submit-side parser enforces the
 *   same rule. A vendor id missing from this deployment shows the settings
 *   card's model-unavailable warning and the round's availability fallback
 *   keeps the round alive — data-driven honesty over silent rewriting.
 * - The auto flow is plugin-side LLM-free: the plugin probes the catalog,
 *   renders the brief and validates/submits picks. The only model inference
 *   involved is the SESSION AGENT's own turn (the user's existing context) —
 *   zero independent one-shot calls, zero spawned agents. A catalog that is
 *   empty/unavailable degrades to a written degraded-status record; an
 *   unusable submission degrades the same way — the flow can never throw
 *   into the loader event path and never blocks a round.
 * - Effort ids are model-dependent. A vendor preset's effort token is applied
 *   as configured (the schema's sanitizeReasoningEffort drops an unsupported
 *   id at round time and the card shows the effective-default note); the AUTO
 *   picks' efforts are validated against `ctx.llm.resolveModelInfo` when that
 *   face is available and dropped (model kept, effort cleared) otherwise.
 * - Server → card visibility rides the volatile `presetRecommendation`
 *   field: the outcome (handed-off pending, applied picks, degradation
 *   reason) is written as a compact JSON record the card renders. Same
 *   channel, same gate, same persistence as every settings write.
 * - The selection itself is the volatile `presetPlan` field; the apply is
 *   one-shot per selection change (a `loader/volatile-update` guard in
 *   apply() tracks the last handled value), so a re-fire caused by our own
 *   writes cannot loop.
 *
 * Everything decision-shaped is a pure exported function so the offline test
 * suite (test/v17-model-presets.mjs) can pin the registry shape, prompt
 * content, parsing, apply-op building and degradation without a host.
 * @module dsh-cybernetics/model-presets
 */

import { parseAgentModelSpec, type RoleSpec, type RolesConfig } from './controller.ts'
import { modelTier, probeCatalogOptions } from './modelSelection.ts'
import type { CatalogOption } from './modelSelection.ts'

// --- registry -----------------------------------------------------------------

/** The auto-recommend selector id (not a vendor; computed from the live catalog). */
export const PRESET_AUTO_ID = 'auto'

/**
 * v0.18.2: the model-facing tool the auto recommendation is handed off
 * through. The plugin registers it via `ctx.tools.register` (the same face
 * as the cybernetics tool); the SESSION AGENT calls it in its own context:
 * first hop without `recommendation` → the tool returns the live catalog +
 * assignment rules + current config; second hop with `recommendation` (the
 * JSON answer) → the plugin validates and writes. The name is part of the
 * hard-gate allowlist contract (src/index.ts keeps it alongside the
 * cybernetics tool itself).
 */
export const PRESET_RECOMMEND_TOOL_NAME = 'preset_recommend'

/** Stable option ids, in dropdown order. The client mirrors these ids. */
export const PRESET_IDS = [
  PRESET_AUTO_ID,
  'openai',
  'claude',
  'gemini',
  'deepseek',
  'kimi',
  'qwen',
  'volcano-coding-plan',
  'minimax',
  'glm',
] as const

export type PresetId = (typeof PRESET_IDS)[number]

/**
 * One role's entry inside a vendor preset variant: the vendor-published model
 * choice plus the reasoning-effort token the vendor recommends (heterogeneous
 * across vendors — OpenAI/Minimax five-level low/medium/high/xhigh/max,
 * DeepSeek thinking switch; undefined = model default), the next upgrade
 * tier, the availability fallback, and the why. `provider`/`model` are the
 * vendor-canonical names (they may be absent from a given deployment's live
 * catalog — the card warns and the round's availability fallback covers it).
 */
export interface PresetRoleSpec {
  provider?: string
  model?: string
  /** Vendor-recommended effort token ('' / undefined = model default). */
  reasoningEffort?: string
  /** The next tier up when the round proves harder than expected (reference). */
  upgradeTo?: string
  /** Availability-fallback model (reference; the round path handles swaps). */
  fallback?: string
  rationale?: string
}

/**
 * One variant of a vendor preset (e.g. Claude 常规/高要求, Qwen A/B/C).
 * `roles` only ever carries the three SUB-AGENT keys — the session agent is
 * out of scope and structurally cannot appear here.
 */
export interface PresetVariant {
  id: string
  label: string
  description?: string
  roles: { task?: PresetRoleSpec; verify?: PresetRoleSpec; triage?: PresetRoleSpec }
  /**
   * REFERENCE ONLY: the vendor's session-agent suggestion, kept because each
   * vendor did publish one. Never applied, never prompted as a target — the
   * UI labels it 「session 由用户自行管理，方案不应用此项」.
   */
  session?: PresetRoleSpec
  /** Variant-level rationale lines (rendered in the vendor detail). */
  rationale?: string[]
}

/** One vendor's recommended combination entry in the registry. */
export interface VendorPreset {
  /** Stable id (PRESET_IDS member except `auto`). */
  id: Exclude<PresetId, typeof PRESET_AUTO_ID>
  /** Display label (also injected into the auto prompt as reference context). */
  label: string
  /** One-line scope note: what the vendor claims this combination optimizes. */
  description: string
  /** Source of the recommendation when filled (URL / advisory note). */
  source?: string
  /**
   * 'ready' = the variants below carry the vendor's published combination and
   * selecting the preset applies the default one; 'placeholder' = structure
   * only (selecting it records the choice, changes nothing).
   */
  status: 'placeholder' | 'ready'
  /** The DEFAULT variant's combination (=== variants[0].roles when ready). */
  roles: { task?: PresetRoleSpec; verify?: PresetRoleSpec; triage?: PresetRoleSpec }
  /** All variants (≥1; roles mirrors variants[0].roles so old readers work). */
  variants: PresetVariant[]
  /** Vendor note incl. ⚠️ caveats (rendered under the applied record). */
  note?: string
  /** session-scope note (the constant session-scope ruling, per vendor). */
  sessionNote?: string
}

/** The constant session-scope note every preset carries (user ruling). */
export const PRESET_SESSION_NOTE = 'session agent 由用户自行管理：方案与自动推荐均不应用 session 项，厂商方案中的 session 推荐仅作参考展示。'

/** The cross-vendor principles injected into the auto prompt (sub-agents only). */
export const CROSS_VENDOR_PRINCIPLES: string[] = [
  'verify 的模型档位不得低于 task（审计岗至少与执行岗同级）。',
  'verify 与 task 保持跨代际/跨家族独立，避免同一模型自我确认偏误；确需同家族时 verify 升高一档补偿。',
  'verify 不能过度自信：优先判断力强、能承认不确定性的模型。',
  '需要省成本时先压缩 task/triage，verify 最后动；成本不应成为降级 verify 的理由。',
  'triage 是轻量收敛分拣，选便宜快速的模型即可。',
  'session agent 不在推荐范围内（由用户自行管理），上述原则均不涉及 session 配置。',
]

/**
 * The vendor registry (v0.17: the vendors' published combinations, collected
 * 2026-11-06; v0.19.1 naming audit 2026-11-07). The audit re-grounded every
 * `model` id against (a) the vendors' official API model lists and (b) THIS
 * deployment's live catalog: catalog-covered families (DeepSeek, Kimi, 火山
 * Coding Plan, GLM) use verbatim catalog ids (provider+model both hit);
 * off-catalog vendors (OpenAI / Anthropic / Google / Qwen / MiniMax) keep
 * their vendor provider id with officially confirmed API ids (Anthropic's
 * product-name forms — Sonnet-5.5/Opus-5.5/… — became the lowercase-hyphen
 * API ids claude-*-5-5 / claude-fable-5-1; Qwen's qwen-turbo is gone, so the
 * trio is the current qwen3.7-plus / qwen3.8-max / qwen3.8-flash; OpenAI /
 * Gemini / MiniMax ids verified correct as-is). Each entry's `source` names
 * the official page checked and its `note` carries the audit disclosure.
 * Selecting a READY preset applies its DEFAULT variant's task/verify/triage
 * roles (model + effort) to the flat volatile fields; the session suggestion
 * travels with the variant as reference data only. DeepSeek deliberately
 * publishes two variants (in-house stack vs external verify); Kimi/Qwen/火山
 * carry the multi-variant ladders. Gemini resolves 「家族 + 最新版本」 at
 * runtime, so its ids are family-latest tokens rather than pinned versions.
 */
export const VENDOR_PRESETS: VendorPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'OpenAI 官方针对 cybernetic 循环（规划-执行-验证-分拣）推荐的组合：gpt-6.1-sol 承担 task/verify，gpt-6-luna 承担 triage；effort 五档 low/medium/high/xhigh/max（astra/6.1-sol 不支持 none）。',
    source: 'https://developers.openai.com/api/docs/models',
    status: 'ready',
    roles: {
      task: {
        provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'medium',
        upgradeTo: 'gpt-6.1-sol (high/xhigh)',
        rationale: 'task 承担主要执行工作：6.1-sol 主力档 medium 起步，难题逐级升到 xhigh。',
      },
      verify: {
        provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'high',
        upgradeTo: 'gpt-6.1-sol (xhigh)',
        rationale: 'verify 与 task 同模型但高一档 effort，以思考深度补偿同家族独立性损失。',
      },
      triage: {
        provider: 'openai', model: 'gpt-6-luna', reasoningEffort: 'low',
        upgradeTo: 'gpt-6-luna (medium)',
        rationale: 'triage 是轻量分拣：luna 低档足够，成本敏感。',
      },
    },
    variants: [{
      id: 'standard',
      label: '标准组合',
      roles: {
        task: { provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'medium', upgradeTo: 'gpt-6.1-sol (high/xhigh)', rationale: '主力执行模型，effort 五档可调。' },
        verify: { provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'high', upgradeTo: 'gpt-6.1-sol (xhigh)', rationale: 'verify 高一档 effort 补偿同家族。' },
        triage: { provider: 'openai', model: 'gpt-6-luna', reasoningEffort: 'low', upgradeTo: 'gpt-6-luna (medium)', rationale: '轻量分拣。' },
      },
      session: { provider: 'openai', model: 'gpt-6-astra', reasoningEffort: 'high', upgradeTo: 'gpt-6-astra (xhigh/max)', rationale: 'session 主脑用旗舰 astra（仅参考）。' },
    }],
    note: 'effort 五档：low/medium/high/xhigh/max；gpt-6-astra 与 gpt-6.1-sol 不支持 none 档（官方迁移指引：改用 low）。v0.19.1 核对：gpt-6-astra（旗舰）/ gpt-6.1-sol（6.1 代主力）/ gpt-6-luna（轻量档）均为官方现行 API id，非编造名；本部署目录未含 openai，需部署侧具备对应 provider 方可应用。',
    sessionNote: PRESET_SESSION_NOTE,
  },
  {
    id: 'claude',
    label: 'Claude',
    description: 'Anthropic 官方组合（单家族跨代际）：常规 = task claude-sonnet-5-5 / verify claude-opus-5-5 / triage claude-haiku-5-5；高要求 = task claude-opus-5-5 / verify claude-fable-5-1 / triage claude-haiku-5-5。',
    source: 'https://platform.claude.com/docs/en/models/overview',
    status: 'ready',
    roles: {
      task: { provider: 'anthropic', model: 'claude-sonnet-5-5', rationale: '常规档 task 用 Sonnet 5.5（claude-sonnet-5-5）：性价比主力。' },
      verify: { provider: 'anthropic', model: 'claude-opus-5-5', fallback: 'claude-fable-5-1', rationale: 'verify 高一档（Opus 5.5）补偿单家族独立性损失。' },
      triage: { provider: 'anthropic', model: 'claude-haiku-5-5', rationale: '轻量分拣。' },
    },
    variants: [
      {
        id: 'standard',
        label: '常规',
        roles: {
          task: { provider: 'anthropic', model: 'claude-sonnet-5-5', rationale: '性价比主力执行。' },
          verify: { provider: 'anthropic', model: 'claude-opus-5-5', fallback: 'claude-fable-5-1', rationale: 'verify 高一档补偿单家族。' },
          triage: { provider: 'anthropic', model: 'claude-haiku-5-5', rationale: '轻量分拣。' },
        },
        session: { provider: 'anthropic', model: 'claude-opus-5-5', rationale: 'session 主脑用 Opus 5.5（仅参考）。' },
      },
      {
        id: 'demanding',
        label: '高要求',
        roles: {
          task: { provider: 'anthropic', model: 'claude-opus-5-5', rationale: '高要求场景 task 直接上 Opus 5.5。' },
          verify: { provider: 'anthropic', model: 'claude-fable-5-1', rationale: 'verify 用最强判断档 Fable 5.1（claude-fable-5-1，官方定位 demanding reasoning / long-horizon agentic）。' },
          triage: { provider: 'anthropic', model: 'claude-haiku-5-5', rationale: '轻量分拣不变。' },
        },
        session: { provider: 'anthropic', model: 'claude-fable-5-1', rationale: 'session 主脑用 Fable 5.1（仅参考）。' },
      },
    ],
    note: 'v0.19.1 命名核对：官方 API id 一律小写连字符——claude-sonnet-5-5 / claude-opus-5-5 / claude-haiku-5-5 / claude-fable-5-1（旧文案的 Sonnet-5.5 等商品名形式已更正为 API id；Fable 5.1 为真实产品线，非编造）。本部署目录未含 anthropic，需部署侧具备对应 provider 方可应用。',
    sessionNote: PRESET_SESSION_NOTE,
  },
  {
    id: 'gemini',
    label: 'Gemini',
    description: 'Google 官方组合（家族 + 最新版本，运行时解析，不硬编码旧版本号）：task Flash、verify Pro（或高配 Flash + 严格 Prompt）、triage Flash。',
    source: 'https://ai.google.dev/gemini-api/docs/models',
    status: 'ready',
    roles: {
      task: { provider: 'google', model: 'gemini-flash-latest', rationale: '上下文对齐：task 用最新 Flash，速度吞吐优先。' },
      verify: { provider: 'google', model: 'gemini-pro-latest', fallback: 'gemini-flash-latest + 严格 Prompt', rationale: '严谨审查用最新 Pro；退而求其次用高配 Flash 配严格审查 Prompt。' },
      triage: { provider: 'google', model: 'gemini-flash-latest', rationale: '轻量路由。' },
    },
    variants: [{
      id: 'standard',
      label: '标准组合',
      roles: {
        task: { provider: 'google', model: 'gemini-flash-latest', rationale: '速度吞吐。' },
        verify: { provider: 'google', model: 'gemini-pro-latest', fallback: 'gemini-flash-latest + 严格 Prompt', rationale: '严谨审查。' },
        triage: { provider: 'google', model: 'gemini-flash-latest', rationale: '轻量路由。' },
      },
      session: { provider: 'google', model: 'gemini-pro-latest', rationale: 'session 主脑用最新 Pro（仅参考）。' },
    }],
    note: 'v0.19.1 核对：gemini-flash-latest / gemini-pro-latest 家族别名在官方模型枚举中仍有效，当前代际旗舰为 gemini-4-argon、Flash 当代为 gemini-3.8-flash（*-latest 由部署目录在运行时解析到最新稳定版，无需硬编码版本号）；verify 也可用高配 Flash + 严格 Prompt 替代 Pro（Flash 别名默认开启 thinking，成本敏感时留意）。本部署目录未含 google，需部署侧具备对应 provider 方可应用。',
    sessionNote: PRESET_SESSION_NOTE,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek 官方组合（两个变体，已对齐官方 API id 与本部署目录）：仅本家栈 = verify deepseek-v4-pro(thinking)、task deepseek-v4-pro(视难度切 thinking)、triage deepseek-flash；verify 外置 = verify 优先 Claude Opus / GPT 旗舰 / Gemini Pro。',
    source: 'https://api-docs.deepseek.com/quick_start/pricing/',
    status: 'ready',
    roles: {
      task: { provider: 'deepseek-official', model: 'deepseek-v4-pro', fallback: 'deepseek-v4-pro (thinking)', rationale: '默认非 thinking 起步，按任务难度切换 thinking 档。' },
      verify: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'thinking', fallback: 'deepseek-flash', rationale: 'verify 常开 thinking 档，审计岗不省这一层。' },
      triage: { provider: 'deepseek-official', model: 'deepseek-flash', rationale: '轻量分拣用 Flash 非思考档。' },
    },
    variants: [
      {
        id: 'in-house',
        label: '仅本家',
        roles: {
          task: { provider: 'deepseek-official', model: 'deepseek-v4-pro', fallback: 'deepseek-v4-pro (thinking)', rationale: '视难度切 thinking。' },
          verify: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'thinking', fallback: 'deepseek-flash', rationale: 'verify 常开 thinking。' },
          triage: { provider: 'deepseek-official', model: 'deepseek-flash', rationale: '轻量分拣。' },
        },
        session: { provider: 'deepseek-official', model: 'deepseek-v4-pro (非 thinking)', fallback: 'deepseek-flash', rationale: 'session 用 deepseek-v4-pro 非思考档或 deepseek-flash（仅参考）。' },
      },
      {
        id: 'external-verify',
        label: 'verify 外置',
        roles: {
          task: { provider: 'deepseek-official', model: 'deepseek-v4-pro', fallback: 'deepseek-v4-pro (thinking)', rationale: '本家 task 不变。' },
          verify: { provider: 'anthropic', model: 'claude-opus-5-5', fallback: 'gpt-6-astra / gemini-pro-latest', rationale: 'verify 优先外置旗舰（Claude Opus / GPT 旗舰 / Gemini Pro），跨家族独立性最大化。' },
          triage: { provider: 'deepseek-official', model: 'deepseek-flash', rationale: '轻量分拣。' },
        },
        session: { provider: 'deepseek-official', model: 'deepseek-v4-pro (非 thinking)', fallback: 'deepseek-flash', rationale: 'session 用 deepseek-v4-pro 非思考档或 deepseek-flash（仅参考）。' },
      },
    ],
    note: '成本不应成为降级 verify 的理由；官方现行 API id 只有 deepseek-v4-pro 与 deepseek-flash（v0.19.1 核对：旧文案的 V4-Flash 已由 deepseek-flash/V4.1-Flash 接替，R1、V3.2 已不在官方目录，相应兜底一并更正），两者均支持 thinking/非 thinking 双模切换；thinking 档按部署目录实际提供的档位 id 应用，未提供时按模型默认执行。本部署 provider 为 deepseek-official（deepseek-account 为同款另一计费渠道）。',
    sessionNote: PRESET_SESSION_NOTE,
  },
  {
    id: 'kimi',
    label: 'Kimi',
    description: 'Moonshot 官方组合（两个变体，已对齐本部署 kimi 目录）：长期组合 = task/triage kimi-for-coding-highspeed + verify k3（代际差异保独立）；最高验收质量 = verify 改 k3-256k。',
    source: 'https://platform.kimi.ai/docs/models',
    status: 'ready',
    roles: {
      task: { provider: 'kimi', model: 'kimi-for-coding-highspeed', rationale: '高速执行主力（本部署目录内的高速 coding 档）。' },
      verify: { provider: 'kimi', model: 'k3', fallback: 'k3-256k', rationale: 'verify 用上一代 k3：代际差异保持审计独立性；最高验收质量可换 k3-256k。' },
      triage: { provider: 'kimi', model: 'kimi-for-coding-highspeed', rationale: '轻量分拣同执行主力（高速版成本低）。' },
    },
    variants: [
      {
        id: 'long-term',
        label: '长期组合',
        roles: {
          task: { provider: 'kimi', model: 'kimi-for-coding-highspeed', rationale: '高速执行主力。' },
          verify: { provider: 'kimi', model: 'k3', fallback: 'k3-256k', rationale: '代际差异保独立。' },
          triage: { provider: 'kimi', model: 'kimi-for-coding-highspeed', rationale: '轻量分拣。' },
        },
        session: { provider: 'kimi', model: 'kimi-for-coding-highspeed', rationale: 'session 同执行主力（仅参考）。' },
      },
      {
        id: 'max-acceptance',
        label: '最高验收质量',
        roles: {
          task: { provider: 'kimi', model: 'kimi-for-coding-highspeed', rationale: '执行主力不变。' },
          verify: { provider: 'kimi', model: 'k3-256k', rationale: 'verify 升级到目录内当代最强 k3-256k（原方案 kimi-k3.1-pro 不在部署目录，就近替换并披露）。' },
          triage: { provider: 'kimi', model: 'kimi-for-coding-highspeed', rationale: '轻量分拣。' },
        },
        session: { provider: 'kimi', model: 'kimi-for-coding-highspeed', rationale: 'session 同执行主力（仅参考）。' },
      },
    ],
    note: 'v0.19.1 就近替换披露：原方案的 kimi-k3.1-pro(-highspeed) 在本部署 kimi 目录不存在（官方平台虽有 kimi-k3.1-pro，但部署目录未接入，不编造 id），高速执行档以 kimi-for-coding-highspeed、当代最强验收档以 k3-256k 就近替换。K2 系列官方公告 2026-10-31 起停止新用户接入、计划 2026 年底前全量退役——本部署 kimi 渠道现仍提供 kimi-for-coding(-highspeed)（K2.7 Code），退役窗口内可用、请留意迁移；k3（上一代）与 k3-256k（当代 K3 全量档）的代际差异是该方案 independence 的来源。',
    sessionNote: PRESET_SESSION_NOTE,
  },
  {
    id: 'qwen',
    label: 'Qwen',
    description: '阿里 Qwen 官方组合（三档，2026-11 当代代际）：A = task qwen3.7-plus/verify qwen3.8-max/triage qwen3.8-flash；B = task max/verify max(或深度思考)/triage plus；C = task flash/verify plus/triage flash。旧系列 qwen-plus/qwen-max 仍可调用但已列入旧版（qwen-max 32k 且无思考档），qwen-turbo 已由 flash 系接替。',
    source: 'https://www.alibabacloud.com/help/zh/model-studio/text-generation-model',
    status: 'ready',
    roles: {
      task: { provider: 'qwen', model: 'qwen3.7-plus', upgradeTo: 'qwen3.8-max', rationale: 'A 档：plus 执行（官方默认推荐档），max 留给 verify。' },
      verify: { provider: 'qwen', model: 'qwen3.8-max', fallback: 'qwen3.8-max（深度思考）', rationale: 'verify 恒用 max 档；⚠️ 绝不用 Flash（幻觉共振）。' },
      triage: { provider: 'qwen', model: 'qwen3.8-flash', rationale: '轻量分拣。' },
    },
    variants: [
      {
        id: 'a',
        label: 'A（均衡）',
        roles: {
          task: { provider: 'qwen', model: 'qwen3.7-plus', upgradeTo: 'qwen3.8-max', rationale: 'plus 执行。' },
          verify: { provider: 'qwen', model: 'qwen3.8-max', fallback: 'qwen3.8-max（深度思考）', rationale: 'max 审计。' },
          triage: { provider: 'qwen', model: 'qwen3.8-flash', rationale: 'flash 分拣。' },
        },
        session: { provider: 'qwen', model: 'qwen3.8-max', rationale: 'session max（仅参考）。' },
      },
      {
        id: 'b',
        label: 'B（高要求）',
        roles: {
          task: { provider: 'qwen', model: 'qwen3.8-max', rationale: 'max 执行。' },
          verify: { provider: 'qwen', model: 'qwen3.8-max', fallback: 'qwen3.8-max（深度思考）', rationale: 'max（或深度思考）审计。' },
          triage: { provider: 'qwen', model: 'qwen3.7-plus', rationale: 'plus 分拣。' },
        },
        session: { provider: 'qwen', model: 'qwen3.8-max', rationale: 'session max（仅参考）。' },
      },
      {
        id: 'c',
        label: 'C（轻量）',
        roles: {
          task: { provider: 'qwen', model: 'qwen3.8-flash', rationale: 'flash 执行（轻量场景）。' },
          verify: { provider: 'qwen', model: 'qwen3.7-plus', rationale: 'plus 审计（verify 底线，绝不用 Flash）。' },
          triage: { provider: 'qwen', model: 'qwen3.8-flash', rationale: 'flash 分拣。' },
        },
        session: { provider: 'qwen', model: 'qwen3.7-plus', rationale: 'session plus（仅参考）。' },
      },
    ],
    note: '⚠️ verify 绝不用 Flash 档（qwen3.8-flash/qwen-flash；幻觉共振：轻模型审计重模型输出会互相放大幻觉）；verify 档恒 ≥ task。v0.19.1 命名核对：qwen-turbo 已从官方目录下架（由 flash 系接替），qwen-plus/qwen-max 转入旧版（qwen-max 32k 且无思考档），故整表换用官方当前推荐的 qwen3.7-plus / qwen3.8-max / qwen3.8-flash。本部署目录未含 qwen，需部署侧具备对应 provider 方可应用。',
    sessionNote: PRESET_SESSION_NOTE,
  },
  {
    id: 'volcano-coding-plan',
    label: '火山 Coding Plan',
    description: '火山引擎 Coding Plan 组合（可用池 doubao-seed-2.1-pro / doubao-seed-evolving / doubao-seed-2.1-lite / doubao-seed-2.0-mini，另有 deepseek-v4 系与 glm 系）：A = task lite（复杂重构自动切 pro）/ verify lite（高危 fallback pro）/ triage mini；B = task mini（复杂强制 lite）/ verify lite / triage mini。',
    source: 'https://ark.volcengine.com/region:cn-beijing/docs/model-list',
    status: 'ready',
    roles: {
      task: { provider: 'bza-plan', model: 'doubao-seed-2.1-lite', upgradeTo: 'doubao-seed-2.1-pro', rationale: 'A 档：lite 执行，复杂重构自动切 pro。' },
      verify: { provider: 'bza-plan', model: 'doubao-seed-2.1-lite', fallback: 'doubao-seed-2.1-pro', rationale: 'verify 用 lite，高危任务 fallback pro；备选可换 zai-coding-cn/glm-5.3。' },
      triage: { provider: 'bza-plan', model: 'doubao-seed-2.0-mini', rationale: '最轻分拣。' },
    },
    variants: [
      {
        id: 'a',
        label: 'A（均衡）',
        roles: {
          task: { provider: 'bza-plan', model: 'doubao-seed-2.1-lite', upgradeTo: 'doubao-seed-2.1-pro', rationale: 'lite 执行，复杂重构自动切 pro。' },
          verify: { provider: 'bza-plan', model: 'doubao-seed-2.1-lite', fallback: 'doubao-seed-2.1-pro', rationale: 'lite 审计，高危 fallback pro；备选 zai-coding-cn/glm-5.3。' },
          triage: { provider: 'bza-plan', model: 'doubao-seed-2.0-mini', rationale: '最轻分拣。' },
        },
        session: { provider: 'bza-plan', model: 'doubao-seed-evolving', fallback: 'doubao-seed-2.1-pro', rationale: 'session 首选 doubao-seed-evolving，退 pro（仅参考）。' },
      },
      {
        id: 'b',
        label: 'B（成本优先）',
        roles: {
          task: { provider: 'bza-plan', model: 'doubao-seed-2.0-mini', upgradeTo: 'doubao-seed-2.1-lite', rationale: 'mini 执行，复杂任务强制 lite。' },
          verify: { provider: 'bza-plan', model: 'doubao-seed-2.1-lite', fallback: 'doubao-seed-2.1-pro', rationale: 'lite 审计不变（成本再压也不降 verify）。' },
          triage: { provider: 'bza-plan', model: 'doubao-seed-2.0-mini', rationale: '最轻分拣。' },
        },
        session: { provider: 'bza-plan', model: 'doubao-seed-evolving', fallback: 'doubao-seed-2.1-pro', rationale: 'session doubao-seed-evolving（仅参考）。' },
      },
    ],
    note: 'v0.19.1 命名核对：provider 用本部署的 bza-plan 渠道（火山系模型在本部署的唯一入口），模型 id 逐字对齐部署目录（doubao-seed-2.1-pro / doubao-seed-2.1-lite / doubao-seed-2.0-mini / doubao-seed-evolving；旧文案的 Seed-2.1-lite 等商品名形式已更正）；官方方舟 Doubao-Seed-2.1 系列提供 pro/turbo/lite 三档。verify/复杂 task 的 fallback 可换 zai-coding-cn/glm-5.3（外部家族），但禁给 triage/普通 task；session 首选 doubao-seed-evolving（持续演化档）。',
    sessionNote: PRESET_SESSION_NOTE,
  },
  {
    id: 'minimax',
    label: 'Minimax',
    description: 'Minimax 官方组合：task M3.1-Flash(effort high，可升 xhigh) / verify M3 / triage M3.1-Flash(effort low，可升 medium)；session M3（参考）。',
    source: 'https://platform.minimax.io/docs/guides/text-generation',
    status: 'ready',
    roles: {
      task: { provider: 'minimax', model: 'MiniMax-M3.1-Flash', reasoningEffort: 'high', upgradeTo: 'MiniMax-M3.1-Flash (xhigh)', rationale: 'Flash 执行主力，effort high 起步。' },
      verify: { provider: 'minimax', model: 'MiniMax-M3', rationale: 'verify 用当代旗舰 M3：判断力强、能承认不确定性。' },
      triage: { provider: 'minimax', model: 'MiniMax-M3.1-Flash', reasoningEffort: 'low', upgradeTo: 'MiniMax-M3.1-Flash (medium)', rationale: '轻量分拣 low 档。' },
    },
    variants: [{
      id: 'standard',
      label: '标准组合',
      roles: {
        task: { provider: 'minimax', model: 'MiniMax-M3.1-Flash', reasoningEffort: 'high', upgradeTo: 'MiniMax-M3.1-Flash (xhigh)', rationale: 'Flash 执行。' },
        verify: { provider: 'minimax', model: 'MiniMax-M3', rationale: 'M3 审计。' },
        triage: { provider: 'minimax', model: 'MiniMax-M3.1-Flash', reasoningEffort: 'low', upgradeTo: 'MiniMax-M3.1-Flash (medium)', rationale: '轻量分拣。' },
      },
      session: { provider: 'minimax', model: 'MiniMax-M3', rationale: 'session 用 M3（仅参考）。' },
    }],
    note: 'verify 必须能承认不确定性（M3 的校准优于 Flash）；缓存读 4 倍差价——同前缀的重复轮次成本敏感，triage effort 保持 low。v0.19.1 核对：MiniMax-M3 与 MiniMax-M3.1-Flash 均为官方 API model 枚举内的真实 id（M3.1-Flash 为 M 系最新，支持思考深度调节）；本部署目录未含 minimax，需部署侧具备对应 provider 方可应用。',
    sessionNote: PRESET_SESSION_NOTE,
  },
  {
    id: 'glm',
    label: 'GLM',
    description: '智谱 GLM 官方组合（两个变体，provider 一律 zai-coding-cn）：标准组合 = task glm-5.3-flash(effort high，可升 glm-5.3 max) / verify glm-5.3(effort max) / triage glm-5.3-flash(effort low)；重活命名角色（frontend 等）= task/verify glm-5.3(effort max) / triage glm-5.3-flash(effort low)；session glm-5.3(effort high，参考)。',
    status: 'ready',
    roles: {
      task: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'high', upgradeTo: 'glm-5.3 (max)', rationale: '量最大的角色，effort 杠杆收益最大处；不用 low 兜底——太弱触发 verify 拒绝循环反而更贵；Flash 上 high 思考成本约是 5.3 的 1/10。' },
      verify: { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max', rationale: '全系统最不该省的位置：假阳性静默污染整个循环；只跑 full 轮、调用量低，max token 溢价付得起；测量点多花计算=降低测量噪声。' },
      triage: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'low', rationale: '四分类小输入小输出，机制性工作；在轮次收敛关键路径上，low 顺带压 wall-clock。' },
    },
    variants: [
      {
        id: 'standard',
        label: '标准组合',
        roles: {
          task: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'high', upgradeTo: 'glm-5.3 (max)', rationale: 'Flash 执行主力，effort high；难题升 glm-5.3 max。' },
          verify: { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max', rationale: 'verify 恒 glm-5.3 max：审计岗不省这一层。' },
          triage: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'low', rationale: '轻量分拣 low 档。' },
        },
        session: { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'high', rationale: '规划/brief 写作受益于思考，但外环、用户面对面，max 延迟和 token 不值；high 档做 fallback 执行者也够用（仅参考）。' },
      },
      {
        id: 'heavy-named-roles',
        label: '重活命名角色（frontend 等）',
        roles: {
          task: { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max', rationale: '官方建议复杂 coding 用 max；按需触发，只在难 subgoal 上生效。' },
          verify: { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max', rationale: 'verify 与 task 同级 max，同家族下以最高档补偿独立性损失。' },
          triage: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'low', rationale: '轻量分拣不变。' },
        },
        session: { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'high', rationale: 'session 同标准组合（仅参考）。' },
      },
    ],
    note: '命名角色（frontend 等）的 glm-5.3 max effort 只按需生效（智能选择命中难 subgoal 时），避免全量 max；verify 恒 glm-5.3 max，成本不构成降级理由。',
    sessionNote: PRESET_SESSION_NOTE,
  },
]

// Normalize the mirror invariant: a READY preset's top-level `roles` IS its
// default variant's roles object (identity, not a copy) — the single source
// of truth for the combination lives in variants[0]; the inline `roles`
// literals above exist only for placeholder-status entries.
for (const preset of VENDOR_PRESETS) {
  if (preset.status === 'ready' && Array.isArray(preset.variants) && preset.variants.length > 0 && preset.variants[0]) {
    preset.roles = preset.variants[0].roles
  }
}

/** The dropdown's display label for any selector id (auto included). */
export function presetChoiceLabel(id: string): string {
  if (id === PRESET_AUTO_ID) return '根据现有配置自动推荐'
  return VENDOR_PRESETS.find((p) => p.id === id)?.label ?? id
}

/** Look one registry entry up by id (vendors only; `auto` has no entry). */
export function presetById(id: string): VendorPreset | undefined {
  return VENDOR_PRESETS.find((p) => p.id === id)
}

/** All vendor entries, regardless of status (prompt reference material). */
export function allVendorPresets(): VendorPreset[] {
  return [...VENDOR_PRESETS]
}

/** Resolve a preset's variant (default = the first one); undefined when absent. */
export function presetVariant(preset: VendorPreset, variantId?: string): PresetVariant | undefined {
  if (Array.isArray(preset.variants) && preset.variants.length > 0) {
    if (variantId === undefined || variantId === null || variantId === '') return preset.variants[0]
    return preset.variants.find((v) => v !== undefined && v.id === variantId) ?? preset.variants[0]
  }
  return undefined
}

// --- recommendation request (pure) ---------------------------------------------

/** Everything the pure request builder needs. */
export interface RecommendationRequestInput {
  /** Live catalog candidates (probeCatalogOptions output). */
  options: CatalogOption[]
  /** The folded EXPLICIT overrides the panel fields currently carry. */
  currentOverrides: RolesConfig
  /** Vendor reference material; defaults to allVendorPresets(). */
  presets?: VendorPreset[]
}

/** One built recommendation request (system + user), ready for the LLM call. */
export interface RecommendationRequest {
  system: string
  user: string
}

/** Render one catalog line for the prompt (stable, bounded). */
function catalogLine(option: CatalogOption): string {
  const meta = [option.name, option.description].filter(Boolean).join(' — ')
  return `- ${option.provider}/${option.model}${meta ? ` (${meta})` : ''}`
}

/** Render one configured role row (or its inherit stance) for the prompt. */
function currentRow(roleKey: string, spec: RoleSpec | undefined): string {
  if (!spec || (!spec.provider && !spec.model)) return `- ${roleKey}: （未配置，继承 session agent）`
  const bits = [spec.provider, spec.model].filter(Boolean).join('/')
  return `- ${roleKey}: ${bits}${spec.reasoningEffort ? `（思考强度 ${spec.reasoningEffort}）` : ''}`
}

/** Render one vendor preset as prompt reference (variants + session noted). */
function presetBlock(preset: VendorPreset): string {
  const lines = [`### ${preset.label}（id: ${preset.id}，${preset.status === 'ready' ? '已填充' : '占位待填充'}）`, preset.description]
  if (preset.source) lines.push(`来源: ${preset.source}`)
  if (preset.note) lines.push(`注意: ${preset.note}`)
  for (const variant of Array.isArray(preset.variants) ? preset.variants : []) {
    const roles = Object.entries(variant?.roles ?? {}).filter(([, spec]) => spec && (spec!.provider || spec!.model))
    const roleText = roles.length > 0
      ? roles.map(([roleKey, spec]) => `${roleKey}=${[spec!.provider, spec!.model].filter(Boolean).join('/')}${spec!.reasoningEffort ? `(effort ${spec!.reasoningEffort})` : ''}`).join('，')
      : '（组合待填充）'
    lines.push(`- 变体「${variant?.label ?? variant?.id}」：${roleText}`)
    if (variant?.session && (variant.session.provider || variant.session.model)) {
      lines.push(`  - session 参考（不在推荐范围，勿输出）：${[variant.session.provider, variant.session.model].filter(Boolean).join('/')}`)
    }
  }
  return lines.join('\n')
}

/**
 * Build the auto-recommendation REQUEST: the system prompt fixes the output
 * contract (JSON only; pick ONLY from the catalog; session agent OUT OF
 * SCOPE — the output carries exactly task/verify/triage; null = keep
 * current; optional per-role reasoningEffort), the user prompt carries the
 * live catalog, the current role config, the cross-vendor principles and the
 * vendor presets as advisory reference. Pure and bounded — the catalog is
 * capped at 200 lines so a huge directory cannot blow the input budget.
 */
export function buildRecommendationPrompt(input: RecommendationRequestInput): RecommendationRequest {
  const options = Array.isArray(input.options) ? input.options.slice(0, 200) : []
  const presets = Array.isArray(input.presets) ? input.presets : allVendorPresets()
  const overrides = input.currentOverrides && typeof input.currentOverrides === 'object' ? input.currentOverrides : {}
  const system = [
    '你是一个模型分配助手。DSH 的 cybernetics 循环由三个子 agent 角色组成：',
    '- task：执行任务本身（写代码/分析/产出交付物）；',
    '- verify：独立审计 task 的结果（不继承任务叙事，需要判断力）；',
    '- triage：读 task/verify 结果做收敛分拣（轻量决策）。',
    '用户会在「根据现有配置自动推荐」时请你从当前系统实际可用的模型列表中为每个角色选择合适的模型。',
    '范围（最高优先）：session agent（主会话 agent）不在推荐范围内，其模型由用户自行管理——输出 JSON 只允许 task/verify/triage 三个键，禁止输出 session 键。',
    '规则：',
    '1. 只能从「可用模型列表」中选择，逐字使用其中的 provider/model；列表外的模型一律禁止推荐。',
    '2. 通用原则：verify 的模型档位不得低于 task；verify 与 task 保持跨代际/跨家族独立（同一模型时 verify 升高一档补偿）；verify 不能过度自信；省成本先压 task/triage、verify 最后动；成本不是降级 verify 的理由；triage 选便宜快速的模型。',
    '3. 某个角色如维持现状更好（例如当前配置已是最优、或列表中没有更好的选择），输出 null 保持现状。',
    '4. 「厂商预置方案」只是参考资料（各家产品思路），不是可选项——目录里没有的模型组合不要采纳。',
    '5. reasoningEffort 可选：仅当你确知该模型提供该思考强度档位时输出（例如 low/medium/high/xhigh/max 等），否则省略该字段；task 建议 medium/high，verify 至少 high，triage 建议 low。',
    '6. 只输出一个 JSON 对象，不要解释、不要 markdown 代码块之外的文字。格式：',
    '{"task":{"provider":"<provider>","model":"<model>","reasoningEffort":"<可选>"}|null,"verify":...,"triage":...}',
  ].join('\n')
  const user = [
    '## 当前系统可用模型列表（唯一可选来源）',
    options.length > 0 ? options.map(catalogLine).join('\n') : '（空——此时无法推荐，全部输出 null）',
    '',
    '## 通用分配原则',
    CROSS_VENDOR_PRINCIPLES.map((line) => `- ${line}`).join('\n'),
    '',
    '## 当前 cybernetics 角色模型配置（仅三个子 agent 角色）',
    [
      currentRow('task', overrides.default),
      currentRow('verify', overrides.verify),
      currentRow('triage', overrides.triage),
    ].join('\n'),
    '',
    '## 厂商预置方案（参考背景，非可选来源；其中的 session 条目仅供了解各家思路，禁止作为输出）',
    presets.length > 0 ? presets.map(presetBlock).join('\n') : '（无）',
    '',
    '请输出推荐 JSON（只含 task/verify/triage 三个键）。',
  ].join('\n')
  return { system, user }
}

/** The brief handed to the session agent through the preset_recommend tool. */
export interface RecommendationBrief {
  /** false = the catalog was empty/unavailable — nothing to hand off. */
  ok: boolean
  /** Degradation reason when ok is false. */
  reason?: string
  /** Live catalog size at brief time. */
  catalogSize: number
  /** The complete tool-return text when ok (contract + material + protocol). */
  text?: string
}

/** The two-hop protocol footer appended to every brief (how to answer). */
const BRIEF_PROTOCOL = [
  '## 你的任务（插件交办，请在本回合直接完成，不要新起任何 LLM 调用或子 agent）',
  '请阅读上面的可用模型列表、通用原则、当前配置与厂商参考，在自己已有的上下文中直接判断，',
  '然后再次调用本工具（' + PRESET_RECOMMEND_TOOL_NAME + '）并在 `recommendation` 参数中传入推荐 JSON。',
  'JSON 只含 task/verify/triage 三个键；某角色维持现状输出 null；可选 reasoningEffort 字段遵循上文规则。',
  '示例：{"task":{"provider":"<provider>","model":"<model>","reasoningEffort":"high"},"verify":null,"triage":null}',
  '插件负责校验（逐字命中目录、effort 支持性）并把结果写入 task/verify/triage 配置；无需你写入任何配置。',
].join('\n')

/**
 * Build the auto-recommendation BRIEF handed to the session agent
 * (v0.18.2, replaces the old request+one-shot-call pair): the session
 * agent's system-side contract (buildRecommendationPrompt's system prompt)
 * plus the material (catalog/principles/config/vendor reference) plus the
 * two-hop answer protocol. Pure and bounded — the catalog is capped at 200
 * lines so a huge directory cannot blow the input budget. An empty or
 * unavailable catalog returns ok:false (the caller degrades).
 */
export function buildRecommendationBrief(input: RecommendationRequestInput): RecommendationBrief {
  const options = Array.isArray(input.options) ? input.options : []
  const catalogSize = options.length
  if (catalogSize === 0) {
    return { ok: false, reason: '当前系统模型目录不可用或为空，无法推荐', catalogSize: 0 }
  }
  const request = buildRecommendationPrompt(input)
  return { ok: true, catalogSize, text: [request.system, '', request.user, '', BRIEF_PROTOCOL].join('\n') }
}

// --- response parsing (pure) ---------------------------------------------------

/** One recommended pick: the catalog-matched option plus an optional effort. */
export interface RecommendedPick extends CatalogOption {
  /** Suggested reasoning-effort token (unvalidated until validatePickEfforts). */
  reasoningEffort?: string
}

/** Parsed recommendation: per-role picks (undefined = keep current). */
export interface RecommendationPicks {
  task?: RecommendedPick
  verify?: RecommendedPick
  triage?: RecommendedPick
}

/** One parse outcome: `ok` false means the response was unusable as a whole. */
export interface RecommendationParse {
  ok: boolean
  /** Error note when ok is false (parse failure / shape violation). */
  error?: string
  /** Per-role catalog-matched picks (only when ok). */
  picks: RecommendationPicks
  /** Roles the model answered for with entries NOT in the catalog (dropped). */
  invalid: string[]
  /** Set when the reply carried a `session` key (dropped: user-managed scope). */
  ignoredSession: boolean
  /** Suggested efforts that were dropped for shape reasons (never applied). */
  droppedEfforts: string[]
}

/** Extract the outermost JSON object text from a model reply (fences stripped). */
export function extractJsonBlock(text: string): string | undefined {
  const raw = typeof text === 'string' ? text : ''
  const start = raw.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return raw.slice(start, i + 1)
    }
  }
  return undefined
}

/** Match one suggested {provider, model} against the live catalog (same rules as the panel: exact provider/model, else bare model). */
function matchOption(suggested: unknown, options: CatalogOption[]): CatalogOption | undefined {
  if (suggested === null || typeof suggested !== 'object') return undefined
  const provider = (suggested as { provider?: unknown }).provider
  const model = (suggested as { model?: unknown }).model
  const p = typeof provider === 'string' ? provider.trim() : ''
  const m = typeof model === 'string' ? model.trim() : ''
  if (!m) return undefined
  if (p) return options.find((o) => o.provider === p && o.model === m) ?? options.find((o) => o.model === m)
  return options.find((o) => o.model === m)
}

/** Sanitize a suggested effort token: non-empty trimmed string, bounded. */
function sanitizeEffortToken(value: unknown, roleKey: string, dropped: string[]): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (text === '') return undefined
  if (text.length > 40) {
    dropped.push(`${roleKey}: effort 超长已忽略`)
    return undefined
  }
  return text
}

/**
 * Parse a model reply into per-role picks. Strict: every suggested model
 * must resolve against the live catalog (the model may only pick what the
 * deployment can actually route); non-null roles that match nothing are
 * dropped into `invalid` (reported, not applied). A `session` key — which
 * the prompt forbids — is dropped with `ignoredSession` (the user manages
 * the session model; a session pick can never reach an op). A wholly
 * unusable reply (no JSON / wrong shape) returns ok:false — the caller
 * degrades.
 */
export function parseRecommendation(text: string, options: CatalogOption[]): RecommendationParse {
  const json = extractJsonBlock(typeof text === 'string' ? text : '')
  if (json === undefined) return { ok: false, error: '回复中没有找到 JSON 对象', picks: {}, invalid: [], ignoredSession: false, droppedEfforts: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    return { ok: false, error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`, picks: {}, invalid: [], ignoredSession: false, droppedEfforts: [] }
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, error: '回复不是 JSON 对象', picks: {}, invalid: [], ignoredSession: false, droppedEfforts: [] }
  const record = parsed as Record<string, unknown>
  const picks: RecommendationPicks = {}
  const invalid: string[] = []
  const droppedEfforts: string[] = []
  let ignoredSession = false
  // The session key is structurally out of scope: recorded, never applied.
  if (record.session !== undefined) ignoredSession = true
  for (const roleKey of ['task', 'verify', 'triage'] as const) {
    const suggested = record[roleKey]
    if (suggested === undefined || suggested === null) continue
    const matched = matchOption(suggested, options)
    if (matched === undefined) {
      const shown = typeof suggested === 'object' && suggested !== null
        ? [(suggested as { provider?: unknown }).provider, (suggested as { model?: unknown }).model].filter(Boolean).join('/') || String(JSON.stringify(suggested))
        : String(suggested)
      invalid.push(`${roleKey}: ${shown}`)
      continue
    }
    const effort = sanitizeEffortToken((suggested as { reasoningEffort?: unknown }).reasoningEffort, roleKey, droppedEfforts)
    picks[roleKey] = effort !== undefined ? { ...matched, reasoningEffort: effort } : { ...matched }
  }
  return { ok: true, picks, invalid, ignoredSession, droppedEfforts }
}

/**
 * Soft effort validation for auto picks: when the host exposes
 * `resolveModelInfo`, check each pick's suggested effort against the exact
 * model's offered efforts and DROP mismatches (model kept, effort cleared —
 * the round then uses the model default). Every seam failure keeps the pick
 * unvalidated (the schema's sanitizeReasoningEffort still guards round
 * start). Never throws; returns the (possibly effort-stripped) picks and
 * human-readable notes.
 */
export async function validatePickEfforts(
  ctx: unknown,
  picks: RecommendationPicks,
): Promise<{ picks: RecommendationPicks; notes: string[] }> {
  const notes: string[] = []
  let resolve: ((provider: string, model: string) => Promise<unknown>) | undefined
  try {
    const llm = (ctx as { llm?: unknown } | null | undefined)?.llm as { resolveModelInfo?: unknown } | undefined
    if (llm && typeof llm.resolveModelInfo === 'function') {
      resolve = (provider: string, model: string) => (llm.resolveModelInfo as (p: string, m: string) => Promise<unknown>)(provider, model)
    }
  } catch { /* Cordis proxy guard: face absent */ }
  if (resolve === undefined) return { picks, notes }
  const next: RecommendationPicks = { ...picks }
  for (const roleKey of ['task', 'verify', 'triage'] as const) {
    const pick = next[roleKey]
    if (pick === undefined || pick.reasoningEffort === undefined) continue
    try {
      const info = await resolve(pick.provider, pick.model) as { reasoning?: { efforts?: Array<{ id?: unknown }> } } | undefined
      const efforts = info?.reasoning?.efforts
      if (Array.isArray(efforts) && efforts.length > 0) {
        const ids = efforts.map((lv) => (lv && typeof lv.id === 'string' ? lv.id : '')).filter((id) => id !== '')
        if (ids.length > 0 && !ids.includes(pick.reasoningEffort)) {
          notes.push(`${roleKey}: 推荐 effort「${pick.reasoningEffort}」不被 ${pick.provider}/${pick.model} 支持，已改为模型默认`)
          const { reasoningEffort: _dropped, ...rest } = pick
          next[roleKey] = rest
        }
      }
    } catch { /* isolated failure: keep the pick unvalidated */ }
  }
  return { picks: next, notes }
}

// --- apply ops (pure) ------------------------------------------------------------

/**
 * One settings-form mutation op (the panel write path's wire shape). `unset`
 * restores the schema default ('' = model default effort) — used to clear a
 * stale effort when the role's model changes without carrying one.
 */
export interface SettingsOp {
  op: 'set' | 'unset'
  path: string[]
  value?: string
}

/** The flat model field each sub-agent role maps to. */
const ROLE_FIELD: Record<keyof RecommendationPicks, string> = {
  task: 'taskAgentModel',
  verify: 'verifyAgentModel',
  triage: 'triageAgentModel',
}

/** The flat effort field each sub-agent role maps to. */
const ROLE_EFFORT_FIELD: Record<keyof RecommendationPicks, string> = {
  task: 'taskAgentReasoningEffort',
  verify: 'verifyAgentReasoningEffort',
  triage: 'triageAgentReasoningEffort',
}

/**
 * The ONLY config paths a preset selection / auto recommendation may ever
 * write: the three sub-agent model fields and their three effort pairs. The
 * session agent's configuration is user-managed and structurally unreachable
 * here — ops builders filter through this set (defense in depth; tests pin
 * it against every registry entry).
 */
export const ALLOWED_OP_PATHS: ReadonlySet<string> = new Set([
  'taskAgentModel', 'verifyAgentModel', 'triageAgentModel',
  'taskAgentReasoningEffort', 'verifyAgentReasoningEffort', 'triageAgentReasoningEffort',
])

/** Keep only ops whose path the feature is allowed to write (order preserved). */
export function filterAllowedOps(ops: SettingsOp[]): SettingsOp[] {
  return ops.filter((op) => op !== null && typeof op === 'object' && typeof op.path?.[0] === 'string' && ALLOWED_OP_PATHS.has(op.path[0]))
}

/** Build the set/unset ops that apply per-role picks to the flat volatile fields. */
export function recommendationApplyOps(picks: RecommendationPicks): SettingsOp[] {
  const ops: SettingsOp[] = []
  for (const roleKey of ['task', 'verify', 'triage'] as const) {
    const pick = picks[roleKey]
    if (!pick) continue
    ops.push({ op: 'set', path: [ROLE_FIELD[roleKey]], value: `${pick.provider}/${pick.model}` })
    // The role's model is changing: a carried effort is applied, a stale one
    // (from the previous model) is reset to the model default via unset.
    ops.push(
      pick.reasoningEffort !== undefined && pick.reasoningEffort !== ''
        ? { op: 'set', path: [ROLE_EFFORT_FIELD[roleKey]], value: pick.reasoningEffort }
        : { op: 'unset', path: [ROLE_EFFORT_FIELD[roleKey]] },
    )
  }
  return filterAllowedOps(ops)
}

/**
 * Build the set/unset ops that apply a vendor preset (default variant unless
 * `variantId` names another) to the flat fields. Placeholder presets apply
 * nothing — returns {ready:false, ops:[], variant: undefined}. The session
 * suggestion (variant.session) is reference data and can never appear: only
 * task/verify/triage are read.
 */
export function vendorPresetApplyOps(
  preset: VendorPreset,
  variantId?: string,
): { ready: boolean; ops: SettingsOp[]; variant?: PresetVariant } {
  if (preset.status !== 'ready') return { ready: false, ops: [] }
  const variant = presetVariant(preset, variantId)
  const roles = variant !== undefined ? variant.roles : preset.roles
  const ops: SettingsOp[] = []
  const entries: Array<[keyof RecommendationPicks, PresetRoleSpec | undefined]> = [
    ['task', roles.task],
    ['verify', roles.verify],
    ['triage', roles.triage],
  ]
  for (const [roleKey, spec] of entries) {
    if (!spec || (!spec.provider && !spec.model)) continue
    const value = spec.provider ? `${spec.provider}/${spec.model}` : String(spec.model)
    ops.push({ op: 'set', path: [ROLE_FIELD[roleKey]], value })
    ops.push(
      spec.reasoningEffort !== undefined && spec.reasoningEffort !== ''
        ? { op: 'set', path: [ROLE_EFFORT_FIELD[roleKey]], value: spec.reasoningEffort }
        : { op: 'unset', path: [ROLE_EFFORT_FIELD[roleKey]] },
    )
  }
  return { ready: true, ops: filterAllowedOps(ops), ...(variant !== undefined ? { variant } : {}) }
}

// --- custom presets (用户自定义方案, v0.19) ---------------------------------------

/**
 * The presetPlan selector id prefix that marks a USER-SAVED combination
 * (「自定义方案」). The full selector value is `<prefix><id>` where id is the
 * stable entry id inside the `customPresets` config field. The prefix keeps
 * custom ids structurally distinct from the fixed registry ids (and from the
 * vendor ids a future registry edit could collide with).
 */
export const CUSTOM_PRESET_PREFIX = 'custom:'

/** True when a presetPlan selector value names a user-saved combination. */
export function isCustomPresetId(plan: string): boolean {
  return typeof plan === 'string' && plan.startsWith(CUSTOM_PRESET_PREFIX)
}

/** The registry entry id of a custom selector value (strips the prefix). */
export function customPresetEntryId(plan: string): string {
  return isCustomPresetId(plan) ? plan.slice(CUSTOM_PRESET_PREFIX.length) : ''
}

/**
 * One user-saved combination (「自定义方案」): exactly what the settings card
 * currently carries for task/verify/triage (model routes + effort tokens),
 * captured verbatim. Storage is the plugin's `customPresets` config field —
 * a compact JSON array serialized by serializeCustomPresets (backward
 * compatible: the field is new, defaults to '', and old readers simply see
 * no such key).
 */
export interface CustomPreset {
  /** Stable unique entry id (the selector value is CUSTOM_PRESET_PREFIX + id). */
  id: string
  /** User-chosen display name (unique across custom presets — enforced by the save UI). */
  name: string
  /** ISO time the entry was created (refreshed on overwrite). */
  at: string
  /** The captured combination — the three SUB-AGENT roles only (session is user-managed, structurally out of scope). */
  roles: { task?: PresetRoleSpec; verify?: PresetRoleSpec; triage?: PresetRoleSpec }
}

/** One role spec extracted from the card's flat config values (undefined = unset/inherit). */
export interface CustomRoleCapture {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/**
 * Capture the card's current task/verify/triage combination (the flat
 * `*AgentModel` / `*AgentReasoningEffort` values) into a CustomPreset's
 * roles object. A model value is parsed as `provider/model` when it carries
 * a slash (bare model names keep undefined provider, exactly the runtime's
 * parseAgentModelSpec acceptance); blank model/effort fields are dropped so
 * the stored entry never carries empty strings.
 */
export function captureCustomRoles(values: {
  taskAgentModel?: unknown; taskAgentReasoningEffort?: unknown
  verifyAgentModel?: unknown; verifyAgentReasoningEffort?: unknown
  triageAgentModel?: unknown; triageAgentReasoningEffort?: unknown
}): CustomPreset['roles'] {
  const parseModel = (raw: unknown): CustomRoleCapture | undefined => {
    const text = raw === undefined || raw === null ? '' : String(raw).trim()
    if (text === '') return undefined
    const slash = text.indexOf('/')
    return slash > 0
      ? { provider: text.slice(0, slash), model: text.slice(slash + 1) }
      : { model: text }
  }
  const parseEffort = (raw: unknown): string | undefined => {
    const text = raw === undefined || raw === null ? '' : String(raw).trim()
    return text === '' ? undefined : text
  }
  const roles: CustomPreset['roles'] = {}
  const pairs: Array<[keyof CustomPreset['roles'], CustomRoleCapture | undefined, string | undefined]> = [
    ['task', parseModel(values.taskAgentModel), parseEffort(values.taskAgentReasoningEffort)],
    ['verify', parseModel(values.verifyAgentModel), parseEffort(values.verifyAgentReasoningEffort)],
    ['triage', parseModel(values.triageAgentModel), parseEffort(values.triageAgentReasoningEffort)],
  ]
  for (const [roleKey, model, effort] of pairs) {
    if (model === undefined && effort === undefined) continue
    roles[roleKey] = {
      ...(model?.provider !== undefined ? { provider: model.provider } : {}),
      ...(model?.model !== undefined ? { model: model.model } : {}),
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    }
  }
  return roles
}

const CUSTOM_ROLES = ['task', 'verify', 'triage'] as const

/**
 * Parse the `customPresets` config field (a compact JSON array). Fully
 * defensive: anything that is not an array of well-shaped entries returns
 * the valid prefix (a corrupt entry is dropped, never a throw) — a broken
 * storage payload must not take down the settings card or the selection
 * handler. Entries with an empty id or name are invalid.
 */
export function parseCustomPresets(text: unknown): CustomPreset[] {
  if (typeof text !== 'string' || text.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: CustomPreset[] = []
  for (const raw of parsed) {
    if (raw === null || typeof raw !== 'object') continue
    const record = raw as Partial<CustomPreset>
    if (typeof record.id !== 'string' || record.id === '') continue
    if (typeof record.name !== 'string' || record.name.trim() === '') continue
    if (record.roles === null || typeof record.roles !== 'object') continue
    const roles: CustomPreset['roles'] = {}
    const source = record.roles as Record<string, unknown>
    for (const roleKey of CUSTOM_ROLES) {
      const spec = source[roleKey]
      if (spec === null || typeof spec !== 'object') continue
      const entry = spec as Partial<PresetRoleSpec>
      const next: PresetRoleSpec = {}
      if (typeof entry.provider === 'string' && entry.provider !== '') next.provider = entry.provider
      if (typeof entry.model === 'string' && entry.model !== '') next.model = entry.model
      if (typeof entry.reasoningEffort === 'string' && entry.reasoningEffort !== '') next.reasoningEffort = entry.reasoningEffort
      if (next.provider !== undefined || next.model !== undefined) roles[roleKey] = next
    }
    out.push({
      id: record.id,
      name: record.name.trim(),
      ...(typeof record.at === 'string' && record.at !== '' ? { at: record.at } : { at: '' }),
      roles,
    })
  }
  return out
}

/** Serialize the custom-preset list into the config field (compact JSON). */
export function serializeCustomPresets(list: CustomPreset[]): string {
  return JSON.stringify(Array.isArray(list) ? list : [])
}

/**
 * Adapt one custom preset into the VendorPreset shape so the existing
 * `vendorPresetApplyOps` builds its apply ops (same six-field bound, same
 * effort unset semantics, same filterAllowedOps guarantee). `ready` status
 * with a single variant mirroring `roles` — the exact mirror invariant the
 * registry normalizes for built-ins.
 */
export function customPresetAsVendor(preset: CustomPreset): VendorPreset {
  return {
    id: preset.id as VendorPreset['id'],
    label: preset.name,
    description: `用户自定义方案「${preset.name}」`,
    status: 'ready',
    roles: preset.roles,
    variants: [{ id: 'custom', label: preset.name, roles: preset.roles }],
    note: '自定义方案：保存时从设置卡片当前组合捕获，仅含 task/verify/triage 三个子 agent 角色。',
    sessionNote: PRESET_SESSION_NOTE,
  }
}

// --- outcome record (the card-visible status) -----------------------------------

/** The JSON record written into the volatile `presetRecommendation` field. */
export interface PresetRecommendationRecord {
  /**
   * ok = applied (auto picks or a ready vendor); pending = the auto request
   * was handed to the session agent (v0.18.2, awaiting its tool submission);
   * placeholder = noted, nothing changed; degraded = why.
   */
  status: 'ok' | 'pending' | 'placeholder' | 'degraded'
  /** The selector id this record belongs to ('auto' or a vendor id). */
  preset: string
  /** Display label at apply time. */
  label: string
  /** ISO time of the outcome. */
  at: string
  /** Live catalog size at decision time. */
  catalogSize?: number
  /** Applied per-role routes ('provider/model') — ok only. */
  picks?: Record<string, string>
  /** Applied per-role effort tokens ('' = model default reset) — ok only. */
  efforts?: Record<string, string>
  /** The variant label applied for a vendor preset (default variant first). */
  variant?: string
  /** Remaining variant labels the user can switch to by editing the registry. */
  otherVariants?: string[]
  /** Suggested-but-off-catalog entries — ok with invalid picks only. */
  invalid?: string[]
  /** Effort-validation / session-scope notes (auto flow). */
  notes?: string[]
  /** Degradation / placeholder / pending note. */
  reason?: string
}

/** Serialize one outcome record for the volatile field (compact JSON). */
export function formatRecommendationRecord(record: PresetRecommendationRecord): string {
  return JSON.stringify(record)
}

/** Parse the volatile field back into a record (client + tests; undefined when absent/corrupt). */
export function parseRecommendationRecord(text: unknown): PresetRecommendationRecord | undefined {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object') return undefined
    const record = parsed as Partial<PresetRecommendationRecord>
    if (record.status !== 'ok' && record.status !== 'pending' && record.status !== 'placeholder' && record.status !== 'degraded') return undefined
    if (typeof record.preset !== 'string' || typeof record.label !== 'string') return undefined
    return record as PresetRecommendationRecord
  } catch {
    return undefined
  }
}

// --- submit side: validate the session agent's answer (pure + soft) --------------

/**
 * The outcome of one submitted recommendation (the session agent's answer
 * routed back through the preset_recommend tool): applied ops or a fully
 * explained degradation. Mirrors the old recommendModels failure semantics —
 * unusable reply / zero picks degrade, every failure names its reason.
 */
export type SubmittedRecommendation =
  | {
    ok: true
    picks: RecommendationPicks
    ops: SettingsOp[]
    invalid: string[]
    notes: string[]
    ignoredSession: boolean
  }
  | {
    ok: false
    reason: string
  }

/**
 * Validate a session agent's submitted recommendation against the LIVE
 * catalog and build the apply ops (v0.18.2 submit side — the plugin never
 * calls an LLM itself, it only validates and writes): strict catalog parse
 * (parseRecommendation — off-catalog models dropped and reported, a session
 * key ignored with an explicit note) → soft effort validation
 * (validatePickEfforts via ctx.llm.resolveModelInfo) → apply ops bounded to
 * the six flat sub-agent fields. Never throws; a wholly unusable answer
 * returns ok:false with the reason (the tool surfaces it back to the
 * session agent so it can correct and re-submit).
 */
export async function applyRecommendationAnswer(
  ctx: unknown,
  answer: unknown,
  options: CatalogOption[],
): Promise<SubmittedRecommendation> {
  const parse = parseRecommendation(typeof answer === 'string' ? answer : '', options)
  if (!parse.ok) return { ok: false, reason: `推荐回复不可用：${parse.error}` }
  const validated = await validatePickEfforts(ctx, parse.picks)
  const picks = validated.picks
  const ops = recommendationApplyOps(picks)
  const notes = [...validated.notes, ...parse.droppedEfforts.map((d) => `推荐 effort 已忽略：${d}`)]
  if (parse.ignoredSession) notes.push('推荐回复含 session 键，已忽略（session 由用户自行管理）')
  if (ops.length === 0) {
    return {
      ok: false,
      reason: parse.invalid.length > 0
        ? `推荐未命中目录内模型（${parse.invalid.join('；')}），未应用任何更改`
        : '推荐结果为空（建议全部保持现状），未应用任何更改',
    }
  }
  return { ok: true, picks, ops, invalid: parse.invalid, notes, ignoredSession: parse.ignoredSession }
}

