# 为 sub agent 增加思考强度（reasoning effort）选项 — 交付说明

目标：在 dsh-cybernetics 设置页为每个 sub agent（task / verify / triage）增加思考强度选项，
档位随所选模型动态变化，与模型一样持久化，并在 sub agent 调用路径上生效。

## 前提偏差（重要）

本任务 agent 的文件沙箱仅允许写本会话工作区（/Users/mars/jobs/dsh-cybernetics），
对检出目录 /Users/mars/.dsh/profiles/web/ 的任何写入都被策略拒绝（沙箱提示
`file access denied under workspace-write mode`，且升级重试被自动驳回，无应答者）。
因此全部改动在 `stage/` 暂存副本上完成并通过验证，由 `apply.sh` 落盘（需有写权限的
shell 执行一次，自动先备份 `.bak-pre-effort-<时间戳>`，可回滚）。

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
  - 模型不支持强度：下拉禁用 +「该模型不支持思考强度」，绝不出空下拉/报错；
  - 未配置模型（继承 session agent）：禁用 + 提示先选模型；
  - 目录未就绪：禁用 + 加载提示；
  - 配置的档位不在该模型支持列表（枚举变化/配置损坏）：显示实际生效值（模型默认）
    + 回退说明，存储值仅在用户主动保存时被覆盖（与“一键清除”同策略，不静默改配置）；
  - 选择即经共享 writeField 落 volatile 写（'' = unset 操作）。
- zh/en 词典各加 9 个 key。

## 验证（全部在 stage/ 副本上执行）

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
与补丁无关；补齐后 75/75 通过。

## 应用与回滚

```
bash /Users/mars/jobs/dsh-cybernetics/effort-patch/apply.sh
# 然后重启 DSH 宿主：Node 半（src schema 仅启动时读取）与 client bundle 均需重载。
# 回滚：用 apply.sh 输出的 .bak-pre-effort-<时间戳> 覆盖回同名文件。
```

## 手动验证路径（应用并重启后）

1. Web 设置 → 插件 → dsh-cybernetics：三个模型字段下方各出现「思考强度」下拉。
2. 选 glm-5.3（reasoningEfforts: off/minimal/low/medium/high/max）→ 下拉出现全部档位；
   选无强度模型（如 doubao-seed-2.1-pro）→ 禁用 +「该模型不支持思考强度」。
3. 清空模型字段 → 强度下拉禁用并提示先选模型。
4. 选择档位 → 即时保存（卡片顶部「保存中」→消失）；下一轮 goal 的子 agent 请求带
   reasoningEffort（可在会话日志/子 agent 描述符 agentReasoningEffort 处核对）。
5. 故障回退：手工在 profile patch 里写入该模型不存在的档位 → 下一轮该子 agent 首调
   失败、轮结果 fallbacks 记录，回合以 session 默认完成，UI 不崩溃。

## 风险

- dsh-workflow-ptc 与 dsh-cybernetics 均为 node_modules 内已装包，`pnpm install`
  / 插件升级会覆盖补丁（apply.sh 的 .bak 保留原样，可重放）。
- guest 源补丁位于嵌入字符串内，宿主升级换版本后需按新版本重打（替换模式集中在
  patch.mjs，可核对后复用）。
