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
