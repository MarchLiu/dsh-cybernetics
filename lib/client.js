// dsh-cybernetics client module: the「目标 / Goal」conversation tab, the
//「控制」tab, and (v0.7.2+, fixed in v0.7.3, full volatile coverage in v0.8.1,
// triageAgentModel added in v0.8.2) the settings card seated on the official
// Plugins page (plugins.item / plugins.row.config / plugins.bundle.config,
// bound to the row's ConfigForm in either of the two shapes the seats deliver
// — volatile writes stay live without a restart). The card is the ONLY GUI
// surface for the plugin's seven volatile fields: the host Plugins page draws
// no fields of its own and dsh-client-ui-settings ships the configForms
// service, not a renderer.
// Rendered from the session's `goal` projection (dsh-goal), pushed live by the
// host — no plugin HTTP route needed. Hand-written ModuleLoader wrapper, same
// format the host bundler emits (see dsh-context / dsh-maze client.js).
// v0.18: the「目标 / Goal」tab is subagent-aware. A child session (a workflow
// task/verify/triage child or an Agent Teams teammate) has an empty goal board
// of its own, so the tab now walks the session list's parent chain to the
// nearest ancestor with a non-empty `cyberneticsGoals` board (normally the main
// session), renders that board, marks the goal whose `agents` contain this
// session（「当前」badge + accent border）, scrolls it into view once on open,
// and points the agent chips at the BOARD session as their navigation parent —
// so from any sub agent you can jump to the session's other agents. Root
// sessions with their own board render exactly as before, and a host without
// the session list store keeps the pre-v0.18 fallback (empty → single goal).
/* global window */
// Registration id = the package name in package.json, NOT the short plugin row
// id: the client-modules boot graph keys every row by the package manifest name
// (`@mars.liu/dsh-cybernetics`) and only materializes a row whose bundle
// registered under exactly that id — a stale `dsh-cybernetics` here executes
// the batch script fine, then reports "loaded without registering".
window.__ModuleLoader__.load({
	id: '@mars.liu/dsh-cybernetics',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		const react = require('react');
		const jsx = require('react/jsx-runtime');

		//#region locale dictionaries (zh is the key-set source of truth)
		const NS = 'cybernetics';
		const zh = {
			'view.goal': '目标',
			'tab.description': '展示当前会话的目标与回路进度。',
			'phase.active': '进行中',
			'phase.paused': '已暂停',
			'phase.blocked': '受阻',
			'phase.complete': '已完成',
			'rounds': '已推进 {round} 轮 · 上限 {max}',
			'noGoal': '当前会话没有目标 — 通过对话描述任务，agent 会建立并维护目标。',
			'blocked': '受阻原因',
			'loopHint': 'agent 通过 cybernetics 工具推进：task → verify → triage 每调用一轮。',
			'view.control': '控制',
			'control.description': '查看当前会话各 agent 的目标与运行状态。',
			'agent.lead': '主控',
			'agent.running': '运行中',
			'agent.idle': '空闲',
			'agent.external': '外部',
			'agent.noGoal': '无目标',
			'agent.noData': '目标数据未同步',
			'agents.empty': '本会话当前没有子 agent。',
			'agents.count': '{running}/{total} 个 agent 运行中',
			// v0.6 multi-goal projection (`cyberneticsGoals`) — every goal of the
			// session in one tab, updated in place.
			'goals.count': '{count} 个目标',
			'goal.round': '第 {round} 轮',
			'goal.subgoal': '当前子目标',
			'goal.depth.quick': '轻量',
			'goal.depth.full': '完整',
			'goal.executor.ephemeral': '临时执行者',
			'goal.executor.persistent': '持久执行者',
			'goalStatus.pending': '待启动',
			'goalStatus.running': '进行中',
			'goalStatus.paused': '已暂停',
			'goalStatus.met': '已完成',
			'goalStatus.cancelled': '已取消',
			'goalStatus.superseded': '已被取代',
			'goalStatus.failed': '受阻',
			// v0.6 append-only goal lineage lines (server sets these fields)
			'goal.supersededBy': '已被「{title}」取代',
			'goal.revisedFrom': '修订自「{title}」',
			// v0.6 executor line: the durable teammate's name (persistent only)
			'goal.member': '成员 {name}',
			// v0.18 subagent goal board: a child session (workflow task/verify/
			// triage or an Agent Teams teammate) renders the ancestor board and
			// marks/scrolls the goal that spawned it.
			'goal.current': '当前',
			'goal.subagentBoard': '显示「{title}」的目标板（本会话是它的子智能体）。',
			'goal.jumpHint': '点击下方 agent 标签可跳转到该目标板会话里的其它 agent。',
			'control.goals': '目标',
			// v0.7.2 plugins-page settings card (plugins.item / plugins.row.config /
			// plugins.bundle.config). cardLabel titles the 内置插件配置 group card.
			'settings.cardLabel': 'Cybernetics 控制循环',
			'settings.title': '全目标模式',
			'settings.description': '所有用户请求（含只读问题）必须先经 cybernetics goal。保存后即时生效，无需重载。',
			'settings.on': '开',
			'settings.off': '关',
			'settings.summaryOn': '全目标模式：开',
			'settings.summaryOff': '全目标模式：关',
			'settings.unavailable': '配置不可用（设置文档未开放或插件未运行）。',
			'settings.saving': '保存中…',
			'settings.saveFailed': '保存未生效（宿主拒绝了写入）。',
			// v0.7.6 path-(b) diagnostics: the direct settings-transport retry
			// surfaces the host's exact RemoteError message (the shared
			// ConfigFormController swallows it into a bare `false`).
			'settings.saveFailedDetail': '保存未生效，宿主拒绝原因：{message}',
			// v0.8.1: the remaining five volatile fields. The card is the ONLY
			// GUI surface for them (see the card region comment): the host has
			// no generic schema-driven field renderer, so every field the card
			// does not draw is invisible everywhere.
			'settings.taskAgentModel': 'Task agent 模型',
			'settings.groupTask': 'Task agent · 模型与思考强度',
			'settings.groupVerify': 'Verify agent · 模型与思考强度',
			'settings.groupTriage': 'Triage agent · 模型与思考强度',
			'settings.verifyAgentModel': 'Verify agent 模型',
			// v0.8.3: the three model fields are dropdown-backed (datalist over the
			// host's live model catalog, remote.session.modelCatalog) with free
			// manual entry preserved — the datalist input accepts any text.
			'settings.modelFieldHint': '可从下拉选择当前系统模型（显示 provider · provider/model）；点开输入框（聚焦）即可看到全部可选模型——已有值会先收进占位符，离开且未改动不会保存。也可手工输入「provider/model」或裸模型名；留空 = 与 session agent 一致（继承）。回车或移开焦点即保存。',
			// v0.8.3: configured value no longer in the live catalog = deleted
			// subscription. Warn + one-click clear; NEVER auto-unset (the value
			// may be valid again after resubscribing, and silent rewrites of
			// user config are a side effect) — the runtime already falls back to
			// the session agent model per v0.8.0, so the warning is advisory.
			'settings.modelUnavailable': '该模型已不在当前系统模型列表中，运行时将回退到 session agent 模型。',
			'settings.modelClear': '清除',
			// v0.8.2: the triage role's flat model field — triage reads the
			// task/verify results and emits the round's convergence decision
			// (met/continue/human-input/...); quick rounds never invoke it.
			'settings.triageAgentModel': 'Triage agent 模型',
			'settings.triageModelHint': '可从下拉选择当前系统模型；点开输入框（聚焦）即可看到全部可选模型（已有值先收进占位符，离开且未改动不会保存）。也可手工输入「provider/model」或裸模型名；留空 = 与 session agent 一致（继承）。triage 角色读 task/verify 结果输出本轮收敛决策（met/continue/human-input 等），quick 轮不启用。回车或移开焦点即保存。',
			// v0.15: reasoning-effort selects — options resolve live from the same
			// model catalog face (session.modelCatalog → model.reasoning) the
			// conversation model picker reads; v0.17.3: a model without levels
			// keeps the select enabled with only 「跟随模型默认」 and no warning
			// (pure off/none models collapse into that same option); no model /
			// catalog loading disable with a hint; an invalid stored id displays
			// the effective (model default) selection with a fallback note.
			'settings.taskAgentEffort': 'Task agent 思考强度',
			'settings.verifyAgentEffort': 'Verify agent 思考强度',
			'settings.triageAgentEffort': 'Triage agent 思考强度',
			'settings.effortFieldHint': '思考强度档位随该 sub agent 当前所选模型动态给出（与会话输入框 model picker 同一模型能力数据源）。「跟随模型默认」不发送该参数，由模型适配器按默认档位处理。选择即保存，下一轮 goal 生效。',
			'settings.effortDefault': '跟随模型默认',
			'settings.effortFallback': '配置的档位「{value}」不在当前模型支持列表中，实际按模型默认档位执行（选择一个受支持的档位并保存即可覆盖）。',
			'settings.effortNeedsModel': '该 sub agent 未指定模型（继承 session agent 模型）——在上方模型字段选择具体模型后可选择思考强度。',
			'settings.effortCatalogLoading': '模型目录加载中，档位暂不可选。',
			'settings.roundsPerSubgoal': '子目标轮数上限',
			'settings.roundsPerSubgoalHint': '同一子目标的最大连续轮数（整数 ≥1，缺省 3）；留空恢复默认。回车或移开焦点即保存。',
			'settings.maxConcurrentRounds': '并行轮数上限',
			'settings.maxConcurrentRoundsHint': '全局并行轮数上限（整数 ≥0，缺省 0 = 不限）；留空恢复默认。回车或移开焦点即保存。',
			// v0.19: 状态提示位置（volatile 枚举下拉）。
			'settings.hintLocation': '状态提示位置',
			'settings.hintLocationHint': '控制模式状态 UI 的显示位置（缺省 both）：顶栏药丸 / 编辑器下方提示条 / 两处 / 都不显示。纯外观项，不影响控制语义；配置未加载或旧宿主缺字段时客户端回退为 both。选择即保存，即时生效。',
			'settings.hintLocation.optBoth': '两处（顶栏药丸 + 提示条）',
			'settings.hintLocation.optPill': '仅顶栏药丸',
			'settings.hintLocation.optComposer': '仅编辑器下方提示条',
			'settings.hintLocation.optNone': '都不显示',
			// v0.8.4: roles 高级配置不再上卡片（手工编辑 JSON 对用户不友善）——
			// 由 agent 指导用户直接编辑 profile 配置 yaml（见 README）。
			'settings.invalidNumber': '请输入符合范围的整数，或留空恢复默认。',
			// v0.8.10: hardGate 上卡片（volatile，热切换）。
			'settings.hardGate': '硬控制门',
			'settings.hardGateHint': '开启后，顶层 agent 的写/执行工具在装配期被摘除，所有变更必须经 cybernetics goal + task agent 委派完成。开关保存后即时生效（热装卸门禁监听），无需重启。',
			// v0.16: 智能选择 Agent 配置（volatile 布尔）。
			'settings.smartAgentModelSelection': '智能选择 Agent 配置',
			'settings.smartAgentModelSelectionHint': '开启后每轮启动时按任务内容（委托书/子目标/目标）从当前系统可用模型列表为 task/verify/triage 自动选择合适模型：简单任务（删文件、git 提交等）用轻量模型提速省资源，困难任务（不常见语言、复杂数学等）用顶配模型。上方显式配置的角色模型始终优先；目录不可用或选不到合适模型时保持继承 session agent；每次决策（含保持继承的理由）写入轮审计。保存后下一轮 goal 生效。',
			// v0.17: 预置方案下拉（volatile 选择器 + 结果记录字段）；v0.18.2 起 auto
			// 推荐由 session agent 在自身上下文作答（插件零独立 LLM 调用）。
			'settings.presetPlan': '预置方案',
			'settings.presetPlanHint': '选择一套模型组合应用到 task/verify/triage（写入下方各角色的模型与思考强度字段）：「根据现有配置自动推荐」把实时模型目录、分配原则与当前配置交给 session agent，由它在自己的上下文中给出推荐（插件不发起任何独立 LLM 调用、不新起子 agent；结果经校验后写入）；九家厂商方案为数据驱动条目（OpenAI/Claude/Gemini/DeepSeek/Kimi/Qwen/火山 Coding Plan/Minimax/GLM，含变体/档位/备注），选择即应用其默认变体。作用范围仅三个子 agent 角色——session agent 由用户自行管理，方案与自动推荐都不应用 session 项。每次选择的结果显示在下拉框下方；重复选择同一项不会重复应用（先切「（未选择）」再选）。下拉框下方还有「保存为自定义方案」：把当前组合存档为自定义方案（下拉列表在内置方案之下以分割线分区显示，可删除）。',
			'settings.presetNone': '（未选择）',
			'settings.preset.optAuto': '根据现有配置自动推荐',
			'settings.preset.optOpenai': 'OpenAI',
			'settings.preset.optClaude': 'Claude',
			'settings.preset.optGemini': 'Gemini',
			'settings.preset.optDeepseek': 'DeepSeek',
			'settings.preset.optKimi': 'Kimi',
			'settings.preset.optQwen': 'Qwen',
			'settings.preset.optVolcanoCodingPlan': '火山 Coding Plan',
			'settings.preset.optMinimax': 'Minimax',
			'settings.preset.optGlm': 'GLM',
			'settings.preset.optBuiltinGlmLight': '轻量级GLM',
			'settings.preset.optBuiltinDeepseekFast': 'deepseek 快速',
			// v0.17.1: session 范围提示（用户裁定：session agent 不在本功能范围内）。
			'settings.preset.sessionScope': 'session agent 由用户自行管理：预置方案与自动推荐只应用 task/verify/triage 三个子 agent 角色，厂商方案中的 session 推荐仅作参考展示，不会写入任何配置。',
			'settings.preset.applied': '已应用（{label}）：{picks}',
			'settings.preset.effortSuffix': '（effort {effort}）',
			'settings.preset.effortDefaultSuffix': '（effort 模型默认）',
			'settings.preset.variant': '；应用变体「{variant}」',
			'settings.preset.otherVariants': '；其余变体：{variants}',
			'settings.preset.notes': '备注：{notes}',
			'settings.preset.appliedInvalid': '；以下建议不在可用模型目录中，已忽略：{invalid}',
			'settings.preset.placeholder': '{label}：厂商方案为占位条目（模型组合待填充），本次选择仅记录、未更改任何模型配置。',
			'settings.preset.degraded': '自动推荐降级：{reason}',
			// v0.18.2: auto 已交办 session agent、等待其经 preset_recommend 工具作答。
			'settings.preset.pending': '已交办 session agent（{label}）：等待其在会话中经 preset_recommend 工具作答——第一跳返回实时目录与要求，第二跳提交推荐 JSON；本插件不再发起任何独立 LLM 调用。',
			'settings.preset.recordRaw': '最近一次选择结果：{raw}',
			// v0.19: 自定义方案（用户保存的组合）。持久化在 volatile customPresets
			// 字段（宿主把 volatile 写入落进 profile 的用户 patch 行，重启后仍在）。
			'settings.preset.customDivider': '── 自定义方案 ──',
			'settings.preset.save': '保存为自定义方案',
			'settings.preset.delete': '删除',
			'settings.preset.savePrompt': '输入自定义方案名称：',
			'settings.preset.saveEmpty': '名称为空，未保存。',
			'settings.preset.overwriteConfirm': '已存在同名自定义方案「{name}」，是否覆盖它？',
			'settings.preset.deleteConfirm': '确定删除自定义方案「{name}」吗？内置厂商方案不可删除。',
			'settings.preset.saveHint': '「保存为自定义方案」把当前 task/verify/triage 的模型与思考强度组合存为一个自定义方案（可命名；同名确认后覆盖）；自定义方案显示在内置厂商方案下方，可删除；内置厂商方案不可覆盖、不可删除。',
			// v0.10.0: 控制模式可视化状态指示（会话头部徽标 + 输入框提示条）。
			'mode.pill': '控制',
			// v0.18.x: pill visible label = 「控制模式：{active}/{total}」 (running
			// goals / total goals of this session); not-yet-loaded keeps the
			// existing unknown semantics as 「控制模式：…」. The tooltip keeps the
			// richer mode.tip.* wording (source + round detail).
			'mode.pillCounts': '控制模式：{stopped}/{total}',
			'mode.pillUnknown': '控制模式：…',
			'mode.state.on': '开',
			'mode.state.off': '关',
			'mode.state.unknown': '…',
			'mode.tip.onOverride': '控制模式：开（本会话显式设置）\n点击关闭',
			'mode.tip.onGlobal': '控制模式：开（继承全局配置）\n点击关闭',
			'mode.tip.offOverride': '控制模式：关（本会话显式设置）\n点击开启',
			'mode.tip.offGlobal': '控制模式：关（继承全局配置）\n点击开启',
			'mode.tip.unknown': '控制模式状态加载中…',
			'mode.tip.noCommand': '命令通道不可用，无法在此切换（可手动发送 /cybernetics on|off）',
			'mode.toggleFailed': '切换失败：{message}',
			'mode.toggleUnknown': '宿主不识别 /cybernetics 命令（插件可能未加载）',
			'mode.tip.running': '{count} 个目标运行中 · 第 {round} 轮',
			'hint.insert': '控制模式生效中：新输入将作为外环控制即时插入当前回合',
			'hint.queue': '控制模式生效中：新输入将排队为下一轮输入（inputPolicy=queue）',
			// v0.14 goal-agent tracking: per-goal「关联智能体」line on the goal tab.
			'agents.title': '关联智能体',
			'agents.none': '暂无子智能体记录',
			'agentRole.task': 'task',
			'agentRole.verify': 'verify',
			'agentRole.triage': 'triage',
			'agentStatus.running': '运行中',
			'agentStatus.completed': '已结束',
			'agentStatus.failed': '失败',
			'agentStatus.unknown': '状态未知',
			'agents.openTip': '点击进入该智能体的对话界面',
			'agents.openUnavailable': '会话跳转通道不可用',
			// v0.18.2: the「对话」entry at the top of the goal/control tab content.
			// v0.18.3: it is a「回主对话 / home」navigation — from ANY agent's
			// goal/control tab it returns to the ROOT (main) session's chat view,
			// the equivalent of a site's「回到主页」. The hint states the
			// destination explicitly, because the label alone (「对话」) reads as
			// "switch this session's tab".
			'view.chatEntry': '对话',
			'view.chatEntryHint': '回到主 agent 的对话',
		};
		const en = {
			'view.goal': 'Goal',
			'tab.description': 'Current session goal and loop progress.',
			'phase.active': 'Active',
			'phase.paused': 'Paused',
			'phase.blocked': 'Blocked',
			'phase.complete': 'Complete',
			'rounds': '{round} rounds started · cap {max}',
			'noGoal': 'No goal in this session — describe the task in conversation; the agent will establish and maintain the goal.',
			'blocked': 'Blocked reason',
			'loopHint': 'The agent advances via the cybernetics tool: one call = one round of task → verify → triage.',
			'view.control': 'Control',
			'control.description': 'Goals and run states of every agent in the current session.',
			'agent.lead': 'Lead',
			'agent.running': 'Running',
			'agent.idle': 'Idle',
			'agent.external': 'External',
			'agent.noGoal': 'No goal',
			'agent.noData': 'Goal data not synced',
			'agents.empty': 'No child agents in this session yet.',
			'agents.count': '{running}/{total} agents running',
			'goals.count': '{count} goals',
			'goal.round': 'round {round}',
			'goal.subgoal': 'Current subgoal',
			'goal.depth.quick': 'Quick',
			'goal.depth.full': 'Full',
			'goal.executor.ephemeral': 'Ephemeral executor',
			'goal.executor.persistent': 'Persistent executor',
			'goalStatus.pending': 'Pending',
			'goalStatus.running': 'Running',
			'goalStatus.paused': 'Paused',
			'goalStatus.met': 'Complete',
			'goalStatus.cancelled': 'Cancelled',
			'goalStatus.superseded': 'Superseded',
			'goalStatus.failed': 'Blocked',
			'goal.supersededBy': 'Superseded by "{title}"',
			'goal.revisedFrom': 'Revised from "{title}"',
			'goal.member': 'Member {name}',
			// v0.18 subagent goal board (see the zh dictionary note).
			'goal.current': 'Current',
			'goal.subagentBoard': 'Showing the goal board of "{title}" (this session is one of its sub agents).',
			'goal.jumpHint': 'Click an agent chip below to jump to another agent of that board session.',
			'control.goals': 'Goals',
			'settings.cardLabel': 'Cybernetics goal loop',
			'settings.title': 'All-goals mode',
			'settings.description': 'Every user request (including read-only questions) must go through a cybernetics goal first. Takes effect immediately on save; no reload needed.',
			'settings.on': 'On',
			'settings.off': 'Off',
			'settings.summaryOn': 'All-goals mode: on',
			'settings.summaryOff': 'All-goals mode: off',
			'settings.unavailable': 'Configuration unavailable (settings document not served or plugin not running).',
			'settings.saving': 'Saving…',
			'settings.saveFailed': 'Save did not take effect (the host refused the write).',
			'settings.saveFailedDetail': 'Save did not take effect — host refusal: {message}',
			// v0.8.1: the remaining five volatile fields (see zh for the rationale).
			'settings.taskAgentModel': 'Task agent model',
			'settings.groupTask': 'Task agent · model & reasoning effort',
			'settings.groupVerify': 'Verify agent · model & reasoning effort',
			'settings.groupTriage': 'Triage agent · model & reasoning effort',
			'settings.verifyAgentModel': 'Verify agent model',
			'settings.modelFieldHint': 'Pick from the dropdown of currently available system models (shown as provider · provider/model); click into the input to see the whole list — an existing value is parked as the placeholder and restored on blur without saving. You can also type "provider/model" or a bare model name; empty = inherit the session agent. Enter or blur saves.',
			'settings.modelUnavailable': 'This model is no longer in the system model list; at runtime the round falls back to the session agent model.',
			'settings.modelClear': 'Clear',
			// v0.8.2: the triage role's flat model field (see zh for the rationale).
			'settings.triageAgentModel': 'Triage agent model',
			'settings.triageModelHint': 'Pick from the dropdown of available system models; click into the input to see the whole list (an existing value is parked as the placeholder and restored on blur without saving). You can also type "provider/model" or a bare model name; empty = inherit the session agent. The triage role reads the task/verify results and emits the round\'s convergence decision (met/continue/human-input/...); quick rounds never invoke it. Enter or blur saves.',
			// v0.15: reasoning-effort selects (English locale); v0.17.3: a model
			// without levels stays selectable with only "Model default", no warning.
			'settings.taskAgentEffort': 'Task agent reasoning effort',
			'settings.verifyAgentEffort': 'Verify agent reasoning effort',
			'settings.triageAgentEffort': 'Triage agent reasoning effort',
			'settings.effortFieldHint': 'Effort levels resolve live from the model this sub agent uses (the same model-capability source the conversation model picker reads). "Model default" sends no effort parameter; the adapter applies its default. Saving takes effect on the next goal round.',
			'settings.effortDefault': 'Model default',
			'settings.effortFallback': 'The configured effort "{value}" is not offered by the current model; the model default applies (pick a supported level and save to overwrite).',
			'settings.effortNeedsModel': 'No model configured for this sub agent (inheriting the session agent model) — pick a specific model above to choose an effort level.',
			'settings.effortCatalogLoading': 'Model catalog loading — effort levels are temporarily unavailable.',
			'settings.roundsPerSubgoal': 'Rounds per subgoal',
			'settings.roundsPerSubgoalHint': 'Max consecutive rounds on one subgoal (integer ≥1, default 3); empty restores the default. Enter or blur saves.',
			'settings.maxConcurrentRounds': 'Concurrent round cap',
			'settings.maxConcurrentRoundsHint': 'Global cap on rounds in flight (integer ≥0, default 0 = unlimited); empty restores the default. Enter or blur saves.',
			// v0.19: status-indicator location (volatile enum select).
			'settings.hintLocation': 'Status hint location',
			'settings.hintLocationHint': 'Where the control-mode status UI renders (default both): the session-header pill / the composer hint bar / both / neither. Purely cosmetic; the client falls back to both when the config is unloaded or the field is missing (older hosts). Selecting saves immediately, no reload.',
			'settings.hintLocation.optBoth': 'Both (pill + hint bar)',
			'settings.hintLocation.optPill': 'Pill only',
			'settings.hintLocation.optComposer': 'Hint bar only',
			'settings.hintLocation.optNone': 'Hidden',
			'settings.invalidNumber': 'Enter an integer in range, or leave blank to restore the default.',
			// v0.8.10: hardGate joins the card (volatile, hot-toggled).
			'settings.hardGate': 'Hard control gate',
			'settings.hardGateHint': 'When on, write/execution tools are stripped from the TOP-LEVEL agent at assembly time; every change must go through a cybernetics goal + task agent. Takes effect immediately on save (gate listeners are hot-installed/disposed); no restart needed.',
			// v0.16: smart agent model selection (volatile boolean).
			'settings.smartAgentModelSelection': 'Smart agent model selection',
			'settings.smartAgentModelSelectionHint': 'When on, each round start classifies the work order (brief/subgoal/objective) and picks a suitable provider/model for task/verify/triage from the live system model catalog: trivial work (file deletes, git commits) gets light models for speed and savings, hard work (uncommon languages, difficult math) gets the top tier. Explicitly configured role models above always win; when the catalog is unavailable or nothing suitable is found the round keeps inheriting the session agent; every decision (including why inheritance was kept) is written into the round audit. Takes effect on the next goal round.',
			// v0.17: preset plans dropdown (volatile selector + outcome record);
			// v0.18.2: auto is answered by the session agent in its own context
			// (the plugin runs NO independent LLM call).
			'settings.presetPlan': 'Preset plans',
			'settings.presetPlanHint': 'Apply a model combination to task/verify/triage (writes each role\'s model + reasoning-effort fields below): 「auto-recommend from current config」hands the live model catalog, assignment principles and current config to the session agent, which answers in its own context (the plugin runs no independent LLM call and spawns no agent; the validated result is written back); the nine vendor presets are data-driven entries (OpenAI/Claude/Gemini/DeepSeek/Kimi/Qwen/Volcano Coding Plan/Minimax/GLM, with variants/efforts/notes) — selecting one applies its default variant. Scope is ONLY the three sub-agent roles: the session agent is user-managed, so neither presets nor auto-recommend ever touch the session config. Each selection\'s outcome renders under the dropdown; re-selecting the same entry does not re-apply (switch to (none) first). "Save as custom preset" below the select archives the current combination as a custom preset (listed under the built-ins below a divider, deletable).',
			'settings.presetNone': '(none)',
			'settings.preset.optAuto': 'Auto-recommend from current config',
			'settings.preset.optOpenai': 'OpenAI',
			'settings.preset.optClaude': 'Claude',
			'settings.preset.optGemini': 'Gemini',
			'settings.preset.optDeepseek': 'DeepSeek',
			'settings.preset.optKimi': 'Kimi',
			'settings.preset.optQwen': 'Qwen',
			'settings.preset.optVolcanoCodingPlan': 'Volcano Coding Plan',
			'settings.preset.optMinimax': 'Minimax',
			'settings.preset.optGlm': 'GLM',
			'settings.preset.optBuiltinGlmLight': 'GLM (light)',
			'settings.preset.optBuiltinDeepseekFast': 'deepseek (fast)',
			// v0.17.1: session-scope callout (user ruling: the session agent is out of scope).
			'settings.preset.sessionScope': 'The session agent is user-managed: preset plans and auto-recommend apply only the task/verify/triage sub-agent roles; a vendor\'s session suggestion is displayed for reference only and is never written to any config.',
			'settings.preset.applied': 'Applied ({label}): {picks}',
			'settings.preset.effortSuffix': ' (effort {effort})',
			'settings.preset.effortDefaultSuffix': ' (effort model default)',
			'settings.preset.variant': '; variant 「{variant}」 applied',
			'settings.preset.otherVariants': '; other variants: {variants}',
			'settings.preset.notes': 'Notes: {notes}',
			'settings.preset.appliedInvalid': '; suggestions not present in the live catalog were ignored: {invalid}',
			'settings.preset.placeholder': '{label}: the vendor preset is a placeholder (combination to be filled); this selection was recorded without changing any model config.',
			'settings.preset.degraded': 'Auto-recommend degraded: {reason}',
			// v0.18.2: auto handed to the session agent, awaiting its preset_recommend tool answer.
			'settings.preset.pending': 'Handed to the session agent ({label}): awaiting its preset_recommend tool answer in this conversation — hop 1 returns the live catalog + requirements, hop 2 submits the recommendation JSON; this plugin no longer runs any independent LLM call.',
			'settings.preset.recordRaw': 'Last selection outcome: {raw}',
			// v0.19: custom presets (user-saved combinations), persisted in the
			// volatile customPresets field (the host lands volatile writes in the
			// profile's user patch row, so the list survives restarts).
			'settings.preset.customDivider': '── Custom presets ──',
			'settings.preset.save': 'Save as custom preset',
			'settings.preset.delete': 'Delete',
			'settings.preset.savePrompt': 'Name for the custom preset:',
			'settings.preset.saveEmpty': 'Empty name — nothing saved.',
			'settings.preset.overwriteConfirm': 'A custom preset named "{name}" already exists. Overwrite it?',
			'settings.preset.deleteConfirm': 'Delete the custom preset "{name}"? Built-in vendor presets cannot be deleted.',
			'settings.preset.saveHint': '"Save as custom preset" stores the current task/verify/triage model + effort combination under a name (duplicate names overwrite after confirmation); custom presets render below the built-in vendor presets and can be deleted; built-in vendor presets can never be overwritten or deleted.',
			// v0.10.0: control-mode visual indicator (header pill + composer hint bar).
			'mode.pill': 'Control',
			// v0.18.x: same label contract as the zh dictionary (key parity).
			'mode.pillCounts': 'Control {stopped}/{total}',
			'mode.pillUnknown': 'Control …',
			'mode.state.on': 'On',
			'mode.state.off': 'Off',
			'mode.state.unknown': '…',
			'mode.tip.onOverride': 'Control: on (explicit session override)\nClick to turn off',
			'mode.tip.onGlobal': 'Control: on (inherited from global config)\nClick to turn off',
			'mode.tip.offOverride': 'Control: off (explicit session override)\nClick to turn on',
			'mode.tip.offGlobal': 'Control: off (inherited from global config)\nClick to turn on',
			'mode.tip.unknown': 'Control mode state loading…',
			'mode.tip.noCommand': 'Command channel unavailable — toggle here is disabled (send /cybernetics on|off manually)',
			'mode.toggleFailed': 'Toggle failed: {message}',
			'mode.toggleUnknown': 'The host does not recognize /cybernetics (plugin may not be loaded)',
			'mode.tip.running': '{count} goal(s) running · round {round}',
			'hint.insert': 'Control mode active: new input is inserted into the current turn as outer-loop control',
			'hint.queue': 'Control mode active: new input queues as the next turn (inputPolicy=queue)',
			// v0.14 goal-agent tracking (see zh for the rationale).
			'agents.title': 'Agents',
			'agents.none': 'No child agents recorded yet',
			'agentRole.task': 'task',
			'agentRole.verify': 'verify',
			'agentRole.triage': 'triage',
			'agentStatus.running': 'Running',
			'agentStatus.completed': 'Finished',
			'agentStatus.failed': 'Failed',
			'agentStatus.unknown': 'Unknown',
			'agents.openTip': 'Open this agent\'s conversation',
			'agents.openUnavailable': 'Session navigation unavailable',
			// v0.18.2: the conversation entry; v0.18.3: a home navigation back to
			// the MAIN agent's conversation (see the zh dictionary note).
			'view.chatEntry': 'Conversation',
			'view.chatEntryHint': 'Back to the main agent\'s conversation',
		};
		//#endregion

		const PHASE_KEY = {
			active: 'phase.active',
			paused: 'phase.paused',
			blocked: 'phase.blocked',
			complete: 'phase.complete',
		};

		//#region goal view component
		// v0.6: the tab is driven by the plugin's own `cyberneticsGoals`
		// projection — the WHOLE multi-goal board of this session, pushed live
		// by the host (one whole-value `cybernetics/goals` event per change, no
		// polling). When that key is absent (older plugin/host) or carries an
		// empty board, fall back to dsh-goal's single-slot `goal` projection,
		// which is exactly the pre-v0.6 rendering.
		const GOAL_STATUS_KEY = {
			pending: 'goalStatus.pending',
			running: 'goalStatus.running',
			paused: 'goalStatus.paused',
			met: 'goalStatus.met',
			cancelled: 'goalStatus.cancelled',
			superseded: 'goalStatus.superseded',
			failed: 'goalStatus.failed',
		};

		function goalStatusStyle(status) {
			if (status === 'running') return { color: '#3fb950' };
			if (status === 'failed') return { color: '#d29922' };
			if (status === 'met') return { color: '#58a6ff' };
			return { color: '#8b949e' };
		}

		// End-of-life statuses: the same two-segment rule the goal tab uses
		// (unfinished first, finished after). The server already sorts that way;
		// this stable partition keeps the invariant even if a view arrives with a
		// different order, without re-sorting anything inside a segment.
		const COMPLETED_GOAL_STATUSES = ['met', 'cancelled', 'superseded'];
		function groupGoals(goals) {
			const open = [];
			const done = [];
			for (const g of goals) {
				if (COMPLETED_GOAL_STATUSES.indexOf(g.status) >= 0) done.push(g);
				else open.push(g);
			}
			return open.concat(done);
		}

		//#region v0.14 goal-agent chips (per-goal「关联智能体」on the goal tab)
		// Data: the goal projection now carries `agents` (src/agents.ts — every
		// task/verify/triage child the goal's rounds spawned, aggregated and
		// deduped by child id, published live with the board). Liveness joins
		// the session list store (the same source the control tab's agent tree
		// reads): listed-and-running wins, then the recorded outcome; an agent
		// with no outcome and no live row stays "unknown" instead of guessing.
		// Click-through reuses the subagent pill's navigation seam
		// (uiWorkspace.openSession with a durable direct-parent subagent
		// address — the exact target shape dsh-client-ui-subagent passes).
		function agentChipStatus(agent, list, sessionId) {
			const byId = list && list.byId ? list.byId : {};
			const row = byId[agent.id];
			if (row !== undefined && row.running === true) return 'running';
			const catalogs = list && list.projectionsBySession ? list.projectionsBySession : {};
			const catalog = catalogs[sessionId] && catalogs[sessionId].values
				? catalogs[sessionId].values.subagentCatalog
				: undefined;
			const entry = Array.isArray(catalog) ? catalog.find(function (e) { return e && e.id === agent.id; }) : undefined;
			if (entry && entry.activity === 'running') return 'running';
			if (agent.outcome === 'completed') return 'completed';
			if (agent.outcome === 'failed') return 'failed';
			if (agent.outcome !== undefined) return 'unknown';
			// No recorded outcome: the round that spawned it may still be in
			// flight (a caller-delivery workflow child is invisible to the
			// session list) — treat a running goal's pending agents as running,
			// anything else as unknown.
			return 'running';
		}

		function agentStatusKey(status) {
			if (status === 'running') return 'agentStatus.running';
			if (status === 'completed') return 'agentStatus.completed';
			if (status === 'failed') return 'agentStatus.failed';
			return 'agentStatus.unknown';
		}

		function agentStatusStyle(status) {
			if (status === 'running') return { color: '#3fb950' };
			if (status === 'completed') return { color: '#58a6ff' };
			if (status === 'failed') return { color: '#d29922' };
			return { color: '#8b949e' };
		}

		/** One agent chip: role badge + live status + click-through. */
		function GoalAgentChip(props) {
			const t = props.t;
			const agent = props.agent;
			// v0.18: on an ancestor board the catalog + navigation parent is the
			// BOARD session (the goal's own session), not the viewing child.
			const boardSessionId = props.boardSessionId !== undefined ? props.boardSessionId : props.sessionId;
			const status = agentChipStatus(agent, props.list, boardSessionId);
			const roleKey = 'agentRole.' + (agent.role === 'verify' || agent.role === 'triage' ? agent.role : 'task');
			const openable = typeof props.open === 'function';
			const label = agent.label && agent.label !== agent.role ? agent.label : t(roleKey);
			const tip = (openable ? t('agents.openTip') : t('agents.openUnavailable'))
				+ ' · ' + label + ' · ' + t(agentStatusKey(status));
			return jsx.jsx('button', {
				type: 'button',
				'aria-label': tip,
				title: tip,
				disabled: !openable,
				onClick: openable ? function () { props.open(agent, boardSessionId); } : undefined,
				style: styles.agentChip,
				children: [
					jsx.jsx('span', { style: styles.agentChipRole, children: label }),
					jsx.jsx('span', { style: { ...styles.agentChipDot, ...agentStatusStyle(status) } }),
					jsx.jsx('span', { style: { ...styles.agentChipStatus, ...agentStatusStyle(status) }, children: t(agentStatusKey(status)) }),
				],
			});
		}

		/** The goal's agents line (hidden when the goal has no recorded agents). */
		function GoalAgentsLine(props) {
			const t = props.t;
			const agents = Array.isArray(props.agents) ? props.agents : [];
			if (agents.length === 0) return null;
			return jsx.jsxs('div', { style: styles.goalAgents, children: [
				jsx.jsx('span', { style: styles.goalAgentsTitle, children: t('agents.title') }),
				...agents.map(function (a) {
					return jsx.jsx(GoalAgentChip, { agent: a, t: t, list: props.list, sessionId: props.sessionId, boardSessionId: props.boardSessionId, open: props.open }, a.id + ':' + (a.outcome ?? 'live'));
				}),
			] });
		}
		//#endregion

		// One goal row: title + status badge + round + current subgoal + tags.
		// Append-only lineage (v0.6): a superseded goal names its successor, a
		// revised goal names where it came from — titles resolved from the board
		// snapshot, falling back to the goalId when the successor is not listed.
		// v0.14: + the 关联智能体 line (agents chips with live status + click-through).
		function GoalRow(props) {
			const t = props.t;
			const g = props.goal;
			const titles = props.titles || {};
			const statusKey = GOAL_STATUS_KEY[g.status] ?? 'goalStatus.pending';
			const depthKey = g.depth === 'quick' ? 'goal.depth.quick' : 'goal.depth.full';
			const executorKey = g.executor === 'persistent' ? 'goal.executor.persistent' : 'goal.executor.ephemeral';
			// v0.18: the goal that spawned THIS session (a row of the ancestor
			// board) gets an accent border + a「当前」badge; in ancestor-board
			// mode its ref also scrolls it into view once (see focusScroller).
			// No prop is added for a normal row, so the self-board render stays
			// byte-equal to pre-v0.18.
			const current = props.current === true;
			// Built conditionally (never a null slot) so a normal row's children
			// are byte-identical to pre-v0.18.
			const headChildren = [jsx.jsx('span', { style: styles.goalTitle, children: g.title || g.goalId })];
			if (current) headChildren.push(jsx.jsx('span', { style: styles.goalCurrentBadge, children: t('goal.current') }));
			headChildren.push(jsx.jsx('span', { style: { ...styles.badge, ...goalStatusStyle(g.status) }, children: t(statusKey) }));
			const cardProps = {
				style: current ? { ...styles.goalCard, ...styles.goalCardCurrent } : styles.goalCard,
				children: [
					jsx.jsxs('div', { style: styles.goalHead, children: headChildren }),
					jsx.jsxs('div', { style: styles.goalMetaRow, children: [
						jsx.jsx('span', { style: styles.meta, children: t('goal.round', { round: g.round ?? 0 }) }),
						jsx.jsx('span', { style: styles.tag, children: t(depthKey) }),
						jsx.jsx('span', { style: styles.tag, children: t(executorKey) }),
						g.memberName
							? jsx.jsx('span', { style: styles.tag, children: t('goal.member', { name: g.memberName }) })
							: null,
					] }),
					g.supersededBy
						? jsx.jsx('div', { style: styles.lineage, children: t('goal.supersededBy', { title: titles[g.supersededBy] || g.supersededBy }) })
						: null,
					g.parentGoalId
						? jsx.jsx('div', { style: styles.lineage, children: t('goal.revisedFrom', { title: titles[g.parentGoalId] || g.parentGoalId }) })
						: null,
					g.subgoal
						? jsx.jsxs('div', { style: styles.goalSubgoal, children: [t('goal.subgoal') + '：', g.subgoal] })
						: null,
					jsx.jsx(GoalAgentsLine, {
						agents: g.agents, t: t, list: props.list, sessionId: props.sessionId,
						boardSessionId: props.boardSessionId, open: props.open,
					}),
				],
			};
			if (current) {
				cardProps['data-cyb-current'] = 'true';
				if (typeof props.scrollRef === 'function') cardProps.ref = props.scrollRef;
			}
			return jsx.jsxs('div', cardProps);
		}

		//#region v0.18.2 conversation entry (top of the goal / control tab content)
		// Workflow: entering a sub agent's session from the goal tab and
		// returning to the root session restores the「目标 / Goal」tab — the chat
		// tab stays one click away in the header, but not where the user is
		// looking. The entry rides at the TOP of the tab content.
		//
		// v0.18.3 semantics (user-verified gap): v0.18.2 switched the CURRENT
		// session's conversation view, so from a sub agent's goal tab the click
		// landed on the SUB agent's chat — it looked and behaved like a tab
		// switch, not like「回到主页」. The entry is now a home navigation: from
		// ANY agent's goal/control tab it returns to the ROOT session's chat.
		//
		// Seam (verified against the running host's sources, 2026-11-06): the
		// conversation.view renderer hands every view component the owner props
		// inspectCall / viewRequest / openView(view, focus) / completeViewRequest
		// (@deepseek-ai/dsh-client-ui-conversation, slots.d.ts
		// ConversationViewProps; openView validates the registered view, then
		// activates it + actions.openView), merged AFTER the seat's inject
		// props (owner wins); the chat view's registered id is the constant
		// 'chat' (@deepseek-ai/dsh-client-ui-chat). Pure SPA state: no reload,
		// no URL change, no new session, no server API. Known host semantics,
		// accepted: openView also writes viewRequest, which the chat view never
		// consumes — a harmless residue owned by the host, never touched here.
		// Guarded: an older host without the owner prop renders NO entry
		// (the component returns null), never a throw.
		//
		// Cross-session isolation: the conversation view store is PER SESSION
		// (dsh-client-ui-renderer resolveStore + persist key
		// `dsh.conversation.<sessionId>`), and the host exposes NO "select the
		// view of another session" API. So the home hop is two-legged:
		//   1. this session's entry drops a ONE-SHOT request addressed to the
		//      root session (`requestHome(rootId)`), then asks the workspace
		//      service to select the root session
		//      (`uiWorkspace.openSession(rootId)`;
		//      SessionTarget = SessionId | SubagentAddress, so a plain id
		//      string opens that session);
		//   2. the root session mounts OUR goal/control view (the user's usual
		//      state: the root was left on the goal tab), whose effect consumes
		//      the request and calls ITS OWN props.openView('chat', …).
		// The provider is a page-lifetime module singleton, so it survives the
		// session switch; consumption deletes the key (at most one trigger),
		// and a request older than HOME_REQUEST_TTL_MS is treated as stale and
		// dropped. Known limitation: if the root session is currently showing
		// some OTHER view (e.g. chat itself, or a third-party tab), our consume
		// point never mounts, the request expires, and the user lands on the
		// root session still showing that view (acceptable: the session hop —
		// the part the user asked for — did happen; the view stays wherever the
		// root already was, which is never a WORSE outcome than v0.18.2).
		const CHAT_VIEW_ID = 'chat';
		// Stable focus tag for every entry-initiated switch (both legs), so the
		// host's viewRequest carries one recognizable origin.
		const HOME_VIEW_FOCUS = 'cybernetics-home';
		// A request is consumed by the next mount/render of the root session's
		// goal/control view. The switch itself is synchronous SPA work, so 4 s
		// is generous; anything older belongs to a click the user has moved on
		// from and must not fire later.
		const HOME_REQUEST_TTL_MS = 4000;
		var HOME_REQUESTS = {};

		/** Record a pending「open home」request for `sessionId`. */
		function requestHome(sessionId) {
			if (typeof sessionId !== 'string' || sessionId === '') return false;
			HOME_REQUESTS[sessionId] = Date.now();
			return true;
		}

		/**
		 * Read-and-delete the pending request for `sessionId`; true only when it
		 * exists and is younger than HOME_REQUEST_TTL_MS. Malformed/empty ids
		 * and stale requests answer false (and are cleared).
		 */
		function consumeHomeRequest(sessionId) {
			if (typeof sessionId !== 'string' || sessionId === '') return false;
			if (!Object.prototype.hasOwnProperty.call(HOME_REQUESTS, sessionId)) return false;
			const at = HOME_REQUESTS[sessionId];
			delete HOME_REQUESTS[sessionId];
			if (typeof at !== 'number' || !isFinite(at)) return false;
			const age = Date.now() - at;
			return age >= 0 && age <= HOME_REQUEST_TTL_MS;
		}

		function ConversationEntry(props) {
			if (typeof props.openView !== 'function') return null;
			const label = props.t('view.chatEntry');
			const hint = props.t('view.chatEntryHint');
			const tip = label + ' · ' + hint;
			return jsx.jsx('button', {
				type: 'button',
				'aria-label': tip,
				title: tip,
				onClick: function () {
					// The home session is the LAST element of the parent chain
					// (the session list is absent/partial on an older host → the
					// current session, i.e. the one-step behavior).
					const home = homeSessionOf(props.list, props.sessionId);
					// Root session (or no usable home hop): one step, as before.
					// An injected openHome is required for the cross-session leg;
					// without it the entry degrades to the local view switch
					// (pre-v0.18.3 behavior) rather than doing nothing.
					if (home === props.sessionId || typeof props.openHome !== 'function') {
						props.openView(CHAT_VIEW_ID, HOME_VIEW_FOCUS);
						return;
					}
					requestHome(home);
					try {
						props.openHome(home);
					} catch {
						// The workspace service refused/threw: never leave the
						// click dead — fall back to this session's chat. The
						// pending request expires on its own.
						props.openView(CHAT_VIEW_ID, HOME_VIEW_FOCUS);
					}
				},
				style: styles.chatEntry,
				children: [
					jsx.jsx('span', { style: styles.chatEntryIcon, 'aria-hidden': 'true', children: '←' }),
					jsx.jsx('span', { style: styles.chatEntryLabel, children: label }),
					jsx.jsx('span', { style: styles.chatEntryHintText, children: hint }),
				],
			});
		}
		//#endregion

		// Multi-goal list. Order is the projection's (server-side two segments:
		// unfinished goals first, finished after; newest change first inside each),
		// so the client renders verbatim and never re-sorts.
		// v0.18: `ancestor` mode prepends the subagent-board banner and passes
		// the board session through to the chips; the focus goal gets the
		// current marker + the one-shot scroll ref. A self board passes exactly
		// the pre-v0.18 props and children (byte-equal render).
		function GoalsList(props) {
			const t = props.t;
			const goals = props.goals;
			const titles = {};
			for (const g of goals) titles[g.goalId] = g.title || g.goalId;
			const ancestor = props.ancestor === true;
			const boardSessionId = ancestor ? props.boardSessionId : undefined;
			const focusGoalId = props.focusGoalId;
			const autoScroll = ancestor && props.autoScroll === true && focusGoalId !== undefined;
			const scrollRef = autoScroll ? focusScroller(boardSessionId, focusGoalId) : undefined;
			const rows = goals.map(function (g) {
				const rowProps = {
					goal: g, t: t, titles: titles,
					list: props.list, sessionId: props.sessionId, open: props.open,
				};
				if (ancestor) rowProps.boardSessionId = boardSessionId;
				if (focusGoalId !== undefined && g.goalId === focusGoalId) {
					rowProps.current = true;
					if (scrollRef !== undefined) rowProps.scrollRef = scrollRef;
				}
				return jsx.jsx(GoalRow, rowProps, g.goalId + ':' + (g.updatedAt ?? 0));
			});
			// v0.18.2: the「对话」entry is the content's first row on every board
			// (self + ancestor). Absent (older host, openView owner prop missing)
			// → the children sequence stays exactly the pre-v0.18.2 one.
			const children = props.leading ? [props.leading] : [];
			if (ancestor) {
				children.push(jsx.jsxs('div', { style: styles.subagentBoard, children: [
					jsx.jsx('div', { style: styles.subagentBoardLine, children: t('goal.subagentBoard', { title: props.boardTitle || boardSessionId || '' }) }),
					jsx.jsx('div', { style: styles.subagentBoardHint, children: t('goal.jumpHint') }),
				] }));
			}
			children.push(jsx.jsx('div', { style: styles.badgeRow, children:
				jsx.jsx('span', { style: styles.badge, children: t('goals.count', { count: goals.length }) }) }));
			children.push(...rows);
			children.push(jsx.jsx('div', { style: styles.hint, children: t('loopHint') }));
			return jsx.jsxs('div', { style: styles.root, children: children });
		}

		// props.raw: the session `goal` projection snapshot value. It may be the
		// raw state ({current: GoalProjection | null, ...}) or the projection
		// value itself — normalize both; undefined = not yet arrived.
		function SingleGoalView(props) {
			const t = props.t;
			const raw = props.raw;
			if (raw === undefined) return null;
			const goal = raw !== null && typeof raw === 'object' && 'current' in raw ? raw.current : raw;
			if (goal === null || goal === undefined) {
				// v0.18.2: the empty board keeps the entry visible and clickable —
				// same root column as the goal view, entry first, the dimmed
				// empty text after it (padding comes from the root now).
				return jsx.jsxs('div', { style: styles.root, children: [
					...(props.leading ? [props.leading] : []),
					jsx.jsx('div', { style: { ...styles.empty, padding: 0 }, children: t('noGoal') }),
				] });
			}
			const g = goal.goal ?? goal;
			return jsx.jsxs('div', { style: styles.root, children: [
				...(props.leading ? [props.leading] : []),
				jsx.jsx('div', { style: styles.badgeRow, children:
					jsx.jsx('span', { style: { ...styles.badge, ...phaseStyle(g.phase) }, children: t(PHASE_KEY[g.phase] ?? g.phase ?? '') }),
				}),
				jsx.jsx('div', { style: styles.objective, children: g.objective ?? t('noGoal') }),
				g.phase === 'blocked' && g.blockedReason
					? jsx.jsxs('div', { style: styles.blocked, children: [t('blocked') + '：', g.blockedReason.message] })
					: null,
				jsx.jsx('div', { style: styles.meta, children: t('rounds', { round: goal.roundsStarted ?? 0, max: g.maxGoalRounds ?? '—' }) }),
				jsx.jsx('div', { style: styles.hint, children: t('loopHint') }),
			] });
		}

		//#region v0.18 subagent goal board (child sessions show the ancestor board)
		// A workflow task/verify/triage child or an Agent Teams teammate is a
		// session of its own, so its own `cyberneticsGoals` board is empty and
		// the「目标 / Goal」tab used to render nothing. v0.18 makes the tab useful
		// from a child: it renders the nearest ancestor session's board (in
		// practice the main session), highlights the goal that spawned THIS
		// session, scrolls it into view once on open, and routes the agent chips
		// through the board session so they keep jumping between that board's
		// agents.
		//
		// Data seams (`ctx.sessions.list`, live):
		//  - `projectionsBySession[id].values.cyberneticsGoals` — the board;
		//    `byId[id].projectionValues.cyberneticsGoals` is the same value from
		//    the row snapshot (fallback for partial rows);
		//  - `byId[id].parentId` (session header.parentSession) first, then the
		//    OWNING session's `subagentCatalog` entry (same resolution order as
		//    dsh-client-ui-subagent) when the row lacks a parent.
		// Every read is defensive: an older host without the store keeps the
		// pre-v0.18 behavior (own board or the empty fallback), never a throw.
		const MAX_ANCESTOR_HOPS = 16;

		// Stable no-list face: a host without the session list store still calls
		// the same hooks in the same order, and its snapshot (null) means "no
		// ancestor resolution" — the pre-v0.18 behavior.
		const NO_SESSION_LIST = { subscribe: () => () => {}, getSnapshot: () => null };

		/** The session-list store, or null when the host does not expose it. */
		function readableSessionList(sessions) {
			if (!sessions || typeof sessions !== 'object') return null;
			const list = sessions.list;
			if (list === undefined || list === null) return null;
			if (typeof list.subscribe !== 'function' || typeof list.getSnapshot !== 'function') return null;
			return list;
		}

		/** One session's `cyberneticsGoals` snapshot value (live projections first). */
		function boardOfSession(list, id) {
			if (!list || typeof list !== 'object' || typeof id !== 'string' || id === '') return undefined;
			const bySession = list.projectionsBySession;
			const projections = bySession && typeof bySession === 'object' ? bySession[id] : undefined;
			const values = projections && typeof projections === 'object' ? projections.values : undefined;
			if (values && values.cyberneticsGoals !== undefined) return values.cyberneticsGoals;
			const byId = list.byId && typeof list.byId === 'object' ? list.byId[id] : undefined;
			const projectionValues = byId && typeof byId === 'object' ? byId.projectionValues : undefined;
			return projectionValues ? projectionValues.cyberneticsGoals : undefined;
		}

		/** The goals array of a projection snapshot (both raw shapes tolerated). */
		function goalsOfState(raw) {
			return raw !== null && typeof raw === 'object' && Array.isArray(raw.goals) ? raw.goals : [];
		}

		/** Parent session id: row.parentId first, else the owning catalog's session. */
		function parentOfSession(list, id) {
			if (!list || typeof list !== 'object' || typeof id !== 'string' || id === '') return undefined;
			const byId = list.byId && typeof list.byId === 'object' ? list.byId : undefined;
			const row = byId ? byId[id] : undefined;
			if (row && typeof row === 'object' && typeof row.parentId === 'string'
				&& row.parentId !== '' && row.parentId !== id) {
				return row.parentId;
			}
			const bySession = list.projectionsBySession;
			if (!bySession || typeof bySession !== 'object') return undefined;
			for (const owner of Object.keys(bySession)) {
				if (owner === id) continue;
				const projections = bySession[owner];
				const values = projections && typeof projections === 'object' ? projections.values : undefined;
				const catalog = values ? values.subagentCatalog : undefined;
				if (!Array.isArray(catalog)) continue;
				for (const entry of catalog) {
					if (entry && typeof entry === 'object' && entry.id === id) return owner;
				}
			}
			return undefined;
		}

		/** [parent, grandparent, …] — visited-cycle guard + hop cap, never throws. */
		function ancestorSessions(list, sessionId) {
			const chain = [];
			if (!list || typeof list !== 'object' || typeof sessionId !== 'string' || sessionId === '') return chain;
			const visited = new Set([sessionId]);
			let current = sessionId;
			for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
				const parent = parentOfSession(list, current);
				if (typeof parent !== 'string' || parent === '' || visited.has(parent)) break;
				chain.push(parent);
				visited.add(parent);
				current = parent;
			}
			return chain;
		}

		/**
		 * The「home」session of `sessionId`: the LAST element of the ancestor
		 * chain (the root/main session). The current session when the chain is
		 * empty (already root) or when no usable list is available. Never
		 * throws — every branch of `ancestorSessions` is already defensive.
		 */
		function homeSessionOf(list, sessionId) {
			const chain = ancestorSessions(list, sessionId);
			if (chain.length === 0) return sessionId;
			return chain[chain.length - 1];
		}

		/** goalId of the first goal whose agents include one of `ids` (nearest first). */
		function focusGoalIn(goals, ids) {
			for (const id of ids) {
				if (typeof id !== 'string' || id === '') continue;
				for (const goal of goals) {
					const agents = goal && Array.isArray(goal.agents) ? goal.agents : [];
					for (const agent of agents) {
						if (agent && agent.id === id) return goal.goalId;
					}
				}
			}
			return undefined;
		}

		/**
		 * Decide what the goal tab renders: the current session's own non-empty
		 * board (unchanged behavior), else the nearest ancestor's non-empty
		 * board, else nothing (the caller keeps the single-goal fallback).
		 * The focus goal is the displayed goal whose agents contain this
		 * session — or, failing that, the nearest ancestor session (so a
		 * grandchild still finds the goal that spawned its parent).
		 */
		function resolveGoalBoard(sessionId, ownGoals, list) {
			const chain = list ? ancestorSessions(list, sessionId) : [];
			const focusIds = [sessionId, ...chain];
			if (ownGoals.length > 0) {
				return {
					boardSessionId: sessionId, ancestor: false, goals: ownGoals,
					focusGoalId: focusGoalIn(ownGoals, focusIds), boardTitle: undefined,
				};
			}
			for (const ancestor of chain) {
				const goals = goalsOfState(boardOfSession(list, ancestor));
				if (goals.length === 0) continue;
				const byId = list.byId && typeof list.byId === 'object' ? list.byId[ancestor] : undefined;
				const title = byId && typeof byId === 'object'
					? (byId.displayTitle !== undefined ? byId.displayTitle : byId.title)
					: undefined;
				return {
					boardSessionId: ancestor, ancestor: true, goals,
					focusGoalId: focusGoalIn(goals, focusIds),
					boardTitle: typeof title === 'string' && title !== '' ? title : ancestor,
				};
			}
			return { boardSessionId: sessionId, ancestor: false, goals: [], focusGoalId: undefined, boardTitle: undefined };
		}

		/**
		 * Scroll the focused goal card into view ONCE per (board, goal). The
		 * card's key carries updatedAt, so a live update remounts it; the
		 * dedupe marker lives on the scroll container DOM node (the GoalsList
		 * root, overflow:auto), NOT in a hook — the seat's fake-react harness
		 * implements only a subset of hooks and this tab must stay hook-stable.
		 */
		function focusScroller(boardSessionId, goalId) {
			return function attachFocusCard(el) {
				if (!el || typeof el !== 'object') return;
				const container = el.parentNode && typeof el.parentNode === 'object' ? el.parentNode : el;
				if (container.__cybFocusedGoal === goalId && container.__cybFocusedBoard === boardSessionId) return;
				container.__cybFocusedGoal = goalId;
				container.__cybFocusedBoard = boardSessionId;
				if (typeof el.scrollIntoView !== 'function') return;
				try {
					el.scrollIntoView({ block: 'center' });
				} catch {
					// Host without scrollIntoView semantics: silent.
				}
			};
		}
		//#endregion

		function GoalView(props) {
			const goalsRaw = react.useSyncExternalStore(props.goals.subscribe, props.goals.getSnapshot);
			const singleRaw = react.useSyncExternalStore(props.goal.subscribe, props.goal.getSnapshot);
			// v0.18: the session list store resolves the ancestor board + the
			// focus goal and updates live (a late-arriving projection appears
			// without a remount). Absent store → pre-v0.18 behavior. The
			// fallback face keeps the hook count constant (React requires
			// unconditional hooks) and its snapshot is null.
			const sessionList = readableSessionList(props.sessions) ?? NO_SESSION_LIST;
			const list = react.useSyncExternalStore(sessionList.subscribe, sessionList.getSnapshot);
			const board = resolveGoalBoard(props.sessionId, goalsOfState(goalsRaw), list);
			// v0.18.3: consume a pending「home」request addressed to THIS session
			// (dropped by the entry of a descendant session, which then asked
			// the workspace service to select this very session). No dependency
			// array on purpose: the request may already be queued before this
			// view mounts and any render after the switch can be the first one;
			// consumeHomeRequest is read-and-delete, so at most one render
			// fires the switch and later renders are no-ops. Runs on EVERY
			// goal-tab branch (self board / ancestor board / single goal / empty
			// / projections in flight) because it sits above the branches.
			react.useEffect(function () {
				if (consumeHomeRequest(props.sessionId) && typeof props.openView === 'function') {
					props.openView(CHAT_VIEW_ID, HOME_VIEW_FOCUS);
				}
			});
			// v0.18.2: the「对话」entry rides above EVERY goal-tab branch (self
			// board / ancestor board / single-goal fallback / projections still
			// in flight). The openView owner prop reaches the view component on
			// each path; without it (older host) ConversationEntry renders null
			// and every branch stays byte-identical to pre-v0.18.2.
			const chatEntry = jsx.jsx(ConversationEntry, {
				t: props.t, openView: props.openView, openHome: props.openHome,
				sessionId: props.sessionId, list,
			});
			if (board.goals.length > 0) {
				// Self board: exactly the pre-v0.18 props (byte-equal main-session
				// render). Ancestor board: + banner, board session (chip
				// navigation) and the focus marker/scroll.
				const listProps = { t: props.t, goals: board.goals, list, sessionId: props.sessionId, open: props.open, leading: chatEntry };
				if (board.ancestor) {
					listProps.ancestor = true;
					listProps.boardSessionId = board.boardSessionId;
					listProps.boardTitle = board.boardTitle;
				}
				if (board.focusGoalId !== undefined) listProps.focusGoalId = board.focusGoalId;
				if (board.ancestor && board.focusGoalId !== undefined) listProps.autoScroll = true;
				return jsx.jsx(GoalsList, listProps);
			}
			if (singleRaw === undefined) {
				// v0.18.2: both faces still empty (projections in flight) — the
				// tab used to render nothing at all; the entry needs no goal
				// data, so it stays visible and clickable during the load.
				return jsx.jsx('div', { style: styles.root, children: [chatEntry] });
			}
			return jsx.jsx(SingleGoalView, { t: props.t, raw: singleRaw, leading: chatEntry });
		}

		var styles = {
			root: { display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 16px', overflow: 'auto' },
			empty: { padding: '12px 16px', opacity: 0.6 },
			badgeRow: { display: 'flex', gap: 6 },
			badge: { fontSize: 12, padding: '1px 8px', borderRadius: 999, border: '1px solid currentColor' },
			objective: { whiteSpace: 'pre-wrap', lineHeight: 1.5, fontSize: 13 },
			blocked: { color: '#d29922', fontSize: 12 },
			meta: { opacity: 0.65, fontSize: 12 },
			hint: { opacity: 0.45, fontSize: 11 },
			// v0.6 multi-goal rows
			goalCard: { display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', border: '1px solid rgba(127,127,127,0.25)', borderRadius: 6 },
			goalHead: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
			goalTitle: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
			goalMetaRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
			tag: { fontSize: 10, padding: '0 6px', borderRadius: 999, border: '1px solid rgba(127,127,127,0.35)', opacity: 0.75 },
			goalSubgoal: { fontSize: 12, opacity: 0.85, whiteSpace: 'pre-wrap', lineHeight: 1.45 },
			lineage: { fontSize: 11, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
			// v0.18 subagent goal board: ancestor-board banner + the「当前」goal
			// marker (accent border on the card, small badge next to the title).
			subagentBoard: { display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(88,166,255,0.35)', background: 'rgba(88,166,255,0.08)' },
			subagentBoardLine: { fontSize: 12 },
			subagentBoardHint: { fontSize: 11, opacity: 0.65 },
			goalCardCurrent: { borderLeft: '3px solid #58a6ff' },
			goalCurrentBadge: { fontSize: 10, padding: '0 6px', borderRadius: 999, border: '1px solid currentColor', color: '#58a6ff' },
			// v0.6 control tab executor rows
			controlGoalRow: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap', padding: '2px 0' },
			goalCards: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 },
			agentRow: { borderLeft: '2px solid transparent', borderRadius: 4 },
			agentMain: { display: 'flex', flexDirection: 'column', gap: 2 },
			agentHead: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
			agentName: { fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
			agentGoal: { fontSize: 11, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
			branch: { opacity: 0.4, fontSize: 11 },
			leadBadge: { fontSize: 10, padding: '0 6px', borderRadius: 999, border: '1px solid currentColor', color: '#58a6ff' },
			runBadge: { fontSize: 10, padding: '0 6px', borderRadius: 999, border: '1px solid currentColor' },
			runOn: { color: '#3fb950' },
			runOff: { color: '#8b949e' },
			// v0.14 goal agents line
			goalAgents: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', paddingTop: 2, borderTop: '1px solid rgba(127,127,127,0.15)' },
			goalAgentsTitle: { fontSize: 10, opacity: 0.55, flex: 'none' },
			agentChip: {
				display: 'inline-flex', alignItems: 'center', gap: 4, font: 'inherit',
				fontSize: 10, padding: '0 6px', borderRadius: 999, cursor: 'pointer',
				border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit',
			},
			agentChipRole: { fontWeight: 600, opacity: 0.85 },
			agentChipDot: { width: 5, height: 5, borderRadius: 999, background: 'currentColor' },
			agentChipStatus: { opacity: 0.8 },
			// v0.18.2 conversation entry: a tab-item-like button on the content's
			// first line (same rgba hairline family as the agent chips; inline
			// styles only, colors inherit the host theme).
			chatEntry: {
				display: 'inline-flex', alignItems: 'center', gap: 6, font: 'inherit',
				fontSize: 12, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
				border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit',
				alignSelf: 'flex-start', textAlign: 'left',
			},
			chatEntryIcon: { opacity: 0.7, lineHeight: 1 },
			chatEntryLabel: { fontWeight: 600 },
			chatEntryHintText: { opacity: 0.55, fontSize: 11 },
		};
		function phaseStyle(phase) {
			if (phase === 'active') return { color: '#3fb950' };
			if (phase === 'blocked') return { color: '#d29922' };
			if (phase === 'complete') return { color: '#58a6ff' };
			return { color: '#8b949e' };
		}
		//#endregion

		//#region control view component
		// The「控制 / Control」tab: every goal of the session with its EXECUTOR
		// line (substrate + the durable teammate's name when it runs on one),
		// plus every agent of the current session — the lead itself and the
		// subagent catalog (recursively) — with its run state and its own durable
		// goal (dsh-goal projection values). Goal data comes from the same
		// `cyberneticsGoals` whole-value projection the goal tab reads; the agent
		// tree comes from the session list store, updated live by the Session
		// Controller via the control stream (running flips, goal/control frames).
		const MAX_TREE_DEPTH = 3;

		// No goal face (older host/plugin): keep the agent tree rendering exactly
		// as before instead of throwing.
		const NOOP_GOALS_FACE = { subscribe: () => () => {}, getSnapshot: () => undefined };

		// One goal row of the control tab: status + title + executor + durable
		// member name + round. Same fields as the goal tab, restated as the
		// operator's line — who is executing this goal and how far it got.
		function ControlGoalRow(props) {
			const t = props.t;
			const g = props.goal;
			const statusKey = GOAL_STATUS_KEY[g.status] ?? 'goalStatus.pending';
			const executorKey = g.executor === 'persistent' ? 'goal.executor.persistent' : 'goal.executor.ephemeral';
			return jsx.jsxs('div', { style: styles.controlGoalRow, children: [
				jsx.jsx('span', { style: { ...styles.badge, ...goalStatusStyle(g.status) }, children: t(statusKey) }),
				jsx.jsx('span', { style: styles.agentName, children: g.title || g.goalId }),
				jsx.jsx('span', { style: styles.tag, children: t(executorKey) }),
				g.memberName
					? jsx.jsx('span', { style: styles.tag, children: t('goal.member', { name: g.memberName }) })
					: null,
				jsx.jsx('span', { style: styles.meta, children: t('goal.round', { round: g.round ?? 0 }) }),
			] });
		}

		/** Depth-first agent rows rooted at `rootId`: lead + subagentCatalog, recursed. */
		function collectAgents(list, rootId) {
			const rows = [];
			const walk = (id, depth, catalogLabel, mode) => {
				if (depth > MAX_TREE_DEPTH) return;
				const row = list.byId[id];
				const catalog = list.projectionsBySession[id]?.values?.subagentCatalog ?? [];
				rows.push({
					id,
					depth,
					lead: depth === 0,
					label: catalogLabel ?? row?.projectionValues?.subagent?.label,
					external: mode === 'external',
					running: row?.running === true,
					goal: row?.projectionValues?.goal ?? null,
					hasRow: row !== undefined,
					childCount: catalog.length,
				});
				for (const entry of catalog) walk(entry.id, depth + 1, entry.label, entry.mode);
			};
			walk(rootId, 0);
			return rows;
		}

		/** Render one goal snapshot face shared by both tabs. */
		function goalFace(t, goal, noDataText) {
			if (goal === undefined) return t('agent.noData');
			if (goal === null || goal.goal === undefined) return t('agent.noGoal');
			const g = goal.goal;
			const phase = t(PHASE_KEY[g.phase] ?? g.phase);
			const rounds = ' · ' + t('rounds', { round: goal.roundsStarted ?? 0, max: g.maxGoalRounds ?? '—' });
			return phase + rounds + (g.phase === 'blocked' && g.blockedReason ? ' · ' + t('blocked') + '：' + g.blockedReason.message : '');
		}

		function AgentRow(props) {
			const t = props.t;
			const a = props.agent;
			const statusText = a.external ? t('agent.external') : a.running ? t('agent.running') : t('agent.idle');
			return jsx.jsx('div', { style: { ...styles.agentRow, paddingLeft: 16 + a.depth * 18 }, children:
				jsx.jsxs('div', { style: styles.agentMain, children: [
					jsx.jsxs('div', { style: styles.agentHead, children: [
						a.depth > 0 ? jsx.jsx('span', { style: styles.branch, children: '└' }) : null,
						jsx.jsx('span', { style: styles.agentName, children: a.label ?? a.id }),
						a.lead ? jsx.jsx('span', { style: styles.leadBadge, children: t('agent.lead') }) : null,
						jsx.jsx('span', { style: { ...styles.runBadge, ...(a.running ? styles.runOn : styles.runOff) }, children: statusText }),
					] }),
					jsx.jsx('div', { style: styles.agentGoal, children: goalFace(t, a.goal, t('agent.noData')) }),
				] }),
			});
		}

		function ControlView(props) {
			const t = props.t;
			const sessions = props.sessions;
			const list = react.useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot);
			const goalsFace = props.goals ?? NOOP_GOALS_FACE;
			const goalsRaw = react.useSyncExternalStore(goalsFace.subscribe, goalsFace.getSnapshot);
			const goals = goalsRaw !== null && typeof goalsRaw === 'object' && Array.isArray(goalsRaw.goals)
				? groupGoals(goalsRaw.goals)
				: [];
			const agents = collectAgents(list, props.sessionId);
			const runningCount = agents.filter((a) => a.running).length;
			// v0.18.3: same home-request consume point as GoalView (the root
			// session may be left on the control tab instead of the goal tab —
			// whichever of our views mounts first consumes the one-shot request;
			// consumption is read-and-delete, so the other stays quiet).
			react.useEffect(function () {
				if (consumeHomeRequest(props.sessionId) && typeof props.openView === 'function') {
					props.openView(CHAT_VIEW_ID, HOME_VIEW_FOCUS);
				}
			});
			return jsx.jsxs('div', { style: styles.root, children: [
				// v0.18.2: the same「对话」entry as the goal tab — one seam, both
				// tabs consistent (ControlView receives the same openView owner
				// prop from the conversation.view renderer; the component's own
				// guard hides the entry on an older host).
				jsx.jsx(ConversationEntry, {
					t, openView: props.openView, openHome: props.openHome,
					sessionId: props.sessionId, list,
				}),
				goals.length > 0
					? jsx.jsxs('div', { style: styles.goalCards, children: [
						jsx.jsxs('div', { style: styles.badgeRow, children: [
							jsx.jsx('span', { style: styles.meta, children: t('control.goals') }),
							jsx.jsx('span', { style: styles.badge, children: t('goals.count', { count: goals.length }) }),
						] }),
						...goals.map((g) => jsx.jsx(ControlGoalRow, { goal: g, t }, 'goal:' + g.goalId + ':' + (g.updatedAt ?? 0))),
					] })
					: null,
				jsx.jsxs('div', { style: styles.badgeRow, children: [
					jsx.jsx('span', { style: styles.badge, children: t('agents.count', { total: agents.length, running: runningCount }) }),
				] }),
				...agents.map((a) => jsx.jsx(AgentRow, { agent: a, t }, a.id + ':' + a.depth)),
				agents.length <= 1 ? jsx.jsx('div', { style: styles.hint, children: t('agents.empty') }) : null,
			] });
		}
		//#endregion

		//#region plugins-page settings card (v0.7.2)
		// The official Plugins page (@deepseek-ai/dsh-client-ui-plugin-manager, the
		// runtime copy that owns the 内置插件配置/实验性插件/已安装插件 groups) renders a
		// bundle's own configuration ONLY through the slots it declares:
		//   plugins.bundle.config  keyed by the bundle name (profile dep name)
		//   plugins.row.config     keyed by `<bundle name>#<row id>`
		// (rowConfigKey in that page's client.js; slot contract in
		// dsh-cordis-client-runner's slot catalog). A server-side Config schema
		// alone surfaces nowhere once the ui-settings-plugins section is disabled
		// by the family plugin-manager — exactly the observed gap.
		// Both entries bind the row's own ConfigForm from ctx.configForms (the
		// namespace id is the loader row id `dsh-cybernetics`, same convention
		// @deepseek-ai/dsh-experimental-client-ui-cot-translation uses). A toggle
		// write goes settings mutate → loader volatile commit
		// (`loader/volatile-update`), so allGoalsMode stays live without a
		// restart — the v0.7.1 volatile semantics, unchanged.
		const SETTINGS_ENTRY_ID = 'dsh-cybernetics';
		const NO_FORM_SNAP = { status: 'unavailable', value: undefined, writable: false };
		const noopSubscribe = () => () => {};

		var settingsStyles = {
			card: { display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 0' },
			row: { display: 'flex', alignItems: 'center', gap: 12 },
			main: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
			title: { fontSize: 13, fontWeight: 600 },
			desc: { fontSize: 12, opacity: 0.65, lineHeight: 1.5 },
			toggle: {
				cursor: 'pointer', borderRadius: 999, width: 40, height: 22,
				border: '1px solid rgba(127,127,127,0.45)', position: 'relative', flex: 'none',
				background: 'transparent', padding: 0,
			},
			knob: {
				position: 'absolute', top: 2, width: 16, height: 16, borderRadius: 999,
				transition: 'left .15s ease',
			},
			trackOn: { background: '#2da44e', borderColor: '#2da44e' },
			trackOff: { background: 'rgba(127,127,127,0.25)' },
			knobOn: { left: 20, background: '#fff' },
			knobOff: { left: 2, background: 'currentColor' },
			unavailable: { fontSize: 12, opacity: 0.6 },
			// v0.8.1: editable volatile fields (text / number inputs).
			field: { display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 6, borderTop: '1px solid rgba(127,127,127,0.18)' },
			input: {
				font: 'inherit', fontSize: 12, color: 'inherit', maxWidth: 320,
				background: 'transparent', border: '1px solid rgba(127,127,127,0.4)',
				borderRadius: 4, padding: '3px 8px', outline: 'none',
			},
			inputInvalid: { borderColor: '#d29922' },
			invalid: { fontSize: 11, color: '#d29922' },
		};

		// v0.8.1: the card renders ALL volatile fields, not just the
		// allGoalsMode toggle (v0.8.2 adds triageAgentModel → seven). Verified
		// against the running host's sources (2026-11-04): the Plugins page
		// detail view (ItemDetail in @deepseek-ai/dsh-client-ui-plugin-manager
		// lib/client.js) renders a plugin's configuration ONLY through its slot
		// cards — the page itself draws no fields;
		// @deepseek-ai/dsh-client-ui-settings ships the configForms SERVICE
		// (transport + volatileForm serve/write gates) but no generic field
		// renderer; dsh-client-ui-settings-plugins is a read-only inventory
		// shell ("Configuring a built-in plugin happens on the sidebar's
		// Plugins page, where each official plugin's own companion package
		// registers its page"). Official plugins each draw their own card
		// (agent-loop / web-search / …). So a volatile field this card does not
		// render is editable NOWHERE in the GUI — that was the v0.7.9–v0.8.0
		// panel gap. Field types follow the schema (src/index.ts Config):
		// allGoalsMode boolean toggle; taskAgentModel / verifyAgentModel /
		// triageAgentModel text ('' = inherit); roundsPerSubgoal /
		// maxConcurrentRounds integers (≥1 / ≥0; blank restores the default via
		// an `unset` op). v0.8.4: roles is no longer on the card — hand-editing
		// a JSON object in the GUI is unfriendly; roles became non-volatile and
		// is configured directly in the profile yaml (agent-guided, README).
		// The card's field list is back to seven (v0.8.10):
		// hardGate (boolean toggle) / roundsPerSubgoal / maxConcurrentRounds.
		// v0.15.1: the three 「模型 + 思考强度」 pairs are grouped per sub agent
		// (Task → Verify → Triage) like the conversation composer's model
		// picker, each behind a small group header ('header' kind rows).
		// v0.16: smartAgentModelSelection joins as a boolean toggle (same write
		// path as allGoalsMode/hardGate) — placed ahead of the per-agent groups
		// because it reinterprets those groups' semantics (explicit rows still
		// win; unset rows get auto-picked from the live catalog).
		// v0.17: the preset-plans dropdown joins ahead of the per-agent groups
		// too — selecting an entry writes taskAgentModel/verifyAgentModel/
		// triageAgentModel SERVER-side (a ready vendor preset applies its
		// default variant; placeholder vendors change nothing), and the
		// outcome lands in the volatile presetRecommendation record that
		// renders under the select. v0.18.2: auto is a session-agent handoff
		// (preset_recommend tool; the plugin runs no LLM call of its own) —
		// the record gains the 'pending' state and the input row is gone.
		const SETTINGS_FIELDS = [
			// v0.8.10: hardGate is volatile and joins the card as a boolean toggle
			// (same write path as allGoalsMode: settings mutate → loader volatile
			// commit → loader/volatile-update → the server hot-installs/disposes
			// the gate listeners, no restart).
			{ field: 'hardGate', labelKey: 'settings.hardGate', hintKey: 'settings.hardGateHint', kind: 'boolean' },
			// v0.16: smart agent model selection (volatile boolean toggle).
			{ field: 'smartAgentModelSelection', labelKey: 'settings.smartAgentModelSelection', hintKey: 'settings.smartAgentModelSelectionHint', kind: 'boolean' },
			// v0.17: preset plans (volatile selector; server-resolved one-shot).
			{ field: 'presetPlan', labelKey: 'settings.presetPlan', hintKey: 'settings.presetPlanHint', kind: 'preset' },
			// v0.15.1: per-agent groups — the model field and its paired
			// reasoning-effort select sit adjacent under one header, matching
			// the composer's 「模型 · 推理等级」 combined control.
			{ field: 'groupTask', labelKey: 'settings.groupTask', kind: 'header' },
			// v0.8.3: the model fields are kind 'model' — datalist-backed
			// dropdown over the live host catalog, manual entry still accepted
			// (a datalist input is a free text input); invalid configured values
			// render the unavailable warning + a one-click clear.
			{ field: 'taskAgentModel', labelKey: 'settings.taskAgentModel', hintKey: 'settings.modelFieldHint', kind: 'model' },
			// v0.15: reasoning-effort selects. Options resolve live from the model
			// configured on the paired model field (modelField → catalog entry →
			// reasoning.efforts); unsupported/no-model states disable with a hint,
			// invalid stored ids fall back to the model default for display.
			{ field: 'taskAgentReasoningEffort', modelField: 'taskAgentModel', labelKey: 'settings.taskAgentEffort', hintKey: 'settings.effortFieldHint', kind: 'effort' },
			{ field: 'groupVerify', labelKey: 'settings.groupVerify', kind: 'header' },
			{ field: 'verifyAgentModel', labelKey: 'settings.verifyAgentModel', hintKey: 'settings.modelFieldHint', kind: 'model' },
			{ field: 'verifyAgentReasoningEffort', modelField: 'verifyAgentModel', labelKey: 'settings.verifyAgentEffort', hintKey: 'settings.effortFieldHint', kind: 'effort' },
			{ field: 'groupTriage', labelKey: 'settings.groupTriage', kind: 'header' },
			{ field: 'triageAgentModel', labelKey: 'settings.triageAgentModel', hintKey: 'settings.triageModelHint', kind: 'model' },
			{ field: 'triageAgentReasoningEffort', modelField: 'triageAgentModel', labelKey: 'settings.triageAgentEffort', hintKey: 'settings.effortFieldHint', kind: 'effort' },
			{ field: 'roundsPerSubgoal', labelKey: 'settings.roundsPerSubgoal', hintKey: 'settings.roundsPerSubgoalHint', kind: 'number', min: 1 },
			{ field: 'maxConcurrentRounds', labelKey: 'settings.maxConcurrentRounds', hintKey: 'settings.maxConcurrentRoundsHint', kind: 'number', min: 0 },
			// v0.19: status-indicator location (volatile enum select; the client
			// pill + hint bar read the same field off the live snapshot).
			{
				field: 'hintLocation', labelKey: 'settings.hintLocation', hintKey: 'settings.hintLocationHint', kind: 'enum',
				options: [
					{ value: 'both', labelKey: 'settings.hintLocation.optBoth' },
					{ value: 'pill', labelKey: 'settings.hintLocation.optPill' },
					{ value: 'composer', labelKey: 'settings.hintLocation.optComposer' },
					{ value: 'none', labelKey: 'settings.hintLocation.optNone' },
				],
			},
		];
		/** Sentinel for "blank input = restore the schema default" (an unset op). */
		const UNSET = {};
		// v0.17: the preset-plans dropdown options, in server registry order
		// (src/modelPresets.ts PRESET_IDS). The ids are the shared contract —
		// the server resolves them one-shot on the loader/volatile-update
		// event; the labels live in the locale dicts. The leading "(none)"
		// option is the select's neutral value ('' = unset op).
		const PRESET_CHOICES = [
			{ id: 'auto', labelKey: 'settings.preset.optAuto' },
			{ id: 'openai', labelKey: 'settings.preset.optOpenai' },
			{ id: 'claude', labelKey: 'settings.preset.optClaude' },
			{ id: 'gemini', labelKey: 'settings.preset.optGemini' },
			{ id: 'deepseek', labelKey: 'settings.preset.optDeepseek' },
			{ id: 'kimi', labelKey: 'settings.preset.optKimi' },
			{ id: 'qwen', labelKey: 'settings.preset.optQwen' },
			{ id: 'volcano-coding-plan', labelKey: 'settings.preset.optVolcanoCodingPlan' },
			{ id: 'minimax', labelKey: 'settings.preset.optMinimax' },
			{ id: 'glm', labelKey: 'settings.preset.optGlm' },
			{ id: 'builtin-glm-light', labelKey: 'settings.preset.optBuiltinGlmLight' },
			{ id: 'builtin-deepseek-fast', labelKey: 'settings.preset.optBuiltinDeepseekFast' },
		];
		/**
		 * v0.17: parse the volatile presetRecommendation record the server
		 * writes after a selection is resolved. Shape-tolerant: anything that
		 * is not a {status, preset, label} record returns undefined and the
		 * caller falls back to showing the raw text.
		 */
		function parsePresetRecord(text) {
			if (typeof text !== 'string' || text.trim() === '') return undefined;
			try {
				const parsed = JSON.parse(text);
				if (parsed === null || typeof parsed !== 'object') return undefined;
				const status = parsed.status;
				// v0.18.2: 'pending' = the auto request was handed to the session
				// agent and is awaiting its preset_recommend tool answer.
				if (status !== 'ok' && status !== 'pending' && status !== 'placeholder' && status !== 'degraded') return undefined;
				if (typeof parsed.preset !== 'string' || typeof parsed.label !== 'string') return undefined;
				return parsed;
			} catch {
				return undefined;
			}
		}
		//#region v0.8.3 model catalog store (dropdown data + invalid-model detection)
		// Host model directory, read the same way the official 子智能体 settings
		// page does (@deepseek-ai/dsh-client-ui-settings-subagent): the
		// `remote.session` namespace answers `modelCatalog()` with
		// { ok, value: { groups: [{id, name, models: [{id, name, reasoning?}]}], failures } }
		// — every currently routable model, grouped by provider. Provider
		// invalidations arrive as `llm/adapters-updated` on ctx.remote. OPTIONAL
		// everywhere: a host without the namespace leaves the store absent, the
		// dropdown empty and the text entry intact — no crash, no warnings.
		function createModelCatalogStore() {
			let snap = { status: 'idle', options: [] };
			const subs = new Set();
			return {
				subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
				getSnapshot() { return snap; },
				set(next) { snap = next; for (const cb of subs) cb(); },
				load: async (session) => {
					snap = { status: 'loading', options: snap.options };
					for (const cb of subs) cb();
					try {
						const response = await session.modelCatalog();
						if (response && response.ok === true && response.value && Array.isArray(response.value.groups)) {
							const options = [];
							for (const group of response.value.groups) {
								for (const model of (group.models ?? [])) {
									// v0.15.1: carry the model's reasoning capability metadata
									// ({ efforts: [{id,name}], defaultEffort }) through — the
									// conversation model picker keys exactly this field per
									// [group.id, model.id] (dsh-client-ui-model-selection
									// ModelCatalogDirectory.reasoningFor) to decide which
									// 推理等级 levels to offer. v0.15 dropped it here, so
									// every model looked effort-less ("不支持思考强度").
									// Shape validation stays in effortRow; an absent/odd
									// reasoning simply means unsupported.
									options.push({
										value: group.id + '/' + model.id,
										provider: group.id,
										model: model.id,
										reasoning: model.reasoning === undefined || model.reasoning === null ? undefined : model.reasoning,
										label: (group.name ?? group.id) + ' · ' + group.id + '/' + model.id,
									});
								}
							}
							snap = { status: 'ready', options };
						} else {
							snap = { status: 'error', options: [] };
						}
					} catch {
						snap = { status: 'error', options: [] };
					}
					for (const cb of subs) cb();
				},
			};
		}
		/**
		 * Whether a configured model value still resolves against the live
		 * catalog. Accepts the same shapes the runtime does (parseAgentModelSpec):
		 * `provider/model` (exact option match) or a bare model name (matches any
		 * provider's model id). An empty value or an absent/failed catalog never
		 * flags — the warning must be provable, not a guess.
		 */
		function isConfiguredModelAvailable(value, catalogSnap) {
			const text = (value ?? '').trim();
			if (text === '') return true;
			if (!catalogSnap || catalogSnap.status !== 'ready' || !Array.isArray(catalogSnap.options) || catalogSnap.options.length === 0) return true;
			if (text.indexOf('/') >= 0) {
				return catalogSnap.options.some((opt) => opt.value === text);
			}
			return catalogSnap.options.some((opt) => opt.model === text);
		}
		/**
		 * v0.15: resolve the catalog entry for a configured model value — same
		 * matching rules as isConfiguredModelAvailable ("provider/model" exact,
		 * bare name against any provider's model id). Returns the option (which
		 * carries the model's reasoning capability metadata) or undefined
		 * when the catalog is not ready or the value matches nothing. An empty
		 * value (inherit the session agent) also returns undefined: the client
		 * cannot know the inherited model's efforts, so the paired effort
		 * select disables instead of guessing.
		 */
		function findCatalogModel(value, catalogSnap) {
			const text = (value === undefined || value === null ? '' : String(value)).trim();
			if (text === '') return undefined;
			if (!catalogSnap || catalogSnap.status !== 'ready' || !Array.isArray(catalogSnap.options) || catalogSnap.options.length === 0) return undefined;
			if (text.indexOf('/') >= 0) {
				return catalogSnap.options.find((opt) => opt.value === text);
			}
			return catalogSnap.options.find((opt) => opt.model === text);
		}

		//#endregion

		/**
		 * The settings card; shared by all three seats. Two form shapes reach
		 * it, and the card must speak both:
		 *  - the LIVE ConfigForm this module injects (ctx.configForms.get):
		 *    getSnapshot / subscribe / set / unset / mutate — the only shape on
		 *    the plugins.bundle.config page and in summary rows, whose owners
		 *    pass no form of their own;
		 *  - the HOST's ConfigPageForm { state, mutate }: the plugins.item and
		 *    plugins.row.config detail pages compute it from the same shared
		 *    mirror (configForms.get(id).getSnapshot()/mutate) and pass it as
		 *    an OWNER prop, which spreads AFTER inject at the render seam
		 *    (@deepseek-ai/dsh-client-ui-renderer renderEntry: ...injected,
		 *    ...ownerProps) — on those pages this shape WINS over the injected
		 *    form. Reading `.subscribe` on it crashed the first v0.7.2 cut.
		 * The host shape carries no subscribe; its `state` is re-computed by
		 * the owning page on every mirror update, so reading it per render is
		 * already live.
		 */
		function SettingsCard(props) {
			const t = props.t;
			const form = props.form;
			// v0.7.6 path-(b) fallback write face: the plugin's own bound
			// remote.settings.mutate. SAME host write path as the ConfigForm
			// (remote.settings.mutate → @deepseek-ai/dsh-settings SettingsForms
			// → @deepseek-ai/dsh-config-editor edit → the USER patch row
			// `{id, name, config}` appended to the profile cordis.patch.yml,
			// reconciled by reconcileProfilePatches) — the only落点 the host
			// accepts. Used ONLY when the primary write refuses, without an
			// expectedRevision (the controller documents undefined as an
			// unconditional write), so a stale-revision refusal heals in place
			// and a hard refusal surfaces its exact host message instead of a
			// bare「宿主拒绝了写入」with no reason.
			const directMutate = props.directMutate;
			const view = props.view === 'summary' ? 'summary' : 'page';
			const live = form !== null && typeof form === 'object'
				&& typeof form.subscribe === 'function' && typeof form.getSnapshot === 'function' && typeof form.set === 'function'
				? form : undefined;
			const host = live === undefined && form !== null && typeof form === 'object'
				&& typeof form.mutate === 'function' && form.state !== null && typeof form.state === 'object'
				? form : undefined;
			const liveSnap = react.useSyncExternalStore(
				live ? (cb) => live.subscribe(cb) : noopSubscribe,
				live ? () => live.getSnapshot() : () => NO_FORM_SNAP,
			);
			const snap = host !== undefined ? host.state : liveSnap;
			const [saving, setSaving] = react.useState(false);
			// `false` = no failure; `true` = failure without a host message;
			// a string = the host's exact refusal (RemoteError.message).
			const [failed, setFailed] = react.useState(false);
			// v0.8.1: per-field edit drafts (field → text; absent = untouched,
			// the control shows the snapshot value) and the field whose current
			// draft failed local validation ('' = none). A failed SAVE keeps
			// the draft for correction; an accepted write clears it.
			const [drafts, setDrafts] = react.useState({});
			const [invalid, setInvalid] = react.useState('');
			// v0.8.3: the live model catalog face (optional prop; absent on hosts
			// without remote.session — the dropdown then renders empty and no
			// availability warning is ever shown).
			const catalog = props.catalog;
			const catalogSnap = react.useSyncExternalStore(
				catalog ? (cb) => catalog.subscribe(cb) : noopSubscribe,
				catalog ? () => catalog.getSnapshot() : () => NO_FORM_SNAP,
			);
			const catalogOptions = catalogSnap && Array.isArray(catalogSnap.options) ? catalogSnap.options : [];
			const on = snap.status === 'ready' && snap.value != null && snap.value.allGoalsMode === true;
			const cfg = snap.status === 'ready' && snap.value !== null && typeof snap.value === 'object' ? snap.value : {};
			const disabled = (live === undefined && host === undefined) || snap.status !== 'ready' || snap.writable === false || saving;
			const setDraft = (field, text) => setDrafts((d) => ({ ...d, [field]: text }));
			const clearDraft = (field) => setDrafts((d) => {
				if (!(field in d)) return d;
				const next = { ...d };
				delete next[field];
				return next;
			});
			// v0.8.7: focus parking for the model fields. A native datalist
			// filters its options by the input's CURRENT text, so a field that
			// already holds a configured model unfolded to exactly that one
			// option. Focusing such a field PARKS its text here and blanks the
			// input, which makes the datalist unfold the whole catalog; leaving
			// the field (blur/Enter) with no edit restores the parked text and
			// writes nothing — merely looking at the list can never unset a
			// configured model. `edited` records that the user typed or picked
			// an option while parked: only then does the regular commit run
			// (and a deliberate clear still lands as an unset op).
			// `hadDraft` remembers whether the parked text was an uncommitted
			// draft (keep it) or the snapshot value (restore = clear the draft).
			const [focus, setFocus] = react.useState({});
			const parkFocus = (field, value, hadDraft) => setFocus((f) => ({ ...f, [field]: { value, hadDraft, edited: false } }));
			const markFocusEdited = (field) => setFocus((f) => {
				const entry = f[field];
				if (entry === undefined || entry.edited === true) return f;
				return { ...f, [field]: { value: entry.value, hadDraft: entry.hadDraft, edited: true } };
			});
			const dropFocus = (field) => setFocus((f) => {
				if (!(field in f)) return f;
				const next = { ...f };
				delete next[field];
				return next;
			});
			/** Undo a focus-only visit: the parked text comes back, nothing is written. */
			const restoreParked = (field, entry) => {
				if (entry.hadDraft === true) setDraft(field, entry.value);
				else clearDraft(field);
			};

			// One write for any volatile field; the toggle is
			// writeField('allGoalsMode', !on). Both write paths land in the same
			// host mutation: ConfigForm.set/unset are one-field sugar over
			// ConfigForm.mutate, and the host's ConfigPageForm.mutate IS that
			// form's mutate (the expected revision carried explicitly). The
			// host commits the write into the running plugin instance
			// (volatile) and the next snapshot / page render pushes the
			// accepted value back here.
			// Failure policy (v0.7.4): the transport can REFUSE (settles
			// false) or stall (the observed "保存中" hang). Neither is
			// silent: a refused write shows saveFailed for a few seconds,
			// and a stalled write releases the controls after 15 s with the
			// same hint — every control always returns to the snapshot value,
			// which is the only state the host confirmed.
			// v0.7.6: a refused write is retried ONCE through the direct
			// settings transport (props.directMutate, no expectedRevision).
			// Same落点 (user patch row via configEditor), unconditional
			// revision — a stale-revision conflict therefore heals, and any
			// remaining refusal reports its host message verbatim.
			const writeField = (field, value) => {
				if (disabled) return;
				setSaving(true);
				setFailed(false);
				setInvalid('');
				let settled = false;
				const finish = (ok, detail) => {
					if (settled) return;
					settled = true;
					setSaving(false);
					if (ok) { clearDraft(field); return; }
					setFailed(detail || true);
					setTimeout(() => setFailed(false), 6000);
				};
				const guard = setTimeout(() => finish(false), 15000);
				const op = value === UNSET
					? { op: 'unset', path: [field] }
					: { op: 'set', path: [field], value };
				const write = live !== undefined
					? (value === UNSET ? live.unset(field) : live.set(field, value))
					: host.mutate([op], snap.revision);
				Promise.resolve(write)
					.then(async (accepted) => {
						if (accepted !== false) { clearTimeout(guard); finish(true); return; }
						if (typeof directMutate !== 'function') { clearTimeout(guard); finish(false); return; }
						try {
							const answer = await directMutate([op]);
							clearTimeout(guard);
							if (answer && typeof answer === 'object' && answer.ok === false) {
								finish(false, answer.error && answer.error.message);
							} else finish(true);
						} catch (error) {
							clearTimeout(guard);
							finish(false, error && error.message);
						}
					})
					.catch((error) => { clearTimeout(guard); finish(false, error && error.message); });
			};
			const toggle = () => writeField('allGoalsMode', !on);

			// Text/number commit (Enter or blur): an untouched field never
			// writes; a draft equal to the snapshot just clears; a blank draft
			// restores the schema default through an `unset` op; a number
			// outside its range flags the field instead of writing.
			const commitField = (spec) => {
				const draft = drafts[spec.field];
				if (draft === undefined) return;
				const current = cfg[spec.field];
				const text = draft.trim();
				if (text === (current === undefined || current === null ? '' : String(current))) {
					clearDraft(spec.field);
					setInvalid('');
					return;
				}
				if (text === '') { writeField(spec.field, UNSET); return; }
				if (spec.kind === 'number') {
					const n = Number(text);
					if (!Number.isInteger(n) || n < spec.min) { setInvalid(spec.field); return; }
					writeField(spec.field, n);
					return;
				}
				writeField(spec.field, text);
			};

			if (view === 'summary') {
				return jsx.jsx('span', { children: snap.status === 'ready' ? t(on ? 'settings.summaryOn' : 'settings.summaryOff') : t('settings.unavailable') });
			}

			// v0.8.10: boolean fields render the same switch face as the header
			// allGoalsMode toggle, per field. The write is the shared
			// writeField(field, !current) path (set op, no drafts involved).
			const booleanRow = (spec) => {
				const on = snap.status === 'ready' && snap.value != null && snap.value[spec.field] === true;
				return jsx.jsx('div', { style: settingsStyles.field, children:
					jsx.jsxs('div', { style: { ...settingsStyles.row }, children: [
						jsx.jsxs('div', { style: settingsStyles.main, children: [
							jsx.jsx('div', { style: settingsStyles.title, children: t(spec.labelKey) }),
							jsx.jsx('div', { style: settingsStyles.desc, children: t(spec.hintKey) }),
						] }),
						snap.status === 'ready'
							? jsx.jsx('button', {
								type: 'button', role: 'switch', 'aria-checked': on, 'aria-label': t(spec.labelKey),
								disabled, onClick: () => writeField(spec.field, !on),
								style: { ...settingsStyles.toggle, ...(on ? settingsStyles.trackOn : settingsStyles.trackOff) },
								children: jsx.jsx('span', { style: { ...settingsStyles.knob, ...(on ? settingsStyles.knobOn : settingsStyles.knobOff) } }),
							})
							: null,
					] })
				}, spec.field);
			};


			// v0.17: the preset-plans select. The choice itself is one volatile
		// write (writeField('presetPlan', id)); the SERVER resolves it one-shot
		// (v0.18.2: auto hands the brief to the session agent and writes a
		// pending record / a ready vendor preset applies its default variant /
		// a placeholder records a note) and answers through the volatile
		// presetRecommendation record, which renders under the select the
		// moment its snapshot commit lands. Status tones: ok/pending = default
		// text (pending is informational), placeholder/degraded/raw = the amber
		// used by the model-unavailable warning (a caution, not an error).
		// v0.19: parse the customPresets config field (one compact JSON array of
		// {id, name, at, roles:{task,verify,triage}}). Fully defensive — a
		// corrupt payload degrades to an empty list, never a throw (mirrors the
		// server's parseCustomPresets in src/modelPresets.ts).
		const CUSTOM_PRESET_PREFIX = 'custom:';
		const parseCustomPresetsList = (text) => {
			if (typeof text !== 'string' || text.trim() === '') return [];
			let parsed;
			try { parsed = JSON.parse(text); } catch { return []; }
			if (!Array.isArray(parsed)) return [];
			const out = [];
			for (const raw of parsed) {
				if (raw === null || typeof raw !== 'object') continue;
				if (typeof raw.id !== 'string' || raw.id === '') continue;
				if (typeof raw.name !== 'string' || raw.name.trim() === '') continue;
				const roles = (raw.roles !== null && typeof raw.roles === 'object') ? raw.roles : {};
				const clean = {};
				for (const roleKey of ['task', 'verify', 'triage']) {
					const spec = roles[roleKey];
					if (spec === null || typeof spec !== 'object') continue;
					const entry = {};
					if (typeof spec.provider === 'string' && spec.provider !== '') entry.provider = spec.provider;
					if (typeof spec.model === 'string' && spec.model !== '') entry.model = spec.model;
					if (typeof spec.reasoningEffort === 'string' && spec.reasoningEffort !== '') entry.reasoningEffort = spec.reasoningEffort;
					if (entry.provider !== undefined || entry.model !== undefined) clean[roleKey] = entry;
				}
				out.push({ id: raw.id, name: raw.name.trim(), at: typeof raw.at === 'string' ? raw.at : '', roles: clean });
			}
			return out;
		};
		// v0.19: capture the card's CURRENT task/verify/triage combination (the
		// snapshot flat values — committed config only, never drafts) into a
		// custom-preset roles object. `provider/model` splits on the slash; blank
		// fields are dropped (they mean inherit / model default).
		const captureCustomRoles = (cfgValue) => {
			const parseModel = (raw) => {
				const text = (raw === undefined || raw === null ? '' : String(raw)).trim();
				if (text === '') return undefined;
				const slash = text.indexOf('/');
				return slash > 0 ? { provider: text.slice(0, slash), model: text.slice(slash + 1) } : { model: text };
			};
			const parseEffort = (raw) => {
				const text = (raw === undefined || raw === null ? '' : String(raw)).trim();
				return text === '' ? undefined : text;
			};
			const roles = {};
			const pairs = [
				['task', parseModel(cfgValue.taskAgentModel), parseEffort(cfgValue.taskAgentReasoningEffort)],
				['verify', parseModel(cfgValue.verifyAgentModel), parseEffort(cfgValue.verifyAgentReasoningEffort)],
				['triage', parseModel(cfgValue.triageAgentModel), parseEffort(cfgValue.triageAgentReasoningEffort)],
			];
			for (const [roleKey, model, effort] of pairs) {
				if (model === undefined && effort === undefined) continue;
				roles[roleKey] = {
					...(model !== undefined && model.provider !== undefined ? { provider: model.provider } : {}),
					...(model !== undefined && model.model !== undefined ? { model: model.model } : {}),
					...(effort !== undefined ? { reasoningEffort: effort } : {}),
				};
			}
			return roles;
		};

		const presetRow = (spec) => {
			const plan = cfg[spec.field] === undefined || cfg[spec.field] === null ? '' : String(cfg[spec.field]);
			const record = parsePresetRecord(cfg.presetRecommendation);
			let note = null;
			if (record !== undefined) {
				if (record.status === 'ok') {
					// v0.17.1: per-role picks carry the applied effort token
					// (record.efforts[role]; '' = reset to the model default).
					const efforts = record.efforts !== null && typeof record.efforts === 'object' ? record.efforts : {};
					const picks = record.picks !== null && typeof record.picks === 'object'
						? Object.entries(record.picks).map(([role, value]) => {
							const effort = Object.prototype.hasOwnProperty.call(efforts, role) ? String(efforts[role] ?? '') : undefined;
							const suffix = effort === undefined
								? ''
								: effort !== ''
									? t('settings.preset.effortSuffix', { effort })
									: t('settings.preset.effortDefaultSuffix');
							return role + '=' + value + suffix;
						}).join(', ')
						: '';
					let text = t('settings.preset.applied', { label: record.label, picks });
					if (typeof record.variant === 'string' && record.variant !== '') {
						text += t('settings.preset.variant', { variant: record.variant });
					}
					if (Array.isArray(record.otherVariants) && record.otherVariants.length > 0) {
						text += t('settings.preset.otherVariants', { variants: record.otherVariants.join('、') });
					}
					if (Array.isArray(record.invalid) && record.invalid.length > 0) {
						text += t('settings.preset.appliedInvalid', { invalid: record.invalid.join('; ') });
					}
					note = { text, warn: false };
					// v0.17.1: applied-record notes (session-scope ruling, vendor
					// ⚠️ caveats, effort-validation notes) render as a second line.
					if (Array.isArray(record.notes) && record.notes.length > 0) {
						note.extra = t('settings.preset.notes', { notes: record.notes.join('；') });
					}
				} else if (record.status === 'placeholder') {
					note = { text: t('settings.preset.placeholder', { label: record.label }), warn: true };
				} else if (record.status === 'pending') {
					// v0.18.2: the auto request was handed to the session agent and
					// is awaiting its preset_recommend tool answer (blue = info,
					// not a warning; the record reason carries the same handoff
					// note for raw readers).
					note = { text: t('settings.preset.pending', { label: record.label }), warn: false };
				} else {
					note = { text: t('settings.preset.degraded', { reason: String(record.reason ?? 'unknown') }), warn: true };
				}
			} else if (typeof cfg.presetRecommendation === 'string' && cfg.presetRecommendation.trim() !== '') {
				note = { text: t('settings.preset.recordRaw', { raw: cfg.presetRecommendation }), warn: true };
			}
			// v0.19: custom presets render below the built-ins, separated by a
			// disabled divider option; selection writes the `custom:<id>` selector
			// the server resolves one-shot against the customPresets field.
			const customPresets = parseCustomPresetsList(cfg.customPresets);
			// v0.19: save the CURRENT snapshot combination under a user-chosen
			// name (browser prompt); a duplicate name overwrites the existing
			// entry after an explicit confirm (same id kept, so the selector
			// stays valid). Built-in vendor presets are code data — this flow
			// writes ONLY the customPresets field and can never touch them.
			const saveCustom = () => {
				if (disabled) return;
				const raw = window.prompt(t('settings.preset.savePrompt'));
				if (raw === null) return;
				const name = String(raw).trim();
				if (name === '') { window.alert(t('settings.preset.saveEmpty')); return; }
				const list = parseCustomPresetsList(cfg.customPresets);
				const existing = list.find((p) => p.name === name);
				if (existing !== undefined && !window.confirm(t('settings.preset.overwriteConfirm', { name }))) return;
				const roles = captureCustomRoles(cfg);
				const at = new Date().toISOString();
				const next = existing !== undefined
					? list.map((p) => (p.id === existing.id ? { ...p, roles, at } : p))
					: list.concat([{ id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), name, at, roles }]);
				writeField('customPresets', JSON.stringify(next));
			};
			// v0.19: delete the SELECTED custom preset (built-ins are never
			// deletable — the button renders only for a custom:<id> selection).
			// One combined mutation: the list rewrite + the presetPlan unset, so
			// the selector never lingers on a deleted entry.
			const deleteCustom = () => {
				if (disabled || !isCustomSelection) return;
				const entryId = plan.slice(CUSTOM_PRESET_PREFIX.length);
				const list = parseCustomPresetsList(cfg.customPresets);
				const entry = list.find((p) => p.id === entryId);
				if (entry === undefined) return;
				if (!window.confirm(t('settings.preset.deleteConfirm', { name: entry.name }))) return;
				const next = list.filter((p) => p.id !== entryId);
				const ops = [
					{ op: 'set', path: ['customPresets'], value: JSON.stringify(next) },
					{ op: 'unset', path: ['presetPlan'] },
				];
				setSaving(true);
				setFailed(false);
				let settled = false;
				const finish = (ok, detail) => {
					if (settled) return;
					settled = true;
					setSaving(false);
					if (!ok) { setFailed(detail || true); setTimeout(() => setFailed(false), 6000); }
				};
				const guard = setTimeout(() => finish(false), 15000);
				const write = live !== undefined ? live.mutate(ops) : host.mutate(ops, snap.revision);
				Promise.resolve(write)
					.then((accepted) => { clearTimeout(guard); finish(accepted !== false); })
					.catch((error) => { clearTimeout(guard); finish(false, error && error.message); });
			};
			const isCustomSelection = plan.indexOf(CUSTOM_PRESET_PREFIX) === 0;
			return jsx.jsxs('div', { style: settingsStyles.field, children: [
				jsx.jsx('div', { style: settingsStyles.title, children: t(spec.labelKey) }),
				jsx.jsx('div', { style: settingsStyles.desc, children: t(spec.hintKey) }),
				// v0.17.1: the standing session-scope callout (user ruling) — the
				// session agent is user-managed; presets and auto-recommend only
				// ever write the three sub-agent roles.
				jsx.jsx('div', { style: { ...settingsStyles.invalid, color: '#58a6ff', whiteSpace: 'pre-wrap' }, children: t('settings.preset.sessionScope') }),
				snap.status === 'ready'
					? jsx.jsxs('select', {
						'aria-label': t(spec.labelKey),
						disabled,
						value: plan,
						onChange: (e) => {
							const value = e && e.target ? String(e.target.value) : '';
							// '' = (none) → unset op (schema default ''); a concrete id
							// writes the selector the server resolves one-shot. The
							// disabled divider option can never be selected.
							writeField(spec.field, value === '' ? UNSET : value);
						},
						style: settingsStyles.input,
						children: [
							jsx.jsx('option', { value: '', children: t('settings.presetNone') }, 'none'),
							...PRESET_CHOICES.map((opt) => jsx.jsx('option', { value: opt.id, children: t(opt.labelKey) }, opt.id)),
							// v0.19: the divider between built-ins and user-saved combos.
							jsx.jsx('option', { value: '__custom-divider__', disabled: true, children: t('settings.preset.customDivider') }, 'custom-divider'),
							...customPresets.map((entry) => jsx.jsx('option', { value: CUSTOM_PRESET_PREFIX + entry.id, children: entry.name }, 'custom-' + entry.id)),
						],
					})
					: null,
				snap.status === 'ready'
					? jsx.jsxs('div', { style: { display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }, children: [
						jsx.jsx('button', {
							type: 'button',
							'aria-label': t('settings.preset.save'),
							title: t('settings.preset.saveHint'),
							disabled,
							onClick: saveCustom,
							style: settingsStyles.input,
							children: t('settings.preset.save'),
						}),
						isCustomSelection
							? jsx.jsx('button', {
								type: 'button',
								'aria-label': t('settings.preset.delete'),
								disabled,
								onClick: deleteCustom,
								style: { ...settingsStyles.input, color: '#f85149' },
								children: t('settings.preset.delete'),
							})
							: null,
					] })
					: null,
				note !== null ? jsx.jsx('div', { style: { ...settingsStyles.invalid, color: note.warn ? '#d29922' : 'inherit', whiteSpace: 'pre-wrap' }, children: note.text }) : null,
				note !== null && typeof note.extra === 'string' ? jsx.jsx('div', { style: { ...settingsStyles.invalid, color: '#8b949e', whiteSpace: 'pre-wrap' }, children: note.extra }) : null,
			] }, spec.field);
		};

			// v0.15: the reasoning-effort select for one sub agent. Options come
			// live from the model catalog entry of the model configured on the
			// paired model field — the same capability data the conversation
			// model picker renders. States:
			//  - no model configured (inherit session agent): disabled + hint
			//    (the inherited model's efforts are unknowable here — no guessing);
			//  - catalog still loading: disabled + loading hint;
			//  - v0.17.3: a model without reasoning efforts (reasoning absent or
			//    empty) is NOT an error: 跟随模型默认 sends no strength parameter,
			//    which is exactly what such a model wants — the select stays
			//    enabled with that single option and renders no warning, not even
			//    for a stale stored token (no declared level to conflict with);
			//  - v0.17.3: a "pure off" model (every offered level is off/none) is the
			//    same choice as 跟随模型默认, so the list collapses to that single
			//    option; a stored off id shows as the default, no warning, no write.
			//    A model offering any real level (glm-5.3: off/minimal/…/max) keeps
			//    its off entry — the dedupe never widens beyond the pure-off shape;
			//  - stored id not offered by the DECLARED levels (枚举变化/配置损坏):
			//    the select shows the EFFECTIVE selection (model default) plus a
			//    fallback note. An effort-less model declares no levels, so it
			//    never reaches this note (v0.17.3 follow-up, user ruling). The
			//    stored value is only replaced when the user saves a change
			//    (deliberate write, same policy as the model-clear button).
			// Save path: the shared writeField — '' (跟随模型默认) writes an unset
			// op, a concrete id writes the string. Volatile, next round live.
			const effortRow = (spec) => {
				const modelText = cfg[spec.modelField] === undefined || cfg[spec.modelField] === null ? '' : String(cfg[spec.modelField]).trim();
				const stored = cfg[spec.field] === undefined || cfg[spec.field] === null ? '' : String(cfg[spec.field]).trim();
				const catalogReady = catalogSnap !== undefined && catalogSnap !== null && catalogSnap.status === 'ready';
				const opt = catalogReady ? findCatalogModel(modelText, catalogSnap) : undefined;
				const reasoning = opt !== undefined && opt.reasoning !== undefined && opt.reasoning !== null
					&& Array.isArray(opt.reasoning.efforts) ? opt.reasoning : undefined;
				const efforts = reasoning !== undefined ? reasoning.efforts : [];
				const defaultEffort = reasoning !== undefined
					&& reasoning.defaultEffort !== undefined && reasoning.defaultEffort !== null
					? String(reasoning.defaultEffort)
					: undefined;
				// v0.17.3: conservative off-like test — the level id OR name equals
				// off/none (case-insensitive, trimmed). Deliberately not a prefix match:
				// minimal/low/medium/... are real levels and must never be collapsed.
				const OFF_LIKE = /^(off|none)$/i;
				const isOffLike = (lv) => lv !== undefined && lv !== null
					&& (OFF_LIKE.test(String(lv.id).trim())
					|| (lv.name !== undefined && lv.name !== null && OFF_LIKE.test(String(lv.name).trim())));
				const pureOff = efforts.length > 0 && efforts.every(isOffLike);
				// Pure-off levels ARE 跟随模型默认 (send nothing): hide them. Any real
				// level keeps the full list, off included (user-confirmed scope).
				const levels = pureOff ? [] : efforts;
				const storedValid = stored !== '' && levels.some((lv) => lv !== undefined && lv !== null && String(lv.id) === stored);
				const effective = storedValid ? stored : '';
				// v0.17.3: a resolved model is always selectable — dropping efforts from
				// the gates leaves only the three pre-existing ones (global disabled,
				// catalog not ready, no/unresolved model). "No strength levels" is a
				// valid state, not a reason to block the only (default) option.
				const selectDisabled = disabled || !catalogReady || opt === undefined;
				// v0.17.3 follow-up: the fallback note only applies when the model
				// DECLARES levels and the stored one is not among them. A model
				// with no levels sends no parameter for ANY stored token, so the
				// stale token is not worth a note (it would be pure noise).
				// A stored off/none id of a pure-off model IS declared (and is the
				// collapsed 跟随模型默认 option): display it as the default, never
				// warn, never write.
				const declaredLevel = efforts.some((lv) => lv !== undefined && lv !== null && String(lv.id) === stored);
				const note = opt !== undefined && efforts.length > 0 && stored !== '' && !declaredLevel
					? t('settings.effortFallback', { value: stored })
					: !catalogReady
						? t('settings.effortCatalogLoading')
						: modelText === ''
							? t('settings.effortNeedsModel')
							: null;
				return jsx.jsxs('div', { style: settingsStyles.field, children: [
					jsx.jsx('div', { style: settingsStyles.title, children: t(spec.labelKey) }),
					jsx.jsx('div', { style: settingsStyles.desc, children: t(spec.hintKey) }),
					snap.status === 'ready'
						? jsx.jsxs('select', {
							'aria-label': t(spec.labelKey),
							disabled: selectDisabled,
							value: effective,
							onChange: (e) => {
								const value = e && e.target ? String(e.target.value) : '';
								// '' = 跟随模型默认 → unset op (schema default ''), a concrete
								// id writes the string; both are the shared volatile write.
								writeField(spec.field, value === '' ? UNSET : value);
							},
							style: settingsStyles.input,
							children: [
								jsx.jsx('option', { value: '', children: defaultEffort !== undefined ? t('settings.effortDefault') + ' (' + defaultEffort + ')' : t('settings.effortDefault') }, 'default'),
								...levels.map((lv) => {
									const id = String(lv.id);
									const name = lv.name === undefined || lv.name === null ? '' : String(lv.name);
									return jsx.jsx('option', { value: id, children: name !== '' && name !== id ? id + ' · ' + name : id }, id);
								}),
							],
						})
						: null,
					note !== null ? jsx.jsx('div', { style: { ...settingsStyles.invalid, color: '#d29922' }, children: note }) : null,
				] }, spec.field);
			};

			// v0.19: fixed-enum select (hintLocation). Options are static; an
			// unknown / missing stored value displays the schema default 'both'
			// (the client reader readHintLocation degrades the same way).
			const enumRow = (spec) => {
				const raw = cfg[spec.field];
				const value = spec.options.some((o) => o.value === raw) ? String(raw) : 'both';
				return jsx.jsxs('div', { style: settingsStyles.field, children: [
					jsx.jsx('div', { style: settingsStyles.title, children: t(spec.labelKey) }),
					jsx.jsx('div', { style: settingsStyles.desc, children: t(spec.hintKey) }),
					snap.status === 'ready'
						? jsx.jsxs('select', {
							'aria-label': t(spec.labelKey),
							disabled,
							value,
							onChange: (e) => {
								const v = e && e.target ? String(e.target.value) : '';
								if (v !== '') writeField(spec.field, v);
							},
							style: settingsStyles.input,
							children: spec.options.map((o) => jsx.jsx('option', { value: o.value, children: t(o.labelKey) }, o.value)),
						})
						: null,
				] }, spec.field);
			};

			const fieldRow = (spec) => {
				if (spec.kind === 'boolean') return booleanRow(spec);
				// v0.19: fixed-enum select.
				if (spec.kind === 'enum') return enumRow(spec);
				// v0.17: preset-plans select (volatile selector + outcome record).
				if (spec.kind === 'preset') return presetRow(spec);
				// v0.15.1: per-agent group caption (Task / Verify / Triage) —
				// decorative, no write, still keyed for stable reconciliation.
				if (spec.kind === 'header') return jsx.jsx('div', {
					style: { fontSize: 12, fontWeight: 600, color: 'var(--dsh-text-secondary, #8b949e)', marginTop: 10, textTransform: 'uppercase', letterSpacing: 0.4 },
					children: t(spec.labelKey),
				}, spec.field);
				// v0.15: reasoning-effort select (catalog-driven, see effortRow above).
				if (spec.kind === 'effort') return effortRow(spec);
				// v0.8.3: availability verdict for the configured (snapshot) value —
				// drafts are uncommitted text and never warn. Only a loaded catalog
				// can flag; an empty/failed catalog keeps every value "available".
				const configuredValue = cfg[spec.field] === undefined || cfg[spec.field] === null ? '' : String(cfg[spec.field]);
				const modelUnavailable = spec.kind === 'model'
					&& !isConfiguredModelAvailable(configuredValue, catalogSnap);
				const listId = 'cybernetics-models-' + spec.field;
				// v0.8.7: a focused model field is "parked" — its text moved to
				// the placeholder and the input blanked so the datalist unfolds
				// every option instead of filtering down to the current value.
				const parked = focus[spec.field];
				const inputText = drafts[spec.field] !== undefined ? drafts[spec.field] : configuredValue;
				// Emptying the box is what lets the native datalist list every
				// model (it filters by the input text); the parked text stays
				// visible as the placeholder. Guarded so a second click into an
				// already-parked field never clears text the user just typed.
				const parkCurrent = () => {
					if (focus[spec.field] !== undefined) return;
					const text = drafts[spec.field] !== undefined ? String(drafts[spec.field]) : configuredValue;
					if (text !== '') { parkFocus(spec.field, text, drafts[spec.field] !== undefined); setDraft(spec.field, ''); }
				};
				return jsx.jsxs('div', { style: settingsStyles.field, children: [
					jsx.jsx('div', { style: settingsStyles.title, children: t(spec.labelKey) }),
					jsx.jsx('div', { style: settingsStyles.desc, children: t(spec.hintKey) }),
					snap.status === 'ready'
						? jsx.jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: [
							jsx.jsx('input', {
								type: 'text',
								// datalist: native dropdown over the catalog options; the
								// input stays a free text field, so manual entry is the
								// built-in fallback (and values off-catalog still commit).
								list: spec.kind === 'model' && catalogOptions.length > 0 ? listId : undefined,
								inputMode: spec.kind === 'number' ? 'numeric' : undefined,
								'aria-label': t(spec.labelKey),
								'aria-invalid': invalid === spec.field || undefined,
								disabled,
								placeholder: parked !== undefined ? parked.value : undefined,
								value: inputText,
								onChange: (e) => {
									setDraft(spec.field, e && e.target ? String(e.target.value) : '');
									// Typing/picking while parked turns the visit into a real
									// edit, so the commit paths below apply unchanged.
									markFocusEdited(spec.field);
								},
								onFocus: spec.kind === 'model' && catalogOptions.length > 0 ? parkCurrent : undefined,
								// A click on the already-focused input must also unfold the
								// list (Escape, or a list closed without blur, restores the
								// value and leaves the field focused — no second onFocus).
								onClick: spec.kind === 'model' && catalogOptions.length > 0 ? parkCurrent : undefined,
								onKeyDown: (e) => {
									if (!e) return;
									if (e.key === 'Enter') {
										const entry = focus[spec.field];
										if (entry !== undefined) {
											dropFocus(spec.field);
											// Enter on an untouched parked field = no edit: restore
											// instead of writing an unset. A parked field the user
											// really edited keeps the v0.8.1 commit path (blank =
											// unset).
											if (entry.edited !== true) { restoreParked(spec.field, entry); return; }
										}
										commitField(spec);
										return;
									}
									if (e.key === 'Escape') { dropFocus(spec.field); clearDraft(spec.field); setInvalid(''); }
								},
								onBlur: () => {
									const entry = focus[spec.field];
									if (entry !== undefined) {
										dropFocus(spec.field);
										const text = (drafts[spec.field] ?? '').trim();
										if (text === '' && entry.edited !== true) { restoreParked(spec.field, entry); return; }
									}
									commitField(spec);
								},
								style: { ...settingsStyles.input, ...(invalid === spec.field ? settingsStyles.inputInvalid : {}) },
							}),
							spec.kind === 'model' && catalogOptions.length > 0
								? jsx.jsx('datalist', { id: listId, children: catalogOptions.map((opt) =>
									jsx.jsx('option', { value: opt.value, label: opt.label ?? opt.value }, opt.value)) })
								: null,
						] })
						: null,
					modelUnavailable
						? jsx.jsxs('div', { style: { ...settingsStyles.invalid, color: '#d29922', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, children: [
							jsx.jsx('span', { children: t('settings.modelUnavailable') }),
							// One-click clear = an explicit user action writing an unset
							// op (same writeField path as blanking the field) — never a
							// silent auto-unset of stored config (recorded trade-off in
							// docs/CHANGELOG.md v0.8.3).
							jsx.jsx('button', {
								type: 'button',
								'aria-label': t('settings.modelClear') + ' ' + t(spec.labelKey),
								disabled,
								onClick: () => writeField(spec.field, UNSET),
								style: { ...settingsStyles.apply, alignSelf: 'auto' },
								children: t('settings.modelClear'),
							}),
						] })
						: null,
					invalid === spec.field ? jsx.jsx('div', { style: settingsStyles.invalid, children: t('settings.invalidNumber') }) : null,
				] }, spec.field);
			};

			return jsx.jsxs('div', { style: settingsStyles.card, children: [
				jsx.jsxs('div', { style: settingsStyles.row, children: [
					jsx.jsxs('div', { style: settingsStyles.main, children: [
						jsx.jsx('div', { style: settingsStyles.title, children: t('settings.title') }),
						jsx.jsx('div', { style: settingsStyles.desc, children: t('settings.description') }),
					] }),
					snap.status === 'ready'
						? jsx.jsx('button', {
							type: 'button', role: 'switch', 'aria-checked': on, 'aria-label': t('settings.title'),
							disabled, onClick: toggle,
							style: { ...settingsStyles.toggle, ...(on ? settingsStyles.trackOn : settingsStyles.trackOff) },
							children: jsx.jsx('span', { style: { ...settingsStyles.knob, ...(on ? settingsStyles.knobOn : settingsStyles.knobOff) } }),
						})
						: null,
				] }),
				...SETTINGS_FIELDS.map(fieldRow),
				snap.status !== 'ready' ? jsx.jsx('div', { style: settingsStyles.unavailable, children: t('settings.unavailable') }) : null,
				saving ? jsx.jsx('div', { style: settingsStyles.unavailable, children: t('settings.saving') }) : null,
				!saving && failed ? jsx.jsx('div', { style: { ...settingsStyles.unavailable, color: '#d29922' }, children: failed === true ? t('settings.saveFailed') : t('settings.saveFailedDetail', { message: failed }) }) : null,
			] });
		}
		//#endregion

		//#region mode indicator (v0.10.0): session-header pill + composer hint bar
		// Visual state indicator for the per-session orchestration mode so the
		// user can tell AT A GLANCE whether this session is under cybernetics
		// control (ALL-GOALS routing + hard gate + outer-loop input insert).
		// Data join: the session projection `cyberneticsMode` ({override:
		// true|false|null}, live-pushed by the host) + the profile-global
		// volatile `allGoalsMode` from the plugin's own ConfigForm (same live
		// face the settings card reads). The join is one `override ?? global`
		// — the canonical server-side rule is src/sessionMode.ts resolveMode();
		// the client deliberately mirrors it inline instead of waiting for the
		// server to compute "effective": the projection only republishes on
		// session events, so a global volatile flip could not reach a
		// server-side effective value without new server APIs. Both inputs are
		// reactive here, which the settings-card header toggle already proved
		// live. Click = ctx.remote.commands.execute(sessionId, '/cybernetics
		// on|off') — the exact path dsh-client-ui-plan uses for /plan off; no
		// new server API.
		const NO_MODE_FACE = { subscribe: () => () => {}, getSnapshot: () => undefined };
		const MODE_ON_COLOR = '#3fb950';
		const MODE_OFF_COLOR = '#8b949e';

		// v0.12.0: pure board-shape reducer for the pill's "inner loop running"
		// animation (now a rotating ring; was a pulsing dot). Input is whatever
		// the `cyberneticsGoals` projection face hands over ({goals: [{status,
		// round, ...}]} — src/projection.ts GoalView[] wire) or undefined/not-
		// yet-loaded; anything else degrades to zero so the pill simply never
		// animates instead of throwing. `round` is the highest round among
		// running goals (0 when none), for the tooltip's 「第 N 轮」 detail.
		// Exported on module.exports for offline unit tests.
		function countRunningGoals(board) {
			const goals = board !== null && typeof board === 'object' && Array.isArray(board.goals)
				? board.goals
				: [];
			let count = 0;
			let round = 0;
			for (const g of goals) {
				if (g === null || typeof g !== 'object' || g.status !== 'running') continue;
				count++;
				const r = typeof g.round === 'number' && Number.isFinite(g.round) ? g.round : 0;
				if (r > round) round = r;
			}
			return { count, round };
		}

		// v0.18.x: pill label counts —「控制模式：{stopped}/{total}」. stopped is
		// the count of goals NOT currently running (met / paused / pending /
		// anything that is not `status === 'running'`), total is
		// `goals.length`; the ratio therefore trends toward 1 as goals settle.
		// Semantics contract: stopped = total - running, clamped into
		// [0, total]. Alternative口径 (count only `met` as "settled") was
		// considered and rejected for now — noted as a possible future switch.
		// NOTE on the data source: the `cyberneticsGoals` projection face is
		// the only per-session agent activity surface the client pill has
		// (subagent chips live in the goal-tab model, not in this projection),
		// so these are GOAL counts — one running goal ≈ the session's live
		// outer loop. Malformed entries are skipped from the running count,
		// keeping total and stopped on the same countable base (total =
		// countable entries, stopped = total - running, never negative).
		// Malformed input degrades to { stopped: 0, total: 0 } and never
		// throws. Exported on module.exports for offline unit tests.
		function countGoals(board) {
			const goals = board !== null && typeof board === 'object' && Array.isArray(board.goals)
				? board.goals
				: [];
			let running = 0;
			for (const g of goals) {
				if (g === null || typeof g !== 'object' || g.status !== 'running') continue;
				running++;
			}
			const total = goals.length;
			const stopped = Math.min(Math.max(total - running, 0), total);
			return { stopped, total };
		}

		// v0.18.x: the pill indicator geometry. The ring box was enlarged from
		// 6×6 to 14×14 to visually match the host's context-usage ring in the
		// composer dock (measured live in the 3080 GUI: svg 14×14 CSS px,
		// circle bounding box ≈ 11×11 → r + strokeWidth/2 ≈ 5.5). Geometry is
		// the 6px ring scaled ×14/6 and snapped to clean values: r 6, stroke 2
		// (outer edge 7 = box edge, inner 5 — same 2:3 inner/outer feel as the
		// old r 2.5 / stroke 1). The dasharray keeps the old 3:1 arc:gap ratio:
		// 2π·6 ≈ 37.70 → '28.3 9.4' (old '11.8 3.9' on 2π·2.5 ≈ 15.71). The
		// 3s spin keyframes are unchanged.
		const PILL_RING_SIZE = 14;
		const PILL_RING_RADIUS = 6;
		const PILL_RING_STROKE = 2;
		const PILL_RING_DASHARRAY = '28.3 9.4';

		// v0.12.0: the running-state animation styles, injected into document.head
		// exactly once per page load (guarded by the data attribute). Later
		// change: the running indicator is a slowly rotating ring instead of a
		// pulsing dot — the arc gap (stroke-dasharray) is what makes the spin
		// visible at 6 px; 3s linear keeps it calm. prefers-reduced-motion
		// degrades to the plain static ring — the animation class becomes a
		// no-op. New style id + class (was dsh-cybernetics-pill-pulse /
		// -pill-dot-running): a page that loaded the old bundle during HMR
		// would keep the old guard tag and never re-inject under the same id;
		// distinct ids let the new styles inject cleanly and the old tag go inert.
		const PILL_SPIN_STYLE_ID = 'dsh-cybernetics-pill-spin';
		function ensurePillSpinStyle() {
			if (typeof document === 'undefined') return;
			if (document.getElementById(PILL_SPIN_STYLE_ID)) return;
			const style = document.createElement('style');
			style.id = PILL_SPIN_STYLE_ID;
			style.textContent = [
				'@keyframes dsh-cybernetics-pill-spin {',
				'  from { transform: rotate(0deg); }',
				'  to { transform: rotate(360deg); }',
				'}',
				'.dsh-cybernetics-pill-ring-running { animation: dsh-cybernetics-pill-spin 3s linear infinite; transform-origin: center; }',
				'@media (prefers-reduced-motion: reduce) {',
				'  .dsh-cybernetics-pill-ring-running { animation: none; }',
				'}',
			].join('\n');
			document.head.appendChild(style);
		}
		const modeIndicatorStyles = {
			pill: {
				display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 10px',
				borderRadius: 999, border: '0.5px solid var(--dsw-alias-border-l1, rgba(240,246,252,0.1))',
				background: 'var(--dsw-alias-bg-base, transparent)', cursor: 'pointer', flex: 'none',
				font: '500 12px/16px Inter, var(--dsw-font-family, sans-serif)',
				color: 'var(--dsw-alias-label-secondary, inherit)',
			},
			pillUnknown: { cursor: 'default', opacity: 0.7 },
			// All three indicator variants (dot / idle ring / running ring) share
			// the same PILL_RING_SIZE box (v0.18.x: 14×14, matching the host
			// context-usage ring) so the pill layout never jumps between states.
			dot: { width: PILL_RING_SIZE, height: PILL_RING_SIZE, borderRadius: 999, flex: 'none' },
			ring: { width: PILL_RING_SIZE, height: PILL_RING_SIZE, flex: 'none', display: 'block' },
			hint: {
				display: 'flex', alignItems: 'center', gap: 8, maxWidth: '100%', margin: '0 auto',
				padding: '2px 12px', borderRadius: 8, overflow: 'hidden', flex: 'none',
				font: '400 12px/18px Inter, var(--dsw-font-family, sans-serif)',
				color: 'var(--dsw-alias-label-tertiary, inherit)',
				background: 'var(--dsw-alias-interactive-bg-hover, rgba(240,246,252,0.04))',
				whiteSpace: 'nowrap', textOverflow: 'ellipsis',
			},
		};

		// Shared ring indicator (v0.19.0): one renderer for every "on" state of
		// both status UIs (session pill + composer hint bar). running=true →
		// the gapped ring with the 3s/turn spin class; running=false → the
		// static complete ring. Same PILL_RING_* geometry everywhere so the
		// pill and the hint bar look identical and nothing jumps.
		function renderModeRing(running, color) {
			return jsx.jsx('svg', {
				...(running ? { className: 'dsh-cybernetics-pill-ring-running' } : {}),
				width: PILL_RING_SIZE,
				height: PILL_RING_SIZE,
				viewBox: '0 0 14 14',
				'aria-hidden': true,
				style: modeIndicatorStyles.ring,
				children: jsx.jsx('circle', {
					cx: 7,
					cy: 7,
					r: PILL_RING_RADIUS,
					fill: 'none',
					stroke: color,
					strokeWidth: PILL_RING_STROKE,
					strokeLinecap: 'round',
					...(running ? { strokeDasharray: PILL_RING_DASHARRAY } : {}),
				}),
			});
		}

		/**
		 * One reactive tri-state read shared by the pill and the hint bar:
		 * { override: boolean|null|undefined, globalOn: boolean|undefined,
		 * ready } — `undefined` means "that input has not loaded yet". `ready`
		 * is false exactly while the effective mode cannot be decided.
		 */
		// Same live-face shape check the settings card uses: a ConfigForm
		// without subscribe/getSnapshot parks the config input (global value
		// unknown → the pill shows its loading state until the override or the
		// live form arrives).
		const liveConfigForm = (form) => form !== null && form !== undefined && typeof form === 'object'
			&& typeof form.subscribe === 'function' && typeof form.getSnapshot === 'function' ? form : undefined;

		function readModeState(raw, cfgSnap) {
			const override = raw !== undefined && raw !== null && typeof raw === 'object'
				&& typeof raw.override === 'boolean' ? raw.override : (raw === undefined ? undefined : null);
			const cfgReady = cfgSnap !== undefined && cfgSnap !== null && typeof cfgSnap === 'object'
				&& cfgSnap.status === 'ready' && cfgSnap.value !== null && typeof cfgSnap.value === 'object';
			const globalOn = cfgReady ? cfgSnap.value.allGoalsMode === true : undefined;
			const policy = cfgReady && cfgSnap.value.inputPolicy === 'queue' ? 'queue' : 'insert';
			const ready = override !== undefined && (override !== null || globalOn !== undefined);
			const effective = !ready
				? null
				: (override !== null ? override : globalOn);
			const source = override !== null ? 'override' : 'global';
			return { override, globalOn, policy, ready, effective, source };
		}

		/**
		 * v0.19.0: where the status indicators render, read from the live
		 * ConfigForm snapshot. Valid values: 'both' (default) | 'pill' |
		 * 'composer' | 'none'. Anything else — config not loaded yet, an older
		 * host without the field, a garbage value — degrades to 'both', which
		 * is exactly the pre-v0.19.0 behavior (backward compatible).
		 */
		function readHintLocation(cfgSnap) {
			const cfgReady = cfgSnap !== undefined && cfgSnap !== null && typeof cfgSnap === 'object'
				&& cfgSnap.status === 'ready' && cfgSnap.value !== null && typeof cfgSnap.value === 'object';
			const value = cfgReady ? cfgSnap.value.hintLocation : undefined;
			return value === 'pill' || value === 'composer' || value === 'none' ? value : 'both';
		}

		// The session-header pill: always visible per session; green = effective
		// on, gray = effective off, dim "…" = projection/config not loaded yet
		// (a loading state, never an error). Tooltip names the deciding source
		// (explicit override vs inherited global). Click toggles via the
		// /cybernetics command (same route the slash menu takes).
		function ModePill(props) {
			const t = props.t;
			const face = props.mode || NO_MODE_FACE;
			const raw = react.useSyncExternalStore(face.subscribe, face.getSnapshot);
			// v0.12.0: the same session's `cyberneticsGoals` projection face —
			// drives the "inner loop running" ring spin + tooltip detail. Optional:
			// an older host without the face leaves the pill exactly as before
			// (never spins).
			const goalsFace = props.goals || NO_MODE_FACE;
			const goalsRaw = react.useSyncExternalStore(goalsFace.subscribe, goalsFace.getSnapshot);
			const running = countRunningGoals(goalsRaw);
			// v0.18.x: label counts「{stopped}/{total}」— same board, same
			// degrade-to-zero contract as `running`.
			const counts = countGoals(goalsRaw);
			const cfgForm = props.config;
			const cfgSnap = react.useSyncExternalStore(
				liveConfigForm(cfgForm) ? (cb) => cfgForm.subscribe(cb) : noopSubscribe,
				liveConfigForm(cfgForm) ? () => cfgForm.getSnapshot() : () => NO_FORM_SNAP,
			);
			const state = readModeState(raw, cfgSnap);
			const execute = typeof props.execute === 'function' ? props.execute : undefined;
			const [busy, setBusy] = react.useState(false);
			// Transient failure note folded into the tooltip (6 s), matching the
			// settings card's "the snapshot is the only confirmed state" policy.
			const [error, setError] = react.useState('');
			react.useEffect(() => {
				if (!error) return;
				const timer = setTimeout(() => setError(''), 6000);
				return () => clearTimeout(timer);
			}, [error]);
			const toggle = () => {
				if (!execute || busy || !state.ready) return;
				setBusy(true);
				setError('');
				Promise.resolve(execute(props.sessionId, '/cybernetics ' + (state.effective ? 'off' : 'on')))
					.then((result) => {
						if (result && result.ok === false) setError(result.error && result.error.message ? t('mode.toggleFailed', { message: String(result.error.message) }) : t('mode.toggleFailed', { message: 'unknown error' }));
						else if (result && result.ok === true && result.value === undefined) setError(t('mode.toggleUnknown'));
					})
					.catch((err) => setError(t('mode.toggleFailed', { message: err && err.message ? String(err.message) : 'unknown error' })))
					.finally(() => setBusy(false));
			};
			let tip = error || (!state.ready
				? t('mode.tip.unknown')
				: t(state.effective
					? (state.source === 'override' ? 'mode.tip.onOverride' : 'mode.tip.onGlobal')
					: (state.source === 'override' ? 'mode.tip.offOverride' : 'mode.tip.offGlobal')));
			// v0.12.0: append the live inner-loop detail while the mode is on and
			// at least one goal is running (「2 个目标运行中 · 第 3 轮」).
			const pulsing = state.ready && state.effective === true && running.count > 0;
			if (pulsing) tip += '\n' + t('mode.tip.running', { count: running.count, round: running.round });
			if (pulsing) ensurePillSpinStyle();
			const dotColor = !state.ready ? MODE_OFF_COLOR : (state.effective ? MODE_ON_COLOR : MODE_OFF_COLOR);
			const disabled = !execute || busy || !state.ready;
			// v0.19.0: the hintLocation setting gates this pill ('none' hides
			// both UIs, 'composer' keeps only the hint bar). After all hooks —
			// an early return must never skip a hook. Unloaded/old-host →
			// 'both' (readHintLocation), so the pill stays visible as before.
			const hintLocation = readHintLocation(cfgSnap);
			if (hintLocation === 'none' || hintLocation === 'composer') return null;
			return jsx.jsxs('button', {
				type: 'button',
				'aria-label': tip.replace('\n', ' '),
				title: tip,
				disabled,
				onClick: toggle,
				style: { ...modeIndicatorStyles.pill, ...(!state.ready ? modeIndicatorStyles.pillUnknown : {}) },
				children: [
					// Running state: a slowly rotating ring with a stroke-dasharray
					// gap; idle-on: a static complete ring (same geometry, no
					// dasharray, no animation) — a still full ring means "on but
					// not running". Off / unknown keep the static dot. All
					// variants share the same PILL_RING_SIZE box (14×14, matching
					// the host context-usage ring), so layout never jumps. Both
					// ring arms go through the shared renderModeRing helper
					// (v0.19.0) so the composer hint bar renders the identical
					// indicator.
					pulsing
						? renderModeRing(true, dotColor)
						: (state.ready && state.effective === true
							? renderModeRing(false, dotColor)
							: jsx.jsx('span', { style: { ...modeIndicatorStyles.dot, background: dotColor } })),
					// v0.18.x: visible label =「控制模式：{active}/{total}」while the
					// mode state is loaded (counts are goal counts — see
					// countGoals); not-yet-loaded keeps「控制模式：…」. The tooltip
					// (title/aria-label above) keeps its richer wording.
					jsx.jsx('span', { children: state.ready ? t('mode.pillCounts', { stopped: counts.stopped, total: counts.total }) : t('mode.pillUnknown') }),
				],
			});
		}

		// The composer dock hint bar (v0.19.0): rendered ONLY while the
		// orchestration mode is effective in this session AND the
		// hintLocation setting includes 'composer'. Indicator + label now
		// match the session pill exactly — the same shared ring (rotating
		// gapped ring while a goal runs, static full ring when idle-on) and
		// the same「控制模式：{active}/{total}」counts label; the insert/queue
		// wording moved into the tooltip (title/aria-label) so the semantics
		// survive as hover detail.
		function ComposerHint(props) {
			const t = props.t;
			const face = props.mode || NO_MODE_FACE;
			const raw = react.useSyncExternalStore(face.subscribe, face.getSnapshot);
			const goalsFace = props.goals || NO_MODE_FACE;
			const goalsRaw = react.useSyncExternalStore(goalsFace.subscribe, goalsFace.getSnapshot);
			const running = countRunningGoals(goalsRaw);
			const counts = countGoals(goalsRaw);
			const cfgForm = props.config;
			const cfgSnap = react.useSyncExternalStore(
				liveConfigForm(cfgForm) ? (cb) => cfgForm.subscribe(cb) : noopSubscribe,
				liveConfigForm(cfgForm) ? () => cfgForm.getSnapshot() : () => NO_FORM_SNAP,
			);
			const state = readModeState(raw, cfgSnap);
			// v0.19.0: hintLocation gate ('none' hides both UIs, 'pill' keeps
			// only the session pill). Unloaded/old-host → 'both' (backward
			// compatible: the hint bar stays). Evaluated after all hooks.
			const hintLocation = readHintLocation(cfgSnap);
			if (!state.ready || state.effective !== true) return null;
			if (hintLocation === 'none' || hintLocation === 'pill') return null;
			if (running.count > 0) ensurePillSpinStyle();
			const tip = t(state.policy === 'queue' ? 'hint.queue' : 'hint.insert');
			return jsx.jsxs('div', {
				role: 'note',
				'data-cybernetics-hint': '',
				title: tip,
				'aria-label': tip,
				style: modeIndicatorStyles.hint,
				children: [
					renderModeRing(running.count > 0, MODE_ON_COLOR),
					jsx.jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' }, children: t('mode.pillCounts', { stopped: counts.stopped, total: counts.total }) }),
				],
			});
		}
		//#endregion

		//#region plugin apply
		const name = 'dsh-cybernetics';
		// configForms: the per-entry ConfigForm registry (@deepseek-ai/dsh-client-ui-settings)
		// that backs the plugins-page settings card below.
		const inject = ['slots', 'sessions', 'locale', 'configForms',
			// v0.14: the goal tab's agent chips navigate through the workspace
			// service — the same openSession(target) seam dsh-client-ui-subagent
			// passes openChild through. Optional at runtime (guarded in apply):
			// an absent namespace disables click-through, never the rendering.
			'uiWorkspace',
			// v0.7.6: the settings card's diagnostic fallback write rides the
			// same namespace remote the official ui-settings declares
			// (["remote", "remote.settings"]). Both are required: ctx access is
			// gated by the inject declaration (client-runner guard), so an
			// undeclared `remote` would throw on read and silently disable the
			// fallback. Optional at runtime (guarded in apply): a host without
			// the namespace parks this client module exactly as it would
			// ui-settings itself — the web profile always serves it.
			'remote', 'remote.settings',
			// v0.8.3: the settings card's model dropdown reads the host model
			// catalog through the session namespace (same service the official
			// ui-settings-subagent page declares). Guarded at runtime: absent →
			// no dropdown, no warnings, text entry as before.
			'remote.session',
			// v0.10.0: the mode pill's click-to-toggle rides the same host
			// commands transport the slash menu and dsh-client-ui-plan use
			// (remote.commands.execute(sessionId, line, attachments)). Guarded
			// at runtime: absent → the pill renders disabled with a hint
			// instead of throwing.
			'remote.commands'];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-cybernetics: dictionaries');
			const t = ctx.locale.bind(NS);

			// v0.7.2: bind the row's ConfigForm once per apply body. The namespace
			// is the loader row id (`dsh-cybernetics`), the same convention the
			// official cot-translation bundle uses (`ctx.configForms.get(ns)`). If
			// the host does not serve this namespace yet, the card renders its
			// unavailable state instead of throwing.
			let settingsForm;
			try {
				settingsForm = ctx.configForms.get(SETTINGS_ENTRY_ID);
			} catch {
				settingsForm = undefined;
			}
			// v0.7.6 path-(b) diagnostics face: the direct settings transport,
			// bound from this module's own context (`remote.settings` inject).
			// Guarded: a deployment without the namespace leaves it undefined
			// and the card falls back to the v0.7.4 hint-only failure state.
			let settingsDirectMutate;
			try {
				if (ctx.remote && ctx.remote.settings && typeof ctx.remote.settings.mutate === 'function') {
					settingsDirectMutate = (ops, expectedRevision) => ctx.remote.settings.mutate(SETTINGS_ENTRY_ID, ops, expectedRevision);
				}
			} catch {
				settingsDirectMutate = undefined;
			}
			// v0.8.3: the live model catalog for the settings card's dropdown +
			// invalid-model warnings. OPTIONAL: a host without the remote.session
			// namespace (or without modelCatalog) leaves it undefined — the card
			// renders text-only fields exactly as pre-v0.8.3, no crash, no
			// false warnings. Refresh on `llm/adapters-updated` (the same
			// invalidation the 子智能体 settings page listens to), so a model
			// deleted/added in the model settings updates the dropdown live.
			let catalogStore;
			try {
				if (ctx.remote && ctx.remote.session && typeof ctx.remote.session.modelCatalog === 'function') {
					catalogStore = createModelCatalogStore();
					ctx.effect(() => {
						catalogStore.load(ctx.remote.session);
						if (ctx.remote.$on && typeof ctx.remote.$on === 'function') {
							ctx.remote.$on('llm/adapters-updated', () => { catalogStore.load(ctx.remote.session); });
						}
					}, 'dsh-cybernetics: model catalog');
				}
			} catch {
				catalogStore = undefined;
			}
			const settingsInject = () => ({ form: settingsForm, directMutate: settingsDirectMutate, catalog: catalogStore });
			// v0.7.2 (the actual gap): the official Plugins page renders the
			// 内置插件配置 group cards ONLY from the `plugins.item` slot
			// (ItemCard in @deepseek-ai/dsh-client-ui-plugin-manager client.js:
			// basicCards = ledger.items from slot "plugins.item"; ItemDetail
			// renders view "page" with the host form for item.id). The keyed
			// seats below surface only on an installed bundle's own page, which
			// this linked bundle never reaches in the 已安装插件 group — that was
			// why v0.7.1's schema alone (and the first v0.7.2 cut) showed no card.
			// Register the list card UNCONDITIONALLY (v0.7.5 hardening): the earlier
			// cut gated it on configForms.whileServed, so a deployment where the
			// host does not (yet) serve the `dsh-cybernetics` namespace showed NO
			// card at all — indistinguishable from the registration never running.
			// ctx.configForms.get() binds a live ConfigFormController that follows
			// the shared describe mirror (ConfigForms.get → new ConfigFormController
			// + mirror.ensure), so a card registered before the namespace appears
			// flips to the toggle the moment the host starts serving it; while it
			// does not, the card renders its `settings.unavailable` line — visible
			// and diagnosable instead of absent.
			ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
				name: 'plugins.item',
				id: SETTINGS_ENTRY_ID,
				order: 80,
				label: () => t('settings.cardLabel'),
				locale: NS,
				inject: settingsInject,
			}, SettingsCard)), 'dsh-cybernetics: plugins-page settings card');
			// The dispatch key bundles use the profile dependency name (the value
			// in dsh.profile.bundles = `dsh-cybernetics`); register the scoped
			// package manifest name too, so either resolution finds the card.
			for (const bundleKey of ['dsh-cybernetics', '@mars.liu/dsh-cybernetics']) {
				ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
					name: 'plugins.row.config',
					key: bundleKey + '#' + SETTINGS_ENTRY_ID,
					locale: NS,
					inject: settingsInject,
				}, SettingsCard));
				ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
					name: 'plugins.bundle.config',
					key: bundleKey,
					locale: NS,
					inject: settingsInject,
				}, SettingsCard));
			}

			// Conversation-view tab, same slot the trajectory/context tabs use.
			// `t` reaches the view as a slot-provided prop from `locale: NS`
			// (PropsLocale) — do NOT also pass a hand-bound t through inject:
			// bind() before dictionary registration resolves empty strings and
			// shadows the injected one (verified live 2026-11-02).
			ctx.slots.inject('conversation.view', () => ctx.slots.register({
				name: 'conversation.view',
				id: 'cybernetics-goal',
				order: 15,
				locale: NS,
				label: () => t('view.goal'),
				inject: (sessionId) => {
					const binding = ctx.sessions.binding(sessionId);
					if (binding === undefined) throw new Error('dsh-cybernetics: session "' + sessionId + '" unavailable');
					// v0.14 goal-agent click-through: durable direct-parent subagent
					// address (the exact target shape dsh-client-ui-subagent's
					// openChild passes to uiWorkspace.openSession). The child's
					// catalog mode wins when listed; 'unknown' is the api-session-
					// controller's own fallback for an unlisted subagent child.
					// The list snapshot is read at CLICK time (not at inject time):
					// the subagent catalog may still be loading when the tab mounts.
					// v0.18: a chip rendered on an ANCESTOR board passes that board
					// session as its second argument — it is the child's real
					// parent (`parentSessionId`) and the catalog lookup key. The
					// second argument defaults to the viewing session (self board).
					const openAgent = typeof ctx.uiWorkspace !== 'undefined'
						&& ctx.uiWorkspace !== null && typeof ctx.uiWorkspace.openSession === 'function'
						? function (agent, boardSessionId) {
							const parentSessionId = typeof boardSessionId === 'string' && boardSessionId !== ''
								? boardSessionId
								: sessionId;
							let mode = 'unknown';
							try {
								const snap = ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null;
								const catalog = snap && snap.projectionsBySession && snap.projectionsBySession[parentSessionId]
									&& snap.projectionsBySession[parentSessionId].values
									? snap.projectionsBySession[parentSessionId].values.subagentCatalog
									: undefined;
								const entry = Array.isArray(catalog) ? catalog.find(function (e) { return e && e.id === agent.id; }) : undefined;
								if (entry && typeof entry.mode === 'string' && entry.mode !== 'external') mode = entry.mode;
							} catch { /* keep 'unknown' */ }
							ctx.uiWorkspace.openSession({ parentSessionId: parentSessionId, childSessionId: agent.id, mode });
						}
						: undefined;
					// v0.18.3:「回到主对话」target. `uiWorkspace.openSession` takes a
					// SessionTarget = SessionId | SubagentAddress, so a plain root
					// session id string selects that session. Guarded exactly like
					// openAgent: an absent workspace service disables the
					// cross-session leg and the entry degrades to the local view
					// switch (pre-v0.18.3 behavior) instead of throwing.
					const openHome = typeof ctx.uiWorkspace !== 'undefined'
						&& ctx.uiWorkspace !== null && typeof ctx.uiWorkspace.openSession === 'function'
						? function (homeSessionId) {
							if (typeof homeSessionId !== 'string' || homeSessionId === '') return;
							ctx.uiWorkspace.openSession(homeSessionId);
						}
						: undefined;
					// v0.6: both faces. `cyberneticsGoals` carries the whole goal
					// board (live, pushed by the host); `goal` stays as the
					// backward-compatible fallback for older plugin/host builds.
					return {
						goals: binding.session.projections.faceOf('cyberneticsGoals'),
						goal: binding.session.projections.faceOf('goal'),
						sessionId,
						sessions: ctx.sessions,
						open: openAgent,
						openHome,
					};
				},
			}, GoalView));

			// Control tab: goals + run states of every agent in this session,
			// driven by the session list store (live via the control stream).
			// The goal face is optional (older host/plugin): the agent tree then
			// renders exactly as before.
			ctx.slots.inject('conversation.view', () => ctx.slots.register({
				name: 'conversation.view',
				id: 'cybernetics-control',
				order: 16,
				locale: NS,
				label: () => t('view.control'),
				inject: (sessionId) => {
					let goals = NOOP_GOALS_FACE;
					try {
						const binding = ctx.sessions.binding(sessionId);
						const face = binding && binding.session && binding.session.projections
							? binding.session.projections.faceOf('cyberneticsGoals')
							: undefined;
						if (face) goals = face;
					} catch {
						// No multi-goal projection: keep the control tab's agent tree.
					}
					// v0.18.3: same「回到主对话」navigation target as the goal tab
					// (see the goal-tab inject above for the seam and the guard).
					const openHome = typeof ctx.uiWorkspace !== 'undefined'
						&& ctx.uiWorkspace !== null && typeof ctx.uiWorkspace.openSession === 'function'
						? function (homeSessionId) {
							if (typeof homeSessionId !== 'string' || homeSessionId === '') return;
							ctx.uiWorkspace.openSession(homeSessionId);
						}
						: undefined;
					return { sessionId, sessions: ctx.sessions, goals, openHome };
				},
			}, ControlView));

			// v0.10.0: the orchestration-mode visual indicator. Two session-scoped
			// seats (both declared list/session by dsh-client-ui-conversation):
			// the header pill (always visible) and the composer dock hint bar
			// (only while the mode is effective). Both subscribe the same two
			// reactive inputs — the session projection face and the plugin's
			// ConfigForm (global allGoalsMode / inputPolicy) — via the shared
			// readModeState join (see the mode-indicator region). The command
			// transport is optional and guarded: a host without remote.commands
			// renders the pill in its disabled/loading state with a hint instead
			// of crashing the header.
			const runCommand = (() => {
				try {
					if (ctx.remote && ctx.remote.commands && typeof ctx.remote.commands.execute === 'function') {
						return (sessionId, line) => ctx.remote.commands.execute(sessionId, line, []);
					}
				} catch { /* namespace absent → undefined */ }
				return undefined;
			})();
			const modeIndicatorInject = (sessionId) => {
				let mode = NO_MODE_FACE;
				let goals = NO_MODE_FACE;
				try {
					const binding = ctx.sessions.binding(sessionId);
					const projections = binding && binding.session && binding.session.projections;
					const face = projections ? projections.faceOf('cyberneticsMode') : undefined;
					if (face) mode = face;
					// v0.12.0: the goal-board face for the pill's running
					// animation (rotating ring).
					// Same binding path as the conversation.view seats (the header
					// utilities slot delivers the sessionId prop identically) —
					// verified against the v0.10.0 cyberneticsMode seat, which has
					// resolved this binding live since that release. Optional: an
					// older host without the projection keeps the pill static.
					const goalsFace = projections ? projections.faceOf('cyberneticsGoals') : undefined;
					if (goalsFace) goals = goalsFace;
				} catch {
					// Projection face unavailable (older host): the pill shows its
					// unknown state, the hint bar stays hidden.
				}
				return { mode, goals, config: settingsForm, execute: runCommand, sessionId };
			};
			ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
				name: 'conversation.session.header.utilities',
				id: 'cybernetics-mode-pill',
				order: 10,
				locale: NS,
				inject: modeIndicatorInject,
			}, ModePill));
			ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
				name: 'conversation.composer.dock',
				id: 'cybernetics-composer-hint',
				order: 10,
				locale: NS,
				inject: modeIndicatorInject,
			}, ComposerHint));
		}
		//#endregion

		// v0.18.3: `homeSessionOf` / `requestHome` / `consumeHomeRequest` are
		// pure-ish helpers (the last two own the page-lifetime HOME_REQUESTS
		// singleton) exported for the offline harness (test/v20-home-entry.mjs).
		module.exports = {
			name, inject, apply, countRunningGoals, countGoals, readHintLocation,
			homeSessionOf, requestHome, consumeHomeRequest,
		};
		return module.exports;
	},
});
