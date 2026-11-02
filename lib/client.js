// dsh-cybernetics client module: the「目标 / Goal」conversation tab.
// Rendered from the session's `goal` projection (dsh-goal), pushed live by the
// host — no plugin HTTP route needed. Hand-written ModuleLoader wrapper, same
// format the host bundler emits (see dsh-context / dsh-maze client.js).
/* global window */
window.__ModuleLoader__.load({
	id: 'dsh-cybernetics',
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
		};
		//#endregion

		const PHASE_KEY = {
			active: 'phase.active',
			paused: 'phase.paused',
			blocked: 'phase.blocked',
			complete: 'phase.complete',
		};

		//#region goal view component
		// props.goal: ObservableSnapshot face of the session `goal` projection.
		// The snapshot may be the raw state ({current: GoalProjection | null, ...})
		// or the projection value itself — normalize both; undefined = not yet arrived.
		function GoalView(props) {
			const t = props.t;
			const raw = react.useSyncExternalStore(props.goal.subscribe, props.goal.getSnapshot);
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

		var styles = {
			root: { display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 16px', overflow: 'auto' },
			empty: { padding: '12px 16px', opacity: 0.6 },
			badgeRow: { display: 'flex', gap: 6 },
			badge: { fontSize: 12, padding: '1px 8px', borderRadius: 999, border: '1px solid currentColor' },
			objective: { whiteSpace: 'pre-wrap', lineHeight: 1.5, fontSize: 13 },
			blocked: { color: '#d29922', fontSize: 12 },
			meta: { opacity: 0.65, fontSize: 12 },
			hint: { opacity: 0.45, fontSize: 11 },
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
		// The「控制 / Control」tab: every agent of the current session — the lead
		// itself plus the subagent catalog (recursively) — with its run state and
		// its own durable goal (dsh-goal projection values). All reactive input
		// comes from the session list store, which the Session Controller updates
		// live via the control stream (running flips, goal/control frames).
		const MAX_TREE_DEPTH = 3;

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
			const agents = collectAgents(list, props.sessionId);
			const runningCount = agents.filter((a) => a.running).length;
			return jsx.jsxs('div', { style: styles.root, children: [
				jsx.jsxs('div', { style: styles.badgeRow, children: [
					jsx.jsx('span', { style: styles.badge, children: t('agents.count', { total: agents.length, running: runningCount }) }),
				] }),
				...agents.map((a) => jsx.jsx(AgentRow, { agent: a, t }, a.id + ':' + a.depth)),
				agents.length <= 1 ? jsx.jsx('div', { style: styles.hint, children: t('agents.empty') }) : null,
			] });
		}
		//#endregion

		//#region plugin apply
		const name = 'dsh-cybernetics';
		const inject = ['slots', 'sessions', 'locale'];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-cybernetics: dictionaries');
			const t = ctx.locale.bind(NS);

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
					return { goal: binding.session.projections.faceOf('goal') };
				},
			}, GoalView));

			// Control tab: goals + run states of every agent in this session,
			// driven by the session list store (live via the control stream).
			ctx.slots.inject('conversation.view', () => ctx.slots.register({
				name: 'conversation.view',
				id: 'cybernetics-control',
				order: 16,
				locale: NS,
				label: () => t('view.control'),
				inject: (sessionId) => ({ sessionId, sessions: ctx.sessions }),
			}, ControlView));
		}
		//#endregion

		module.exports = { name, inject, apply };
		return module.exports;
	},
});
