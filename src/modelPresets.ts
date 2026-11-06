/**
 * v0.17 preset plans (预置方案): a data-driven registry of model combinations
 * for the cybernetics sub-agent loop, surfaced on the settings card as a
 * dropdown. Two kinds of entries share one structure:
 *
 *  - `auto` — 「根据现有配置自动推荐」: read the host's LIVE model catalog
 *    (`probeCatalogOptions`, the same directory the smart selection uses),
 *    build a recommendation REQUEST that embeds the catalog, the current
 *    role config, the cross-vendor principles AND every vendor preset below
 *    as reference context, run one guarded one-shot LLM call, parse the
 *    per-role picks and write them into the flat volatile model/effort fields
 *    (taskAgentModel / verifyAgentModel / triageAgentModel ± their
 *    ReasoningEffort pairs) through the settings service — the exact write
 *    path the panel's own fallback (directMutate → remote.settings.mutate →
 *    @deepseek-ai/dsh-settings SettingsForms.mutate → config editor user
 *    patch row) uses.
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
 *   note); the auto flow picks only models present in the live catalog.
 *   A vendor id missing from this deployment shows the settings card's
 *   model-unavailable warning and the round's availability fallback keeps the
 *   round alive — data-driven honesty over silent rewriting.
 * - The LLM call is a soft seam: the host exposes a raw one-shot completion
 *   face (`ctx.llm.prepareCall(...).stream()` — the dsh-session-title-llm
 *   pattern), but this plugin stays deliberately zero-dependency on
 *   @deepseek-ai packages, so the message and the chunk collector are built
 *   inline (a user message is `{role, id, content, source}`; visible text
 *   arrives as `text-delta` chunks). Any missing face / transport error /
 *   parse failure degrades to a written degraded-status record — the flow
 *   can never throw into the loader event path and never blocks a round.
 * - Effort ids are model-dependent. A vendor preset's effort token is applied
 *   as configured (the schema's sanitizeReasoningEffort drops an unsupported
 *   id at round time and the card shows the effective-default note); the AUTO
 *   picks' efforts are validated against `ctx.llm.resolveModelInfo` when that
 *   face is available and dropped (model kept, effort cleared) otherwise.
 * - Server → card visibility rides the volatile `presetRecommendation`
 *   field: the outcome (applied picks, degradation reason) is written as a
 *   compact JSON record the card renders. Same channel, same gate, same
 *   persistence as every settings write.
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
 * The vendor registry (v0.17: the eight vendors' published combinations,
 * collected 2026-11-06). Selecting a READY preset applies its DEFAULT
 * variant's task/verify/triage roles (model + effort) to the flat volatile
 * fields; the session suggestion travels with the variant as reference data
 * only. DeepSeek deliberately publishes two variants (in-house stack vs
 * external verify); Kimi/Qwen/火山 carry the multi-variant ladders the
 * vendors document. Gemini resolves 「家族 + 最新版本」 at runtime, so its
 * ids are family-latest tokens rather than pinned version numbers.
 */
export const VENDOR_PRESETS: VendorPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'OpenAI 官方针对 cybernetic 循环（规划-执行-验证-分拣）推荐的组合：gpt-6.1-sol 承担 task/verify，gpt-6-luna 承担 triage；effort 五档 low/medium/high/xhigh/max（astra/6.1-sol 不支持 none）。',
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
    note: 'effort 五档：low/medium/high/xhigh/max；gpt-6-astra 与 gpt-6.1-sol 不支持 none 档。',
    sessionNote: PRESET_SESSION_NOTE,
  },
  {
    id: 'claude',
    label: 'Claude',
    description: 'Anthropic 官方组合（单家族跨代际）：常规 = task Sonnet 5.5 / verify Opus 5.5 / triage Haiku 5.5；高要求 = task Opus 5.5 / verify Fable 5.1 / triage Haiku 5.5。',
    status: 'ready',
    roles: {
      task: { provider: 'anthropic', model: 'Sonnet-5.5', rationale: '常规档 task 用 Sonnet 5.5：性价比主力。' },
      verify: { provider: 'anthropic', model: 'Opus-5.5', fallback: 'Fable-5.1', rationale: 'verify 高一档（Opus）补偿单家族独立性损失。' },
      triage: { provider: 'anthropic', model: 'Haiku-5.5', rationale: '轻量分拣。' },
    },
    variants: [
      {
        id: 'standard',
        label: '常规',
        roles: {
          task: { provider: 'anthropic', model: 'Sonnet-5.5', rationale: '性价比主力执行。' },
          verify: { provider: 'anthropic', model: 'Opus-5.5', fallback: 'Fable-5.1', rationale: 'verify 高一档补偿单家族。' },
          triage: { provider: 'anthropic', model: 'Haiku-5.5', rationale: '轻量分拣。' },
        },
        session: { provider: 'anthropic', model: 'Opus-5.5', rationale: 'session 主脑用 Opus 5.5（仅参考）。' },
      },
      {
        id: 'demanding',
        label: '高要求',
        roles: {
          task: { provider: 'anthropic', model: 'Opus-5.5', rationale: '高要求场景 task 直接上 Opus。' },
          verify: { provider: 'anthropic', model: 'Fable-5.1', rationale: 'verify 用最强判断档 Fable 5.1。' },
          triage: { provider: 'anthropic', model: 'Haiku-5.5', rationale: '轻量分拣不变。' },
        },
        session: { provider: 'anthropic', model: 'Fable-5.1', rationale: 'session 主脑用 Fable 5.1（仅参考）。' },
      },
    ],
    note: 'verify 恒比 task 高一档，补偿单家族缺独立性的短板；Fable 5.1 的实际可用性以部署模型目录为准。',
    sessionNote: PRESET_SESSION_NOTE,
  },
  {
    id: 'gemini',
    label: 'Gemini',
    description: 'Google 官方组合（家族 + 最新版本，运行时解析，不硬编码旧版本号）：task Flash、verify Pro（或高配 Flash + 严格 Prompt）、triage Flash。',
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
    note: '模型 id 按家族 + 最新版本在部署目录中解析（*-latest），不硬编码旧版本号；verify 也可用高配 Flash + 严格 Prompt 替代 Pro。',
    sessionNote: PRESET_SESSION_NOTE,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek 官方组合（两个变体）：仅本家栈 = verify R1/V4-Pro(thinking)、task V4-Pro(视难度切 thinking)、triage V4-Flash/V3.2；verify 外置 = verify 优先 Claude Opus / GPT 旗舰 / Gemini Pro。',
    status: 'ready',
    roles: {
      task: { provider: 'deepseek', model: 'V4-Pro', fallback: 'V4-Pro (thinking)', rationale: '默认非 thinking 起步，按任务难度切换 thinking 档。' },
      verify: { provider: 'deepseek', model: 'V4-Pro', reasoningEffort: 'thinking', fallback: 'R1 (thinking)', rationale: 'verify 常开 thinking（R1/V4-Pro thinking 档），审计岗不省这一层。' },
      triage: { provider: 'deepseek', model: 'V4-Flash', fallback: 'V3.2 (非 thinking)', rationale: '轻量分拣用 Flash/V3.2 非思考档。' },
    },
    variants: [
      {
        id: 'in-house',
        label: '仅本家',
        roles: {
          task: { provider: 'deepseek', model: 'V4-Pro', fallback: 'V4-Pro (thinking)', rationale: '视难度切 thinking。' },
          verify: { provider: 'deepseek', model: 'V4-Pro', reasoningEffort: 'thinking', fallback: 'R1 (thinking)', rationale: 'verify R1/V4-Pro thinking。' },
          triage: { provider: 'deepseek', model: 'V4-Flash', fallback: 'V3.2 (非 thinking)', rationale: '轻量分拣。' },
        },
        session: { provider: 'deepseek', model: 'V4-Pro (非 thinking)', fallback: 'Flash', rationale: 'session 用 V4-Pro 非思考档或 Flash（仅参考）。' },
      },
      {
        id: 'external-verify',
        label: 'verify 外置',
        roles: {
          task: { provider: 'deepseek', model: 'V4-Pro', fallback: 'V4-Pro (thinking)', rationale: '本家 task 不变。' },
          verify: { provider: 'anthropic', model: 'Opus-5.5', fallback: 'GPT 旗舰 / Gemini Pro', rationale: 'verify 优先外置旗舰（Claude Opus / GPT 旗舰 / Gemini Pro），跨家族独立性最大化。' },
          triage: { provider: 'deepseek', model: 'V4-Flash', fallback: 'V3.2 (非 thinking)', rationale: '轻量分拣。' },
        },
        session: { provider: 'deepseek', model: 'V4-Pro (非 thinking)', fallback: 'Flash', rationale: 'session 用 V4-Pro 非思考档或 Flash（仅参考）。' },
      },
    ],
    note: '成本不应成为降级 verify 的理由；thinking 档按 DeepSeek 目录实际提供的档位 id 应用，部署目录未提供时按模型默认执行。',
    sessionNote: PRESET_SESSION_NOTE,
  },
  {
    id: 'kimi',
    label: 'Kimi',
    description: 'Moonshot 官方组合（两个变体）：长期组合 = task/triage kimi-k3.1-pro-highspeed + verify kimi-k3（代际差异保独立）；最高验收质量 = verify 改 kimi-k3.1-pro。',
    status: 'ready',
    roles: {
      task: { provider: 'moonshot', model: 'kimi-k3.1-pro-highspeed', rationale: '高速版执行主力。' },
      verify: { provider: 'moonshot', model: 'kimi-k3', fallback: 'kimi-k3.1-pro', rationale: 'verify 用上一代 k3：代际差异保持审计独立性；最高验收质量可换 k3.1-pro。' },
      triage: { provider: 'moonshot', model: 'kimi-k3.1-pro-highspeed', rationale: '轻量分拣同执行主力（高速版成本低）。' },
    },
    variants: [
      {
        id: 'long-term',
        label: '长期组合',
        roles: {
          task: { provider: 'moonshot', model: 'kimi-k3.1-pro-highspeed', rationale: '高速版执行主力。' },
          verify: { provider: 'moonshot', model: 'kimi-k3', fallback: 'kimi-k3.1-pro', rationale: '代际差异保独立。' },
          triage: { provider: 'moonshot', model: 'kimi-k3.1-pro-highspeed', rationale: '轻量分拣。' },
        },
        session: { provider: 'moonshot', model: 'kimi-k3.1-pro-highspeed', rationale: 'session 同执行主力（仅参考）。' },
      },
      {
        id: 'max-acceptance',
        label: '最高验收质量',
        roles: {
          task: { provider: 'moonshot', model: 'kimi-k3.1-pro-highspeed', rationale: '执行主力不变。' },
          verify: { provider: 'moonshot', model: 'kimi-k3.1-pro', rationale: 'verify 升级到当代最强 k3.1-pro。' },
          triage: { provider: 'moonshot', model: 'kimi-k3.1-pro-highspeed', rationale: '轻量分拣。' },
        },
        session: { provider: 'moonshot', model: 'kimi-k3.1-pro-highspeed', rationale: 'session 同执行主力（仅参考）。' },
      },
    ],
    note: '避开即将退役的 K2 系列；k3（上一代）与 k3.1（当代）的代际差异是该方案 independence 的来源。',
    sessionNote: PRESET_SESSION_NOTE,
  },
  {
    id: 'qwen',
    label: 'Qwen',
    description: '阿里 Qwen 官方组合（三档）：A = task plus/verify max/triage turbo；B = task max/verify max(或深度思考版)/triage plus；C = task turbo/verify plus/triage turbo。',
    status: 'ready',
    roles: {
      task: { provider: 'qwen', model: 'qwen-plus', upgradeTo: 'qwen-max', rationale: 'A 档：plus 执行，max 留给 verify。' },
      verify: { provider: 'qwen', model: 'qwen-max', fallback: 'qwen-max (深度思考版)', rationale: 'verify 恒用 max；⚠️ 绝不用 Turbo（幻觉共振）。' },
      triage: { provider: 'qwen', model: 'qwen-turbo', rationale: '轻量分拣。' },
    },
    variants: [
      {
        id: 'a',
        label: 'A（均衡）',
        roles: {
          task: { provider: 'qwen', model: 'qwen-plus', upgradeTo: 'qwen-max', rationale: 'plus 执行。' },
          verify: { provider: 'qwen', model: 'qwen-max', fallback: 'qwen-max (深度思考版)', rationale: 'max 审计。' },
          triage: { provider: 'qwen', model: 'qwen-turbo', rationale: 'turbo 分拣。' },
        },
        session: { provider: 'qwen', model: 'qwen-max', rationale: 'session max（仅参考）。' },
      },
      {
        id: 'b',
        label: 'B（高要求）',
        roles: {
          task: { provider: 'qwen', model: 'qwen-max', rationale: 'max 执行。' },
          verify: { provider: 'qwen', model: 'qwen-max', fallback: 'qwen-max (深度思考版)', rationale: 'max（或深度思考版）审计。' },
          triage: { provider: 'qwen', model: 'qwen-plus', rationale: 'plus 分拣。' },
        },
        session: { provider: 'qwen', model: 'qwen-max', rationale: 'session max（仅参考）。' },
      },
      {
        id: 'c',
        label: 'C（轻量）',
        roles: {
          task: { provider: 'qwen', model: 'qwen-turbo', rationale: 'turbo 执行（轻量场景）。' },
          verify: { provider: 'qwen', model: 'qwen-plus', rationale: 'plus 审计（verify 底线，绝不用 Turbo）。' },
          triage: { provider: 'qwen', model: 'qwen-turbo', rationale: 'turbo 分拣。' },
        },
        session: { provider: 'qwen', model: 'qwen-plus', rationale: 'session plus（仅参考）。' },
      },
    ],
    note: '⚠️ verify 绝不用 Turbo（qwen-turbo；幻觉共振：轻模型审计重模型输出会互相放大幻觉）；verify 档恒 ≥ task。',
    sessionNote: PRESET_SESSION_NOTE,
  },
  {
    id: 'volcano-coding-plan',
    label: '火山 Coding Plan',
    description: '火山引擎 Coding Plan 组合（可用池 Seed-2.1-pro / Seed-Evolving / Seed-2.1-lite / Seed-2.0-mini，另有 DeepSeek-V4、GLM-5.3）：A = task lite（复杂重构自动切 pro）/ verify lite（高危 fallback pro）/ triage mini；B = task mini（复杂强制 lite）/ verify lite / triage mini。',
    status: 'ready',
    roles: {
      task: { provider: 'volcano', model: 'Seed-2.1-lite', upgradeTo: 'Seed-2.1-pro', rationale: 'A 档：lite 执行，复杂重构自动切 pro。' },
      verify: { provider: 'volcano', model: 'Seed-2.1-lite', fallback: 'Seed-2.1-pro', rationale: 'verify 用 lite，高危任务 fallback pro；备选可换 GLM-5.3。' },
      triage: { provider: 'volcano', model: 'Seed-2.0-mini', rationale: '最轻分拣。' },
    },
    variants: [
      {
        id: 'a',
        label: 'A（均衡）',
        roles: {
          task: { provider: 'volcano', model: 'Seed-2.1-lite', upgradeTo: 'Seed-2.1-pro', rationale: 'lite 执行，复杂重构自动切 pro。' },
          verify: { provider: 'volcano', model: 'Seed-2.1-lite', fallback: 'Seed-2.1-pro', rationale: 'lite 审计，高危 fallback pro；备选 GLM-5.3。' },
          triage: { provider: 'volcano', model: 'Seed-2.0-mini', rationale: '最轻分拣。' },
        },
        session: { provider: 'volcano', model: 'Seed-Evolving', fallback: 'Seed-2.1-pro', rationale: 'session 首选 Evolving，退 pro（仅参考）。' },
      },
      {
        id: 'b',
        label: 'B（成本优先）',
        roles: {
          task: { provider: 'volcano', model: 'Seed-2.0-mini', upgradeTo: 'Seed-2.1-lite', rationale: 'mini 执行，复杂任务强制 lite。' },
          verify: { provider: 'volcano', model: 'Seed-2.1-lite', fallback: 'Seed-2.1-pro', rationale: 'lite 审计不变（成本再压也不降 verify）。' },
          triage: { provider: 'volcano', model: 'Seed-2.0-mini', rationale: '最轻分拣。' },
        },
        session: { provider: 'volcano', model: 'Seed-Evolving', fallback: 'Seed-2.1-pro', rationale: 'session Evolving（仅参考）。' },
      },
    ],
    note: 'verify/复杂 task 的 fallback 可换 GLM-5.3（外部家族），但禁给 triage/普通 task；session 首选 Seed-Evolving（持续演化档）。',
    sessionNote: PRESET_SESSION_NOTE,
  },
  {
    id: 'minimax',
    label: 'Minimax',
    description: 'Minimax 官方组合：task M3.1-Flash(effort high，可升 xhigh) / verify M3 / triage M3.1-Flash(effort low，可升 medium)；session M3（参考）。',
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
    note: 'verify 必须能承认不确定性（M3 的校准优于 Flash）；缓存读 4 倍差价——同前缀的重复轮次成本敏感，triage effort 保持 low。',
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

// --- outcome record (the card-visible status) -----------------------------------

/** The JSON record written into the volatile `presetRecommendation` field. */
export interface PresetRecommendationRecord {
  /** ok = applied (auto picks or a ready vendor); placeholder = noted, nothing changed; degraded = why. */
  status: 'ok' | 'placeholder' | 'degraded'
  /** The selector id this record belongs to ('auto' or a vendor id). */
  preset: string
  /** Display label at apply time. */
  label: string
  /** ISO time of the outcome. */
  at: string
  /** Route that produced an auto recommendation ('provider/model'). */
  route?: string
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
  /** Degradation / placeholder note. */
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
    if (record.status !== 'ok' && record.status !== 'placeholder' && record.status !== 'degraded') return undefined
    if (typeof record.preset !== 'string' || typeof record.label !== 'string') return undefined
    return record as PresetRecommendationRecord
  } catch {
    return undefined
  }
}

// --- host probes + the LLM call (soft, never throw) ------------------------------

/** The route the one-shot recommendation call runs on. */
export interface RecommendRoute {
  provider?: string
  model?: string
}

/**
 * Resolve the route for the auto call: an explicit `provider/model` (or bare
 * model) wins; otherwise the FIRST high-tier catalog option (the deployment's
 * strongest listed model — the same generic tiering the smart selection uses),
 * falling back to the first option. Pure; empty catalog → undefined.
 */
export function pickRecommendRoute(explicit: unknown, options: CatalogOption[]): RecommendRoute | undefined {
  const spec = parseAgentModelSpec(typeof explicit === 'string' ? explicit : undefined)
  if (spec && (spec.provider || spec.model)) {
    const matched = matchOption({ provider: spec.provider, model: spec.model }, options)
    if (matched) return { provider: matched.provider, model: matched.model }
    // Explicit but off-catalog: still honored verbatim (the call will report
    // its own transport error and the flow degrades with that reason).
    return { ...(spec.provider ? { provider: spec.provider } : {}), ...(spec.model ? { model: spec.model } : {}) }
  }
  const high = options.find((o) => modelTier(o, {}) === 'high')
  const chosen = high ?? options[0]
  return chosen ? { provider: chosen.provider, model: chosen.model } : undefined
}

/** Build one inline user message (the dsh-session-title message shape, zero imports). */
function buildUserMessage(text: string): Record<string, unknown> {
  return {
    role: 'user',
    id: cryptoRandomUuid(),
    content: [{ type: 'text', text }],
    source: { kind: 'cybernetics-preset-recommend' },
  }
}

/** randomUUID with a non-secure fallback (the offline harness may lack crypto). */
function cryptoRandomUuid(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  } catch { /* fall through */ }
  return `cyb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Collect the visible text of one prepared stream (text-delta chunks only). */
async function collectStreamText(stream: AsyncIterable<unknown>): Promise<string> {
  let text = ''
  for await (const chunk of stream) {
    if (chunk !== null && typeof chunk === 'object' && (chunk as { type?: unknown }).type === 'text-delta') {
      const delta = (chunk as { text?: unknown }).text
      if (typeof delta === 'string') text += delta
    }
  }
  return text
}

/** The guard face read off `ctx.llm` (soft: any shape problem yields undefined). */
function llmFaceOf(ctx: unknown): { prepareCall: (config: unknown, signal: unknown, configure?: unknown) => Promise<any> } | undefined {
  try {
    const llm = (ctx as { llm?: unknown } | null | undefined)?.llm
    if (llm && typeof (llm as { prepareCall?: unknown }).prepareCall === 'function') {
      return llm as { prepareCall: (config: unknown, signal: unknown, configure?: unknown) => Promise<any> }
    }
  } catch { /* Cordis proxy guard: service not injected */ }
  return undefined
}

/**
 * One guarded one-shot LLM call (`ctx.llm.prepareCall().stream()` — the
 * dsh-session-title-llm pattern, imports inlined). NEVER throws: any missing
 * face, abort or transport error returns {ok:false, reason}.
 */
export async function callLlmOneShot(
  ctx: unknown,
  route: RecommendRoute,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; text?: string; reason?: string }> {
  const llm = llmFaceOf(ctx)
  if (llm === undefined) return { ok: false, reason: '宿主未暴露 LLM 调用面（ctx.llm.prepareCall 不可用）' }
  const routeLabel = [route.provider, route.model].filter(Boolean).join('/')
  try {
    const call = await llm.prepareCall({ ...route, maxTokens: 2048 }, signal ?? undefined, (controls: unknown) => controls)
    const options = {
      ...(call && typeof call === 'object' && call.config && typeof call.config === 'object' ? call.config : {}),
      messages: [buildUserMessage(user)],
      system,
      purpose: 'cybernetics-preset-recommend',
      ...(signal !== undefined ? { signal } : {}),
    }
    const text = await collectStreamText(call.stream(options))
    if (text.trim() === '') return { ok: false, reason: `推荐模型 ${routeLabel} 返回了空回复` }
    return { ok: true, text }
  } catch (error) {
    return { ok: false, reason: `推荐模型 ${routeLabel} 调用失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Everything the orchestrator accepts; every field optional. */
export interface RecommendModelsInput {
  /** Catalog override (tests); default = probeCatalogOptions(ctx). */
  options?: CatalogOption[]
  /** The explicit `presetRecommendModel` field value. */
  route?: unknown
  /** Current role overrides for the prompt (default {}). */
  currentOverrides?: RolesConfig
  /** Vendor reference material (default allVendorPresets()). */
  presets?: VendorPreset[]
  /** Optional abort signal for the LLM call. */
  signal?: AbortSignal
}

/** The orchestrator's outcome: applied picks or a fully-explained degradation. */
export type RecommendationOutcome =
  | {
    status: 'ok'
    route: RecommendRoute
    catalogSize: number
    picks: RecommendationPicks
    invalid: string[]
    notes: string[]
    ignoredSession: boolean
    ops: SettingsOp[]
  }
  | {
    status: 'degraded'
    reason: string
    catalogSize: number
    route?: RecommendRoute
    /** The request that WOULD have been sent (always built before any call). */
    request: RecommendationRequest
  }

/**
 * The full auto-recommend flow, always non-throwing: probe the live catalog →
 * build the request (catalog + principles + current config + vendor
 * reference) → resolve the route → one LLM call → strict parse (catalog +
 * session-scope guard) → soft effort validation → apply ops. Every failure
 * mode returns `degraded` with a concrete reason; the built request is always
 * attached so "能构造推荐请求" is verifiable even when the call face is
 * unreachable.
 */
export async function recommendModels(ctx: unknown, input: RecommendModelsInput = {}): Promise<RecommendationOutcome> {
  let options = input.options
  if (options === undefined) {
    const probe = await probeCatalogOptions(ctx)
    options = probe.options
  }
  const catalogSize = Array.isArray(options) ? options.length : 0
  const safeOptions = Array.isArray(options) ? options : []
  const currentOverrides = (input.currentOverrides && typeof input.currentOverrides === 'object' ? input.currentOverrides : {}) as RolesConfig
  const request = buildRecommendationPrompt({ options: safeOptions, currentOverrides, presets: input.presets })
  if (safeOptions.length === 0) {
    return { status: 'degraded', reason: '当前系统模型目录不可用或为空，无法推荐', catalogSize: 0, request }
  }
  const route = pickRecommendRoute(input.route, safeOptions)
  if (route === undefined) return { status: 'degraded', reason: '无法确定推荐调用路由（目录为空且未配置 presetRecommendModel）', catalogSize, request }
  const answer = await callLlmOneShot(ctx, route, request.system, request.user, input.signal)
  if (!answer.ok) return { status: 'degraded', reason: answer.reason ?? '推荐调用失败', catalogSize, route, request }
  const parse = parseRecommendation(answer.text ?? '', safeOptions)
  if (!parse.ok) return { status: 'degraded', reason: `推荐回复不可用：${parse.error}`, catalogSize, route, request }
  const validated = await validatePickEfforts(ctx, parse.picks)
  const picks = validated.picks
  const ops = recommendationApplyOps(picks)
  const notes = [...validated.notes, ...parse.droppedEfforts.map((d) => `推荐 effort 已忽略：${d}`)]
  if (parse.ignoredSession) notes.push('推荐回复含 session 键，已忽略（session 由用户自行管理）')
  if (ops.length === 0) {
    return {
      status: 'degraded',
      reason: parse.invalid.length > 0
        ? `推荐未命中目录内模型（${parse.invalid.join('；')}），未应用任何更改`
        : '推荐结果为空（模型建议全部保持现状），未应用任何更改',
      catalogSize,
      route,
      request,
    }
  }
  return { status: 'ok', route, catalogSize, picks, invalid: parse.invalid, notes, ignoredSession: parse.ignoredSession, ops }
}
