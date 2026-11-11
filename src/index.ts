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
import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import {
  STATE_DIR, createGoal, decideAbort, foldRound, parseAgentModelSpec, runRound, sanitizeReasoningEffort, startRound, supersedeGoal, writeRevisionLog,
} from './controller.ts'
import type {
  AgentsModelAudit, ControllerConfig, ControllerDecision, LoopState, ResumableReason, RoundResult, RolesConfig,
} from './controller.ts'
import { startTeamRound, teamExecutorAvailable, teamExecutorUnavailableError } from './executor.ts'
import { computeSmartSelection, probeCatalogOptions, sessionRouteOf } from './modelSelection.ts'
import type { SmartSelectionAudit } from './modelSelection.ts'
import {
  PRESET_AUTO_ID, PRESET_IDS, PRESET_RECOMMEND_TOOL_NAME, applyRecommendationAnswer, buildRecommendationBrief,
  customPresetAsVendor, customPresetEntryId, formatRecommendationRecord, isCustomPresetId, parseCustomPresets,
  presetById, presetChoiceLabel, vendorPresetApplyOps,
} from './modelPresets.ts'
import type { CustomPreset, PresetRecommendationRecord, SettingsOp } from './modelPresets.ts'
import { linkRunToGoal, noteWorkflowAgent, setBoardSource, unlinkRun } from './agents.ts'
import { cyberneticsGoalsProjection, goalsFromBoard, publishGoals, setPublishDebugRoot, appendModeRecord } from './projection.ts'
import {
  clearSessionRolesOverride, formatSessionRolesOverride, getSessionRolesOverride, mergeSessionRolesOverride,
  peekSessionAutoPending, sessionRolesKeyOf, setSessionAutoPending, setSessionRolesOverride, takeSessionAutoPending,
} from './sessionRoles.ts'
import {
  MODE_EVENT_TYPE, MODE_LEGACY_EVENT_TYPE, cyberneticsModeProjection, effectiveEnabled, modeOverrideOf, planWanted,
} from './sessionMode.ts'

export const name = 'dsh-cybernetics'

export const inject = [
  'tools',
  'systemPrompt',
  'goals',
  'workingDirectory',
  'agentPresets',
  'agents',
  'sessionProjections',
] as const
// All seven are ROOT-level services (goal / working-directory / agent-preset-registry
// / agents / session-projection registry are top-level loader entries) — static
// inject cannot pend at boot. `sessionProjections` is the registry dsh-goal
// itself injects at root; this plugin registers the `cyberneticsGoals` unit
// there so every goal on the board reaches the「目标」tab (v0.6).
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
  /** Flat task-agent model override ("provider/model" or bare model); empty = inherit session agent. */
  taskAgentModel?: string
  /** Flat verify-agent model override (same format); empty = inherit session agent. */
  verifyAgentModel?: string
  /** Flat triage-agent model override (same format); empty = inherit session agent. */
  triageAgentModel?: string
  /** v0.15: flat task-agent reasoning-effort id ('' = model default). Volatile. */
  taskAgentReasoningEffort?: string
  /** v0.15: flat verify-agent reasoning-effort id ('' = model default). Volatile. */
  verifyAgentReasoningEffort?: string
  /** v0.15: flat triage-agent reasoning-effort id ('' = model default). Volatile. */
  triageAgentReasoningEffort?: string
  /**
   * v0.16 smart agent model selection (default false). When on, every round
   * start classifies the work order (brief/subgoal/objective) and picks a
   * provider/model per sub-agent role from the host's LIVE model catalog
   * (`ctx.llm`), filling only roles WITHOUT an explicit provider/model
   * override; trivial work lands on light models, hard work on the top tier,
   * and any fallback (catalog unavailable, nothing suitable, classifier
   * failure) keeps the session-agent inheritance and records WHY in the round
   * audit (`smartSelection` on the round record). Volatile — next round.
   */
  smartAgentModelSelection?: boolean
  /**
   * v0.17 preset plans (预置方案): the settings card's selector ('' = none,
   * 'auto' = 根据现有配置自动推荐 (v0.18.2: handed to the session agent
   * through the preset_recommend tool — no independent LLM call), otherwise
   * a vendor registry id or `custom:<id>` for a user-saved combination
   * (v0.19)). Selecting writes this volatile field; the
   * loader/volatile-update handler resolves each change ONE-SHOT and applies
   * the result to the flat task/verify/triage model+effort fields only — the
   * session agent's configuration is user-managed and structurally out of
   * scope (src/modelPresets.ts ALLOWED_OP_PATHS).
   */
  presetPlan?: string
  /** v0.17: the card-visible JSON record of the last preset selection outcome ({status, preset, label, at, picks?, efforts?, variant?, notes?, reason?...}). Volatile. */
  presetRecommendation?: string
  /** v0.19: the user-saved custom presets (自定义方案), one compact JSON array (CustomPreset[]). Volatile (persisted via the host's user patch row). */
  customPresets?: string
  /**
   * Hard control gate (default false): hide execution tools from
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
  /** Extra tool names unioned onto the allowlist (default or gateAllowlist). */
  gateAllowlistExtra?: string[]
  /**
   * Approval relay (v0.8.5, default true, hardGate companion): delegated
   * children (workflow subagents, teammates) inherit the host's pinned
   * `never` approval policy, so a sandbox escalation a task agent needs
   * (e.g. writing outside the session workspace) fails deterministically
   * before any answerer sees it. When on, the plugin flips each delegated
   * child's effective policy to `ask` at creation (one durable
   * `approval/policy` session event — later events win over the
   * delegation-seeded pin) and registers an OUTERMOST `approval/request`
   * answerer that re-issues a child's request ON THE TOP-LEVEL SESSION AGENT
   * through the host's own approval service — i.e. the native Allow once /
   * Reject panel of the conversation the user is watching. Outermost is not
   * an optimization: the host's api-remotes registers its `approval/request`
   * browser forwarder at boot, before every user plugin; once the browser's
   * approval answerer claims a child request, that per-session panel never
   * calls `next()`, so an inner relay listener would never run at all (the
   * last-hop defect this field fixes). When the top-level turn is closed (a
   * continuable child outliving it) the relay falls back to the
   * user-questions (ask_user_question) channel on the same agent, then to the
   * native chain. Denials stay explicit: relay failures answer `rejected`,
   * an aborted child run answers `cancelled`, and a child with no live
   * top-level agent falls through to the native chain.
   */
  gateApprovalRelay?: boolean
  /**
   * All-goals mode (v0.7, default false): EVERY user request — including
   * trivial read-only questions and lightweight analysis — must go through a
   * cybernetics goal first; in-place analysis by the session agent is banned.
   * Off (default) keeps the v0.6 implicit-trigger behavior exactly unchanged.
   */
  allGoalsMode?: boolean
  /**
   * New-input delivery policy for sessions where cybernetics is effective-on
   * (v0.9.0, default 'insert'): while a round keeps the session agent busy,
   * a queued next-turn user input is relocated to next-step (steer) so the
   * session agent sees it as immediate outer-loop control. Sessions where
   * cybernetics is off are NEVER touched and follow the DSH-native
   * `ui-conversation.busyEnter` behavior ('queue' by default).
   */
  inputPolicy?: 'insert' | 'queue'
  /**
   * Round-settled notice delivery policy for sessions where cybernetics is
   * effective-on (v0.13.0, default 'insert'): the inner-loop completion notice
   * (notifyRoundSettled followup) that lands in the next-turn queue while a
   * round keeps the session agent busy is relocated to next-step (steer), so
   * the feedback is folded without waiting for the turn to end or a manual
   * push/collect prompt. 'queue' restores the native next-turn delivery.
   */
  noticePolicy?: 'insert' | 'queue'
  /**
   * Where the status indicators render (v0.19.0, default 'both'): the
   * session-header pill (pill), the composer-dock hint bar (composer), both,
   * or neither (none). Purely a client-UI concern; purely cosmetic either way.
   */
  hintLocation?: 'both' | 'pill' | 'composer' | 'none'
  /**
   * Max concurrent rounds across ALL sessions (default 0 = unlimited): a new
   * round (blocking, 'start' or 'revise') is refused while this many rounds
   * are in flight, protecting the host from parallel-agent storms.
   */
  maxConcurrentRounds?: number
}

// Under the host's 0.1.7 settings model, an exported schemastery `Config`
// schema IS the plugin entry's settings page: the Web editor derives the
// plugin config form from it and serves it through the shared configuration
// forms (see @linxin666/dsh-ssh and @linxin666/dsh-usage for the same
// pattern). At least one field must be `.volatile()` for the page to be
// served at all; a volatile edit is committed into the running fiber's
// reference without a remount and announced via `loader/volatile-update`.
// The user-facing knobs (taskAgentModel / verifyAgentModel / triageAgentModel /
// roundsPerSubgoal / maxConcurrentRounds / allGoalsMode) are all
// volatile so they are visible AND writable in the settings panel and take
// effect on the next goal round. roles stays in the schema but is NOT
// volatile (v0.8.4): the panel serves only volatile fields, so it no longer
// shows in the GUI — advanced users (agent-guided) configure it directly in
// the profile config yaml; a host reload applies it. v0.8.10: hardGate itself
// is volatile and toggleable from the settings card (the gate wiring is
// installed/disposed live on loader/volatile-update); the fine-grained gate
// fields (gateMode/gatedTools/gateAllowlist/gateAllowlistExtra) and
// gateApprovalRelay stay non-volatile config-document fields.
export const Config = z.object({
  /** Model-facing tool name. */
  toolName: z.string().default('cybernetics').description('模型侧工具名（缺省 cybernetics）。'),
  /** Inject the implicit goal-loop guidance section. */
  implicitTrigger: z.boolean().default(true).description('注入隐式 goal-loop 系统提示段（缺省开启）。'),
  /**
   * Per-role sub-agent model/provider overrides: role -> {provider, model}.
   * v0.8.4: NOT volatile — the settings card no longer exposes the roles JSON
   * textarea (hand-editing JSON in the GUI is unfriendly), and the host panel
   * serves only volatile fields, so a non-volatile roles simply disappears
   * from the GUI while remaining configurable in the profile config yaml
   * (save triggers a plugin-row remount / host reload, which is fine for an
   * advanced setting an agent guides the user through). Runtime semantics are
   * unchanged: readConfigField accepts a plain object (non-volatile) exactly
   * like a live reference (volatile), and named task roles keep working.
   */
  roles: z.dict(z.object({
    provider: z.string(),
    model: z.string(),
  })).description('按角色的子 agent provider/model 覆盖：role -> {provider, model}（如 default/verify/triage/frontend）。高级配置：直接编辑 profile 配置 yaml 后需宿主重载生效（GUI 不再提供此字段的编辑控件）。'),
  /**
   * Flat task-agent model override ("provider/model" or a bare model name).
   * Empty = inherit the session agent. Merged over roles.default at wiring
   * time (parseAgentModelSpec) — the flat fields are the settings-panel face;
   * roles stays the canonical runtime shape the round script consumes.
   * Volatile (v0.7.7): the host settings form (@deepseek-ai/dsh-settings
   * volatileForm, lib/index.js:122-131) serves ONLY `.volatile()` fields, and
   * its write() refuses any non-volatile path ("Config field ... is not
   * volatile") — a plain field is invisible AND unwritable on the plugins
   * page. Volatile commit keeps the running instance live; the value is read
   * per round start (readConfigField unwrap below), so an edit takes effect
   * on the next goal round without a remount.
   */
  taskAgentModel: z.string().default('').volatile().description('task agent 模型覆盖（「provider/model」或裸模型名）；留空 = 与 session agent 一致。保存后下一轮 goal 即生效，无需重载。'),
  /** Flat verify-agent model override; same format, fallback and volatile semantics as taskAgentModel. */
  verifyAgentModel: z.string().default('').volatile().description('verify agent 模型覆盖（「provider/model」或裸模型名）；留空 = 与 session agent 一致。保存后下一轮 goal 即生效，无需重载。'),
  /**
   * Flat triage-agent model override (v0.8.2); identical shape, fallback and
   * volatile semantics as taskAgentModel/verifyAgentModel. The triage role
   * reads the task/verify results and produces the round's convergence
   * decision (met / continue / human-input / ...); quick-depth rounds skip
   * verify+triage entirely, so this override only ever fires on full rounds.
   */
  triageAgentModel: z.string().default('').volatile().description('triage agent 模型覆盖（「provider/model」或裸模型名）；留空 = 与 session agent 一致。triage 角色读 task/verify 结果输出本轮收敛决策（met/continue/human-input 等）；quick 轮不启用。保存后下一轮 goal 即生效，无需重载。'),
  /**
   * v0.15: flat per-role reasoning-effort ids, one per sub agent. '' = follow
   * the model default (nothing sent). Volatile like the model fields — the
   * settings card renders a live dropdown from the paired model's catalog
   * reasoning.efforts; an unsupported/invalid stored id is sanitized away at
   * fold time (sanitizeReasoningEffort) and the runtime falls back to the
   * model default (recorded in the round's fallbacks audit on provider
   * rejection).
   */
  taskAgentReasoningEffort: z.string().default('').volatile().description('task agent 思考强度档位（留空 = 跟随模型默认）。档位列表随该 agent 所选模型动态给出；选择即保存，下一轮 goal 生效。'),
  verifyAgentReasoningEffort: z.string().default('').volatile().description('verify agent 思考强度档位（留空 = 跟随模型默认）。档位列表随该 agent 所选模型动态给出；选择即保存，下一轮 goal 生效。'),
  triageAgentReasoningEffort: z.string().default('').volatile().description('triage agent 思考强度档位（留空 = 跟随模型默认）。档位列表随该 agent 所选模型动态给出；选择即保存，下一轮 goal 生效。'),
  /**
   * v0.16: smart agent model selection. Volatile boolean — the settings card
   * renders a toggle; the value is read live at every round launch, so a
   * panel edit governs the next goal round. Classification and selection
   * rules live in src/modelSelection.ts (see README「智能选择 Agent 配置」);
   * explicit role config always wins and every decision lands in the round
   * audit with its reason.
   */
  smartAgentModelSelection: z.boolean().default(false).volatile().description('智能选择 Agent 配置（v0.16，缺省关）：开启后每轮启动时按任务内容（委托书/子目标/目标）从当前系统可用模型列表为 task/verify/triage 自动选择合适模型——简单任务（删文件、git 提交等）用轻量模型提速省资源，困难任务（不常见语言、复杂数学等）用顶配模型。显式配置的角色模型始终优先；目录不可用或选不到合适模型时保持继承 session agent；每次决策（含保持继承的理由）写入轮审计（.cybernetics/round-*.json 的 smartSelection 字段）。保存后下一轮 goal 生效。'),
  /**
   * v0.17 preset plans (预置方案) — the settings card's selector. '' = none;
   * 'auto' = 根据现有配置自动推荐 (v0.18.2: the plugin hands the live
   * catalog + principles + current config to the SESSION AGENT through the
   * preset_recommend tool and the session agent answers in its own context —
   * no independent one-shot LLM call, no spawned agent); the other ids
   * name the vendor registry entries (src/modelPresets.ts, placeholder this
   * round). Selecting writes this volatile field; the loader/volatile-update
   * handler below resolves it ONE-SHOT: 'auto' writes the pending handoff
   * record and notifies the live session agent(s); a READY vendor preset
   * applies its roles to the three flat model fields; a PLACEHOLDER one only
   * records the status note; a `custom:<id>` value (v0.19) applies the
   * matching user-saved combination from the `customPresets` field. The
   * applied values live in the standard flat
   * fields, so persistence, display and the round-start fold are all the
   * existing paths — this field is the trigger, not a parallel config.
   * v0.19: the selector accepts the `custom:` prefix (user-saved combos), so
   * the union became a free string — the handler validates ids itself
   * (unknown ids are ignored with a warn, exactly like before).
   */
  presetPlan: z.string().default('').volatile().description('预置方案选择（v0.17，缺省空）：设置卡片下拉框的当前选择。选「根据现有配置自动推荐」(auto) 时，插件把实时模型目录、分配原则与当前角色配置直接交给 session agent（通过 preset_recommend 工具，不发起任何独立 LLM 调用、不新起子 agent），由 session agent 在自己的上下文中给出 task/verify/triage 推荐并回传，插件校验后写入下方各角色字段（已显式配置的角色会被覆盖，请以推荐结果为准复核）；选某厂商方案时应用其默认变体的组合（OpenAI/Claude/Gemini/DeepSeek/Kimi/Qwen/火山 Coding Plan/Minimax/GLM，数据见 src/modelPresets.ts）；选「custom:<id>」时应用 customPresets 字段中对应自定义方案的组合。作用范围仅 task/verify/triage 三个子 agent 角色——session agent 由用户自行管理，方案与自动推荐都不应用 session 项（厂商 session 推荐仅作参考展示）。每次选择的结果记录在 presetRecommendation 字段（pending=已交办 session agent 等待作答）。'),
  /**
   * v0.17: the card-visible outcome of the last preset selection. The server
   * writes a compact JSON record ({status: ok|pending|placeholder|degraded,
   * preset, label, at, picks?, reason?...}) through the settings service —
   * the exact write path the panel uses — and the card renders it under the
   * dropdown. Volatile both so the card can render it and so the record is
   * transient state (the applied models themselves live in the three flat
   * fields).
   */
  presetRecommendation: z.string().default('').volatile().description('最近一次预置方案应用/自动推荐的结果记录（JSON）：ok=已应用（picks 列出各角色写入的模型）；pending=自动推荐已交办 session agent，等待其经 preset_recommend 工具作答；placeholder=厂商方案占位待填充（未更改配置）；degraded=降级原因（目录不可用/回复不可用/未命中目录）。设置卡片在下拉框下方渲染该记录。'),
  /**
   * v0.19 custom presets (自定义方案): the user-saved combinations, stored as
   * ONE compact JSON array (CustomPreset[] in src/modelPresets.ts) in this
   * single config field. Volatile like every other field on the card — the
   * host persists volatile writes into the profile's user patch row, so the
   * list survives restarts; the field defaults to '' (empty list), which
   * keeps old profile payloads and old readers fully compatible (an absent
   * key parses to no entries). The card renders these entries under the
   * built-in vendor presets, below a divider, and the save/delete/overwrite
   * flows all rewrite this one field; the selection handler reads it with
   * the defensive parseCustomPresets (a corrupt payload degrades to an empty
   * list, never a throw). Built-in vendor presets are code data and can
   * NEVER be overwritten or deleted through this field.
   */
  customPresets: z.string().default('').volatile().description('自定义方案列表（v0.19，缺省空）：设置卡片上保存的用户自定义模型组合（task/verify/triage 的模型与思考强度），JSON 数组格式。保存/覆盖/删除自定义方案即改写本字段；选择某个自定义方案（presetPlan = custom:<id>）时按其组合写入下方各角色字段。内置厂商方案为代码内置数据，不经过本字段，不可覆盖或删除。'),
  /**
   * Max consecutive rounds per subgoal before the loop pauses for the user
   * (controller round-cap, default 3). Volatile: read per round start, so the
   * panel edit governs the very next goal round without a remount.
   */
  roundsPerSubgoal: z.number().default(3).volatile().description('同一子目标的最大连续轮数（递归深度上限，缺省 3）：超过即暂停并升级给用户。保存后下一轮 goal 即生效，无需重载。'),
  /**
   * Max concurrent rounds across all sessions (default 0 = unlimited).
   * Volatile: enforced at every launch, live on the next tool call.
   */
  maxConcurrentRounds: z.number().default(0).volatile().description('全局并行轮数上限（缺省 0 = 不限）：在跑轮数达到上限时拒绝启动新一轮，防止并行风暴。保存后即时生效，无需重载。'),
  /**
   * Hard control gate (default true). Volatile (v0.8.10): the settings
   * card exposes a live toggle; on loader/volatile-update apply() disposes or
   * (re)installs the gate wiring (assemble waterfall + tools/pre-execute deny
   * + approval relay) without a plugin remount, mirroring the
   * registerGuidanceSection re-derive pattern.
   */
  hardGate: z.boolean().default(true).volatile().description('硬控制门（默认开启）：装配期从顶层 session agent 摘除执行工具，所有改动必须经 cybernetics goal + task agent。设置卡片可开关，保存后即时生效（热装卸门禁监听），无需重启宿主。'),
  /** Tool names hidden in denylist mode (default DEFAULT_GATED_TOOLS). */
  gatedTools: z.array(z.string()).description('denylist 模式下隐藏的工具名（缺省内置 DEFAULT_GATED_TOOLS）。'),
  /**
   * Gate semantics. v0.8.6: NO schema-level default — an absent value means
   * "derive from hardGate" in apply() (`hardGate ? 'allowlist' : 'denylist'`).
   * The old `default('denylist')` erased the user's silence and silently made
   * every hardGate deployment a partial gate (only bash/edit/write), which is
   * how the bsk_ / taskboard_ / schedule_ / farm_ / uno_ / ppt_ writes stayed
   * alive. Explicit configurations are still honored verbatim, denylist
   * included.
   */
  gateMode: z.union(['denylist', 'allowlist'] as const).description('门语义（缺省随 hardGate 推导）：hardGate 开启且未显式配置时按 allowlist 生效；hardGate 关闭时按 denylist。allowlist 只保留 gateAllowlist（+gateAllowlistExtra）与 cybernetics 工具本身；denylist 只隐藏 gatedTools（默认 bash/edit/write），其余写工具（bsk_*/taskboard_*/schedule_*/farm_*/uno_*/ppt_*/config_restore 等）仍然可用——属残留风险，仅在明确接受该风险时才显式配置。'),
  /** Allowlist-mode survival set (default DEFAULT_GATE_ALLOWLIST). */
  gateAllowlist: z.array(z.string()).description('allowlist 模式生存工具集（缺省内置 DEFAULT_GATE_ALLOWLIST）。'),
  /** Extra tool names unioned onto the allowlist. */
  gateAllowlistExtra: z.array(z.string()).description('并集追加进 allowlist 的额外工具名。'),
  /** Approval relay for delegated children (default true). */
  gateApprovalRelay: z.boolean().default(true).description('子代理审批透传（默认开启，hardGate 伴随项）：把委派子代理的权限升级请求以"最外层 answerer"接管，改用顶层 session agent 的原生审批面板（Allow once / Reject）弹给用户裁决——请求落在用户正在看的会话里，而不是子会话那张看不见的面板；顶层回合已关闭时回退到 user-questions（ask_user_question）通道，再回退原生应答链。转发失败按显式拒绝、子代理跑飞按 cancelled 处理。属配置文件维护字段（GUI 面板不展示），修改需插件重载。'),
  /**
   * All-goals mode (v0.7, default false): every user request must go through
   * a cybernetics goal first. Volatile: the settings-panel toggle commits
   * into the running instance without a remount.
   */
  allGoalsMode: z.boolean().default(false).volatile()
    .description('全目标模式（v0.7，缺省关）：所有用户请求（含只读问题）都必须先经 cybernetics goal。开关在面板上保存后即时生效，无需重载。'),
  /**
   * New-input delivery policy (v0.9.0, default 'insert'). Volatile: read live
   * at every inbox insertion, so a panel edit governs the very next input.
   */
  inputPolicy: z.union(['insert', 'queue'] as const).default('insert').volatile()
    .description('新输入策略（v0.9.0，缺省 insert）：本会话 cybernetics 生效期间，goal 轮运行中到达的新用户输入不再排队到轮后（next-turn），而是作为外环控制直接插入当前回合（next-step/steer）；queue 恢复排队。cybernetics 关闭的会话完全不受此项影响，走 DSH 原生 busyEnter 行为。保存后即时生效。'),
  /**
   * Round-settled notice delivery policy (v0.13.0, default 'insert'). Volatile:
   * read live at every inbox insertion, same timing as inputPolicy.
   */
  noticePolicy: z.union(['insert', 'queue'] as const).default('insert').volatile()
    .description('轮完成通知策略（v0.13.0，缺省 insert）：本会话 cybernetics 生效期间，后台 goal 轮结束产生的内环完成通知（<cybernetics_round>）若排队在 next-turn（session agent 仍在跑），自动重定位为 next-step（steer）即时插入当前回合，免手动推送/等待轮后折叠；queue 恢复原生 next-turn 排队。保存后即时生效。'),
  /**
   * Status-indicator location (v0.19.0, default 'both'). Volatile: the client
   * reads it from the live ConfigForm snapshot on every render, so a panel
   * edit moves/hides the pill + hint bar without a remount. Purely cosmetic.
   */
  hintLocation: z.union(['both', 'pill', 'composer', 'none'] as const).default('both').volatile()
    .description('状态提示位置（v0.19.0，缺省 both）：控制模式状态 UI 的显示位置——both=顶栏药丸 + 编辑器下方提示条（默认，保持现状）；pill=仅顶栏药丸；composer=仅编辑器下方提示条；none=两处都不显示。纯外观项，不影响任何控制语义；配置未加载或旧宿主缺字段时客户端回退为 both。保存后即时生效，无需重载。'),
})

/** One resolved config field: a live reference (volatile), or a plain value. */
type ConfigField<T> = { get(): T } | T

/** Read one resolved config field, following the live reference the schema produces for volatile fields. */
function readConfigField<T>(field: ConfigField<T> | undefined, fallback: T): T {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof (field as { get?: unknown }).get === 'function') {
    const value = (field as { get(): T }).get()
    return value === undefined ? fallback : value
  }
  return field as T
}

/**
 * Multi-goal loop registry: session -> goalId -> loop. v0.3 lifts the
 * single-goal limit of dsh-goal (one slot per session) by keeping the
 * plugin's own goal board; the dsh-goal slot remains the FOCUS goal (GUI
 * tab + goal-round-driver auto-continuation) and is synced best-effort.
 */
const boards = new Map<unknown, Map<string, LoopState>>()

// v0.14 goal-agent tracking: hand the boards registry to src/agents.ts (no
// import cycle — agents.ts reaches the board only through this accessor).
setBoardSource(() => boards)

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
  /** Set once the run has been disposed (cancel-by-revision and collect can race). */
  disposed?: boolean
}
const running = new Map<string, RunningRound>()

/** Dispose a run at most once; disposal is best-effort observability cleanup. */
async function disposeOnce(handle: RunningRound): Promise<void> {
  if (handle.disposed) return
  handle.disposed = true
  try {
    await handle.run.dispose()
  } catch {
    // An already-settled or torn-down run must not fail the calling action.
  }
}

// --- v0.6 board persistence / rehydrate -------------------------------------
// The `boards` map above is process memory, and the `cyberneticsGoals`
// projection only replays session events written by SOME process. After a host
// restart the map is empty and — when the previous process never published (or
// the log was not yet replayed) — so is the tab: every historical goal seems to
// have vanished and the user can no longer track goals separately. Each
// session's board therefore snapshots itself next to the round logs at
// `<workspace>/.cybernetics/board-<sessionId>.json`, and the first tool call of
// a session with an empty memory board restores it and republishes once.
//
// Persistence is durability, never workflow control: both directions swallow
// their errors (a read-only workspace still runs rounds; a corrupt snapshot
// degrades to a fresh board instead of failing the call).

/** Snapshot format version; a mismatch is treated as "no snapshot". */
export const BOARD_FILE_VERSION = 1

/** On-disk board snapshot: the controller's whole goal board for one session. */
export interface BoardFile {
  version: number
  sessionId: string
  /** Epoch milliseconds of the snapshot write. */
  savedAt: number
  goals: LoopState[]
}

const BOARD_STATUSES: ReadonlySet<string> = new Set(['running', 'paused', 'met', 'cancelled', 'superseded'])
const PAUSE_REASONS: ReadonlySet<string> = new Set([
  'goal-questionable', 'human-input', 'round-cap', 'failed', 'no-goal',
])
const UNSAFE_FILENAME = /[^a-zA-Z0-9._-]/g

/** Snapshot file name for one session (ids are slugged: never a path escape). */
export function boardFileName(sessionId: string): string {
  return `board-${sessionId.replace(UNSAFE_FILENAME, '_')}.json`
}

/** Absolute snapshot path under the workspace root. */
export function boardFilePath(root: string, sessionId: string): string {
  return join(root, STATE_DIR, boardFileName(sessionId))
}

/**
 * Normalize one persisted goal back into a LoopState. Anything that is not a
 * usable goal record (no goalId, wrong shape) is dropped, so a partially
 * hand-edited or half-written snapshot still yields a usable board.
 */
function restoreLoop(raw: unknown): LoopState | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const g = raw as Record<string, unknown>
  if (typeof g.goalId !== 'string' || g.goalId.length === 0) return undefined
  const loop: LoopState = {
    goalId: g.goalId,
    round: typeof g.round === 'number' && Number.isFinite(g.round) ? g.round : 0,
    doneSummary: typeof g.doneSummary === 'string' ? g.doneSummary : '',
    subgoal: typeof g.subgoal === 'string' ? g.subgoal : '',
    role: typeof g.role === 'string' && g.role.length > 0 ? g.role : 'default',
  }
  if (typeof g.title === 'string') loop.title = g.title
  if (typeof g.objective === 'string') loop.objective = g.objective
  if (typeof g.brief === 'string') loop.brief = g.brief
  if (g.depth === 'quick' || g.depth === 'full') loop.depth = g.depth
  if (g.executor === 'ephemeral' || g.executor === 'persistent') loop.executor = g.executor
  if (typeof g.memberName === 'string' && g.memberName.length > 0) loop.memberName = g.memberName
  if (typeof g.status === 'string' && BOARD_STATUSES.has(g.status)) loop.status = g.status as LoopState['status']
  if (g.paused !== null && typeof g.paused === 'object' && !Array.isArray(g.paused)) {
    const p = g.paused as Record<string, unknown>
    if (typeof p.reason === 'string' && PAUSE_REASONS.has(p.reason) && typeof p.note === 'string') {
      loop.paused = { reason: p.reason as ResumableReason, note: p.note }
    }
  }
  if (typeof g.parentGoalId === 'string' && g.parentGoalId.length > 0) loop.parentGoalId = g.parentGoalId
  if (typeof g.supersededBy === 'string' && g.supersededBy.length > 0) loop.supersededBy = g.supersededBy
  // v0.14 goal-agent records: restore every well-formed entry so the「目标」tab
  // keeps showing a goal's spawned agents across host restarts.
  if (Array.isArray(g.agents)) {
    const agents: LoopState['agents'] = []
    for (const raw of g.agents) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const a = raw as Record<string, unknown>
      if (typeof a.id !== 'string' || a.id.length === 0) continue
      agents.push({
        id: a.id,
        role: typeof a.role === 'string' && a.role.length > 0 ? a.role : 'task',
        label: typeof a.label === 'string' ? a.label : '',
        startedAt: typeof a.startedAt === 'number' && Number.isFinite(a.startedAt) ? a.startedAt : 0,
        ...(a.outcome === 'completed' || a.outcome === 'failed' || a.outcome === 'cancelled'
          ? { outcome: a.outcome }
          : {}),
        ...(typeof a.endedAt === 'number' && Number.isFinite(a.endedAt) ? { endedAt: a.endedAt } : {}),
      })
    }
    if (agents.length > 0) loop.agents = agents
  }
  // v0.21 model-audit mirror: restore the latest round's per-role audit so the
  // board keeps answering "what ran on what" across host restarts. Absent on
  // pre-v0.21 snapshots (readers tolerate missing fields). Corrupt rows are
  // dropped per-field; a whole-malformed mirror restores to nothing.
  if (g.models !== null && typeof g.models === 'object' && !Array.isArray(g.models)) {
    const m = g.models as Record<string, unknown>
    if (typeof m.round === 'number' && Number.isFinite(m.round) && m.agents !== null && typeof m.agents === 'object' && !Array.isArray(m.agents)) {
      const agents: Record<string, unknown> = {}
      for (const [key, row] of Object.entries(m.agents as Record<string, unknown>)) {
        if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
          const r = row as Record<string, unknown>
          if (r.source === 'config' || r.source === 'observed') agents[key] = row
        }
      }
      loop.models = { round: m.round, agents: agents as AgentsModelAudit }
    }
  }
  if (Array.isArray(g.revisions)) {
    loop.revisions = []
    for (const entry of g.revisions) {
      if (entry === null || typeof entry !== 'object') continue
      const r = entry as Record<string, unknown>
      loop.revisions.push({
        version: typeof r.version === 'number' && Number.isFinite(r.version) ? r.version : 0,
        reason: typeof r.reason === 'string' ? r.reason : '',
        at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0,
      })
    }
  }
  return loop
}

/**
 * Read one session's board snapshot. Missing file, unreadable file, invalid
 * JSON, a different format version or a foreign session id all mean "no
 * history" — this function never throws.
 */
export async function loadBoardFile(root: string, sessionId: string): Promise<LoopState[] | undefined> {
  let text: string
  try {
    text = await readFile(boardFilePath(root, sessionId), 'utf8')
  } catch {
    return undefined // no snapshot: a genuinely fresh session
  }
  try {
    const parsed = JSON.parse(text) as Partial<BoardFile> | null
    if (parsed === null || typeof parsed !== 'object') return undefined
    if (parsed.version !== BOARD_FILE_VERSION) return undefined
    if (typeof parsed.sessionId === 'string' && parsed.sessionId !== sessionId) return undefined
    if (!Array.isArray(parsed.goals)) return undefined
    const out: LoopState[] = []
    const seen = new Set<string>()
    for (const raw of parsed.goals) {
      const loop = restoreLoop(raw)
      if (loop === undefined || loop.goalId === undefined || seen.has(loop.goalId)) continue
      seen.add(loop.goalId)
      out.push(loop)
    }
    return out
  } catch {
    return undefined // corrupt snapshot: behave like an empty board
  }
}

/**
 * Atomically snapshot one session's board (temp file + rename, so a concurrent
 * reader never sees a half-written JSON). Returns the snapshot path, or
 * undefined when the write failed — never throws.
 */
export async function saveBoardFile(
  root: string,
  sessionId: string,
  loops: Iterable<LoopState>,
): Promise<string | undefined> {
  const file = boardFilePath(root, sessionId)
  const payload: BoardFile = {
    version: BOARD_FILE_VERSION,
    sessionId,
    savedAt: Date.now(),
    goals: [...loops],
  }
  const tmp = `${file}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`
  try {
    await mkdir(join(root, STATE_DIR), { recursive: true })
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
    return file
  } catch {
    return undefined
  }
}

/** Minimal required-field validation the omitted dsh-tools wrapper would do. */
function requireFields(args: Record<string, unknown>, names: string[]): void {
  for (const n of names) {
    if (args[n] === undefined) throw new Error(`cybernetics: missing required argument "${n}"`)
  }
}

const IMPLICIT_GUIDANCE = `Goal-driven control loop (cybernetics). You are the SESSION agent: you never execute task work
yourself — you manage goals and the task agents that execute them. Classify each user input:
- TRIVIAL READ-ONLY QUESTION (a fact your read tools answer directly, no computation) → answer inline, no goal.
- LIGHTWEIGHT ANALYSIS (a bounded query/lookup needing tool work but no multi-step planning) → create a goal
  with depth 'quick': one task-agent round, feed the result back directly.
- COMPLEX ANALYSIS (data fetching to disk, datasets, statistics, multi-step query planning) and ANY
  WORLD-CHANGING TASK → create a goal with depth 'full' (default): the work-verify loop must confirm the
  result before you deliver it. Never shortcut a change or a complex analysis through a quick round.
- For goals: call cybernetics with action 'start' (non-blocking) or 'round' (blocking), a short title, and
  a brief — the COMPLETE work order extracted from the request (background, paths, constraints, acceptance
  criteria). The task agent is an independent subagent with NO conversation history; the brief must be
  detailed enough for it to finish the work unaided. One session supports multiple concurrent goals.
- EXECUTOR (new): pass executor 'persistent' for goals whose rounds should accumulate context across
  iterations (multi-turn analysis by a durable teammate — the member keeps its identity and findings
  while you keep the dialogue). Default 'ephemeral' runs each round as fresh workflow subagents, which
  is right for one-shot work and changes. Persistent rounds still verify (full depth) through ephemeral
  verifiers, so verification never inherits the task narrative.
- CORRECTION to an existing task → an APPEND-ONLY goal revision: call action 'revise' with the old goalId, a
  required reason, the new objective when the goal itself changed (omit it to inherit), and optionally a new
  title / depth / executor. 'revise' creates a NEW goal (parentGoalId = old goal) and starts its first round;
  the old goal keeps its final state as 'superseded'. Pass abortPrevious: true only when the session agent
  decides the old goal's in-flight task agent must be interrupted (default: let it finish; the abort reuses
  the 'cancel' path, and 'cancel' on its own still stops a round without revising the goal).
  NEVER edit a goal's objective in place — 'revise' is the only goal-change verb, and only after the user
  has confirmed the change in conversation.
- FEEDBACK arrives as the tool result ('round') or, for async rounds, as an auto-inserted notification
  (delivered on settle — no manual push needed) followed by action 'collect'. Then choose: summarize the outcome to the user; start a verification round; or start a
  corrective round whose brief is built from the verdict gaps. On decision 'continue', launch the next
  round with the returned subgoal. On 'pause': 'met' = report and wait for user confirmation;
  'goal-questionable' = re-examine the goal through dialogue; 'human-input' = surface the question;
  'round-cap'/'failed' = report status. Never mark a goal complete yourself; completion is the user's act.
Use action 'list' to see every goal on this session's board with its status, round and subgoal.`

/**
 * v0.7 all-goals mode addendum: turns the implicit trigger from "suggest a
 * goal for substantial tasks" into "every request is a goal". Contains the
 * four routing rules the protocol and tests pin down:
 * (1) everything enters a goal; (2) simple read-only → 'quick' single round;
 * (3) complex analysis / write tasks → progressive multi-round ('full');
 * (4) the revise auto-abort decision tree.
 */
const ALL_GOALS_GUIDANCE = `
ALL-GOALS MODE ACTIVE (routing protocol — no exceptions, no in-place analysis):
- RULE 1 — EVERYTHING ENTERS A GOAL: for ANY user request (question, lookup, analysis, change), first
  create a goal via cybernetics (action 'start' with title + brief), then let the task agent produce the
  answer. NEVER answer a request by doing the task work yourself with read tools — even a one-file lookup
  or a quick calculation goes through the loop. If a change is requested while the hard gate is off, the
  protocol still forbids in-place edits: delegate.
- RULE 2 — SIMPLE READ-ONLY REQUEST → depth 'quick': one task-agent round, no verify/triage, feed the
  result straight back to the user (bounded lookups, single-file reads, small queries).
- RULE 3 — COMPLEX ANALYSIS or WRITE TASK → depth 'full', progressive multi-round: launch with action
  'start' (async), then 'collect' each settled round and advance the subgoal round by round (task →
  verify → triage). Analysis: data fetching to disk, datasets, statistics, multi-step query planning.
  Write tasks additionally rely on the hard gate: the session agent must NEVER execute a change itself —
  delegation through the goal loop is the only path, however small the change.
- RULE 4 — REVISE DECISION TREE (updating an existing goal stays append-only: a new goal with
  parentGoalId, old goal superseded; 'revise' is the only goal-change verb). Decide abortPrevious by the
  old task agent's state (check with action 'list'):
  (a) old round STILL RUNNING and the revision contradicts it (objective/depth rewritten — conflicting
      goals / write-domain overlap) → let 'revise' auto-abort: do not pass abortPrevious; the plugin
      cancels the old round automatically;
  (b) old round STILL RUNNING but the correction keeps the objective (brief/title/role only) and the old
      work stays valuable / parallelizable / reusable → do not pass abortPrevious; the plugin waits for
      the old round to finish naturally;
  (c) old task agent ALREADY FINISHED (goal not running on the board) → just call 'revise'; no abort is
      needed and none is attempted.
  The chosen branch and its reason are recorded in the .cybernetics/revisions-<newGoalId>.jsonl audit
  line (abort.mode = auto|explicit + basis). Passing abortPrevious explicitly keeps manual control.`

/**
 * v0.11.0 plan precedence (docs/plan-precedence.md §4.3, design finalized
 * v0.10.0, user ruling 2026-11-05): when plan mode is active (or pending) for
 * the requesting session, this segment REPLACES the entire cybernetics
 * guidance (IMPLICIT + ALL-GOALS + hard-gate wording) — the session agent
 * plans inline under plan discipline instead of routing everything through
 * goals. Wording already reflects the v0.10.0 gate policy: the hard gate is
 * exempted per-session while plan mode is active, so plan discipline is
 * carried by this guidance + the plan:policy section, not by tool removal.
 */
const PLAN_PRECEDENCE_GUIDANCE = `
PLAN MODE ACTIVE (plan precedence over cybernetics): this session is in plan mode; the plan
protocol governs this turn and the ALL-GOALS routing protocol is SUSPENDED:
- Do NOT create goals, do NOT call the cybernetics tool, do NOT delegate — planning is done by
  you, inline, in this conversation.
- Stay read-only: research with read/search tools only; no changes to files, services, boards or
  any other state.
- Present the complete plan with the exit_plan_mode tool for user approval. On approval plan mode
  exits, and the session's cybernetics mode (goal loop + hard gate) resumes from the next step:
  approved implementation work will then be routed through the goal loop.
The hard gate is EXEMPTED for this session while plan mode is active: full tool access is restored
for the plan turn. Plan discipline is carried by this guidance and the plan:policy section, not by
tool removal; the gate returns automatically once plan mode exits.`

/** Tool names hidden from top-level session agents when the hard gate is on. */
const DEFAULT_GATED_TOOLS = ['bash', 'edit', 'write']

/**
 * Allowlist-mode survival set for top-level orchestrator agents: pure reads,
 * conversation, presentation and goal/control verbs. Anything that
 * changes the world — files, services, boards, knowledge, schedules, docs,
 * other agents' work — is absent, so the session agent must delegate it to a
 * cybernetics task agent. The cybernetics tool itself is always re-added.
 */
const DEFAULT_GATE_ALLOWLIST = [
  // v0.11.0 plan precedence (docs/plan-precedence.md §4.2): the plan-mode
  // approval tool is read-only and always registered; outside plan mode a
  // call throws (plan-mode lib :255), so listing it has no side effect. This
  // is the FALLBACK that keeps plan approval reachable even when the
  // planWanted projection detection below fails (plan-mode unmounted, key
  // renamed, read error) — plan approval must never be double-killed.
  'exit_plan_mode',
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

/**
 * Hard-gate guidance is mode-specific (v0.8.6). In allowlist mode the strong
 * claim is true: every change-class tool is absent from the assembly and
 * denied at dispatch. In denylist mode it was FALSE — only `gatedTools` is
 * removed while bsk_ / taskboard_ / schedule_ / farm_ / uno_ / ppt_ /
 * config_restore remain callable — so the section names the partial stance
 * instead of pretending the loop is structurally enforced.
 */
const HARD_GATE_GUIDANCE_ALLOWLIST = `
HARD GATE ACTIVE (allowlist mode): your tool list is restricted to reading, searching, conversation,
presentation and goal/control verbs — every tool that CHANGES the world (edit/write/bash,
service lifecycle, board/knowledge/schedule writes, spawning other workers, ...) is STRUCTURALLY
unavailable to you. Answering a read-only question directly is fine and needs no goal; but the
moment the user asks for a change — however small — that is your signal to delegate: create a
cybernetics goal (action 'start' with title+brief) and let a task agent execute it. Never tell the
user a change is "too small for the loop": the loop is the only way changes get done. If you look
for a tool to perform a change and do not find it, that is the gate working as intended — delegate
instead.`

const HARD_GATE_GUIDANCE_DENYLIST = `
HARD GATE ACTIVE (denylist mode): only the tools listed in gatedTools (default bash, edit, write)
are removed from your tool list. This mode is PARTIAL, not structural: other change-class tools are
still present and callable — bsk_* (browser automation), taskboard_* (board writes), schedule_*
(cron reminders), farm_* (service lifecycle), uno_* / ppt_* (document generators), config_restore,
subagent/team spawning, and the rest of the mutation long tail. Their availability is NOT
permission to do task work yourself — calling one directly bypasses the goal loop this deployment
requires. The moment the user asks for a change, however small, create a cybernetics goal (action
'start' with title+brief) and let a task agent execute it. Do not route around a missing tool with
another write tool, and do not describe the gate as total: it hides gatedTools only.`

/** Effective gate semantics: explicit config wins; otherwise follow hardGate. */
function resolveGateMode(config: Partial<Config>, hardGate: boolean): 'denylist' | 'allowlist' {
  if (config.gateMode === 'denylist' || config.gateMode === 'allowlist') return config.gateMode
  return hardGate ? 'allowlist' : 'denylist'
}

export function apply(ctx: any, config: Partial<Config> = {}) {
  const toolName = config.toolName ?? 'cybernetics'
  // v0.8.10: hardGate is a volatile field, so it may arrive as a live
  // reference whose value the settings card commits in place — read it at use
  // time instead of capturing it once (same pattern as allGoalsMode below).
  // Fallback false keeps the plain-object contract unchanged: a config that
  // simply omits hardGate installs no gate, exactly as before; the schema's
  // default(true) reaches the runtime through the live reference the volatile
  // resolution provides.
  const hardGate = (): boolean => readConfigField(config.hardGate, false) === true
  // v0.8.6 default-safe gate semantics: a user who turns hardGate on but says
  // nothing about gateMode gets the structural allowlist, not the leaky
  // denylist. hardGate=false resolves to denylist but no gate is installed,
  // so its behavior is unchanged. gateMode itself stays non-volatile: its
  // plain value is re-read on every (re)install, so a hot hardGate flip
  // re-derives the mode via resolveGateMode at that moment.
  // allGoalsMode is a volatile field: under the loader's schema resolution it
  // arrives as a live reference whose value the settings panel commits in
  // place (no remount), so read it at use time instead of capturing it once.
  const allGoalsMode = () => readConfigField(config.allGoalsMode, false) === true
  // v0.9.0 per-session enablement: the /cybernetics override wins; without one
  // the global allGoalsMode volatile decides. Read at every use point — both
  // the override (session projection) and the global (volatile live ref) can
  // change while the host runs.
  const enabledFor = (session: unknown): boolean =>
    effectiveEnabled(ctx, session, allGoalsMode())
  const disposers: Array<() => void> = []

  // v0.6: register the multi-goal session projection, so every goal on the
  // session board — not just dsh-goal's single focus slot — reaches the
  // 「目标 / Goal」tab. The registration rides this plugin's fiber: unloading
  // the plugin removes the key and the tab falls back to the `goal` face.
  // Guarded because the offline harness (and any host without the projection
  // seam) builds a ctx without `sessionProjections`.
  const projections = ctx.sessionProjections as
    | { register?: (definition: unknown) => () => void }
    | undefined
  if (projections !== undefined && typeof projections.register === 'function') {
    const projectionDisposer = projections.register(cyberneticsGoalsProjection())
    if (typeof projectionDisposer === 'function') disposers.push(projectionDisposer)
    // v0.9.0: the per-session /cybernetics override projection (same registry,
    // separate key; replayed eagerly, so modeOverrideOf reads are synchronous).
    const modeDisposer = projections.register(cyberneticsModeProjection())
    if (typeof modeDisposer === 'function') disposers.push(modeDisposer)
  }

  // v0.14 goal-agent tracking: listen to the host engine's lifecycle events
  // (the exact seam dsh-tool-workflow uses) and fold each child agent of THIS
  // plugin's runs onto its goal's board record (src/agents.ts). Only runs the
  // plugin itself started are correlated (linkRunToGoal at launch), so other
  // workflows sharing the engine never leak into a goal board. Guarded: a ctx
  // without `on` (offline harness) skips tracking entirely, and each listener
  // failure is contained inside noteWorkflowAgent.
  if (typeof ctx.on === 'function') {
    try {
      const offStart = ctx.on('workflow/agent-start', (info: unknown, agent: unknown) => {
        noteWorkflowAgent(info, agent, undefined)
      })
      if (typeof offStart === 'function') disposers.push(offStart)
      const offEnd = ctx.on('workflow/agent-end', (info: unknown, agent: unknown) => {
        const outcome = agent !== null && typeof agent === 'object'
          ? (agent as { outcome?: unknown }).outcome
          : undefined
        noteWorkflowAgent(info, agent, outcome === 'completed' || outcome === 'failed' || outcome === 'cancelled' ? outcome : undefined)
      })
      if (typeof offEnd === 'function') disposers.push(offEnd)
      const offRun = ctx.on('workflow/end', (info: unknown) => { unlinkRun((info as { id?: unknown })?.id) })
      if (typeof offRun === 'function') disposers.push(offRun)
    } catch {
      // Events unavailable on this fiber: goal-agent tracking stays off.
    }
  }

  // The implicit guidance section embeds the volatile allGoalsMode wording,
  // so it must be re-derived when a settings-panel toggle is committed into
  // the running instance (the loader announces loader/volatile-update on this
  // fiber instead of remounting; same re-derive pattern as dsh-ssh's sync()).
  let disposeSection: (() => void) | undefined
  function registerGuidanceSection() {
    if (disposeSection !== undefined) disposeSection()
    disposeSection = undefined
    if (config.implicitTrigger === false) return
    // v0.8.10: the hard-gate wording is re-derived per call — hardGate is
    // volatile, so its guidance segment follows the live toggle too.
    // v0.9.0: the section text is a FUNCTION of the requesting agent's
    // session (the same form dsh-plan-mode uses for its plan:policy section).
    // Per-session /cybernetics override:
    //   off  → no guidance at all for that session (no ALL-GOALS protocol,
    //          no hard-gate wording) and the gate listeners pass it through;
    //   on   → full control guidance (ALL-GOALS routing included),
    //          regardless of the global allGoalsMode;
    //   none → the global allGoalsMode volatile decides ALL-GOALS inclusion,
    //          exactly the pre-v0.9.0 behavior for un-overridden sessions.
    const gateMode = resolveGateMode(config, hardGate())
    const hardGateGuidance = hardGate()
      ? (gateMode === 'allowlist' ? HARD_GATE_GUIDANCE_ALLOWLIST : HARD_GATE_GUIDANCE_DENYLIST)
      : ''
    disposeSection = ctx.systemPrompt.section({
      name: `tool:${toolName}`,
      order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
      text: (context: any) => {
        const session = context?.agent?.session
        const override = modeOverrideOf(ctx, session)
        if (override === false) return ''
        // v0.11.0 plan precedence (docs/plan-precedence.md §4.3): plan mode
        // outranks cybernetics — the whole segment (including the hard-gate
        // wording, conflict C3) is replaced by the plan protocol. Same
        // planWanted predicate the gate exemption reads (§4.1), so guidance
        // and gate can never drift apart.
        if (planWanted(ctx, session)) return PLAN_PRECEDENCE_GUIDANCE
        const allGoals = override === true ? true : allGoalsMode()
        return IMPLICIT_GUIDANCE + (allGoals ? ALL_GOALS_GUIDANCE : '') + hardGateGuidance
      },
    })
  }
  registerGuidanceSection()
  disposers.push(() => { if (disposeSection !== undefined) disposeSection() })

  /**
   * v0.8.10: install (or tear down) the hard-gate wiring in step with the
   * volatile hardGate toggle. Idempotent: each call first disposes the
   * previous installation, so repeated toggles never double-register. A
   * hot false→true re-derives gateMode via resolveGateMode from the CURRENT
   * resolution (explicit gateMode config wins; otherwise allowlist).
   */
  let disposeGate: (() => void) | undefined
  function installGate(): void {
    if (disposeGate !== undefined) { disposeGate(); disposeGate = undefined }
    if (!hardGate()) return
    const gateDisposers: Array<() => void> = []
    // The gate is being installed, so hardGate() is true here; resolveGateMode
    // then honors an explicit gateMode or derives the structural allowlist.
    const gateMode = resolveGateMode(config, true)
    const allowlistMode = gateMode === 'allowlist'
    // NOTE: schema-resolved config turns an unset z.array field into [] (not
    // undefined), so fall back on length, not on ?? — otherwise the gate
    // would silently keep/gate nothing.
    const keep = new Set([
      ...(config.gateAllowlist?.length ? config.gateAllowlist : DEFAULT_GATE_ALLOWLIST),
      ...(config.gateAllowlistExtra ?? []),
      toolName,
      // v0.18.2: the preset_recommend tool is a conversation/decision seam of
      // THIS plugin (the auto recommendation is answered through it), so it
      // survives the allowlist exactly like the cybernetics tool itself.
      PRESET_RECOMMEND_TOOL_NAME,
    ])
    const gated = new Set(config.gatedTools?.length ? config.gatedTools : DEFAULT_GATED_TOOLS)
    // The hard gate: a system-prompt/assemble waterfall listener that strips
    // execution tools from TOP-LEVEL agents' assemblies. Workflow subagents
    // (task/verify/triage) and team teammates are never in agents.roots(),
    // so their assemblies pass through untouched with full tool access.
    const listenerDisposer = ctx.on('system-prompt/assemble', (assembly: any, context: any, next: () => unknown) => {
      const scope = context?.scope
      if (!scope) return next()
      let roots: unknown[] = []
      try { roots = ctx.agents?.roots?.() ?? [] } catch { roots = [] }
      const isRoot = roots.some((r: any) =>
        r === scope || r?.id === scope || (r?.id && r.id === scope?.id))
      // Fallback for agents the registry does not list as roots (a resumed
      // session's agent, for example): a session with no parentSession is a
      // top-level session and belongs on the orchestrator side of the gate.
      // Delegated children (workflow subagents, team members) carry
      // `origin: subagent` + `parentSession` and keep their full tool set.
      const parentSession = (scope as any)?.session?.header?.parentSession
      const isSessionRoot = parentSession === undefined
      if (!isRoot && !isSessionRoot) return next()
      // v0.9.0: an EXPLICIT /cybernetics off override exempts the session —
      // the gate passes UNFILTERED, tools included verbatim. Without an
      // override the gate applies exactly as configured (hardGate is
      // independent of allGoalsMode, so a null override changes nothing).
      if (modeOverrideOf(ctx, (scope as any)?.session) === false) return next()
      // v0.11.0 plan precedence (docs/plan-precedence.md §4.3-硬门, user
      // ruling 2026-11-05): a plan-active session gets the gate PASSED
      // THROUGH per-request — plan discipline is carried by guidance +
      // plan:policy, not tool removal; when the projection flips (approval /
      // /plan off) the very next request is gated again with zero recovery
      // logic.
      if (planWanted(ctx, (scope as any)?.session)) return next()
      if (Array.isArray(assembly.tools)) {
        assembly.tools = allowlistMode
          ? assembly.tools.filter((t: any) => keep.has(t?.name))
          : assembly.tools.filter((t: any) => !gated.has(t?.name))
      }
      return next()
    })
    gateDisposers.push(() => listenerDisposer?.())

    // Execution-layer gate (the assembly filter above only hides names; the
    // host resolves any registered tool by name, so an unadvertised call must
    // be denied here too). Same root/child rule: a session with no
    // parentSession is orchestrated by the gate; delegated children pass.
    const isGatedAgent = (agent: any): boolean => {
      if (agent === undefined || agent === null || typeof agent !== 'object') return false
      let roots: unknown[] = []
      try { roots = ctx.agents?.roots?.() ?? [] } catch { roots = [] }
      if (roots.some((r: any) => r === agent || r?.id === agent || (r?.id && r.id === agent?.id))) return true
      return agent?.session?.header?.parentSession === undefined
    }
    const preDisposer = ctx.on('tools/pre-execute', (exec: any, next: () => Promise<unknown>) => {
      const name = exec?.name
      if (typeof name !== 'string') return next()
      if (!isGatedAgent(exec?.agent)) return next()
      // v0.9.0: the dispatch-layer gate honors the same per-session override
      // as the assembly filter — an explicit off is never denied here.
      if (modeOverrideOf(ctx, exec?.agent?.session) === false) return next()
      // v0.11.0 plan precedence (§4.3-硬门): plan-active sessions are never
      // denied — same per-request exemption as the assembly filter.
      if (planWanted(ctx, exec?.agent?.session)) return next()
      // v0.11.0 §4.2 C1 fallback: the plan-approval tool is explicitly passed
      // at dispatch for BOTH gate modes (double protection alongside the
      // allowlist entry), so plan approval survives even a planWanted
      // detection failure.
      if (name === 'exit_plan_mode') return next()
      const blocked = allowlistMode ? !keep.has(name) : gated.has(name)
      if (!blocked) return next()
      return Promise.resolve({
        kind: 'deny',
        reason:
          `cybernetics hard gate: tool "${name}" is not available to the session agent. ` +
          'Delegate the change: create a cybernetics goal (action "start" with title+brief) and let a task agent execute it.',
      })
    })
    gateDisposers.push(() => preDisposer?.())

    // v0.8.5 approval relay (gateApprovalRelay, default true): delegated
    // children (workflow subagents, teammates) inherit the host's PINNED
    // `never` approval policy (dsh-subagent/lib/index.js:413
    // captureDelegatedPolicyOverrides pins 'never' for every delegation;
    // dsh-user-approval/lib/index.js:175 decide() then short-circuits the ask
    // to 'rejected' BEFORE any answerer runs), so a task agent's sandbox
    // escalation (e.g. writing outside the session workspace) can never reach
    // the user. Relay = two listeners:
    //
    // (1) agent/created — flip the child's effective policy to 'ask' by
    //     appending one plain `approval/policy {policy:'ask'}` event to the
    //     child session (exactly what the host's setApprovalPolicy appends;
    //     later child switches win over the delegation-seeded pin). Live
    //     evidence: a real delegated session log carries the pin
    //     {policy:'never', source:'delegation'} at seq 2 and the plugin's
    //     {policy:'ask'} at seq 3 (52 ms later).
    // (2) approval/request — OUTERMOST answerer (prepend:true) for delegated
    //     children only. It does NOT give the native chain the first turn:
    //     the host's api-remotes registers an approval/request waterfall
    //     listener at boot (dsh-api-remotes/lib/index.js:21-28,147
    //     API_REMOTE_FORWARDED_EVENTS → forwardWaterfall at :233) and
    //     forwards every request to the connected browser, where
    //     dsh-client-ui-approval/lib/client.js:284 answerApproval claims it
    //     and awaits a per-session panel that is INVISIBLE whenever the user
    //     is watching the parent conversation. A listener registered after
    //     api-remotes is INNER and is never reached (cordis waterfall runs
    //     outermost-first — cordis/lib/index.js:317-325), so the previous
    //     bounded-window `next()` race could not fire at all: the child hung
    //     on a panel nobody could see. prepend makes the relay the FIRST
    //     listener; it re-issues the request ON THE TOP-LEVEL LIVE ANCESTOR
    //     AGENT through the host's own ApprovalService
    //     (ctx.get('approval').request) — the native Allow once / Reject
    //     panel of the conversation the user is actually watching, audited as
    //     approval/asked + approval/decided on that session. The child's
    //     callId is deliberately NOT forwarded (a child ToolCallId must not
    //     correlate with a tool call in the parent transcript). When the
    //     top-level turn is closed (ApprovalService.request requires an open
    //     turn: dsh-user-approval/lib/index.js:130) the relay falls back to
    //     the user-questions channel on the same agent (an ask_user_question
    //     card in the same composer). A native 'unavailable' (no answering
    //     client) ALSO falls through to the question card — v0.8.8 fix: the
    //     live failure was asked → decided unavailable in 9 ms with no visible
    //     prompt. Denial semantics stay explicit: relay errors answer
    //     'rejected', an aborted child run answers 'cancelled', a question
    //     channel that is also unavailable answers terminal 'unavailable',
    //     and a child with no live top-level agent falls through to next()
    //     (the host's fail-closed native semantics) — never a silent success.
    const gateApprovalRelay = config.gateApprovalRelay !== false
    if (gateApprovalRelay) {
      // Delegated children carry `origin: 'subagent'` (dsh-subagent sets it on
      // the child header; the live session log of this very task agent shows
      // it). Forks keep a parentSession for lineage but are independent roots,
      // so they are excluded here: `delegationDepth > 0` is the fallback when
      // a host build omits `origin`.
      const isDelegatedChild = (agent: any): boolean => {
        const header = agent?.session?.header
        if (header === undefined || header === null) return false
        if (header.origin === 'subagent') return true
        return header.parentSession !== undefined && typeof header.delegationDepth === 'number' && header.delegationDepth > 0
      }
      const agentById = (id: string): any => {
        try {
          const direct = ctx.agents?.get?.(id)
          if (direct !== undefined && direct !== null) return direct
        } catch { /* registry lookup is best-effort */ }
        try {
          return (ctx.agents?.roots?.() ?? []).find((r: any) =>
            r?.id === id || r?.session?.header?.id === id)
        } catch { return undefined }
      }
      // Walk the durable parentSession chain up to the live TOP-LEVEL agent:
      // the conversation the user watches. Undefined when a link is dead (a
      // continuable child that outlived its parent) — the relay then leaves
      // the request to the native chain.
      const topLevelAgentOf = (agent: any): any => {
        let cursor = agent
        const visited = new Set<string>()
        while (true) {
          const parentId = cursor?.session?.header?.parentSession
          if (parentId === undefined) return cursor
          if (visited.has(parentId)) return undefined
          visited.add(parentId)
          const parent = agentById(parentId)
          if (parent === undefined) return undefined
          cursor = parent
        }
      }
      const approvalServiceOf = (agent: any): any => {
        try {
          const fromCtx = typeof ctx.get === 'function' ? ctx.get('approval') : undefined
          if (fromCtx !== undefined) return fromCtx
        } catch { /* service not provided in this deployment */ }
        try { return agent?.ctx?.get?.('approval') } catch { return undefined }
      }

      const createdDisposer = ctx.on('agent/created', (payload: any) => {
        const agent = payload?.agent
        if (!isDelegatedChild(agent)) return
        try {
          agent.session.append('approval/policy', { policy: 'ask' })
        } catch {
          // agent/created is a serial event: a throw fails child creation.
          // A relay must never break delegation — leave the pinned policy.
        }
      })
      gateDisposers.push(() => createdDisposer?.())

      const RELAY_QUESTION_ID = 'cybernetics-approval-relay'
      const RELAY_ALLOW = '允许一次（Allow once）'
      const RELAY_REJECT = '拒绝（Reject）'
      // 'unavailable' is deliberately NOT terminal here: it means "the native
      // panel had no answering client" (dsh-user-approval/lib/index.js:176),
      // which is exactly the v0.8.7 live failure (asked → decided unavailable
      // in 9 ms). The relay then still falls through to the question card so
      // the user gets a VISIBLE prompt; only when the question channel is also
      // unavailable does the request end as a terminal 'unavailable'.
      const APPROVAL_OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled'])

      // Observability (v0.8.8, persisted v0.8.9): every relay decision logs
      // the path taken, outcome, latency and the resolved top-level target —
      // to the host logger AND to `<workspace>/.cybernetics/relay-log.jsonl`.
      // The file is the ground truth a later acceptance run can read without
      // host stdout or browser console access (the v0.8.8 live failure was
      // indistinguishable between "stale build" and "both channels down").
      const relayLog = (agent: any, path: string, outcome: string, startedAt: number): void => {
        const rootId = agent?.session?.header?.id ?? agent?.id ?? 'unknown'
        const line = `cybernetics approval-relay: path=${path} outcome=${outcome} ` +
          `root=${rootId} elapsed=${Date.now() - startedAt}ms`
        try {
          const logger = (ctx as { logger?: { debug?: (m: string) => void; info?: (m: string) => void } }).logger
          if (typeof logger?.debug === 'function') logger.debug(line)
          else if (typeof logger?.info === 'function') logger.info(line)
          else console.debug(line)
        } catch { console.debug(line) }
        // Fire-and-forget disk append; a relay must never fail because its own
        // audit trail could not be written.
        try {
          const wd = (ctx as { workingDirectory?: { get?: (s: unknown) => unknown } }).workingDirectory
          const ws = typeof wd?.get === 'function' ? wd.get(agent?.session) : undefined
          if (typeof ws !== 'string' || ws.length === 0) return
          const entry = JSON.stringify({
            ts: new Date().toISOString(),
            root: rootId,
            path,
            outcome,
            elapsedMs: Date.now() - startedAt,
          }) + '\n'
          void mkdir(join(ws, '.cybernetics'), { recursive: true })
            .then(() => appendFile(join(ws, '.cybernetics', 'relay-log.jsonl'), entry, 'utf8'))
            .catch(() => { /* observability only */ })
        } catch { /* observability only */ }
      }

      // Ask the top-level agent through the host's native approval channel,
      // falling back to the user-questions channel, then to a terminal
      // 'unavailable'. Returns a closed approval outcome.
      const relayToSessionAgent = async (req: any, root: any): Promise<string> => {
        const childId = req.agent?.session?.header?.id ?? req.agent?.id ?? 'unknown'
        const rootId = root?.session?.header?.id ?? root?.id ?? 'unknown'
        const startedAt = Date.now()
        const reason = typeof req.reason === 'string' && req.reason.length > 0 ? req.reason : undefined
        const approval = approvalServiceOf(root)
        if (approval !== undefined && typeof approval.request === 'function') {
          try {
            const outcome = await approval.request({
              agent: root,
              toolName: req.toolName,
              reason: `[sub-agent ${childId}] ${reason ?? `tool "${req.toolName}" requires approval`}`,
              displayReason: {
                en: `Sub-agent ${childId} requests privileged execution of ${req.toolName}${reason === undefined ? '' : `: ${reason}`}`,
                zh: `子代理 ${childId} 请求越权执行工具 ${req.toolName}${reason === undefined ? '' : `：${reason}`}`,
              },
              ...(req.signal !== undefined ? { signal: req.signal } : {}),
            })
            if (APPROVAL_OUTCOMES.has(outcome)) {
              relayLog(root, 'native-panel', outcome, startedAt)
              return outcome
            }
            // 'unavailable' (or any unknown value): the native panel found no
            // answering client — keep falling through to the question card.
          } catch {
            // No open turn on the session agent (continuable child outliving
            // it) or the audit pair failed: the question channel does not
            // require an open turn, so try it before giving up.
          }
        }
        // v0.8.9 ROOT-CAUSE FIX: plain property access `ctx.userQuestions` on
        // this plugin's context throws cordis' "cannot get property without
        // inject" (the plugin's `inject` list does not declare the service),
        // so the previous `try { ctx.userQuestions }` always fell into the
        // catch and the question-card fallback answered terminal 'unavailable'
        // within milliseconds — the user never saw a card. Resolution now
        // mirrors dsh-plan-mode/lib/index.js:257 (`ctx.get("userQuestions")`,
        // the inject-free reflective read that walks the composition store),
        // with the property access kept as a secondary attempt for host builds
        // where the service is injected under a different graph shape.
        let uq: any
        try {
          const viaGet = typeof (ctx as { get?: (n: string) => unknown }).get === 'function'
            ? (ctx as { get: (n: string) => unknown }).get('userQuestions')
            : undefined
          if (viaGet !== undefined && typeof (viaGet as { ask?: unknown }).ask === 'function') uq = viaGet
        } catch { uq = undefined }
        if (uq === undefined) {
          try { uq = ctx.userQuestions } catch { uq = undefined }
          if (uq !== undefined && typeof uq.ask !== 'function') uq = undefined
        }
        if (uq === undefined || typeof uq.ask !== 'function') {
          relayLog(root, 'question-card', 'unavailable', startedAt)
          return 'unavailable'
        }
        if (req.signal?.aborted) {
          relayLog(root, 'question-card', 'cancelled', startedAt)
          return 'cancelled'
        }
        try {
          const answer = await uq.ask({
            questions: [{
              id: RELAY_QUESTION_ID,
              question: `${reason ?? `tool ${req.toolName}`}（子代理 ${childId} 请求越权执行工具 ${req.toolName}）`,
              detail: reason,
              header: '子代理审批透传',
              options: [{ label: RELAY_ALLOW }, { label: RELAY_REJECT }],
              multiSelect: false,
            }],
            agent: root,
            ...(req.signal !== undefined ? { signal: req.signal } : {}),
          })
          const selected = (answer?.answers ?? []).find((a: any) => a?.id === RELAY_QUESTION_ID)?.selected ?? []
          const outcome = selected.includes(RELAY_ALLOW) ? 'allowed-once' : 'rejected'
          relayLog(root, 'question-card', outcome, startedAt)
          return outcome
        } catch {
          // Question delivery failed (client gone, answerer refused, run
          // aborted): answer 'cancelled' when the child's own signal fired,
          // otherwise an explicit rejection — the child stops and explains.
          const outcome = req.signal?.aborted ? 'cancelled' : 'rejected'
          relayLog(root, 'question-card', outcome, startedAt)
          return outcome
        }
      }

      const relayDisposer = ctx.on('approval/request', async (req: any, next: () => Promise<string>) => {
        if (!isDelegatedChild(req?.agent)) return next()
        if (req?.signal?.aborted) return 'cancelled'
        const root = topLevelAgentOf(req.agent)
        // No live ancestor, or a malformed child whose chain loops back to
        // itself: never re-ask on the requesting agent (that would re-enter
        // this same waterfall forever).
        if (root === undefined || root === req.agent) {
          relayLog(req.agent, 'next-passthrough', 'next', Date.now())
          return next()
        }
        const outcome = await relayToSessionAgent(req, root)
        return outcome === undefined ? next() : outcome
      }, { prepend: true })
      gateDisposers.push(() => relayDisposer?.())
    }

    disposeGate = () => { gateDisposers.forEach((d) => d()) }
  }
  installGate()
  disposers.push(() => { if (disposeGate !== undefined) disposeGate() })
  ctx.on?.('loader/volatile-update', () => {
    registerGuidanceSection()
    installGate()
  })

  // --- v0.17.0 preset plans (预置方案): one-shot selection handler ----------
  // The settings card writes `presetPlan` (volatile selector); this handler
  // resolves each CHANGE of that value exactly once:
  //   'auto'   → (v0.18.2, user ruling) NO independent LLM call and NO
  //              spawned agent: probe the live catalog, build the
  //              recommendation brief (catalog + principles + current role
  //              fields + vendor presets as reference), write a `pending`
  //              record to `presetRecommendation` (the same settings-service
  //              write path, ctx.get('settings').mutate) and HAND THE BRIEF
  //              to the live session agent(s): a steer/followup message asks
  //              the session agent to call the plugin-registered
  //              preset_recommend tool, which returns the brief (first hop)
  //              and validates + applies the session agent's own answer
  //              (second hop — applyRecommendationAnswer, then the write).
  //              The recommendation therefore comes from the session agent's
  //              OWN context, exactly once, without re-submitting it to a
  //              separate model call.
  //   vendor   → READY preset: apply its roles via the settings service;
  //              PLACEHOLDER: only record the status note (no model field is
  //              touched).
  // The outcome (pending handoff / picks / placeholder note / degradation
  // reason) is always written into `presetRecommendation`, which the card
  // renders under the dropdown. Guarded by `lastHandledPresetPlan` so:
  //  - the handler's own writes (which re-enter loader/volatile-update) are
  //    no-ops (they never change presetPlan);
  //  - a value that persists across a restart is not re-applied at boot
  //    (lastHandledPresetPlan is seeded from the CURRENT value).
  // EVERY failure is contained: the settings service may be absent (host
  // without dsh-settings — log + record nothing), any throw lands in a
  // degraded record, and the handler never throws into the loader event.
  const SETTINGS_NAMESPACE = 'dsh-cybernetics' // the loader row id = the card's SETTINGS_ENTRY_ID
  let lastHandledPresetPlan: string | undefined
  try {
    lastHandledPresetPlan = readConfigField(config.presetPlan, '')
  } catch { /* live-ref read failure: treat as never-handled */ }
  // --- v0.17.1 preset-handler diagnostics + settings resolution fallback ----
  // The live host surfaced a silent defect: GUI preset selections commit
  // (client mutate works) but the one-shot handler's writes never land and its
  // warn() output is invisible (host stdout only). Two additions, both inert
  // when everything already works:
  //  1. presetDiag(): append one JSON line to /tmp/dsh-cyb-preset-diag.jsonl so
  //     the handler's decision points are observable without host logs.
  //  2. settingsMutate() gains a ctx.root fallback: if the entry-scoped
  //     ctx.get('settings') cannot resolve the root-provided settings service
  //     (realm/proxy composition differences), resolve it from the root
  //     context instead. Deliberately NOT a static inject addition — a
  //     missing dependency would pend boot; a lazy fallback cannot.
  const presetDiag = (payload: Record<string, unknown>): void => {
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), ...payload }) + '\n'
      appendFile('/tmp/dsh-cyb-preset-diag.jsonl', line, 'utf8').catch(() => { /* diagnostics must never throw */ })
    } catch { /* diagnostics must never throw */ }
  }
  const probeSettings = (scope: string): Record<string, unknown> => {
    try {
      const scopeCtx = scope === 'root' ? (ctx as { root?: unknown }).root : ctx
      const get = typeof (scopeCtx as { get?: unknown })?.get === 'function'
        ? (scopeCtx as { get: (name: string) => unknown }).get.bind(scopeCtx)
        : undefined
      if (get === undefined) return { scope, result: 'no-get' }
      const settings = get('settings')
      if (settings === undefined) return { scope, result: 'undefined' }
      const mutateType = typeof (settings as { mutate?: unknown })?.mutate
      return { scope, result: mutateType === 'function' ? 'ok' : `mutate:${mutateType}` }
    } catch (error) {
      return { scope, result: 'threw', error: error instanceof Error ? error.message : String(error) }
    }
  }
  /**
   * v0.17.2 — the live host serializes every config write through the dsh-hmr
   * service: the settings.mutate chain ends in configEditor.edit →
   * hmr.runExclusive, and runExclusive REJECTS when its AsyncLocalStorage
   * store is set ("HMR transactions cannot be nested"). A preset handler runs
   * from loader/volatile-update — synchronously inside the very transaction
   * that committed the volatile write — and that store leaks into every async
   * continuation scheduled during the transaction (verified empirically:
   * timers fired after run() completed still saw the store), so the v0.17.1
   * live diag recorded write-refused … "HMR transactions cannot be nested"
   * even though the settings service itself resolved. dsh-hmr's own
   * watchConfig faces the identical problem and escapes with
   * `this.executing.exit(...)`; we mirror exactly that: resolve the hmr
   * service and run the mutate with the transaction store cleared, so
   * runExclusive sees a fresh caller and QUEUES the write behind the
   * in-flight transaction (the loader emits volatile-update without awaiting
   * listeners, so queueing cannot deadlock). When the hmr service is
   * unreachable (offline stubs, composition changes) the plain call is kept —
   * behavior identical to v0.17.1.
   */
  const resolveHmrExit = (): ((cb: () => unknown) => unknown) | undefined => {
    try {
      const scopes: Array<() => unknown> = [
        () => typeof (ctx as { get?: unknown })?.get === 'function' ? (ctx as { get: (name: string) => unknown }).get('hmr') : undefined,
        () => {
          const root = (ctx as { root?: unknown })?.root as { get?: (name: string) => unknown } | undefined
          return typeof root?.get === 'function' ? root.get('hmr') : undefined
        },
      ]
      for (const scope of scopes) {
        const hmr = scope() as { executing?: { exit?: (cb: () => unknown) => unknown } } | undefined
        const exit = (hmr?.executing as { exit?: unknown } | undefined)?.exit
        if (typeof exit === 'function') return exit.bind(hmr!.executing) as (cb: () => unknown) => unknown
      }
    } catch { /* hmr service absent or Cordis proxy guard — plain mutate */ }
    return undefined
  }
  const probeHmr = (): Record<string, unknown> => {
    try {
      return { result: resolveHmrExit() === undefined ? 'undefined' : 'ok-exit' }
    } catch (error) {
      return { result: 'threw', error: error instanceof Error ? error.message : String(error) }
    }
  }
  /**
   * v0.17.2: the live auto-recommend returned degraded on its first firing
   * (write-refused status:'degraded' — the v0.17.1 build has no reason-level
   * diag). Prime suspect: `ctx.llm` is read as a CONTEXT PROPERTY by
   * probeCatalogOptions (still the catalog source in v0.18.2, and
   * validatePickEfforts' resolveModelInfo seam), and the entry-scoped ctx
   * handed to loader/volatile-update may not carry the host's llm service —
   * the same composition-layer class as the v0.17.1 settings gap. Probe both
   * scopes into the boot diag and resolve a face for the catalog probe with
   * a root fallback; the probe only ever touches `ctx.llm`, so a wrapper
   * context `{ llm }` is a complete substitute when the entry scope is bare.
   * v0.18.2: no one-shot LLM call remains anywhere in the auto flow — the
   * face is used to LIST models only, never to run a completion.
   */
  const probeLlm = (scope: string): Record<string, unknown> => {
    try {
      const scopeCtx = scope === 'root' ? (ctx as { root?: unknown }).root : ctx
      const llm = (scopeCtx as { llm?: unknown } | null | undefined)?.llm
      if (llm === undefined || llm === null) return { scope, result: 'undefined' }
      const face = llm as { prepareCall?: unknown; listProviders?: unknown }
      return { scope, result: typeof face.prepareCall === 'function' && typeof face.listProviders === 'function' ? 'ok' : 'partial' }
    } catch (error) {
      return { scope, result: 'threw', error: error instanceof Error ? error.message : String(error) }
    }
  }
  const resolveLlmFace = (): unknown => {
    try {
      const direct = (ctx as { llm?: unknown } | null | undefined)?.llm
      if (direct !== undefined && direct !== null) return direct
    } catch { /* Cordis proxy guard — fall through */ }
    try {
      const rootLlm = ((ctx as { root?: unknown })?.root as { llm?: unknown } | undefined)?.llm
      if (rootLlm !== undefined && rootLlm !== null) return rootLlm
    } catch { /* Cordis proxy guard — give up */ }
    return undefined
  }
  presetDiag({
    event: 'boot',
    seededPlan: lastHandledPresetPlan,
    presetPlanBinding: typeof config.presetPlan === 'object' && config.presetPlan !== null && typeof (config.presetPlan as { get?: unknown }).get === 'function' ? 'ref' : typeof config.presetPlan,
    ctxOn: typeof ctx.on,
    hmr: probeHmr(),
    llm: [probeLlm('entry'), probeLlm('root')],
    settings: [probeSettings('entry'), probeSettings('root')],
  })
  const settingsMutate = (): ((ns: string, ops: unknown[], expectedRevision?: number) => Promise<unknown>) | undefined => {
    let bound: ((ns: string, ops: unknown[], expectedRevision?: number) => Promise<unknown>) | undefined
    let scopeLabel = ''
    const scopes: Array<{ label: string; get: (() => unknown) | undefined }> = [
      { label: 'entry', get: typeof ctx.get === 'function' ? () => ctx.get('settings') : undefined },
      { label: 'root', get: typeof (ctx as { root?: unknown }).root === 'object' && typeof ((ctx as { root?: { get?: unknown } }).root as { get?: unknown })?.get === 'function' ? () => (ctx as { root: { get: (name: string) => unknown } }).root.get('settings') : undefined },
    ]
    for (const scope of scopes) {
      if (scope.get === undefined) continue
      try {
        const settings = scope.get()
        if (settings && typeof (settings as { mutate?: unknown }).mutate === 'function') {
          bound = (settings as { mutate: (ns: string, ops: unknown[], expectedRevision?: number) => Promise<unknown> }).mutate.bind(settings)
          scopeLabel = scope.label
          break
        }
      } catch { /* service absent or Cordis proxy guard — try the next scope */ }
    }
    if (bound === undefined) {
      presetDiag({ event: 'settings-unavailable', probed: [probeSettings('entry'), probeSettings('root')] })
      return undefined
    }
    const hmrExit = resolveHmrExit()
    presetDiag({ event: 'settings-resolved', scope: scopeLabel, hmr: hmrExit === undefined ? 'plain' : 'exit' })
    if (hmrExit === undefined) return bound
    return (ns: string, ops: unknown[], expectedRevision?: number) => {
      try {
        return Promise.resolve(hmrExit(() => bound!(ns, ops, expectedRevision)))
      } catch (error) {
        // Belt and braces: if the exit escape itself throws synchronously,
        // fall back to the plain call (v0.17.1 behavior) so the outcome is at
        // least attempted — and observe the fallback in the diag.
        presetDiag({ event: 'write-escape-fallback', error: error instanceof Error ? error.message : String(error) })
        return bound!(ns, ops, expectedRevision)
      }
    }
  }
  const warnOf = (message: string, error?: unknown): void => {
    try {
      const logger = (ctx as { logger?: { warn?: (m: string, e?: unknown) => void } }).logger
      logger?.warn?.(message, error)
    } catch { /* logging must never throw */ }
  }
  /**
   * (v0.25.5) writePresetRecord: ONE atomic settings mutate — the six-field
   * ops (or none for record-only outcomes) plus the outcome record. This is
   * the settings-CARD path only: the `/cybernetics use` subcommand no longer
   * routes through here at all (v0.25.5 user ruling: use is session-only,
   * zero settings writes — see src/sessionRoles.ts), so no extraOps channel
   * remains and no presetPlan op is ever written from the plugin.
   */
  const writePresetRecord = async (ops: SettingsOp[], record: PresetRecommendationRecord): Promise<boolean> => {
    const mutate = settingsMutate()
    if (mutate === undefined) {
      warnOf(`cybernetics: preset plan "${record.preset}" resolved but the settings service is unavailable — the outcome (${record.status}) could not be written to the card`)
      presetDiag({ event: 'write-skipped', preset: record.preset, status: record.status, reason: 'settings service unavailable' })
      return false
    }
    const allOps = [...ops, { op: 'set', path: ['presetRecommendation'], value: formatRecommendationRecord(record) }]
    try {
      await mutate(SETTINGS_NAMESPACE, allOps, undefined)
      presetDiag({ event: 'write-ok', preset: record.preset, status: record.status, ops: ops.length + 1 })
      return true
    } catch (error) {
      warnOf(`cybernetics: preset plan "${record.preset}" write refused by the settings service`, error)
      presetDiag({ event: 'write-refused', preset: record.preset, status: record.status, error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }
  const readCurrentOverrides = (): RolesConfig => {
    const overrides: RolesConfig = {}
    for (const [roleKey, field] of [['default', 'taskAgentModel'], ['verify', 'verifyAgentModel'], ['triage', 'triageAgentModel']] as const) {
      const spec = parseAgentModelSpec(readConfigField(config[field] as unknown as string, ''))
      if (spec) overrides[roleKey] = spec
    }
    return overrides
  }
  const recordOf = (preset: string, patch: Partial<PresetRecommendationRecord>): PresetRecommendationRecord => ({
    status: 'ok', preset, label: presetChoiceLabel(preset), at: new Date().toISOString(), ...patch,
  })
  /**
   * The record every applied outcome carries for the card's session-scope
   * note: the session agent is user-managed — neither presets nor the auto
   * recommendation touch it (ops builders are structurally limited to the
   * six flat sub-agent fields; src/modelPresets.ts ALLOWED_OP_PATHS).
   */
  const SESSION_SCOPE_NOTE = 'session 由用户自行管理，方案不应用此项'
  /** The handoff note carried by the pending record + the session message (v0.18.2). */
  const PRESET_HANDOFF_NOTE = '已交办 session agent：请在本会话中让 session agent 调用 preset_recommend 工具完成推荐（第一跳取目录与要求，第二跳提交推荐 JSON）；插件不再发起任何独立 LLM 调用。'
  /**
   * v0.18.2: the message delivered into a live session agent's inbox when
   * the user selects auto. Same zero-dependency message shape and
   * steer/followup split as notifyRoundSettled (running → next-step steer,
   * idle → next-turn followup wake). Source kind 'cybernetics' — the
   * inbox-inserted relay treats it as plugin traffic (never relocated as
   * user input).
   */
  const deliverPresetHandoff = (): number => {
    let roots: any[] = []
    try { roots = ((ctx as { agents?: { roots?: () => unknown[] } }).agents?.roots?.() ?? []) as any[] } catch { roots = [] }
    let delivered = 0
    const message = () => ({
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text:
          '<cybernetics_preset>\n用户在设置卡片选择了「根据现有配置自动推荐」（预置方案）。\n' +
          '请不要为此发起任何独立 LLM 调用，也不要新起任何子 agent：直接调用 preset_recommend 工具（不带 recommendation 参数）获取实时模型目录、分配原则与当前角色配置，' +
          '在自己的上下文中给出 task/verify/triage 的选择，然后再次调用 preset_recommend 并把推荐 JSON 传入 recommendation 参数提交。\n' +
          '插件会校验（逐字命中目录、effort 支持性）并写入 task/verify/triage 的模型与思考强度字段。\n</cybernetics_preset>',
      }],
      source: { kind: 'cybernetics', preset: 'auto' },
    })
    for (const agent of roots) {
      try {
        // Delegated children are out of scope (defensive: roots() should
        // already exclude them) — only top-level session agents answer.
        if (agent?.session?.header?.parentSession !== undefined) continue
        if (agent?.status === 'running' && typeof agent.steer === 'function') agent.steer(message())
        else if (typeof agent.followup === 'function') agent.followup(message())
        else continue
        delivered++
      } catch { /* best-effort delivery: the pending record + the tool stay usable */ }
    }
    presetDiag({ event: 'preset-handoff', roots: roots.length, delivered })
    return delivered
  }
  const handlePresetSelection = async (plan: string): Promise<void> => {
    try {
      if (plan === PRESET_AUTO_ID) {
        // v0.18.2 handoff flow (user ruling 2026-11-06: no independent LLM
        // call, no spawned agent — the session agent answers in its own
        // context). Prefer the entry-scoped llm face, fall back to the root
        // scope when the entry ctx is bare (probeCatalogOptions/
        // validatePickEfforts only touch `ctx.llm`, so `{ llm }` is a
        // complete substitute context).
        const llmFace = resolveLlmFace()
        const llmCtx = llmFace !== undefined ? { llm: llmFace } : ctx
        const currentOverrides = readCurrentOverrides()
        const probe = await probeCatalogOptions(llmCtx)
        const brief = buildRecommendationBrief({ options: probe.options, currentOverrides })
        presetDiag({
          event: 'recommend-outcome',
          status: brief.ok ? 'pending' : 'degraded',
          catalogSize: brief.catalogSize,
          ...(brief.ok ? {} : { reason: brief.reason }),
          briefChars: brief.text?.length ?? 0,
        })
        if (!brief.ok) {
          // Empty/unavailable catalog: degrade exactly like the old flow —
          // a written record, no model field touched, nothing pending.
          await writePresetRecord([], recordOf(PRESET_AUTO_ID, {
            status: 'degraded',
            catalogSize: 0,
            reason: brief.reason,
          }))
          return
        }
        // The pending record is the card-visible state; the handoff message
        // tells the live session agent(s) to answer through the tool. Both
        // are best-effort: the tool remains usable even if either fails.
        await writePresetRecord([], recordOf(PRESET_AUTO_ID, {
          status: 'pending',
          catalogSize: brief.catalogSize,
          reason: PRESET_HANDOFF_NOTE,
        }))
        deliverPresetHandoff()
        return
      }
      // v0.19 custom presets (自定义方案): `custom:<id>` resolves against the
      // `customPresets` config field (the user-saved combinations). The entry
      // is adapted into the VendorPreset shape so vendorPresetApplyOps builds
      // the SAME six-field-bounded ops the built-ins use (session scope holds
      // structurally: the ops builders read task/verify/triage exclusively).
      if (isCustomPresetId(plan)) {
        const entryId = customPresetEntryId(plan)
        let list: CustomPreset[] = []
        try {
          list = parseCustomPresets(readConfigField(config.customPresets, ''))
        } catch { /* defensive: readConfigField face absent → treat as empty */ }
        const entry = list.find((p) => p.id === entryId)
        if (entry === undefined) {
          warnOf(`cybernetics: custom preset plan "${plan}" not found in customPresets — ignored`)
          await writePresetRecord([], recordOf(plan, {
            status: 'degraded',
            label: entryId,
            reason: '自定义方案不存在（可能已被删除），未应用任何更改',
          }))
          return
        }
        const appliedCustom = vendorPresetApplyOps(customPresetAsVendor(entry))
        const customRoles = appliedCustom.variant !== undefined ? appliedCustom.variant.roles : entry.roles
        const customPicks: Record<string, string> = {}
        const customEfforts: Record<string, string> = {}
        for (const roleKey of ['task', 'verify', 'triage'] as const) {
          const spec = customRoles[roleKey]
          if (!spec || (!spec.provider && !spec.model)) continue
          customPicks[roleKey] = spec.provider ? `${spec.provider}/${spec.model}` : String(spec.model)
          customEfforts[roleKey] = spec.reasoningEffort ?? ''
        }
        await writePresetRecord(appliedCustom.ops, recordOf(plan, {
          label: entry.name,
          picks: customPicks,
          efforts: customEfforts,
          notes: [SESSION_SCOPE_NOTE, '自定义方案：应用用户保存的组合（保存于设置卡片）'],
        }))
        return
      }
      const preset = presetById(plan)
      if (preset === undefined) {
        warnOf(`cybernetics: unknown preset plan "${plan}" — ignored`)
        return
      }
      const applied = vendorPresetApplyOps(preset)
      if (!applied.ready) {
        await writePresetRecord([], recordOf(plan, {
          status: 'placeholder',
          reason: '厂商方案为占位条目（模型组合待填充），本次选择仅记录、未更改任何模型配置',
        }))
        return
      }
      // picks/efforts render from the applied VARIANT's roles (models only);
      // the session suggestion never enters either record or ops — the ops
      // builders read task/verify/triage exclusively.
      const roles = applied.variant !== undefined ? applied.variant.roles : preset.roles
      const picks: Record<string, string> = {}
      const efforts: Record<string, string> = {}
      for (const roleKey of ['task', 'verify', 'triage'] as const) {
        const spec = roles[roleKey]
        if (!spec || (!spec.provider && !spec.model)) continue
        picks[roleKey] = spec.provider ? `${spec.provider}/${spec.model}` : String(spec.model)
        efforts[roleKey] = spec.reasoningEffort ?? ''
      }
      const variantLabels = Array.isArray(preset.variants) ? preset.variants.map((v) => v?.label ?? v?.id ?? '') : []
      const otherVariants = applied.variant !== undefined
        ? variantLabels.filter((label) => label !== '' && label !== applied.variant!.label)
        : []
      await writePresetRecord(applied.ops, recordOf(plan, {
        picks,
        efforts,
        ...(applied.variant !== undefined ? { variant: applied.variant.label } : {}),
        ...(otherVariants.length > 0 ? { otherVariants } : {}),
        notes: [
          SESSION_SCOPE_NOTE,
          ...(applied.variant?.session && (applied.variant.session.provider || applied.variant.session.model)
            ? [`session 参考（未应用）：${[applied.variant.session.provider, applied.variant.session.model].filter(Boolean).join('/')}`]
            : []),
          ...(preset.note !== undefined ? [preset.note] : []),
          ...(preset.source !== undefined ? [`来源：${preset.source}`] : []),
        ],
      }))
    } catch (error) {
      // Belt and braces (the handoff flow is designed not to throw): record
      // the degradation so the card shows WHY nothing was applied.
      await writePresetRecord([], recordOf(plan, {
        status: 'degraded',
        reason: `预置方案处理异常：${error instanceof Error ? error.message : String(error)}`,
      }))
    }
  }
  ctx.on?.('loader/volatile-update', () => {
    let plan: string
    try {
      plan = readConfigField(config.presetPlan, '')
    } catch { return }
    const willHandle = plan !== lastHandledPresetPlan && plan !== ''
    presetDiag({ event: 'volatile-update', plan, lastHandled: lastHandledPresetPlan, willHandle })
    if (plan === lastHandledPresetPlan) return
    lastHandledPresetPlan = plan
    if (plan === '') return
    void handlePresetSelection(plan)
  })



  // --- v0.9.0 input-policy relay (outer-loop control insertion) -------------
  // DSH native behavior (researched in @deepseek-ai/dsh-api-session-controller
  // lib/index.js prompt()/updateQueue): the BROWSER decides the delivery mode
  // from the user setting `ui-conversation.busyEnter` (default 'queue') and
  // the server calls agent.steer (next-step) or agent.followup (next-turn)
  // accordingly; prompt() has no server-side extension point, but the loop
  // emits `agent/inbox/inserted` on every admission (the seam
  // dsh-goal-round-driver also uses), and api-session-controller's own
  // updateQueue 'steer' action shows the sanctioned relocation API:
  // inbox.remove(id) + agent.steer(message). This listener reuses exactly
  // that pair — it does not touch the decision path, it only relocates an
  // already-queued next-turn USER input to next-step, and ONLY when the
  // session's cybernetics enablement is effective-on. Every other session
  // (override off, or global allGoalsMode false with no override) returns
  // before any mutation: the native queue behavior is untouched.
  const inputDisposer = ctx.on?.('agent/inbox/inserted', (payload: any) => {
    const agent = payload?.agent
    const message = payload?.message
    if (agent?.inbox === undefined || message?.id === undefined) return
    // Delegated children (workflow subagents, team members) are out of scope:
    // cybernetics governs the top-level session conversation only.
    if (agent?.session?.header?.parentSession !== undefined) return
    // Non-cybernetics sessions: zero intervention, native behavior preserved.
    if (!enabledFor(agent.session)) return
    // Act only on messages this deployment relocates: user prompts under
    // inputPolicy='insert' (outer-loop control insertion, v0.9.0) and our own
    // inner-loop round-settled notices under noticePolicy='insert' (v0.13.0).
    // Next-step re-insertions of an already relocated message fall through the
    // nextTurn membership check below, which also prevents recursion.
    const sourceKind = message?.source?.kind
    const isUserInput =
      sourceKind === 'user' && readConfigField(config.inputPolicy, 'insert') === 'insert'
    const isRoundNotice =
      sourceKind === 'cybernetics' && readConfigField(config.noticePolicy, 'insert') === 'insert'
    if (!isUserInput && !isRoundNotice) return
    // Only a RUNNING agent actually queues behind the current turn; an idle
    // agent wakes on the very followup, so relocation is a no-op there.
    if (agent.status !== 'running') return
    if (!agent.inbox.nextTurn?.some((m: any) => m?.id === message.id)) return
    try {
      if (!agent.inbox.remove(message.id)) return
      agent.steer(message)
    } catch (error) {
      // Relocation is an optimization, never a correctness requirement: on
      // any race (claimed between the event and removal) the message stays
      // wherever the native path put it.
      const logger = (ctx as { logger?: { warn?: (m: string, e: unknown) => void } }).logger
      try { logger?.warn?.(`cybernetics: failed to steer queued input into session "${agent?.id}": %o`, error) } catch { /* observability only */ }
    }
  })
  if (typeof inputDisposer === 'function') disposers.push(inputDisposer)

  // --- v0.9.0 /cybernetics command (per-session on/off/status) --------------
  // Same registration shape as dsh-plan-mode's /plan (ctx.inject(['commands'])
  // child scope; handler executes directly without a model round-trip). The
  // override is one durable `cybernetics/mode` session event, so resume/fork
  // replay restores it.
  ctx.inject?.(['commands'], (commandCtx: any) => {
    // Dynamic input hint (v0.14.0): the descriptor registry carries a static
    // string per registration, so the hint is refreshed by re-registering the
    // command whenever the invoking session's effective mode flips — the
    // registry emits `commands/change` on every layer mutation and the
    // client-side directory invalidates on that event, so the composer menu
    // picks up the new hint on its next open. `enabledFor` reads the live
    // session projection (and the volatile global fallback) at call time —
    // no mirrored/stale copy of the mode. Registration is global (one
    // descriptor for every session), so the advertised hint follows the most
    // recent mode change; a multi-session host may briefly show the other
    // session's hint until that session's own next /cybernetics invocation.
    const commandHint = (session: unknown): string =>
      enabledFor(session) ? '[off|status|use]' : '[on|status|use]'
    let commandDisposer: (() => void) | undefined
    const handler = (invocation: any) => {
      const agent = invocation?.agent
      const session = agent?.session
      if (session === undefined || typeof session.append !== 'function') {
        return { kind: 'error' as const, text: 'cybernetics: 会话不可用，无法写入模式事件。' }
      }
      // Case-insensitive subcommand dispatch (v0.9.0); the `use` preset id
      // keeps its original case — custom preset ids are user-chosen and
      // case-sensitive (`custom:<id>` matches the customPresets entry verbatim).
      const rawInput = (invocation.rawInput ?? '').trim()
      const arg = rawInput.toLowerCase()
      const override = modeOverrideOf(ctx, session)
      const globalOn = allGoalsMode()
      if (arg === 'on' || arg === 'off') {
        try {
          // v0.13.1: the mode override travels as an ignorable plugin record
          // (`plugin:cybernetics/mode`). The plain `session.append` call the
          // v0.9.0 path used persisted the type unmarked, which fail-closes
          // the whole session on any harness build that does not know it.
          appendModeRecord(session, MODE_EVENT_TYPE, { enabled: arg === 'on' })
        } catch (error) {
          return { kind: 'error' as const, text: `cybernetics: 写入会话模式失败：${String(error)}` }
        }
        // The effective mode just flipped: re-advertise the command so the
        // input hint offers the subcommands meaningful in the new state.
        // Redundant on/off stays accepted above — the hint narrows the
        // display, never the accepted grammar.
        try { registerCommand(session) } catch { /* hint refresh is cosmetic, never load-bearing */ }
        return {
          kind: 'success' as const,
          text: arg === 'on'
            ? 'cybernetics 控制已对本会话开启（ALL-GOALS 路由 + 硬门禁 + 新输入外环插入）。覆盖全局配置；/cybernetics off 可关闭。'
            : 'cybernetics 控制已对本会话关闭：不再注入控制 guidance，硬门禁放行，新输入回归 DSH 原生行为。/cybernetics on 可恢复。',
        }
      }
      // --- `use` subcommand (v0.22.0; v0.25.5 session-only, user ruling
      // 2026-11-11): switch the role composition (task/verify/triage model +
      // reasoning effort) for THIS SESSION to any preset plan — the built-in
      // registry ids (PRESET_IDS) or a user-saved custom preset
      // (`custom:<id>`), or `use off` to clear. ZERO settings writes: the
      // resolved picks land in the in-memory per-session override store
      // (src/sessionRoles.ts), which the round-dispatch read point folds in
      // with "session override > global fields" precedence. The host's
      // write-gate defect (v0.7.10, dual-module Include instance) is therefore
      // irrelevant here, and the settings-card dropdown / global fields stay
      // exactly where the card left them.
      if (arg === 'use' || arg.startsWith('use ')) {
        const planArg = rawInput.slice(3).trim()
        const sessionKey = sessionRolesKeyOf(agent)
        const listPlans = (): string[] => {
          const lines = PRESET_IDS.map((id) => `- ${id}：${presetChoiceLabel(id)}`)
          try {
            for (const p of parseCustomPresets(readConfigField(config.customPresets, ''))) {
              lines.push(`- custom:${p.id}：${p.name}（自定义方案）`)
            }
          } catch { /* readConfigField face absent → built-ins only */ }
          return lines
        }
        if (planArg === '') {
          // No argument: plain-text listing (the command channel has no
          // picker UI); the user confirms with a second invocation.
          const current = getSessionRolesOverride(sessionKey)
          return {
            kind: 'success' as const,
            text:
              'cybernetics 可用预置方案：\n' + listPlans().join('\n') +
              (current ? `\n当前会话覆盖：${current.label}（${formatSessionRolesOverride(current)}）` : '') +
              '\n再次输入 /cybernetics use <id> 应用其中一个方案；/cybernetics use off 清除会话覆盖。',
          }
        }
        // Clear: back to the global fields for this session.
        if (planArg === 'off') {
          const had = clearSessionRolesOverride(sessionKey)
          presetDiag({ event: 'use-session-apply', preset: '', label: '', cleared: true, had })
          return {
            kind: 'success' as const,
            text: had
              ? 'cybernetics: 已清除本会话的预置方案覆盖，回到全局配置（下一轮 goal 生效）。'
              : 'cybernetics: 本会话当前没有预置方案覆盖（一直跟随全局配置）。',
          }
        }
        const isCustom = isCustomPresetId(planArg)
        const customEntryExists = isCustom && (() => {
          try {
            return parseCustomPresets(readConfigField(config.customPresets, '')).some((p) => p.id === customPresetEntryId(planArg))
          } catch { return false }
        })()
        const known = isCustom ? customEntryExists : (planArg === PRESET_AUTO_ID || presetById(planArg) !== undefined)
        if (!known) {
          return {
            kind: 'error' as const,
            text:
              `cybernetics: 未知预置方案 "${planArg}"。可用 id：\n` + listPlans().join('\n') +
              '\n输入 /cybernetics use <id> 应用其中一个方案。',
          }
        }
        if (planArg === PRESET_AUTO_ID) {
          // Session-only auto: mark this session pending and hand the brief to
          // THIS session's agent (the preset_recommend tool hop 1), whose hop-2
          // answer lands in the session override instead of the global fields.
          // The settings card path (dropdown auto) is untouched.
          setSessionAutoPending(sessionKey)
          try {
            const target = agent as { status?: string; steer?: (m: unknown) => void; followup?: (m: unknown) => void }
            const message = {
              id: randomUUID(),
              role: 'user',
              content: [{
                type: 'text',
                text:
                  '<cybernetics_preset>\n用户通过 /cybernetics use auto 请求本会话的预置方案自动推荐（仅本会话生效，不修改全局配置）。\n' +
                  '请直接调用 preset_recommend 工具（不带 recommendation 参数）获取实时模型目录与推荐要求，' +
                  '在自己的上下文中给出 task/verify/triage 的选择，然后再次调用 preset_recommend 并把推荐 JSON 传入 recommendation 参数提交。\n' +
                  '本次提交将应用为本会话的角色覆盖。\n</cybernetics_preset>',
              }],
              source: { kind: 'cybernetics', preset: 'auto', scope: 'session' },
            }
            if (target?.status === 'running' && typeof target.steer === 'function') target.steer(message)
            else if (typeof target.followup === 'function') target.followup(message)
          } catch { /* best-effort: the tool remains callable from context */ }
          presetDiag({ event: 'use-session-apply', preset: PRESET_AUTO_ID, label: presetChoiceLabel(PRESET_AUTO_ID), phase: 'pending-handoff' })
          return {
            kind: 'success' as const,
            text:
              `cybernetics: 已交办本会话的预置方案自动推荐（${presetChoiceLabel(PRESET_AUTO_ID)}）。` +
              'preset_recommend 的推荐结果将仅应用为本会话的 task/verify/triage 覆盖；不修改全局配置。',
          }
        }
        // Built-in vendor plan or user-saved custom plan: resolve the roles
        // and store them as the session override (no settings mutate at all).
        let overrideRoles: Partial<Record<'task' | 'verify' | 'triage', { provider?: string; model?: string; reasoningEffort?: string }>> = {}
        let overrideLabel = planArg
        let placeholder = false
        if (isCustom) {
          const entryId = customPresetEntryId(planArg)
          let entry
          try {
            entry = parseCustomPresets(readConfigField(config.customPresets, '')).find((p) => p.id === entryId)
          } catch { entry = undefined }
          if (entry === undefined) {
            return { kind: 'error' as const, text: `cybernetics: 自定义方案 "${planArg}" 不存在（可能已被删除），未应用任何更改。` }
          }
          const appliedCustom = vendorPresetApplyOps(customPresetAsVendor(entry))
          overrideRoles = (appliedCustom.variant !== undefined ? appliedCustom.variant.roles : entry.roles) as typeof overrideRoles
          overrideLabel = entry.name
        } else {
          const preset = presetById(planArg)!
          const applied = vendorPresetApplyOps(preset)
          if (!applied.ready) placeholder = true
          else overrideRoles = (applied.variant !== undefined ? applied.variant.roles : preset.roles) as typeof overrideRoles
          overrideLabel = presetChoiceLabel(planArg)
        }
        if (placeholder) {
          return {
            kind: 'error' as const,
            text: `cybernetics: 预置方案 "${planArg}" 为占位条目（模型组合待填充），本次未应用任何更改。`,
          }
        }
        setSessionRolesOverride(sessionKey, {
          preset: planArg,
          label: overrideLabel,
          roles: overrideRoles,
          appliedAt: new Date().toISOString(),
        })
        presetDiag({
          event: 'use-session-apply',
          preset: planArg,
          label: overrideLabel,
          picks: overrideRoles,
          cleared: false,
        })
        return {
          kind: 'success' as const,
          text:
            `已在本会话应用预置方案 "${overrideLabel}"：${formatSessionRolesOverride({ preset: planArg, label: overrideLabel, roles: overrideRoles, appliedAt: '' })}；` +
            '仅本会话生效（会话结束失效），不修改全局配置。/cybernetics use off 可清除覆盖、回到全局配置。',
        }
      }
      // No argument (or unknown text) = status report.
      const effective = override === null ? globalOn : override
      const overrideText = override === null ? '未设置（遵循全局配置）' : override ? 'on' : 'off'
      const sessionOverride = getSessionRolesOverride(sessionRolesKeyOf(agent))
      const sessionOverrideText = sessionOverride === undefined
        ? '无（跟随全局配置）'
        : `${sessionOverride.label}（${formatSessionRolesOverride(sessionOverride)}）— 清除：/cybernetics use off` +
          (peekSessionAutoPending(sessionRolesKeyOf(agent)) ? '；auto 推荐待提交（preset_recommend）' : '')
      return {
        kind: 'success' as const,
        text:
          `cybernetics 本会话状态：${effective ? '生效' : '关闭'}\n` +
          `- 会话 override：${overrideText}\n` +
          `- 会话预置方案覆盖：${sessionOverrideText}\n` +
          `- 全局 allGoalsMode：${globalOn ? 'on' : 'off'}\n` +
          `- 硬门禁 hardGate：${hardGate() ? (resolveGateMode(config, true) === 'allowlist' ? 'on（allowlist）' : 'on（denylist）') : 'off'}\n` +
          `- 新输入策略 inputPolicy：${readConfigField(config.inputPolicy, 'insert')}\n` +
          `- 轮完成通知策略 noticePolicy：${readConfigField(config.noticePolicy, 'insert')}\n` +
          `用法：/cybernetics on | /cybernetics off | 无参数或 status = 显示状态 | /cybernetics use [方案id] = 应用预置方案（仅本会话生效；无参数列出全部可用方案；use off 清除覆盖）`,
      }
    }
    const registerCommand = (session: unknown): void => {
      try {
        if (typeof commandDisposer === 'function') commandDisposer()
      } catch { /* a failed unregister must not block the re-register below */ }
      commandDisposer = commandCtx.commands.register({
        name: 'cybernetics',
        description: 'Toggle cybernetics control loop (ALL-GOALS routing + hard gate) for THIS session; no argument shows status; `use [id]` applies a preset plan (no id lists all)',
        input: { hint: commandHint(session) },
        handler,
      })
    }
    // Initial advertisement: no session context yet, so the hint follows the
    // profile-global allGoalsMode (enabledFor(undefined) resolves to it).
    registerCommand(undefined)
    disposers.push(() => {
      try { if (typeof commandDisposer === 'function') commandDisposer() } catch { /* idempotent teardown */ }
    })
  })

  const disposer = (ctx.tools as { register: (d: unknown) => () => void }).register({
    name: toolName,
    description:
      'Goal-driven control loop for the SESSION agent, which never executes task work itself: it manages ' +
      'goals and the independent task agents that execute them. Actions: round (default, blocking) runs one ' +
      'full round (task agent -> verify agent -> triage agent) and returns the controller decision; start ' +
      'launches the round in the background and returns immediately (a completion notice is auto-inserted ' +
      'into this session when it settles — next-step while running, next-turn wake while idle); collect ' +
      'folds a finished background round into its decision; cancel aborts a running round ' +
      '(use when a user correction must interrupt the current task agent); list shows every goal on this ' +
      'session board. New task: pass title + brief (a complete, self-contained work order — the task agent ' +
      'has NO conversation history) to create a goal; one session supports multiple concurrent goals. ' +
      'revise is the ONLY goal-change verb and it is append-only: it creates a NEW goal (parentGoalId = old ' +
      'goal, inherited depth/executor/role/objective unless overridden), starts that goal\'s first round, and ' +
      'marks the old goal superseded (supersededBy = new goal) — it never rewrites the objective in place. ' +
      'Existing goal: pass its goalId. The controller never marks a goal complete — that is the user\'s act. ' +
      'When the deployment enables smartAgentModelSelection, every round auto-assigns each role (task/verify/' +
      'triage) a model from the live system model catalog by task shape — trivial work on light models, hard ' +
      'work on the top tier; explicitly configured role models always win, and the round result/audit carries ' +
      'a smartSelection trail naming every decision (selected or kept-inherit, with the reason).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['round', 'start', 'collect', 'cancel', 'revise', 'list'],
          description: 'round=同步执行一轮（默认）| start=后台启动一轮并立即返回 | collect=折叠已完成的后台轮 | cancel=中止正在运行的轮（修正场景）| revise=追加式修正：为新目标建新 goal 并启动第 1 轮，旧 goal 置 superseded | list=查看本会话全部 goal。',
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
        depth: {
          type: 'string',
          enum: ['quick', 'full'],
          description:
            '本轮深度：quick=轻量分析，只跑 task agent 单 agent 一轮出结果直接反馈（跳过 verify/triage）；' +
            'full=完整工作-验证循环（默认）——复杂分析（取数/下载/统计/多步查询规划）与一切变更类任务必须用 full。',
        },
        role: {
          type: 'string',
          description: '本轮 task agent 的角色（对应部署配置 roles 表，如 frontend/backend/writer）；缺省 default。',
        },
        reason: {
          type: 'string',
          description:
            'revise 必填：修订原因（写进 .cybernetics/revisions-<新goalId>.jsonl 审计，并向用户解释为什么换目标）。',
        },
        objective: {
          type: 'string',
          description: 'revise：新 goal 的目标文本；缺省继承旧 goal 的 objective（用于「目标本身被校准」的修订）。',
        },
        abortPrevious: {
          type: 'boolean',
          description:
            'revise：是否中止旧 goal 正在运行的 task agent 轮。缺省时按决策树自动判断（查 goal 板：旧轮在跑且目标被改写→自动中止；旧轮在跑但目标不变→等待自然结束；旧轮未跑→直启）；' +
            '显式传 true/false 保持人工控制（true 复用 cancel 路径）。',
        },
        executor: {
          type: 'string',
          enum: ['ephemeral', 'persistent'],
          description: 'revise：新 goal 的执行者基质，缺省继承旧 goal（当前均为 ephemeral）。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          goalId: { type: 'string' },
          previousGoalId: { type: 'string' },
          revised: { type: 'boolean' },
          abort: { type: 'object' },
          revision: { type: 'object' },
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
        if (value.revised) {
          return [{
            type: 'text',
            text:
              `goal ${value.previousGoalId} 已置 superseded → 新 goal ${value.goalId}` +
              `（修订自 ${value.previousGoalId}${value.aborted ? '，旧轮已中止' : ''}）；` +
              `新 goal 第 ${value.round} 轮已后台启动，完成后将通知本会话`,
          }]
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
      action?: 'round' | 'start' | 'collect' | 'cancel' | 'revise' | 'list'
      goalId?: string
      title?: string
      brief?: string
      subgoal?: string
      depth?: 'quick' | 'full'
      role?: string
      reason?: string
      objective?: string
      abortPrevious?: boolean
      executor?: 'ephemeral' | 'persistent'
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

      const sessionId = typeof parent.session?.id === 'string' && parent.session.id.length > 0
        ? parent.session.id
        : undefined
      const board = boards.get(parent.session) ?? new Map<string, LoopState>()
      boards.set(parent.session, board)

      // v0.6 write point: publish the session's WHOLE board as one
      // `cybernetics/goals` event, so the「目标」tab tracks every goal of this
      // session (dsh-goal's single-slot `goal` projection cannot). Idempotent:
      // republishing an unchanged board appends nothing and never throws.
      // Then snapshot the same board to `<workspace>/.cybernetics/board-<id>.json`
      // so a restarted controller can rehydrate it (see loadBoardFile).
      const publishBoard = async (): Promise<void> => {
        // The workspace root is authoritative here (the working-directory
        // service resolved it); hand it to the projection so the one-shot
        // host-copy resolution record lands in `<workspace>/.cybernetics/`
        // even if a session header carries no cwd.
        if (typeof root === 'string' && root.length > 0) setPublishDebugRoot(root)
        publishGoals(parent.session, goalsFromBoard(board.values()))
        if (sessionId !== undefined && typeof root === 'string' && root.length > 0) {
          await saveBoardFile(root, sessionId, board.values())
        }
      }

      // v0.6 read point: first touch of a session after a host restart (empty
      // memory board). Restore the snapshot and republish it once, so the tab
      // shows the recovered history immediately instead of waiting for the next
      // round. A missing/corrupt/foreign snapshot leaves the board empty.
      if (board.size === 0 && sessionId !== undefined && typeof root === 'string' && root.length > 0) {
        const restored = await loadBoardFile(root, sessionId)
        if (restored !== undefined && restored.length > 0) {
          for (const restoredLoop of restored) {
            if (restoredLoop.goalId !== undefined) board.set(restoredLoop.goalId, restoredLoop)
          }
          await publishBoard()
        }
      }

      // 'list' needs no goal resolution and no workflow engine.
      if (action === 'list') {
        return {
          board: [...board.values()].map((g) => ({
            goalId: g.goalId, title: g.title, objective: g.objective, status: g.status ?? 'paused',
            running: running.has(g.goalId!), round: g.round, subgoal: g.subgoal,
            depth: g.depth ?? 'full',
            executor: g.executor ?? 'ephemeral',
            ...(g.memberName ? { memberName: g.memberName } : {}),
            ...(g.parentGoalId ? { parentGoalId: g.parentGoalId } : {}),
            ...(g.supersededBy ? { supersededBy: g.supersededBy } : {}),
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
      // 'revise' is excluded from the title branch: there `title` names the NEW
      // goal's title while the call targets the OLD goal.
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
      } else if (args.title && action !== 'revise') {
        // New task: create a registry goal. dsh-goal stays single-slot; when it
        // is free, focus the new goal into it (GUI tab + round-driver pickup).
        const goalId = `cyb-${randomUUID().slice(0, 8)}`
        const objective = args.brief ?? args.title
        loop = createGoal(undefined, {
          goalId,
          title: args.title,
          objective,
          ...(args.subgoal ? { subgoal: args.subgoal } : {}),
        })
        board.set(goalId, loop)
        // Goal creation is a projection write point: the tab gains the goal
        // immediately, before the first round settles.
        await publishBoard()
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

      // Per-call overrides. 'revise' is excluded from the brief override: the
      // call targets the OLD goal (which gets frozen as superseded below), so
      // writing the new work order onto it would pollute frozen history — the
      // revise branch assigns the brief to the successor goal itself.
      if (args.subgoal) loop.subgoal = args.subgoal
      if (args.brief && action !== 'revise') loop.brief = args.brief
      if (args.depth) loop.depth = args.depth
      if (args.executor) loop.executor = args.executor
      if (args.role) loop.role = args.role

      // A goal adopted from the dsh-goal focus slot joins the board here; make
      // it visible in the tab even when this call changes nothing else.
      await publishBoard()

      // Flat settings-panel model fields fold into the canonical roles shape:
      // an unset field leaves its role untouched = inherit the session agent.
      // All three fields are volatile (task/verify v0.7.7, triage v0.8.2), so
      // the loader hands back live references — unwrap through readConfigField
      // ('' = inherit) exactly like the allGoalsMode live ref above.
      // roles may be volatile (a live reference, pre-0.8.3 configs) or a plain
      // object (non-volatile since v0.8.4, configured via profile yaml) —
      // readConfigField handles both shapes: a live ref is unwrapped, a plain
      // object is returned as-is (hardGate and friends take the same path).
      const roleOverrides: RolesConfig = { ...readConfigField(config.roles, {} as RolesConfig) }
      const taskSpec = parseAgentModelSpec(readConfigField(config.taskAgentModel, ''))
      if (taskSpec) roleOverrides.default = { ...roleOverrides.default, ...taskSpec }
      const verifySpec = parseAgentModelSpec(readConfigField(config.verifyAgentModel, ''))
      if (verifySpec) roleOverrides.verify = { ...roleOverrides.verify, ...verifySpec }
      const triageSpec = parseAgentModelSpec(readConfigField(config.triageAgentModel, ''))
      if (triageSpec) roleOverrides.triage = { ...roleOverrides.triage, ...triageSpec }
      // v0.15: flat reasoning-effort fields fold into the same roles shape.
      // sanitizeReasoningEffort DROPS an invalid stored id (undefined = send
      // nothing = the model default applies) instead of forwarding corrupt
      // values; the settings card mirrors this by displaying the effective
      // (default) selection with a fallback note.
      const taskEffort = sanitizeReasoningEffort(readConfigField(config.taskAgentReasoningEffort, ''))
      if (taskEffort) roleOverrides.default = { ...roleOverrides.default, reasoningEffort: taskEffort }
      const verifyEffort = sanitizeReasoningEffort(readConfigField(config.verifyAgentReasoningEffort, ''))
      if (verifyEffort) roleOverrides.verify = { ...roleOverrides.verify, reasoningEffort: verifyEffort }
      const triageEffort = sanitizeReasoningEffort(readConfigField(config.triageAgentReasoningEffort, ''))
      if (triageEffort) roleOverrides.triage = { ...roleOverrides.triage, reasoningEffort: triageEffort }
      // v0.25.5 (user ruling 2026-11-11): a `/cybernetics use <id>` session
      // override wins over the global fields above — applied LAST, per role
      // and per field, so uncovered roles/fields keep the global value and a
      // session without `use` behaves exactly as before. In-memory only; the
      // global fields (and the settings card) are never read-modified here.
      const sessionOverride = getSessionRolesOverride(sessionRolesKeyOf(parent))
      const effectiveRoleOverrides = mergeSessionRolesOverride(roleOverrides, sessionOverride)

      // The session's durable objective, as a classification-input fallback
      // for targets that carry none (v0.16 smart selection reads it).
      const objective = loop.objective ?? goalView?.objective ?? loop.title ?? ''
      const controllerConfig: ControllerConfig = {
        roundScriptPath: config.roundScriptPath ?? fileURLToPath(new URL('../workflows/round.js', import.meta.url)),
        // Volatile schema fields surface as live references — unwrap per round
        // start so a settings-panel edit governs the next round (0/undefined
        // falls back to the controller's built-in default).
        roundsPerSubgoal: Math.max(1, Math.floor(readConfigField(config.roundsPerSubgoal, 3))),
        roles: effectiveRoleOverrides,
      }
      /**
       * v0.16 smart agent model selection — per LAUNCH, not per call. A
       * revise launches the successor goal, whose brief/objective/depth may
       * differ from the call's target loop, so the classification runs against
       * the target actually being started. When the volatile toggle is on:
       * probe the host's live model catalog (`ctx.llm`), classify the work
       * order (brief → subgoal → objective), and fill only the role rows that
       * carry NO explicit provider/model; every decision (selected, kept
       * explicit, kept inherit, skipped) lands in the returned config's
       * `smartSelection` audit, which startRound/startTeamRound hand to the
       * round script for the round record (.cybernetics/round-*.json).
       * probeCatalogOptions + computeSmartSelection never throw and never
       * block: any failure degrades to plain session-agent inheritance with
       * the fallback recorded. Feature off → controllerConfig verbatim.
       */
      const roundConfigFor = async (target: LoopState): Promise<ControllerConfig> => {
        if (readConfigField(config.smartAgentModelSelection, false) !== true) return controllerConfig
        try {
          const text = [
            target.brief, target.subgoal, target.objective ?? objective,
          ].filter((part) => typeof part === 'string' && part.trim().length > 0).join('\n')
          const catalog = await probeCatalogOptions(ctx)
          const { overrides, audit } = computeSmartSelection({
            text,
            depth: target.depth ?? 'full',
            executor: target.executor ?? 'ephemeral',
            taskRoleKey: target.role ?? 'default',
            explicit: effectiveRoleOverrides,
            options: catalog.options,
            session: sessionRouteOf(parent),
          })
          // The pure merge only produces rows for roles without explicit
          // provider/model, so spreading them over the folded config cannot
          // clobber an explicit value; a merged COPY keeps controllerConfig
          // (and effectiveRoleOverrides) untouched for the next launch.
          const roles: RolesConfig = { ...effectiveRoleOverrides }
          for (const [roleKey, spec] of Object.entries(overrides)) {
            if (spec) roles[roleKey] = { ...roles[roleKey], ...spec }
          }
          return { ...controllerConfig, roles, smartSelection: audit }
        } catch (error) {
          // Belt and braces (the pipeline is designed not to throw): record
          // the fallback so the round log stays truthful, keep the round.
          return {
            ...controllerConfig,
            smartSelection: {
              enabled: true, taskClass: 'standard', inputChars: 0, inputPreview: '',
              catalogSize: 0, catalogStatus: 'unavailable', roles: [],
              classifyError: error instanceof Error ? error.message : String(error),
            },
          }
        }
      }
      // Concurrent-round cap (0 = unlimited), read live at every launch.
      const maxConcurrentRounds = () => {
        const raw = Math.floor(readConfigField(config.maxConcurrentRounds, 0))
        return Number.isFinite(raw) && raw > 0 ? raw : 0
      }
      const concurrentCapError = () => {
        const cap = maxConcurrentRounds()
        return cap > 0 && running.size >= cap
          ? `cybernetics: 已有 ${running.size} 个运行中的轮，达到全局并行上限 ${cap}（可在设置面板调高 maxConcurrentRounds 或等待完成）`
          : undefined
      }
      /**
       * Brief visibility in tool results: without it the model cannot tell
       * whether a round was launched WITH a work order — the result looked
       * identical either way, and a briefless round silently sent the task
       * agent in with only objective/title (a no-feedback loop).
       */
      const briefWarning = (target: LoopState): { warning?: string } =>
        typeof target.brief === 'string' && target.brief.trim().length > 0
          ? {}
          : {
              warning:
                '该 goal 没有工作委托书（brief）：task agent 只能看到 objective/title。' +
                '复杂任务请用 cybernetics revise 补 brief（含背景、路径、验收标准）。',
            }
      // (`objective` moved above the v0.16 smart-selection fold — it feeds the
      // classification input; the value is identical.)

      /**
       * Start one round on the goal's chosen substrate. Ephemeral (default) is
       * the v0.5 workflow run; persistent uses an Agent Teams teammate that
       * survives across rounds. Both return the same run-like handle, so the
       * async/blocking/cancel paths below stay substrate-agnostic.
       */
      const startAnyRound = async (target: LoopState, signal?: AbortSignal): Promise<any> => {
        // v0.16: the round config (roles + smart-selection audit) is derived
        // per launch target; carried on the returned handle so the collect
        // path folds with exactly what was launched.
        const roundConfig = await roundConfigFor(target)
        if (target.executor === 'persistent') {
          // Soft probe: never read ctx.agentTeams directly here — Cordis throws
          // on an un-injected service property, which would surface as an
          // internal proxy error instead of "unsupported, use ephemeral".
          if (!teamExecutorAvailable(ctx)) throw teamExecutorUnavailableError()
          const teamHandle = await startTeamRound(ctx, parent, target, roundConfig, signal)
          return { ...teamHandle, config: roundConfig }
        }
        const started = await startRound(engine, parent, root, target, roundConfig, { objective: target.objective ?? '' }, signal)
        // v0.14 goal-agent tracking: correlate this run with the goal so the
        // workflow/agent-start|end listeners record its children on the board.
        linkRunToGoal((started.run as { id?: unknown })?.id, parent.session, target.goalId)
        return {
          round: started.round,
          result: started.run.result,
          cancel: (reason?: string) => started.run.cancel(reason),
          dispose: () => started.run.dispose(),
          run: started.run,
          config: roundConfig,
        }
      }

      /**
       * Start one goal's round in the background (action 'start' and `revise`
       * share this): install the handle, then deliver the completion notice.
       * The goal's status is already 'running' when this is called.
       */
      const launchBackground = async (target: LoopState): Promise<{ round: number }> => {
        const blocked = concurrentCapError()
        if (blocked) throw new Error(blocked)
        const controller = new AbortController()
        if (exec.signal) {
          if (exec.signal.aborted) controller.abort()
          else exec.signal.addEventListener('abort', () => controller.abort(), { once: true })
        }
        const started: any = await startAnyRound(target, controller.signal)
        const round = started.round as number
        const handle: RunningRound = { goalId: target.goalId!, round, parent, root, loop: target, config: (started.config as ControllerConfig) ?? controllerConfig, run: started }
        running.set(target.goalId!, handle)
        started.result.then(async (settled: any) => {
          handle.settled = settled
          // Superseded goal (revise with abortPrevious: false): the successor
          // carries the work from here — no collect notice, and release the run
          // so a finished-but-replaced round cannot leak the handle.
          if (target.supersededBy !== undefined) {
            if (running.get(target.goalId!) === handle) {
              running.delete(target.goalId!)
              await disposeOnce(handle)
            }
            return
          }
          notifyRoundSettled(parent, target, round, readConfigField(config.noticePolicy, 'insert'))
        }).catch(() => { /* result never rejects by contract; belt and braces */ })
        return { round }
      }

      // --- revise (append-only goal model) ------------------------------------
      // A goal change NEVER rewrites the objective in place: it creates a
      // successor goal (parentGoalId = old), starts that goal's first round, and
      // freezes the old goal as superseded (supersededBy = new). The session
      // agent decides whether the old goal's in-flight task agent is aborted.
      if (action === 'revise') {
        const previous = loop
        const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
        if (reason.length === 0) {
          throw new Error('cybernetics: action "revise" requires a non-empty "reason" — record why the goal changed')
        }
        if (previous.supersededBy !== undefined) {
          throw new Error(
            `cybernetics: goal "${previous.goalId}" was already superseded by "${previous.supersededBy}" — ` +
            'revise the successor goal instead of forking the lineage',
          )
        }
        // v0.7 abort policy: explicit abortPrevious keeps the v0.6 manual
        // semantics; when the caller omits it, all-goals mode auto-decides via
        // the decision tree (see decideAbort). With allGoalsMode off, the
        // omitted flag means false exactly as before (backward compat) and the
        // audit records that legacy default instead of a fabricated decision.
        const roundInFlight = running.has(previous.goalId!)
        const abortDecision = decideAbort(previous, roundInFlight, args)
        const legacyDefault = args.abortPrevious === undefined && !allGoalsMode()
        const effectiveAbort = legacyDefault
          ? { abort: false, mode: 'explicit' as const, basis: 'all-goals 模式未开启：abortPrevious 缺省沿用 v0.6 默认 false（不中止旧轮）' }
          : abortDecision
        const abortPrevious = args.abortPrevious !== undefined
          ? args.abortPrevious === true
          : (allGoalsMode() ? abortDecision.abort : false)
        const previousHandle = running.get(previous.goalId!)
        let aborted: string | undefined
        if (abortPrevious && previousHandle) {
          previousHandle.run.cancel(args.brief ?? `goal 被修订取代：${reason}`)
          running.delete(previous.goalId!)
          await disposeOnce(previousHandle)
          aborted = '旧 goal 的在跑轮已中止'
        }
        const newGoalId = `cyb-${randomUUID().slice(0, 8)}`
        const next = createGoal(previous, {
          goalId: newGoalId,
          ...(args.title ? { title: args.title } : {}),
          ...(args.objective ? { objective: args.objective } : {}),
          ...(args.depth ? { depth: args.depth } : {}),
          ...(args.executor ? { executor: args.executor } : {}),
          ...(args.role ? { role: args.role } : {}),
          subgoal: args.objective ?? previous.objective ?? previous.title ?? newGoalId,
        })
        // A revision inherits the previous work order unless a corrected brief
        // is supplied; the round-1 task agent reads `next.brief` verbatim.
        if (args.brief ?? previous.brief) next.brief = args.brief ?? previous.brief
        board.set(newGoalId, next)
        supersedeGoal(previous, newGoalId)
        await publishBoard()
        const at = Date.now()
        let revisionLog: string | undefined
        try {
          revisionLog = await writeRevisionLog(root, newGoalId, {
            from: previous.goalId!, to: newGoalId, reason, at,
            abort: effectiveAbort,
          })
        } catch {
          // Audit is observability: a read-only workspace must not break the
          // revision (the lineage fields on the board still carry the change).
        }
        const { round } = await launchBackground(next)
        return {
          goalId: newGoalId,
          previousGoalId: previous.goalId,
          revised: true,
          round,
          started: true,
          // Work-order visibility: the successor's effective brief (supplied
          // or inherited), so the caller can verify the task agent's mandate.
          workOrder: next.brief
            ? { present: true, chars: next.brief.length, preview: next.brief.slice(0, 80) }
            : { present: false },
          ...(aborted ? { aborted } : {}),
          abort: effectiveAbort,
          revision: { from: previous.goalId, to: newGoalId, reason, at },
          ...(revisionLog ? { revisionLog } : {}),
          ...briefWarning(next),
        }
      }

      // A superseded goal is frozen history: only the successor may be driven.
      if (loop.supersededBy !== undefined) {
        throw new Error(
          `cybernetics: goal "${loop.goalId}" is superseded by "${loop.supersededBy}" — ` +
          'drive the successor goal (see action "list")',
        )
      }

      // --- cancel -------------------------------------------------------------
      if (action === 'cancel') {
        const h = running.get(loop.goalId!)
        if (!h) return { goalId: loop.goalId, cancelled: '该 goal 当前没有运行中的轮' }
        loop.status = 'cancelled'
        h.run.cancel(args.brief ?? 'session agent 决定终止（用户修正）')
        await publishBoard()
        return { goalId: loop.goalId, round: h.round, cancelled: '已请求中止；完成通知到达后请 collect 折叠结果' }
      }

      // --- collect ------------------------------------------------------------
      if (action === 'collect') {
        const h = running.get(loop.goalId!)
        if (!h) throw new Error(`cybernetics: goal "${loop.goalId}" has no background round to collect`)
        if (!h.settled) return { goalId: loop.goalId, round: h.round, pending: true }
        const { result, decision } = await foldRound(h.root, h.round, h.settled, h.loop, h.config)
        // v0.21: mirror the latest round's per-role model audit onto the board
        // (round file already carries the full record).
        h.loop.models = { round: h.round, agents: result.agents ?? {} }
        applyDecision(h.loop, h.round, result, decision)
        running.delete(loop.goalId!)
        await disposeOnce(h)
        // Round settlement decision applied — republish (round / status / subgoal).
        await publishBoard()
        return { goalId: loop.goalId, round: h.round, decision, result }
      }

      // --- round / start ------------------------------------------------------
      if (running.has(loop.goalId!)) {
        throw new Error(`cybernetics: goal "${loop.goalId}" already has a round in flight — collect or cancel it first`)
      }
      const blocked = concurrentCapError()
      if (blocked) throw new Error(blocked)
      loop.status = 'running'
      // In-flight visibility: the blocking 'round' path can run for minutes, so
      // publish before awaiting it (the async path needs no second publish —
      // the state did not change).
      await publishBoard()

      if (action === 'start') {
        const { round } = await launchBackground(loop)
        return { goalId: loop.goalId, round, started: true, ...briefWarning(loop) }
      }

      // Blocking round (default). Both substrates expose {round, result, dispose}.
      const handle: any = await startAnyRound(loop, exec.signal)
      let settled: any
      try {
        settled = await handle.result
      } finally {
        await handle.dispose()
      }
      const { result, decision } = await foldRound(root, handle.round, settled, loop, controllerConfig)
      // v0.21: mirror the latest round's per-role model audit onto the board
      // (round file already carries the full record).
      loop.models = { round: result.round ?? handle.round, agents: result.agents ?? {} }
      applyDecision(loop, result.round, result, decision)
      // Round settlement decision applied — republish (round / status / subgoal).
      await publishBoard()
      return { goalId: loop.goalId, round: result.round, decision, result, ...briefWarning(loop) }
    },
  })

  // --- v0.18.2 preset_recommend tool: the auto-recommendation handoff -------
  // User ruling 2026-11-06: selecting auto must NOT run a separate one-shot
  // LLM call nor spawn a sub agent — the SESSION AGENT answers in its own
  // context. This tool is the seam: registered via ctx.tools.register (the
  // same face as the cybernetics tool), kept alive under the hard-gate
  // allowlist next to the cybernetics tool itself. Two hops, one tool:
  //   hop 1 (no `recommendation`): the tool probes the live catalog, builds
  //          the brief (catalog + principles + current config + vendor
  //          reference + the answer protocol — buildRecommendationBrief) and
  //          returns it as the tool result, i.e. the material lands in the
  //          session agent's OWN context.
  //   hop 2 (`recommendation` = the session agent's JSON answer): the plugin
  //          validates (applyRecommendationAnswer: strict catalog parse +
  //          soft effort validation + ALLOWED_OP_PATHS-bounded ops), writes
  //          the applied picks through the settings service together with the
  //          outcome record, and returns the summary. An unusable answer is
  //          rejected with the concrete reason so the caller can correct and
  //          re-submit — nothing is written in that case.
  // The tool works standalone (a user may simply ask the session agent to
  // auto-recommend in conversation, no card selection involved); the card's
  // pending record is visibility, not a precondition. Every failure is
  // contained: probeCatalogOptions and applyRecommendationAnswer never
  // throw; a write refusal is reported in the result text AND the diag.
  const presetRecommendToolDisposer = (ctx.tools as { register: (d: unknown) => () => void }).register({
    name: PRESET_RECOMMEND_TOOL_NAME,
    description:
      'Preset-plan auto recommendation for THIS session (预置方案「根据现有配置自动推荐」), answered by the SESSION AGENT ' +
      'itself — the plugin never runs its own LLM call for this. Two hops on the same tool: ' +
      'call WITHOUT `recommendation` to receive the live model catalog, the cross-vendor assignment principles, the current ' +
      'task/verify/triage config and the output contract; then answer IN YOUR OWN CONTEXT and call the tool AGAIN with ' +
      '`recommendation` set to the JSON (only task/verify/triage keys; null = keep current; optional reasoningEffort). ' +
      'The plugin validates the answer against the live catalog, writes the winning model/effort fields and reports the outcome.',
    parameters: {
      type: 'object',
      properties: {
        recommendation: {
          type: 'string',
          description:
            '第二跳：你的推荐 JSON（只含 task/verify/triage 三个键；null=维持现状；可选 reasoningEffort）。' +
            '省略本参数 = 第一跳：返回实时模型目录与推荐要求，请阅读后作答并再次调用。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['brief', 'applied', 'rejected', 'degraded'] },
          catalogSize: { type: 'number' },
          picks: { type: 'object' },
          reason: { type: 'string' },
          brief: { type: 'string' },
        },
      },
      render: (_args: unknown, value: any) => {
        if (value?.status === 'brief') return [{ type: 'text', text: String(value.brief ?? '') }]
        if (value?.status === 'applied') {
          const picks = value.picks && typeof value.picks === 'object'
            ? Object.entries(value.picks).map(([k, v]) => `${k}=${String(v)}`).join(', ')
            : ''
          return [{ type: 'text', text: `推荐已应用：${picks}${value.notes?.length ? `（${value.notes.join('；')}）` : ''}` }]
        }
        return [{ type: 'text', text: `推荐未应用（${value?.status}）：${String(value?.reason ?? 'unknown')}` }]
      },
    },
    async execute(args: { recommendation?: string }, exec: any) {
      const llmFace = resolveLlmFace()
      const llmCtx = llmFace !== undefined ? { llm: llmFace } : ctx
      // v0.25.5 session-only auto: when THIS session carries a `use auto`
      // pending marker, the tool's second hop lands as the session role
      // override (zero settings writes) instead of the global card path.
      const sessionKey = sessionRolesKeyOf(exec?.agent)
      const answer = typeof args?.recommendation === 'string' ? args.recommendation.trim() : ''
      if (answer === '') {
        // Hop 1: hand the material over (pure probe + render, zero LLM calls).
        const probe = await probeCatalogOptions(llmCtx)
        const brief = buildRecommendationBrief({ options: probe.options, currentOverrides: readCurrentOverrides() })
        presetDiag({ event: 'preset-tool-brief', catalogSize: brief.catalogSize, ok: brief.ok })
        if (!brief.ok) return { status: 'degraded', catalogSize: 0, reason: brief.reason }
        return { status: 'brief', catalogSize: brief.catalogSize, brief: brief.text }
      }
      // Hop 2: validate + apply the session agent's own answer.
      const probe = await probeCatalogOptions(llmCtx)
      if (!Array.isArray(probe.options) || probe.options.length === 0) {
        const reason = '当前系统模型目录不可用或为空，无法校验推荐'
        if (!takeSessionAutoPending(sessionKey)) {
          await writePresetRecord([], recordOf(PRESET_AUTO_ID, { status: 'degraded', catalogSize: 0, reason }))
        } else {
          presetDiag({ event: 'use-session-apply', preset: PRESET_AUTO_ID, phase: 'degraded-catalog' })
        }
        return { status: 'degraded', catalogSize: 0, reason }
      }
      const outcome = await applyRecommendationAnswer(llmCtx, answer, probe.options)
      // Consume the pending marker exactly once (before any early return).
      const sessionAutoApply = takeSessionAutoPending(sessionKey)
      presetDiag(outcome.ok ? {
        event: 'preset-tool-apply',
        status: 'applied',
        catalogSize: probe.options.length,
        ...(sessionAutoApply ? { sessionScope: true } : {}),
        picks: Object.fromEntries((['task', 'verify', 'triage'] as const).filter((k) => outcome.picks[k] !== undefined).map((k) => [k, `${outcome.picks[k]!.provider}/${outcome.picks[k]!.model}`])),
        ignoredSession: outcome.ignoredSession,
        notes: outcome.notes,
      } : {
        event: 'preset-tool-apply',
        status: 'rejected',
        catalogSize: probe.options.length,
        reason: outcome.reason,
      })
      if (!outcome.ok) {
        // Rejected: the card learns why (card path only), the caller gets a
        // correctable error. The session-only path writes nothing anywhere.
        if (!sessionAutoApply) {
          await writePresetRecord([], recordOf(PRESET_AUTO_ID, { status: 'degraded', catalogSize: probe.options.length, reason: outcome.reason }))
        }
        return { status: 'rejected', catalogSize: probe.options.length, reason: outcome.reason }
      }
      const picks: Record<string, string> = {}
      const efforts: Record<string, string> = {}
      for (const roleKey of ['task', 'verify', 'triage'] as const) {
        const pick = outcome.picks[roleKey]
        if (!pick) continue
        picks[roleKey] = `${pick.provider}/${pick.model}`
        efforts[roleKey] = pick.reasoningEffort ?? ''
      }
      if (sessionAutoApply) {
        // v0.25.5 session-only landing: store the validated picks as THIS
        // session's role override; no settings.mutate, no card record.
        setSessionRolesOverride(sessionKey, {
          preset: PRESET_AUTO_ID,
          label: presetChoiceLabel(PRESET_AUTO_ID),
          // Keep only the dispatch-relevant fields (the catalog rows carry
          // display metadata like `name` that roles consumers never read).
          roles: Object.fromEntries(
            (['task', 'verify', 'triage'] as const).filter((k) => outcome.picks[k]).map((k) => {
              const { provider, model, reasoningEffort } = outcome.picks[k]!
              return [k, { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }]
            }),
          ),
          appliedAt: new Date().toISOString(),
        })
        presetDiag({ event: 'use-session-apply', preset: PRESET_AUTO_ID, label: presetChoiceLabel(PRESET_AUTO_ID), picks, cleared: false })
        return {
          status: 'applied',
          catalogSize: probe.options.length,
          picks,
          ...(outcome.notes.length > 0 ? { notes: outcome.notes } : {}),
          reason: '已应用为本会话的角色覆盖（仅本会话生效，会话结束失效；不修改全局配置）',
        }
      }
      const written = await writePresetRecord(outcome.ops, recordOf(PRESET_AUTO_ID, {
        catalogSize: probe.options.length,
        picks,
        efforts,
        notes: [SESSION_SCOPE_NOTE, ...outcome.notes],
        ...(outcome.invalid.length > 0 ? { invalid: outcome.invalid } : {}),
      }))
      return {
        status: 'applied',
        catalogSize: probe.options.length,
        picks,
        ...(outcome.notes.length > 0 ? { notes: outcome.notes } : {}),
        ...(written ? {} : { reason: '配置写入被设置服务拒绝，详见服务端诊断日志' }),
      }
    },
  })
  disposers.push(presetRecommendToolDisposer)

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
 * Deliver a completion notice into the session agent's own inbox, so an async
 * round's feedback reaches the session agent even while it is doing something
 * else. Zero-dependency replica of dsh-llm's createUserMessage
 * ({id, role:'user', content, source}); running agents get it via steer
 * (next-step, auto-inserted into the current turn — v0.13.0, when
 * noticePolicy='insert'), idle agents via followup (next-turn, wakes the
 * driver), the same mechanism dsh-goal-round-driver uses to admit
 * continuation rounds. The `agent/inbox/inserted` relay (v0.13.0) is the
 * safety net for any notice that still lands in a running next-turn queue.
 */
function notifyRoundSettled(parent: any, loop: LoopState, round: number, policy: 'insert' | 'queue' = 'insert'): void {
  try {
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text:
          `<cybernetics_round>\nGoal: ${JSON.stringify(loop.goalId)} (${loop.title ?? ''})\nRound: ${round}\n\n` +
          `该 goal 的后台轮已结束。调用 cybernetics { action: "collect", goalId: ${JSON.stringify(loop.goalId)} } 折叠结果，然后按协议处理反馈：向用户总结 / 启动验证轮 / 带缺口启动修正轮。\n</cybernetics_round>`,
      }],
      source: { kind: 'cybernetics', goalId: loop.goalId, round },
    }
    // v0.13.0 inner-loop auto-insert (noticePolicy='insert'): while the session
    // agent is mid-turn, a followup parks the notice in the next-turn inbox,
    // which the Web GUI queue dock renders as a pending bubble that waits for
    // a manual send (the "manual push" the user removed). Delivering as
    // next-step (steer) inserts the notice into the running turn directly, so
    // it executes on arrival. An idle agent wakes on the very delivery either
    // way — keep the native followup there. steer wakes too
    // (send(_, _, true)), so the status-read race (running → idle between
    // check and call) stays safe. noticePolicy='queue' restores the native
    // next-turn delivery for this deployment (the inbox relay honors the same
    // knob, so the two paths stay consistent).
    if (policy === 'insert' && parent?.status === 'running' && typeof parent.steer === 'function') {
      parent.steer(message)
    } else {
      parent.followup(message)
    }
  } catch {
    // The notice is a convenience; the session agent can still collect on its
    // next turn. Never let notification failure break the round lifecycle.
  }
}
