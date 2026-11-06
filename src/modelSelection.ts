/**
 * v0.16 smart agent model selection (`smartAgentModelSelection`): at every
 * round start, classify the round's work order (brief / subgoal / objective)
 * and pick a provider/model per sub-agent role from the HOST'S LIVE model
 * catalog. The goal is not to upgrade hard tasks — it is to let SIMPLE tasks
 * finish faster and cheaper (trivial verification on a light model, trivial
 * triage on a small model) while genuinely hard work keeps the top tier.
 *
 * Design constraints (user ruling 2026-11-06):
 * - Model names are NEVER hardcoded: every candidate comes from the host LLM
 *   registry (`ctx.llm.listProviders()` / `listModels(provider)` — the same
 *   live directory `buildModelCatalog` projects for the settings card). Tiers
 *   are derived from generic capability signals (parameter-size tokens,
 *   light/heavy naming tokens), with the session agent's own route as the
 *   deployment's reference ceiling.
 * - Classification is a cheap RULE HEURISTIC this round. The host does expose
 *   a raw one-shot completion face (`ctx.llm.prepareCall().stream()` — the
 *   dsh-session-title-llm pattern), but it requires @deepseek-ai runtime
 *   imports (createUserMessage / BlockAssembler), an extra provider round
 *   trip BEFORE every round, and a whole second failure surface; this plugin
 *   is deliberately zero-dependency on @deepseek-ai packages. Deterministic
 *   keyword classification is fully offline-testable and costs nothing; the
 *   audit makes every decision reviewable so mis-classifications are visible
 *   and correctable (explicit role config always wins).
 * - Explicit configuration outranks smart selection row by row: a role whose
 *   folded override carries provider or model (roles table / flat settings
 *   fields) is left untouched. A row that pins ONLY a reasoning effort is
 *   also left alone (that effort is pinned to the inherited session route;
 *   re-routing it would clear or mismatch the pinned level — dsh-subagent
 *   clears an inherited effort when the route changes without one).
 * - No reasoning-effort assignment this round: effort ids are model-dependent
 *   (resolving them needs a per-model `resolveModelInfo` adapter round trip
 *   per selected role). Smart selection routes only; effort levels stay with
 *   the model default / the existing flat effort fields.
 * - Any failure (catalog unavailable, provider listing error, classifier
 *   exception) degrades to "keep inheriting the session agent" — the exact
 *   pre-v0.16 behavior — and records WHY in the round audit. Selection can
 *   never throw into the round path and never blocks a round.
 * - Persistent teammates (`executor.ts` spawnTeammate) do not accept model
 *   overrides: the task row is skipped with an explicit audit reason, never
 *   silently. verify/triage still run as ephemeral round.js agents and remain
 *   selectable on full persistent rounds.
 *
 * Everything decision-shaped is a pure exported function so the offline test
 * suite (test/v16-smart-selection.mjs) can pin classification, tiering,
 * merge priority, fallback and audit shape without a host.
 * @module dsh-cybernetics/model-selection
 */

import type { RolesConfig } from './controller.ts'

/** Complexity class the round's work order was classified into. */
export type SmartTaskClass = 'trivial' | 'writing' | 'hard' | 'standard'

/** Capability tier derived from generic catalog signals (no hardcoded names). */
export type ModelTier = 'light' | 'mid' | 'high'

/** One routable model candidate from the host's live catalog. */
export interface CatalogOption {
  provider: string
  model: string
  /** Display name from the catalog (tiering signal + audit readability). */
  name?: string
  /** Catalog description (tiering / writing-ability signal). */
  description?: string
}

/** The session agent's own route — the deployment's reference ceiling. */
export interface SessionRoute {
  provider?: string
  model?: string
}

/** How one role's model was decided for this round. */
export interface SmartRoleChoice {
  /** Role key: the task role ('default' or named), 'verify', 'triage'. */
  role: string
  /**
   * 'selected' = picked from the catalog (override merged into roles);
   * 'kept-explicit' = an explicit config row owns this role, smart selection
   * stood down; 'kept-inherit' = deliberately or by fallback no override —
   * `reason` always says which; 'skipped' = the role does not accept an
   * override this round (persistent teammate task) or does not run (depth).
   */
  decision: 'selected' | 'kept-explicit' | 'kept-inherit' | 'skipped'
  /** Human-readable basis, always present, always in the round audit. */
  reason: string
  /** The chosen route when decision === 'selected'. */
  picked?: { provider: string; model: string }
}

/** Per-round audit written into the round record (`.cybernetics/round-*.json`). */
export interface SmartSelectionAudit {
  /** Marker: smart selection ran for this round (absent on the object = off). */
  enabled: true
  /** The classification the work order received. */
  taskClass: SmartTaskClass
  /** Input summary: joined brief/subgoal/objective character count. */
  inputChars: number
  /** Input summary: first 100 chars, newlines flattened (never the full text). */
  inputPreview: string
  /** How many routable models the catalog probe produced. */
  catalogSize: number
  /** 'unavailable' = the host catalog could not be read; all rows inherit. */
  catalogStatus: 'ok' | 'unavailable'
  /** Per-role decision trail (task row first, then verify/triage on full). */
  roles: SmartRoleChoice[]
  /** Set when the classifier itself failed — the round fell back to inherit. */
  classifyError?: string
}

/** Everything the pure decision needs; `options` may be empty (fallback). */
export interface SmartSelectionInput {
  /** Classification input: the joined brief / subgoal / objective text. */
  text: string
  /** Round depth: quick decides ONLY the task row (verify/triage never run). */
  depth: 'quick' | 'full'
  /** Persistent teammates reject model overrides — the task row is skipped. */
  executor: 'ephemeral' | 'persistent'
  /** The role key the task agent reads this round (state.role ?? 'default'). */
  taskRoleKey: string
  /** The fully folded EXPLICIT overrides (roles table + flat fields + efforts). */
  explicit: RolesConfig
  /** Live catalog candidates (empty = nothing to pick from). */
  options: CatalogOption[]
  /** The session agent's route (inherit target + tiering reference). */
  session: SessionRoute
}

/** Merged per-role overrides + the audit trail, in one pure result. */
export interface SmartSelectionOutput {
  /** Rows to ADD to the config-derived roles (only 'selected' decisions). */
  overrides: RolesConfig
  audit: SmartSelectionAudit
}

// --- classification -----------------------------------------------------------

/** Trivial mechanical operations: the exact shapes a light model handles. */
const TRIVIAL_PATTERNS: RegExp[] = [
  /删除.{0,12}(文件|目录|文件夹)|删掉|(?:remove|delete)\s+(?:\w+\s+){0,3}(?:file|directory|folder|dir)\b|\brm\s+-?[rf]/i,
  /\bgit\s+(commit|push|add|stash|tag|checkout|pull)\b|(提交|推送|拉取).{0,6}(代码|变更|改动|提交|commit|push)/i,
  /重命名|rename\s+(?:\w+\s+){0,3}(?:file|directory|folder|variable|function)|移动文件|move\s+(?:\w+\s+){0,2}file|复制文件|copy\s+(?:\w+\s+){0,2}file/i,
  /格式化|fix\s+lint|lint\s+(fix|error)|prettier|\btypo(s)?\b|错别字|错字|改个文案|改一下文案/i,
  /文件(是否|是不是|还)?(不)?存在|(?:file|文件)\s+(?:is\s+)?(?:not\s+)?(?:missing|absent|exists|present)|existsSync|存在性/i,
  /查(找|看)一下|看看.{0,6}(文件|内容|日志|状态)|列出(目录|文件)|list\s+files/i,
]

/** Prose/writing deliverables: documentation-shaped work as the goal itself. */
const WRITING_PATTERNS: RegExp[] = [
  /写(?:一?份|一?篇|个)?(?:文档|说明|README|报告|文章|博客|教程|总结|纪要|周报)|文档写作|撰写|润色|校对|翻译|拟一份|起草/i,
  /write\s+(?:\w+\s+){0,3}(?:doc|docs|documentation|readme|report|article|blog|post|tutorial|summary|guide|changelog)/i,
  /update.{0,8}(?:doc|docs|documentation|readme|report)|documentation\s+(?:for|of)\b/i,
  /\btranslate\b|translation/i,
]

/** Genuinely hard work: uncommon languages, hard math, systems/concurrency. */
const HARD_PATTERNS: RegExp[] = [
  /\brust\b|\bc\+\+\b|\bcpp\b|haskell|ocaml|\bzig\b|elixir|scala|prolog|fortran|cobol|汇编|assembly|wasm/i,
  /证明.{0,12}(命题|定理|猜想|正确性)|非平凡.{0,6}(数学|命题|定理)|数学(归纳|证明)|\bproof\b\s+(of|for)|\btheorem\b|conjecture|测度|拓扑|群论|伽罗瓦|数论/i,
  /并发(运行时|调度|控制)|并行运行时|lock-?free|无锁(数据结构)?|\bscheduler\b.{0,10}(实现|实现一个|from scratch)|内存分配器|写一个(?:操作系统的?)?内核|kernel.{0,10}(from scratch|module)/i,
  /分布式一致|共识算法|\braft\b|\bpaxos\b|\bcap\b.{0,6}定理|两阶段提交|分布式事务/i,
  /编译器|compiler.{0,12}(from scratch|实现)|词法分析|语法分析|类型检查器|类型推导|\binterpreter\b.{0,12}(实现|from scratch)|虚拟机指令集|emulator/i,
  /密码学|加密算法实现|零知识证明|zero.?knowledge|椭圆曲线|\bsha-?3\b|\baes\b.{0,10}实现/i,
  /从零(开始)?实现.{0,10}(运行时|引擎|数据库|语言|协议)|from scratch.{0,20}(runtime|engine|database|language|protocol)/i,
]

/**
 * Signals a catalog candidate is good at prose (description/name mentions) —
 * used by the writing class to prefer a catalog model that advertises writing
 * strength. Matching nothing is normal (most catalogs don't advertise this);
 * the writing class then keeps the session model for the task row.
 */
const WRITING_ABILITY_SIGNALS = /writ|doc|report|summar|translat|editor|creative|copywrit|narrat|创作|写作|文案/i

/**
 * Classify the round's work order. Precedence: hard > writing > trivial >
 * standard — a hard signal anywhere (e.g. "用 Rust 写 README") wins, and a
 * standard task is deliberately left on the session default (the feature's
 * purpose is cheapening simple work, not perturbing ordinary work).
 * Pure; never throws (all patterns are plain literals).
 */
export function classifyTaskText(text: string): SmartTaskClass {
  const raw = typeof text === 'string' ? text : ''
  if (raw.length === 0) return 'standard'
  const haystack = raw.slice(0, 20000) // bound the scan; work orders are far shorter
  for (const re of HARD_PATTERNS) if (re.test(haystack)) return 'hard'
  for (const re of WRITING_PATTERNS) if (re.test(haystack)) return 'writing'
  for (const re of TRIVIAL_PATTERNS) if (re.test(haystack)) return 'trivial'
  return 'standard'
}

// --- tiering ------------------------------------------------------------------

/** Parameter-size tokens ("8b", "70B", "1.5b") beat name tokens (distilled R1 8b is light). */
const SIZE_TOKEN = /(\d+(?:\.\d+)?)\s*b\b/i
const LIGHT_NAME_TOKENS = /mini|flash|lite|small|tiny|nano|instant|swift|haiku|air|edge|低配|轻量/i
const HIGH_NAME_TOKENS = /opus|ultra|plus|premium|pro|large|heavy|sonnet|reasoner|thinking|think|preview|高配|顶配|旗舰/i

/**
 * Derive a capability tier from generic catalog signals. The session agent's
 * own route is forced 'high' — the deployment chose it as the working model,
 * so it is the reference ceiling and never mistaken for a downgrade target.
 * Unknown shapes default to 'mid' (picked only by the writing class, which
 * treats mid as an acceptable fallback; light/high picks never consider it).
 * Pure; never throws.
 */
export function modelTier(option: CatalogOption, session: SessionRoute): ModelTier {
  if (sameRoute(option, session)) return 'high'
  const text = [option.model, option.name ?? '', option.description ?? ''].join(' ')
  const size = SIZE_TOKEN.exec(text)
  if (size !== null) {
    const b = Number(size[1])
    if (Number.isFinite(b)) {
      if (b <= 12) return 'light'
      if (b <= 40) return 'mid'
      return 'high'
    }
  }
  if (LIGHT_NAME_TOKENS.test(text)) return 'light'
  if (HIGH_NAME_TOKENS.test(text)) return 'high'
  return 'mid'
}

/**
 * Whether a catalog option IS the session agent's route. The model id
 * dominates: overriding to another provider under the SAME model id changes
 * nothing capability-wise but counts as a route change (dsh-subagent would
 * clear the inherited reasoning effort), so it must stand down too. A session
 * route with no provider (bare model name from parseAgentModelSpec) matches
 * any provider carrying that id.
 */
function sameRoute(option: CatalogOption, session: SessionRoute): boolean {
  const { provider, model } = session
  if (model) return option.model === model
  // A provider-only session route cannot identify a model — nothing matches.
  return false
}

// --- per-class picks ----------------------------------------------------------

/** The desired route per role for one class; undefined = keep inheriting. */
export interface ClassPicks {
  task?: CatalogOption
  verify?: CatalogOption
  triage?: CatalogOption
}

/** First catalog option passing `pred`, skipping the session route itself. */
function firstMatching(options: CatalogOption[], session: SessionRoute, pred: (o: CatalogOption) => boolean): CatalogOption | undefined {
  return options.find((o) => !sameRoute(o, session) && pred(o))
}

/** All light-tier options (session route excluded — it is the ceiling). */
function lightOptions(options: CatalogOption[], session: SessionRoute): CatalogOption[] {
  return options.filter((o) => !sameRoute(o, session) && modelTier(o, session) === 'light')
}

function pickLight(options: CatalogOption[], session: SessionRoute): CatalogOption | undefined {
  return lightOptions(options, session)[0]
}

/**
 * Hard tasks: the highest-tier non-session model (a real upgrade). When the
 * catalog has no separate high-tier model, undefined keeps the session route
 * (which the tiering already treats as high — inheriting IS the top tier).
 */
function pickHigh(options: CatalogOption[], session: SessionRoute): CatalogOption | undefined {
  return firstMatching(options, session, (o) => modelTier(o, session) === 'high')
}

/**
 * Writing tasks: a catalog model whose name/description advertises writing
 * strength, preferring the strongest candidate (high > mid > light). No
 * writing-advertised model → undefined (the session model stays on the task;
 * verify inherits too — prose review benefits from the stronger model).
 */
function pickWriting(options: CatalogOption[], session: SessionRoute): CatalogOption | undefined {
  const candidates = options.filter(
    (o) => !sameRoute(o, session) && WRITING_ABILITY_SIGNALS.test([o.model, o.name ?? '', o.description ?? ''].join(' ')),
  )
  const byTier = (t: ModelTier) => candidates.find((o) => modelTier(o, session) === t)
  return byTier('high') ?? byTier('mid') ?? byTier('light')
}

/**
 * Per-class desired routes. verify mirrors the class's review weight:
 * trivial review is a existence/shape check (light model is enough), hard
 * review needs the top tier, writing review keeps the session model (the
 * strongest prose judge available by definition), triage is always a small
 * bucketing job (light). Standard decides nothing (all inherit).
 */
export function picksForClass(taskClass: SmartTaskClass, options: CatalogOption[], session: SessionRoute): ClassPicks {
  if (taskClass === 'standard' || options.length === 0) return {}
  if (taskClass === 'trivial') {
    const light = pickLight(options, session)
    return light !== undefined ? { task: light, verify: light, triage: light } : {}
  }
  if (taskClass === 'writing') {
    const writer = pickWriting(options, session)
    const light = pickLight(options, session)
    return { ...(writer !== undefined ? { task: writer } : {}), verify: undefined, ...(light !== undefined ? { triage: light } : {}) }
  }
  // hard: top tier for task + verify, light triage.
  const high = pickHigh(options, session)
  const light = pickLight(options, session)
  return { ...(high !== undefined ? { task: high, verify: high } : {}), ...(light !== undefined ? { triage: light } : {}) }
}

// --- merge + audit ------------------------------------------------------------

const routeLabel = (o: { provider: string; model: string }): string => `${o.provider}/${o.model}`
const sessionLabel = (s: SessionRoute): string =>
  [s.provider, s.model].filter(Boolean).join('/') || '(未知的 session 路由)'

/**
 * Fold smart selection over the explicit config: classify, pick, merge, and
 * record every decision. NEVER throws and NEVER blocks: a classifier failure
 * degrades to standard-class (all inherit) with `classifyError` recorded; an
 * empty catalog keeps every row inheriting with `catalogStatus: 'unavailable'`
 * (or 'ok' + per-role reasons when the catalog simply has no lighter/higher
 * model to offer).
 */
export function computeSmartSelection(input: SmartSelectionInput): SmartSelectionOutput {
  const { session, explicit, depth, executor, taskRoleKey } = input
  const text = typeof input.text === 'string' ? input.text : ''
  const options: CatalogOption[] = Array.isArray(input.options) ? input.options : []
  const baseAudit = {
    enabled: true as const,
    inputChars: text.length,
    inputPreview: text.slice(0, 100).replace(/\s+/g, ' '),
    catalogSize: options.length,
    catalogStatus: 'ok' as 'ok' | 'unavailable',
  }
  // 1. Classify — a pattern failure must never break the round.
  let taskClass: SmartTaskClass
  try {
    taskClass = classifyTaskText(text)
  } catch (error) {
    const reason = `任务分类失败（${error instanceof Error ? error.message : String(error)}），保持继承 session agent`
    return {
      overrides: {},
      audit: {
        ...baseAudit,
        taskClass: 'standard',
        classifyError: error instanceof Error ? error.message : String(error),
        roles: roleDecisionsForFallback(taskRoleKey, depth, executor, explicit, reason, '分类异常回退'),
      },
    }
  }
  // 2. Catalog absent → everything inherits (recorded).
  if (options.length === 0) {
    return {
      overrides: {},
      audit: {
        ...baseAudit,
        catalogStatus: 'unavailable',
        taskClass,
        roles: roleDecisionsForFallback(
          taskRoleKey, depth, executor, explicit,
          `当前系统模型目录不可用或为空（catalogSize=0），无法智能选择，保持继承 ${sessionLabel(session)}`,
          '模型目录不可用回退',
        ),
      },
    }
  }
  // 3. Per-class desired routes + per-role decision fold.
  const picks = picksForClass(taskClass, options, session)
  const overrides: RolesConfig = {}
  const roles: SmartRoleChoice[] = []
  const decidedKeys = decidedRoleKeys(taskRoleKey, depth, executor)
  for (const [roleKey, kind] of decidedKeys) {
    // Persistent teammate: the spawn face accepts no model overrides.
    if (kind === 'task' && executor === 'persistent') {
      roles.push({
        role: roleKey,
        decision: 'skipped',
        reason: 'persistent executor 的 task teammate（spawnTeammate）不接受模型覆盖：智能选择显式跳过 task 行（verify/triage 仍按下方决策执行）',
      })
      continue
    }
    // Explicit config wins: provider/model present → stand down.
    const row = explicit?.[roleKey]
    if (row && (row.provider || row.model)) {
      roles.push({
        role: roleKey,
        decision: 'kept-explicit',
        reason: `角色已有显式模型配置（${[row.provider, row.model].filter(Boolean).join('/')}），显式配置优先于智能选择`,
      })
      continue
    }
    // Effort-only row: an effort pinned to the inherited session route.
    if (row && row.reasoningEffort) {
      roles.push({
        role: roleKey,
        decision: 'kept-inherit',
        reason: `角色已显式钉住思考强度档位 ${row.reasoningEffort}（作用在继承的 session 路由上）；改路由会使该档位失配，保持继承`,
      })
      continue
    }
    const desired = picks[kind]
    if (desired === undefined) {
      const why =
        taskClass === 'standard'
          ? `常规任务（无简单/困难特征）：维持 session 默认 ${sessionLabel(session)}`
          : taskClass === 'hard'
            ? `目录中没有独立于 session 模型（${sessionLabel(session)}，即顶配参照）的更高配模型，保持继承即顶配`
            : taskClass === 'writing'
              ? `目录中没有声明写作特长的模型，task/verify 保持继承 ${sessionLabel(session)}`
              : `目录中没有比 session 模型（${sessionLabel(session)}）更轻的模型，保持继承（部署本身已是轻量配置）`
      roles.push({ role: roleKey, decision: 'kept-inherit', reason: why })
      continue
    }
    // Picking the session route itself would clear an inherited effort for
    // nothing (dsh-subagent clears route-owned effort on any route change):
    // inherit achieves the identical route, so stand down.
    if (sameRoute(desired, session)) {
      roles.push({ role: roleKey, decision: 'kept-inherit', reason: `选定模型 ${routeLabel(desired)} 与 session 模型相同，保持继承（保留继承的思考强度）` })
      continue
    }
    overrides[roleKey] = { ...row, provider: desired.provider, model: desired.model }
    roles.push({
      role: roleKey,
      decision: 'selected',
      reason:
        `任务分类 ${taskClass}：为 ${kind === 'task' ? 'task' : kind} 角色选择 ${routeLabel(desired)}` +
        `（${modelTier(desired, session)} 档，目录 ${options.length} 个模型中按${kind === 'triage' ? '分拣轻量' : kind === 'verify' ? '验证强度' : '执行档位'}规则选取）`,
      picked: { provider: desired.provider, model: desired.model },
    })
  }
  return { overrides, audit: { ...baseAudit, taskClass, roles } }
}

/** Which roles this round actually decides, in audit order. */
function decidedRoleKeys(taskRoleKey: string, depth: 'quick' | 'full', executor: 'ephemeral' | 'persistent'): Array<[string, 'task' | 'verify' | 'triage']> {
  const keys: Array<[string, 'task' | 'verify' | 'triage']> = [[taskRoleKey || 'default', 'task']]
  if (depth !== 'quick') {
    keys.push(['verify', 'verify'], ['triage', 'triage'])
  }
  // Persistent quick rounds never run round.js verify/triage at all.
  if (executor === 'persistent' && depth === 'quick') {
    return keys.filter(([k]) => k === (taskRoleKey || 'default'))
  }
  return keys
}

/** Fallback audit: every decided role inherits, each with the shared reason. */
function roleDecisionsForFallback(
  taskRoleKey: string,
  depth: 'quick' | 'full',
  executor: 'ephemeral' | 'persistent',
  explicit: RolesConfig,
  reason: string,
  prefix: string,
): SmartRoleChoice[] {
  const roles: SmartRoleChoice[] = []
  for (const [roleKey, kind] of decidedRoleKeys(taskRoleKey, depth, executor)) {
    const row = explicit?.[roleKey]
    if (kind === 'task' && executor === 'persistent') {
      roles.push({ role: roleKey, decision: 'skipped', reason: 'persistent executor 的 task teammate 不接受模型覆盖：智能选择显式跳过（附带说明：' + prefix + '）' })
      continue
    }
    if (row && (row.provider || row.model)) {
      roles.push({ role: roleKey, decision: 'kept-explicit', reason: `角色已有显式模型配置（${[row.provider, row.model].filter(Boolean).join('/')}），显式配置优先于智能选择` })
      continue
    }
    roles.push({ role: roleKey, decision: 'kept-inherit', reason })
  }
  return roles
}

// --- host probes (soft, never throw) -------------------------------------------

/**
 * Read the host's live model catalog through the root `llm` service — the
 * same registry `buildModelCatalog` projects for the settings card
 * (`listProviders()` → `listModels(provider.id)` per provider, provider
 * failures isolated like the host does). Soft probe: any missing service,
 * throwing property read (Cordis un-injected guard), transport error, or
 * malformed shape yields `[]` = "nothing to pick from" (inherit), never an
 * error into the round path.
 */
export async function probeCatalogOptions(ctx: unknown): Promise<{ options: CatalogOption[]; ok: boolean }> {
  let llm: unknown
  try {
    llm = (ctx as { llm?: unknown } | null | undefined)?.llm
  } catch {
    return { options: [], ok: false } // Cordis proxy guard: service not injected here
  }
  const face = llm as { listProviders?: unknown; listModels?: unknown } | undefined
  if (!face || typeof face.listProviders !== 'function' || typeof face.listModels !== 'function') {
    return { options: [], ok: false }
  }
  let providers: unknown
  try {
    providers = await (face.listProviders as () => unknown)()
  } catch {
    return { options: [], ok: false }
  }
  if (!Array.isArray(providers)) return { options: [], ok: false }
  const options: CatalogOption[] = []
  let any = false
  for (const provider of providers) {
    const pid = (provider as { id?: unknown } | null | undefined)?.id
    if (typeof pid !== 'string' || pid.length === 0) continue
    any = true
    try {
      const models = await (face.listModels as (id: string) => unknown)(pid)
      if (!Array.isArray(models)) continue
      for (const model of models) {
        const mid = (model as { id?: unknown } | null | undefined)?.id
        if (typeof mid !== 'string' || mid.length === 0) continue
        const name = (model as { name?: unknown }).name
        const description = (model as { description?: unknown }).description
        options.push({
          provider: pid,
          model: mid,
          ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
          ...(typeof description === 'string' && description.length > 0 ? { description } : {}),
        })
      }
    } catch {
      // Isolated provider failure: skip it, keep the rest (host parity).
    }
  }
  return { options, ok: any }
}

/**
 * The session agent's own route — `session.requestHeader().config` wins (the
 * latest request-time selection) over creation options, exactly how
 * dsh-subagent's `parentAgentOptionsForDelegation` resolves the values a
 * child inherits. Soft read: every missing/throwing seam yields {}.
 */
export function sessionRouteOf(parent: unknown): SessionRoute {
  const read = (config: unknown): SessionRoute | undefined => {
    if (config === null || typeof config !== 'object') return undefined
    const provider = (config as { provider?: unknown }).provider
    const model = (config as { model?: unknown }).model
    const p = typeof provider === 'string' && provider.length > 0 ? provider : undefined
    const m = typeof model === 'string' && model.length > 0 ? model : undefined
    return p || m ? { ...(p ? { provider: p } : {}), ...(m ? { model: m } : {}) } : undefined
  }
  try {
    const header = (parent as { session?: { requestHeader?: () => { config?: unknown } } } | undefined)
      ?.session?.requestHeader?.()?.config
    const fromHeader = read(header)
    if (fromHeader) return fromHeader
  } catch { /* proxy/shape failures fall through */ }
  try {
    const fromOptions = read((parent as { options?: unknown }).options)
    if (fromOptions) return fromOptions
  } catch { /* ignore */ }
  return {}
}
