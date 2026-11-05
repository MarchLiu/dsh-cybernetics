# 子代理审批透传（gateApprovalRelay）调查与设计 — 2026-11-04 v0.8.5

> 目标：hardGate 模式下，委派子代理（workflow task/verify/triage、teammate）的沙箱越权请求
> 必须能真正弹到用户 GUI，而不是被宿主/客户端的既有应答链静默吞掉。
> 本文记录代码级证据（宿主版本 0.2.1-rc.3，路径 `~/.dsh/profiles/web/node_modules/@deepseek-ai/`）、
> 根因判定、取舍与验证方式。

## 1. 现象与事实

- 子代理访问会话工作区之外的路径（如 `~/.dsh/profiles/web/cordis.patch.yml`）时，工具层
  `sandbox_permissions` 升级会走 `ctx.approval.request(...)`（`dsh-tools/lib/index.js:3551`、
  `dsh-sandbox/lib/index.js:99-120`），但用户看不到任何提示，子代理只能失败/回退人工。
- 真机证据（本任务子代理 session `18168d3c` 的 `session.v4.jsonl.zstd`）：seq 2 是
  `approval/policy {policy:'never', source:'delegation'}`，seq 3 是插件 `agent/created`
  监听追加的 `{policy:'ask'}`（相隔 52 ms）——**第一跳（解除钉死）在真实宿主上有效**；
  失败点在第二跳（请求送达用户）。

## 2. 宿主机制（代码证据）

| 环节 | 证据 |
| --- | --- |
| 委派时审批策略被**钉死为 `never`** | `dsh-subagent/lib/index.js:413` `approvalPolicy: parent.ctx.get("approval") === undefined ? undefined : "never"`；`dsh-subagent/lib/types/child-agent.js:185,202`；`appendDelegatedPolicyOverrides` 把它写成 `approval/policy {source:'delegation'}`（`:430-432`） |
| `never` 在**任何 answerer 之前**确定性拒绝 | `dsh-user-approval/lib/index.js:172-176`：`decide()` 先 `if (effectivePolicy === 'never') return 'rejected'`，之后才 `waterfall('approval/request', ...)` |
| 审批请求必须落在**打开的回合**内 | `dsh-user-approval/lib/index.js:130`（`hasOpenTurn` 检查，audit 对必须 turn-enclosed） |
| 宿主把 `approval/request` 转发给浏览器 | `dsh-api-remotes/lib/index.js:21-28`（`API_REMOTE_FORWARDED_EVENTS` 含 `approval/request` waterfall）、`:147`（boot 时 `registerRemoteEvents`）、`:233-252`（`forwardWaterfall`：推入 client 队列并等待结果，client 不 delegate 就不 `next()`）；`dsh-api-gateway/lib/index.js:1105` 仅投递给 `answers` 的 owner client |
| 浏览器审批 answerer 的行为 | `dsh-client-ui-approval/lib/client.js:284-320`：`sessions.scopeOf(owner)` → 构造 `PendingApproval` → `uiSession.registerPendingInteraction` → **等待用户**；面板只渲染"当前打开会话"的 pendingInteraction（`dsh-client-ui-conversation/lib/client.js:17814`） |
| waterfall 由外向内执行 | `cordis/lib/index.js:317-325`：`dispatch()` 按注册顺序取监听器，`waterfall` 逐个 `shift`，外层不调用 `next()` 则内层永不执行 |

**结论（宿主没有现成的"审批委托"机制）**：`captureDelegatedPolicyOverrides` 只有
`'never'` 一种委派策略，没有 `inherit`/`approval: 'parent'` 之类的开关；子代理请求也不会自动改投父会话。
因此只能在插件侧中转。

## 3. 根因（最后一跳）

- 宿主 `api-remotes` 在 **boot 时**（bundle 顺序早于所有用户插件：
  `dsh-web-app/cordis.patch.yml:248-249`，profile `package.json` bundles 中 `dsh-cybernetics` 排在其后）
  就注册了 `approval/request` 监听器；cybernetics 的 relay 注册得更晚 ⇒ 在 waterfall 中处于**内层**。
- 子代理请求先到 `api-remotes` → 推给浏览器 → 浏览器 answerer **claim 子会话请求**并等待一张
  "用户根本看不见的 per-session 面板"（当前打开的是父会话），且**永不 `next()`**。
- 于是内层 relay 从来不会被执行：上一版"限时 `next()` + 超时转 userQuestions"的窗口逻辑是**死代码**，
  子代理只会挂在被 claim 的请求上。用户看到的现象就是"没有弹窗、任务失败"。

最小复现（真实 cordis，`new Context()`）：
外层监听器返回一个永不 settle 的 Promise、内层返回 `'allowed-once'`，`waterfall` 的 Promise 永不 settle；
给内层加 `{ prepend: true }` 后内层成为外层，立即返回 `'allowed-once'`（见 `test/relay-host-probe.mjs` 的
排序断言与 `test/v03-offline.mjs` 检查 70 的负向对照）。

## 4. 设计取舍

**采用：最外层 relay + 在顶层 session agent 上复用宿主的原生审批通道。**

- `ctx.on('approval/request', handler, { prepend: true })` —— 必须先于 `api-remotes` 拿到请求；
  这是唯一不依赖插件加载顺序的可靠位置。
- 只接管**委派子代理**（`session.header.origin === 'subagent'`；fork 有 `parentSession` 但独立成根，
  用 `delegationDepth > 0` 兜底区分）。
- 沿持久 `parentSession` 链向上解析**顶层活祖先**（`ctx.agents.get(parentSession)`，
  与 `dsh-experimental-agent-team/lib/index.js:873-876` 的同款解析一致），把请求用
  `ctx.get('approval').request({ agent: <顶层>, toolName, reason, displayReason, signal })`
  在该 agent 的会话上**重新发起**：
  - 面板就是用户熟悉的原生 "Allow once / Reject"（`dsh-client-ui-approval/lib/client.js:38-120`），
    渲染在用户正在看的会话里；该会话同时得到 `approval/asked` + `approval/decided` 审计对。
  - **不转发子代理的 `callId`**：那是子会话里的 tool call，不能与父会话 transcript 关联。
  - `displayReason`（本地化）写明 `Sub-agent <id> requests privileged execution of <tool>`，
    审计 `reason` 带 `[sub-agent <id>]` 前缀。
- 回退链：顶层回合已关闭（`ApprovalService.request` 抛 open-turn 错）→ 同一 agent 的
  `ask_user_question` 卡片（`ctx.userQuestions.ask`，不要求 open turn）→ 没有活顶层 agent 则 `next()`
  交给原生链（fail-closed 语义不变）。
- 失败语义：转发抛错 → 显式 `rejected`；子代理 signal 已中止 → `cancelled`；
  顶层审批返回 `unavailable`（无客户端）→ `unavailable`。绝不静默成功。
- **删除** `gateApprovalRelayTimeoutMs`：relay 不再与原生链赛跑，"等用户"就是普通审批的语义；
  调用方的 `signal`/工具超时负责取消。

**否决的方案**：
1. *保留限时窗口、抢在原生链之后* —— 内层永远轮不到，且 15s 空窗期内用户什么都看不到。
2. *只用 `ask_user_question` 转发* —— 能用，但问题卡片不是审批面板（措辞/按键/审计都不对），
   且不落在审批审计链上；作为"顶层回合已关闭"的回退保留。
3. *修改宿主 `api-remotes` 或客户端 answerer* —— 越出插件边界，且会改变所有插件的审批语义。
4. *把子代理策略改成 `never` 之外的持久继承* —— 宿主没有该能力，且子代理自身仍是"看不见的面板"。

## 5. 验证

- `node --experimental-strip-types test/v03-offline.mjs` → **ALL 71 CHECKS PASSED**（检查 70 重写：
  最外层注册、child→mid→root 攀爬、原生面板/问题/原生链三层回退、无 callId、
  排序回归 + 内层负向对照、opt-out、schema/README）。
- `node test/relay-host-probe.mjs` → 用**真机 cordis + 真机 `ApprovalService` + 真实插件 `apply()`**
  跑通：子代理 escalation 只落到顶层会话的审批通道（模拟浏览器只 claim 顶层、对子会话永不 delegate），
  顶层会话留下 `approval/asked`/`approval/decided`；顶层回合关闭时回退问题通道；顶层拒绝显式回传。
- 真机证据：本任务子代理 session 的 `approval/policy` seq 2/3（钉死 → ask），父会话在子代理运行期间
  处于 open turn（`turn/start` 无对应 `turn/end`）。

## 6. 已知边界

- **运行中的宿主仍加载旧构建**：`src/` 改动需宿主重载/重启后才生效；本轮无法在不打断当前
  goal round 的前提下重启宿主，因此 GUI 实测弹窗需在重载后复验一次（发一条越权子代理任务，
  看父会话是否出现 "Allow once / Reject" 面板）。
- 子代理**自己的会话面板不再被使用**（请求一律改投顶层会话）——这是有意的：那张面板正是"看不见的
  最后一跳"的成因；需要时仍可打开子会话，但那不是本次的交付路径。
- relay 只在 `hardGate: true` 时安装（`gateApprovalRelay` 是 hardGate 伴随项）。
