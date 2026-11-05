// Offline verification for the v0.14 settings-card reasoning-effort selects.
// Runs against ../lib/client.js (the staged patched copy) via the same
// ModuleLoader harness the plugin suite uses. No React DOM — jsx stubs.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

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
const writes = []
const cfgValue = {
  allGoalsMode: false,
  taskAgentModel: 'zai-coding-cn/glm-5.3', verifyAgentModel: 'no-effort-model', triageAgentModel: 'zai-coding-cn/glm-5.3',
  taskAgentReasoningEffort: 'high', verifyAgentReasoningEffort: '', triageAgentReasoningEffort: 'bogus-level',
}
const form = {
  subscribe: () => () => {},
  getSnapshot: () => ({ status: 'ready', writable: true, revision: 1, value: cfgValue }),
  set: (f, v) => { writes.push(['set', f, v]); return Promise.resolve(true) },
  unset: (f) => { writes.push(['unset', f]); return Promise.resolve(true) },
  mutate: () => Promise.resolve(true),
}
const efforts = [
  { id: 'off', name: 'off' },
  { id: 'low', name: '低' },
  { id: 'high', name: '高' },
]
const catalogSnap = {
  status: 'ready',
  options: [
    { value: 'zai-coding-cn/glm-5.3', provider: 'zai-coding-cn', model: 'glm-5.3', label: 'l1', reasoning: { efforts, defaultEffort: 'medium' } },
    { value: 'p/no-effort-model', provider: 'p', model: 'no-effort-model', label: 'l2' },
  ],
}
const catalog = { subscribe: () => () => {}, getSnapshot: () => catalogSnap }

const mod = loaded.factory((req) => (req === 'react' ? react : jsx))
const registered = []
const t = (key, params) => key + (params && params.value !== undefined ? ':' + params.value : '')
mod.apply({
  effect: (fn) => fn(),
  locale: { register: () => () => {}, bind: () => t },
  slots: { inject: (_n, cb) => cb(), register: (spec, view) => { registered.push({ spec, view }) } },
  sessions: {},
  configForms: { get: () => form, whileServed: (_ns, register) => { register(new Set()); return () => {} } },
})
const seat = registered.find((e) => e.spec.name === 'plugins.item')
assert.ok(seat, 'settings seat registered')
const flatten = (node, out = []) => {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
  if (node.props && node.props.children !== undefined) flatten(node.props.children, out)
  return out
}
const walk = (node, fn) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) walk(n, fn); return }
  fn(node)
  if (node.props && node.props.children !== undefined) walk(node.props.children, fn)
}
const face = { t, form, catalog, view: 'page' }
const render = () => { slotIndex = 0; return seat.view(face) }
const findSelect = (label) => {
  let hit
  walk(render(), (n) => { if (n.type === 'select' && n.props['aria-label'] === label) hit = n })
  return hit
}
const optionValues = (sel) => sel.props.children.filter((o) => o.type === 'option').map((o) => o.props.value)

// 1. model with efforts → enabled select, options = default + efforts, shows stored id
const task = findSelect('settings.taskAgentEffort')
assert.ok(task, 'task effort select rendered')
assert.equal(task.props.disabled, false, 'select enabled for model with efforts')
assert.deepEqual(optionValues(task), ['', 'off', 'low', 'high'], 'options = model default + efforts in catalog order')
assert.equal(task.props.value, 'high', 'stored effort id is the current selection')
const taskText = flatten(render()).join('\n')
assert.ok(taskText.includes('settings.effortDefault') && taskText.includes('(medium)'), 'default option names the model defaultEffort')

// 2. pick an effort → writes the string via the shared volatile path
task.props.onChange({ target: { value: 'low' } })
assert.deepEqual(writes.at(-1), ['set', 'taskAgentReasoningEffort', 'low'], 'picking a level writes a set op')

// 3. pick 跟随模型默认 → unset op (no parameter sent)
task.props.onChange({ target: { value: '' } })
assert.deepEqual(writes.at(-1), ['unset', 'taskAgentReasoningEffort'], 'empty selection writes an unset op')

// drain the write promises so the fake-react saving state settles
await new Promise((r) => setTimeout(r, 0))
await new Promise((r) => setTimeout(r, 0))

// 4. model without reasoning capability → disabled select + unsupported note, never an empty dropdown
const verify = findSelect('settings.verifyAgentEffort')
assert.ok(verify, 'verify effort select rendered')
assert.equal(verify.props.disabled, true, 'select disabled for a model without efforts')
assert.equal(optionValues(verify).length >= 1, true, 'disabled select still has the default option (no empty dropdown)')
assert.ok(flatten(render()).join('\n').includes('settings.effortUnsupported'), 'unsupported-model note shown')

// 5. stored id not offered by the model (枚举变化) → effective display = model default + fallback note
const triage = findSelect('settings.triageAgentEffort')
// triage model is valid with efforts, but the stored id is not offered →
// select enabled, effective selection = model default, fallback note shown
assert.equal(triage.props.disabled, false, 'select enabled for a catalog model with efforts')
const triageText = flatten(render()).join('\n')
assert.ok(triageText.includes('settings.effortFallback:bogus-level'), 'invalid stored id surfaces the fallback note with its value')
assert.equal(triage.props.value, '', 'effective selection falls back to the model default entry, no crash')

console.log('ALL effort-row CHECKS PASSED (7 assertions groups, incl. dynamic options / unsupported / fallback / write paths)')
