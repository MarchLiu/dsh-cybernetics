# 诊断报告：DSH Web 重启后本地模型供应商全部消失（只剩 deepseek）

- 诊断时间：2026-11-04 17:39–17:43（Asia/Shanghai）
- 对象：`/Users/mars/.dsh/profiles/web/`（当前 3080 端口 Web GUI，pid 65486，startedAt 2026-11-04T09:36:57Z = 17:36:57 本地）
- 结论：**判定 (b) —— 供应商配置没丢，但 YAML 被 PyYAML round-trip 改成了「布尔键」，导致 `llm-pi-ai` 的整段 Config 校验失败、插件 entry 被 cordis 判为 inactive。**
- 本轮未做任何写入（profile 目录在我这个 subagent 的 sandbox 之外，写入被 EPERM 拒；见「执行边界」）。

---

## 1. 根因（一句话）

17:2x 用 `python3 yaml.safe_dump` 对 `cordis.patch.yml` 做整体 round-trip 时，PyYAML 按 **YAML 1.1** 把 `reasoningEfforts:` 下的裸键 `off:` 解析成布尔 `False`，重新 dump 成 `false:`；
DSH 侧用 **js-yaml（YAML 1.2 core schema）** 读回来，`off` 本来是字符串、`false` 也变成字符串键 `"false"`
（`reasoningEfforts` 的键只允许 `off|minimal|low|medium|high|xhigh|max`），于是 `z.object({ providers: z.dict(profile) })` 校验直接失败：

```
$.providers.zai-coding-cn.models[6].reasoningEfforts expected false | { [key: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"]: string | Schema<const> }
  but got {"false":null,"minimal":"high","low":"high","medium":"high","high":"high","max":"max"}
```

`llm-pi-ai` 这一个插件就是 `zai-coding-cn`(GLM/智谱) / `kimi` / `ollama` 三条 route 的唯一来源；
配置校验抛错后 cordis 把该 entry 置为 inactive（只写日志、不阻断 boot），三条 route 全部不注册。
剩下的 `deepseek-account` 来自**另一个独立插件** `@deepseek-ai/dsh-llm-deepseek-account`（OAuth 账号，`PROVIDER = "deepseek-account"`），
不受这段配置影响 —— 所以现象精确地表现为「只剩 deepseek」。

---

## 2. 证据

### 2.1 供应商配置确实还在文件里（排除 (a)）

`/Users/mars/.dsh/profiles/web/cordis.patch.yml` L30–L122：

| 行 | 内容 |
|---|---|
| L30–33 | `- id: llm-pi-ai` / `name: '@deepseek-ai/dsh-llm-pi-ai'` / `config:` / `providers:` |
| L34–72 | `zai-coding-cn`（displayName `GLM (智谱)`，8 个模型：glm-4.5-air…glm-5.3-flash） |
| L73–102 | `kimi`（`api: openai-completions`，`baseURL: https://api.kimi.com/coding/v1`，4 个模型） |
| L103–122 | `ollama`（`baseURL: http://localhost:11434/v1`，2 个模型） |

配置文件哈希（本次快照）：`cordis.patch.yml` = `0e2222b5f0537ebbc48746a6e8e8ee80cc2d4591d7311cd84c930ccec0344339`，9739 B / 449 行 / mtime 17:38:02。

### 2.2 语义差异只有 8 处（其余全是引号/注释/缩进等价改写）

脚本 `.diag/semdiff.mjs`（js-yaml 解析两份文件后按 entry id 递归比较）：

```
entries only in BACKUP: []      entries only in CURRENT: []
semantic differences (8):
 - llm-pi-ai…zai-coding-cn.models[6].reasoningEfforts.off: null -> <absent>
 - llm-pi-ai…zai-coding-cn.models[6].reasoningEfforts.false: <absent> -> null
 - llm-pi-ai…zai-coding-cn.models[7].reasoningEfforts.off: null -> <absent>
 - llm-pi-ai…zai-coding-cn.models[7].reasoningEfforts.false: <absent> -> null
 - agent-default-model.config.provider: "zai-coding-cn" -> "deepseek-account"
 - agent-default-model.config.model: "glm-5.3-flash" -> "deepseek-flash"
 - agent-default-model.config.reasoningEffort: <absent> -> "high"
 - dsh-cybernetics.config.hardGate: <absent> -> true
```

即：**没有条目丢失**；`tool-email.accountsYaml` / `serverPresets` 从 block scalar 变成转义双引号串是**同值改写**（语义比较未报差异）；
注释全丢（449 行 vs 469 行、9739 B vs 15328 B）只是外观损失，不是本次故障原因。
`agent-default-model` 被改成 `deepseek-account/deepseek-flash` 是**故障之后**的连带改动（round-trip 之后、与 17:28 备份的差别），不是原因。

### 2.3 用插件真实 schema 复现（决定性证据）

脚本 `.diag/validate.mjs`，直接 import 已安装的 `@deepseek-ai/dsh-llm-pi-ai`（`export { Config … }`）并调用 `Config(config)` —— 与运行时 `resolveConfig` 同一条路径：

```
===== CURRENT  cordis.patch.yml =====
provider routes: [ 'zai-coding-cn', 'kimi', 'ollama' ]
  zai-coding-cn/glm-5.3      reasoningEfforts keys: [ 'false','minimal','low','medium','high','max' ] values: [ null,'high','high','high','high','max' ]
  zai-coding-cn/glm-5.3-flash reasoningEfforts keys: [ 'false',… ]
  Config() => THREW: $.providers.zai-coding-cn.models[6].reasoningEfforts expected false | { [key: "off" | …] } but got {"false":null,…}
===== BACKUP   cordis.patch.yml.bak-pre-hardgate-20261104-172829 =====
  zai-coding-cn/glm-5.3      reasoningEfforts keys: [ 'off','minimal','low','medium','high','max' ]
  Config() => OK
```

schema 定义（`node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`）：
- L1033 `const reasoningEfforts = z.dict(z.union([z.string(), z.const(null)]), z.union(THINKING_LEVELS));`
- L1040 `reasoningEfforts: z.union([z.const(false), reasoningEfforts]),`
- L1083 `const Config = z.object({ providers: z.dict(profile).default({}).volatile() });`
- L299 `const THINKING_LEVELS = Object.keys({ off, minimal, low, medium, high, xhigh, max … })`
- L1024–1027 注释本身写明「valueless key (`off:`) 靠 schemastery 对 nullable 的放行才通过」——**它要求的是字符串键 `off`**。

### 2.4 为什么「校验失败 = 插件静默消失，而不是启动失败」

`node_modules/@deepseek-ai/cordis/lib/index.js`：

- L956–959 `resolveConfig()`：`const result = runtime.Config["~standard"].validate(config); if (result.issues) throw new ValidationError(result.issues);`
- L1348–1362 `_reload()`：`try { … this.config = this._resolveConfig(this._config); … } catch (reason) { this.ctx.logger.error(reason); this._error = reason; this._runner.epoch = INACTIVE; }`

即：异常被 catch → 打日志到进程 stderr → entry 变 INACTIVE。整站照常启动（`~/.dsh/dsh-config-manager/boot-state/boot-state.json`: `ok:true, lastGoodAt 2026-11-04T09:36:58.544Z`），
只是 `llm-pi-ai` 这个 adapter 从未 `ctx.llm.registerAdapter(routes, adapter)`（`lib/index.js` L2943/2956 的 `ensureRegistrationFacts`），于是模型选择器里那三组供应商整组消失。

### 2.5 现场（live）证据：模型选择器里只有 DeepSeek 账号一组

`browser` 打开当前 GUI `http://127.0.0.1:3080/`，点开输入框左下「选择模型」：
只出现 `DeepSeek 账号` 分组，内含 `DeepSeek-V4.1-Flash` / `DeepSeek-V4-Pro`（重复两行是账号目录的两次 listing），
**没有** `GLM (智谱)` / `Kimi Code` / `Ollama (本地)` 三组。
截图：`.diag/evidence/live-model-picker-only-deepseek.jpg`。

### 2.6 排除的两个替代解释

- **不是凭证丢失**：`/Users/mars/.dsh/.credentials-cli.yaml` 的 `refs` 里有 `ZHIPU_API_KEY`、`KIMI_API_KEY`、`DEEPSEEK_API_KEY`，`records` 里有 `deepseek-account-platform/*`（值未读取、未输出）。故 `apiKeyEnv` 引用可解析。
  唯一缺的是 `OLLAMA_API_KEY`（ollama 本地一般不需要真 key，但**修复后请顺手确认 ollama route 是否能解析凭证**）。
- **不是换了 profile / 账号**：`~/.dsh/dsh-config-manager/running/web.json` 显示 `name: web, pid 65486, port 3080, startedAt 2026-11-04T09:36:57.504Z`；
  `cordis.yml` 仍是 `[]`（profile 根，补丁层负责组合）；`cordis.patch.yml` 是唯一用户层。
  `~/.dsh/dsh-usage/provider-snapshots.json` 里也只有 `deepseek-official`（DeepSeek 余额快照），与现场一致。

### 2.7 时间线与文件清单（`ls -la /Users/mars/.dsh/profiles/web/`）

| 文件 | mtime | 大小/行数 | `off` 键 | hardGate | 说明 |
|---|---|---|---|---|---|
| `cordis.patch.yml` | **17:38:02** | 9739 B / 449 行 | ❌ `false:` ×2 (L49, L65) | ✅ L449 | 当前生效态，PyYAML 风格（序列缩进、无注释） |
| `cordis.patch.yml.bak-pre-hardgate-20261104-172829` | 17:28:41 | 15328 B / 469 行 | ✅ `off:` ×2 (L96, L112) | ❌ | **最佳恢复源**（仅 10 分钟前，注释完整） |
| `#cordis.patch.yml#` | 17:38:26 | 9110 B / 330 行 | ❌ `false:` ×2 | ✅ | Emacs 自动保存，js-yaml 风格；同样损坏，不可用 |
| `.#cordis.patch.yml` | 17:37 | symlink | — | — | **Emacs 文件锁 → 有人正开着这个文件**（见风险 3） |
| `cordis.patch.yml~` | 11-03 21:58 | 20102 B / 613 行 | ✅ | ❌ | 更老的 Emacs 备份（早于 cybernetics 改动） |
| `cordis.patch.yml.bak-genui` / `.bak-bisect` / `.bak-20261028-…-pre-agents` | 10-22 | 18590 B / 565 行 | ✅ | ❌ | 更老，均包含完整 providers，可作后备恢复源 |

结论修正：先前「修正轮声称恢复了备份再用文本插入 hardGate」**与磁盘事实不符** —— 当前文件没有一行注释、且是 PyYAML dump 风格，说明最终落盘的是 round-trip 版本（可能是 17:38 的再次 dump 或编辑器/配置编辑器回写）。

---

## 3. 建议修复（**未执行**，等确认）

### 方案 A（推荐，最小改动，2 行）
把 L49 与 L65 的 `false: null` 改回字符串键 `'off': null`（加引号，避免任何 YAML 1.1 解析器再次误判）：

```yaml
            reasoningEfforts:
              'off': null
              minimal: high
```

脚本：`.diag/fix-A-quoted-off.sh`（自带备份 + 2 处计数校验 + 用真实 schema 复验；已在副本上实测通过）

```sh
/Users/mars/jobs/dsh-cybernetics/.diag/fix-A-quoted-off.sh
# 或手工：
cp -p /Users/mars/.dsh/profiles/web/cordis.patch.yml \
      /Users/mars/.dsh/profiles/web/cordis.patch.yml.bak-pre-offkeyfix-$(date +%Y%m%d-%H%M%S)
sed -i '' "s/^              false: null$/              'off': null/" \
      /Users/mars/.dsh/profiles/web/cordis.patch.yml
# 复验（必须 OK 才继续）
node /Users/mars/jobs/dsh-cybernetics/.diag/validate.mjs   # 期望 CURRENT 也 OK
```

代价：注释仍然缺失（不影响功能）；`agent-default-model` 仍是 `deepseek-account/deepseek-flash`（可用，但默认模型不是 GLM）。

### 方案 B（顺带找回注释）
以 17:28 备份为基底还原，再**文本**追加 `hardGate: true`（不要再任何 YAML round-trip）：

```sh
/Users/mars/jobs/dsh-cybernetics/.diag/fix-B-restore-backup.sh
```
脚本内容 = `cp` 备份覆盖 → 在 `triageAgentModel: zai-coding-cn/glm-5.3-flash` 后插入 `    hardGate: true` → 复验；已在副本实测：470 行 / 74 行注释 / `Config() OK` / `hardGate=true, allGoalsMode=true`。
代价：回滚 17:28 之后对 patch 文件的其他改动 —— 实测只有 `agent-default-model`（→ 会变回 `zai-coding-cn/glm-5.3-flash`）。

现成的整文件候选（已按方案 A 修好，可直接 diff 后覆盖）：`.diag/cordis.patch.yml.fixed-candidate`
（sha256 `b75b36fe…9da2e56d`，与当前文件的差异**仅** L49/L65 两行）。

### 生效方式
`@deepseek-ai/cordis-plugin-loader` 没有文件 watcher（grep 无 `watch/FSWatcher/chokidar`），改文件**不会热生效** → 必须重启 `dsh web`：

```sh
# 1) 停掉 3080 上的 dsh web（pid 见 ~/.dsh/dsh-config-manager/running/web.json，当前 65486）
# 2) 重启
dsh web        # 或 dsh --profile web
# 3) 验证：GUI 模型选择器应重新出现 GLM (智谱) / Kimi Code / Ollama (本地) 三组；
#    或 dsh --profile web --dump-config | grep -A3 llm-pi-ai
```

---

## 4. 风险与注意事项

1. **我无法执行修复**：本 subagent 的 sandbox 是 `workspace-write`（工作区 `/Users/mars/jobs/dsh-cybernetics`），写 `/Users/mars/.dsh/...` 被拒。
   实测：`node_modules/.bin/dsh --profile web --dump-config` 想回写 `cordis.yml` 直接
   `Error: EPERM: operation not permitted, open '/Users/mars/.dsh/profiles/web/cordis.yml'`（见 `.diag/dump-current.err`）。
   → 修复必须在有 profile 写权限的会话/终端里执行。
2. **不要再对 `cordis.patch.yml` 做 `yaml.safe_dump` 整体重写**。要改配置请用文本编辑（或带 YAML 1.2 schema 的 js-yaml 并显式引号化 `off`）。
   本次故障的唯一机制就是这个；`kimi/ollama/zai` 数据本身全程都在文件里。
3. **Emacs 正开着这个文件**：`/Users/mars/.dsh/profiles/web/.#cordis.patch.yml`（17:37）+ `#cordis.patch.yml#`（17:38:26）。
   若那个 buffer 里还是 `false: null`，一旦保存就会把修复覆盖回去。修复前先关掉该 buffer。
4. **别再让设置 GUI 回写整份 patch**（`@deepseek-ai/dsh-config-editor` 用 `js-yaml` load + `yaml` AST 写回）：它在文本层面保留已有键，一旦文件里已是 `false:` 就会继续保留 `false:`。修完后再操作设置页，请复查 L49/L65。
5. 根因与「只剩 deepseek」严格对应，但**重启后还需实测**三条 route：
   - GLM/Kimi：`ZHIPU_API_KEY` / `KIMI_API_KEY` 已在 credentials `refs` 中，应可用；
   - Ollama：`refs` 里**没有** `OLLAMA_API_KEY`（L105 `apiKeyEnv: OLLAMA_API_KEY`），若凭证解析失败该 route 会单独不可用 —— 与本次 root cause 无关，属既有配置缺口，修复后单独确认。
6. `dsh-cybernetics` 的 `taskAgentModel/verifyAgentModel/triageAgentModel` 都写死 `zai-coding-cn/glm-5.3-flash`，
   在修复前这三个 subagent 模型都不可用 —— 这解释了为什么 hardGate 相关委派在这段时间异常/报错。

---

## 5. 本轮产物

| 文件 | 用途 |
|---|---|
| `.diag/DIAGNOSIS.md` | 本报告 |
| `.diag/semdiff.mjs` | 备份 vs 当前的 YAML 语义 diff |
| `.diag/validate.mjs` | 用真实 `llm-pi-ai` schema 校验两个文件 |
| `.diag/verify-fix.mjs` | 校验修好的样本 |
| `.diag/fix-A-quoted-off.sh` | 修复方案 A（已实测） |
| `.diag/fix-B-restore-backup.sh` | 修复方案 B（已实测） |
| `.diag/cordis.patch.yml.fixed-candidate` | 方案 A 的整文件成品（仅 2 行差异） |
| `.diag/evidence/live-model-picker-only-deepseek.jpg` | 现场截图：只有 DeepSeek 账号 |
| `.diag/dump-current.err` | 写入受限（EPERM）证据 |
| `.diag/test-A/`、`.diag/test-B/` | 两个脚本在副本上的实测结果 |
