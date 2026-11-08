// Offline harness test for dsh-cybernetics v0.12.0: the mode pill's
// "inner loop running" pulse. Covers:
//   - countRunningGoals: the pure board-shape reducer (running count +
//     highest round among running goals) across real / malformed shapes,
//   - locale dictionaries carry the new bilingual tooltip key,
//   - the running-ring CSS (spin keyframes + prefers-reduced-motion fallback)
//     injects once into document.head and never duplicates,
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

// --- 1b. countGoals: pill label counts {stopped, total} ------------------------
{
  const countGoals = factoryResult.countGoals
  assert.equal(typeof countGoals, 'function', 'countGoals exported from client bundle')

  // Empty / unloaded / malformed shapes → { stopped: 0, total: 0 }, never throw.
  assert.deepEqual(countGoals(undefined), { stopped: 0, total: 0 }, 'unloaded face snapshot')
  assert.deepEqual(countGoals(null), { stopped: 0, total: 0 }, 'null snapshot')
  assert.deepEqual(countGoals({}), { stopped: 0, total: 0 }, 'board without goals array')
  assert.deepEqual(countGoals({ goals: [] }), { stopped: 0, total: 0 }, 'empty goals array')
  assert.deepEqual(countGoals('garbage'), { stopped: 0, total: 0 }, 'non-object snapshot')
  assert.deepEqual(countGoals({ goals: 'garbage' }), { stopped: 0, total: 0 }, 'non-array goals')

  // Real wire shape: stopped = total - running (any non-running status counts
  // as stopped), total = goals.length (ALL goals count toward total, including
  // malformed entries — length is length).
  const board = {
    goals: [
      { goalId: 'a', status: 'running', round: 2 },
      { goalId: 'b', status: 'running', round: 5 },
      { goalId: 'c', status: 'met', round: 3 },
      { goalId: 'd', status: 'pending', round: 0 },
      { goalId: 'e', status: 'paused', round: 1 },
    ],
  }
  assert.deepEqual(countGoals(board), { stopped: 3, total: 5 }, '2 running of 5 total → 3 stopped / 5')
  assert.deepEqual(countGoals({ goals: [null, 'x', { status: 'running' }] }), { stopped: 2, total: 3 }, 'malformed entries still count toward total')
  assert.deepEqual(countGoals({ goals: [{ status: 'running' }, { status: 'running' }] }), { stopped: 0, total: 2 }, 'all running → stopped 0, never negative')
  assert.deepEqual(countGoals({ goals: [{ status: 'met' }] }), { stopped: 1, total: 1 }, 'all settled → 1/1')
  console.log('✓ 1b countGoals: stopped/total label counts, malformed shapes degrade to 0/0')
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
  // v0.18.x: pill label keys —「控制模式：{stopped}/{total}」format, bilingual.
  assert.ok(source.includes("'mode.pillCounts': '控制模式：{stopped}/{total}'"), 'zh label wording 控制模式：{stopped}/{total}')
  assert.ok(source.includes("'mode.pillCounts': 'Control {stopped}/{total}'"), 'en label wording Control {stopped}/{total}')
  assert.ok(source.includes("'mode.pillUnknown': '控制模式：…'"), 'zh not-loaded label keeps unknown semantics')
  assert.ok(source.includes("'mode.pillUnknown': 'Control …'"), 'en not-loaded label keeps unknown semantics')
  assert.ok(zhKeys.includes('mode.pillCounts') && zhKeys.includes('mode.pillUnknown'), 'zh key set includes the new label keys')
  assert.ok(source.includes("t('mode.pillCounts', { stopped: counts.stopped, total: counts.total })"), 'label interpolates stopped/total counts')
  assert.ok(source.includes("state.ready ? t('mode.pillCounts', { stopped: counts.stopped, total: counts.total }) : t('mode.pillUnknown')"), 'not-loaded state renders the unknown label')
  console.log(`✓ 2 locale: bilingual mode.tip.running key + zh/en mode.* key parity (${zhKeys.length} keys)`)
}

// --- 3. ring CSS: injects once, honors prefers-reduced-motion ----------------
{
  const source = (await import('node:fs')).readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(source.includes('@keyframes dsh-cybernetics-pill-spin'), 'spin keyframes declared')
  assert.ok(source.includes('.dsh-cybernetics-pill-ring-running { animation: dsh-cybernetics-pill-spin 3s linear infinite'), 'ring rotates 3s linear infinite')
  assert.ok(source.includes('strokeDasharray'), 'ring arc carries a visible gap (stroke-dasharray)')
  assert.ok(source.includes("const PILL_RING_DASHARRAY = '28.3 9.4'"), 'dasharray keeps the 3:1 arc:gap ratio at r 6 (2π·6 ≈ 37.7)')
  assert.ok(source.includes('@media (prefers-reduced-motion: reduce)'), 'reduced-motion fallback declared')
  assert.ok(source.includes('animation: none'), 'reduced-motion degrades to static ring')
  assert.ok(source.includes("document.getElementById(PILL_SPIN_STYLE_ID)"), 'injection guarded by style id')
  // No zombie pulse CSS: the old dot-pulse id/class/keyframes must be gone.
  assert.ok(!source.includes('dsh-cybernetics-pill-pulse {'), 'old pulse keyframes removed')
  assert.ok(!source.includes('.dsh-cybernetics-pill-dot-running'), 'old pulse class removed')
  // The ring only reaches the pill when mode on AND a goal runs — the
  // element is computed from `pulsing`, itself gated on effective === true.
  // v0.19.0: both ring arms render through the shared renderModeRing helper.
  assert.ok(source.includes("pulsing\n\t\t\t\t\t\t? renderModeRing(true, dotColor)"), 'running arm gated on pulsing flag, renders via renderModeRing(true)')
  assert.ok(source.includes('const pulsing = state.ready && state.effective === true && running.count > 0'), 'pulsing = ready + on + running')
  console.log('✓ 3 ring CSS: single-injection guard, 3s linear spin, dasharray gap, reduced-motion fallback, on+running gating')
}

// --- 3b. idle-on state renders a STATIC FULL ring (no dasharray, no anim class)
{
  const source = (await import('node:fs')).readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // v0.19.0: the ring arms delegate to the shared renderModeRing(running,
  // color) helper; assert the helper + both call sites instead of inline svg.
  const helperStart = source.indexOf('function renderModeRing(')
  assert.ok(helperStart > 0, 'shared renderModeRing helper exists')
  const helper = source.slice(helperStart, source.indexOf('\t\t}\n', helperStart))
  assert.ok(helper.includes("running ? { className: 'dsh-cybernetics-pill-ring-running' } : {}"), 'spin class applied only when running')
  assert.ok(helper.includes("...(running ? { strokeDasharray: PILL_RING_DASHARRAY } : {})"), 'dasharray gap applied only when running')
  assert.ok(helper.includes("viewBox: '0 0 14 14'"), 'helper reuses the 14×14 box (context-ring size)')
  assert.ok(helper.includes('r: PILL_RING_RADIUS') && helper.includes('strokeWidth: PILL_RING_STROKE'), 'helper geometry rides the shared constants (r 6, stroke 2)')
  assert.ok(helper.includes('style: modeIndicatorStyles.ring'), 'helper shares the ring box style')
  // The idle arm passes running=false; the running arm passes true.
  assert.ok(source.includes('? renderModeRing(true, dotColor)'), 'running arm = gapped spinning ring')
  const idleStart = source.indexOf(": (state.ready && state.effective === true")
  assert.ok(idleStart > 0, 'idle-on branch exists and is gated on ready + effective === true')
  const idleEnd = source.indexOf('modeIndicatorStyles.dot, background: dotColor', idleStart)
  assert.ok(idleEnd > idleStart, 'idle branch ends at the off/unknown dot fallback')
  const idle = source.slice(idleStart, idleEnd)
  assert.ok(idle.includes('renderModeRing(false, dotColor)'), 'idle-on renders the static full ring (running=false)')
  // Ring size constants: 14×14 to match the host context-usage ring
  // (measured live in the 3080 GUI: svg 14×14 CSS px); the off/unknown dot
  // shares the same box via modeIndicatorStyles.dot.
  assert.ok(source.includes('const PILL_RING_SIZE = 14'), 'ring box constant = 14 (context-ring match)')
  assert.ok(source.includes('const PILL_RING_RADIUS = 6'), 'ring radius constant = 6 (outer edge 7 = box edge)')
  assert.ok(source.includes('const PILL_RING_STROKE = 2'), 'ring stroke constant = 2 (scaled from the old 1px @ ×14/6)')
  assert.ok(source.includes('width: PILL_RING_SIZE') && source.includes('height: PILL_RING_SIZE'), 'ring svg sizes ride the constant')
  assert.ok(source.includes('width: PILL_RING_SIZE, height: PILL_RING_SIZE, borderRadius: 999'), 'off/unknown dot shares the same box (no layout jump)')
  assert.ok(!source.includes("viewBox: '0 0 6 6'"), 'old 6px ring geometry fully replaced')
  // Off/unknown arm is still the dot.
  const offArm = source.slice(source.indexOf('modeIndicatorStyles.dot, background: dotColor', idleStart))
  assert.ok(offArm.includes('modeIndicatorStyles.dot'), 'off/unknown keep the static dot')
  console.log('✓ 3b idle-on: static full green ring via shared helper, running keeps gap+spin, off keeps dot')
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
  // v0.23 adds exactly ONE further optional inject: `commandUi` (the
  // /cybernetics popupSelect decoration's namespace — guarded at runtime, a
  // host without the service keeps the pre-v0.23 behavior). 10 entries now.
  assert.equal(factoryResult.inject.length, 10, 'inject list = v0.11.2 set + uiWorkspace (v0.14) + commandUi (v0.23)')
  assert.ok(factoryResult.inject.includes('uiWorkspace'), 'goal-agent click-through transport declared')
  console.log('✓ 4 client.js: factory evaluates, inject list = v0.11.2 + uiWorkspace')
}

console.log('\nALL v0.12.0 MODE-PILL RUNNING CHECKS PASSED')
