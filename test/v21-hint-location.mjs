// Offline harness test for dsh-cybernetics v0.19.0: the status-indicator
// unification + the hintLocation setting. Covers:
//   - readHintLocation: the pure snapshot reader ('both'|'pill'|'composer'|
//     'none'), with loaded / not-loaded / old-host / garbage fallbacks,
//   - ComposerHint renders the shared pill ring +「控制模式：{stopped}/{total}」
//     label, keeps the insert/queue wording as tooltip, keeps role:'note' +
//     data-cybernetics-hint, and honors the hintLocation gate,
//   - ModePill honors the same gate ('none'/'composer' → hidden),
//   - the server schema (src/index.ts) declares the field with default
//     'both' (volatile), and the TS surface type carries it,
//   - the old 6px hintDot style is gone (both UIs share the ring now).
// Run: node test/v21-hint-location.mjs

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
      throw new Error('unexpected require: ' + id)
    }
    factoryResult = def.factory(require)
  },
}
await import('../lib/client.js')

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const schemaSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

// --- 1. readHintLocation: valid values + backward-compatible fallbacks -------
{
  const readHintLocation = factoryResult.readHintLocation
  assert.equal(typeof readHintLocation, 'function', 'readHintLocation exported from client bundle')

  const snap = (value) => ({ status: 'ready', value: { inputPolicy: 'insert', ...(value !== undefined ? { hintLocation: value } : {}) } })
  assert.equal(readHintLocation(snap('both')), 'both', 'both passes through')
  assert.equal(readHintLocation(snap('pill')), 'pill', 'pill passes through')
  assert.equal(readHintLocation(snap('composer')), 'composer', 'composer passes through')
  assert.equal(readHintLocation(snap('none')), 'none', 'none passes through')

  // Fallbacks — everything unknown degrades to 'both' (pre-v0.19.0 behavior).
  assert.equal(readHintLocation(snap(undefined)), 'both', 'old host: field absent → both')
  assert.equal(readHintLocation(undefined), 'both', 'config not loaded (undefined snapshot) → both')
  assert.equal(readHintLocation(null), 'both', 'null snapshot → both')
  assert.equal(readHintLocation({ status: 'loading', value: { hintLocation: 'none' } }), 'both', 'not-ready snapshot → both')
  assert.equal(readHintLocation({ status: 'ready', value: null }), 'both', 'ready with null value → both')
  assert.equal(readHintLocation({ status: 'ready', value: 'garbage' }), 'both', 'ready with non-object value → both')
  assert.equal(readHintLocation(snap('garbage')), 'both', 'garbage value → both')
  assert.equal(readHintLocation(snap('BOTH')), 'both', 'case-sensitive values: BOTH is not valid → both')
  console.log('✓ 1 readHintLocation: 4 valid values, not-loaded/old-host/garbage all fall back to both')
}

// --- 2. ComposerHint: pill-identical indicator + counts label, tooltip wording
{
  // Locate the ComposerHint function body.
  const fnStart = source.indexOf('function ComposerHint(')
  assert.ok(fnStart > 0, 'ComposerHint exists')
  const fn = source.slice(fnStart, source.indexOf('\t\t}\n', fnStart))

  // Same gate as before: only while effective === true.
  assert.ok(fn.includes('if (!state.ready || state.effective !== true) return null;'), 'composer hint still gated on ready + effective === true')

  // hintLocation gate: 'none' and 'pill' hide the hint bar.
  assert.ok(fn.includes("if (hintLocation === 'none' || hintLocation === 'pill') return null;"), "hint bar hidden on hintLocation 'none'/'pill'")

  // Pill-identical indicator: the shared ring helper, spinning while a goal runs.
  assert.ok(fn.includes('renderModeRing(running.count > 0, MODE_ON_COLOR)'), 'hint indicator = shared ring (spins while running, static when idle)')
  assert.ok(fn.includes('if (running.count > 0) ensurePillSpinStyle();'), 'spin CSS ensured when a goal runs')

  // Pill-identical label: the same mode.pillCounts counts key.
  assert.ok(fn.includes("t('mode.pillCounts', { stopped: counts.stopped, total: counts.total })"), 'hint label =「控制模式：{stopped}/{total}」counts label')
  assert.ok(fn.includes('const counts = countGoals(goalsRaw)'), 'counts come from the shared countGoals reducer')
  assert.ok(fn.includes('const running = countRunningGoals(goalsRaw)'), 'running state comes from the shared countRunningGoals reducer')

  // Old wording survives as tooltip (title + aria-label), never deleted.
  assert.ok(fn.includes("state.policy === 'queue' ? 'hint.queue' : 'hint.insert'"), 'insert/queue key choice kept')
  assert.ok(fn.includes('title: tip'), 'tooltip title carries the insert/queue wording')
  assert.ok(fn.includes("'aria-label': tip"), 'aria-label carries the insert/queue wording')

  // Semantic markers preserved.
  assert.ok(fn.includes("role: 'note'"), "role:'note' preserved")
  assert.ok(fn.includes("'data-cybernetics-hint': ''"), 'data-cybernetics-hint preserved')
  assert.ok(fn.includes('style: modeIndicatorStyles.hint'), 'hint capsule style preserved')
  assert.ok(!fn.includes('hintDot'), 'old 6px hintDot indicator removed from the hint bar')

  // The old dictionaries keep the insert/queue wording (bilingual).
  assert.ok(source.includes("'hint.insert': '控制模式生效中：新输入将作为外环控制即时插入当前回合'"), 'zh hint.insert wording kept for the tooltip')
  assert.ok(source.includes("'hint.queue': '控制模式生效中：新输入将排队为下一轮输入（inputPolicy=queue）'"), 'zh hint.queue wording kept for the tooltip')
  console.log('✓ 2 ComposerHint: shared ring + counts label, insert/queue → tooltip, role/data attrs kept, hintDot gone')
}

// --- 3. ModePill: honors the same hintLocation gate --------------------------
{
  const fnStart = source.indexOf('function ModePill(')
  assert.ok(fnStart > 0, 'ModePill exists')
  const fn = source.slice(fnStart, source.indexOf('\t\t}\n', fnStart))
  assert.ok(fn.includes("if (hintLocation === 'none' || hintLocation === 'composer') return null;"), "pill hidden on hintLocation 'none'/'composer'")
  // The gate must sit after every hook (useState/useEffect/useSyncExternalStore).
  const lastHook = fn.lastIndexOf('react.useState(')
  const gate = fn.indexOf("if (hintLocation === 'none'")
  assert.ok(gate > lastHook, 'hintLocation early-return placed after all hooks')
  assert.ok(fn.includes('renderModeRing(true, dotColor)') && fn.includes('renderModeRing(false, dotColor)'), 'pill ring arms ride the same shared helper')
  console.log('✓ 3 ModePill: hintLocation gate after hooks, ring arms via shared helper')
}

// --- 4. Server schema: hintLocation union, default 'both', volatile ----------
{
  assert.ok(schemaSource.includes("hintLocation: z.union(['both', 'pill', 'composer', 'none'] as const).default('both').volatile()"), 'schema field: union(both|pill|composer|none), default both, volatile')
  assert.ok(schemaSource.includes("hintLocation?: 'both' | 'pill' | 'composer' | 'none'"), 'surface type carries the field')
  assert.ok(schemaSource.includes('状态提示位置'), 'zh label「状态提示位置」in the field description')
  // No new client inject, no new API: the field rides the existing ConfigForm
  // snapshot + the settings card enum row (settings.hintLocation locale keys).
  assert.ok(!source.includes("'remote.settings.hintLocation'"), 'no new settings namespace/path invented')
  assert.ok(source.includes("field: 'hintLocation'") && source.includes("kind: 'enum'"), 'settings card renders the field as a fixed-enum select')
  assert.ok(source.includes("'settings.hintLocation': '状态提示位置'"), 'zh label「状态提示位置」declared in the client locale dict')
  assert.ok(source.includes("'settings.hintLocation.optBoth'") && source.includes("'settings.hintLocation.optNone'"), 'bilingual option labels declared (both/none at minimum)')
  console.log('✓ 4 schema: hintLocation union + default both + volatile, no new API')
}

// --- 5. Factory smoke: exports intact ----------------------------------------
{
  assert.equal(factoryResult.name, 'dsh-cybernetics', 'client module exports its name')
  assert.equal(typeof factoryResult.apply, 'function', 'client module exports apply')
  // v0.23 adds the optional `commandUi` inject (popupSelect decoration for
  // /cybernetics); the hint-location feature itself adds no transport.
  assert.equal(factoryResult.inject.length, 10, 'inject list = v0.19 set + commandUi (v0.23)')
  assert.ok(factoryResult.inject.includes('commandUi'), 'v0.23 decoration transport declared')
  assert.equal(typeof factoryResult.readHintLocation, 'function', 'readHintLocation exported for the offline harness')
  console.log('✓ 5 client.js: factory evaluates, exports intact')
}

console.log('\nALL v0.19.0 HINT-LOCATION CHECKS PASSED')
