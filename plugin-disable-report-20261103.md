# DSH web profile 插件停用 — 现场核验与回滚记录（2026-11-03）

## 结论
本轮开始时，目标停用状态**已经在 profile 装配文件中生效**（cordis.patch.yml 修改时间
2026-11-03 21:58:35 CST，早于本任务 agent 启动），无需再做任何写入。本 agent 只做了核验，
未修改任何文件。

## 当前状态（/Users/mars/.dsh/profiles/web/cordis.patch.yml）
行 596-612，全部 `disabled: true`：
- id: opencode-palette（行 596）
- id: wallpaper-engine（行 598）
- id: wallpaper-engine-about-notice（行 600）
- id: wallpaper-engine-mascot-avatar（行 602）
- id: wallpaper-engine-media-bridge（行 604）
- id: wallpaper-engine-pet-link（行 606）
- id: wallpaper-engine-fx（行 608）
- id: wallpaper-engine-parallax（行 610）
- id: wallpaper-engine-fonts（行 612）

YAML 语法已通过 python3 yaml.safe_load 解析验证（合法）。

## mint 保留结论：无法只保留 mint
证据：
1. `node_modules/dsh-plugin-wallpaper-engine/lib/settings-schema.js:44-45`：
   "主题偏好"仅指宿主 theme 服务的 light/dark 档位白名单，不含任何具名主题。
2. `node_modules/dsh-plugin-wallpaper-engine/lib/glass-presets/` 仅有 7 个预设：
   factory-default / factory-frosted / factory-night / factory-readable /
   factory-vivid / purple-mood / factory-author —— 没有 mint。
3. 全包源码 word-boundary 搜索 "mint"：仅 client.js:18843 一处注释（"对每个 scene 都
   mint 一个 id"，是"铸造 id"的动词用法），与主题无关。
4. "mint" 实际存在于 `dsh-opencode-palette/lib/client.js:13370`（`"mint": "#2affdf"`），
   是 opencode-palette 38 个 OpenCode 主题里的一个颜色/主题名 —— 而该插件本次也被停用。
5. parallax / fonts / pet-link 不是主题变体：主包 cordis.patch.yml 注释明确它们是
   独立功能子包（3D 视差层 / 字体系统 / 桌宠联动），主引擎无"按主题独占启用"配置项。

⇒ 按委托书分支 2："不支持按主题选择 → 四个全部停用"。现状与该分支一致。

## 恢复方法（原值记录）
这些行在本次停用前**不存在**于 patch 文件（对比
cordis.patch.yml.bak-20261027-140824-pre-disable 与 cordis.patch.yml~，均无这些行；
行缺失 = 插件默认启用）。恢复 = 用编辑器打开 cordis.patch.yml，删除行 595-612 的
`- id: opencode-palette` 至 `- id: wallpaper-engine-fonts` 共 9 个条目（连同 596 前
的 `- id: photostory / disabled: true` 之后的 wallpaper 段），或把对应 `disabled: true`
改为 `disabled: false`，然后重启 DSH 宿主（patch 在宿主装配时应用）。
若只想恢复 wallpaper 主引擎看效果，也可只删 `wallpaper-engine` 一行的 disabled，
但注意主包 apply 会 resolve 三个子包行（parallax/fx/fonts），子包行保持 disabled
可能引发行解析行为差异——恢复时建议整段一起恢复。

## 生效方式
- patch 在宿主启动装配时应用：需重启 DSH 宿主进程；浏览器端刷新即可拿到新版客户端 bundle。

## 偏差说明
委托书称"第一轮、无既往产物"，但磁盘上停用行已于今日 21:58:35 写入（非本 agent 所为，
疑似并行/前序会话完成）。本 agent 未重复写入，仅核验 + 出报告。
