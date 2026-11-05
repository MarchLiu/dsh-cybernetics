// Offline harness test for dsh-cybernetics v0.9.0: the per-session
// /cybernetics on|off|status override (session event + projection) and the
// input-policy relay (queued next-turn user input relocated to next-step).
// Run: node test/v09-session-mode.mjs

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { MODE_EVENT_TYPE, MODE_PROJECTION_KEY, cyberneticsModeProjection } from '../src/sessionMode.ts'

// --- fake host ctx with a working projection registry + command registry ----
function fakeHost({ allGoalsMode = false, hardGate = false } = {}) {
  const projections = new Map() // key -> definition
  // state per projection key, folded per session object
  const states = new Map() // key -> Map<session, state>
  const listeners = []
  const commands = []
  const injections = []
  const sections = []
  const tools = []
  const ctx = {
    tools: { register: (d) => { tools.push(d); return () => {} } },
    systemPrompt: {
      section: (s) => { sections.push(s); return () => {} },
      getSectionOrder: () => 0,
    },
    goals: { get: () => null },
    workingDirectory: { get: () => '/tmp' },
    agentPresets: { serviceFor: () => undefined },
    agents: { roots: () => [] },
    sessionProjections: {
      register(definition) {
        projections.set(definition.key, definition)
        states.set(definition.key, new Map())
        return () => { projections.delete(definition.key) }
      },
      stateOf(session, key) {
        return states.get(key)?.get(session)
      },
    },
    on(event, fn) { listeners.push({ event, fn }); return () => {} },
    inject(names, cb) {
      injections.push({ names, cb })
      // Command-injected child scope: commands default to a recording stub.
      cb({ ...ctx, commands: { register: (d) => { commands.push(d); return () => {} } } })
    },
  }
  apply(ctx, { allGoalsMode, hardGate })
  const makeSession = makeSessionFactoryLocal({ projections, states })
  return { ctx, projections, states, listeners, commands, injections, sections, tools, makeSession }
}

/** Append one mode event through the registered projection (mimics session.append + replay). */
function appendModeEvent(host, session, enabled) {
  const unit = host.projections.get(MODE_PROJECTION_KEY)
  const perSession = host.states.get(MODE_PROJECTION_KEY)
  if (!perSession.has(session)) perSession.set(session, unit.init())
  const next = unit.apply(perSession.get(session), { type: MODE_EVENT_TYPE, data: { enabled } })
  perSession.set(session, next)
  return next
}

function makeSessionFactoryLocal({ projections, states }) {
  return (id, parent) => ({
    id,
    header: parent === undefined ? {} : { parentSession: parent },
    append(type, data) {
      for (const [key, unit] of projections) {
        const perSession = states.get(key)
        if (!perSession.has(this)) perSession.set(this, unit.init())
        perSession.set(this, unit.apply(perSession.get(this), { type, data }))
      }
    },
  })
}

// --- 1. mode projection fold -------------------------------------------------
{
  const unit = cyberneticsModeProjection()
  assert.equal(unit.key, MODE_PROJECTION_KEY)
  assert.deepEqual(unit.init(), { override: null })
  let s = unit.init()
  s = unit.apply(s, { type: MODE_EVENT_TYPE, data: { enabled: false } })
  assert.equal(s.override, false)
  s = unit.apply(s, { type: MODE_EVENT_TYPE, data: { enabled: true } })
  assert.equal(s.override, true)
  s = unit.apply(s, { type: MODE_EVENT_TYPE, data: { enabled: null } })
  assert.equal(s.override, null, 'null clears the override back to inherit')
  s = unit.apply(s, { type: MODE_EVENT_TYPE, data: { enabled: 'yes' } })
  assert.equal(s.override, null, 'garbage heals to inherit')
  s = unit.apply(s, { type: 'user/message', data: {} })
  assert.equal(s.override, null, 'unrelated events keep state identity')
  console.log('✓ 1 mode projection: on/off/clear/garbage fold correctly')
}

// --- 2. guidance section follows the per-session override --------------------
{
  const host = fakeHost({ allGoalsMode: false, hardGate: true })
  ;(host.rootSession = host.makeSession, host.childSession = (id, p) => host.makeSession(id, p))
  const section = host.sections.find((s) => s.name === 'tool:cybernetics')
  assert.ok(section, 'guidance section registered')
  assert.equal(typeof section.text, 'function', 'v0.9.0: text is a function of the session')

  const sessA = host.rootSession('sess-a')
  const sessB = host.rootSession('sess-b')
  const sessC = host.rootSession('sess-c')
  // no override + global off → implicit guidance only, no ALL-GOALS
  const tNone = section.text({ agent: { session: sessA } })
  assert.match(tNone, /never execute task work/i)
  assert.ok(!tNone.includes('ALL-GOALS MODE ACTIVE'), 'no override + global off: implicit only')
  assert.match(tNone, /HARD GATE ACTIVE/, 'hardGate config still drives gate guidance')
  // override on + global off → full orchestration incl. ALL-GOALS
  appendModeEvent(host, sessB, true)
  const tOn = section.text({ agent: { session: sessB } })
  assert.match(tOn, /ALL-GOALS MODE ACTIVE/, 'override on: ALL-GOALS routing injected')
  // override off → nothing at all
  appendModeEvent(host, sessC, false)
  const tOff = section.text({ agent: { session: sessC } })
  assert.equal(tOff, '', 'override off: empty guidance for that session only')
  // other sessions unaffected
  assert.ok(section.text({ agent: { session: sessA } }).length > 0, 'override is per-session')
  console.log('✓ 2 guidance: per-session override decides ALL-GOALS/hard-gate text')
}

// --- 3. hard gate honors an explicit off override -----------------------------
{
  const host = fakeHost({ hardGate: true, allGoalsMode: true })
  ;(host.rootSession = host.makeSession, host.childSession = (id, p) => host.makeSession(id, p))
  const gate = host.listeners.find((l) => l.event === 'system-prompt/assemble')
  const pre = host.listeners.find((l) => l.event === 'tools/pre-execute')
  assert.ok(gate && pre, 'gate listeners registered with hardGate:true')

  const sessOff = host.rootSession('sess-off')
  const sessOn = host.rootSession('sess-on')
  appendModeEvent(host, sessOff, false)

  const mkAssembly = () => ({ tools: [{ name: 'bash' }, { name: 'read' }, { name: 'cybernetics' }] })
  // override off: untouched
  const a1 = mkAssembly()
  gate.fn(a1, { scope: { session: sessOff } }, () => a1)
  assert.deepEqual(a1.tools.map((t) => t.name), ['bash', 'read', 'cybernetics'], 'override off: assembly unfiltered')
  const d1 = await pre.fn({ agent: { session: sessOff }, name: 'bash' }, async () => ({ kind: 'allow' }))
  assert.equal(d1.kind, 'allow', 'override off: pre-execute passes bash through')
  // no override: gated as configured
  const a2 = mkAssembly()
  gate.fn(a2, { scope: { session: sessOn } }, () => a2)
  assert.deepEqual(a2.tools.map((t) => t.name), ['read', 'cybernetics'], 'no override: gate applies')
  const d2 = await pre.fn({ agent: { session: sessOn }, name: 'bash' }, async () => ({ kind: 'allow' }))
  assert.equal(d2.kind, 'deny', 'no override: pre-execute denies bash')
  // delegated child: untouched either way
  const a3 = mkAssembly()
  gate.fn(a3, { scope: { session: host.childSession('child-1', 'sess-on') } }, () => a3)
  assert.equal(a3.tools.length, 3, 'delegated child: untouched')
  console.log('✓ 3 hard gate: /cybernetics off exempts the session, both layers')
}

// --- 4. /cybernetics command: on/off/status ----------------------------------
{
  const host = fakeHost({})
  ;(host.rootSession = host.makeSession, host.childSession = (id, p) => host.makeSession(id, p))
  const injection = host.injections.find((i) => i.names.includes('commands'))
  assert.ok(injection, 'commands child scope injected')
  // The fake host runs cb(ctx) directly, so the registration happened with the
  // root ctx.commands stub — provide one and re-run the callback shape check:
  assert.ok(Array.isArray(injection.names), 'commands inject requested')
  console.log('✓ 4a commands scope: /cybernetics registration requested via inject')
}

// Full command-path coverage needs a commands service; simulate it precisely.
{
  const commands = []
  const handlers = {}
  const host = fakeHost({})
  ;(host.rootSession = host.makeSession, host.childSession = (id, p) => host.makeSession(id, p))
  // Re-drive the injected callback against a stubbed command registry.
  const cmdCtx = {
    ...host.ctx,
    commands: {
      register(definition) { commands.push(definition); handlers[definition.name] = definition.handler; return () => {} },
    },
  }
  // The plugin's own inject callback is (commandCtx) => ...register — call it
  // through the captured injection record.
  const injection = host.injections.find((i) => i.names.includes('commands'))
  injection.cb(cmdCtx)
  assert.ok(handlers.cybernetics, '/cybernetics registered')

  const session = host.rootSession('sess-cmd')
  const invocation = (rawInput) => ({ agent: { session }, rawInput })
  // status with no override
  const status1 = handlers.cybernetics(invocation(''))
  assert.equal(status1.kind, 'success')
  assert.match(status1.text, /未设置（遵循全局配置）/, 'status reports no override')
  // off → event appended, effective flips
  const off = handlers.cybernetics(invocation('off'))
  assert.equal(off.kind, 'success')
  const state = host.states.get(MODE_PROJECTION_KEY).get(session)
  assert.equal(state.override, false, 'off appended the durable mode event')
  // status now reports off
  const status2 = handlers.cybernetics(invocation('status'))
  assert.match(status2.text, /override：off/, 'status reflects the stored override')
  assert.match(status2.text, /关闭/, 'status reports disabled effective state')
  // on restores
  const on = handlers.cybernetics(invocation('on'))
  assert.equal(on.kind, 'success')
  const state2 = host.states.get(MODE_PROJECTION_KEY).get(session)
  assert.equal(state2.override, true, 'on appended the durable mode event')
  const status3 = handlers.cybernetics(invocation('STATUS'))
  assert.match(status3.text, /生效/, 'status (case-insensitive arg) reports enabled')
  console.log('✓ 4b /cybernetics on|off|status: durable events + accurate status text')
}

// --- 5. input-policy relay: queued user input relocated to next-step ---------
{
  // Sessions WITHOUT a live projection registry must be untouched (fail-safe).
  const host = fakeHost({ allGoalsMode: true })
  ;(host.rootSession = host.makeSession, host.childSession = (id, p) => host.makeSession(id, p))
  const relay = host.listeners.find((l) => l.event === 'agent/inbox/inserted')
  assert.ok(relay, 'input relay registered')

  const session = host.rootSession('sess-relay')
  appendModeEvent(host, session, true) // explicit on (global off default here)
  let steered = []
  let removed = []
  const agent = {
    id: 'agent-relay',
    session,
    status: 'running',
    inbox: {
      nextTurn: [],
      nextStep: [],
      remove(id) { removed.push(id); return true },
    },
    steer(message) { steered.push(message) },
  }
  const queued = { id: 'm1', source: { kind: 'user' } }
  agent.inbox.nextTurn = [queued]
  relay.fn({ agent, message: queued })
  assert.deepEqual(removed, ['m1'], 'running + on: queued user input removed from next-turn')
  assert.equal(steered.length, 1, 'running + on: input steered into next-step')

  // Relay's own next-step re-insertion must not recurse.
  steered = []; removed = []
  const steplanded = { id: 'm1', source: { kind: 'user' } }
  agent.inbox.nextTurn = []
  agent.inbox.nextStep = [steplanded]
  relay.fn({ agent, message: steplanded })
  assert.equal(steered.length, 0, 'next-step insertion: no relocation loop')

  // Override off: untouched (native behavior).
  const sessOff = host.rootSession('sess-relay-off')
  appendModeEvent(host, sessOff, false)
  const agentOff = { ...agent, id: 'agent-off', session: sessOff, inbox: { nextTurn: [queued], nextStep: [], remove() { removed.push('x') } }, steer: (m) => steered.push(m) }
  steered = []; removed = []
  relay.fn({ agent: agentOff, message: queued })
  assert.equal(removed.length, 0, 'override off: inbox untouched')
  assert.equal(steered.length, 0, 'override off: nothing steered')

  // Global on + no override: relay active.
  const hostGlobal = fakeHost({ allGoalsMode: true })
  ;(hostGlobal.rootSession = hostGlobal.makeSession, hostGlobal.childSession = (id, p) => hostGlobal.makeSession(id, p))
  const relayGlobal = hostGlobal.listeners.find((l) => l.event === 'agent/inbox/inserted')
  const sessG = hostGlobal.rootSession('sess-global')
  const agentG = { id: 'agent-g', session: sessG, status: 'running', inbox: { nextTurn: [queued], nextStep: [], remove: () => true }, steer: () => {} }
  let steeredG = 0
  agentG.steer = () => { steeredG++ }
  relayGlobal.fn({ agent: agentG, message: queued })
  assert.equal(steeredG, 1, 'global allGoalsMode on, no override: relay active')

  // Policy 'queue': no relocation even when enabled.
  const hostQueue = fakeHost({})
  ;(hostQueue.rootSession = hostQueue.makeSession, hostQueue.childSession = (id, p) => hostQueue.makeSession(id, p))
  // rebuild apply with inputPolicy 'queue': the second apply adds another
  // relay reading the queue policy; the last relay decides the outcome.
  const ctxQueue = hostQueue.ctx
  apply(ctxQueue, { allGoalsMode: true, inputPolicy: 'queue' })
  const relayQ = hostQueue.listeners.filter((l) => l.event === 'agent/inbox/inserted').at(-1)
  assert.ok(relayQ, 'queue-policy relay registered')
  const sessQ = hostQueue.rootSession('sess-q')
  let steeredQ = 0
  const agentQ = { id: 'agent-q', session: sessQ, status: 'running', inbox: { nextTurn: [queued], nextStep: [], remove: () => true }, steer: () => { steeredQ++ } }
  relayQ.fn({ agent: agentQ, message: queued })
  assert.equal(steeredQ, 0, "inputPolicy 'queue': native queue behavior preserved")

  // Idle agent: no relocation needed (followup already wakes).
  const agentIdle = { ...agent, status: 'idle' }
  steered = []; removed = []
  agentIdle.inbox = { nextTurn: [queued], nextStep: [], remove: (id) => { removed.push(id); return true } }
  relay.fn({ agent: agentIdle, message: queued })
  assert.equal(removed.length, 0, 'idle agent: untouched (followup already wakes immediately)')

  // v0.13.0: our own round notice (source.kind 'cybernetics') IS relocated by
  // default (noticePolicy 'insert', inner-loop auto insertion); an unknown
  // source kind stays untouched.
  const notice = { id: 'n1', source: { kind: 'cybernetics' } }
  agent.status = 'running'
  agent.inbox.nextTurn = [notice]
  steered = []; removed = []
  relay.fn({ agent, message: notice })
  assert.deepEqual(removed, ['n1'], 'v0.13: round notice relocated (noticePolicy insert default)')
  assert.equal(steered.length, 1, 'v0.13: round notice steered into next-step')
  const unknown = { id: 'u1', source: { kind: 'tool' } }
  agent.inbox.nextTurn = [unknown]
  steered = []; removed = []
  relay.fn({ agent, message: unknown })
  assert.equal(removed.length, 0, 'unknown source kind: untouched')
  assert.equal(steered.length, 0, 'unknown source kind: nothing steered')

  // Delegated child agent: untouched.
  const childAgent = { id: 'child', session: host.childSession('c1', 'sess-relay'), status: 'running', inbox: { nextTurn: [queued], nextStep: [], remove: () => true }, steer: () => {} }
  steered = []
  relay.fn({ agent: childAgent, message: queued })
  assert.equal(steered.length, 0, 'delegated child: untouched')

  console.log('✓ 5 input relay: queue→steer relocation with exact non-interference guards')
}

console.log('\nALL v0.9.0 SESSION-MODE CHECKS PASSED')
