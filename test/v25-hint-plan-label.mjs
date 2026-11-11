// Offline harness test for dsh-cybernetics v0.25.3: the composer hint bar's
// parenthesized label「控制模式({stopped}/{total})({plan})」. Covers:
//   - resolvePlanName: the active agent-preset display name across real /
//     malformed ConfigForm snapshot shapes (unset → 未命名; built-in vendor
//     id → localized label; custom:<id> → saved preset name; dangling
//     custom id → 未命名; corrupt customPresets JSON → 未命名),
//   - locale dictionaries carry the bilingual hintCounts + plan.unnamed keys.
// Run: node test/v25-hint-plan-label.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ModuleLoader harness, same shape test/v12-mode-pill-running.mjs uses.
globalThis.window = globalThis.window || {}
let factoryResult
globalThis.window.__ModuleLoader__ = {
  load(def) {
    const require = (id) => {
      if (id === 'react') return { useState: () => [undefined, () => {}], useEffect: () => {}, useSyncExternalStore: () => undefined }
if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: null }
      throw new Error('unexpected require: ' + id)
    }
    factoryResult = def.factory(require)
  },
}
await import('../lib/client.js')

// Bilingual translator over the plugin's registered dictionaries: pull the
// zh/en dicts straight out of the bundle source (they are inline object
// literals), falling back to the key itself.
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
function dictOf(localeMark) {
  const marker = localeMark === 'zh' ? "'settings.preset.optAuto': '根据现有配置自动推荐'" : "'settings.preset.optAuto': 'Auto-recommend from current config'"
  const at = source.indexOf(marker)
  assert.ok(at > 0, localeMark + ' dict found in bundle source')
  return { at }
}
dictOf('zh'); dictOf('en') // both dictionaries present
function t(key, params) {
  const lines = source.split('\n')
  const needle = "'" + key + "': '"
  for (const line of lines) {
    const at = line.indexOf(needle)
    if (at >= 0) {
      let value = line.slice(at + needle.length)
      const end = value.lastIndexOf("',")
      value = end >= 0 ? value.slice(0, end) : value
      return value.replace(/\{(\w+)\}/g, (_, k) => (params && params[k] !== undefined ? String(params[k]) : '{' + k + '}'))
    }
  }
  return key
}

// --- 1. resolvePlanName: real / malformed ConfigForm snapshot shapes ---------
{
  const resolvePlanName = factoryResult.resolvePlanName
  assert.equal(typeof resolvePlanName, 'function', 'resolvePlanName exported from client bundle')

  const UNNAMED = '未命名'

  // Unset / malformed snapshots → 未命名, never throw.
  assert.equal(resolvePlanName(undefined, t), UNNAMED, 'no config form snapshot')
  assert.equal(resolvePlanName(null, t), UNNAMED, 'null snapshot')
  assert.equal(resolvePlanName('garbage', t), UNNAMED, 'non-object snapshot')
  assert.equal(resolvePlanName({ status: 'idle' }, t), UNNAMED, 'not-ready snapshot')
  assert.equal(resolvePlanName({ status: 'ready', value: {} }, t), UNNAMED, 'ready, empty value')
  assert.equal(resolvePlanName({ status: 'ready', value: { presetPlan: '' } }, t), UNNAMED, 'unset plan (empty selector)')

  // Built-in vendor preset id → localized label.
  assert.equal(resolvePlanName({ status: 'ready', value: { presetPlan: 'glm' } }, t), t('settings.preset.optGlm'), 'builtin glm label')
  assert.equal(resolvePlanName({ status: 'ready', value: { presetPlan: 'builtin-deepseek-fast' } }, t), t('settings.preset.optBuiltinDeepseekFast'), 'builtin fast label')

  // Custom preset → saved display name.
  const customs = JSON.stringify([{ id: 'p1', name: ' 我的方案 ' }, { id: 'p2', name: '备选' }])
  assert.equal(resolvePlanName({ status: 'ready', value: { presetPlan: 'custom:p1', customPresets: customs } }, t), '我的方案', 'custom name (trimmed)')
  assert.equal(resolvePlanName({ status: 'ready', value: { presetPlan: 'custom:p2', customPresets: customs } }, t), '备选', 'second custom name')

  // Degradations → 未命名, never throw.
  assert.equal(resolvePlanName({ status: 'ready', value: { presetPlan: 'custom:gone', customPresets: customs } }, t), UNNAMED, 'dangling custom id')
  assert.equal(resolvePlanName({ status: 'ready', value: { presetPlan: 'custom:p1', customPresets: '{broken' } }, t), UNNAMED, 'corrupt customPresets JSON')
  assert.equal(resolvePlanName({ status: 'ready', value: { presetPlan: 'custom:p1' } }, t), UNNAMED, 'missing customPresets field')
  assert.equal(resolvePlanName({ status: 'ready', value: { presetPlan: 'never-heard-of' } }, t), 'never-heard-of', 'unknown non-custom id surfaces raw selector')

  console.log('✓ 1 resolvePlanName: unset/builtin/custom/dangling/corrupt shapes')
}

// --- 2. locale parity: hintCounts + plan.unnamed in both dictionaries --------
{
  for (const key of ["'mode.hintCounts':", "'mode.plan.unnamed':"]) {
    const hits = source.split(key).length - 1
    assert.equal(hits, 2, 'dict entry ' + key + ' present in zh AND en dicts (found ' + hits + ')')
  }
  const zhFormat = source.match(/'mode\.hintCounts': '([^']+)'/)[1]
  assert.equal(zhFormat, '控制模式({stopped}/{total})({plan})', 'zh hintCounts uses the parenthesized () format')
  console.log('✓ 2 locale parity + format: 控制模式({stopped}/{total})({plan})')
}

// --- 3. composer hint bar renders the new label with the shared ring ----------
{
  // The ComposerHint span must consume mode.hintCounts (not the pill key)
  // and keep the breathing ring renderModeRing as its first child.
  const hintStart = source.indexOf('function ComposerHint')
  const hintRegion = source.slice(hintStart, source.indexOf('#endregion', hintStart))
  assert.ok(hintRegion.includes("t('mode.hintCounts'"), 'ComposerHint uses mode.hintCounts')
  assert.ok(hintRegion.includes('resolvePlanName(cfgSnap, t)'), 'ComposerHint resolves the plan name from the live config snapshot')
  assert.ok(hintRegion.includes('renderModeRing('), 'ComposerHint keeps the breathing ring indicator')
  assert.ok(!hintRegion.includes("t('mode.pillCounts'"), 'ComposerHint no longer reuses the pill label key')
  console.log('✓ 3 ComposerHint renders ring + parenthesized hintCounts label')
}

console.log('\nAll v0.25.3 hint-plan-label checks passed.')
