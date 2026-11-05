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
			// v0.14: reasoning-effort selects — options resolve live from the same
			// model catalog face (session.modelCatalog → model.reasoning) the
			// conversation model picker reads; no model / unsupported model
			// disables the select with a hint; an invalid stored id displays the
			// effective (model default) selection with a fallback note.
			'settings.taskAgentEffort': 'Task agent 思考强度',
			'settings.verifyAgentEffort': 'Verify agent 思考强度',
			'settings.triageAgentEffort': 'Triage agent 思考强度',
			'settings.effortFieldHint': '思考强度档位随该 sub agent 当前所选模型动态给出（与会话输入框 model picker 同一模型能力数据源）。「跟随模型默认」不发送该参数，由模型适配器按默认档位处理。选择即保存，下一轮 goal 生效。',
			'settings.effortDefault': '跟随模型默认',
			'settings.effortUnsupported': '该模型不支持思考强度。',
			'settings.effortFallback': '配置的档位「{value}」不在当前模型支持列表中，实际按模型默认档位执行（选择一个受支持的档位并保存即可覆盖）。',
			'settings.effortNeedsModel': '该 sub agent 未指定模型（继承 session agent 模型）——在上方模型字段选择具体模型后可选择思考强度。',
			'settings.effortCatalogLoading': '模型目录加载中，档位暂不可选。',
			'settings.roundsPerSubgoal': '子目标轮数上限',
			'settings.roundsPerSubgoalHint': '同一子目标的最大连续轮数（整数 ≥1，缺省 3）；留空恢复默认。回车或移开焦点即保存。',
			'settings.maxConcurrentRounds': '并行轮数上限',
			'settings.maxConcurrentRoundsHint': '全局并行轮数上限（整数 ≥0，缺省 0 = 不限）；留空恢复默认。回车或移开焦点即保存。',
			// v0.8.4: roles 高级配置不再上卡片（手工编辑 JSON 对用户不友善）——
			// 由 agent 指导用户直接编辑 profile 配置 yaml（见 README）。
			'settings.invalidNumber': '请输入符合范围的整数，或留空恢复默认。',
			// v0.8.10: hardGate 上卡片（volatile，热切换）。
			'settings.hardGate': '硬控制门',
			'settings.hardGateHint': '开启后，顶层 agent 的写/执行工具在装配期被摘除，所有变更必须经 cybernetics goal + task agent 委派完成。开关保存后即时生效（热装卸门禁监听），无需重启。',
			// v0.10.0: 控制模式可视化状态指示（会话头部徽标 + 输入框提示条）。
			'mode.pill': '控制',
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
			'settings.verifyAgentModel': 'Verify agent model',
			'settings.modelFieldHint': 'Pick from the dropdown of currently available system models (shown as provider · provider/model); click into the input to see the whole list — an existing value is parked as the placeholder and restored on blur without saving. You can also type "provider/model" or a bare model name; empty = inherit the session agent. Enter or blur saves.',
			'settings.modelUnavailable': 'This model is no longer in the system model list; at runtime the round falls back to the session agent model.',
			'settings.modelClear': 'Clear',
			// v0.8.2: the triage role's flat model field (see zh for the rationale).
			'settings.triageAgentModel': 'Triage agent model',
			'settings.triageModelHint': 'Pick from the dropdown of available system models; click into the input to see the whole list (an existing value is parked as the placeholder and restored on blur without saving). You can also type "provider/model" or a bare model name; empty = inherit the session agent. The triage role reads the task/verify results and emits the round\'s convergence decision (met/continue/human-input/...); quick rounds never invoke it. Enter or blur saves.',
			// v0.14: reasoning-effort selects (see zh for the rationale).
			'settings.taskAgentEffort': 'Task agent reasoning effort',
			'settings.verifyAgentEffort': 'Verify agent reasoning effort',
			'settings.triageAgentEffort': 'Triage agent reasoning effort',
			'settings.effortFieldHint': 'Effort levels resolve live from the model this sub agent uses (the same model-capability source the conversation model picker reads). "Model default" sends no effort parameter; the adapter applies its default. Saving takes effect on the next goal round.',
			'settings.effortDefault': 'Model default',
			'settings.effortUnsupported': 'This model provides no reasoning effort levels.',
			'settings.effortFallback': 'The configured effort "{value}" is not offered by the current model; the model default applies (pick a supported level and save to overwrite).',
			'settings.effortNeedsModel': 'No model configured for this sub agent (inheriting the session agent model) — pick a specific model above to choose an effort level.',
			'settings.effortCatalogLoading': 'Model catalog loading — effort levels are temporarily unavailable.',
			'settings.roundsPerSubgoal': 'Rounds per subgoal',
			'settings.roundsPerSubgoalHint': 'Max consecutive rounds on one subgoal (integer ≥1, default 3); empty restores the default. Enter or blur saves.',
			'settings.maxConcurrentRounds': 'Concurrent round cap',
			'settings.maxConcurrentRoundsHint': 'Global cap on rounds in flight (integer ≥0, default 0 = unlimited); empty restores the default. Enter or blur saves.',
			'settings.invalidNumber': 'Enter an integer in range, or leave blank to restore the default.',
			// v0.8.10: hardGate joins the card (volatile, hot-toggled).
			'settings.hardGate': 'Hard control gate',
			'settings.hardGateHint': 'When on, write/execution tools are stripped from the TOP-LEVEL agent at assembly time; every change must go through a cybernetics goal + task agent. Takes effect immediately on save (gate listeners are hot-installed/disposed); no restart needed.',
			// v0.10.0: control-mode visual indicator (header pill + composer hint bar).
			'mode.pill': 'Control',
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

		// One goal row: title + status badge + round + current subgoal + tags.
		// Append-only lineage (v0.6): a superseded goal names its successor, a
		// revised goal names where it came from — titles resolved from the board
		// snapshot, falling back to the goalId when the successor is not listed.
		function GoalRow(props) {
			const t = props.t;
			const g = props.goal;
			const titles = props.titles || {};
			const statusKey = GOAL_STATUS_KEY[g.status] ?? 'goalStatus.pending';
			const depthKey = g.depth === 'quick' ? 'goal.depth.quick' : 'goal.depth.full';
			const executorKey = g.executor === 'persistent' ? 'goal.executor.persistent' : 'goal.executor.ephemeral';
			return jsx.jsxs('div', { style: styles.goalCard, children: [
				jsx.jsxs('div', { style: styles.goalHead, children: [
					jsx.jsx('span', { style: styles.goalTitle, children: g.title || g.goalId }),
					jsx.jsx('span', { style: { ...styles.badge, ...goalStatusStyle(g.status) }, children: t(statusKey) }),
				] }),
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
			] });
		}

		// Multi-goal list. Order is the projection's (server-side two segments:
		// unfinished goals first, finished after; newest change first inside each),
		// so the client renders verbatim and never re-sorts.
		function GoalsList(props) {
			const t = props.t;
			const goals = props.goals;
			const titles = {};
			for (const g of goals) titles[g.goalId] = g.title || g.goalId;
			return jsx.jsxs('div', { style: styles.root, children: [
				jsx.jsx('div', { style: styles.badgeRow, children:
					jsx.jsx('span', { style: styles.badge, children: t('goals.count', { count: goals.length }) }) }),
				...goals.map(function (g) {
					return jsx.jsx(GoalRow, { goal: g, t: t, titles: titles }, g.goalId + ':' + (g.updatedAt ?? 0));
				}),
				jsx.jsx('div', { style: styles.hint, children: t('loopHint') }),
			] });
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
				return jsx.jsx('div', { style: styles.empty, children: t('noGoal') });
			}
			const g = goal.goal ?? goal;
			return jsx.jsxs('div', { style: styles.root, children: [
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

		function GoalView(props) {
			const goalsRaw = react.useSyncExternalStore(props.goals.subscribe, props.goals.getSnapshot);
			const singleRaw = react.useSyncExternalStore(props.goal.subscribe, props.goal.getSnapshot);
			const goals = goalsRaw !== null && typeof goalsRaw === 'object' && Array.isArray(goalsRaw.goals)
				? goalsRaw.goals
				: [];
			if (goals.length > 0) return jsx.jsx(GoalsList, { t: props.t, goals: goals });
			return jsx.jsx(SingleGoalView, { t: props.t, raw: singleRaw });
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
			return jsx.jsxs('div', { style: styles.root, children: [
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
		// hardGate (boolean toggle) / allGoalsMode-toggle header +
		// taskAgentModel / verifyAgentModel / triageAgentModel /
		// roundsPerSubgoal / maxConcurrentRounds.
		const SETTINGS_FIELDS = [
			// v0.8.10: hardGate is volatile and joins the card as a boolean toggle
			// (same write path as allGoalsMode: settings mutate → loader volatile
			// commit → loader/volatile-update → the server hot-installs/disposes
			// the gate listeners, no restart).
			{ field: 'hardGate', labelKey: 'settings.hardGate', hintKey: 'settings.hardGateHint', kind: 'boolean' },
			// v0.8.3: the three model fields are kind 'model' — datalist-backed
			// dropdown over the live host catalog, manual entry still accepted
			// (a datalist input is a free text input); invalid configured values
			// render the unavailable warning + a one-click clear.
			{ field: 'taskAgentModel', labelKey: 'settings.taskAgentModel', hintKey: 'settings.modelFieldHint', kind: 'model' },
			// v0.14: reasoning-effort selects. Options resolve live from the model
			// configured on the paired model field (modelField → catalog entry →
			// reasoning.efforts); unsupported/no-model states disable with a hint,
			// invalid stored ids fall back to the model default for display.
			{ field: 'taskAgentReasoningEffort', modelField: 'taskAgentModel', labelKey: 'settings.taskAgentEffort', hintKey: 'settings.effortFieldHint', kind: 'effort' },
			{ field: 'verifyAgentModel', labelKey: 'settings.verifyAgentModel', hintKey: 'settings.modelFieldHint', kind: 'model' },
			{ field: 'verifyAgentReasoningEffort', modelField: 'verifyAgentModel', labelKey: 'settings.verifyAgentEffort', hintKey: 'settings.effortFieldHint', kind: 'effort' },
			{ field: 'triageAgentModel', labelKey: 'settings.triageAgentModel', hintKey: 'settings.triageModelHint', kind: 'model' },
			{ field: 'triageAgentReasoningEffort', modelField: 'triageAgentModel', labelKey: 'settings.triageAgentEffort', hintKey: 'settings.effortFieldHint', kind: 'effort' },
			{ field: 'roundsPerSubgoal', labelKey: 'settings.roundsPerSubgoal', hintKey: 'settings.roundsPerSubgoalHint', kind: 'number', min: 1 },
			{ field: 'maxConcurrentRounds', labelKey: 'settings.maxConcurrentRounds', hintKey: 'settings.maxConcurrentRoundsHint', kind: 'number', min: 0 },
		];
		/** Sentinel for "blank input = restore the schema default" (an unset op). */
		const UNSET = {};
		//#region v0.8.3 model catalog store (dropdown data + invalid-model detection)
		// Host model directory, read the same way the official 子智能体 settings
		// page does (@deepseek-ai/dsh-client-ui-settings-subagent): the
		// `remote.session` namespace answers `modelCatalog()` with
		// { ok, value: { groups: [{id, name, models: [{id, name}]}], failures } }
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
									options.push({
										value: group.id + '/' + model.id,
										provider: group.id,
										model: model.id,
										label: (group.name ?? group.id) + ' · ' + group.id + '/' + model.id,
										// v0.14: the model's reasoning-effort capability metadata
										// (efforts[] + defaultEffort) — the same session.modelCatalog
										// face the conversation model picker reads for its dynamic
										// effort menu; consumed by the settings card effort selects.
										reasoning: model.reasoning,
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
		 * v0.14: resolve the catalog entry for a configured model value — same
		 * matching rules as isConfiguredModelAvailable ("provider/model" exact,
		 * bare name against any provider's model id). Returns the option (which
		 * now carries the model's reasoning capability metadata) or undefined
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

			// v0.14: the reasoning-effort select for one sub agent. Options come
			// live from the model catalog entry of the model configured on the
			// paired model field — the same capability data the conversation
			// model picker renders. States:
			//  - no model configured (inherit session agent): disabled + hint
			//    (the inherited model's efforts are unknowable here — no guessing);
			//  - catalog still loading: disabled + loading hint;
			//  - model without reasoning efforts (reasoning absent or empty):
			//    disabled + 「该模型不支持思考强度」 — never an empty dropdown, never an error;
			//  - stored id not offered by the model (枚举变化/配置损坏): the select
			//    shows the EFFECTIVE selection (model default) plus a fallback
			//    note; the stored value is only replaced when the user saves a
			//    change (deliberate write, same policy as the model-clear button).
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
				const storedValid = stored !== '' && efforts.some((lv) => lv !== undefined && lv !== null && String(lv.id) === stored);
				const effective = storedValid ? stored : '';
				const unsupported = catalogReady && opt !== undefined && efforts.length === 0;
				const selectDisabled = disabled || !catalogReady || opt === undefined || efforts.length === 0;
				const note = unsupported
					? t('settings.effortUnsupported')
					: stored !== '' && !storedValid && efforts.length > 0
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
								...efforts.map((lv) => {
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

			const fieldRow = (spec) => {
				if (spec.kind === 'boolean') return booleanRow(spec);
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
		// pulse. Input is whatever the `cyberneticsGoals` projection face hands
		// over ({goals: [{status, round, ...}]} — src/projection.ts GoalView[]
		// wire) or undefined/not-yet-loaded; anything else degrades to zero so
		// the pill simply never pulses instead of throwing. `round` is the
		// highest round among running goals (0 when none), for the tooltip's
		// 「第 N 轮」 detail. Exported on module.exports for offline unit tests.
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

		// v0.12.0: the pulse keyframes, injected into document.head exactly once
		// per page load (guarded by the data attribute). prefers-reduced-motion
		// degrades to the plain static dot — the animation class becomes a no-op.
		const PILL_PULSE_STYLE_ID = 'dsh-cybernetics-pill-pulse';
		function ensurePillPulseStyle() {
			if (typeof document === 'undefined') return;
			if (document.getElementById(PILL_PULSE_STYLE_ID)) return;
			const style = document.createElement('style');
			style.id = PILL_PULSE_STYLE_ID;
			style.textContent = [
				'@keyframes dsh-cybernetics-pill-pulse {',
				'  0%, 100% { opacity: 1; }',
				'  50% { opacity: 0.35; }',
				'}',
				'.dsh-cybernetics-pill-dot-running { animation: dsh-cybernetics-pill-pulse 1.6s ease-in-out infinite; }',
				'@media (prefers-reduced-motion: reduce) {',
				'  .dsh-cybernetics-pill-dot-running { animation: none; }',
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
			dot: { width: 6, height: 6, borderRadius: 999, flex: 'none' },
			hint: {
				display: 'flex', alignItems: 'center', gap: 8, maxWidth: '100%', margin: '0 auto',
				padding: '2px 12px', borderRadius: 8, overflow: 'hidden', flex: 'none',
				font: '400 12px/18px Inter, var(--dsw-font-family, sans-serif)',
				color: 'var(--dsw-alias-label-tertiary, inherit)',
				background: 'var(--dsw-alias-interactive-bg-hover, rgba(240,246,252,0.04))',
				whiteSpace: 'nowrap', textOverflow: 'ellipsis',
			},
			hintDot: { width: 6, height: 6, borderRadius: 999, flex: 'none', background: MODE_ON_COLOR },
		};

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
			// drives the "inner loop running" pulse + tooltip detail. Optional:
			// an older host without the face leaves the pill exactly as before
			// (never pulses).
			const goalsFace = props.goals || NO_MODE_FACE;
			const goalsRaw = react.useSyncExternalStore(goalsFace.subscribe, goalsFace.getSnapshot);
			const running = countRunningGoals(goalsRaw);
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
			if (pulsing) ensurePillPulseStyle();
			const dotColor = !state.ready ? MODE_OFF_COLOR : (state.effective ? MODE_ON_COLOR : MODE_OFF_COLOR);
			const disabled = !execute || busy || !state.ready;
			return jsx.jsxs('button', {
				type: 'button',
				'aria-label': tip.replace('\n', ' '),
				title: tip,
				disabled,
				onClick: toggle,
				style: { ...modeIndicatorStyles.pill, ...(!state.ready ? modeIndicatorStyles.pillUnknown : {}) },
				children: [
					jsx.jsx('span', {
						className: pulsing ? 'dsh-cybernetics-pill-dot-running' : undefined,
						style: { ...modeIndicatorStyles.dot, background: dotColor },
					}),
					jsx.jsx('span', { children: t('mode.pill') + ' ' + (!state.ready ? t('mode.state.unknown') : (state.effective ? t('mode.state.on') : t('mode.state.off'))) }),
				],
			});
		}

		// The composer dock hint bar: rendered ONLY while the orchestration mode
		// is effective in this session; the wording follows the volatile
		// inputPolicy (insert → outer-loop insertion; queue → native queuing).
		function ComposerHint(props) {
			const t = props.t;
			const face = props.mode || NO_MODE_FACE;
			const raw = react.useSyncExternalStore(face.subscribe, face.getSnapshot);
			const cfgForm = props.config;
			const cfgSnap = react.useSyncExternalStore(
				liveConfigForm(cfgForm) ? (cb) => cfgForm.subscribe(cb) : noopSubscribe,
				liveConfigForm(cfgForm) ? () => cfgForm.getSnapshot() : () => NO_FORM_SNAP,
			);
			const state = readModeState(raw, cfgSnap);
			if (!state.ready || state.effective !== true) return null;
			return jsx.jsxs('div', {
				role: 'note',
				'data-cybernetics-hint': '',
				style: modeIndicatorStyles.hint,
				children: [
					jsx.jsx('span', { style: modeIndicatorStyles.hintDot }),
					jsx.jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' }, children: t(state.policy === 'queue' ? 'hint.queue' : 'hint.insert') }),
				],
			});
		}
		//#endregion

		//#region plugin apply
		const name = 'dsh-cybernetics';
		// configForms: the per-entry ConfigForm registry (@deepseek-ai/dsh-client-ui-settings)
		// that backs the plugins-page settings card below.
		const inject = ['slots', 'sessions', 'locale', 'configForms',
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
					// v0.6: both faces. `cyberneticsGoals` carries the whole goal
					// board (live, pushed by the host); `goal` stays as the
					// backward-compatible fallback for older plugin/host builds.
					return {
						goals: binding.session.projections.faceOf('cyberneticsGoals'),
						goal: binding.session.projections.faceOf('goal'),
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
					return { sessionId, sessions: ctx.sessions, goals };
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
					// v0.12.0: the goal-board face for the pill's running pulse.
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

		module.exports = { name, inject, apply, countRunningGoals };
		return module.exports;
	},
});
