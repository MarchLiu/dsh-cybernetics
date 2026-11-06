// v0.15.1 offline tests: reasoning-effort capability source + per-agent layout.
//
// Defect 1 (capability source mismatch): the conversation model picker
// (dsh-client-ui-model-selection ModelCatalogDirectory) keys each model's
// reasoning metadata — { efforts: [{id, name}], defaultEffort } — per
// [group.id, model.id] from the SAME remote.session.modelCatalog() face the
// plugin reads. v0.15 dropped model.reasoning while flattening the catalog
// into dropdown options, so every model looked effort-less ("该模型不支持思考强度").
// These tests pin the fix end to end against a fixture shaped exactly like the
// picker's data source:
//   (1) the catalog store carries model.reasoning through to its options;
//   (2) a reasoning-capable model (glm-5.3-flash shape) lists its levels and
//       the select is enabled;
//   (3) v0.17.3: a model without reasoning levels — the user's REAL
//       ollama/qwen3.8:latest (cordis.patch.yml declares it with no
//       reasoningEfforts) plus the synthetic deepseek effort-less model —
//       stays SELECTABLE with the single 「跟随模型默认」 option and renders NO
//       unsupported warning — never an empty dropdown, never a throw; a stale
//       stored level renders NO note either (v0.17.3 follow-up: the model
//       declares no level, so there is nothing to fall back from — the user
//       reported the old fallback note on ollama + stored 'off' as pure noise);
//   (4) a stored level the model no longer offers shows the EFFECTIVE value
//       ('' = model default) plus the fallback note, without rewriting config.
//       The note is conditional on the model DECLARING levels: a pure-off model
//       with a token outside off/none still warns (genuine mismatch), an
//       effort-less model never does;
//   (5) layout: each agent's model + effort pair sits under its own group
//       header (Task → Verify → Triage), zh/en locale keys complete;
//   (6) v0.17.3: a "pure off" model (every level is off/none — a SYNTHETIC
//       shape under synthetic-off/off-only:latest; production currently has
//       no pure-off model) collapses into that same single default option — a
//       stored off id displays as the default, no warning, no write;
//   (7) v0.17.3: a model offering any real level (glm-5.3) keeps its off entry
//       and every other level — the dedupe never widens past the pure-off shape;
//   (8) the effort-patch table stays byte-synced: every lib/client.js anchor and
//       its applied-state marker (incl. the explicit `done` for the insertion
//       patch) exists verbatim, so `patch-v2 check` keeps skipping idempotently.
// No DSH runtime: lib/client.js is loaded verbatim like the ModuleLoader does,
// with stubbed react / react-jsx-runtime (same harness as test 68 of
// v03-offline.mjs).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Catalog fixture matching the real host shape (groups[].models[].reasoning).
const CATALOG_PAYLOAD = {
  ok: true,
  value: {
    groups: [
      {
        id: 'zai-coding-cn', name: 'Zai Coding CN',
        models: [
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'default', name: 'Default' }], defaultEffort: 'default' } },
          // v0.17.3: real levels + off — the off entry must be PRESERVED here.
          { id: 'glm-5.3', name: 'GLM 5.3', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'minimal', name: 'Minimal' }, { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'medium' } },
        ],
      },
      {
        id: 'deepseek', name: 'DeepSeek',
        models: [{ id: 'no-effort-model', name: 'No Effort Model' }],
      },
      {
        // synthetic pure-off shape — 生产当前没有纯 off 模型；纯 off 折叠逻辑是
        // 本轮新增的防御分支。 Production has NO pure-off model (cordis.patch.yml
        // declares reasoningEfforts only for other providers), so this collapse
        // coverage lives under its own synthetic group/model ids and must never
        // be re-pointed at a real model id. Mixed-case 'NONE' pins the
        // case-insensitive off/none detection.
        id: 'synthetic-off', name: 'Synthetic Off',
        models: [
          { id: 'off-only:latest', name: 'Off Only (latest)', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'NONE', name: 'None' }], defaultEffort: 'off' } },
        ],
      },
      {
        // The user's ACTUAL shape: cordis.patch.yml:552 sets
        // triageAgentModel: ollama/qwen3.8:latest while the ollama provider
        // declares qwen3.8:latest with NO reasoning metadata at all — this hits
        // the effort-less branch of (3)/(3b), never the pure-off branch.
        id: 'ollama', name: 'Ollama',
        models: [
          { id: 'qwen3.8:latest', name: 'Qwen3.8 27B (Ollama)' },
          { id: 'qwen3-vl:latest', name: 'Qwen3-VL 8B (Ollama)' },
        ],
      },
    ],
    failures: [],
  },
}

async function loadHarness() {
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded
  globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m } } }
  new Function('window', client)(globalThis.window)
  const jsx = {
    jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
    jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
  }
  const slotsMem = []
  let slotIndex = 0
  const react = {
    useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(),
    useState: (initial) => {
      const i = slotIndex++
      if (slotsMem[i] === undefined) {
        slotsMem[i] = { value: initial, set: (nv) => { slotsMem[i].value = typeof nv === 'function' ? nv(slotsMem[i].value) : nv } }
      }
      return [slotsMem[i].value, slotsMem[i].set]
    },
  }
  const mod = loaded.factory((req) => (req === 'react' ? react : jsx))
  const registered = []
  const dicts = {}
  let catalogCalls = 0
  const session = { modelCatalog: async () => { catalogCalls += 1; return CATALOG_PAYLOAD } }
  mod.apply({
    effect: (fn) => fn(),
    locale: {
      register: (_ns, dictionaries) => { Object.assign(dicts, dictionaries) },
      bind: () => (key, params) => {
        let text = dicts.zh?.[key] ?? key
        if (params) for (const name of Object.keys(params)) text = text.replaceAll('{' + name + '}', String(params[name]))
        return text
      },
    },
    slots: { inject: (_n, cb) => cb(), register: (spec, view) => { registered.push({ spec, view }) } },
    sessions: {},
    remote: { $on: () => {}, session },
    configForms: { get: () => undefined, whileServed: (_ns, register) => { register(new Set()); return () => {} } },
  })
  // The catalog load is async: let the store's load() promise settle.
  await new Promise((resolve) => setImmediate(resolve))
  const seat = registered.find((e) => e.spec.name === 'plugins.item')
  assert.ok(seat, 'plugins.item seat registered')
  const catalogStore = seat.spec.inject().catalog
  assert.ok(catalogStore && typeof catalogStore.getSnapshot === 'function', 'seat inject exposes the shared catalog store')

  const walk = (node, fn) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const n of node) walk(n, fn); return }
    fn(node)
    if (node.props && node.props.children !== undefined) walk(node.props.children, fn)
  }
  const flatten = (node, out = []) => {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
    if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
    if (node.type === 'function') { flatten(node.type(node.props), out); return out }
    if (node.props && node.props.children !== undefined) flatten(node.props.children, out)
    return out
  }
  const t = (key, params) => {
    let text = dicts.zh?.[key] ?? key
    if (params) for (const name of Object.keys(params)) text = text.replaceAll('{' + name + '}', String(params[name]))
    return text
  }
  const render = (face) => { slotIndex = 0; return seat.view({ view: 'page', t, catalog: catalogStore, ...face }) }
  const findSelect = (face, labelKey) => {
    const label = t(labelKey)
    let hit
    walk(render(face), (n) => { if (n.type === 'select' && n.props && n.props['aria-label'] === label) hit = n })
    return hit
  }
  return { dicts, t, render, flatten, walk, findSelect, catalogStore, catalogCalls: () => catalogCalls }
}

const baseConfig = (extra) => ({
  status: 'ready', writable: true,
  value: { allGoalsMode: false, taskAgentModel: '', verifyAgentModel: '', triageAgentModel: '', roundsPerSubgoal: 3, maxConcurrentRounds: 0, ...extra },
})
const formOf = (snap, hooks = {}) => ({
  getSnapshot: () => snap,
  subscribe: () => () => {},
  set: hooks.set ?? (async () => true),
  unset: hooks.unset ?? (async () => true),
  mutate: async () => true,
})

// (1) The store carries model.reasoning through (defect-1 fix at the source).
{
  const h = await loadHarness()
  const snap = h.catalogStore.getSnapshot()
  assert.equal(snap.status, 'ready', 'catalog loaded at apply time')
  assert.equal(h.catalogCalls(), 1, 'exactly one modelCatalog fetch')
  const glm = snap.options.find((o) => o.value === 'zai-coding-cn/glm-5.3-flash')
  assert.ok(glm, 'glm option present')
  assert.ok(glm.reasoning && Array.isArray(glm.reasoning.efforts) && glm.reasoning.efforts.length === 2
    && glm.reasoning.defaultEffort === 'default', 'store option carries the model reasoning metadata verbatim')
  const bare = snap.options.find((o) => o.model === 'glm-5.3-flash')
  assert.ok(bare && bare.reasoning, 'bare-name match resolves the same reasoning-bearing option')
  const noEffort = snap.options.find((o) => o.value === 'deepseek/no-effort-model')
  assert.equal(noEffort.reasoning, undefined, 'model without reasoning keeps reasoning undefined')
  const qwen = snap.options.find((o) => o.value === 'ollama/qwen3.8:latest')
  assert.ok(qwen, 'ollama/qwen3.8:latest option present (the real triageAgentModel from cordis.patch.yml:552)')
  assert.equal(qwen.reasoning, undefined, 'real ollama/qwen3.8:latest keeps reasoning undefined — production declares no reasoningEfforts for ollama')
  const qwenVl = snap.options.find((o) => o.value === 'ollama/qwen3-vl:latest')
  assert.ok(qwenVl && qwenVl.reasoning === undefined, 'ollama/qwen3-vl:latest present and equally effort-less')
  console.log('✓ v15 (1) catalog store passes model.reasoning through (picker-shaped fixture)')
}

// (2) Reasoning-capable model: effort select enabled, lists every level.
{
  const h = await loadHarness()
  const face = { form: formOf(baseConfig({ taskAgentModel: 'zai-coding-cn/glm-5.3-flash' })) }
  const select = h.findSelect(face, 'settings.taskAgentEffort')
  assert.ok(select, 'task effort select rendered')
  assert.equal(select.props.disabled, false, 'select enabled for a reasoning-capable model')
  const options = select.props.children
  assert.equal(options.length, 3, 'default option + two model levels')
  assert.equal(options[0].props.value, '', 'first option is 跟随模型默认')
  assert.match(String(options[0].props.children), /default/, 'default option shows the model defaultEffort id')
  assert.deepEqual(options.slice(1).map((o) => o.props.value), ['high', 'default'], 'level ids listed verbatim')
  assert.ok(!h.flatten(h.render(face)).join('\n').includes('不支持思考强度'), 'no unsupported note for a capable model')
  console.log('✓ v15 (2) glm-5.3-flash lists high/default levels, select enabled')
}

// (3) v0.17.3: model without reasoning levels — the select stays ENABLED with
//     the single 「跟随模型默认」 option and renders NO unsupported warning.
//     「跟随模型默认」 = send no strength parameter, which is exactly what such
//     a model wants; disabling it or warning was the reported defect.
//     Regression core: triageAgentModel='ollama/qwen3.8:latest' is the user's
//     verbatim config (cordis.patch.yml:552); the synthetic deepseek
//     effort-less model keeps the generic coverage alongside it.
{
  const h = await loadHarness()
  for (const model of ['ollama/qwen3.8:latest', 'deepseek/no-effort-model']) {
    const unsets = []
    const sets = []
    const face = {
      form: formOf(baseConfig({ triageAgentModel: model }), {
        unset: async (field) => { unsets.push(field); return true },
        set: async (field, value) => { sets.push([field, value]); return true },
      }),
    }
    const select = h.findSelect(face, 'settings.triageAgentEffort')
    assert.ok(select, `triage effort select rendered (${model})`)
    assert.equal(select.props.disabled, false, `select ENABLED without reasoning metadata (v0.17.3, ${model})`)
    assert.equal(select.props.children.length, 1, `no phantom level options (default-only, ${model})`)
    assert.equal(select.props.children[0].props.value, '', `the single option is 跟随模型默认 (value '', ${model})`)
    const text = h.flatten(h.render(face)).join('\n')
    assert.ok(!text.includes('该模型不支持思考强度'), `no unsupported warning for an effort-less model (${model})`)
    assert.ok(!text.includes('不在当前模型支持列表'), `stored value is empty → no fallback note either (${model})`)
    assert.equal(unsets.length, 0, `rendering performs no silent write (${model})`)
    // The option is selectable: picking it is the shared volatile unset write.
    select.props.onChange({ target: { value: '' } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unsets, ['triageAgentReasoningEffort'], `choosing 跟随模型默认 writes the volatile unset op (${model})`)
    assert.equal(sets.length, 0, `no concrete level is written (${model})`)
  }
  console.log('✓ v15 (3) effort-less model → enabled single 跟随模型默认 option, no warning, write works')
}

// (3b) v0.17.3 follow-up (user ruling): a stale concrete token on an
//      effort-less model renders NO note at all. The model sends no strength
//      parameter for ANY token, so displaying "配置的档位 off 不在当前模型支持
//      列表中" (the note the user saw on ollama/qwen3.8:latest + stored 'off')
//      was pure noise. Covered for the real ollama/qwen3.8:latest and the
//      synthetic deepseek model; the last case is the user's verbatim
//      production combo (triageAgentReasoningEffort: 'off').
{
  const h = await loadHarness()
  const cases = [
    { model: 'ollama/qwen3.8:latest', stored: 'high' },
    { model: 'deepseek/no-effort-model', stored: 'high' },
    { model: 'ollama/qwen3.8:latest', stored: 'off' }, // cordis.patch.yml:552 + :555 verbatim
  ]
  for (const { model, stored } of cases) {
    const unsets = []
    const sets = []
    const face = {
      form: formOf(baseConfig({ triageAgentModel: model, triageAgentReasoningEffort: stored }), {
        unset: async (field) => { unsets.push(field); return true },
        set: async (field, value) => { sets.push([field, value]); return true },
      }),
    }
    const select = h.findSelect(face, 'settings.triageAgentEffort')
    assert.equal(select.props.disabled, false, `still enabled (${model}, stored=${stored})`)
    assert.equal(select.props.children.length, 1, `still default-only (${model}, stored=${stored})`)
    assert.equal(select.props.value, '', `effective selection is the model default (${model}, stored=${stored})`)
    const text = h.flatten(h.render(face)).join('\n')
    assert.ok(!text.includes('不在当前模型支持列表'), `no fallback note for an effort-less model (${model}, stored=${stored})`)
    assert.ok(!text.includes(stored), `the unused stored token is not surfaced anywhere (${model}, stored=${stored})`)
    assert.ok(!text.includes('该模型不支持思考强度'), `the removed unsupported warning never renders (${model}, stored=${stored})`)
    assert.equal(unsets.length, 0, `no silent rewrite (${model}, stored=${stored})`)
    assert.equal(sets.length, 0, `no concrete level written either (${model}, stored=${stored})`)
  }
  console.log('✓ v15 (3b) stale token on effort-less model → no note at all, no unsupported warning')
}

// (3c) v0.17.3 follow-up scenario 4: a pure-off model DOES declare levels
//      (off/none) — just not 'high'. That stored token is a genuine mismatch,
//      so the fallback note must still render (only effort-less models lose
//      it). Same no-write policy; the effective selection stays the default.
{
  const h = await loadHarness()
  const unsets = []
  const sets = []
  const face = {
    form: formOf(baseConfig({ triageAgentModel: 'synthetic-off/off-only:latest', triageAgentReasoningEffort: 'high' }), {
      unset: async (field) => { unsets.push(field); return true },
      set: async (field, value) => { sets.push([field, value]); return true },
    }),
  }
  const select = h.findSelect(face, 'settings.triageAgentEffort')
  assert.ok(select, 'triage effort select rendered (pure-off model, stored=high)')
  assert.equal(select.props.disabled, false, 'still enabled (pure-off model is resolved)')
  assert.equal(select.props.children.length, 1, 'pure-off levels still collapse into the single default option')
  assert.equal(select.props.value, '', 'effective selection is the model default')
  const text = h.flatten(h.render(face)).join('\n')
  assert.ok(text.includes('不在当前模型支持列表') && text.includes('high'), 'fallback note survives for a token outside the declared off/none levels')
  assert.ok(!text.includes('该模型不支持思考强度'), 'no removed unsupported warning')
  assert.equal(unsets.length, 0, 'no silent unset rewrite')
  assert.equal(sets.length, 0, 'no silent concrete write')
  console.log('✓ v15 (3c) pure-off model + token outside off/none → fallback note still shown, config untouched')
}

// (4) Stored level the model no longer offers: effective value shown ('' =
//     model default) + fallback note; rendering never rewrites config.
{
  const h = await loadHarness()
  const unsets = []
  const face = {
    form: formOf(baseConfig({ taskAgentModel: 'zai-coding-cn/glm-5.3-flash', taskAgentReasoningEffort: 'bogus-level' }), {
      unset: async (field) => { unsets.push(field); return true },
    }),
  }
  const select = h.findSelect(face, 'settings.taskAgentEffort')
  assert.ok(select, 'task effort select rendered')
  assert.equal(select.props.disabled, false, 'still enabled (model supports levels)')
  assert.equal(select.props.value, '', 'select shows the EFFECTIVE value (model default), not the stale id')
  const text = h.flatten(h.render(face)).join('\n')
  assert.ok(text.includes('bogus-level'), 'fallback note names the stale stored value')
  assert.equal(unsets.length, 0, 'rendering performs no silent unset write')
  console.log('✓ v15 (4) stale stored level → effective default shown + fallback note, config untouched')
}

// (5) Layout: per-agent groups (Task → Verify → Triage), model+effort adjacent,
//     zh + en locale keys complete, header rows render between the pairs.
{
  const h = await loadHarness()
  assert.ok(h.dicts.zh && h.dicts.en, 'both locale dictionaries registered')
  for (const lang of ['zh', 'en']) {
    for (const key of ['settings.groupTask', 'settings.groupVerify', 'settings.groupTriage']) {
      assert.equal(typeof h.dicts[lang][key], 'string', `${lang} locale has ${key}`)
    }
    // v0.17.3: the removed "unsupported" warning must not linger in either
    // dictionary (it was the copy the user objected to).
    assert.equal(h.dicts[lang]['settings.effortUnsupported'], undefined, `${lang} locale no longer ships settings.effortUnsupported`)
  }
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const order = [
    client.indexOf("field: 'groupTask'"),
    client.indexOf("field: 'taskAgentModel'"),
    client.indexOf("field: 'taskAgentReasoningEffort'"),
    client.indexOf("field: 'groupVerify'"),
    client.indexOf("field: 'verifyAgentModel'"),
    client.indexOf("field: 'verifyAgentReasoningEffort'"),
    client.indexOf("field: 'groupTriage'"),
    client.indexOf("field: 'triageAgentModel'"),
    client.indexOf("field: 'triageAgentReasoningEffort'"),
  ]
  assert.ok(order.every((i) => i >= 0), 'all grouped fields present in SETTINGS_FIELDS')
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'field order is Task group → Verify group → Triage group (model paired with its effort)')
  const face = { form: formOf(baseConfig()) }
  const text = h.flatten(h.render(face)).join('\n')
  const positions = ['settings.groupTask', 'settings.taskAgentModel', 'settings.taskAgentEffort', 'settings.groupVerify', 'settings.verifyAgentModel', 'settings.verifyAgentEffort', 'settings.groupTriage', 'settings.triageAgentModel', 'settings.triageAgentEffort']
    .map((key) => text.indexOf(h.t(key)))
  assert.ok(positions.every((i) => i >= 0), 'all group/model/effort labels render')
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'rendered order matches the grouped layout')
  // v0.17.3: pre-existing disabling states are untouched. No model configured
  // (inherit the session agent) still disables with the needs-model hint.
  const noModelSelect = h.findSelect(face, 'settings.triageAgentEffort')
  assert.equal(noModelSelect.props.disabled, true, 'no model configured → select still disabled')
  assert.ok(text.includes(h.t('settings.effortNeedsModel')), 'no model configured → needs-model hint still rendered')
  // Global readonly (writable:false) still disables a resolved effort-less model.
  const readonlyFace = { form: formOf({ ...baseConfig({ triageAgentModel: 'deepseek/no-effort-model' }), writable: false }) }
  assert.equal(h.findSelect(readonlyFace, 'settings.triageAgentEffort').props.disabled, true, 'readonly config → select disabled regardless of model levels')
  const readonlyFaceQwen = { form: formOf({ ...baseConfig({ triageAgentModel: 'ollama/qwen3.8:latest' }), writable: false }) }
  assert.equal(h.findSelect(readonlyFaceQwen, 'settings.triageAgentEffort').props.disabled, true, 'readonly config → ollama/qwen3.8:latest (real user shape) stays disabled too')
  console.log('✓ v15 (5) per-agent groups Task/Verify/Triage with adjacent model+effort, zh/en keys complete')
}

// (6) v0.17.3: pure-off model (every level is off/none — SYNTHETIC shape
//     synthetic-off/off-only:latest; production currently has NO pure-off
//     model, so this is the defensive branch added this round, NOT the user's
//     qwen3.8 case — that one is effort-less and covered by (3)/(3b)). off IS
//     跟随模型默认 (both send nothing), so the list collapses to that single
//     option; a stored off/none id displays as the default with no warning and
//     no rewrite. Detection is case-insensitive on id AND name.
{
  const h = await loadHarness()
  for (const stored of ['', 'off', 'NONE']) {
    const unsets = []
    const face = {
      form: formOf(baseConfig({ triageAgentModel: 'synthetic-off/off-only:latest', triageAgentReasoningEffort: stored }), {
        unset: async (field) => { unsets.push(field); return true },
      }),
    }
    const select = h.findSelect(face, 'settings.triageAgentEffort')
    assert.ok(select, `triage effort select rendered (stored=${JSON.stringify(stored)})`)
    assert.equal(select.props.disabled, false, 'enabled (pure-off model is resolved and selectable)')
    assert.equal(select.props.children.length, 1, 'pure-off levels collapse into the single default option')
    assert.equal(select.props.children[0].props.value, '', 'the collapsed option is 跟随模型默认 (value \'\')')
    assert.equal(select.props.value, '', 'a stored off/none id is the SAME option → displays as the default')
    const text = h.flatten(h.render(face)).join('\n')
    assert.ok(!text.includes('该模型不支持思考强度'), 'no unsupported warning for a pure-off model')
    assert.ok(!text.includes('不在当前模型支持列表'), 'no fallback note: the stored off id is the collapsed option')
    assert.equal(unsets.length, 0, 'rendering performs no silent write for a stored off id')
  }
  console.log('✓ v15 (6) pure-off model → single 跟随模型默认 option, stored off/none reads as default, no warning')
}

// (7) v0.17.3 scope guard: a model with ANY real level (glm-5.3:
//     off/minimal/low/medium/high/max) keeps its off entry and every other
//     level, and a stored off stays a concrete selection. The dedupe must not
//     widen beyond the pure-off shape (user-confirmed scope).
{
  const h = await loadHarness()
  const face = { form: formOf(baseConfig({ taskAgentModel: 'zai-coding-cn/glm-5.3', taskAgentReasoningEffort: 'off' })) }
  const select = h.findSelect(face, 'settings.taskAgentEffort')
  assert.ok(select, 'task effort select rendered')
  assert.equal(select.props.disabled, false, 'enabled')
  const options = select.props.children
  assert.equal(options.length, 7, 'default option + all six real levels')
  assert.deepEqual(options.slice(1).map((o) => o.props.value), ['off', 'minimal', 'low', 'medium', 'high', 'max'], 'off is preserved alongside the real levels')
  assert.equal(select.props.value, 'off', 'a stored off stays a concrete selection (not collapsed)')
  const text = h.flatten(h.render(face)).join('\n')
  assert.ok(!text.includes('不在当前模型支持列表'), 'off is a valid level here → no fallback note')
  assert.ok(!text.includes('该模型不支持思考强度'), 'no unsupported warning')
  console.log('✓ v15 (7) model with real levels keeps off + all levels; stored off is not collapsed')
}

// (8) v0.17.3 patch-table sync guard: the effort-patch table must stay a
//     verbatim mirror of lib/client.js, otherwise a host upgrade re-patch would
//     either revert this change (locale/effort blocks) or duplicate effortRow
//     (the insertion patch reports ready when its `done` marker is missing).
//     Mirrors patch-v2.mjs's applied-state detection exactly.
{
  const { PATCHES } = await import('../effort-patch/patches.mjs')
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const effortPatches = PATCHES.filter((p) => p.file === 'lib/client.js'
    && (p.id === 'client:locale-zh-effort-strings'
      || p.id === 'client:locale-en-effort-strings'
      || p.id === 'client:find-catalog-model-helper'
      || p.id === 'client:effort-row-renderer'))
  assert.equal(effortPatches.length, 4, 'all four effort patches present in the table')
  for (const p of effortPatches) {
    const anchorCount = client.split(p.find).length - 1
    const doneText = p.done ?? (p.replace.startsWith(p.find) ? p.replace.slice(p.find.length) : p.replace)
    const doneCount = doneText === '' ? (anchorCount === 0 ? 1 : 0) : client.split(doneText).length - 1
    // Same tri-state as patch-v2.mjs: already-applied → SKIP; else the forward
    // anchor must occur exactly once or the runner FAILs.
    assert.ok(doneCount >= 1 || anchorCount === 1, `${p.id}: either applied-state marker present or exactly one forward anchor (never the runner's FAIL state)`)
    assert.ok(!p.replace.includes('settings.effortUnsupported'), `${p.id}: re-patching cannot resurrect the removed warning key`)
    assert.ok(!p.find.includes('settings.effortUnsupported'), `${p.id}: anchor contains no removed warning key`)
  }
  const effortRowPatch = PATCHES.find((p) => p.id === 'client:effort-row-renderer')
  assert.equal(typeof effortRowPatch.done, 'string', 'effortRow insertion patch carries an explicit done marker')
  console.log('✓ v15 (8) effort patch table is a verbatim mirror of lib/client.js (idempotent re-patch)')
}

console.log('✓ v15-effort-reasoning: all checks passed')
