# 演进历史 / Changelog

> 本文件承接自项目早期的 README「状态」与「实测修正」记录，按版本倒序整理。
> 当下的功能与使用方式以 [README.md](../README.md) 为准；协议细节见 [protocol.md](protocol.md)。
> 约定：`src/` 改动需宿主重载生效；`lib/client.js` 改动需重启宿主（客户端模块图在宿主启动时构建）并刷新浏览器；`workflows/round.js` 改动热生效。

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
