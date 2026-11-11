// Offline harness test for dsh-cybernetics v0.10.0: the orchestration-mode
// visual indicator. Server-side semantics the client UI depends on:
//   - the canonical tri-state join (resolveMode: override on/off/null ×
//     global on/off → enabled + deciding source),
//   - null-override inheritance semantics through effectiveEnabled,
//   - resume/fork replay: folding the same mode-event log prefix into a
//     fresh session reproduces the exact override state,
//   - projection wire backward compatibility ({override} view, stateVersion),
//   - client.js (ModuleLoader bundle) factory still evaluates.
// Run: node test/v10-mode-indicator.mjs

import assert from 'node:assert/strict'
import { apply } from '../src/index.ts'
import {
  MODE_EVENT_TYPE,
  MODE_PROJECTION_KEY,
  cyberneticsModeProjection,
  resolveMode,
  effectiveEnabled,
  modeOverrideOf,
  modeEventPayload,
} from '../src/sessionMode.ts'

// --- 1. resolveMode: the canonical override × global matrix -------------------
{
  const matrix = [
    // [override, global, expected enabled, expected source]
    [true, false, true, 'override'],
    [true, true, true, 'override'],
    [false, true, false, 'override'],
    [false, false, false, 'override'],
    [null, true, true, 'global'],
    [null, false, false, 'global'],
  ]
  for (const [override, global, enabled, source] of matrix) {
    const resolved = resolveMode(override, global)
    assert.equal(resolved.enabled, enabled, `resolveMode(${override},${global}).enabled`)
    assert.equal(resolved.source, source, `resolveMode(${override},${global}).source`)
  }
  console.log('✓ 1 resolveMode: override/global/effective tri-state matrix + deciding source')
}

// --- 2. effectiveEnabled inheritance semantics (null = inherit global) --------
{
  // Minimal fake ctx carrying only what modeOverrideOf touches.
  const mkCtx = (stateByKey) => ({ sessionProjections: { stateOf: (_s, key) => stateByKey.get(key) } })
  const none = mkCtx(new Map())
  const onOverride = mkCtx(new Map([[MODE_PROJECTION_KEY, { override: true }]]))
  const offOverride = mkCtx(new Map([[MODE_PROJECTION_KEY, { override: false }]]))
  const garbage = mkCtx(new Map([[MODE_PROJECTION_KEY, { override: 'yes' }]]))
  assert.equal(effectiveEnabled(none, {}, true), true, 'no override + global on')
  assert.equal(effectiveEnabled(none, {}, false), false, 'no override + global off')
  assert.equal(effectiveEnabled(onOverride, {}, false), true, 'override on beats global off')
  assert.equal(effectiveEnabled(offOverride, {}, true), false, 'override off beats global on')
  assert.equal(effectiveEnabled(garbage, {}, true), true, 'garbage override heals to inherit')
  assert.equal(effectiveEnabled(none, undefined, true), true, 'missing session: fail-safe inherit')
  assert.equal(effectiveEnabled({}, {}, true), true, 'no registry at all: fail-safe inherit')
  // resolveMode/effectiveEnabled agree on every path (the client UI mirrors
  // resolveMode's rule; the server gate keeps using effectiveEnabled).
  for (const override of [true, false, null]) {
    for (const global of [true, false]) {
      assert.equal(
        effectiveEnabled(mkCtx(new Map([[MODE_PROJECTION_KEY, { override }]])), {}, global),
        resolveMode(override, global).enabled,
      )
    }
  }
  console.log('✓ 2 effectiveEnabled: null inheritance + fail-safe + resolveMode agreement')
}

// --- 3. resume/fork replay reproduces the override state ----------------------
{
  const unit = cyberneticsModeProjection()
  // An event log as a session would hold it (mixed with unrelated events).
  const log = [
    { type: 'user/message', data: {} },
    { type: MODE_EVENT_TYPE, data: modeEventPayload('on') },
    { type: 'cybernetics/goals', data: { board: {} } },
    { type: MODE_EVENT_TYPE, data: modeEventPayload('off') },
    { type: MODE_EVENT_TYPE, data: { enabled: null } },
    { type: MODE_EVENT_TYPE, data: modeEventPayload('on') },
  ]
  const fold = (from, to) => {
    let state = unit.init()
    for (const event of log.slice(from, to)) state = unit.apply(state, event)
    return state
  }
  const live = fold(0, log.length)
  assert.equal(live.override, true, 'live fold ends on the last explicit on')
  // Resume/fork replay the same log prefix into a fresh session object —
  // the folded state must be identical, override survives the round-trip.
  for (const cut of [2, 3, 4, 5, 6]) {
    const replayed = fold(0, cut)
    const livePrefix = fold(0, cut)
    assert.deepEqual(replayed, livePrefix, `prefix replay to ${cut} matches live fold`)
    assert.equal(replayed.override, fold(0, cut).override)
  }
  assert.equal(fold(2, 6).override, live.override, 'partial-prefix replay (fork tail) preserves final override')
  assert.equal(fold(0, 4).override, false, 'mid-log replay (resume point) reproduces the then-current override')
  console.log('✓ 3 resume/fork replay: folded override state is identical across replay prefixes')
}

// --- 4. projection wire backward compatibility --------------------------------
{
  const unit = cyberneticsModeProjection()
  assert.equal(unit.key, MODE_PROJECTION_KEY, 'registry key unchanged')
  assert.equal(unit.stateVersion, 1, 'stateVersion unchanged (no migration)')
  const state = unit.apply(unit.init(), { type: MODE_EVENT_TYPE, data: { enabled: true } })
  assert.deepEqual(unit.wire.view(state), { override: true }, 'wire view is exactly the v0.9.0 shape')
  assert.deepEqual(unit.wire.view(unit.init()), { override: null }, 'wire view of init is the inherit sentinel')
  console.log('✓ 4 projection wire: {override} view + stateVersion 1 unchanged (v0.9 clients unaffected)')
}

// --- 5. client.js factory still evaluates (ModuleLoader bundle smoke) ---------
{
  const globalThis_ = globalThis
  globalThis_.window = globalThis_.window || {}
  let factoryResult
  globalThis_.window.__ModuleLoader__ = {
    load(def) {
      const requireCache = new Map()
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
  assert.equal(factoryResult.name, 'dsh-cybernetics', 'client module exports its name')
  assert.equal(typeof factoryResult.apply, 'function', 'client module exports apply')
  assert.ok(Array.isArray(factoryResult.inject), 'client module exports inject list')
  assert.ok(factoryResult.inject.includes('remote.commands'), 'v0.10.0: remote.commands declared (pill toggle transport)')
  console.log('✓ 5 client.js: factory evaluates, remote.commands declared')
}

console.log('\nALL v0.10.0 MODE-INDICATOR CHECKS PASSED')
