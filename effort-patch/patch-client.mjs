#!/usr/bin/env node
// Client-side patch: settings card reasoning-effort selects for
// @mars.liu/dsh-cybernetics (staged copy of lib/client.js).
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), 'stage')
const rel = 'dsh-cybernetics/lib/client.js'
const file = join(root, rel)
let text = readFileSync(file, 'utf8')
const pairs = [
  // 1. catalog store: keep each model's reasoning capability metadata
  {
    name: 'catalog store captures reasoning',
    from: `									options.push({
										value: group.id + '/' + model.id,
										provider: group.id,
										model: model.id,
										label: (group.name ?? group.id) + ' · ' + group.id + '/' + model.id,
									});`,
    to: `									options.push({
										value: group.id + '/' + model.id,
										provider: group.id,
										model: model.id,
										label: (group.name ?? group.id) + ' · ' + group.id + '/' + model.id,
										// v0.14: the model's reasoning-effort capability metadata
										// (efforts[] + defaultEffort) — the same session.modelCatalog
										// face the conversation model picker reads for its dynamic
										// effort menu; consumed by the settings card effort selects.
										reasoning: model.reasoning,
									});`,
  },
  // 2. helper next to isConfiguredModelAvailable
  {
    name: 'findCatalogModel helper',
    from: `			return catalogSnap.options.some((opt) => opt.model === text);
		}
		//#endregion`,
    to: `			return catalogSnap.options.some((opt) => opt.model === text);
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
		//#endregion`,
  },
  // 3. SETTINGS_FIELDS: effort row paired with each model row
  {
    name: 'SETTINGS_FIELDS effort entries',
    from: `			{ field: 'taskAgentModel', labelKey: 'settings.taskAgentModel', hintKey: 'settings.modelFieldHint', kind: 'model' },
			{ field: 'verifyAgentModel', labelKey: 'settings.verifyAgentModel', hintKey: 'settings.modelFieldHint', kind: 'model' },
			{ field: 'triageAgentModel', labelKey: 'settings.triageAgentModel', hintKey: 'settings.triageModelHint', kind: 'model' },`,
    to: `			{ field: 'taskAgentModel', labelKey: 'settings.taskAgentModel', hintKey: 'settings.modelFieldHint', kind: 'model' },
			// v0.14: reasoning-effort selects. Options resolve live from the model
			// configured on the paired model field (modelField → catalog entry →
			// reasoning.efforts); unsupported/no-model states disable with a hint,
			// invalid stored ids fall back to the model default for display.
			{ field: 'taskAgentReasoningEffort', modelField: 'taskAgentModel', labelKey: 'settings.taskAgentEffort', hintKey: 'settings.effortFieldHint', kind: 'effort' },
			{ field: 'verifyAgentModel', labelKey: 'settings.verifyAgentModel', hintKey: 'settings.modelFieldHint', kind: 'model' },
			{ field: 'verifyAgentReasoningEffort', modelField: 'verifyAgentModel', labelKey: 'settings.verifyAgentEffort', hintKey: 'settings.effortFieldHint', kind: 'effort' },
			{ field: 'triageAgentModel', labelKey: 'settings.triageAgentModel', hintKey: 'settings.triageModelHint', kind: 'model' },
			{ field: 'triageAgentReasoningEffort', modelField: 'triageAgentModel', labelKey: 'settings.triageAgentEffort', hintKey: 'settings.effortFieldHint', kind: 'effort' },`,
  },
  // 4. fieldRow dispatch
  {
    name: 'fieldRow effort dispatch',
    from: `				if (spec.kind === 'boolean') return booleanRow(spec);`,
    to: `				if (spec.kind === 'boolean') return booleanRow(spec);
				if (spec.kind === 'effort') return effortRow(spec);`,
  },
  // 5. effortRow implementation (before fieldRow)
  {
    name: 'effortRow implementation',
    from: `			const fieldRow = (spec) => {
				if (spec.kind === 'boolean') return booleanRow(spec);`,
    to: `			// v0.14: the reasoning-effort select for one sub agent. Options come
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
				if (spec.kind === 'boolean') return booleanRow(spec);`,
  },
  // 6. zh locale
  {
    name: 'zh locale effort keys',
    from: `			'settings.triageAgentModel': 'Triage agent 模型',
			'settings.triageModelHint': '可从下拉选择当前系统模型；点开输入框（聚焦）即可看到全部可选模型（已有值先收进占位符，离开且未改动不会保存）。也可手工输入「provider/model」或裸模型名；留空 = 与 session agent 一致（继承）。triage 角色读 task/verify 结果输出本轮收敛决策（met/continue/human-input 等），quick 轮不启用。回车或移开焦点即保存。',`,
    to: `			'settings.triageAgentModel': 'Triage agent 模型',
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
			'settings.effortCatalogLoading': '模型目录加载中，档位暂不可选。',`,
  },
  // 7. en locale
  {
    name: 'en locale effort keys',
    from: `			'settings.triageAgentModel': 'Triage agent model',
			'settings.triageModelHint': 'Pick from the dropdown of available system models; click into the input to see the whole list (an existing value is parked as the placeholder and restored on blur without saving). You can also type "provider/model" or a bare model name; empty = inherit the session agent. The triage role reads the task/verify results and emits the round\\'s convergence decision (met/continue/human-input/...); quick rounds never invoke it. Enter or blur saves.',`,
    to: `			'settings.triageAgentModel': 'Triage agent model',
			'settings.triageModelHint': 'Pick from the dropdown of available system models; click into the input to see the whole list (an existing value is parked as the placeholder and restored on blur without saving). You can also type "provider/model" or a bare model name; empty = inherit the session agent. The triage role reads the task/verify results and emits the round\\'s convergence decision (met/continue/human-input/...); quick rounds never invoke it. Enter or blur saves.',
			// v0.14: reasoning-effort selects (see zh for the rationale).
			'settings.taskAgentEffort': 'Task agent reasoning effort',
			'settings.verifyAgentEffort': 'Verify agent reasoning effort',
			'settings.triageAgentEffort': 'Triage agent reasoning effort',
			'settings.effortFieldHint': 'Effort levels resolve live from the model this sub agent uses (the same model-capability source the conversation model picker reads). "Model default" sends no effort parameter; the adapter applies its default. Saving takes effect on the next goal round.',
			'settings.effortDefault': 'Model default',
			'settings.effortUnsupported': 'This model provides no reasoning effort levels.',
			'settings.effortFallback': 'The configured effort "{value}" is not offered by the current model; the model default applies (pick a supported level and save to overwrite).',
			'settings.effortNeedsModel': 'No model configured for this sub agent (inheriting the session agent model) — pick a specific model above to choose an effort level.',
			'settings.effortCatalogLoading': 'Model catalog loading — effort levels are temporarily unavailable.',`,
  },
]
for (const { name, from, to } of pairs) {
  const count = text.split(from).length - 1
  if (count !== 1) throw new Error(`${rel}: pattern ${name} matched ${count}x (expected 1)`)
  text = text.replace(from, to)
}
writeFileSync(file, text)
console.log(`patched ${rel} (${pairs.length} replacements)`)
