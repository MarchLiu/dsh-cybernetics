// dsh-cybernetics client module: the「目标 / Goal」conversation tab, the
//「控制」tab, and (v0.7.2+, fixed in v0.7.3) the allGoalsMode settings card
// seated on the official Plugins page (plugins.item / plugins.row.config /
// plugins.bundle.config, bound to the row's ConfigForm in either of the two
// shapes the seats deliver — volatile writes stay live without a restart).
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
			'settings.cardLabel': 'Cybernetics 编排循环',
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
			card: { display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' },
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
		};

		/**
		 * One boolean settings row; shared by all three seats. Two form shapes
		 * reach it, and the card must speak both:
		 *  - the LIVE ConfigForm this module injects (ctx.configForms.get):
		 *    getSnapshot / subscribe / set — the only shape on the
		 *    plugins.bundle.config page and in summary rows, whose owners pass
		 *    no form of their own;
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
			const on = snap.status === 'ready' && snap.value != null && snap.value.allGoalsMode === true;
			const disabled = (live === undefined && host === undefined) || snap.status !== 'ready' || snap.writable === false || saving;

			const toggle = () => {
				if (disabled) return;
				setSaving(true);
				setFailed(false);
				// Both write paths land in the same host mutation: ConfigForm.set
				// is one-field sugar over ConfigForm.mutate, and the host's
				// ConfigPageForm.mutate IS that form's mutate (the expected
				// revision carried explicitly). The host commits the write into
				// the running plugin instance (volatile) and the next snapshot /
				// page render pushes the accepted value back here.
				// Failure policy (v0.7.4): the transport can REFUSE (settles
				// false) or stall (the observed "保存中" hang). Neither is
				// silent: a refused write shows saveFailed for a few seconds,
				// and a stalled write releases the switch after 15 s with the
				// same hint — the switch always returns to the snapshot value,
				// which is the only state the host confirmed.
				// v0.7.6: a refused write is retried ONCE through the direct
				// settings transport (props.directMutate, no expectedRevision).
				// Same落点 (user patch row via configEditor), unconditional
				// revision — a stale-revision conflict therefore heals, and any
				// remaining refusal reports its host message verbatim.
				let settled = false;
				const finish = (ok, detail) => {
					if (settled) return;
					settled = true;
					setSaving(false);
					if (!ok) {
						setFailed(detail || true);
						setTimeout(() => setFailed(false), 6000);
					}
				};
				const guard = setTimeout(() => finish(false), 15000);
				const op = { op: 'set', path: ['allGoalsMode'], value: !on };
				const write = live !== undefined
					? live.set('allGoalsMode', !on)
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

			if (view === 'summary') {
				return jsx.jsx('span', { children: snap.status === 'ready' ? t(on ? 'settings.summaryOn' : 'settings.summaryOff') : t('settings.unavailable') });
			}

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
				snap.status !== 'ready' ? jsx.jsx('div', { style: settingsStyles.unavailable, children: t('settings.unavailable') }) : null,
				saving ? jsx.jsx('div', { style: settingsStyles.unavailable, children: t('settings.saving') }) : null,
				!saving && failed ? jsx.jsx('div', { style: { ...settingsStyles.unavailable, color: '#d29922' }, children: failed === true ? t('settings.saveFailed') : t('settings.saveFailedDetail', { message: failed }) }) : null,
			] });
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
			'remote', 'remote.settings'];

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
			const settingsInject = () => ({ form: settingsForm, directMutate: settingsDirectMutate });
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
		}
		//#endregion

		module.exports = { name, inject, apply };
		return module.exports;
	},
});
