// v0.15 reasoning-effort patch table — ANCHOR-BASED edits over the CURRENT
// checkout. Every entry is { file, id, find, replace }: `find` must occur
// EXACTLY ONCE in the current file text (uniqueness verified before any
// write), otherwise the whole patch run aborts. No whole-file overwrites.

// ---- lib/client.js effort segments (ported verbatim from the verified R1
// stage copy; anchors re-derived against the current checkout) ----

const CLIENT_LOCALES_ZH = `			// v0.15: reasoning-effort selects — options resolve live from the same
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
`

const CLIENT_LOCALES_EN = `			// v0.15: reasoning-effort selects (English locale); v0.17.3: a model
			// without levels stays selectable with only "Model default", no warning.
			'settings.taskAgentEffort': 'Task agent reasoning effort',
			'settings.verifyAgentEffort': 'Verify agent reasoning effort',
			'settings.triageAgentEffort': 'Triage agent reasoning effort',
			'settings.effortFieldHint': 'Effort levels resolve live from the model this sub agent uses (the same model-capability source the conversation model picker reads). "Model default" sends no effort parameter; the adapter applies its default. Saving takes effect on the next goal round.',
			'settings.effortDefault': 'Model default',
			'settings.effortFallback': 'The configured effort "{value}" is not offered by the current model; the model default applies (pick a supported level and save to overwrite).',
			'settings.effortNeedsModel': 'No model configured for this sub agent (inheriting the session agent model) — pick a specific model above to choose an effort level.',
			'settings.effortCatalogLoading': 'Model catalog loading — effort levels are temporarily unavailable.',
`

const CLIENT_FIELDS = `			// v0.15: reasoning-effort selects. Options resolve live from the model
			// configured on the paired model field (modelField → catalog entry →
			// reasoning.efforts); unsupported/no-model states disable with a hint,
			// invalid stored ids fall back to the model default for display.
			{ field: 'taskAgentReasoningEffort', modelField: 'taskAgentModel', labelKey: 'settings.taskAgentEffort', hintKey: 'settings.effortFieldHint', kind: 'effort' },
			{ field: 'verifyAgentReasoningEffort', modelField: 'verifyAgentModel', labelKey: 'settings.verifyAgentEffort', hintKey: 'settings.effortFieldHint', kind: 'effort' },
			{ field: 'triageAgentReasoningEffort', modelField: 'triageAgentModel', labelKey: 'settings.triageAgentEffort', hintKey: 'settings.effortFieldHint', kind: 'effort' },
`

// v0.15.1: the checkout's CURRENT grouped fields block, verbatim (the checkout
// moved to per-agent groups after R1 — group headers + paired model/effort
// rows). Used as the replacement target above so the already-applied state of
// the live checkout matches byte-for-byte.
const CLIENT_GROUPED_FIELDS = `			// v0.15.1: per-agent groups — the model field and its paired
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
`

const CLIENT_FIND_CATALOG_MODEL = `
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
`

// effortRow + the fieldRow kind hook, extracted verbatim from the verified R1 stage copy.
const CLIENT_EFFORT_ROW = `
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
`

// Locale anchor: the last zh triage hint line — insert the zh effort block after it.
const CLIENT_ANCHOR_LOCALE_ZH = `			'settings.triageModelHint': '可从下拉选择当前系统模型；点开输入框（聚焦）即可看到全部可选模型（已有值先收进占位符，离开且未改动不会保存）。也可手工输入「provider/model」或裸模型名；留空 = 与 session agent 一致（继承）。triage 角色读 task/verify 结果输出本轮收敛决策（met/continue/human-input 等），quick 轮不启用。回车或移开焦点即保存。',
`

// English locale anchor: verify the exact line from the current checkout at patch time.
const CLIENT_ANCHOR_LOCALE_EN = `			'settings.triageModelHint': 'Pick from the dropdown of available system models; click into the input to see the whole list (an existing value is parked as the placeholder and restored on blur without saving). You can also type "provider/model" or a bare model name; empty = inherit the session agent. The triage role reads the task/verify results and emits the round\\'s convergence decision (met/continue/human-input/...); quick rounds never invoke it. Enter or blur saves.',
`

export const PATCHES = [
  // ============ workflows/round.js ============
  {
    file: 'workflows/round.js',
    id: 'round:specFor-carries-effort',
    find: `const specFor = (key) => {
  const s = (roles ?? {})[key]
  return s && (s.provider || s.model)
    ? { ...(s.provider ? { provider: s.provider } : {}), ...(s.model ? { model: s.model } : {}) }
    : {}
}`,
    replace: `const specFor = (key) => {
  const s = (roles ?? {})[key]
  // v0.15: carry the per-role reasoning effort (role -> {reasoningEffort}) alongside
  // provider/model; an effort WITHOUT provider/model is valid — the agent keeps the
  // session model and only pins the effort level.
  return s && (s.provider || s.model || s.reasoningEffort)
    ? { ...(s.provider ? { provider: s.provider } : {}), ...(s.model ? { model: s.model } : {}), ...(s.reasoningEffort ? { reasoningEffort: s.reasoningEffort } : {}) }
    : {}
}`,
  },
  {
    file: 'workflows/round.js',
    id: 'round:overridden-includes-effort',
    find: `  const overridden = !!(spec.provider || spec.model)`,
    replace: `  const overridden = !!(spec.provider || spec.model || spec.reasoningEffort)`,
  },
  {
    file: 'workflows/round.js',
    id: 'round:specLabel-includes-effort',
    find: `const specLabel = (spec) => [spec.provider, spec.model].filter(Boolean).join('/')`,
    replace: `const specLabel = (spec) => [spec.provider, spec.model, spec.reasoningEffort].filter(Boolean).join('/')`,
  },
  {
    file: 'workflows/round.js',
    id: 'round:availability-pattern-effort',
    find: `  /rate.?limit|\\b429\\b|too many requests/i,                                      // 限流`,
    replace: `  // v0.15：配置的思考强度档位不被当前模型支持（provider 侧校验失败的典型报错形态）。
  // 命中即按可用性失败回退：以 session 模型 + 默认档位重试一次（callRoleAgent 的回退
  // 调用不携带 spec，天然不发送 reasoningEffort），并记入 fallbacks 审计。
  /reasoning.?effort|thinking.?effort|effort .*not supported|unsupported effort|invalid effort|unknown effort/i,
  /rate.?limit|\\b429\\b|too many requests/i,                                      // 限流`,
  },

  // ============ src/controller.ts ============
  {
    file: 'src/controller.ts',
    id: 'controller:rolespec-effort-field',
    find: `/** LLM target overrides for one sub-agent role; workflow \`agent()\` opts subset. */
export interface RoleSpec {
  provider?: string
  model?: string
}`,
    replace: `/** LLM target overrides for one sub-agent role; workflow \`agent()\` opts subset. */
export interface RoleSpec {
  provider?: string
  model?: string
  /**
   * v0.15: reasoning effort level id (e.g. 'high') passed through the workflow
   * agent() seam as \`reasoningEffort\`. Absent = model default (nothing sent).
   * Validity is model-dependent and cannot be checked here — the round script's
   * call-level fallback (v0.15 availability pattern) retries on the session
   * default when a provider rejects the level.
   */
  reasoningEffort?: string
}`,
  },
  {
    file: 'src/controller.ts',
    id: 'controller:sanitize-helper',
    find: `  return { model: raw }
}
`,
    replace: `  return { model: raw }
}

/**
 * v0.15: sanitize a stored reasoning-effort id before it reaches the round
 * script. A non-string / blank / oversized / non-token value is DROPPED
 * (undefined = send nothing = the model's default effort applies) instead of
 * being forwarded — a corrupted stored id must degrade to the default, never
 * poison the request. Token shape: letters/digits/._- up to 64 chars (ids the
 * model catalogs emit all match; anything looser is treated as corrupt).
 */
export function sanitizeReasoningEffort(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (!raw || raw.length > 64 || !/^[A-Za-z0-9._-]+$/.test(raw)) return undefined
  return raw
}
`,
  },

  // ============ src/index.ts ============
  {
    file: 'src/index.ts',
    id: 'index:import-sanitize',
    find: `  STATE_DIR, createGoal, decideAbort, foldRound, parseAgentModelSpec, runRound, startRound, supersedeGoal, writeRevisionLog,
} from './controller.ts'`,
    replace: `  STATE_DIR, createGoal, decideAbort, foldRound, parseAgentModelSpec, runRound, sanitizeReasoningEffort, startRound, supersedeGoal, writeRevisionLog,
} from './controller.ts'`,
  },
  {
    file: 'src/index.ts',
    id: 'index:config-interface-effort-fields',
    find: `  /** Flat triage-agent model override (same format); empty = inherit session agent. */
  triageAgentModel?: string`,
    replace: `  /** Flat triage-agent model override (same format); empty = inherit session agent. */
  triageAgentModel?: string
  /** v0.15: flat task-agent reasoning-effort id ('' = model default). Volatile. */
  taskAgentReasoningEffort?: string
  /** v0.15: flat verify-agent reasoning-effort id ('' = model default). Volatile. */
  verifyAgentReasoningEffort?: string
  /** v0.15: flat triage-agent reasoning-effort id ('' = model default). Volatile. */
  triageAgentReasoningEffort?: string`,
  },
  {
    file: 'src/index.ts',
    id: 'index:schema-effort-fields',
    find: `  triageAgentModel: z.string().default('').volatile().description('triage agent 模型覆盖（「provider/model」或裸模型名）；留空 = 与 session agent 一致。triage 角色读 task/verify 结果输出本轮收敛决策（met/continue/human-input 等）；quick 轮不启用。保存后下一轮 goal 即生效，无需重载。'),`,
    replace: `  triageAgentModel: z.string().default('').volatile().description('triage agent 模型覆盖（「provider/model」或裸模型名）；留空 = 与 session agent 一致。triage 角色读 task/verify 结果输出本轮收敛决策（met/continue/human-input 等）；quick 轮不启用。保存后下一轮 goal 即生效，无需重载。'),
  /**
   * v0.15: flat per-role reasoning-effort ids, one per sub agent. '' = follow
   * the model default (nothing sent). Volatile like the model fields — the
   * settings card renders a live dropdown from the paired model's catalog
   * reasoning.efforts; an unsupported/invalid stored id is sanitized away at
   * fold time (sanitizeReasoningEffort) and the runtime falls back to the
   * model default (recorded in the round's fallbacks audit on provider
   * rejection).
   */
  taskAgentReasoningEffort: z.string().default('').volatile().description('task agent 思考强度档位（留空 = 跟随模型默认）。档位列表随该 agent 所选模型动态给出；选择即保存，下一轮 goal 生效。'),
  verifyAgentReasoningEffort: z.string().default('').volatile().description('verify agent 思考强度档位（留空 = 跟随模型默认）。档位列表随该 agent 所选模型动态给出；选择即保存，下一轮 goal 生效。'),
  triageAgentReasoningEffort: z.string().default('').volatile().description('triage agent 思考强度档位（留空 = 跟随模型默认）。档位列表随该 agent 所选模型动态给出；选择即保存，下一轮 goal 生效。'),`,
  },
  {
    file: 'src/index.ts',
    id: 'index:fold-effort-attach',
    find: `      const triageSpec = parseAgentModelSpec(readConfigField(config.triageAgentModel, ''))
      if (triageSpec) roleOverrides.triage = { ...roleOverrides.triage, ...triageSpec }`,
    replace: `      const triageSpec = parseAgentModelSpec(readConfigField(config.triageAgentModel, ''))
      if (triageSpec) roleOverrides.triage = { ...roleOverrides.triage, ...triageSpec }
      // v0.15: flat reasoning-effort fields fold into the same roles shape.
      // sanitizeReasoningEffort DROPS an invalid stored id (undefined = send
      // nothing = the model default applies) instead of forwarding corrupt
      // values; the settings card mirrors this by displaying the effective
      // (default) selection with a fallback note.
      const taskEffort = sanitizeReasoningEffort(readConfigField(config.taskAgentReasoningEffort, ''))
      if (taskEffort) roleOverrides.default = { ...roleOverrides.default, reasoningEffort: taskEffort }
      const verifyEffort = sanitizeReasoningEffort(readConfigField(config.verifyAgentReasoningEffort, ''))
      if (verifyEffort) roleOverrides.verify = { ...roleOverrides.verify, reasoningEffort: verifyEffort }
      const triageEffort = sanitizeReasoningEffort(readConfigField(config.triageAgentReasoningEffort, ''))
      if (triageEffort) roleOverrides.triage = { ...roleOverrides.triage, reasoningEffort: triageEffort }`,
  },

  // ============ lib/client.js ============
  {
    file: 'lib/client.js',
    id: 'client:locale-zh-effort-strings',
    find: CLIENT_ANCHOR_LOCALE_ZH,
    replace: CLIENT_ANCHOR_LOCALE_ZH + CLIENT_LOCALES_ZH,
  },
  {
    file: 'lib/client.js',
    id: 'client:locale-en-effort-strings',
    find: CLIENT_ANCHOR_LOCALE_EN,
    replace: CLIENT_ANCHOR_LOCALE_EN + CLIENT_LOCALES_EN,
  },
  {
    // v0.15.1 recalibration: the checkout's fields array moved to the per-agent
    // group layout (groupTask/groupVerify/groupTriage headers, v0.15.1), so the
    // original triageAgentModel→roundsPerSubgoal adjacency no longer exists in
    // either the pre- or post-effort shapes. Forward anchor = the v0.14
    // three-contiguous-model-fields block (git HEAD 738-741); replacement =
    // the CURRENT checkout's grouped block verbatim, so on the current file the
    // runner detects "already applied" and on a v0.14 file it produces exactly
    // the grouped layout now in the checkout.
    file: 'lib/client.js',
    id: 'client:settings-fields-effort-entries',
    find: `			{ field: 'taskAgentModel', labelKey: 'settings.taskAgentModel', hintKey: 'settings.modelFieldHint', kind: 'model' },
			{ field: 'verifyAgentModel', labelKey: 'settings.verifyAgentModel', hintKey: 'settings.modelFieldHint', kind: 'model' },
			{ field: 'triageAgentModel', labelKey: 'settings.triageAgentModel', hintKey: 'settings.triageModelHint', kind: 'model' },
			{ field: 'roundsPerSubgoal', labelKey: 'settings.roundsPerSubgoal', hintKey: 'settings.roundsPerSubgoalHint', kind: 'number', min: 1 },`,
    replace: CLIENT_GROUPED_FIELDS,
  },
  {
    file: 'lib/client.js',
    id: 'client:find-catalog-model-helper',
    find: `			return catalogSnap.options.some((opt) => opt.model === text);
		}
		//#endregion`,
    replace: `			return catalogSnap.options.some((opt) => opt.model === text);
		}` + CLIENT_FIND_CATALOG_MODEL + `
		//#endregion`,
  },
  {
    file: 'lib/client.js',
    id: 'client:effort-row-renderer',
    done: CLIENT_EFFORT_ROW,
    find: `			const fieldRow = (spec) => {
				if (spec.kind === 'boolean') return booleanRow(spec);`,
    replace: CLIENT_EFFORT_ROW + `
			const fieldRow = (spec) => {
				if (spec.kind === 'boolean') return booleanRow(spec);
				// v0.15.1: per-agent group caption (Task / Verify / Triage) —
				// decorative, no write, still keyed for stable reconciliation.
				if (spec.kind === 'header') return jsx.jsx('div', {
					style: { fontSize: 12, fontWeight: 600, color: 'var(--dsh-text-secondary, #8b949e)', marginTop: 10, textTransform: 'uppercase', letterSpacing: 0.4 },
					children: t(spec.labelKey),
				}, spec.field);
				// v0.15: reasoning-effort select (catalog-driven, see effortRow above).
				if (spec.kind === 'effort') return effortRow(spec);`,
  },

  // ============ lib/client.js v0.15.1 refinements ============
  // The live checkout evolved past R1's v0.15 (per-agent group layout +
  // catalog reasoning-metadata fix). These entries make the forward path
  // HEAD → current byte-exact; the catalog `reasoning` passthrough is
  // FUNCTIONALLY REQUIRED — without it every model looks effort-less.
  {
    file: 'lib/client.js',
    id: 'client:locale-zh-group-headers',
    find: `			'settings.taskAgentModel': 'Task agent 模型',
`,
    replace: `			'settings.taskAgentModel': 'Task agent 模型',
			'settings.groupTask': 'Task agent · 模型与思考强度',
			'settings.groupVerify': 'Verify agent · 模型与思考强度',
			'settings.groupTriage': 'Triage agent · 模型与思考强度',
`,
  },
  {
    file: 'lib/client.js',
    id: 'client:locale-en-group-headers',
    find: `			'settings.taskAgentModel': 'Task agent model',
`,
    replace: `			'settings.taskAgentModel': 'Task agent model',
			'settings.groupTask': 'Task agent · model & reasoning effort',
			'settings.groupVerify': 'Verify agent · model & reasoning effort',
			'settings.groupTriage': 'Triage agent · model & reasoning effort',
`,
  },
  {
    file: 'lib/client.js',
    id: 'client:fields-comment-grouped',
    find: `		// hardGate (boolean toggle) / allGoalsMode-toggle header +
		// taskAgentModel / verifyAgentModel / triageAgentModel /
		// roundsPerSubgoal / maxConcurrentRounds.
`,
    replace: `		// hardGate (boolean toggle) / roundsPerSubgoal / maxConcurrentRounds.
		// v0.15.1: the three 「模型 + 思考强度」 pairs are grouped per sub agent
		// (Task → Verify → Triage) like the conversation composer's model
		// picker, each behind a small group header ('header' kind rows).
`,
  },
  {
    file: 'lib/client.js',
    id: 'client:drop-old-model-fields-comment',
    find: `			// v0.8.3: the three model fields are kind 'model' — datalist-backed
			// dropdown over the live host catalog, manual entry still accepted
			// (a datalist input is a free text input); invalid configured values
			// render the unavailable warning + a one-click clear.
`,
    replace: ``,
  },
  {
    file: 'lib/client.js',
    id: 'client:drop-stray-blank-line',
    find: `			{ field: 'roundsPerSubgoal', labelKey: 'settings.roundsPerSubgoal', hintKey: 'settings.roundsPerSubgoalHint', kind: 'number', min: 1 },

			{ field: 'maxConcurrentRounds', labelKey: 'settings.maxConcurrentRounds', hintKey: 'settings.maxConcurrentRoundsHint', kind: 'number', min: 0 },
`,
    replace: `			{ field: 'roundsPerSubgoal', labelKey: 'settings.roundsPerSubgoal', hintKey: 'settings.roundsPerSubgoalHint', kind: 'number', min: 1 },
			{ field: 'maxConcurrentRounds', labelKey: 'settings.maxConcurrentRounds', hintKey: 'settings.maxConcurrentRoundsHint', kind: 'number', min: 0 },
`,
  },
  {
    file: 'lib/client.js',
    id: 'client:catalog-doc-reasoning',
    find: `		// { ok, value: { groups: [{id, name, models: [{id, name}]}], failures } }
`,
    replace: `		// { ok, value: { groups: [{id, name, models: [{id, name, reasoning?}]}], failures } }
`,
  },
  {
    file: 'lib/client.js',
    id: 'client:catalog-reasoning-metadata',
    find: `								for (const model of (group.models ?? [])) {
									options.push({
										value: group.id + '/' + model.id,
										provider: group.id,
										model: model.id,
										label: (group.name ?? group.id) + ' · ' + group.id + '/' + model.id,
									});`,
    replace: `								for (const model of (group.models ?? [])) {
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
									});`,
  },
]
