# cybernetics 子 agent 模型分配机制 — 调查报告

调查日期：2026-11-06 · 调查对象：本仓库（@mars.liu/dsh-cybernetics，branch `wt/auto-model`，HEAD `f5a0ea4` v0.15）+ 宿主安装包（`/Users/mars/.dsh/profiles/web/node_modules/@deepseek-ai/`）

## 结论速览

子 agent 模型分配是一条五层流水线：**配置入口 → 轮脚本角色匹配 → workflow agent() 接缝 → 子 agent 选项解析 → 调用级回退**。默认语义是「继承 session agent 的当前模型路由」；三类角色（task/verify/triage）与命名角色可逐角色覆盖 provider/model/reasoningEffort；覆盖模型不可用时按可用性失败回退到 session 模型重试一次，全程留审计。

## 第 1 层：配置入口（两个入口折叠为一个 canonical 形状）

代码：`src/index.ts` schema（:184-239）与折叠处（:1599-1633）；`src/controller.ts` `parseAgentModelSpec`（:76-86）/ `sanitizeReasoningEffort`（:96-101）。

| 入口 | 字段 | 生效方式 | 形状 |
|---|---|---|---|
| 扁平 volatile（GUI 设置卡片） | `taskAgentModel` / `verifyAgentModel` / `triageAgentModel` | 保存即时生效，下一轮 goal 读取 | `"provider/model"` 或裸模型名；空 = 继承 session agent |
| 扁平 volatile（v0.15） | `taskAgentReasoningEffort` / `verifyAgentReasoningEffort` / `triageAgentReasoningEffort` | 同上 | 档位 id；`''` = 模型默认（不发送） |
| `roles` dict（v0.8.4 起非 volatile） | 任意角色键（default/verify/triage/frontend/…） | 编辑 profile yaml + 宿主重载 | `role -> {provider, model}` |

折叠规则（每轮启动时执行）：
1. `roleOverrides = { ...readConfigField(config.roles, {}) }` — `readConfigField` 同时接受普通对象（非 volatile）与 live reference（volatile）。
2. 扁平模型字段经 `parseAgentModelSpec` 解析后**浅合并**覆盖 `roles.default` / `roles.verify` / `roles.triage`（`{ ...旧, ...新 }`，模型字段不清除 roles 里已有的 provider）。
3. 扁平 effort 字段经 `sanitizeReasoningEffort` 净化后并入同一角色：非字符串 / 空白 / 超 64 字符 / 非 `[A-Za-z0-9._-]` token 一律 DROP（= 不发送 = 模型默认档位），坏配置退化而非投毒。
4. 产物 `ControllerConfig.roles` 经 `startRound`（controller.ts:378 `roles: config.roles ?? {}`）注入轮脚本 args。

当前 live 部署（`/Users/mars/.dsh/profiles/web/cordis.patch.yml:549-557`，无 roles 块）：
- task = `zai-coding-cn/glm-5.3-flash` + effort `high`
- verify = `zai-coding-cn/glm-5.3` + effort `max`
- triage = `zai-coding-cn/glm-5.3-flash` + effort `low`

## 第 2 层：轮脚本角色匹配（workflows/round.js）

- `specFor(roleKey)`（:32-40）：task agent 查 `roles[本轮 role]`（默认 `'default'`）；verify/triage 固定查 `'verify'` / `'triage'`。三个字段（provider/model/reasoningEffort）任一存在才生成 spec，否则 `{}`。
- 「仅 effort 无模型」是合法形态（v0.15）：agent 保留 session 模型，只钉思考档位。
- `callRoleAgent`（:97-118）：`agent(prompt, { ...opts, ...spec })` — spec 直接展开为 workflow `agent()` 调用选项。
- quick 深度只调用 task 角色 → verify/triage 覆盖在 quick 轮从不生效。

## 第 3 层：workflow `agent()` 接缝（@deepseek-ai/dsh-workflow-ptc）

- 脚本可用选项白名单 `SUPPORTED_AGENT_OPTIONS = { label, phase, schema, provider, model, reasoningEffort }`；白名单外抛 `WorkflowError(UNSUPPORTED_OPTION)`（fatal，绝不换模型）。**注意**：`reasoningEffort` 不在宿主原版白名单里——是本仓库 `effort-patch/`（v0.15）对已安装 ptc 包打的 7 处接缝补丁（guest 源字符串内 4 处 + 宿主侧 3 处）；证据：`…/dsh-workflow-ptc/lib/index.js.bak-v015effort-20261105163035` 备份文件、`effort-patch/README.md`。宿主升级/`pnpm install` 会覆盖补丁，需 `effort-patch/apply-ptc.mjs check|apply|verify` 重放。
- 非字符串的 provider/model/reasoningEffort 抛 `INVALID_ARGUMENT`。
- 传递链：guest `startAgent(request)` → 宿主 `childRequest` 解析（ptc lib/index.js:151-166）→ `startChild`（:337-352）调 `subagents.startActivation({ provider: this.provider, …, request: { cwd, prompt, parent, outputSchema?, agentOptions?: { provider?, model?, reasoningEffort? } } })`。三者全空则整个 `agentOptions` 键省略。
- **歧义澄清**：`startActivation` 顶层的 `provider`（默认 `'spawn'`，ptc lib/index.js:601 `provider: z.string().default("spawn")`）是 dsh-subagent **传输层**注册名（spawn-in-process），不是 LLM provider；LLM 路由只走内层 `agentOptions`。

## 第 4 层：子 agent 模型解析（@deepseek-ai/dsh-subagent `resolveChildAgentOptions`，lib/index.js:315-334）— 机制核心

```js
function resolveChildAgentOptions(parent, requested, childDepth) {
  const parentOptions = parentAgentOptionsForDelegation(parent);   // 继承基线
  const resolved = {
    ...parentProvider, ...parentModel, ...parentReasoningEffort, ...parentMaxTokens,
    ...requested,                    // per-child 覆盖浅合并 WIN
    subagentDepth: childDepth,
  };
  // 路由变了但没显式带 effort → 删掉继承的 effort（新模型解析自己的默认档位）
  if ((resolved.provider !== parentProvider || resolved.model !== parentModel)
      && requested?.reasoningEffort === undefined) delete resolved.reasoningEffort;
  return resolved;
}
```

继承基线 `parentAgentOptionsForDelegation`（:258-275）：
- **有请求头时**：取 parent **最新请求头**（`requestHeader().config`）的 provider/model/reasoningEffort——即「session agent 现在实际跑在什么模型上」；创建期的同名 options 被丢弃；`maxTokens` 恒继承创建 options。
- 无请求头（尚未发过首请求）：回退 parent 创建 options。

最终去向：`ctx.agents.create({ agentOptions, … })` 创建子会话；`snapshotSubagentDescriptor` 把 `agentProvider/agentModel/agentReasoningEffort` 写进 `subagent/descriptor` 会话事件（可在子 session 日志核对）。最后一跳：`dsh-agent-loop`（lib/index.js:1184）`reasoningEffort = options.reasoningEffort ?? persistedReasoningEffort`，`dsh-llm` 适配器解析档位，不支持的档位在 provider 侧抛错 → 回到第 5 层回退。

## 第 5 层：调用级回退（v0.8 起，round.js `callRoleAgent` + `isAvailabilityFailure`）

**触发前提**：该角色配置了覆盖（provider/model/reasoningEffort 任一）。无覆盖时 null/失败维持原语义（本来就跑 session 模型，无处可退）。

| 触发信号 | 判定 |
|---|---|
| `WorkflowError` code `AGENT_START`（provider 解析/spawn/首调失败） | 恒为可用性失败 |
| `AGENT_RESULT` 或无 code 错误，消息命中 `AVAILABILITY_PATTERNS`（:65-80） | 限流 429 / 配额额度 / 鉴权 401 403 / 5xx overloaded / 网络族 / `no subagent provider registered`（v0.8）/ 模型未订阅形态 `model not found|no such model|unknown model|not subscribed|…`（v0.8.3）/ effort 不被支持形态 `reasoning.?effort|unsupported effort|…`（v0.15） |
| `agent()` 返回 `null`（runtime 把子 run stopReason≠completed 压成 null，不透传原因） | 疑似覆盖模型不可调用 |

动作：撤销覆盖、**不带 spec 重调一次**（= 继承 session agent 模型 + 该模型默认 effort）；重试再败降级为 null（沿用「本轮无结果」路径）。逻辑失败（task 报 done=false、verify 未达成 verdict）从不触发回退。非可用性错误（INVALID_ARGUMENT / UNSUPPORTED_* / AGENT_CAP）原样上抛。

审计三通道：
1. `fallbacks` 数组随轮结果返回（`withFallbacks`）；
2. `foldRound → writeRoundLog` 落盘 `.cybernetics/round-<goalId>-<n>.json`（controller.ts:285-292）；
3. controller 决策 note 后缀 `⚠ 模型回退 N 次：role(from→session 模型，trigger)`（`fallbackSuffix`，controller.ts:439-447）+ `log()` 进 workflow/log 事件流。

## 特殊路径与例外

- **persistent executor（v0.6 teammate）**：`startTeamRound`（src/executor.ts:302-309）`spawnTeammate` 请求只有 name/description/prompt/context:'fresh'/provider:'spawn'/signal——**不带 agentOptions** → teammate 经 `resolveChildAgentOptions(parent, undefined)` 继承 Team Lead（session agent）模型。roles 覆盖对 teammate 本体**无效**，只作用于其后的 verify/triage ephemeral agent（executor.ts:374-392 把 `roles` 传给 round.js `taskReport` 分支）。
- **命名角色**：`cybernetics` 调用传 `role:'frontend'` 时 task agent 查 `roles.frontend`，无则回 `roles.default`——不存在时 `{}` = 继承。
- **effort 归属规则**（第 4 层）意味着：roles 里「只配 provider/model 不配 effort」会丢掉 session agent 的 effort；「只配 effort 不配模型」保留 session 路由只换档位。

## 验证证据

1. `node test/v03-offline.mjs` → **ALL 75 CHECKS PASSED**（含 #59 AGENT_START 回退、#63 可用性矩阵：quota/network/5xx→回退，逻辑错误/cap/option 错误→上抛不换模型、决策 note「模型回退 1 次」断言、triage 覆盖回退区段）。
2. 本轮 goal 自身即机制产物：本 task agent 会话 runtime context 声明 "powered by the glm-5.3-flash model"，与 live 配置 `taskAgentModel: zai-coding-cn/glm-5.3-flash`（roles.default）一致；轮脚本以 `task:default` 标签派生（goal 板 `.cybernetics/board-session-7b92644a-*.json` 记录 4 个 goal 的 task:default 子 agent）。
3. 接缝补丁证据：宿主 `dsh-workflow-ptc/lib/index.js` 现行版本含 `reasoningEffort`（白名单/校验/透传 3 处），备份 `index.js.bak-v015effort-20261105163035` 为打补丁前版本。
4. 模型目录档位元数据：live `cordis.patch.yml:48-76` glm-5.3 / glm-5.3-flash 均带 `reasoningEfforts: {off,minimal,low,medium,high,max}` + `compat.supportsReasoningEffort: true`——设置卡片 effort 下拉的数据源（与会话模型选择器同一目录 `remote.session.modelCatalog()`）。

## 偏差记录（委托书 vs 现实）

无重大偏差。三点补充事实：(1) 工作区即插件源码仓库本身（非宿主检出），宿主侧证据取自 `@deepseek-ai` 安装包（`/Users/mars/.dsh/profiles/web/node_modules/`）；(2) v0.15 的 reasoningEffort 接缝是**插件对已安装宿主包的运行时补丁**，非上游能力，宿主升级会丢失（effort-patch/README.md「风险」节明示）；(3) `effort-patch/stage/` 中 3 个文件（src/index.ts / src/controller.ts / workflows/round.js）是打补丁前快照，README 明确警告勿重跑 `apply.sh`（会把过期快照覆盖回 live install），ptc 接缝重装只走 `apply-ptc.mjs`。
