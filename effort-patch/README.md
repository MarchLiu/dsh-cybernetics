# 为 sub agent 增加思考强度（reasoning effort）选项 — 交付说明

目标：在 dsh-cybernetics 设置页为每个 sub agent（task / verify / triage）增加思考强度选项，
档位随所选模型动态变化，与模型一样持久化，并在 sub agent 调用路径上生效。

## 现行部署路径（唯一，方案 B）

**apply.sh 已废弃删除（2026-11-06，用户裁定方案 B）**：它是早期整树恢复脚本，其消费的
`stage/dsh-cybernetics/` 4 个源副本停留在 R1 平铺布局旧版，与 v0.15.1 分组版存在实质
差异；而 live 部署就是本仓库本身（web profile 的符号链接指向本检出），误跑会把 live
回退到旧版。原「勿重跑」警示随脚本移除一并作废，隐患彻底出库。同批删除的 5 个
stage 副本（均仅被 apply.sh 消费）：`src/index.ts`、`src/controller.ts`、
`workflows/round.js`、`lib/client.js`、`test/v14-effort-row.mjs`。

现行且唯一的部署/重打补丁路径：

| 目标 | 工具 | 用法 |
|---|---|---|
| dsh-cybernetics 四文件源锚点补丁 | `patch-v2.mjs`（补丁表 `patches.mjs`） | `node effort-patch/patch-v2.mjs check\|dry-run\|apply` |
| dsh-workflow-ptc 接缝补丁 | `apply-ptc.mjs` | `node effort-patch/apply-ptc.mjs check` → `apply` → `verify` |
| 端到端探针 | `e2e-ptc-effort.mjs` | `node effort-patch/e2e-ptc-effort.mjs` |

- `patch-v2.mjs` 默认根为本仓库检出（即 live install 符号链接目标），`apply` 逐文件
  `.bak` 备份后按锚点改写，替换内容已存在的补丁自动跳过（幂等）。
- `apply-ptc.mjs` 消费 `stage/dsh-workflow-ptc/lib/index.js`（唯一保留的 stage 副本，
  已打补丁接缝的重装源）：写入前断言 real 侧未打补丁 pre-anchor 与 stage 侧
  post-anchor 一一唯一匹配，任一失配零写入退出 1——对 live 已打补丁文件，check 的
  real 侧 pre-anchor 失配是预期状态，该模式本就拒绝盲目重装；写入前取时间戳 `.bak`。
- 历史备注：R1 交付时检出写权限受限，改动先在 `stage/` 副本上验证、再由 apply.sh
  落盘；v0.15 起改由上述锚点工具直接作用（工作区即 live install），staging 中间层
  与整树恢复脚本不再存在。

## 改动内容（5 个文件 + 1 个新测试）

### 1. 引擎接缝：`@deepseek-ai/dsh-workflow-ptc/lib/index.js`
workflow `agent()` 的选项白名单原本只有 label/phase/schema/provider/model，传
reasoningEffort 会以 UNSUPPORTED_OPTION 致命失败。补丁（共 7 处替换，脚本内逐一
断言命中数）：
- 嵌入的 guest 源（WORKFLOW_GUEST_SOURCE 字符串内）：SUPPORTED_AGENT_OPTIONS 增加
  `reasoningEffort`；字符串类型校验列表同步；readAgentOptions 返回包透传；
  startAgent 请求透传。
- 宿主侧：`childRequest` 解析并转发 reasoningEffort；`startChild` 把它并入
  `agentOptions`（含“三者皆空才省略 agentOptions”的门控修正）。
下游 `dsh-subagent` 的 startActivation/child-agent 原生支持
`agentOptions.reasoningEffort`（descriptor/请求构造路径均有该字段），故链路至此打通，
无需改动 dsh-subagent。

### 2. 轮脚本：`@mars.liu/dsh-cybernetics/workflows/round.js`
- `specFor` 支持 reasoningEffort（含“仅强度无模型覆盖”的形态，作用于继承的
  session 模型）；强度与 provider/model 同包传给 `agent()`。
- `overridden`/`specLabel` 计入强度；AVAILABILITY_PATTERNS 增加
  `/reasoning effort|thinking level/i`——适配器对不支持的档位抛
  UNSUPPORTED_REASONING_EFFORT（实测 `dsh-llm-pi-ai` 的 `resolveReasoningLevel`），
  命中后沿用 v0.8 调用级回退：整包撤销覆盖、以 session 默认模型重试一次，
  并记录进轮审计 fallbacks。

### 3. 控制器/Schema：`src/controller.ts`、`src/index.ts`
- `RoleSpec` 增加 `reasoningEffort?: string`。
- Config 接口与导出 schema 增加三个 volatile 字段：
  `taskAgentReasoningEffort` / `verifyAgentReasoningEffort` / `triageAgentReasoningEffort`
  （`z.string().default('').volatile()`，与模型字段同款：保存即时生效、下一轮 goal 生效）。
- 配置折叠处合并进 roles.default/verify/triage，并对非字符串/空白做净化
  （异常配置退化为“不发送该参数”）。

### 4. 设置页 UI：`lib/client.js`
- 模型目录 store 现在保留每个模型的 `reasoning` 能力元数据
  （efforts[] + defaultEffort）——与会话输入框 model picker 同一数据源
  （`remote.session.modelCatalog()`）。
- 新增 `findCatalogModel`（与既有 isConfiguredModelAvailable 相同的匹配规则）与
  `effortRow`（kind: 'effort'，成对跟随每个模型字段）：
  - 选项 = 「跟随模型默认（不发送参数）」+ 该模型 reasoning.efforts（按目录顺序）；
  - v0.17.3：模型无强度档位（reasoning 缺失 / efforts 为空）时**不再禁用、不再提示**
    ——下拉保留且仅含「跟随模型默认」一项（该项本就不发送参数，恰是这类模型所需）；
    无档位模型上存旧 token（off/high…）→ **无任何提示**，仍不改写配置
    （只有模型确有档位、且值不在其中时才提示回退）；
  - v0.17.3：纯 off 模型（所有档位的 id 或 name 均为 off/none，大小写不敏感）与
    「跟随模型默认」语义相同 → 折叠为该项（存储的 off id 显示为默认，不报警、不写）；
    含任一真实档位的模型（如 glm-5.3 的 off/minimal/…/max）完整保留 off，去重不扩大；
  - 未配置模型（继承 session agent）：禁用 + 提示先选模型；
  - 目录未就绪：禁用 + 加载提示；
  - 模型有档位但配置的档位不在声明列表（枚举变化/配置损坏）：显示实际生效值
    （模型默认）+ 回退说明，存储值仅在用户主动保存时被覆盖（与“一键清除”同策略，
    不静默改配置）；无档位模型不进入该分支（零提示）；纯 off 模型上 off/none 之外的
    存量 token 仍提示（真实不匹配）；
  - 选择即经共享 writeField 落 volatile 写（'' = unset 操作）。
- zh/en 词典各 8 个 key（v0.17.3 删除 `settings.effortUnsupported`）。

## 验证（R1 交付时，全部在 stage/ 副本上执行）

| 验证 | 结果 |
|---|---|
| `node --check` ptc/index.js、cybernetics/lib/client.js | 通过 |
| `node --experimental-strip-types --check` src/index.ts、src/controller.ts | 通过 |
| round.js 以 workflow VM 方式编译（顶层 return 合法性） | 通过 |
| round.js 功能桩测试：模型+强度透传 / 仅强度透传 / 不支持强度→回退默认并记录 fallbacks / 无覆盖不变 | 通过 |
| 提取 guest 源并编译 + mock host 端到端：reasoningEffort 到达 startChild；未知选项仍 UNSUPPORTED_OPTION | 通过 |
| 插件自带离线套件 v03（75 项）、v09、v10、v12、v13 于打补丁后的副本全部通过 | 通过 |
| 新增 test/v14-effort-row.mjs（动态选项/不支持禁用/无效档位回退显示/写路径 set+unset） | 通过 |

v03 在暂存环境最初失败两次均为 staging 缺文件（README/node_modules 软链），
与补丁无关；补齐后 75/75 通过。注：上表引用的 stage 测试副本已随 apply.sh 废弃
出库；仓库现行测试为 `test/v15-effort-reasoning.mjs`（命名演进）。

## 部署与回滚

```
# 1) cybernetics 四文件源锚点补丁（默认根 = 本检出 = live install）：
node effort-patch/patch-v2.mjs check        # 锚点唯一性预检（无写入）
node effort-patch/patch-v2.mjs dry-run      # 预检 + 逐文件锚点计数（无写入）
node effort-patch/patch-v2.mjs apply        # 逐文件 .bak 备份后按锚点改写
# 2) ptc 接缝补丁（profile 内已装包）：
node effort-patch/apply-ptc.mjs check       # stage/real 双侧锚点校验（无写入）
node effort-patch/apply-ptc.mjs apply       # 时间戳 .bak 后安装
node effort-patch/apply-ptc.mjs verify      # 确认 live 含全部接缝锚点
# 然后重启 DSH 宿主：Node 半（src schema 仅启动时读取）与 client bundle 均需重载。
# 回滚：两个工具 apply 前均逐文件留 .bak（patch-v2：.bak；apply-ptc：带时间戳），
# 覆盖回同名文件即可。
```

> **v0.17.3 幂等性修正**：`client:effort-row-renderer` 补丁条目新增显式 `done` 标记
> （= `CLIENT_EFFORT_ROW` 逐字块）。此前该条目的“已应用”检测依赖整段 `replace`（含
> fieldRow 尾部），v0.17 增补 preset 行后永不命中，`check` 会把它报为 ready、`apply`
> 会重复插入 effortRow。现在对当前检出 `check` / `dry-run` 均为
> **0/22 anchor ready, 0 failure（全部 SKIP）**，重打补丁不会回退也不会重复。

## 手动验证路径（应用并重启后）

1. Web 设置 → 插件 → dsh-cybernetics：三个模型字段下方各出现「思考强度」下拉。
2. 选 glm-5.3（reasoningEfforts: off/minimal/low/medium/high/max）→ 下拉出现全部档位
   （含 off；有真实档位的模型不做 off 去重）；
   选无强度模型（如 ollama/qwen3.8:latest、doubao-seed-2.1-pro）→ 下拉**仍可点击**，
   仅一项「跟随模型默认」，**无黄色警告**；
   若该模型上配置里存了旧档位 token（off/high…）→ 仍然**无任何提示**
   （模型没声明任何档位，不存在可回退的声明列表）；
   选纯 off 模型（档位只有 off / none）→ 同样只有「跟随模型默认」一项、无警告；
   若此前存的是 off，下拉显示为「跟随模型默认」（同一选项，不报警、不改写配置）；
   若此前存的是 high 等 off/none 之外的 token → 仍显示回退说明（它确实不在声明档位里）。
3. 清空模型字段 → 强度下拉禁用并提示先选模型。
4. 选择档位 → 即时保存（卡片顶部「保存中」→消失）；下一轮 goal 的子 agent 请求带
   reasoningEffort（可在会话日志/子 agent 描述符 agentReasoningEffort 处核对）。
5. 故障回退：手工在 profile patch 里写入该模型不存在的档位 → 下一轮该子 agent 首调
   失败、轮结果 fallbacks 记录，回合以 session 默认完成，UI 不崩溃。

## stage 收敛史（2026-11-06）

- **方案 a（同日早前）**：stage/ 全量镜像瘦身，只保留被补丁工具实际消费的 6 个
  tracked 文件（删除 26 个镜像文件，约 -9 千行）。
- **方案 B（本轮，用户裁定）**：apply.sh 出库，连带删除其独占消费的
  `stage/dsh-cybernetics/` 5 个文件与空目录骨架。stage/ 现仅存
  `stage/dsh-workflow-ptc/lib/index.js`（apply-ptc.mjs 的校验/重装源）。
- 出库后全仓（文档/脚本/测试）无 apply.sh 残留引用；废弃决定记录于本节与
  docs/CHANGELOG.md v0.15 条目。

## 风险

- dsh-workflow-ptc 与 dsh-cybernetics 均为 node_modules 内已装包，`pnpm install`
  / 插件升级会覆盖补丁；重打用上述锚点工具（两者 apply 前均自动留 `.bak`，可回滚）。
- guest 源补丁位于嵌入字符串内，宿主升级换版本后需按新版本重打（现行替换模式集中在
  patches.mjs，可核对后复用）。
