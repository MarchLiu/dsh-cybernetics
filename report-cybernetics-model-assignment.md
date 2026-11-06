# cybernetics 子 agent 模型分配机制调查报告

调查对象：DSH 实现检出目录 `/Users/mars/.dsh/profiles/web/`（monorepo）+ cybernetics 插件源码仓库（本 worktree，HEAD = f5a0ea4 v0.15）。
调查方式：纯只读代码调研 + 离线测试复跑验证。未修改任何被调查代码。

## 与委托书的偏差（以真实状态为准）

1. cybernetics 不在检出目录的 `packages/` 下，而是**外部 link 包**：`profiles/web/package.json:57` 以 `link:/Users/mars/jobs/dsh-cybernetics` 挂载，`cordis.patch.yml:537` 注册插件行 `@mars.liu/dsh-cybernetics`。源码仓库即当前 worktree（`/Users/mars/jobs/dsh-cybernetics` 与本 worktree 同一提交）。
2. 委托书假设「按难度选模型」是**未来需求**；实际上 v0.15 已实现**按角色（settings/配置驱动）的模型+思考强度选择**全链路（含对宿主 `dsh-workflow-ptc` 的 out-of-tree 补丁，见 `effort-patch/`）。真正缺的只是「session agent 每轮通过工具参数指定」这一入口。
3. 插件 `package.json` version 仍为 `0.13.0`，但 git 提交已到 v0.15（版本号未随提交递增，属小的不一致）。

## 问题 1：task/verify/triage 由谁创建 —— 程序行为，非 session agent LLM 输出

**结论：三者全部由插件代码在轮次编排里程序化 spawn。session agent 的 LLM 只调用一次 `cybernetics` 工具（并负责撰写 brief/objective/subgoal 等文本参数），从不发出 task/verify/triage 的 spawn 调用。**

证据链（一次性调用 → 三个子 agent 全由代码顺序驱动）：

1. 工具入口：`src/index.ts:1344-1401` 工具 schema（参数仅 action/goalId/title/brief/subgoal/depth/role/reason/objective/abortPrevious/executor）；`execute` 位于 `src/index.ts:1442`。
2. 阻塞轮路径：`src/index.ts:1857-1874` `startAnyRound(loop)` → `await handle.result` → `foldRound(...)`；后台路径 `launchBackground`（`src/index.ts:1693`）同理。
3. substrate 选择：`src/index.ts:1667-1686` `startAnyRound`：`executor==='persistent'` → `startTeamRound`；否则 → `startRound`（controller.ts）。
4. ephemeral 轮启动：`src/controller.ts:354-385` `startRound` = `engine.start({ script: workflows/round.js, args: { goal, state, subgoal, brief, depth, role, roles } })`——一次 workflow 引擎 run。
5. 三个子 agent 的实际创建点：`workflows/round.js` 脚本内三次调用 workflow runtime 的 `agent()` 钩子——task（`round.js:206-239`，label `task:<role>`）、verify（`round.js:265-293`）、triage（`round.js:301-327`）；`depth==='quick'` 时跳过 verify/triage（`round.js:248-261`）。
6. persistent 变体：`src/executor.ts:262-408` `startTeamRound` 用 `ctx.agentTeams.spawnTeammate`（`executor.ts:302-309`）创建持久 teammate（仍是程序调用），verify/triage 仍走 round.js（以 `taskReport` 参数喂入，`executor.ts:374-392`），保证验证不继承任务叙事。

角色归属的可观测面：`src/agents.ts:80-85` `roleOfLabel`（`task:`/`verify`/`triage` label → 角色），经 `workflow/agent-start|end` 事件记录到 goal 板（`src/agents.ts:139-161`）。

## 问题 2：模型与推理强度如何确定 —— 已有 per-role 配置链

**结论：每个子 agent 的 provider/model/reasoningEffort 由「部署配置 roles 表 + 设置面板平面字段」在每轮启动时折叠成 `roleOverrides`，随 workflow args 下发给轮脚本；`role` 参数决定 task agent 读哪一行，`depth`/`executor` 不影响模型选择。**

配置来源（两层，逐轮生效）：

- profile 配置 yaml（非 volatile，`src/index.ts:200-203`）：`roles: { [role]: { provider, model } }`，支持命名任务角色（frontend 等）。
- 设置面板 volatile 字段（`src/index.ts:217-227` 模型三字段、`:237-239` v0.15 思考强度三字段 `taskAgentReasoningEffort`/`verifyAgentReasoningEffort`/`triageAgentReasoningEffort`）：保存即时生效、下一轮 goal 生效。
- 折叠点：`src/index.ts:1608-1633`——`parseAgentModelSpec`（`src/controller.ts:76-86`，"provider/model" 或裸模型名）解析平面字段合并进 `roles.default/verify/triage`；`sanitizeReasoningEffort`（`src/controller.ts:96-101`）净化档位 id（非法值静默丢弃=不发送=模型默认）。
- 下发：`src/controller.ts:378` `roles: config.roles ?? {}` 进入 workflow args。
- 消费：`workflows/round.js:32-40` `specFor(roleKey)` 按 roleKey 取 spec；`round.js:97-118` `callRoleAgent` 把 `{provider, model, reasoningEffort}` 与 `{label, schema}` 合并传给 `agent()`。task 用 `role ?? 'default'` 行（`round.js:206`），verify/triage 用各自同名行。
- 默认值：无配置 = 空 spec = 不传覆盖 = 子 agent 继承 session agent 的路由（见问题 3）。
- 回退（v0.8 调用级模型回退）：覆盖模型可用性失败（WorkflowError AGENT_START、限流/quota/鉴权/5xx/网络/effort 不支持等模式，`round.js:65-80`，effort 模式在 `:74`）或返回 null 时，撤销覆盖以 session 模型重试一次，记入 `fallbacks` 审计（`round.js:101-117`、类型 `src/controller.ts:23-41`、决策注记 `src/controller.ts:439-447`）。

**`depth`/`executor` 对模型选择的影响：均无。** depth 只决定 verify/triage 是否运行（quick 跳过）；executor 只决定 task 基质。特别地，persistent teammate 的 spawn 调用（`executor.ts:302-309`）**不携带任何 provider/model/effort**——`roles` 配置对持久 teammate 不生效（现存缺口，见问题 4 风险）。

## 问题 3：运行基质与参数传递链

**结论：ephemeral 子 agent = PTC 隔离子进程里的 workflow 脚本，经 JSON 回调回到宿主，由 dsh-subagent 创建真实的可续聊子 agent 会话（in-process agent loop）；provider/model/reasoningEffort 以 `agentOptions` 字段在 spawn 请求中传递并落进子会话持久 descriptor。**

完整链路（ephemeral，即默认基质）：

1. `engine.start()`（dsh-workflow）→ PTC 运行时 `dsh-ptc-runtime-node` 以 `ctx.subprocess.spawn`（`dsh-ptc-runtime-node/lib/index.js:1153,1621`）启动受限 Node 子进程；round.js 在 `node:vm` 沙箱 realm 中执行（dsh-workflow-ptc 内嵌 guest 源）。
2. 脚本 `agent(prompt, opts)` → PTC guest 校验白名单 `SUPPORTED_AGENT_OPTIONS`（label/phase/schema/provider/model/**reasoningEffort**——后者为本仓库 `effort-patch/` 对宿主 `dsh-workflow-ptc/lib/index.js` 的 out-of-tree 补丁所加；补丁前原文件备份 `.bak-v015effort-20261105163035`，diff 确认 7 处替换）→ `host.startChild(request)` JSON 回调跨进程边界。
3. 宿主侧 workflow-ptc：解析校验 `request.reasoningEffort`（`text()` 校验），组装 `agentOptions: {provider, model, reasoningEffort}`（三者皆空才省略）。
4. `dsh-subagent/lib/index.js:1400-1451` spawn 路径：`resolveChildAgentOptions(parent, request.agentOptions, childDepth)`（`:313-330`）——子 agent 继承父的 provider/model/reasoningEffort/maxTokens，请求覆盖叠加其上；**换路由但未显式给 effort 时清除继承的 effort**（`:329`，档位 id 是模型相关的）。覆盖值持久化进子会话 descriptor（`agentProvider/agentModel/agentReasoningEffort`，`:1410-1418`；恢复路径 `:2172-2175`）。
5. LLM 请求层：`dsh-agent-loop/lib/index.js:1178-1195` `prepareRequest` 将 `options.reasoningEffort` 写入请求头 config；`dsh-llm-deepseek/lib/index.js:1718-1732` 解析 `options.reasoningEffort ?? connection.defaults ?? 默认`，校验失败抛 `UNSUPPORTED_REASONING_EFFORT`，映射为 `thinking:{type:enabled}` + `output_config:{effort}`。档位目录：`REASONING_EFFORTS` off/low/high/max（`dsh-llm-deepseek/lib/index.js:476-497`），随模型 catalog 暴露 `reasoning:{efforts,defaultEffort}`（`:538-545`）——设置页 effort 下拉的数据源（`lib/client.js`，v15 测试覆盖）。

persistent 基质：Agent Teams 成员（`ctx.agentTeams.spawnTeammate`，`context:'fresh'`），跨轮存活、按轮 `sendMessage` 续指令（`executor.ts:317-321`）；其模型选择今天不在 cybernetics 的 spawn 调用面上（Agent Teams 工具自身的 roster 行虽暴露 provider/model 字段，`dsh-experimental-tool-agent-team/lib/index.js:62-67`，但 cybernetics 未传）。

## 问题 4：可行性评估 —— 架构可行，且大半已就位

**结论：让 session agent 在发起一轮时按任务难度为 task/verify/triage 各自指定模型与推理强度，架构上完全可行。下游全链路（roles → round.js specFor → workflow agent() → workflow-ptc → dsh-subagent agentOptions → LLM 请求）已在 v0.15 打通；唯一缺口在插件最上层——工具 schema 与轮状态没有 per-call 的模型参数。**

现状缺口：
- 工具 schema（`src/index.ts:1344-1401`）无任何 model/effort 参数；
- `LoopState`（`src/controller.ts:146-194`）与 `GoalSeed`（`:271-282`）无 per-goal 模型字段，`startRound` 只传全局 `config.roles`（`:378`）。

建议改动点清单（全部限于 dsh-cybernetics 插件，预估 100–200 行 + 测试）：

| # | 层 | 位置 | 改动 |
|---|---|---|---|
| 1 | 工具 schema | `src/index.ts:1344-1401` | 增加可选参数，如 `models?: { task?/default?, verify?, triage?: { provider?, model?, reasoningEffort? } }`（复用 `RoleSpec` 形状） |
| 2 | 轮/目标状态 | `src/controller.ts` `LoopState`/`GoalSeed`/`createGoal` | 决定覆盖语义：per-轮一次性（像 brief，最简）或 per-goal 持久（进 `createGoal` 继承链，像 depth/executor） |
| 3 | 折叠点 | `src/index.ts:1608-1633` | 把 per-call 覆盖**合并于** `roleOverrides` 之上（配置保持默认层），复用 `parseAgentModelSpec`/`sanitizeReasoningEffort` 净化 |
| 4 | 下发 | `src/controller.ts:378` | 无需改——`args.roles` 已是该形状（把合并结果作为 `roles` 传入即可） |
| 5 | 轮脚本 | `workflows/round.js` | **零改动**（`specFor`/`callRoleAgent`/回退已支持 reasoningEffort-only spec） |
| 6 | 宿主 | dsh-workflow-ptc / dsh-subagent | **零改动**（v0.15 effort-patch 已落地；`agentOptions` 原生支持） |
| 7 | 提示与文档 | 工具 description、README、locale、docs/protocol.md | 让模型知道何时用、档位 id 合法值随目标模型 |
| 8 | 审计 | round 日志 | 记录本次 per-call 覆盖（fallbacks 已有审计先例，`controller.ts:23-41`） |

可复用的现有机制：
- `RoleSpec`/`RolesConfig` 形状与 `specFor` 消费端（controller.ts:57-109 / round.js:32-40）；
- `parseAgentModelSpec`+`sanitizeReasoningEffort` 净化（controller.ts:76-101）；
- v0.8 调用级回退 + fallbacks 审计（round.js:97-118）——effort 不被模型支持时的降级已存在（AVAILABILITY_PATTERNS `round.js:74`）；
- taskboard 任务的 `{provider, model, reasoningEffort?}` model 字段（宿主 dsh-taskboard）是同构先例，说明 per-execution 模型指定在该代码库中是成熟模式。

风险点：
1. **effort 静态不可校验**：档位有效性依赖目标模型 catalog（off/low/high/max 仅对 DeepSeek 适配器成立；其他 provider 如 `dsh-llm-pi-ai` 另有自己的档位）。靠 sanitize + 运行时回退兜底，属可接受的降级路径，但工具 description 应说明「无效档位将回退模型默认并记入审计」。
2. **换路由清 effort 规则**（dsh-subagent:329）：指定新模型但未给 effort 时继承的 effort 被清除——这是正确行为（档位 id 模型相关），per-call 语义文档需写明「模型与档位应成对指定」。
3. **persistent executor 盲区**：teammate spawn 不接受模型覆盖——session agent 在 `executor:'persistent'` 下指定 task 模型会静默不生效。要么在工具层显式报错/警告，要么推动 agentTeams.spawnTeammate 增加 agentOptions（后者是宿主侧改动，量级更大）。
4. **成本治理**：放开 per-call 模型指定等于给 session agent 开销自由度。可考虑配置白名单（只允许 roles 表里出现过的 provider/model）或仅允许 effort 调整；至少要像 fallbacks 一样进轮审计。
5. **宿主补丁的升级风险（现状，非新增）**：workflow-ptc 的 reasoningEffort 支持是 node_modules 内的 out-of-tree 补丁（`effort-patch/apply.sh` 可重放，`.bak-*` 可回滚），宿主升级会丢失，需重放或上游化。

## 验证证据

- 离线测试复跑：`node test/v15-effort-reasoning.mjs` → 5/5 通过（设置页 effort 行为全链路 fixture 测试）；`node test/v03-offline.mjs` → **ALL 75 CHECKS PASSED**（含 v0.8 回退、goal-agent 追踪、hardGate 热装卸等）。
- 宿主补丁 diff：`diff dsh-workflow-ptc/lib/index.js.bak-v015effort-20261105163035 dsh-workflow-ptc/lib/index.js` 确认 SUPPORTED_AGENT_OPTIONS/startAgent/childRequest/agentOptions 四段 reasoningEffort 透传。
- 关键代码路径行号均来自本 worktree HEAD（f5a0ea4），与 `/Users/mars/jobs/dsh-cybernetics` 同提交。
