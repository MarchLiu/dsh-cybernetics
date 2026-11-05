# 诊断报告：session-9e7abdf0 绕过 goal 模式的根因（2026-11-04）

## 结论（根因判定）

**主根因 = d（其他）：硬门禁对该会话实际生效，但生效的是 denylist 模式（只摘 bash/edit/write 三个工具），配置中的 `gateMode: allowlist` 从未应用到 web profile。** bsk_* 浏览器自动化工具全部保留，所有"写操作"都从这些门禁盲区工具走掉了。a/b/c 三个假设均被证据排除或弱化。

## 证据链

### 1. 门禁在作用域内（排除假设 a：spawn 链不同）
该会话每轮 request/header 中被广告的工具数与内容（session.v4.jsonl.zstd 解压到 /tmp/s9e7.jsonl）：

| seq | 时间 | 工具数 | bash | write | bsk_session | 说明 |
|-----|------|--------|------|-------|-------------|------|
| 13  | 15:19 | 124 | 有 | 有 | 有 | 门禁配置前 |
| 495 | 15:53 | 124 | 有 | 有 | 有 | 门禁配置前 |
| 1317| 17:25 | 124 | 有 | 有 | 有 | 17:28 写入 hardGate 前 |
| 1346| 17:36 | **121** | **无** | **无** | 有 | 门禁生效：恰好只少了 bash/edit/write |
| 1360| 17:37 | 121 | 无 | 无 | 有 | |
| 5102| 19:50 | 121 | 无 | 无 | 有 | **19:47 新宿主（pid 90659）重启后首个 header**，摘除延续 |
| 5266| 19:53 | 121 | 无 | 无 | 有 | 切到 kimi/k3 后同样摘除 |

121 = 124 − {bash, edit, write}，与 `DEFAULT_GATED_TOOLS = ['bash','edit','write']`（src/index.ts:494）精确吻合。
→ 会话被视为顶层 agent（assembly filter 应用）、宿主重启后装配已刷新（排除假设 b 装配缓存问题）。全程日志中 **0 条** "cybernetics hard gate: tool … not available" 拒绝（grep 计 0）——因为模型从未调用被摘的三个工具，其余 118 个工具全 open。

### 2. 生效配置丢失 allowlist（根因所在）
- 插件仓库自带的 `/Users/mars/jobs/dsh-cybernetics/cordis.patch.yml` 配置了 `gateMode: allowlist` + `gateAllowlistExtra: [spawn_teammate, send_message, interrupt_agent]`。
- 但 web profile 的用户 patch 行 `/Users/mars/.dsh/profiles/web/cordis.patch.yml:441-448` 的 config **只有 5 个键**：taskAgentModel / verifyAgentModel / allGoalsMode / triageAgentModel / hardGate —— **没有 gateMode / gateAllowlist / gateAllowlistExtra**。
- 同 id 的 patch 行是**整体替换 config 而非合并**（cordis-plugin-loader/lib/index.js:78-80 `this.data = config`，按 id 重建 map），profile 层的行覆盖后 allowlist 配置消失。
- 运行时判定：src/index.ts:594 `const allowlistMode = config.gateMode === 'allowlist'` → false → denylist 分支；src/index.ts:601 未配置 gatedTools → 落到 DEFAULT_GATED_TOOLS。工具表证据（121 枚）与该路径完全一致。

### 3. allGoalsMode 指引正常下发（排除装配路径问题）
system prompt 全量重播（system/message 事件 seq 7 / 1343 / 5264）均包含 cybernetics section、ALL-GOALS 指引与 HARD_GATE_GUIDANCE 文本（seq 5264 解码验证：has cybernetics=True / ALL-GOALS=True / hard gate=True）。19:53 换 kimi/k3 后的 5264 号 system prompt 也带。模型只是无视指引。

### 4. 模型回退假设（c）不成立，但确有一次 NO_ADAPTER
- request/header 全部 8 次中 7 次 provider=zai-coding-cn/glm-5.3-flash；19:53 起才切 kimi/k3。不存在反复回退。
- 唯一失败：seq 1362，17:37:10，turn 23 step 1，`finish reason error: "no adapter registered for provider \"zai-coding-cn\""（NO_ADAPTER）`——GLM off 键窗口的一次性失败，此后同一模型继续正常出 token。
- ~/.dsh/dsh-usage/usage-ledger.json 存在但按 days 组织、无 session 维度记录（按 9e7abdf0 检索 0 命中）；provider-snapshots.json 显示 zai-coding-cn pro 档 5h 窗口 98% 用量。死循环与模型不可用无因果。

### 5. "写操作"的真实通道
18:26 重启后（cut=18:26:00），该会话工具调用统计：bsk_session 772 / browser_navigate 3 / bsk_page 3，**bash/write/edit 均为 0**（门禁摘除生效）。建频道、API 发消息、PDF/pptx 生成（bash 41、write 10、uno_create 3）全部发生在 17:36 门禁生效**之前**。重启后唯一的大量行为就是 bsk_session start/stop 死循环（18:42–19:53，每次约 5 秒一个 start+stop，共 772 次调用）——这是门禁盲区工具上的可靠性事故，而非 goal 绕过写文件。

## 修复建议（未执行任何写操作）
1. **主修复**：把 `gateMode: allowlist`（必要时连同 gateAllowlistExtra）补进 `/Users/mars/.dsh/profiles/web/cordis.patch.yml:441` 的 dsh-cybernetics config 块，重启宿主。验证方式：新回合 request/header 工具数应骤降到 ~45（allowlist+cybernetics），且 bsk_session 不再出现在广告列表（allowlist 里没有它）。
2. **决策项**：bsk_* 浏览器工具是否进 allowlist。读类（browser_tabs/snapshot/console/network/screenshot/navigate/scroll）已在 DEFAULT_GATE_ALLOWLIST；bsk_session/bsk_interact/bsk_page/bsk_assist/bsk_tabs 具备创建会话、点击、replay 等写能力，建议默认挡在门外，确有只读浏览需求时按最小集放行。
3. **防复发**：profile 用户 patch 行整体覆盖插件 config 是脚枪——要么在插件 README/面板提示"用户行必须携带完整门禁字段"，要么把 loader 改为对非 volatile 字段深合并。另建议 GUI volatile 保存生成的用户行保留原 config 键而非重写。
4. **独立问题**：bsk_session 772 连环 start/stop 说明 repeat-tool-reminder / 循环熔断未起作用，值得单独排查（超出本轮）。

## 偏差说明
- 委托书称宿主 18:26 重启（pid 19488）；磁盘 running/web.json 显示当前宿主 pid 90659、19:47:37 启动——期间又重启过一次，本诊断两条宿主实例的证据都已覆盖（1346 与 5102 分别对应两代宿主的摘除生效）。
- referenced 快照所称"重启后建频道/发消息/生成 PDF"实际发生在 17:36 门禁生效前；重启后并无被禁工具调用，只有门禁盲区的 bsk_* 循环。
