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
//   (3) a model without reasoning renders disabled + the unsupported note —
//       never an empty dropdown, never a throw;
//   (4) a stored level the model no longer offers shows the EFFECTIVE value
//       ('' = model default) plus the fallback note, without rewriting config;
//   (5) layout: each agent's model + effort pair sits under its own group
//       header (Task → Verify → Triage), zh/en locale keys complete.
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
        ],
      },
      {
        id: 'deepseek', name: 'DeepSeek',
        models: [{ id: 'no-effort-model', name: 'No Effort Model' }],
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

// (3) Model without reasoning: disabled + unsupported note, no throw.
{
  const h = await loadHarness()
  const face = { form: formOf(baseConfig({ triageAgentModel: 'deepseek/no-effort-model' })) }
  const select = h.findSelect(face, 'settings.triageAgentEffort')
  assert.ok(select, 'triage effort select rendered')
  assert.equal(select.props.disabled, true, 'select disabled without reasoning metadata')
  assert.equal(select.props.children.length, 1, 'no phantom level options (default-only)')
  assert.ok(h.flatten(h.render(face)).join('\n').includes('该模型不支持思考强度'), 'unsupported note shown')
  console.log('✓ v15 (3) effort-less model → disabled select + 该模型不支持思考强度, no error')
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
  console.log('✓ v15 (5) per-agent groups Task/Verify/Triage with adjacent model+effort, zh/en keys complete')
}

console.log('✓ v15-effort-reasoning: all checks passed')
