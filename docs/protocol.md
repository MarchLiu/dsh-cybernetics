# Cybernetics 工作协议 v0.6（设计稿）

目标-行动-测量-校准的迭代回路，构建在 DSH 的 `dsh-workflow` 编排与 `dsh-goal` 持久目标之上。

## v0.6 设计（未实现）：与 Agent Teams 集成

2026-11-02 与用户逐条定稿的设计决策。尚未写代码；第 0 步验证实验先行（见文末）。

1. **双层修正回路**。内环（行动修正）：本轮 subgoal / 委托书，由 session agent 依据 verdict
   自动调整，每轮记账（现有）。外环（目标修正）：goal 的 objective / 范围，**agent 只能提案，
   用户确认后才生效**——与 dsh-goal「edit 需直接人类输入」的权柄设计一致；修订记录版本号、
   原因、前后对比、触发轮次。多轮迭代中 goal 保持稳定身份，迭代细化的是 subgoal；
   仅当反馈证明目标本身错误时才走外环。目标被悄悄改写会摧毁「经 goal 跟踪 agent」的价值。
2. **委托书修订协议**（持久执行者的消息语义）：`send_message` 只允许投递**委托书修订**
   （新增约束 / 验收标准变化 / 范围收窄），禁止开放式对话；每条修订同样进入 round 日志。
3. **控制页签合并，不替换**：保留 goal 板作为控制面——外环入口（对某 goal 提交修订意见 →
   提案 + 确认）与内环观察面（每轮 subgoal 变化与 verdict）。执行者作为 goal 下的行展示
   （状态 running / 静默 / persistent），数据源为 Lead 会话日志的 `team/member` 事件；
   团队面板是执行者视角，两者互补。
4. **上下文不变量（核心）**：所有二级上下文都是**被配给**的，不是被继承的——
   task agent 只拿委托书；verify agent 只拿 goal + 任务报告 + 证据（绝不拿 task agent 的叙述，
   否则验证被污染）；triage 只拿 verdict；持久队员必须 `context: 'fresh'` 投生、消息只许携带
   委托书修订。**cybernetics 永远不使用 `context: 'fork'`**。持久的是身份和 goal 边界，不是会话历史。
5. **执行者基质二选一**（`executor: 'ephemeral' | 'persistent'`，与 depth 正交）：
   一次性/变更类 goal → workflow 临时 agent（schema 校验报告、最省、已验证）；
   迭代型（多轮分析）goal → 持久 teammate（记忆是特性），verify 仍每轮临时、独立。
6. **软集成**：运行时探测 `ctx.get('agentTeams')`，缺失则回退 workflow（不硬绑实验包）。
   `spawnTeammate` 仅 Team Lead 可调——cybernetics 作为 Lead 的工具调用天然满足；
   goal 板保持唯一真相，不双写 team task 板；每 goal 至多一个执行者；
   goal 完成/cancel 时 `interrupt` + 清理常驻队员。
7. **分步**：第 0 步（验证）：allowlist 加入 `spawn_teammate`/`send_message`/`interrupt_agent`，
   手工养一名分析师跑真实多轮知识库分析，验证协作形态；通过后再实现 Executor 适配层
   （`LoopState.executor` + 外环 revision 记账 + 控制页签执行者行）。

## v0.5 变化：双档轮次（depth）——分析任务分级

分析/查询类任务按复杂度分两级进入 goal 体系（用户 2026-11-02 定稿）：

- **琐碎只读问答**（读工具一步可答的事实，无计算）→ session agent 直接答，不建 goal。
- **轻量分析**（边界清晰、无需多步规划的查询）→ 建 goal，`depth: 'quick'`：
  只跑 task agent 单 agent，一轮出结果直接反馈；跳过 verify/triage，成本约 1/3。
  verdict 由 task report 派生（done → met），controller 决策逻辑不变。
- **复杂分析与一切变更**（取数到本地、数据集统计、多步查询规划、任何状态改变）→
  建 goal，`depth: 'full'`（默认）：完整 工作→验证→分诊 循环，验收通过才交付。
  指导段明令禁止用 quick 轮抄近路做变更或复杂分析。

实现：round.js 按 `args.depth` 分支（热生效）；`LoopState.depth` 逐轮可覆盖；
工具参数 `depth` 枚举 quick/full。

## v0.4 变化：硬门（hard gate）——编排从劝告变成结构

v0.3 及以前，「session agent 不亲自执行」是系统提示里的劝告，模型可自行判断绕过
（琐碎任务直接内联完成）。v0.4 增加可选的**硬门**（`hardGate: true`）：

- 实现：插件注册 `system-prompt/assemble` waterfall 监听器（dsh-system-prompt 的官方扩展点，
  每个模型步触发，可变 assembly、返回值权威），在装配期把执行类工具
  （默认 `bash`/`edit`/`write`，可用 `gatedTools` 覆盖）从**顶层 session agent** 的
  工具清单中物理移除——模型根本看不到这些工具，无法调用。
- 判定顶层 agent 用 `ctx.agents.roots()`（与 dsh-tool-goal 同一 API）；
  workflow 子 agent（task/verify/triage）与 team 成员从不在 roots() 里，
  它们的装配原样通过，保留全部工具——执行能力只属于被编排的执行者。
- 配套提示段追加 HARD GATE ACTIVE 声明，防止模型把「没有 bash」误读为环境故障。
- 默认关闭，部署侧通过 `cordis.patch.yml` 的 `config.hardGate: true` 开启。
- 设计动机（用户 2026-11-02）：思考与行动分离；人类经 goal 跟踪/解释 agent 行为；
  每个 task agent 在有限 goal 上紧凑运行；修正任务（cancel/重启）更自由。
- 已知边界：门在装配层（模型看不见工具），不在执行层（无公开拦截缝）；
  `subagent`/`workflow` 等其他派发工具默认不在门禁清单，如需收口加入 `gatedTools`。

### v0.4.1：allowlist 模式（denylist 的覆盖缺口修复）

实机暴露的缺口：denylist 默认只挡 bash/edit/write，session agent 用 `farm_unregister`
直接删了服务而未建 goal——变更类工具是长尾（farm_*/taskboard_*/knowledge_save/schedule_*/uno_*…），
逐名封堵永远补不完。`gateMode: 'allowlist'` 反转语义：顶层 agent 只保留
**读 + 对话 + 展示 + goal/编排动词**（内置 DEFAULT_GATE_ALLOWLIST，可 `gateAllowlist` 覆盖），
cybernetics 工具自身始终豁免。语义随之明确：**只读问答无需 goal 直接答；
任何「改变世界」的请求——无论多小——都是委派信号**（找不到工具即硬门在起作用）。
本部署 cordis.patch.yml 已启用 allowlist 模式。

## v0.3 变化：多 goal + 编排者 session agent

- **同一 session 支持多个并发 goal**：插件维护自己的 goal 板（`boards: session -> goalId -> loop`）。
  dsh-goal 仍是每 session 单槽，降级为**焦点 goal**（GUI 页签 + goal-round-driver 自动续跑）；
  新建 registry goal 时若 dsh-goal 空槽则尽力同步进去。
- **session agent 是编排者，从不亲自执行任务**：它识别用户输入、提取工作委托书（brief）、
  启动/收取/取消 task agent 轮、向用户转述反馈。
- **异步轮**：`action: 'start'` 后台启动一轮并立即返回；轮结束时插件经 `agent.followup()`
  向 session agent 收件箱排队一条完成通知（与 dsh-goal-round-driver 同一机制），
  session agent 随后 `action: 'collect'` 折叠结果得到 continue/pause 决策。
- **修正路径**：用户对已有任务的修正由 session agent 裁决——`cancel`（中止在跑的轮，
  底层 `WorkflowRun.cancel()`）后带修正 brief 重启一轮，或等 `collect` 后开修正轮。
- v0.2 的单 goal 阻塞调用保持兼容：无 `action`/`goalId`/`title` 时驱动当前 dsh-goal 焦点 goal。

## v0.2 变化：goal 回到 session

- **goal 是 session agent 的思考产物**，通过 dsh-goal 服务持久化（create/edit 是模型动词）。
  用户不精确编辑任何目标文件——**用户通过对话校准 agent，agent 修订 goal**。
- 同一工作区的每个 session 可有自己的 goal（dsh-goal 每 session 单槽）。
- 未来多 goal：按 super-agent 模式（DeepSeek Harness《Super-agent 设计探索》，2026-11-01，
  开源原型 dsh-superagent-prototype），super agent session 持有各 sub agent 的 goal 并据此调度；
  每条 sub goal 下沉到 sub session 各自的 dsh-goal。v0.2 先做单 session 单 goal。

## 角色

| 角色 | 实现 | 职责 |
|---|---|---|
| Session Agent | 调用方 | **编排者**：识别输入（新任务/修正/反馈），维护 goal 板，启动/收取/取消轮，向用户转述；从不亲自执行任务 |
| Controller | `src/controller.ts` | 轮间状态机：`startRound`/`foldRound`/`runRound`，推进/暂停/终止，维护轮审计日志 |
| Task Agent | workflow `agent()` | 独立 sub agent（无对话历史），面向工作委托书（brief）实际执行，产出结构化交付报告 |
| Verify Agent | workflow `agent()` | 把总目标拆成可判定方面逐条验收，产出结构化 verdict |
| Triage Agent | workflow `agent()` | 对后续线索四分拣：auto / defer / reject / human |
| 用户 | 外环 | 对话校准（goal 修订由 session agent 执行）、裁定 human 类目、确认完成 |

## 输入分类协议（session agent 职责）

1. **新任务** → `cybernetics { action:'start', title, brief }` 建 goal 并后台启动 task agent；
   `brief` 是完整工作委托书（背景、路径、约束、验收标准），详细到 subagent 无需对话历史即可完成。
2. **已有任务的修正** → 裁决打断或等待：打断 = `cancel` 该 goalId 后以修正内容重写 brief 重启一轮；
   等待 = `collect` 收完当轮后，以 verdict gaps + 修正内容构造新一轮。
3. **反馈到达**（`round` 的返回值，或异步轮完成通知后的 `collect`）→ 三选一或组合：
   向用户总结；启动验证轮；以缺口为 brief 启动修正轮。

## 隐式触发

插件注入 system prompt 段（`implicitTrigger: false` 可关）：session agent 按上述分类协议
对每个实质性用户输入建 goal / 启动 task agent / 处理反馈，**不等显式要求**。
无任何可解析 goal（无 goalId、无 title、无活跃焦点 goal）时调用工具会报错并提示。

## 结构化判定

- Task 报告：`{summary, done, artifacts, evidence, nextStepThoughts}`
- Verdict：`{met, criteria:[{criterion,pass,evidence}], gaps, goalItselfQuestionable}` —
  `goalItselfQuestionable=true` 时回路禁止自动迭代，回对话重新校准（session agent 修订 goal）。
- Triage：`{auto, defer, reject, human:[{step,rationale,question}]}` — 方向性改动宁可多给 human。

## 回路终止条件

1. `met=true` → 报告完成，**等用户确认**；controller 不自行宣告、不代改 goal phase。
2. `goalItselfQuestionable=true` 或存在 human 类目 → 暂停，回对话。
3. 连续迭代上限（默认 3 轮/子目标，总轮数由 dsh-goal round cap 兜底）→ 暂停并汇报。

## 角色化 sub agent

Config `roles` 表把角色名映射到 `{provider, model}` 覆盖，round 脚本按 `role` 参数取用：
`default`/`verify`/`triage` 固定槽位 + 任意命名任务角色（如 `frontend`/`backend`/`writer`）。

```yaml
- id: dsh-cybernetics
  config:
    roles:
      default: { provider: zai-coding-cn, model: glm-5.3 }
      verify:  { provider: zai-coding-cn, model: glm-5.3 }
      frontend: { provider: zai-coding-cn, model: glm-5.3 }
      writer:  { provider: zai-coding-cn, model: glm-5-turbo }
```

## 审计与可视化

- 每轮结构化结果落 `<workspace>/.cybernetics/round-<goalId>-<N>.json`（追加式审计日志；
  goalId 进文件名，防止多 goal 各自从 1 计轮互相覆盖——v0.3 实机实测发现并修复）。
- goal 状态由 dsh-goal 的 session projection（`goal` 投影）承载，客户端「目标 / Goal」页签
  （`lib/client.js`，conversation.view slot）实时读取渲染：objective 文本 + phase + rounds。
  v0.2 为纯文本渲染；后续演进：任务分解、状态跟踪、verdict 历史可视化（参照 dsh-context 范式）。

## 第 0 步实验记录（2026-11-02）

配置：teammate `analyst`，`context: 'fresh'`，provider `spawn`；两轮真实知识库分析：
首轮委托书（talent_portrait/profile 数据质量评估），次轮委托书修订（423 份 11-01 后刷新批次的
delta 对比 + 压缩为 3 条决策要点）。

观察：
1. **持久记忆生效**：次轮引用了首轮自身结论（「陈志波 92 vs 24」不一致案例、student/researcher
   分面基线），未重做首轮工作；次轮墙钟约为首轮一半。持久身份 + goal 边界成立，
   会话历史只在本队员内累积，符合上下文不变量。
2. **委托书修订语义可行**：只收到增量要求，按约定三段式（分布表/对比结论/3 条要点）交付，
   无开放式对话漂移。
3. **自主分析质量超出委托书要求**：自行发现 PII 入正文、markdown↔JSON 漂移、4% null 维度、
   测试与规范节点混入、1.71 节点/人等——fresh 上下文 + 详细委托书足以支撑高质量领域判断。
4. **只读约束被遵守**：仅写 `.cybernetics/tmp/probe.json`；报告明确说明 401 后未去读取凭据。
5. 成本未精确计量；墙钟首轮约 4 分钟、次轮约 3 分钟。

结论：支持 v0.6 `executor: 'persistent'` 方向。下一步：Executor 适配层（workflow/team 两种传输）
+ 外环 revision 记账 + 控制页签执行者行。
