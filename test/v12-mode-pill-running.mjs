// Offline harness test for dsh-cybernetics v0.12.0: the mode pill's
// "inner loop running" pulse. Covers:
//   - countRunningGoals: the pure board-shape reducer (running count +
//     highest round among running goals) across real / malformed shapes,
//   - locale dictionaries carry the new bilingual tooltip key,
//   - the pulse CSS (keyframes + prefers-reduced-motion fallback) injects
//     once into document.head and never duplicates,
//   - client.js factory still evaluates and exports the reducer.
// Run: node test/v12-mode-pill-running.mjs

import assert from 'node:assert/strict'

// ModuleLoader harness, same shape test/v10-mode-indicator.mjs uses; the
// loaded factory result is reused by section 4.
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

// --- 1. countRunningGoals: running count + highest running round -------------
{
  const countRunningGoals = factoryResult.countRunningGoals
  assert.equal(typeof countRunningGoals, 'function', 'countRunningGoals exported from client bundle')

  // Empty / unloaded shapes → zero, never throw.
  assert.deepEqual(countRunningGoals(undefined), { count: 0, round: 0 }, 'unloaded face snapshot')
  assert.deepEqual(countRunningGoals(null), { count: 0, round: 0 }, 'null snapshot')
  assert.deepEqual(countRunningGoals({}), { count: 0, round: 0 }, 'board without goals array')
  assert.deepEqual(countRunningGoals({ goals: [] }), { count: 0, round: 0 }, 'empty goals array')
  assert.deepEqual(countRunningGoals('garbage'), { count: 0, round: 0 }, 'non-object snapshot')
  assert.deepEqual(countRunningGoals({ goals: 'garbage' }), { count: 0, round: 0 }, 'non-array goals')

  // Real wire shapes (src/projection.ts GoalView): mixed statuses.
  const board = {
    goals: [
      { goalId: 'a', status: 'running', round: 2 },
      { goalId: 'b', status: 'running', round: 5 },
      { goalId: 'c', status: 'met', round: 3 },
      { goalId: 'd', status: 'pending', round: 0 },
      { goalId: 'e', status: 'paused', round: 1 },
    ],
  }
  assert.deepEqual(countRunningGoals(board), { count: 2, round: 5 }, '2 running, highest round 5')

  // Round defaults: missing / non-finite round degrades to 0 and never wins.
  assert.deepEqual(
    countRunningGoals({ goals: [{ status: 'running' }, { status: 'running', round: 'x' }, { status: 'running', round: Number.NaN }] }),
    { count: 3, round: 0 },
    'non-finite rounds degrade to 0',
  )
  // Malformed entries are skipped, not counted.
  assert.deepEqual(
    countRunningGoals({ goals: [null, 'running', { status: 'running' }] }),
    { count: 1, round: 0 },
    'malformed entries skipped',
  )
  console.log('✓ 1 countRunningGoals: real/malformed board shapes, running count + highest round')
}

// --- 2. locale dictionaries: bilingual running tooltip key --------------------
{
  // client.js is a single factory body; grep-level import isn't possible, so
  // re-evaluate the module and introspect via the source text is fragile —
  // instead assert the keys exist by exercising the module source. The zh
  // dictionary is the key-set source of truth (see client.js header note).
  const source = (await import('node:fs')).readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(source.includes("'mode.tip.running'"), 'mode.tip.running key declared')
  assert.ok(source.includes("'{count} 个目标运行中 · 第 {round} 轮'"), 'zh tooltip wording')
  assert.ok(source.includes("'{count} goal(s) running · round {round}'"), 'en tooltip wording')
  // Key parity: zh and en dictionaries declare the same mode.* key set.
  const zhKeys = [...source.matchAll(/^\t\t\t'(mode\.[^']+)':/gm)].map((m) => m[1])
  const enZone = source.slice(source.indexOf("const en = {"), source.indexOf('//#endregion', source.indexOf("const en = {")))
  for (const key of zhKeys) {
    assert.ok(enZone.includes("'" + key + "'"), `en dictionary carries ${key}`)
  }
  assert.ok(zhKeys.includes('mode.tip.running'), 'zh key set includes mode.tip.running')
  console.log(`✓ 2 locale: bilingual mode.tip.running key + zh/en mode.* key parity (${zhKeys.length} keys)`)
}

// --- 3. pulse CSS: injects once, honors prefers-reduced-motion ---------------
{
  const source = (await import('node:fs')).readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(source.includes('@keyframes dsh-cybernetics-pill-pulse'), 'keyframes declared')
  assert.ok(source.includes('@media (prefers-reduced-motion: reduce)'), 'reduced-motion fallback declared')
  assert.ok(source.includes('animation: none'), 'reduced-motion degrades to static dot')
  assert.ok(source.includes("document.getElementById(PILL_PULSE_STYLE_ID)"), 'injection guarded by style id')
  // The pulse class only reaches the dot when mode on AND a goal runs — the
  // className is computed from `pulsing`, itself gated on effective === true.
  assert.ok(source.includes("className: pulsing ? 'dsh-cybernetics-pill-dot-running' : undefined"), 'pulse class gated on pulsing flag')
  assert.ok(source.includes('const pulsing = state.ready && state.effective === true && running.count > 0'), 'pulsing = ready + on + running')
  console.log('✓ 3 pulse CSS: single-injection guard, reduced-motion fallback, on+running gating')
}

// --- 4. client.js factory: inject unchanged, exports intact -------------------
{
  assert.equal(factoryResult.name, 'dsh-cybernetics', 'client module exports its name')
  assert.equal(typeof factoryResult.apply, 'function', 'client module exports apply')
  assert.ok(factoryResult.inject.includes('remote.commands'), 'toggle transport still declared')
  // v0.14 adds exactly ONE optional inject: `uiWorkspace` (the goal agents
  // line's click-through seam — the same openSession(target) the subagent
  // pill passes openChild through). Guarded at runtime: an absent namespace
  // disables click-through only. Everything else still rides the sessions
  // binding, same path the v0.10.0 cyberneticsMode seat uses.
  assert.equal(factoryResult.inject.length, 9, 'inject list = v0.11.2 set + uiWorkspace (v0.14)')
  assert.ok(factoryResult.inject.includes('uiWorkspace'), 'goal-agent click-through transport declared')
  console.log('✓ 4 client.js: factory evaluates, inject list = v0.11.2 + uiWorkspace')
}

console.log('\nALL v0.12.0 MODE-PILL RUNNING CHECKS PASSED')
