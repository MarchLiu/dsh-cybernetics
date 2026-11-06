# 调查报告：cybernetics 子 agent 模型分配机制

调查时间：2026-11-06 · 工作区：`/Users/mars/.dsh/worktrees/dsh-cybernetics-fdba90e4/auto-model`（branch `wt/auto-model`，HEAD `f5a0ea4` v0.15）
宿主实现：`/Users/mars/.dsh/profiles/web/`（dsh-workflow-ptc 0.2.1-rc.3 / dsh-subagent / dsh-experimental-agent-team）

## 一句话结论

模型分配是**四层透传 + 一层回退**：配置层（扁平字段/roles 表折叠）→ 控制器（startRound 注入 args.roles）→ 轮脚本（specFor 取角色 spec，callRoleAgent 可用性失败回退）→ workflow runtime（agent() opts 白名单校验）→ subagent runtime（resolveChildAgentOptions 继承父会话路由、子请求覆盖）。persistent 执行器（teammate）是唯一不经过该机制的子 agent——它的 spawn 请求不含任何模型覆盖字段。

## 1. 配置层（src/index.ts）

两组配置面，一个规范形状：

- **扁平字段**（volatile，设置卡片唯一可写面，保存即下轮生效）：
  `taskAgentModel` / `verifyAgentModel` / `triageAgentModel`（`"provider/model"` 或裸模型名，`''` = 继承 session agent）；
  v0.15 增加 `taskAgentReasoningEffort` / `verifyAgentReasoningEffort` / `triageAgentReasoningEffort`（`''` = 模型默认档）。
- **roles 表**（v0.8.4 起非 volatile，只经 profile yaml 配置）：`role -> {provider, model, reasoningEffort?}`，
  支持固定槽位 `default/verify/triage` + 任意命名任务角色（如 `frontend`）。

每轮启动时折叠（src/index.ts:1599-1633）：`roleOverrides = {...roles}` → `parseAgentModelSpec` 解析扁平模型字段**覆盖合并**到 `default/verify/triage` → `sanitizeReasoningEffort`（token 形状校验，损坏值丢弃=默认档）合并 effort → 产出 `controllerConfig.roles`。`args.role`（cybernetics 工具调用）选择 task agent 的角色键。

解析语义（src/controller.ts:76-86 `parseAgentModelSpec`）：`a/b` → `{provider:'a', model:'b'}`；裸名 → `{model}`；空/空白/`a/`/`/m` → 按裸名或继承。测试 55 逐条钉死。

## 2. 控制器层（src/controller.ts `startRound`）

每轮 `engine.start({args: {..., roles: config.roles ?? {}}, ...})`（controller.ts:378）——roles 原样注入轮脚本 args。

## 3. 轮脚本层（workflows/round.js）

- `specFor(roleKey)`（round.js:32-40）：查 `roles[roleKey]`，仅透传存在的键（provider/model/reasoningEffort 任一即可，effort 可单独存在=保 session 模型只钉档位）；无配置 → `{}`（不传 = 继承）。
- task agent 用 `roles[args.role ?? 'default']`，verify 用 `roles.verify`，triage 用 `roles.triage`；quick 轮完全跳过 verify/triage（triageAgentModel 仅 full 轮生效）。
- **调用级模型回退**（v0.8/v0.15，`callRoleAgent` round.js:97-118）：仅当该角色配置了任一覆盖时，
  - 抛出可用性失败（`AGENT_START` 恒算；`AGENT_RESULT`/无 code 错误需命中 `AVAILABILITY_PATTERNS`：provider 未注册/模型不存在/**effort 不被支持**/429/限额/401/403/5xx/网络）→ 撤销覆盖以 session agent 模型重试一次；
  - 返回 `null`（子 run stopReason ≠ completed 被压平、原因不透传）→ 同样回退重试。
  - 逻辑失败（done=false、未达成 verdict）永不换模型；非可用性错误原样上抛；重试再失败降级为 null（沿用"本轮无结果"）。
  - 每次回退记录 `{role, from: spec, trigger: 'availability-error'|'null-result', reason}` 进轮结果 `fallbacks`，narrate 进 `workflow/log`，落盘 `.cybernetics/round-<goalId>-<n>.json`，并经 `fallbackSuffix` 追加进控制器决策 note（`⚠ 模型回退 N 次：role(覆盖→session 模型, 触发)`，controller.ts:439-447）。回退重试调用不带 spec → effort 也一并回退为 session 配置。

## 4. workflow runtime（@deepseek-ai/dsh-workflow-ptc）

- `agent()` opts 白名单 `SUPPORTED_AGENT_OPTIONS = {label, phase, schema, provider, model, reasoningEffort}`（未知键 `UNSUPPORTED_OPTION` fatal）。
- **两个 provider 概念严格分离**：`request.provider/model` 是 LLM 目标覆盖；引擎级 `subagentProvider`（Config 默认 `'spawn'`）只是子 agent 的**传输通道**选择（`resolveSubagentProvider`，ptc index.js:573-578）。
- 子 agent 启动：`subagents.startActivation({provider: 'spawn', request: {..., agentOptions: {provider?, model?, reasoningEffort?}}})`——三者全空时**整个 agentOptions 键不出现**（ptc index.js:345-349），即纯继承路径。

## 5. subagent runtime（@deepseek-ai/dsh-subagent）——继承基线的定义处

`resolveChildAgentOptions`（child-agent.js）：

- **继承基线**：`parentAgentOptionsForDelegation(parent)` 读父会话**最新 request header 的 config**（provider/model/reasoningEffort——含会话中途切模型后的当前路由），其余创建选项（maxTokens）从创建选项兜底。"与 session agent 一致" = 父会话 spawn 时刻实际运行的路由，不是 preset 默认。
- **合并**：父值打底，`requested`（来自 agentOptions）覆盖在上；打上 `subagentDepth`。
- **effort 清除规则**：解析出的路由（provider/model）变了但请求未显式点名 effort → 删除继承的 `reasoningEffort`（换模型不换档位语义 = 新模型用自己的默认档）；显式点名则跨路由保留。
- 结果经 `agents.create(agentOptions)` 成为子会话路由，descriptor 快照记录 `agentProvider/agentModel/agentReasoningEffort`（可观测，喂 subagentCatalog/goal tab）。

## 6. persistent 执行器缺口（src/executor.ts）

`startTeamRound` 的 teammate 创建：`teams.spawnTeammate(parent, {name, description, prompt, context:'fresh', provider:'spawn', signal})`——`provider` 是传输通道（必填字符串），**激活请求完全不含 agentOptions**（dsh-experimental-agent-team `spawnAdmitted`：`startActivation({request: {prompt, parent}})`）。宿主侧 spawnTeammate 请求形状只有 name/description/prompt/context/provider/signal，**不存在每成员模型覆盖字段**。
另外 `buildWorkOrder(input, config.roles)`（executor.ts:165）声明了 roles 参数但函数体从未使用。
结论：**persistent 模式下 task teammate 恒运行在继承路由上**，roles/taskAgentModel 及其回退审计对它不生效；verify/triage 仍走 round.js（executor.ts:387 传 `roles: config.roles`），覆盖不受影响。

## 7. 当前部署实际配置（/Users/mars/.dsh/profiles/web/cordis.patch.yml:542-560）

```yaml
dsh-cybernetics:
  taskAgentModel: zai-coding-cn/glm-5.3-flash      # effort: high
  verifyAgentModel: zai-coding-cn/glm-5.3          # effort: max
  triageAgentModel: zai-coding-cn/glm-5.3-flash    # effort: low
  gateMode: allowlist, hardGate: true, allGoalsMode: true
```

即"快模型干 task、强模型验收、快模型低档分拣"的实际分工。

## 8. 验证证据

- `node test/v03-offline.mjs` → **ALL 75 CHECKS PASSED**；模型分配直接相关：#55（解析/折叠/wiring）、#59-64（回退矩阵：AGENT_START/429 quota/null-result/逻辑失败不换模型/决策 note+审计落盘）、#67（triageAgentModel + quick 轮跳过）、#68（模型下拉+失效模型处理）、#69（roles 高级配置）。
- `node test/v15-effort-reasoning.mjs` → 5/5 通过（effort 下拉数据源/不支持档位/失效档位回退显示）。
- 宿主侧代码证据：ptc `SUPPORTED_AGENT_OPTIONS`/`startChild`（dsh-workflow-ptc/lib/index.js:145-157, 333-349）、`resolveChildAgentOptions`（dsh-subagent/lib/index.js:315-339）、`spawnAdmitted`（dsh-experimental-agent-team/lib/index.js:1004-1053）。

## 9. 值得注意的边界行为（调查中发现，非缺陷即事实）

1. effort 覆盖可与模型覆盖解耦（`specFor` 允许只有 reasoningEffort）；
2. 换模型不换档：子请求未点名 effort 且路由变化时，继承 effort 被宿主删除（新模型默认档）——插件侧回退重试不带 spec，天然符合该语义；
3. `sanitizeReasoningEffort` 在折叠期丢损坏档位（防御性），provider 拒绝档位时由轮脚本可用性模式（`/reasoning.?effort|.../i`）兜底回退；
4. teammate 的 `buildWorkOrder` roles 参数是死参数（见 §6，persistent 模型覆盖缺口）。
