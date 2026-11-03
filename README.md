# dsh-cybernetics

DSH 的控制论工作协议插件：session goal（`dsh-goal` 持久目标，agent 思考产物、模型动词维护）→
task agent → verify agent → triage agent，controller 在轮间推进，用户通过对话校准。
构建在 `dsh-workflow`（单轮编排）之上。v0.2 起不再依赖 goal.md 文件。

- 协议全文：[docs/protocol.md](docs/protocol.md)
- 服务端：`src/index.ts`（`cybernetics` 工具 + 隐式触发提示段）+ `src/controller.ts`（轮间状态机）
- 客户端：`lib/client.js`（「目标 / Goal」+「控制 / Control」两个会话页签，实时推送）
  - 「目标」优先读插件自有 session projection `cyberneticsGoals`：本会话**全部** goal
    （标题 / 状态徽标 / 第 N 轮 / 当前 subgoal / depth、executor 小标签、被取代/修订来源标注），
    按服务端两段顺序渲染（未完成在前、已完成在后，组内更新时间倒序）并就地更新；
    无多 goal 数据时回退到 dsh-goal 的 `goal` projection 单 goal 渲染；
  - 「控制」读 session list store（control stream 实时推送），递归展示本会话全部
    agent（主控 + subagent catalog）的运行状态与各自 goal projection
    （objective / phase / rounds / 受阻原因），顶部汇总运行中数量；v0.6 起顶部还列出
    每个 goal 的**执行者行**（状态 + 标题 + executor 临时/持久 + 持久 teammate 名称 +
    第 N 轮，未完成在前、已完成在后），数据源与「目标」页签同一份 `cyberneticsGoals` 投影。
- 轮脚本：`workflows/round.js`（每次 run = 一轮；`roles` 表支持按角色覆盖 sub agent 模型）

## 状态

v0.7：**全量 goal 模式（`allGoalsMode`，默认 false）**——开启后注入「ALL-GOALS MODE ACTIVE」
路由协议：任何用户请求一律先建 goal 再执行（禁止就地分析）；简单只读 → quick 单轮；
复杂分析/写任务 → full 多轮渐进（start 异步 + collect 收敛）；revise 缺省 `abortPrevious`
改为自动决策树（查 goal 板 running 状态：旧轮在跑且 objective/depth 被改写 → 自动中止；
旧轮在跑但目标不变 → 等待自然结束；旧轮未跑 → 直启），显式传值仍是人工控制。
每次修订的 `revisions-<新goalId>.jsonl` 审计行新增 `abort: {abort, mode, basis}`；
`revise` 返回值同样携带 `abort`。决策树纯函数在 `src/controller.ts` 的 `decideAbort`。
关闭模式时提示段与 revise 行为与 v0.6 完全一致（离线测试 48–50 锁死）。`src/` 改动需宿主重载。
v0.7.1：**插件配置面板可视化配置**——`src/index.ts` 导出 schemastery `Config` schema，宿主
0.1.7 settings model 据此派生 Web 编辑器插件条目的设置页（机制同 `@linxin666/dsh-ssh` /
`@linxin666/dsh-usage`：loader 经 `runtime.Config['~standard'].validate` 解析配置，面板由
dsh-client-ui-settings 的共享配置表单渲染，含每个字段的 `description` 文案）。
`allGoalsMode` 标记 `.volatile()`：在面板上切换保存后 loader 直接把新值提交进运行实例
（不 remount），提示段经 `loader/volatile-update` 重挂即时生效；`hardGate`/`gateMode`/
`gatedTools`/`roles` 等结构性字段为普通字段，保存后触发插件行 remount（需宿主重载完成）。
注意：schema 解析会把未设置的 `z.array` 字段变成 `[]` 而非 `undefined`，`apply()` 的门
回退因此按「空数组 = 未设置」处理（离线测试 51 锁死）。此前版本只能手改 profile JSON
里的 `allGoalsMode: true`；现在在 Web 编辑器「插件」页的本插件卡片上直接切换
即可（保存 volatile 字段无需重启宿主，刷新浏览器可见最新面板）。
v0.7.2/0.7.3：**插件页设置卡片**——实测仅有服务端 Config schema 不会在「插件」页产生任何
卡片（本 profile 的 @linxin666/dsh-client-ui-plugin-manager 停用了官方 ui-settings-plugins
设置分区，schema 自动面板无处落脚）。官方插件页（@deepseek-ai/dsh-client-ui-plugin-manager）
只通过它声明的 slot 渲染插件配置：`plugins.item`（「内置插件配置」分组列表卡）、
`plugins.bundle.config`（按 bundle 名分发，bundle 详情页配置区）、`plugins.row.config`
（按 `<bundle>#<rowId>` 分发，组件详情页）。`lib/client.js` 因此注册三个席位：
`plugins.item`（id = `dsh-cybernetics`）、`plugins.bundle.config`（key 同时注册
profile 依赖名 `dsh-cybernetics` 与包名 `@mars.liu/dsh-cybernetics`）、`plugins.row.config`
（key `<bundle>#dsh-cybernetics`）。`plugins.item` 无条件注册（v0.7.5 加固）：早先的
cut 用 `configForms.whileServed` 门控，宿主尚未服务该命名空间时整张卡消失，与「注册
从未运行」不可区分；现改为 `ctx.configForms.get()` 绑定一个跟随共享 describe mirror
的活 ConfigFormController，命名空间就绪的瞬间卡片翻成开关，未就绪时渲染
「配置不可用」行——可见、可诊断。卡片读写 `ctx.configForms.get('dsh-cybernetics')`
的 ConfigForm；v0.7.3 修复：详情页的 owner prop `form`（宿主 ConfigPageForm
`{state, mutate}`）在渲染 seam 上覆盖 inject 的 form（renderer renderEntry 先展开
inject 后展开 ownerProps），卡片两种形态都支持（离线测试 52/53 锁死）。
`dsh.client.inject` 增补 `@deepseek-ai/dsh-client-ui-settings` 保证 configForms 提供方
先到。改动 `lib/client.js` 后需重启宿主（客户端模块图在宿主启动时构建）并刷新浏览器。
v0.7.4：**保存失败可见化**——实机验证（2026-11-03，浏览器实测）：卡片注册、summary 文案、开关渲染
均正常，但切换保存经 `configForms`→`remote.settings.mutate` 到宿主后被**静默拒绝**（写不落盘：
profile `cordis.patch.yml` 未变更，RPC 错误不上控制台，卡片此前 `.catch(() => {})` 吞掉失败，
第一次点击甚至把 promise 挂死在「保存中」）。离线模拟宿主 `dsh-config-editor.edit` 的文档校验
（`composeEntries([patches])` 含 bundle insert 层 + 新增 override 行）是**通过**的，说明拒绝发生在
更早的环节（`reconcileProfilePatches` 预检 / loader 热重载路径），宿主日志在本环境不可读，确切
拒绝原因待宿主侧确认。本轮改动：卡片不再吞错——写入被拒（settles false / reject）或 15 s 未返回
都显示「保存未生效（宿主拒绝了写入）」并立即把开关还原到宿主确认的快照值；成功路径语义不变
（volatile 即时生效）。根治写路径需要宿主侧 settings.mutate 的拒绝日志（`harness-log` 或
`dsh plugin --profile web` 诊断），超出本轮插件仓库边界。
v0.7.5：**卡片注册无条件化**——见上 v0.7.2/0.7.3 段的 `plugins.item` 说明；
宿主日志复核（2026-11-03，`~/.dsh/logs/`）：未发现 cybernetics settings mutate 的拒绝
记录（最近一次启动日志是 EADDRINUSE 的失败实例，当前宿主进程无对应落盘日志），
写路径的宿主侧根因仍待带日志的复现。
v0.7.6：**路径 (b) 落点取证 + 拒绝原因透出**——代码级取证（2026-11-04，宿主 checkout 只读）确认：
`settings.mutate` 的唯一宿主写路径是 `@deepseek-ai/dsh-settings SettingsForms.write` →
`@deepseek-ai/dsh-config-editor ConfigEditor.edit`，后者写入的就是**用户 patch 行**（在 profile
`cordis.patch.yml` 追加/更新 `{id, name, config}` 非 insert 行，再以
`reconcileProfilePatches(root, patches, "dsh", [entry.id])` 应用——见
`dsh-config-editor/lib/index.js` edit() 的 `findLastIndex` + `document.add({id, name, config})`）。
即插件侧写入落点**从来就是**宿主允许的用户 patch 行，"写到了 bundle insert 行"的假设不成立；
实测复现（2026-11-04 浏览器点击开关 + `cordis.patch.yml` mtime 前后比对）显示拒绝发生在宿主
`edit()` **落盘之前**（文件未被触碰、快速返回 settings/rejected），确切 throw 行仍需宿主侧
stderr（tty，本环境不可读）。本轮插件侧改动：写入被拒时经插件自有的 `remote.settings.mutate`
（同一宿主写路径）做**一次无条件 revision 回退写**（expectedRevision 省略 = 宿主文档化的
无条件写），陈旧 revision 冲突可就地自愈；仍被拒时卡片以
「保存未生效，宿主拒绝原因：{message}」透出宿主 RemoteError 原文（ConfigFormController 原本把
错误坍缩成裸 `false`）。离线测试增至 54 项，新增写入落点断言（回退写无 revision、主写成功不触
回退、无 remote 降级不崩）。
v0.6：多 goal session 投影（`cyberneticsGoals`）——goal 板每次变化把本 session 全部 goal 的
整值快照 append 成一条 `plugin:cybernetics/goals` 事件（可跳过的插件记录，宿主持久化读取安全），
服务端纯折叠、宿主整值推送，「目标」页签逐条渲染并就地更新；空板回退到 dsh-goal 单 goal 渲染。
**执行者适配层**：`executor: 'ephemeral' | 'persistent'`（与 depth 正交）——persistent 用 Agent Teams
持久 teammate 执行 task 工作（首轮 spawn fresh，后续轮 sendMessage 投递委托书修订，`subagent/end`
捕获输出）；quick 由输出契约派生 verdict，full 把报告作为 `taskReport` 交给 round.js，verify/triage
仍以临时 agent 独立运行。审计日志记录 `executor`，goal 板记录 `memberName`。
v0.6 追加：**只新增目标模型（append-only goals）**——goal 一经存在不再原地修改。`action: 'revise'`
（必填 `reason`，可选 `objective`/`title`/`depth`/`executor`/`abortPrevious`）创建一个带
`parentGoalId` 的新 goal 并立即启动其第 1 轮，旧 goal 置 `superseded` + `supersededBy` 保留最终状态；
已完成的 goal 同样走这条路径。`abortPrevious` 默认 false（旧轮跑完由 session agent 决定是否打断），
true 时复用 cancel 路径。每次修订追加 `.cybernetics/revisions-<新goalId>.jsonl`。页签按两段排序
（未完成在前、已完成 met/cancelled/superseded 在后，组内 `updatedAt` 倒序；服务端排序、客户端不重排），
并显示「已被 <新标题> 取代」/「修订自 <旧标题>」；`GoalStatus` 增加 `superseded`。
v0.6 追加：**板持久化与 rehydrate**——controller 的 goal 板在每个写点整值快照到
`<workspace>/.cybernetics/board-<sessionId>.json`（`{version, sessionId, savedAt, goals}`，
同目录临时文件 + rename 原子替换，失败不阻断）；重启后首次工具调用拿到空内存板时从快照恢复
（缺失/损坏/版本不符/非法记录一律空板，不抛错）并立即重推一次 `cyberneticsGoals` 投影，
「目标」页签因此不再在重启后清空。同一版「控制」页签新增每个 goal 的执行者行
（状态 + 标题 + executor 临时/持久 + 持久 teammate 名称 + 轮次，未完成在前、已完成在后）；
`GoalView` 增加可选 `memberName`，投影折叠保留。快照是当前状态而非事件日志，`updatedAt` 不持久化。
v0.5：双档轮次（depth）——轻量分析 quick 单 agent 一轮直接反馈；复杂分析与变更走完整工作-验证循环。
v0.4.1：硬门增加 allowlist 模式（只保留读+编排工具，挡住 farm_unregister 类长尾变更工具）。
v0.4：可选硬门（`hardGate: true`）——装配期从顶层 session agent 物理摘除执行工具
（默认 bash/edit/write），编排从劝告变成结构；task agent 不受影响。
v0.3：多 goal 板 + 编排者协议 + 异步轮（`start`/`collect`/`cancel`/`list`）+ task agent 工作委托书（brief）。
轮脚本现读（改 `workflows/round.js` 热生效）；`src/` 改动需宿主重载。
v0.2：session-goal 模式 + 隐式触发 + 角色化 sub agent + 客户端 goal 页签。
服务端已按 dsh 0.2.1-rc.3 真实 API 核对（tools.register / goals service / workingDirectory），
客户端按 ModuleLoader 包装格式手写（参照 dsh-client-ui-goal / dsh-context）。
**端到端回路尚未实跑**：workflow 轮脚本、页签挂载均待首次真实验证。

2026-11-02 触发链路实测：隐式提示注入 ✅、工具注册 ✅；执行原在
`ctx.get('workflowEngine')` 处报 "cannot get property ... without inject"
（宿主 cordis 对未注入服务的属性访问直接抛错，goal 护栏不可达）。
已改为静态 inject `workflowEngine` / `goals` / `workingDirectory`
（对齐 dsh-tool-workflow / dsh-tool-ralph）。
追加实测修正：首次重启后插件仍 pending——`workflowEngine` 是在 `delegation`
group 的 isolate 里提供的（`isolate: workflowEngine: true`），顶层 insert 的
行拿不到它。`cordis.patch.yml` 已改为按组 id 插入（`- id: delegation` +
`insert:`，loader 方言：patch id 指向 group 行时追加进该组 config）。
**待服务端重载后复测**：boot 不再 pending、工具可用、隐式提示段与客户端页签
在组作用域下仍正常注入。
第三次实测修正：按组 id 插入也被跳过（dump-config 报 `entry "delegation" not
found`）——`delegation` 组不在顶层 patch 索引，而是嵌在 `preset-standard`
（`@deepseek-ai/dsh-agent-preset`）的 `config.plugins` 里，patch 应用时那只是
普通 config 对象。最终方案：profile 层 patch 整体重写 `preset-standard` 的
config（Web 编辑器保存走的就是这条路），把 `dsh-cybernetics` 加进其
delegation 组；本插件的 bundle patch 清空为 `[]`。
第四次实测修正：页签仍未出现——浏览器实测发现 boot graph 的 client combo
不含本包：客户端扫描只枚举**顶层** loader entries，挂进 preset 的行对它不可
见。最终方案：插件回到顶层行，`workflowEngine` 不再静态 inject，执行时经
`ctx.agentPresets.serviceFor(agent, 'workflowEngine')` 从 Agent 的 preset
mount 读取（registry 的官方 root-realm 访问器）；inject 收窄为五个根级服务
（tools/systemPrompt/goals/workingDirectory/agentPresets）。同轮还修复 goal
护栏：`goals.get()` 对 completed/paused goal 仍返回视图，现严格要求
`phase === 'active'`，并按 goal id 重置轮次状态。dump 复算确认：顶层行就位、
preset-standard 恢复原样、无 patch 警告。
页签渲染两连修（浏览器实测定位）：① inject 手动传的 `t` 遮蔽了槽位按
`locale: NS` 注入的正确翻译函数（字典注册前 bind 会解析为空串）——inject
不再传 t；② 宿主 jsx 变体忽略 `jsx(type, props, children)` 的第三参，
children 必须放进 `props.children`（对照 dsh-client-ui-trajectory 编译产物），
否则所有文本静默丢失、元素塌缩成空胶囊。修复后「目标 / 控制」两页签均完整
渲染（2026-11-02：goal 徽章/objective/轮次 + 1/11 agent 树与各自 goal 状态）。

第五次实测修正（改名后的回归）：`@mars.liu` 改名把包名从 `dsh-cybernetics` 变成
`@mars.liu/dsh-cybernetics`，loader 行名同步了，但 `lib/client.js` 里
`__ModuleLoader__.load({ id })` 仍是短名 → boot 报
`could not load "@mars.liu/dsh-cybernetics": … loaded without registering`。
规则：客户端 bundle 的注册 id 必须等于 package.json 的 `name`（client-modules
boot graph 以包名为行键，`dsh.client.inject` 里的依赖同样按包名解析）；短名只用于
loader 行 id（`- id: dsh-cybernetics`）。离线测试已加断言锁死这条不变量。

## 与 dsh 现有机制的关系

- goal：不替代——dsh-goal 仍是 durable setpoint 与续跑驱动；本插件是它的工作回路。
- workflow：每轮就是一次 `ctx.workflowEngine.start()` run；不新增编排机制。
- 完成确认：controller 永不自宣完成、不代改 goal phase；met 也只暂停等用户。
- 多 goal（未来）：按 super-agent 模式，sub goal 下沉到 sub session 各自的 dsh-goal。
