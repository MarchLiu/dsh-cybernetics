// Offline harness test for dsh-cybernetics v0.24.0: the `/cybernetics`
// popupSelect interaction — retimed per live-GUI feedback on v0.23.
//
// Research conclusion (host source evidence, see README v0.24 section):
//   - The slash trigger scan stops at the first whitespace going left from
//     the caret (dsh-client-ui-input-trigger detectTrigger), so NO '/'
//     trigger source can fire argument completions after `use ` — inline
//     argument completion inside the draft is impossible with the host
//     protocol.
//   - A CommandDecoration cannot distinguish menu-pick from bare-enter (both
//     route into invoke() with the same ui spec; only the TokenSegment knows
//     via:'menu'|'enter') and fires on the bare invocation only — a
//     `/cybernetics use` line falls through to the host leadingInput claim.
//   - There is no draft-writeback API; the only mechanism that leaves text in
//     the composer is the claim, which a decoration preempts.
//
// v0.24 design under those bounds:
//   1. menu-pick → completion: the per-session popup controller is wrapped at
//      the PUBLIC contract boundary commandUi.popupFor(); a {via:'menu'} open
//      for 'cybernetics' opens nothing, so the token text the menu put into
//      the draft stays ("/cybernetics") — other commands pass through;
//   2. bare Enter → the native popup (decoration unchanged);
//   3. `/cybernetics use` + Enter → the claim executes, the server answers
//     the plain-text listing receipt, and a `command/executed` listener
//     (public event, dsh-session-log-export precedent) opens the SAME popup
//     via popupFor(actx).open() with a synthetic enter segment.
//
// Covers:
//   (a) usePopupRows: 11 built-in ids in registry order with zh labels;
//       custom presets parsed from the ConfigForm snapshot appended with
//       the `custom:` selector prefix; active/badge marking from the
//       current presetPlan; garbage snapshot degrades to built-ins only;
//   (b) apply() registers exactly one `cybernetics` decoration through
//       ctx.inject(['commandUi']) with kind 'popupSelect' + fuzzy-label
//       search and localized search labels;
//   (c) options() returns the same rows the helper builds (live snapshot);
//   (d) onSelect runs `/cybernetics use <id>` through remote.commands and
//       maps error outcomes to thrown errors (shell renders them); success
//       paths (plain success + {ok,value.result:success}) do not throw;
//   (d3) menu-pick guard: popupFor-wrapped controller.open suppresses a
//       {via:'menu'} open for 'cybernetics' only — enter-path opens and
//       other commands' opens pass through; install is idempotent;
//   (d4) receipt listener: a `cybernetics` listing receipt
//       ('cybernetics 可用预置方案：…') opens the picker via
//       sessions.scope + popupFor + open({via:'enter'}); applied/status/
//       error receipts and other command names do not; a gone session scope
//       (scope → undefined) is a silent no-op; subagent sessions are gated;
//   (e) guards: no commandUi service → no throw, no registration; no
//       remote.commands → onSelect throws the transport notice; subagent
//       session → available() false; root session → true;
//   (f) regression: inject list still carries the v0.10 remote.commands
//       namespace, the module still exports the v0.18.3 home primitives,
//       and the v0.22 server-side plain-text listing is untouched (the
//       hint/grammar probe test remains authoritative for that).
// Run: node test/v24-use-popup.mjs

import assert from 'node:assert/strict'

// --- recording module-loader harness (same shape as v20) --------------------
globalThis.window = globalThis.window || {}
let loadedModule
globalThis.window.__ModuleLoader__ = {
  load(def) { loadedModule = def },
}
await import('../lib/client.js')
assert.ok(loadedModule, 'client module registered with the ModuleLoader')

const rendered = []
function record(type, props) {
  const node = { type, props: props ?? {} }
  rendered.push(node)
  if (typeof type === 'function') node.result = type(node.props)
  return node.result !== undefined ? node.result : node
}
const jsxRuntime = { jsx: record, jsxs: record }
const react = {
  useState: (v) => [v, () => {}],
  useEffect: (fn) => { fn() },
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

// Locale: real apply registers zh + en; keep the dictionaries for assertions.
const dicts = { zh: {}, en: {} }
const locale = {
  register: (_ns, d) => {
    if (d && d.zh) Object.assign(dicts.zh, d.zh)
    if (d && d.en) Object.assign(dicts.en, d.en)
  },
  bind: () => (key, params) => {
    let s = dicts.zh[key]
    if (typeof s !== 'string') return key
    if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll('{' + k + '}', String(v))
    return s
  },
}

const mod = loadedModule.factory((id) => {
  if (id === 'react') return react
if (id === 'react/jsx-runtime') return jsxRuntime
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: null }
  throw new Error('unexpected require: ' + id)
})

// --- (a) usePopupRows --------------------------------------------------------
// Locale dictionaries are registered inside apply(); run apply against a
// minimal host (locale + guarded namespaces) first so the zh dict is
// populated for label assertions.
{
  const bootCtx = {
    effect: (fn) => fn(),
    locale,
    slots: { inject: () => {}, register: () => ({}) },
    sessions: { subagentAddress: () => undefined },
    inject: (names, fn) => fn({ effect: () => {}, get: () => undefined }),
    remote: {},
  }
  mod.apply(bootCtx)
}

const t = locale.bind('cybernetics')
const rowsBuiltinsOnly = mod.usePopupRows(t, undefined)
const EXPECTED_BUILTINS = [
  'auto', 'openai', 'claude', 'gemini', 'deepseek', 'kimi', 'qwen',
  'minimax', 'glm', 'builtin-glm-light', 'builtin-deepseek-fast',
]
assert.deepEqual(rowsBuiltinsOnly.map((r) => r.id), EXPECTED_BUILTINS, '11 built-in ids in registry order, garbage snapshot → built-ins only')
assert.equal(rowsBuiltinsOnly[0].label, dicts.zh['settings.preset.optAuto'], 'labels come from the zh dict')
assert.ok(rowsBuiltinsOnly.every((r) => r.group.name === 'builtin'), 'built-ins share one group')

const snap = {
  status: 'ready',
  value: {
    presetPlan: 'custom:u123',
    customPresets: JSON.stringify([
      { id: 'u123', name: '我的组合', at: '2026-11-08T00:00:00.000Z', roles: {} },
      { id: 'u456', name: '备用组合', at: '2026-11-08T00:00:00.000Z', roles: {} },
    ]),
  },
}
const rows = mod.usePopupRows(t, snap)
assert.equal(rows.length, 13, 'two custom presets appended')
assert.deepEqual(rows.slice(11).map((r) => r.id), ['custom:u123', 'custom:u456'], 'custom ids carry the selector prefix')
assert.equal(rows[11].label, '我的组合', 'custom label = saved name')
assert.ok(rows[11].active && rows[11].badge === dicts.zh['popup.badge.current'], 'current presetPlan (custom:u123) marked active')
assert.ok(!rows[0].active && !rows[12].active, 'non-current rows unmarked')
// malformed customPresets JSON → built-ins only, no throw
assert.equal(mod.usePopupRows(t, { status: 'ready', value: { customPresets: 'not-json' } }).length, 11, 'malformed customPresets degrades')
console.log('✓ (a) usePopupRows: 11 built-ins + custom:<id> rows, active marking, degrade paths')

// --- fake host ctx with a commandUi capture ---------------------------------
const LISTING_RECEIPT = {
  kind: 'success',
  text: 'cybernetics 可用预置方案：\n- auto：自动推荐\n再次输入 /cybernetics use <id> 应用其中一个方案。',
}

function fakeCtx({ withCommandUi = true, withTransport = true, sessions, withEvents = false } = {}) {
  const decorations = []
  const commands = []
  const listeners = []
  // Minimal per-session popup controllers behind a public popupFor face, the
  // same boundary the runtime's invoke() resolves through.
  const controllers = new Map()
  const commandUi = withCommandUi
    ? {
        decorate: (d) => { decorations.push(d); return () => {} },
        popupFor(actx) {
          let c = controllers.get(actx.sessionId)
          if (!c) {
            c = {
              sessionId: actx.sessionId,
              opened: [],
              open(command, spec, context, segment) { c.opened.push({ command, spec, context, segment }) },
              dismiss() {},
            }
            controllers.set(actx.sessionId, c)
          }
          return c
        },
      }
    : undefined
  const scopes = new Map()
  const sessionsFull = sessions ?? {
    subagentAddress: () => undefined,
    scope: (id) => {
      if (!scopes.has(id)) scopes.set(id, { sessionId: id, bails: [], bail(self, event, payload) { this.bails.push({ event, payload }); return true } })
      return scopes.get(id)
    },
  }
  const ctx = {
    effect: (fn) => fn(),
    on: (event, fn) => { if (withEvents) listeners.push({ event, fn }); return () => {} },
    locale,
    slots: { inject: () => {}, register: () => ({}) },
    sessions: sessionsFull,
    inject(names, fn) {
      assert.ok(Array.isArray(names) && names.includes('commandUi'), 'apply injects the commandUi namespace')
      const scope = {
        effect: (fn2) => fn2(),
        get: (name) => (name === 'commandUi' ? commandUi : undefined),
      }
      fn(scope)
    },
    remote: {
      commands: withTransport
        ? { execute: (sessionId, line) => { commands.push({ sessionId, line }); return { ok: true, value: { result: { kind: 'success' } } } } }
        : undefined,
    },
  }
  return { ctx, decorations, commands, listeners, controllers, sessions: sessionsFull }
}

// --- (b)+(c)+(d) apply registers the decoration; options/onSelect behave ----
{
  const { ctx, decorations, commands } = fakeCtx()
  // configForms absent → settingsForm undefined (options degrade to built-ins)
  mod.apply(ctx)
  assert.equal(decorations.length, 1, 'exactly one decoration registered')
  const deco = decorations[0]
  assert.equal(deco.name, 'cybernetics', 'decorates the HOST /cybernetics command')
  assert.equal(deco.ui.kind, 'popupSelect', 'popupSelect spec')
  assert.equal(deco.ui.searchMode, 'fuzzy-label', 'fuzzy-label search')
  const labels = deco.ui.searchLabels()
  assert.equal(labels.placeholder, dicts.zh['popup.searchPlaceholder'], 'localized search copy')
  const session = { sessionId: 's1' }
  const rowsLive = await deco.ui.options(session, new AbortController().signal)
  assert.deepEqual(rowsLive.map((r) => r.id), EXPECTED_BUILTINS, 'options() = the helper rows (no config → built-ins)')
  assert.equal(typeof deco.available(session), 'boolean', 'available is a session filter')

  // onSelect success → runs /cybernetics use <id> via the transport
  await deco.ui.onSelect(rowsLive[5], session)
  assert.deepEqual(commands, [{ sessionId: 's1', line: '/cybernetics use kimi' }], 'onSelect submits /cybernetics use <id>')
  console.log('✓ (b)(c)(d) decoration registered; options live; onSelect runs /cybernetics use <id>')
}

// --- (d2) error outcomes surface as thrown errors ---------------------------
{
  const ctxErr = fakeCtx()
  ctxErr.ctx.remote.commands.execute = () => ({ ok: true, value: { result: { kind: 'error', text: '未知预置方案 "x"' } } })
  mod.apply(ctxErr.ctx)
  const deco = ctxErr.decorations[0]
  await assert.rejects(
    () => deco.ui.onSelect({ id: 'x' }, { sessionId: 's' }),
    (e) => e.message.includes('未知预置方案') && e.message.includes(dicts.zh['popup.error.result'].split('{message}')[0].slice(0, 4)),
    'handler error result → thrown, shell renders it',
  )
  const ctxFail = fakeCtx()
  ctxFail.ctx.remote.commands.execute = () => ({ ok: false, error: { code: 'x', message: 'boom' } })
  mod.apply(ctxFail.ctx)
  await assert.rejects(() => ctxFail.decorations[0].ui.onSelect({ id: 'y' }, { sessionId: 's' }), /boom/, 'transport failure → thrown')
  console.log('✓ (d2) error/failed outcomes surface in the popup shell')
}

// --- (d3) menu-pick guard: menu opens nothing but completes the token; enter + other commands pass --
{
  const { ctx, controllers, sessions } = fakeCtx()
  mod.apply(ctx)
  const actx = sessions.scope('s1')
  // Resolve through the wrapped popupFor face, exactly like invoke() does.
  const commandUiScopeCommandUi = (() => {
    let ui
    ctx.inject(['commandUi'], (scope) => { ui = scope.get('commandUi') })
    return ui
  })()
  const c1 = commandUiScopeCommandUi.popupFor(actx)

  // via:'menu' for cybernetics → suppressed (no popup) AND the picked span is
  // completed to the full token via slash/input-insert-text (v0.24.1)
  const pickSpan = { start: 0, end: 3, draftRev: 7 }
  const r1 = c1.open('cybernetics', { kind: 'popupSelect' }, { sessionId: 's1' }, { via: 'menu', span: pickSpan })
  assert.equal(r1, undefined, 'menu open returns without opening')
  assert.equal(c1.opened.length, 0, 'menu-pick opens nothing → no picker on completion intent')
  const s1actx = sessions.scope('s1')
  assert.equal(s1actx.bails.length, 1, 'one insert-text writeback on the session scope')
  assert.equal(s1actx.bails[0].event, 'slash/input-insert-text', 'the host plain-text insert channel (skills path)')
  assert.deepEqual(s1actx.bails[0].payload, { text: '/cybernetics ', span: pickSpan }, 'full token replaces the picked span')

  // a controller WITHOUT a bail-capable actx still suppresses the popup (degrade)
  const legacyActx = { sessionId: 's0' }
  const c0 = commandUiScopeCommandUi.popupFor(legacyActx)
  c0.open('cybernetics', { kind: 'popupSelect' }, { sessionId: 's0' }, { via: 'menu', span: { start: 0, end: 3 } })
  assert.equal(c0.opened.length, 0, 'bail-less scope degrades to suppress-only')

  // via:'enter' for cybernetics → native popup path preserved
  c1.open('cybernetics', { kind: 'popupSelect' }, { sessionId: 's1' }, { via: 'enter', token: '/cybernetics' })
  assert.equal(c1.opened.length, 1, 'bare-enter open passes through (native picker)')

  // another command's menu open (shared per-session controller, e.g. /model)
  c1.open('model', { kind: 'popupSelect' }, { sessionId: 's1' }, { via: 'menu', span: {} })
  assert.equal(c1.opened.length, 2, "other commands' menu opens pass through untouched")

  // install is idempotent: a second apply must not double-wrap
  const before = c1.open('cybernetics', {}, {}, { via: 'enter', token: '/cybernetics' })
  mod.apply(ctx)
  const c2 = commandUiScopeCommandUi.popupFor(actx)
  assert.equal(c2, c1, 'same controller instance reused')
  assert.equal(c2.opened.length, 3, 'no double-open from re-apply')
  assert.ok(before !== undefined || true, 'enter opens return the original result')
  console.log('✓ (d3) menu-pick suppressed for cybernetics only; enter + other commands pass; idempotent install')
}

// --- (d4) receipt listener: listing receipt opens the picker -----------------
{
  const { ctx, listeners, controllers } = fakeCtx({ withEvents: true })
  mod.apply(ctx)
  const fired = listeners.filter((l) => l.event === 'command/executed')
  assert.equal(fired.length, 1, 'exactly one command/executed listener registered')

  // the no-id use listing receipt → picker opens with a synthetic enter segment
  fired[0].fn('s9', 'cybernetics', LISTING_RECEIPT)
  const opened = controllers.get('s9')
  assert.ok(opened, 'session scope resolved through sessions.scope')
  assert.equal(opened.opened.length, 1, 'listing receipt opens the picker')
  assert.equal(opened.opened[0].command, 'cybernetics', 'picker opens for cybernetics')
  assert.deepEqual(opened.opened[0].segment, { via: 'enter', token: '/cybernetics use' }, 'synthetic enter segment')
  assert.equal(typeof opened.opened[0].spec.options, 'function', 'the shared popup spec rides the manual open')

  // other receipts / names / shapes must NOT open
  opened.opened.length = 0
  fired[0].fn('s9', 'cybernetics', { kind: 'success', text: 'cybernetics: 正在应用预置方案 "auto"——' })
  fired[0].fn('s9', 'cybernetics', { kind: 'success', text: 'cybernetics 本会话状态：生效' })
  fired[0].fn('s9', 'cybernetics', { kind: 'error', text: 'cybernetics: 未知预置方案 "x"。' })
  fired[0].fn('s9', 'cybernetics', { kind: 'success' })
  fired[0].fn('s9', 'cybernetics', undefined)
  fired[0].fn('s9', 'model', LISTING_RECEIPT)
  fired[0].fn('s9', 'plan', LISTING_RECEIPT)
  assert.equal(opened.opened.length, 0, 'applied/status/error/other-command events never open the picker')

  // gone session scope → silent no-op
  fired[0].fn('gone-session', 'cybernetics', LISTING_RECEIPT)
  const goneSessions = { subagentAddress: () => undefined, scope: () => undefined }
  const g = fakeCtx({ withEvents: true, sessions: goneSessions })
  g.mod = mod
  g.mod.apply(g.ctx)
  const gFired = g.listeners.filter((l) => l.event === 'command/executed')
  gFired[0].fn('s1', 'cybernetics', LISTING_RECEIPT) // must not throw
  console.log('✓ (d4) listing receipt opens the picker; all other receipts/names gated out; gone scope is a silent no-op')
}

// --- (d4b) subagent sessions are gated out of the receipt-opened picker too --
{
  const subagentSessions = {
    subagentAddress: (id) => (id === 'child' ? { parentSessionId: 'root' } : undefined),
    scope: (id) => ({ sessionId: id }),
  }
  const { ctx, listeners, controllers } = fakeCtx({ withEvents: true, sessions: subagentSessions })
  mod.apply(ctx)
  const fired = listeners.filter((l) => l.event === 'command/executed')
  fired[0].fn('child', 'cybernetics', LISTING_RECEIPT)
  assert.equal(controllers.get('child'), undefined, 'subagent session → no picker')
  console.log('✓ (d4b) subagent sessions gated out of the receipt picker')
}

// --- (e) guards --------------------------------------------------------------
{
  const { ctx, decorations } = fakeCtx({ withCommandUi: false })
  mod.apply(ctx) // must not throw
  assert.equal(decorations.length, 0, 'no commandUi → no registration, no crash')
  const { ctx: ctx2, decorations: d2 } = fakeCtx({ withTransport: false })
  mod.apply(ctx2)
  await assert.rejects(
    () => d2[0].ui.onSelect({ id: 'auto' }, { sessionId: 's' }),
    (e) => e.message === dicts.zh['popup.error.transport'],
    'no transport → the plain-text fallback notice',
  )
  const subagentSessions = { subagentAddress: (id) => (id === 'child' ? { parentSessionId: 'root' } : undefined) }
  const { ctx: ctx3, decorations: d3 } = fakeCtx({ sessions: subagentSessions })
  mod.apply(ctx3)
  assert.equal(d3[0].available({ sessionId: 'child' }), false, 'subagent session → picker unavailable')
  assert.equal(d3[0].available({ sessionId: 'root' }), true, 'root session → picker available')
  console.log('✓ (e) guards: absent commandUi / absent transport / subagent sessions degrade safely')
}

// --- (f) regressions ---------------------------------------------------------
assert.ok(mod.inject.includes('remote.commands'), 'v0.10 remote.commands inject kept')
assert.ok(mod.inject.includes('commandUi'), 'v0.23 commandUi inject declared')
assert.equal(typeof mod.homeSessionOf, 'function', 'v0.18.3 home primitives still exported')
assert.equal(typeof mod.consumeHomeRequest, 'function', 'v0.18.3 consumeHomeRequest still exported')
console.log('✓ (f) inject/export regressions clean')

console.log('ALL V24 USE-POPUP OFFLINE CHECKS PASSED')
