# Plan Mode 优先级方案：plan mode ⊃ cybernetics（v0.10.0 设计）

日期：2026-11-05　状态：设计定稿（待实现轮；v0.10.0 修订同一日用户裁定）
作者：cyb 调研轮（只读调研 + 本文档）；v0.10.0 硬门策略修订：用户 2026-11-05 裁定

## 0. 目标语义

用户进入 plan 模式时按 plan 语义执行（只读规划 + `exit_plan_mode` 审批）；批准退出 plan 后，
cybernetics 恢复判定：若会话 cybernetics 生效，后续实施请求走 goal 循环。
一句话：**plan 决定"能不能动手"，cybernetics 决定"动手走不走循环"**。

## 1. 跨插件状态读取（调研任务 1 结论）

**可行，且无需镜像状态。** dsh-plan-mode 注册了 session projection（key = `plan`）：

- 投影定义：`node_modules/@deepseek-ai/dsh-plan-mode/lib/index.js:64-127`
  （`planProjectionDefinition`，key `"plan"`，stateVersion 3）。
- 状态结构：`{ active: boolean, wanted: boolean|null, running: {commandId, wanted}|null, activeAtLastHeader: boolean|null }`。
- `plan/mode { active }` 事件折叠进投影（:103-107）；`/plan` 命令先写 `running`（:84-93），
  命令成功后落 `wanted`（:95-102），下一次 accepted in-turn pre-step 时由
  `onBoundary` 追加 `plan/mode` 事件使 `active` 翻转（:151-166, :388-398）。
- cybernetics 已 inject `sessionProjections`（src/index.ts:50, :647-657），同一注册表，
  直接 `ctx.sessionProjections.stateOf(session, "plan")` 即可读到。

**唯一缺口：pendingIntents 不在投影里**（:146, WeakMap，仅服务内可见）。但投影已含等价信息：
`running`（命令进行中）与 `wanted`（已选未生效）都能从投影 state 读出。因此判定式：

```ts
// planOverrideOf：true = plan 优先生效（active 或即将 active）
function planWanted(session: unknown): boolean {
  try {
    const s = ctx.sessionProjections.stateOf(session, 'plan') as
      { active?: boolean; wanted?: boolean | null; running?: { wanted?: boolean } | null } | undefined
    if (!s || typeof s !== 'object') return false          // plan-mode 未挂载/未回放 → 无 plan
    if (s.active === true) return true                      // 已生效
    if (s.running?.wanted === true) return true             // /plan 进行中，下一步即生效
    if (s.wanted === true) return true                      // 已选待生效
    return false
  } catch { return false }                                 // stateOf 可能 throw（lib/index.js:331-335 同款防御）
}
```

注意：`wanted === false`（退出待生效）不视为 plan 优先——本步仍按 plan 执行（guidance 里 plan:policy
此刻仍在，lib/index.js:175），下一步起 cybernetics 恢复；由于 guidance 是 per-request 函数，
自然按新投影值切换，无需额外事件。

## 2. exit_plan_mode 批准后的接力（调研任务 2 结论）

1. 模型在 plan 模式下调用 `exit_plan_mode { plan }`（工具常驻注册，lib/index.js:230-317）。
2. `execute` 弹 user-questions 审批卡（:257-282）；批准 → `pendingIntents.set(session, {active:false, narrate:false})`
   （:297-300），返回 `{approved:true}`，工具结果文本 "Plan approved — plan mode exited; carry out the plan
   starting with your next step."（:249）。
3. 下一次 accepted in-turn pre-step：`onBoundary` 追加 `plan/mode {active:false}`（:157）→ 投影 `active` 翻 false。
4. **没有系统级的"第一条执行消息"**：用户批准后的实施诉求以普通用户 prompt / steer 进入会话
   （plan 审批文本只是指示模型下一步执行）。cybernetics 接管完全靠既有机制：guidance section 是
   per-request 函数（src/index.ts:686-692），投影翻转后下一请求自动恢复 ALL-GOALS 段与 gate 判定，
   session agent 按协议对实施请求建 goal。**无需新增接线**，只要 3/4 节把 plan 优先判定接进这两处。

## 3. 冲突精确清单（调研任务 3，均有行号）

| # | 层面 | 冲突 | 证据 |
|---|------|------|------|
| C1 | **工具装配（阻断级）** | allowlist 硬门从顶层 session agent 装配中摘掉一切不在 `DEFAULT_GATE_ALLOWLIST` 的工具，**`exit_plan_mode` 不在名单里** → plan 模式下模型根本无法提交计划审批，plan mode 被硬门直接废掉。pre-execute 层同样 deny。 | 名单 `src/index.ts:545-575`；装配过滤 :727-753；dispatch deny :767-782；工具常驻注册 `dsh-plan-mode/lib/index.js:22-24, 230-317` |
| C2 | guidance 文本 | ALL-GOALS RULE 1 "EVERYTHING ENTERS A GOAL"（含分析/问题/一次查询）与 plan:policy（"只读规划 + exit_plan_mode 审批，本步内自己完成"）互斥：plan 模式下模型被同时要求"一切进 goal"和"自己规划"。ALL_GOALS 里 "LIGHTWEIGHT ANALYSIS → create a goal" 直接吞掉规划请求。 | `src/index.ts:465-534`（IMPLICIT_GUIDANCE + ALL_GOALS_GUIDANCE）；plan 段函数 `dsh-plan-mode/lib/index.js:170-177` |
| C3 | hard-gate 文案 | "the moment the user asks for a change … delegate" 会在 plan 模式下诱导模型对"我想要 X 功能"这类**待规划请求**直接建 goal 实施，跳过审批。 | `src/index.ts:585-605`（HARD_GATE_GUIDANCE_ALLOWLIST 末段） |
| C4 | 命令叠加 | `/cybernetics off` + `/plan on`：现行为恰好正确（override=false → 无 guidance、gate 直通，:689/:746/:773；plan:policy 生效）——保留为回归用例，不冲突。反之 `/cybernetics on` + `/plan on` 命中 C1-C3。 | `src/index.ts:673-691, 746, 773` |

方向一致部分（非冲突）：硬门"摘写工具"与 plan 只读纪律同向。但 allowlist 语义是"白名单外全摘"，
殃及 `exit_plan_mode` 这类**只读审批工具**——这是 C1 的根因，也是方案 4.2 选"定向豁免"而非"整体抑制"的原因。

## 4. 实施方案（决策完整，另一工程师可直接实现）

### 4.1 新增读取：`src/sessionMode.ts` 加 `planWanted(ctx, session)`

按第 1 节伪码实现，导出常量 `PLAN_PROJECTION_KEY = 'plan'`。纯只读，try/catch 兜底，
plan-mode 未挂载恒 false（不依赖 plan-mode 注入任何服务）。

**v0.10.0（用户 2026-11-05 裁定）**：`planWanted` 从 §1 判定式实现并从 `src/sessionMode.ts`
导出为共用谓词——guidance（§4.3）、硬门装配过滤与 pre-execute 拒绝（§4.3-硬门）三处都读它，
单一事实源，避免三处各自维护 plan 三态判定。

### 4.2 修 C1（必须，v0.10.0 降级为兜底）：gate 豁免 `exit_plan_mode`

`src/index.ts` `installGate()`：

1. `DEFAULT_GATE_ALLOWLIST`（:545-575）头部加 `'exit_plan_mode'`（工具只读审批，常驻注册，加入无副作用——非 plan 会话调用会 throw，lib/index.js:255）。
2. `tools/pre-execute` deny 判定（:774）前加一行：`if (name === 'exit_plan_mode') return next()`。
   （装配层靠白名单项即可；dispatch 层显式放行，双保险。）

> **v0.10.0 定位变化（用户 2026-11-05 裁定）**：本节从"plan 期间可用 plan 的唯一保障"降级为
> **兜底修复**。主机制改为 §4.3-硬门的 planWanted 会话豁免——plan 激活会话整个 gate 直通，
> exit_plan_mode 天然可达。保留本节是因为：即使 plan 投影检测失效（plan-mode 未挂载、投影
> key 变更、读取异常），plan 审批工具仍不会被双杀；且非 plan 会话中该工具无实际作用
> （调用 throw），加白名单无副作用。

### 4.3 修 C2/C3（核心）：guidance 函数接入 plan 优先条款

`registerGuidanceSection()` 的 text 函数（src/index.ts:686-692）改为：

```ts
text: (context) => {
  const session = context?.agent?.session
  const override = modeOverrideOf(ctx, session)
  if (override === false) return ''                 // 现行为：cybernetics off 无任何段
  if (planWanted(ctx, session)) return PLAN_PRECEDENCE_GUIDANCE   // plan 优先：整段替换
  const allGoals = override === true ? true : allGoalsMode()
  return IMPLICIT_GUIDANCE + (allGoals ? ALL_GOALS_GUIDANCE : '') + hardGateGuidance
}
```

新常量（放 ALL_GOALS_GUIDANCE 之后）：

```
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
tool removal; the gate returns automatically once plan mode exits.
`
```

#### 4.3-硬门（v0.10.0 核心，覆盖原 §4.3"硬门保持"结论）：installGate 两层加 planWanted 豁免

**决策来源：用户 2026-11-05 裁定。** 在 cybernetics 模式下用户进入 plan 模式时，硬门对该会话
**关闭**；plan 响应完成后（exit_plan_mode 批准 / `/plan off`；拒绝后继续规划则豁免保持），
硬门恢复到配置状态。

**实现方式（已与用户对齐）：不用 hook 翻转 volatile 配置**（全局、有恢复失败风险、误伤其他
会话），而是在 installGate 两层判定的 `modeOverrideOf` 检查旁加 `planWanted(session)` 分支。
豁免是**按会话、按请求**生效的；plan 投影翻转后下一请求自动恢复强制，无需任何恢复逻辑。

改动点（均在 `src/index.ts` `installGate()` 内）：

```ts
// (1) 装配过滤（system-prompt/assemble，~:727-753）——在 override 检查旁加：
if (modeOverrideOf(ctx, (scope as any)?.session) === false) return next()
if (planWanted(ctx, (scope as any)?.session)) return next()   // plan 会话：gate 直通，不摘工具

// (2) pre-execute 拒绝（tools/pre-execute，~:767-782）——在 override 检查旁加：
if (modeOverrideOf(ctx, exec?.agent?.session) === false) return next()
if (planWanted(ctx, exec?.agent?.session)) return next()      // plan 会话：不 deny
```

语义细节：

- 豁免仅在 `hardGate()` 为真（gate 已安装）时才被触及；`hardGate=false` 部署行为零变化。
- `planWanted` 为 true 涵盖 plan active / wanted（已选待生效）/ running（/plan 进行中）三态，
  与 guidance 的 plan 优先判定（§4.3）同一谓词（§4.1），guidance 与 gate 永不同步失配。
- **与被覆盖段落的差异说明**：原"硬门保持"依赖"allowlist 恰好包含 plan 所需全部工具"的
  巧合交集——denylist 部署下该论证不成立（bash/edit/write 被摘会阻断规划所需写探针），
  且 HARD_GATE 文案（C3）在 plan 期间诱导跳过审批直接建 goal。planWanted 豁免对两种
  gateMode 一致，且 C3 文案在 plan 期间根本不出现在 prompt 里。plan 纪律由 guidance +
  plan:policy 承担，不再由工具摘除承担。

**恢复语义（明确写出）：**

| 场景 | 豁免状态 |
|---|---|
| plan 中被拒绝（用户选 keep planning） | pendingIntents 未清、投影未翻转 → `planWanted` 仍 true，豁免保持 |
| exit_plan_mode 批准 | 下一次 accepted in-turn pre-step 投影 `active=false`（§2 第 3 步）→ 豁免结束，gate 按配置恢复 |
| `/plan off` | `wanted=false` → `planWanted` false → 豁免结束 |
| resume / fork | 会话日志前缀重放投影，豁免状态自然正确 |
| 崩溃 | 无需恢复逻辑——没有任何全局/volatile 状态被翻转过，gate 从未离开"读投影"这一按请求判定 |

取舍说明（v0.10.0 重述，记录各案与裁定）：
- **gate 谓词读 plan 投影（选定，用户 2026-11-05 裁定）**：见 §4.3-硬门。按会话、按请求、零恢复逻辑。
- **hook 翻转 volatile 配置（否决，同一裁定）**：plan 进入/退出时写 `config.hardGate` volatile
  引用是**全局**状态——同一 profile 的其他并发会话被误伤；plan 崩溃/被杀时存在"豁免未恢复"
  的悬挂态，需额外恢复机制；volatile live ref 由 settings 面板提交，插件侧写它语义脆弱。
- **原 v0.9.1"硬门保持"方案（被本版覆盖）**：见上方差异说明——其 allowlist 交集论证与
  denylist 部署事实不符，故废除。

### 4.4 denylist 部署补强

`DEFAULT_GATED_TOOLS = ['bash','edit','write']` 不含 exit_plan_mode，denylist 模式天然放行，无需改动；
但 4.2 的 dispatch 层 `exit_plan_mode` 显式 `next()` 对两种 gateMode 都生效，统一写上。

### 4.5 不改的东西（明确决策）

- dsh-plan-mode 零改动（它是部署方 bundle，改动成本高且无需）。
- 不新增事件监听/镜像状态：投影 per-request 读取已覆盖 active/pending/批准翻转全路径（§1、§2）。
- **不翻转 volatile 配置（v0.10.0 用户裁定）**：不新增任何 hook 去写 `config.hardGate` /
  `allGoalsMode` volatile 引用；plan 豁免完全走 gate 谓词的按请求判定（§4.3-硬门）。
- `/cybernetics off` × plan：现行为正确（C4），只加测试。
- 并发 goal（cyb-3fb024c6）改的 src/index.ts 头部徽标区与本方案的 installGate/registerGuidanceSection
  无行重叠；实现轮以落盘后的文件为基座。

## 5. 测试矩阵

维度：plan ∈ {on(active), pending(刚 /plan on), off}；cybernetics ∈ {override on, override off, inherit(global on), inherit(global off)}；
hardGate ∈ {allowlist, denylist, off}；override 来源 ∈ {/cybernetics, 全局 volatile}。

| 用例 | 期望 |
|---|---|
| plan on × cyb override on × allowlist | guidance 仅 PLAN_PRECEDENCE（硬门段被 plan 整段替换，HARD_GATE 文案不出现）；**v0.10.0**：planWanted 豁免 → 装配层不摘任何工具（全量保留），exit_plan_mode 与写工具均可达 |
| **v0.10.0** plan on × cybernetics on（inherit global on）× allowlist | 同上：写工具保留（gate 直通）、exit_plan_mode 可用；guidance 为 PLAN_PRECEDENCE |
| **v0.10.0** plan on × cybernetics on × denylist | bash/edit/write 不被 deny（planWanted 分支先于 deny 判定 return next()）；exit_plan_mode 可用 |
| **v0.10.0** plan 退出（批准或 /plan off）→ 同会话下一请求 | planWanted=false → 装配层重新按 allowlist 摘除写工具；pre-execute 恢复 deny；guidance 切回 IMPLICIT+ALL_GOALS+硬门段 |
| plan pending（/plan on 未落）× 同上 | 同上（wanted 判定提前切换，避免一步真空期） |
| plan on × cyb override off | 仅 plan:policy（plan-mode 自己的段）；无任何 cybernetics 段；gate 直通（现状回归） |
| plan off（含批准后）× cyb override on | 恢复 IMPLICIT + ALL_GOALS + 硬门；实施请求走 goal 循环 |
| plan off × inherit global off | 无 ALL_GOALS 段（现状回归） |
| **v0.10.0 修订** plan on × denylist gate（非 cyb 会话） | §4.3-硬门 planWanted 豁免对两种 gateMode 一致：plan 会话整个 gate 直通（bash/edit/write 与 exit_plan_mode 均可达，plan 纪律由 guidance 承担）；planWanted 检测失效时降级为旧行——exit_plan_mode 经 4.2 dispatch 兜底仍放行，bash/edit/write 仍 deny |
| **v0.10.0** planWanted 检测失效（投影 key 缺失/异常）× plan 审批 | 4.2 兜底：exit_plan_mode 仍放行，plan 审批不被双杀（装配层白名单 + dispatch 显式 next()） |
| exit_plan_mode 批准 → 下一步 | 投影 active=false；planWanted=false → 豁免结束 + guidance 自动切回 cybernetics 段（无额外接线） |
| exit_plan_mode "keep planning" | pendingIntents 未清，plan 持续；豁免保持、cybernetics 段持续抑制 |

测试落点：`test/` 现有 vitest 结构，新增 `test/plan-precedence.test.ts`，用 duck-typed 假
sessionProjections（模式参照 sessionMode 注释与现有 projection 测试）。

## 6. 验收标准

1. plan 会话（allowlist 部署）能完整走 `/plan on → 只读调研 → exit_plan_mode → 用户批准` 全链路，
   中途 cybernetics 工具零调用（**v0.10.0 修订**：写工具在 plan 期间豁免可达——按用户裁定，
   plan 纪律由 guidance + plan:policy 承担；验收只查"零 goal 创建、零实际写操作"，
   不再查"零写工具可达"）。
2. 批准后第一条实施消息由 goal 循环承接（会话出现 goal，task agent 执行）；同会话下一请求
   写工具重新被摘除/deny（豁免自动恢复配置状态，无需手动操作）。
3. `/cybernetics off` × plan 与 全 off 会话行为与本方案落地前完全一致（回归）。
4. 矩阵 §5 全绿；`pnpm test` 全量通过。
