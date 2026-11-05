# R2 — llm-pi-ai `off` 键修复：已验证、仍未写入（宿主拒绝提权）

时间：2026-11-04 18:17 (+08:00)
目标：`/Users/mars/.dsh/profiles/web/cordis.patch.yml`
结论：**补丁仍然有效、可一键应用，但没有落到目标文件** —— 本会话的文件沙箱是 workspace-write，
宿主拒绝了 `danger-full-access` 提权（见下），因此最后一步必须由沙箱外的进程完成。

## 1. 本轮阻塞（真实工具输出）

```
$ touch /Users/mars/.dsh/profiles/web/.__write_probe_7445
touch: .__write_probe_7445: Operation not permitted
WRITE_FAILED

# 带 danger-full-access 的同一命令：
Error: the user rejected escalating this command to "danger-full-access";
it stays denied, so stop and explain instead of working around it
```

本轮委托书里"用户已授权 danger-full-access"与宿主实际策略不一致：会话级沙箱在启动时固定，
子会话无法自我提权，且审批提示已禁用 → 自动拒绝。按工具提示不做绕过。

## 2. 目标文件当前状态（未被我改动）

```
sha256  0e2222b5f0537ebbc48746a6e8e8ee80cc2d4591d7311cd84c930ccec0344339
lines   449
mtime   2026-11-04 17:38:02
mode    600
```
坏键**恰好两处**，全文件扫描无其他 YAML 1.1 键位：

```
$ grep -nE '^\s+(true|false|yes|no|on|off):' cordis.patch.yml
49:              false: null
65:              false: null
$ grep -nE '^\s*(true|false|yes|no|on|off)\s*:' cordis.patch.yml
49 / 65（同上，无更多）
```

Emacs：`.#cordis.patch.yml` 锁已不存在（buffer 已关闭）；残留的 `#cordis.patch.yml#`
（9110 B，17:38）是过时内容，**里面同样是 `false: null`**，恢复它不会修复，按指示不动它。
Emacs 进程仍在运行（pid 69584），若重新打开旧 buffer 再保存会覆盖修复 —— 应用后到重启前别从 Emacs 保存。

## 3. 补丁内容（对当前文件的最小 diff，字节数不变 9739 → 9739）

```
--- cordis.patch.yml
+++ cordis.patch.yml.fixed
@@ -46,7 +46,7 @@
             reasoningEfforts:
-              false: null
+              "off": null
@@ -62,7 +62,7 @@
             reasoningEfforts:
-              false: null
+              "off": null
```
修复后 sha256 = `10fc1a02fb7ce40481420a45d4532390dadef27634a2be643daf76e67210fa86`
= 本目录 `cordis.patch.yml.fixed`（已按此 sha 校验）。

## 4. 验证（全部在 /tmp 副本上完成，环境与真实文件一致）

对比同一套校验在**当前文件**上的结果：

| 检查 | 当前文件 | 修复后 |
|---|---|---|
| js-yaml 4.3.2 (YAML 1.2) | ok, 49 entries | ok, 49 entries |
| yaml 2.9.1 (config editor 用) | ok, 49 entries | ok, 49 entries |
| `Config()` @deepseek-ai/dsh-llm-pi-ai | **失败**：`$.providers.zai-coding-cn.models[6].reasoningEfforts expected false \| {[key:"off"\|...]: ...}` | **通过** |
| providers | —（整段被拒） | zai-coding-cn(8) / kimi(4) / ollama(2) |
| glm-5.3 / glm-5.3-flash 的 reasoningEfforts 键 | `false,minimal,low,medium,high,max` | `off,minimal,low,medium,high,max`（键类型 string） |
| cybernetics | hardGate:true, allGoalsMode:true, 三个 agent 模型 zai-coding-cn/glm-5.3-flash | 同上，未变 |

完整输出见 `verify-fixed-R2.json`。

与 17:28 备份的语义差异（只剩既有意图改动，说明修复没有夹带其他变更）：

```
$ node semantic-diff.mjs cordis.patch.yml.bak-pre-hardgate-20261104-172829 <patched>
semantic diffs: 4
  $[12].config.provider: "zai-coding-cn" -> "deepseek-account"
  $[12].config.model: "glm-5.3-flash" -> "deepseek-flash"
  $[12].config.reasoningEffort: <absent> -> "high"
  $[48].config.hardGate: <absent> -> true
entry ids equal: true (49 entries)
```

## 5. 应用方式（沙箱外执行，任选其一）

```bash
# A. 推荐：带 sha 漂移保护 + 自动备份 + 自动校验
cd /Users/mars/jobs/dsh-cybernetics/.fix-llm-pi-ai-20261104 && ./apply-fix.sh minimal

# B. 直接用手工 sed（已在 /tmp 验证：产物 sha 与 10fc1a02… 完全一致）
cd /Users/mars/.dsh/profiles/web
cp -p cordis.patch.yml cordis.patch.yml.bak-pre-offfix-$(date +%Y%m%d-%H%M%S)
sed -i '' '49s|^              false: null$|              "off": null|;65s|^              false: null$|              "off": null|' cordis.patch.yml
shasum -a 256 cordis.patch.yml   # 期望 10fc1a02fb7ce40481420a45d4532390dadef27634a2be643daf76e67210fa86

# C. 直接覆盖已验证产物（等价）
cp /Users/mars/jobs/dsh-cybernetics/.fix-llm-pi-ai-20261104/cordis.patch.yml.fixed \
   /Users/mars/.dsh/profiles/web/cordis.patch.yml
```
A 与 B 均已在本机 /tmp 副本上端到端跑通（A 的 TARGET 覆盖到 /tmp 后产出 sha 10fc1a02…）。

## 6. 生效方式

`cordis.patch.yml` 只在 **dsh web 启动时**解析；shipped 包里没有该文件的 watcher（只有经 GUI
configEditor 的改动才会 reconcile）。所以必须重启 `dsh web`（当前 pid 65486，127.0.0.1:3080）。
本轮**没有**重启、没有 kill 任何进程。

重启后验收：
1. 模型供应商列表出现 zai-coding-cn / kimi / ollama（不再是只剩 deepseek-account）。
2. cybernetics 配置页的模型下拉能展开，并列出三家供应商的模型分组。
3. 启动日志里不再出现 `reasoningEfforts` 的 zod 校验错误。
4. 设置里 agent-default-model 仍为 deepseek-account/deepseek-flash（见下），需要的话由用户自行改回。

## 7. agent-default-model 结论（未改动）

当前 `provider: deepseek-account / model: deepseek-flash / reasoningEffort: high`，
备份里是 `zai-coding-cn/glm-5.3-flash`。判断：**是 GUI/用户改动**，不是运行期失败回退。
依据：字段顺序与 `configEditor.edit()` 的 `{provider,model,reasoningEffort}` 完全一致；
运行期回退只会改内存中的路由，不会持久化进 patch 文件；时间点 17:38:02 与自定义供应商已经消失
（只剩 deepseek）吻合。按指示**未擅自改回**。
