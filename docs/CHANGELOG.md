# 演进历史 / Changelog

> 本文件承接自项目早期的 README「状态」与「实测修正」记录，按版本倒序整理。
> 当下的功能与使用方式以 [README.md](../README.md) 为准；协议细节见 [protocol.md](protocol.md)。
> 约定：`src/` 改动需宿主重载生效；`lib/client.js` 改动需重启宿主（客户端模块图在宿主启动时构建）并刷新浏览器；`workflows/round.js` 改动热生效。

## v0.11.1（2026-11-05）：用户可见术语统一——「编排/orchestration」→「控制/control」

**需求**：用户 2026-11-05 提出——control 比 orchestration 更贴切（cybernetics = 控制论），且插件内已有「控制」标签页（`view.control`），同一概念两处叫法需要统一，同时避免与泛用的多 agent「编排」概念混淆。

**术语决策**：所有用户可见 UI 文案（lib/client.js zh/en 双字典 + `src/index.ts` 斜杠命令回执）统一为「控制模式 / Control」；`hardGate` 中文标签定为「硬控制门」（与「控制模式」保持同一词根，比保留「硬门」简写更可检索）；代码内部英文标识符与注释**不重命名**（避免无意义 diff），历史 CHANGELOG 条目保持原样不改写。

- **lib/client.js（zh）**：`settings.cardLabel`「Cybernetics 编排循环」→「Cybernetics 控制循环」；`settings.hardGate`「硬编排门」→「硬控制门」；`mode.pill`「编排」→「控制」；`mode.tip.*`「编排模式：…」→「控制模式：…」；`hint.insert/queue`「编排模式生效中：…」→「控制模式生效中：…」。
- **lib/client.js（en）**：`settings.hardGate`「Hard orchestration gate」→「Hard control gate」；`mode.pill`「Orchestration」→「Control」；`mode.tip.*`「Orchestration: …」→「Control: …」；`hint.insert/queue`「Orchestration active: …」→「Control mode active: …」。
- **src/index.ts（用户可见回执/描述）**：`hardGate` schema description「硬编排门」→「硬控制门」；`/cybernetics on|off` 成功回执「cybernetics 编排已…」→「cybernetics 控制已…」。
- **文档**：README.zh-CN.md 全文改用新术语（含架构叙述：「编排者」→「控制器」）；README.md 模式指示器章节标题与正文改用 control-mode（架构性角色词 orchestrator 作为英文概念保留）。
- **测试**：test/ 无对「编排」的字符串断言，零改动；v03/v09/v10/plan-precedence 四套全部通过，`tsc --noEmit` 与基线（5 条既有 TS5097 同类）无新增。
- **生效手段**：`lib/client.js` 改动——重启宿主（客户端模块图在宿主启动时构建）并刷新浏览器。

## v0.11.0（2026-11-05）：plan mode ⊃ cybernetics 优先级语义（plan 期间豁免硬门）

**需求**：会话进入 plan 模式时按 plan 语义执行（只读规划 + `exit_plan_mode` 审批），cybernetics 的 ALL-GOALS 路由与硬门禁在该会话**暂停**；批准退出或 `/plan off` 后，下一请求自动恢复 cybernetics 配置语义（实施请求走 goal 循环、写工具重新被门禁约束）。一句话：**plan 决定"能不能动手"，cybernetics 决定"动手走不走循环"**。

**设计决策来源**：`docs/plan-precedence.md`（v0.10.0 定稿设计 + 用户 2026-11-05 裁定「plan 期间关硬门，退出自动恢复」；硬门豁免走按会话、按请求的投影谓词，否决 hook 翻转 volatile 配置的全局方案）。

- **`src/sessionMode.ts` 新增共用谓词**：`PLAN_PROJECTION_KEY = 'plan'` + `planWanted(ctx, session)`——直读本插件已 inject 的同一 `sessionProjections` 注册表里 dsh-plan-mode 的投影（零镜像状态、零 plan-mode 侧配合）。三态判定：`active===true` / `running.wanted===true`（/plan 进行中）/ `wanted===true`（已选待生效）均视为 plan 优先；`wanted===false`（退出待生效）不算。任何失败（plan-mode 未挂载、键未重放、stateOf throw、坏状态）fail-safe 为 false。guidance（一处）与硬门（两层）三处共用，单一事实源，永不失配。
- **guidance（修 C2/C3）**：`registerGuidanceSection` 的 text 函数在 `override===false` 之后加 `planWanted` 分支——plan 会话整段替换为 `PLAN_PRECEDENCE_GUIDANCE`（禁止建 goal/delegate、只读研究、`exit_plan_mode` 提审；文案为 v0.10.0「本会话硬门豁免」版本），ALL-GOALS 协议与硬门文案（诱导跳过审批的 C3 文案）在 plan 期间完全不出现在 prompt。
- **硬门两层豁免（v0.10.0 核心）**：`installGate()` 的装配过滤与 `tools/pre-execute` 拒绝都在 `modeOverrideOf` 检查旁加 `planWanted(session) === true → return next()`——plan 激活会话工具全量保留、调用不拒绝，对 allowlist/denylist 两种 gateMode 一致；豁免按会话按请求生效，投影翻转后下一请求自动恢复强制，**零恢复逻辑**（无全局/volatile 状态被翻转，崩溃/被杀无悬挂态）。
- **C1 兜底**：`DEFAULT_GATE_ALLOWLIST` 头部加 `exit_plan_mode`（只读审批工具，非 plan 会话调用由 plan-mode 侧 throw，无副作用），dispatch 层对两种 gateMode 显式 `next()` 放行——即使 planWanted 检测失效，plan 审批也绝不被双杀。
- **行为边界**：`/cybernetics off` × plan 保持纯 plan 行为（override off 优先，回归 C4）；denylist 部署下 plan 会话同样 gate 直通（v0.10.0 裁定，文档 §5 矩阵对应行已随本版修正为 v0.10.0 语义）；`hardGate=false` 部署零行为变化。
- **测试**：新增 `test/plan-precedence.test.ts` 12 组断言（planWanted 三态+fail-safe、guidance 整段替换、allowlist/denylist 两层豁免、pending 三态提前切换、plan 退出自动恢复、C4 回归、C1 兜底双保险、批准→boundary flip 接力、keep planning 豁免保持、hardGate=false 零变化）；`v03-offline`（75 项）/v09/v10 全部不回归；`tsc --noEmit` 与基线 diff 零新增诊断（基线 5 条，TS5097 同类）。
- **文档**：`docs/plan-precedence.md` 纳入版本控制（顺带修正 :545-595 → :545-575 行号笔误；§5 denylist 非 cyb 会话行更新为 v0.10.0 豁免语义）。
- **生效手段**：`src/` 改动——重启宿主一次加载新代码。

## v0.10.0（2026-11-05）：编排模式可视化状态指示（会话头部徽标 + 输入框提示条）

**需求**：让用户一眼区分当前会话是否处于 cybernetics 控制状态（ALL-GOALS 路由 + 硬门禁 + 外环输入插入），并区分「显式 override」与「继承全局」两种生效来源；点击即切换。

- **会话头部徽标（`lib/client.js`，插槽 `conversation.session.header.utilities`）**：常驻 Pill——绿点「开」= 生效中（override on 或继承全局 on），灰点「关」= 生效关闭，暗「…」= 投影/配置未就绪（加载态，非错误态）。tooltip 注明生效来源（本会话显式设置 vs 继承全局配置）。点击 = `remote.commands.execute(sessionId, '/cybernetics on|off')`——与斜杠菜单、dsh-client-ui-plan（/plan off）完全同款命令通道，不新增服务端 API；写入的是 v0.9.0 同一条 durable 会话事件，徽标经投影实时回流刷新。切换失败把宿主错误折进 tooltip 6 秒（快照仍是唯一被确认的状态）；宿主无 `remote.commands` 命名空间时徽标呈禁用态 + 提示（inject 声明 `remote.commands`，运行时 guard）。
- **输入框提示条（插槽 `conversation.composer.dock`）**：仅当编排模式在本会话生效时渲染一条细提示条，文案随 volatile `inputPolicy` 变化：insert（默认）→「新输入将作为外环控制即时插入当前回合」；queue →「新输入将排队为下一轮输入（inputPolicy=queue）」。
- **数据联接（设计偏差，已验证）**：生效态由客户端就地联接，而非服务端算好投进投影——`cyberneticsMode` 投影只在会话事件时重发布，全局 `allGoalsMode`（volatile）翻转不会产生会话事件，服务端投影无法把全局变化反映进投影值（除非新增 API，违反「优先不新增服务端 API」边界）。客户端两个输入都是响应式的：会话投影 face（`projections.faceOf('cyberneticsMode')`，宿主实时推送）+ 插件 ConfigForm（`configForms.get` live face，设置卡片 v0.7.2 起已验证的同一响应式通道，allGoalsMode / inputPolicy 同源）。联接规则与新增的 `src/sessionMode.ts resolveMode(override, globalMode)`（canonical，返回 `{enabled, source}`）逐字一致；服务端 `effectiveEnabled` 重构为其上封装，行为不变。投影 wire 不变（`{override}`，stateVersion 1）——v0.9 客户端零影响。
- **locale**：新增 `mode.*` / `hint.*` 共 14 个 key，zh/en 双语（zh 为 key-set 基准）。
- **测试**：`test/v10-mode-indicator.mjs` 新增——resolveMode 三值矩阵（override/global/effective + source）、effectiveEnabled null 继承与 fail-safe 语义、resume/fork 重放前缀折叠一致性、投影 wire 向后兼容断言、client.js 工厂求值 + `remote.commands` inject 声明 smoke；既有 `test/v03-offline.mjs` 75 项、`test/v09-session-mode.mjs` 全部通过。`tsc --noEmit` 基线 4 条 + 1 条 TS5097（sessionMode.ts 的 `.ts` 导入，v0.9.0 引入，同类可接受）。
- **生效手段**：`lib/client.js` 改动——重启宿主 + 刷新浏览器。

## v0.9.0（2026-11-05）：按会话 /cybernetics 开关 + 新输入外环插入

**需求**：(A) 同一会话粒度地开关 cybernetics 编排（ALL-GOALS 路由 + 硬门禁），未设置的会话遵循全局 volatile 配置；(B) 会话有活跃 goal 轮时，新用户输入不再排队到轮后，而是作为外环控制直接插入当前回合——且与 DSH 原生输入路由互不干扰。

- **按会话 override（`src/sessionMode.ts` 新模块）**：会话日志事件 `cybernetics/mode { enabled: true|false|null }` + 同 key 注册投影 `cyberneticsMode`（dsh-plan-mode 同款模式，resume/fork 重放可恢复；`null` = 清除 override 回落全局）。`effectiveEnabled(ctx, session, allGoalsMode)` 统一解析：override 优先，无 override 用全局 `allGoalsMode`。任何读取失败（无注册表/键未重放/坏状态）都解析为「无 override」——fail-safe。
- **/cybernetics 命令（`src/index.ts`）**：`ctx.inject(['commands'])` 子作用域注册（/plan 同款，handler 直执行不进模型）。`on`/`off` 写一条 durable 模式事件；无参数/status 输出会话 override、全局 allGoalsMode、hardGate、inputPolicy 与生效态。
- **guidance 函数化**：`systemPrompt.section` 的 `text` 从字符串改为 `(context) => string`（dsh-plan-mode 同款）。override off 会话输出空串；override on 无视全局注入含 ALL-GOALS 的完整编排 guidance；无 override 沿用旧行为（ALL-GOALS 段随全局 `allGoalsMode`）。
- **硬门禁尊重 override**：装配 waterfall 与 `tools/pre-execute` 两层都先查 `modeOverrideOf === false`——显式 off 的会话工具原样保留、调用不拒绝。注意 hardGate 与 allGoalsMode 互相独立：无 override 时门禁仍按 `hardGate` 配置生效（null override 不改变门禁）。
- **新输入外环插入（inputPolicy，默认 'insert'，volatile）**：DSH 原生调研结论——输入排队/插入由浏览器端用户设置 `ui-conversation.busyEnter`（缺省 'queue'）决定，客户端按其选择 mode 提交，服务端 `dsh-api-session-controller` `prompt()` 依 mode 调 `agent.steer`（next-step）或 `agent.followup`（next-turn），prompt 路径无服务端扩展点；可用扩展点是 agent loop 发出的 `agent/inbox/inserted` 事件（dsh-goal-round-driver 同款 seam），且 api-session-controller 自己的 updateQueue 'steer' 动作示范了合规搬迁 API：`inbox.remove(id)` + `agent.steer(message)`。本插件监听该事件：仅当会话 cybernetics 生效（override 或全局 allGoalsMode）、`inputPolicy==='insert'`、agent running、消息是排队 next-turn 的用户输入时才搬迁为 next-step；其余（override off / 全局关 / policy queue / 空闲 / 非 user source / 委派子 agent）一律不动，原生行为零修改。搬迁失败静默回落原生位置。
- **配置矩阵（预期行为）**：{cybernetics on, off, 未 override} × {轮运行中, 空闲}：
  - on + 运行中 → 新输入插队 next-step（外环控制，session agent 立即可见）；
  - on + 空闲 → 正常 followup 立即唤醒（无排队，无需干预）；
  - off + 任意 → 完全走 DSH 原生 busyEnter（缺省排队 next-turn），插件零介入；
  - 未 override + 全局 on + 运行中 → 同 on；未 override + 全局 off → 原生行为。
- **测试**：`test/v09-session-mode.mjs` 新增（投影折叠 / guidance 会话化 / 门禁两层放行 / 命令 on|off|status / input relay 全矩阵守卫）；`test/v03-offline.mjs` 适配 guidance 函数化与双投影、volatile 字段七→八，全部 75 项通过。
- **生效手段**：`src/` 改动——重启宿主一次加载新代码；之后 /cybernetics 与 inputPolicy 即时生效。

## v0.8.10（2026-11-05）：hardGate 上设置卡片，volatile 热切换

**需求**：用户要在插件页配置卡片上直接开关硬编排门（像 `allGoalsMode` 一样保存即时生效，无需重启）。此前 `hardGate` 是非 volatile 字段，宿主设置表单只服务 volatile 路径，GUI 完全写不了它。

- **schema（`src/index.ts`）**：`hardGate` 加 `.volatile()`（保留 `default(true)`），description 更新为「设置卡片可开关，保存后即时生效（热装卸门禁监听），无需重启宿主」。`gateMode`/`gatedTools`/`gateAllowlist`/`gateAllowlistExtra`/`gateApprovalRelay` 保持非 volatile 不动。
- **apply() 门禁接线可装卸**：装配 waterfall 摘工具 + `tools/pre-execute` 分发拒绝 + `gateApprovalRelay` 透传（hardGate 伴随项）提取为 `installGate()`（内部 `gateDisposers`，每次调用先卸旧装再按需安装，幂等）。`hardGate` 改为按使用时读取的函数（`readConfigField` 解 volatile live reference；普通配置缺省仍为不装门，与旧语义一致，schema 默认 true 经 live ref 到达运行时）。监听 `loader/volatile-update`：翻转时先 `registerGuidanceSection()`（HARD GATE 提示段随开关重推导）再 `installGate()`——与 `registerGuidanceSection` 同一重建模式。热关→开按当刻 `resolveGateMode()` 解析结果接线（显式 gateMode 优先，否则结构性 allowlist）。插件卸载 disposer 链不变。
- **client 卡片（`lib/client.js`）**：`SETTINGS_FIELDS` 首位新增 `{ field: 'hardGate', kind: 'boolean' }`；`fieldRow` 新增 boolean 分支（`booleanRow`，与头部 allGoalsMode 开关同款 switch 控件，走同一 `writeField` 写路径）。双语 locale 补 `settings.hardGate` / `settings.hardGateHint`：开启后顶层 agent 写工具被摘除、所有变更经 goal 循环；即时生效，无需重启。
- **测试（`test/v03-offline.mjs`，增至 72 项）**：新增用例 71——(a) 初始 `hardGate=false` 经 live ref 热切 true：装配中 bash 被摘、pre-execute 拒绝、guidance 含 HARD GATE；(b) true→false：bash 恢复、assemble/pre-execute 监听已 dispose、guidance 摘除段；(c) 反复切换幂等（始终恰好一组活监听，末态 hardGate=true 仍拒绝）；(d) schema 断言 hardGate volatile、其余门字段非 volatile。同步更新既有断言：用例 51/56/57 中 hardGate 从「非 volatile 负向对照」改为 volatile 正向（负向对照换 `gateMode`），volatileForm 服务字段六→七。既有全部用例通过。
- **文档**：README / README.zh-CN「硬门」小节与「插件页配置」「已知限制」更新——hardGate 从「配置文件维护/重启生效」改为「GUI 卡片开关、volatile 即时生效」；注明首次部署需重启宿主一次加载新代码，此后开关热生效。
- **生效手段**：`src/index.ts` 改动——重启宿主一次加载新代码，此后开关热生效；`lib/client.js` 改动——重启宿主 + 刷新浏览器（本仓库 `lib/` 即源码）。

## v0.8.7（2026-11-04）：模型下拉 focus-parking（lib/client.js，仅客户端）

**问题**：原生 datalist 按输入框当前文本过滤选项——已配置模型的字段聚焦后下拉只剩当前那一个模型，用户看不到完整目录，容易误以为没有别的选择。改进方向不是自绘下拉，而是顺应原生 datalist 的过滤语义。

- **聚焦占位（focus parking）**：model 字段（task/verify/session/triage 共四个）聚焦或点击时，把已有文本收进 `placeholder`（value 收进占位符、输入框清空），datalist 因此展开全部系统模型；焦点离开（blur/Enter/Escape）且未编辑时恢复占位文本并**不写任何东西**——只是看看列表永远不会把已配置模型置空。
- **编辑语义保持**：占位状态下输入或选中选项即视为真实编辑，走 v0.8.1 的常规提交路径（blank = unset，回车提交）；`hadDraft` 区分占位文本是未提交草稿（保留草稿）还是快照值（恢复即清草稿）。Escape 关闭列表后值已恢复但字段仍持有焦点，此时 `onClick` 也挂 parkCurrent，保证再点一次仍能展开全列表（不再触发 onFocus）。
- **提示文案**（双语 `settings.modelFieldHint` / `settings.triageModelHint`）同步改写：点开输入框即可看到全部可选模型，已有值先收进占位符、离开且未改动不会保存。
- **生效手段**：`lib/client.js` 改动，重启宿主 + 刷新浏览器后生效。`lib/` 是源码同目录（构建产物即源），无需额外构建。

## v0.8.9（2026-11-04）：relay 卡片回退真因修复 + relay-log 落盘

- **根因修复**（src/index.ts）：问题卡片回退改用 `ctx.get('userQuestions')` 解析宿主服务（免 inject 的反射式读取，与 dsh-plan-mode 同法）。旧构建用普通属性访问 `ctx.userQuestions`——cordis 对未 inject 服务的属性访问直接抛 "cannot get property without inject"（cordis/lib/index.js:88-96），try/catch 吞掉后立即返回终态 `unavailable`，这就是 v0.8.8 真机「原生面板 unavailable 后卡片从未出现、12ms 内终结」的直接原因。
- **relay-log 落盘**：每次 relay 决策在 host logger 行之外追加一条 JSON 到 `<workspace>/.cybernetics/relay-log.jsonl`（`{ts, root, path, outcome, elapsedMs}`，fire-and-forget 不影响审批链路），验收无需宿主 stdout / 浏览器 console 即可读取 path/outcome。
- **测试**：test/relay-host-probe.mjs 新增场景 5——cordis 忠实 stub（属性访问抛错、仅 ctx.get 可达）下卡片回退依然可达用户 + relay-log.jsonl 落盘断言；test/v03-offline.mjs 全部通过。
- **文档**：README 双语排障指引更新（relay-log 读取方法与「零记录 = 请求没到 relay」判据）。

## v0.8.6（2026-11-04）：hardGate 门禁语义默认安全 + guidance 与模式一致（P1）

**问题（cyb-3e1ab616 诊断核实）**：`gateMode` 在 schema 里 `.default('denylist')`，而 `DEFAULT_GATED_TOOLS` 只有 `['bash','edit','write']`——任何只写 `hardGate: true` 的部署都得到一道半门：`bsk_*`、`taskboard_create`、`schedule_create`、`farm_start`、`uno_*`、`ppt_create`、`config_restore` 等写工具全部存活；另一会话因此退化成 810 次 `bsk_session` start/stop 死循环。同时 `HARD_GATE_GUIDANCE` 在 denylist 模式下仍宣称“所有改世界的工具结构性不可用”，属假陈述。

- **`src/index.ts` schema**：`gateMode` 去掉 `.default('denylist')`，改为无默认的可选字段（schemastery 对未设置值保留 `undefined`，离线实测 `validate({})` 结果为 `{hardGate:true}`，不含 gateMode）。**用户沉默不再被默认值抹掉**，apply() 才做推导。
- **`src/index.ts` apply()**：新增 `resolveGateMode(config, hardGate)`——显式 `'denylist'`/`'allowlist'` 原样尊重；未设置时 `hardGate ? 'allowlist' : 'denylist'`。`hardGate=false` 时不装任何门禁监听，行为与旧版完全一致。装配过滤与 `tools/pre-execute` 分发拒绝共用同一个 `allowlistMode`。
- **`HARD_GATE_GUIDANCE` 按模式生成**：拆成 `HARD_GATE_GUIDANCE_ALLOWLIST`（保留“所有改世界的工具 STRUCTURALLY unavailable”的强表述）与 `HARD_GATE_GUIDANCE_DENYLIST`（如实说明“只摘 gatedTools，bsk_*/taskboard_*/schedule_*/farm_*/uno_*/ppt_*/config_restore 等仍可调用，这是 PARTIAL 而非结构性门”，并明确禁止“换一个写工具绕过编排流程”）。`registerGuidanceSection()` 在生成时按解析后的模式拼接；hardGate/gateMode 非 volatile，重载后重新生成即可（沿用 volatile 重建模式，不受影响）。
- **文档**：README / README.zh-CN「硬门」小节重写——默认语义（hardGate 伴生 allowlist）、`gateMode` 无默认值、显式 denylist 的残留风险与仍可用工具清单（bsk_*/taskboard_*/schedule_*/farm_*/uno_*/ppt_*/config_restore/subagent 等）、以及“denylist 永远不可能完备（集合随插件增长）”。
- **测试**：离线测试增至 **71 项**——新增 16b 覆盖三种组合：(a) `hardGate:true` 无 `gateMode` → allowlist 生效（长尾写工具在装配期移除且分发期 deny）；(b) `hardGate:true + gateMode:'denylist'` → 仅 bash/edit/write 被摘，farm_start 仍在分发层放行（尊重显式配置、不静默升级）；(c) `hardGate:false` → 无门禁监听、无 HARD GATE guidance。用例同时断言双模式 guidance 文案：allowlist 含 `(allowlist mode)` + `STRUCTURALLY unavailable`；denylist 含 `(denylist mode)` + `gatedTools` + `PARTIAL, not structural`，且**不含** `STRUCTURALLY unavailable` 假陈述；另加 schema 断言 `validate({})` 的 `gateMode` 为 `undefined`、显式 denylist 经校验仍为 denylist。既有 70 项全过。
- **生效手段**：`src/` 改动，**重启 dsh web（宿主重载）后生效**。profile 端 `/Users/mars/.dsh/profiles/web/node_modules/dsh-cybernetics` 是指向源码目录的软链，无需复制；`cordis.patch.yml` 未改动（其中已显式 `gateMode: allowlist`）。

## v0.8.5（2026-11-04）：hardGate 子代理审批透传（`gateApprovalRelay`，最后一跳修复）

**问题**：宿主在委派边界把子代理审批策略钉死为 `never`（`dsh-subagent/lib/index.js:413` `captureDelegatedPolicyOverrides`；`dsh-user-approval/lib/index.js:175` 在 waterfall 之前直接 `rejected`），task agent 的沙箱越权请求到不了用户。**第一跳**：`agent/created` 时给子代理 session 追加 `approval/policy {policy:'ask'}`（真机证据：本任务子代理 session 日志 seq 2 为 `never`/`source:delegation`，seq 3 为插件追加的 `ask`，相隔 52 ms）。**最后一跳（本轮修复）**：原实现把 `approval/request` answerer 注册在内层、先 `next()` 给原生链一个限时窗口——但宿主 `api-remotes` 在启动时（早于所有用户插件）注册了 `approval/request` 转发器（`dsh-api-remotes/lib/index.js:21-28,147,233`），浏览器审批 answerer（`dsh-client-ui-approval/lib/client.js:284`）claim 子代理请求后等待一张"用户看不见的子会话面板"且永不 `next()`；cordis waterfall 由外向内执行（`cordis/lib/index.js:317-325`），内层 relay 因此**永远轮不到执行**，子代理只能挂死。改为 `{ prepend: true }` 最外层接管：沿 `parentSession` 链解析顶层活祖先，用宿主自己的 `ApprovalService.request` 在**用户正在看的会话**上重新发起请求（原生"允许一次/拒绝"面板 + 该 session 的 `approval/asked`/`approval/decided` 审计对，不转发子代理 callId），顶层回合已关闭时回退同一 agent 的 `ask_user_question` 卡片，无活顶层 agent 再回落原生链。旧的 `gateApprovalRelayTimeoutMs` 竞态窗口字段删除（relay 不再与原生链赛跑，等待语义与普通审批一致，由调用方的 signal/超时取消）。**验证**：离线测试 70 重写为最外层注册 + child→mid→root 攀爬 + 原生面板/问题/原生链三层回退 + 排序回归与负向对照；新增 `test/relay-host-probe.mjs` 用真机 cordis + 真机 `ApprovalService` + 真实插件 `apply()` 端到端跑通（子代理请求只落到顶层会话面板、隐藏子会话面板 0 次 claim；顶层拒绝/回合关闭回退均验证）。**生效手段**：`src/` 改动，宿主重载后生效（运行中的宿主仍加载旧构建，需重载/重启才能实测 GUI 弹窗）。

## v0.8.4（2026-11-04）：配置卡片移除 roles JSON 编辑项（roles 改经 profile yaml 高级配置）

**决策理由（记录在案）**：v0.8.1 起 roles 以 JSON 文本域 +「应用」按钮的形式上卡片，用户实测反馈：在 GUI 卡片里手工编辑一个 JSON 对象（`role → {provider, model}`）对用户不友善——JSON 语法错误校验、转义、role 名拼写全暴露给用户。roles 能力本身保留在 schema/运行时（命名角色进阶场景仍可用），但 GUI 不再暴露；确需配置时由 agent 指导用户直接编辑 profile 配置 yaml（用户 patch 行），README/README.zh-CN 各新增「roles 高级配置」小节记录字段位置示例与重载要求。

- **`src/index.ts`**：`roles` 去掉 `.volatile()` 标记（description 文案同步改为「高级配置：直接编辑 profile 配置 yaml 后需宿主重载生效」）。面板语义后果：宿主 `volatileForm` 只服务 volatile 字段，roles 从面板消失且不可经面板写入——这正是想要的行为（同 `hardGate` 等结构字段的既有处置）。**运行时语义核实（双语义均正确）**：接线处 `roleOverrides = { ...readConfigField(config.roles, {}) }` 的 `readConfigField` 同时接受 live reference（volatile，`{get}` → 解引用）与普通对象（非 volatile，原样返回）——`hardGate` 等非 volatile 字段走的就是同一条「普通值」路径，roles 与之同构，无需解 ref 的特殊处理；宿主重载后经 schemastery resolve 出的 roles 就是普通对象，合并逻辑（扁平字段覆盖 `roles.default`/`roles.verify`/`roles.triage`、命名角色透传）完全不变。兼容性：早前经面板写入的 volatile roles 配置在宿主重启后同样 resolve 为普通对象，读取路径不变。
- **`lib/client.js`**：卡片移除 roles JSON 文本域、「应用」按钮及其全部配套（`settings.roles` / `settings.rolesHint` / `settings.apply` / `settings.invalidJson` 四条 locale 词条 ×2 语言、`isRolesValue` 校验、`commitRoles` 提交逻辑、`rolesRow` JSX、`textarea`/`apply` 两条样式）。字段清单回到**六个**：allGoalsMode / taskAgentModel / verifyAgentModel / triageAgentModel / roundsPerSubgoal / maxConcurrentRounds。
- **文档**：README / README.zh-CN 新增「roles 高级配置（profile yaml，agent 指导）」小节——何时需要 roles（命名角色分模型）、`cordis.patch.yml` 用户 patch 行的字段位置 yaml 示例、保存后需宿主重载生效、agent 可指导用户完成；两份 README 的卡片字段清单、GUI 验证步骤与 volatile/非 volatile 语义清单同步为六字段版本。
- **测试**：离线测试增至 **69 项**——51（roles 非 volatile 断言、普通对象 resolve）、57（volatileForm/isVolatilePath 收敛到六字段，roles 路径断言转为非 volatile 负向控制，含宿主真实函数交叉验证）、65（卡片断言：无 roles 文本域、无「应用」按钮、六字段清单）更新；新增 69（roles 非 volatile 双语义：profile yaml 配置 resolve 为普通对象、`readConfigField` 对普通对象与遗留 live ref 双语义、命名角色在扁平字段合并后透传、README yaml 配置路径文档断言）。
- **生效手段**：`src/` 与 `lib/client.js` 均有改动——**重启宿主 + 强刷浏览器**后卡片即为六字段版本；已有 yaml roles 配置经宿主重载照常生效（含命名角色）。

## v0.8.3（2026-11-04）：模型下拉选择 + 失效模型处理（配置卡可用性闭环）

**数据源核实（宿主源码，2026-11-04）**：官方「子智能体」设置页（`@deepseek-ai/dsh-client-ui-settings-subagent`）的模型勾选列表读的是 `ctx.remote.session.modelCatalog()`（`@deepseek-ai/dsh-api-session-controller` 的 `@Remote('modelCatalog')`），返回 `{ ok, value: { groups: [{id, name, models: [{id, name}]}], failures } }` = 当前全部可路由模型按 provider 分组；provider 变更经 `ctx.remote.$on('llm/adapters-updated', …)` 推送刷新。本插件客户端照同一契约接入。

- **模型下拉**（`lib/client.js`）：三个模型字段（taskAgentModel / verifyAgentModel / triageAgentModel）从纯文本框改为 **datalist 加持的文本框**——`<datalist>` 逐项列出目录模型（value = `provider/model`，label = `providerName · provider/model` 便于识别），输入框本体仍是自由文本，**手工输入兜底天然保留**（datalist 不是锁定 select，目录外的值照常提交——与运行时 `parseAgentModelSpec` 接受任意「provider/model」/裸模型名的语义一致）。目录经 `remote.session` 命名空间异步加载（新增 inject 声明 `remote.session`，全程 try/guard：宿主不服务该命名空间或 `modelCatalog` 缺失时下拉为空、不警告、行为与 v0.8.2 完全一致，绝不崩），并订阅 `llm/adapters-updated` 实时刷新（模型设置增删订阅即时反映）。
- **失效模型处理（配置页）**：卡片渲染时把**已保存的配置值**与实时目录比对（`provider/model` 精确匹配选项 value；裸模型名匹配任意 provider 的 model id）——命中失败即显示「该模型已不在当前系统模型列表中，运行时将回退到 session agent 模型」警告 + 一键「清除」按钮（走与留空保存完全相同的 `unset` op 写路径）。**取舍（记录在案）**：选择「警告 + 显式清除」而非「渲染时自动 unset」——自动改写用户配置有副作用（重新订阅后原值即恢复有效；用户应保有对已存配置的所有权），且 unset 本身就是一次面板写入、失败时还会弹保存失败提示，静默化反而更危险。目录未加载/加载失败时**永不**警告（判定必须可证，避免误报）；警告只针对快照值，草稿未提交文本不触发。roles JSON 内的失效项本轮不做逐行校验（委托书明确允许，扁平三字段已覆盖主要交互面）。
- **失效模型处理（运行时，核实 + 补充）**：核实 v0.8.0 回退路径确实覆盖「模型订阅已删」——provider 被删时 dsh-subagent 在 spawn 前抛 `no subagent provider registered for "x"`（`SubagentError NO_PROVIDER`），workflow runtime 包装为 `WorkflowError code AGENT_START`，`round.js` 的 `isAvailabilityFailure` 恒判真 → 撤销覆盖重试（既有测试 59 已锁）。**补充**：provider 仍在但该 model 订阅被删时，失败以模型级报错形态出现（AGENT_RESULT 内嵌或无 code 直抛），本次在 `AVAILABILITY_PATTERNS` 加入 `model not found / no such model / unknown model / invalid model / not subscribed / model …not available/enabled/found` 模式（测试 63 矩阵新增三行触发器）。`workflows/round.js` 改动热生效。
- **测试**：离线测试增至 **68 项**——新增 68（下拉数据源：datalist/option 形状与 providerName 标注、手工输入保留；失效判定：provider/model 与裸名两形态、有效值与目录失败时零警告；清除交互：显式 unset 写入、纯渲染零写入；`llm/adapters-updated` 触发目录重取），63 矩阵扩展删除订阅触发器，67 的字段 kind 断言同步为 `model`。
- **生效手段**：`lib/client.js` 改动需**重启宿主 + 强刷浏览器**；`workflows/round.js` 热生效。验证：重启后打开插件页卡片 → 三个模型字段出现下拉（选项为 `providerName · provider/model`）→ 填入一个已删除订阅的模型回车保存 → 字段下方出现不可用警告 → 点「清除」恢复继承。

## v0.8.2（2026-11-04）：新增 triageAgentModel（第三个扁平角色模型字段，卡片覆盖全部七个 volatile 字段）

- **新增 `triageAgentModel`**（`src/index.ts` schema + Config 接口）：与 `taskAgentModel` / `verifyAgentModel` 完全同构的扁平 volatile 字段——「provider/model」或裸模型名，**留空 = 继承 session agent**；经 `readConfigField` 解 live ref 后由 `parseAgentModelSpec` 解析，在轮启动接线处合并进 `roles.triage`（与 task→roles.default、verify→roles.verify 同一模式）。description 文案写明 triage 角色职责：读 task/verify 结果输出本轮收敛决策（met/continue/human-input 等），**quick 轮不启用**（quick 深度在 verify/triage 之前直接返回）。
- **fallback 语义**：沿用 v0.8.0 `callRoleAgent`——triage 调用点（普通轮与 persistent executor 的 `taskReport` 分支共两处）本就走 `callRoleAgent('triage', …)`，本次零改动；测试 67 锁死：triage 覆盖 + 可用性失败 → 撤销覆盖以 session 模型重试一次并记录 `{role:'triage', trigger:'availability-error'}`；**空配置（无覆盖）时 triage 返回 null 不触发多余重试**、无伪造回退记录；quick 轮完全不调用 triage。`src/controller.ts` 无需改动：`RolesConfig` 本就有 `triage?: RoleSpec`，扁平字段只落在 `src/index.ts` 的 Config 接口上。
- **设置卡片**（`lib/client.js`）：字段清单加入 `triageAgentModel` 文本框（专属 hint 写明 triage 职责与 quick 轮语义），卡片现覆盖全部**七个** volatile 字段（allGoalsMode / taskAgentModel / verifyAgentModel / triageAgentModel / roundsPerSubgoal / maxConcurrentRounds / roles）；读写路径、留空=unset、失败兜底与既有字段完全同构。
- **生效手段**：`src/index.ts`（schema + 接线）改动需**宿主重载**；`lib/client.js`（卡片）改动需**重启宿主 + 强刷浏览器**（客户端模块图在宿主启动时构建，无 watcher）。验证步骤：重启宿主后强刷「插件」页 → 打开 cybernetics 卡片 → 应看到「Triage agent 模型」文本框（位于 Verify agent 模型之下），填入「provider/model」回车保存，下一轮 goal 的 triage 角色即用该模型；留空保存 = 恢复继承。
- **测试**：离线测试增至 **67 项**——新增 67（triageAgentModel：volatile/live-ref/解析/合并接线/三处 fallback 语义/quick 轮跳过/卡片字段清单）；57（volatileForm 服务清单改断言七字段，含真实宿主 volatileForm 交叉核对）与 65（卡片快照 + 字段清单 + triage 字段 set/unset 写路径）同步扩展。

## v0.8.1（2026-11-04）：设置卡片覆盖全部六个 volatile 字段（面板缺字段的真根因）

用户实测（重启宿主 + 刷新浏览器后）：插件详情页的 cybernetics 卡片仍只有「全目标模式」一个开关，roles / roundsPerSubgoal / maxConcurrentRounds / taskAgentModel / verifyAgentModel 五个 volatile 字段在 GUI 无处可见。本轮重读宿主源码后定位到**与 v0.7.10 不同的第三层根因**：

- **渲染来源核实**：插件详情页（`ItemDetail`，@deepseek-ai/dsh-client-ui-plugin-manager lib/client.js:2710）对插件配置的渲染**完全交给 slot 卡片**（`plugins.item` view "page"），页面自身一个字段都不画；@deepseek-ai/dsh-client-ui-settings 只提供 `configForms` **服务**（传输层 + `volatileForm` 决定服务/接受哪些字段），**没有按 schema 自动渲染字段的通用 ConfigForm UI**；dsh-client-ui-settings-plugins 是只读 inventory 壳（其 README 明言："Configuring a built-in plugin happens on the sidebar's Plugins page, where each official plugin's own companion package registers its page"）；官方插件（agent-loop / web-search 等）各自带手绘卡片。**结论：本插件自定义卡没画的 volatile 字段在整个 GUI 中不可见也不可配**——v0.7.2/0.7.3 起的卡片只渲染 allGoalsMode 开关 + summary 文案，这就是重启后其余五字段仍缺席的原因。宿主侧「通用 ConfigForm 服务全部六字段」指的是传输层（测试 57 已证），不是一张实际存在的表单 UI；两张 UI 并不并存，唯一 surface 就是自定义卡。
- **卡片扩展**（`lib/client.js`）：同一 `SettingsCard` 现在渲染全部六个 volatile 字段——allGoalsMode 开关（不变）+ taskAgentModel / verifyAgentModel 文本框 + roundsPerSubgoal / maxConcurrentRounds 数字框 + roles JSON 文本域（「应用」按钮提交，写入前校验 `{role: {provider, model}}` 形状）。单行字段回车或失焦即提交；**留空 = 恢复默认**（`unset` op）；数字越界（<1 / <0）只标红不写；内容未变不写。写路径与开关完全同构：live ConfigForm `set`/`unset`（plugins.bundle.config 页）或宿主 ConfigPageForm `mutate(ops, revision)`（plugins.item / plugins.row.config 详情页），被拒时经 `remote.settings.mutate` 无 revision 兜底重试一次并原样展示宿主拒绝信息（v0.7.6 path-(b)），未就绪显示「配置不可用」行且不挂控件、15s 看守防挂起、控件值始终以宿主确认的快照为准——既有行为全部保留。
- **生效手段**（`lib/client.js` 改动的固有约定）：**重启宿主 + 强刷浏览器**（客户端模块图在宿主启动时构建，无源码 watcher）。验证步骤见 README「插件页配置」。
- **测试**：离线测试增至 **66 项**——新增 65（live ConfigForm 形状：六字段清单渲染、数字解析/越界标红、留空=unset、未变不写、roles JSON 校验与解析后写入、Escape 还原）与 66（宿主 ConfigPageForm 形状：字段写经 `mutate(ops, revision)`、blank=unset op、拒绝→directMutate 无 revision 重试并展示原文、未就绪只渲染标签不挂控件）。

## v0.8.0（2026-11-04）：task/verify agent 模型覆盖的调用级回退（call-level fallback）

为角色设定的模型无法调用时（限额/quota 耗尽、网络不可达、provider 报错等**可用性失败**），不再让整个 goal 轮失败：`workflows/round.js` 对每个角色的 `agent()` 调用包一层 `callRoleAgent`，命中可用性失败即**撤销该角色的 provider/model 覆盖**（不传覆盖 = 继承 session agent 的模型配置）重试一次。覆盖 task（含命名角色）、verify、triage 三个调用点；persistent executor 的 full 轮经 `taskReport` 分支同样走 verify/triage 的 `callRoleAgent`。

**判定信号来自 workflow runtime（`@deepseek-ai/dsh-workflow-ptc`）`agent()` hook 的错误类型/消息**（对该 runtime 源码逐行核实）：

- **抛出 `WorkflowError`** —— `code: 'AGENT_START'`（消息 `agent() could not start a child: …`，provider 解析/spawn/首调失败，**恒为可用性失败**，如 `no subagent provider registered for "x"`）；`code: 'AGENT_RESULT'`（`child agent run failed: …`，消息内嵌失败原因，命中可用性模式才回退）。模式表：限流（429/rate limit/too many requests）、限额（quota/insufficient/额度/余额/配额）、鉴权（401/403/unauthorized/invalid api key）、服务端不可用（502/503/529/overloaded/service unavailable）、网络（ECONNREFUSED/ETIMEDOUT/ENOTFOUND/fetch failed/network 等）。无 `code` 的错误（如离线 harness 的 mock）按消息模式判定。其余抛出（`INVALID_ARGUMENT`/`UNSUPPORTED_*`/`AGENT_CAP` 等脚本或守卫错误）**原样上抛，绝不换模型**。
- **返回 `null`** —— runtime 把子 agent 的失败压成 null 且不透传原因（子 run `stopReason ≠ 'completed'`：LLM 调用中途失败经 dsh-subagent 的 `agent/error` → `stopReason: 'error'`，是限额/网络/provider 报错**最常见的形态**；或 completed 但无结构化产出）。仅当该角色**配置了模型覆盖**时把 null 视为「覆盖模型疑似不可调用」重试一次；无覆盖时 null 维持原失败语义（本来就跑在 session 模型上，无处可退）。重试再败降级为既有「本轮无结果」路径，回退记录仍保留。
- **逻辑失败永不触发回退**：task agent 正常交付 `done=false` 报告、verify 给出未达成 verdict，都是返回值层面的判定，不换模型（离线测试 61 锁死）。

**可见性**：每次回退记录 `{role, from, trigger: 'availability-error'|'null-result', reason}` 进轮结果的 `fallbacks` 数组（所有返回路径经 `withFallbacks` 携带），随 `.cybernetics/round-<goalId>-<n>.json` 审计日志落盘；`log()` 把回退原因 narrate 进 `workflow/log` 事件流；controller 的 `decide()` 把「⚠ 模型回退 N 次：role(覆盖→session 模型)」后缀追加进决策 note（cybernetics 工具结果行可见）。配置语义向后兼容：空配置 = 继承 session agent（无回退必要）；已配置 = 优先用配置模型，可用性失败时回退。离线测试增至 **64 项**（新增 59–64：AGENT_START/quota 触发、逻辑失败不触发、null-result 回退与再败降级、可用性判定矩阵、controller 层可见性）。`workflows/round.js` 改动**热生效**，无需宿主重载；`src/controller.ts` 的类型与决策 note 改动需宿主重载。

另：用户已按 v0.7.10 第 2 条修复宿主部署（profile 侧 dsh-app-boot 收敛到 CLI 同一份模块实例），离线测试 58 的 inode 探针相应改为双态断言——两份拷贝 realpath 相同即认证「部署已修复」（面板保存恢复可用），相异则维持原有的双实例机制断言。

## v0.7.10（2026-11-04）：基于真实宿主源码的双根因定位（面板渲染 + 保存拒绝）与测试忠实化

用户实测（2026-11-04 真实 GUI）：面板只显示「全目标模式」一项，v0.7.9 新 volatile 字段（roles / roundsPerSubgoal / maxConcurrentRounds / taskAgentModel / verifyAgentModel）全部缺席；且「全目标模式」开关保存被宿主拒绝："dsh: profile reload requires the root Include entry"。本轮重读宿主源码（@deepseek-ai/dsh-settings volatileForm/describe/write、@deepseek-ai/dsh-config-editor edit、@deepseek-ai/dsh-app-boot boot/mountRootInclude/recompose）后**修正 v0.7.9 的两个错误结论**：

1. **渲染根因 = 运行时陈旧（stale runtime），不是 schema 缺陷。** 本插件是 `link:` 安装（profile node_modules 软链回本仓库），宿主 loader 在启动时一次性 import `src/index.ts` 并缓存模块图，没有源码 watcher——源码改动只在宿主重启后进入 `entry.fiber.runtime.Config`。实测面板恰好只有「全目标模式」一项，正对应 v0.7.0–v0.7.6 的 schema（当时只有 allGoalsMode 是 volatile；task/verify 两字段 v0.7.7 01:10 才 volatile，roles/rounds/maxConcurrent v0.7.8–0.7.9 才 volatile）：运行中的宿主进程装配的是早于 v0.7.7 的运行时。v0.7.9「渲染失败是因为宿主不认新字段」的判断不成立——真实宿主的 `volatileForm`（dsh-settings lib/index.js:122-131）对**每个 volatile 字段**都会生成表单，`describe()` 按 `entry.fiber.runtime.Config` 服务；离线测试 57 证明：当前 schema 经宿主 `validateVolatilePlacement`（app-boot lib/index.js:2606-2621，volatile 必须落在无 volatile 祖先的固定对象路径上——当前六个字段全部合法，含 volatile 的 roles dict）与 `volatileForm` 后，表单恰好服务全部六个字段；而把 face 回退成 pre-0.7.7（仅 allGoalsMode volatile）即逐字段复现用户截图的「单字段面板」。**生效手段：重启宿主**（`src/` 改动需宿主重载，本文件头注约定）+ 浏览器刷新。

2. **保存拒绝根因 = 宿主 dsh-app-boot 双模块实例（部署层），不是插件声明/写入路径问题，插件仓库内无法修复。** 真实写路径是 `settings.write/mutate`（dsh-settings）→ `ConfigEditor.edit`（dsh-config-editor lib/index.js:69-131），而 edit **无条件先跑一遍预检** `reconcileProfilePatches(root, beforePatches, "dsh")`（第 74-75 行，先于任何文档读写）；该调用进入 dsh-app-boot 的 `recompose`（lib/index.js:3803），其守卫是**模块级全局 WeakMap** `bootstrapIncludes.get(ctx)`——由 `boot()`/`mountRootInclude`（lib/index.js:4151）在**引导进程自己的 dsh-app-boot 拷贝**里登记。本机部署里引导方（全局 CLI：/opt/homebrew/lib/node_modules/@deepseek-ai/dsh，npm 树）与 profile 侧的 dsh-config-editor（pnpm 树，依赖解析到 profile 自己的 @deepseek-ai/dsh-app-boot 拷贝，两份 lib/index.js inode 不同）各持一份模块实例，WeakMap 永远 miss → **任何**插件的面板保存都在落盘前被拒，报错正是 "dsh: profile reload requires the root Include entry"；预检先于 `writeFileAtomic`（第 123 行）的顺序也解释了实测「profile cordis.patch.yml mtime 不变、快速 rejected」的签名。此前 v0.7.4–v0.7.8 依次排查的「非 volatile 拒绝 / revision 冲突 / 落点形状」都不是真实拒绝点。**让面板写入生效的正确装配**（宿主侧，超出本仓库边界）：把引导方与 profile 收敛到**同一份** dsh-app-boot 模块实例——最直接是把 profile 的 `node_modules/@deepseek-ai/dsh-app-boot` 软链到 CLI 引导用的那份（Node ESM 按 realpath 去重，同 realpath = 同 WeakMap；注意 pnpm 重装会还原软链），或上游修复 `recompose` 的守卫（改为显式传递 root Include entry，而非模块级 WeakMap）。修复后 volatile 保存将按 v0.7.8 测试 56 已证明的形状落为 profile 用户 patch 行 `{id, name, config}` 并即时生效（volatile 语义 = 不 remount 的活提交，落盘 + loader/volatile-update）。

插件侧本轮改动：`src/index.ts` schema **无需变更**（经真实宿主闸门逐项验证合法）；离线测试增至 **58 项**——新增测试 57（validateVolatilePlacement + volatileForm 全字段断言 + roles 子路径 isVolatilePath + pre-0.7.7 陈旧运行时单字段负向对照；并在宿主 profile 在场时**直接 import 宿主自己的** `dsh-settings/lib/types/schema.js` 的 `volatileForm`/`isVolatilePath` 对当前 Config 重放——六个字段全被服务、写闸门全过、非 volatile 字段全被拒，把离线模拟钉死在宿主真实代码上，宿主将来改闸门此处先红）与测试 58（bootstrapIncludes WeakMap 按模块实例失配复现精确拒绝串 + 预检先于落盘的顺序断言 + 同实例去重对照 + 本机双拷贝 inode 探针，实测 CLI 拷贝 inode 548644475 ≠ profile 拷贝 inode 548688631）。README 的 GUI 验证步骤同步更新。


## v0.7.9（2026-11-04）：面板暴露 goal 编排核心参数

根因：宿主 0.1.7 settings model 的插件面板**只服务 `.volatile()` 字段**（`@deepseek-ai/dsh-settings` 的 `volatileForm`：无 volatile 字段的插件条目不出现在 describe() 里，`write()` 对非 volatile 路径直接抛 "Config field ... is not volatile"）。v0.7.8 只有 taskAgentModel / verifyAgentModel / allGoalsMode 是 volatile，`roles`、`roundsPerSubgoal`（递归深度上限）与并行上限完全无法在 GUI 配置。本版将 `roles`（role → {provider, model}）与新增的 `roundsPerSubgoal`（同一子目标最大连续轮数，缺省 3）、`maxConcurrentRounds`（全局并行轮数上限，缺省 0 = 不限；`launchBackground` 与阻塞 round 路径启动前检查 `running.size`，超限拒绝并提示）全部标 volatile；运行时经 `readConfigField` 解 live ref（roles 不再直接 spread，避免把 ref 对象当 override）。`hardGate`/`gateMode`/`gatedTools`/`gateAllowlist`/`gateAllowlistExtra`/`toolName`/`implicitTrigger` 保持非 volatile：面板写不了它们（结构性装配，属 profile 配置文档职责）。volatile 保存即时生效、下一轮 goal 生效，无需宿主重载。客户端 `lib/client.js` 无需改动：通用 ConfigForm 从 configForms describe() 的 volatileForm 派生字段，新字段自动出现。离线测试 51 扩展锁死三个新 volatile 字段与 roles live-ref 解析（共 56 项全过）。

## v0.7.x（2026-11-03 ~ 2026-11-04）

### v0.7：全量 goal 模式（`allGoalsMode`，默认 false）

开启后注入「ALL-GOALS MODE ACTIVE」路由协议：任何用户请求一律先建 goal 再执行（禁止就地分析）；简单只读 → quick 单轮；复杂分析/写任务 → full 多轮渐进（start 异步 + collect 收敛）；revise 缺省 `abortPrevious` 改为自动决策树（查 goal 板 running 状态：旧轮在跑且 objective/depth 被改写 → 自动中止；旧轮在跑但目标不变 → 等待自然结束；旧轮未跑 → 直启），显式传值仍是人工控制。每次修订的 `revisions-<新goalId>.jsonl` 审计行新增 `abort: {abort, mode, basis}`；`revise` 返回值同样携带 `abort`。决策树纯函数在 `src/controller.ts` 的 `decideAbort`。关闭模式时提示段与 revise 行为与 v0.6 完全一致（离线测试 48–50 锁死）。同版在 settings schema 上新增扁平 agent 模型字段 taskAgentModel / verifyAgentModel（空 = 继承 session agent）。

### v0.7.1：插件配置面板可视化配置

`src/index.ts` 导出 schemastery `Config` schema，宿主 0.1.7 settings model 据此派生 Web 编辑器插件条目的设置页（机制同 `@linxin666/dsh-ssh` / `@linxin666/dsh-usage`：loader 经 `runtime.Config['~standard'].validate` 解析配置，面板由 dsh-client-ui-settings 的共享配置表单渲染，含每个字段的 `description` 文案）。`allGoalsMode` 标记 `.volatile()`：在面板上切换保存后 loader 直接把新值提交进运行实例（不 remount），提示段经 `loader/volatile-update` 重挂即时生效；`hardGate`/`gateMode`/`gatedTools`/`roles` 等结构性字段为普通字段，保存后触发插件行 remount（需宿主重载完成）。注意：schema 解析会把未设置的 `z.array` 字段变成 `[]` 而非 `undefined`，`apply()` 的门回退因此按「空数组 = 未设置」处理（离线测试 51 锁死）。此前版本只能手改 profile JSON 里的 `allGoalsMode: true`；现在在 Web 编辑器「插件」页的本插件卡片上直接切换即可（保存 volatile 字段无需重启宿主，刷新浏览器可见最新面板）。

### v0.7.2 / v0.7.3：插件页设置卡片

实测仅有服务端 Config schema 不会在「插件」页产生任何卡片（本 profile 的 @linxin666/dsh-client-ui-plugin-manager 停用了官方 ui-settings-plugins 设置分区，schema 自动面板无处落脚）。官方插件页（@deepseek-ai/dsh-client-ui-plugin-manager）只通过它声明的 slot 渲染插件配置：`plugins.item`（「内置插件配置」分组列表卡）、`plugins.bundle.config`（按 bundle 名分发，bundle 详情页配置区）、`plugins.row.config`（按 `<bundle>#<rowId>` 分发，组件详情页）。`lib/client.js` 因此注册三个席位：`plugins.item`（id = `dsh-cybernetics`）、`plugins.bundle.config`（key 同时注册 profile 依赖名 `dsh-cybernetics` 与包名 `@mars.liu/dsh-cybernetics`）、`plugins.row.config`（key `<bundle>#dsh-cybernetics`）。`plugins.item` 无条件注册（v0.7.5 加固）：早先的 cut 用 `configForms.whileServed` 门控，宿主尚未服务该命名空间时整张卡消失，与「注册从未运行」不可区分；现改为 `ctx.configForms.get()` 绑定一个跟随共享 describe mirror 的活 ConfigFormController，命名空间就绪的瞬间卡片翻成开关，未就绪时渲染「配置不可用」行——可见、可诊断。卡片读写 `ctx.configForms.get('dsh-cybernetics')` 的 ConfigForm；v0.7.3 修复：详情页的 owner prop `form`（宿主 ConfigPageForm `{state, mutate}`）在渲染 seam 上覆盖 inject 的 form（renderer renderEntry 先展开 inject 后展开 ownerProps），卡片两种形态都支持（离线测试 52/53 锁死）。`dsh.client.inject` 增补 `@deepseek-ai/dsh-client-ui-settings` 保证 configForms 提供方先到。

### v0.7.4：保存失败可见化

实机验证（2026-11-03，浏览器实测）：卡片注册、summary 文案、开关渲染均正常，但切换保存经 `configForms`→`remote.settings.mutate` 到宿主后被**静默拒绝**（写不落盘：profile `cordis.patch.yml` 未变更，RPC 错误不上控制台，卡片此前 `.catch(() => {})` 吞掉失败，第一次点击甚至把 promise 挂死在「保存中」）。离线模拟宿主 `dsh-config-editor.edit` 的文档校验（`composeEntries([patches])` 含 bundle insert 层 + 新增 override 行）是**通过**的，说明拒绝发生在更早的环节（`reconcileProfilePatches` 预检 / loader 热重载路径），宿主日志在本环境不可读，确切拒绝原因待宿主侧确认。本轮改动：卡片不再吞错——写入被拒（settles false / reject）或 15 s 未返回都显示「保存未生效（宿主拒绝了写入）」并立即把开关还原到宿主确认的快照值；成功路径语义不变（volatile 即时生效）。根治写路径需要宿主侧 settings.mutate 的拒绝日志（`harness-log` 或 `dsh plugin --profile web` 诊断），超出插件仓库边界。

### v0.7.5：卡片注册无条件化

见 v0.7.2/0.7.3 段的 `plugins.item` 说明；宿主日志复核（2026-11-03，`~/.dsh/logs/`）：未发现 cybernetics settings mutate 的拒绝记录（最近一次启动日志是 EADDRINUSE 的失败实例，当前宿主进程无对应落盘日志），写路径的宿主侧根因仍待带日志的复现。

### v0.7.6：路径 (b) 落点取证 + 拒绝原因透出

代码级取证（2026-11-04，宿主 checkout 只读）确认：`settings.mutate` 的唯一宿主写路径是 `@deepseek-ai/dsh-settings SettingsForms.write` → `@deepseek-ai/dsh-config-editor ConfigEditor.edit`，后者写入的就是**用户 patch 行**（在 profile `cordis.patch.yml` 追加/更新 `{id, name, config}` 非 insert 行，再以 `reconcileProfilePatches(root, patches, "dsh", [entry.id])` 应用——见 `dsh-config-editor/lib/index.js` edit() 的 `findLastIndex` + `document.add({id, name, config})`）。即插件侧写入落点**从来就是**宿主允许的用户 patch 行，"写到了 bundle insert 行"的假设不成立；实测复现（2026-11-04 浏览器点击开关 + `cordis.patch.yml` mtime 前后比对）显示拒绝发生在宿主 `edit()` **落盘之前**（文件未被触碰、快速返回 settings/rejected），确切 throw 行仍需宿主侧 stderr（tty，本环境不可读）。本轮插件侧改动：写入被拒时经插件自有的 `remote.settings.mutate`（同一宿主写路径）做**一次无条件 revision 回退写**（expectedRevision 省略 = 宿主文档化的无条件写），陈旧 revision 冲突可就地自愈；仍被拒时卡片以「保存未生效，宿主拒绝原因：{message}」透出宿主 RemoteError 原文（ConfigFormController 原本把错误坍缩成裸 `false`）。离线测试增至 54 项，新增写入落点断言（回退写无 revision、主写成功不触回退、无 remote 降级不崩）。

### v0.7.7：agent 模型字段 volatile 化（表单可写性根治）

本轮实机复现（2026-11-04 浏览器点击插件详情页开关）：写仍被宿主拒绝（快照回弹「全目标模式：关」，profile `cordis.patch.yml` mtime 21:58:35 未变，拒绝发生在落盘之前），且当前宿主进程 2026-11-03 22:04 启动、早于 v0.7.6 提交（00:40），运行中的仍是旧客户端模块。新增宿主侧取证：`@deepseek-ai/dsh-settings` 的 `volatileForm(schema)`（lib/index.js:122-131）只保留 `.volatile()` 字段作为整个设置表单，`write()`（同文件 502-531 行）对每个写入路径做 `isVolatilePath` 检查并抛「Config field "…" is not volatile」——即宿主表单**只服务也只接受** volatile 字段；据此把 taskAgentModel / verifyAgentModel 两个扁平字段也改为 `.volatile()`（此前非 volatile = 在插件页既不可见也不可写），读取点改为 `readConfigField(config.taskAgentModel, '')` 解包活引用（'' = 与 session agent 一致），语义保持「保存后下一轮 goal 即生效，无需重载」。离线测试 55 项全过（测试 55 改为断言两字段 volatile + 活引用解析 + readConfigField 解包布线）。生效步骤：重启宿主（客户端模块图 + 服务端 schema 都在启动时装配）+ 强刷浏览器。

### v0.7.8：写入落点证明测试（测试 56）

把宿主 `@deepseek-ai/dsh-settings` write() 的全部预写闸门（volatileForm / isVolatilePath / projectForm / mutate op reduce / validatePaths / strip + mergeLayers，lib/index.js 122-179 与 488-534 行）逐行复刻，对**真实导出的 Config schema** 重放卡片的 toggle 写：开关写通过每一道闸门、经 schemastery 校验（= cordis `resolveConfig` 的精确检查）后产出持久化 config，最终落点形状恰为 `ConfigEditor.edit`（dsh-config-editor lib/index.js 150-155 行）追加到 profile `cordis.patch.yml` 的**用户 patch 行** `{id, name, config}`（无 `insert` 键）——即 `reconcileProfilePatches`（dsh-app-boot lib/index.js:3794）唯一接受的落点。负向对照：`hardGate` 等非 volatile 路径在写前即被同一闸门以「Config field "hardGate" is not volatile」拒绝、文件不被触碰——这正是 v0.7.4/v0.7.5 实机观测到的拒绝签名（profile patch mtime 不变、快速 rejected）：**运行中宿主装配的插件 schema 若早于 volatile 标注，宿主即在写前拒绝**；生效手段不变：重启宿主装配 v0.7.7 schema + 强刷浏览器。离线测试增至 56 项。

## v0.6（2026-11-02）

- **多 goal session 投影（`cyberneticsGoals`）**——goal 板每次变化把本 session 全部 goal 的整值快照 append 成一条 `plugin:cybernetics/goals` 事件（可跳过的插件记录，宿主持久化读取安全），服务端纯折叠、宿主整值推送，「目标」页签逐条渲染并就地更新；空板回退到 dsh-goal 单 goal 渲染。
- **执行者适配层**：`executor: 'ephemeral' | 'persistent'`（与 depth 正交）——persistent 用 Agent Teams 持久 teammate 执行 task 工作（首轮 spawn fresh，后续轮 sendMessage 投递委托书修订，`subagent/end` 捕获输出）；quick 由输出契约派生 verdict，full 把报告作为 `taskReport` 交给 round.js，verify/triage 仍以临时 agent 独立运行。审计日志记录 `executor`，goal 板记录 `memberName`。
- **只新增目标模型（append-only goals）**——goal 一经存在不再原地修改。`action: 'revise'`（必填 `reason`，可选 `objective`/`title`/`depth`/`executor`/`abortPrevious`）创建一个带 `parentGoalId` 的新 goal 并立即启动其第 1 轮，旧 goal 置 `superseded` + `supersededBy` 保留最终状态；已完成的 goal 同样走这条路径。`abortPrevious` 默认 false（旧轮跑完由 session agent 决定是否打断），true 时复用 cancel 路径。每次修订追加 `.cybernetics/revisions-<新goalId>.jsonl`。页签按两段排序（未完成在前、已完成 met/cancelled/superseded 在后，组内 `updatedAt` 倒序；服务端排序、客户端不重排），并显示「已被 <新标题> 取代」/「修订自 <旧标题>」；`GoalStatus` 增加 `superseded`。
- **板持久化与 rehydrate**——controller 的 goal 板在每个写点整值快照到 `<workspace>/.cybernetics/board-<sessionId>.json`（`{version, sessionId, savedAt, goals}`，同目录临时文件 + rename 原子替换，失败不阻断）；重启后首次工具调用拿到空内存板时从快照恢复（缺失/损坏/版本不符/非法记录一律空板，不抛错）并立即重推一次 `cyberneticsGoals` 投影，「目标」页签因此不再在重启后清空。「控制」页签新增每个 goal 的执行者行（状态 + 标题 + executor 临时/持久 + 持久 teammate 名称 + 第 N 轮，未完成在前、已完成在后）；`GoalView` 增加可选 `memberName`，投影折叠保留。快照是当前状态而非事件日志，`updatedAt` 不持久化。
- **第 0 步实验**（2026-11-02）：持久 teammate `analyst` 两轮真实知识库分析，持久记忆生效（次轮复用首轮结论，墙钟约减半）、委托书修订语义可行、自主分析质量超出委托书（fresh 上下文 + 详细委托书足以支撑领域判断）。记录见 docs/protocol.md 文末。

## v0.5

双档轮次（depth）——轻量分析 quick 单 agent 一轮直接反馈；复杂分析与变更走完整工作-验证循环（full）。

## v0.4 / v0.4.1

- v0.4：可选硬门（`hardGate: true`）——装配期从顶层 session agent 物理摘除执行工具（默认 bash/edit/write），编排从劝告变成结构；task agent 不受影响。
- v0.4.1：硬门增加 allowlist 模式（只保留读+编排工具，挡住 farm_unregister 类长尾变更工具）。

## v0.3

多 goal 板 + 编排者协议 + 异步轮（`start`/`collect`/`cancel`/`list`）+ task agent 工作委托书（brief）。

## v0.2

session-goal 模式 + 隐式触发 + 角色化 sub agent + 客户端 goal 页签。服务端已按 dsh 0.2.1-rc.3 真实 API 核对（tools.register / goals service / workingDirectory），客户端按 ModuleLoader 包装格式手写（参照 dsh-client-ui-goal / dsh-context）。**端到端回路尚未实跑**（此后的实测修正补上了这一课）。

## 实测修正记录（2026-11-02，dogfooding）

- **触发链路实测**：隐式提示注入 ✅、工具注册 ✅；执行原在 `ctx.get('workflowEngine')` 处报 "cannot get property ... without inject"（宿主 cordis 对未注入服务的属性访问直接抛错，goal 护栏不可达）。已改为静态 inject `workflowEngine` / `goals` / `workingDirectory`。
- **第二次实测修正**：首次重启后插件仍 pending——`workflowEngine` 是在 `delegation` group 的 isolate 里提供的（`isolate: workflowEngine: true`），顶层 insert 的行拿不到它。`cordis.patch.yml` 改为按组 id 插入（loader 方言：patch id 指向 group 行时追加进该组 config）。
- **第三次实测修正**：按组 id 插入也被跳过（dump-config 报 `entry "delegation" not found`）——`delegation` 组不在顶层 patch 索引，而是嵌在 `preset-standard`（`@deepseek-ai/dsh-agent-preset`）的 `config.plugins` 里。最终方案：profile 层 patch 整体重写 `preset-standard` 的 config，把 `dsh-cybernetics` 加进其 delegation 组；本插件的 bundle patch 清空为 `[]`。
- **第四次实测修正**：页签仍未出现——浏览器实测发现 boot graph 的 client combo 不含本包：客户端扫描只枚举**顶层** loader entries。最终方案：插件回到顶层行，`workflowEngine` 不再静态 inject，执行时经 `ctx.agentPresets.serviceFor(agent, 'workflowEngine')` 从 Agent 的 preset mount 读取（registry 的官方 root-realm 访问器）；inject 收窄为根级服务。同轮修复 goal 护栏：`goals.get()` 现严格要求 `phase === 'active'`，并按 goal id 重置轮次状态。
- **页签渲染两连修**：① inject 手动传的 `t` 遮蔽了槽位按 `locale: NS` 注入的正确翻译函数（字典注册前 bind 会解析为空串）——inject 不再传 t；② 宿主 jsx 变体忽略 `jsx(type, props, children)` 的第三参，children 必须放进 `props.children`，否则所有文本静默丢失、元素塌缩成空胶囊。修复后「目标 / 控制」两页签均完整渲染。
- **改名回归**：`@mars.liu` 改名把包名从 `dsh-cybernetics` 变成 `@mars.liu/dsh-cybernetics`，loader 行名同步了，但 `lib/client.js` 里 `__ModuleLoader__.load({ id })` 仍是短名 → boot 报 `loaded without registering`。不变量：**客户端 bundle 的注册 id 必须等于 package.json 的 `name`**（client-modules boot graph 以包名为行键，`dsh.client.inject` 里的依赖同样按包名解析）；短名只用于 loader 行 id。离线测试有断言锁死这条不变量。
