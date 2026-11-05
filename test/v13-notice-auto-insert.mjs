// Offline harness test for dsh-cybernetics v0.13.0: inner-loop round-settled
// notices are auto-inserted (steered into next-step) without a manual push.
// The v0.9.0 input relay previously relocated ONLY user prompts; v0.13.0
// extends the same relay to the plugin's own <cybernetics_round> completion
// notices under the new volatile `noticePolicy` config (default 'insert').
// Covers:
//   - default behavior: a queued cybernetics notice on a RUNNING enabled
//     agent is removed from next-turn and steered into next-step,
//   - noticePolicy 'queue' restores the native next-turn delivery,
//   - all non-interference guards still hold (idle agent, off override,
//     delegated child, message not in next-turn → no recursion),
//   - user-input relocation (v0.9.0) still works when noticePolicy is 'queue',
//   - /cybernetics status reports the notice policy.
// Run: node test/v13-notice-auto-insert.mjs

import assert from 'node:assert/strict'
import { apply } from '../src/index.ts'
import { MODE_EVENT_TYPE, MODE_PROJECTION_KEY } from '../src/sessionMode.ts'

// Same fake-host shape test/v09-session-mode.mjs uses.
function fakeHost({ allGoalsMode = false, hardGate = false } = {}) {
  const projections = new Map()
  const states = new Map()
  const listeners = []
  const commands = []
  const injections = []
  const ctx = {
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
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
      stateOf(session, key) { return states.get(key)?.get(session) },
    },
    on(event, fn) { listeners.push({ event, fn }); return () => {} },
    inject(names, cb) {
      injections.push({ names, cb })
      cb({ ...ctx, commands: { register: (d) => { commands.push(d); return () => {} } } })
    },
  }
  apply(ctx, { allGoalsMode, hardGate })
  const makeSession = (id, parent) => ({
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
  return { ctx, projections, states, listeners, commands, injections, makeSession }
}

function enableMode(host, session) {
  const unit = host.projections.get(MODE_PROJECTION_KEY)
  const perSession = host.states.get(MODE_PROJECTION_KEY)
  if (!perSession.has(session)) perSession.set(session, unit.init())
  perSession.set(session, unit.apply(perSession.get(session), { type: MODE_EVENT_TYPE, data: { enabled: true } }))
}

const relayOf = (host) => host.listeners.filter((l) => l.event === 'agent/inbox/inserted').at(-1)

function mkAgent(session, { status = 'running', queued = [] } = {}) {
  const calls = { removed: [], steered: [] }
  const agent = {
    id: 'agent-' + session.id,
    session,
    status,
    inbox: {
      nextTurn: queued,
      nextStep: [],
      remove(id) { calls.removed.push(id); return true },
    },
    steer(message) { calls.steered.push(message) },
  }
  return { agent, calls }
}

const notice = { id: 'n-1', role: 'user', source: { kind: 'cybernetics', goalId: 'g1', round: 2 } }

// --- 1. default noticePolicy 'insert': queued notice auto-inserted ------------
{
  const host = fakeHost({})
  const session = host.makeSession('s13-on')
  enableMode(host, session)
  const relay = relayOf(host)
  const { agent, calls } = mkAgent(session, { queued: [notice] })
  relay.fn({ agent, message: notice })
  assert.deepEqual(calls.removed, ['n-1'], 'default: notice removed from next-turn')
  assert.equal(calls.steered.length, 1, 'default: notice steered into next-step (免手动推送)')
  assert.equal(calls.steered[0], notice, 'the very notice object is relocated, not a copy')

  // Next-step re-insertion must not recurse (membership guard).
  agent.inbox.nextTurn = []
  agent.inbox.nextStep = [notice]
  relay.fn({ agent, message: notice })
  assert.equal(calls.steered.length, 1, 'next-step insertion: no relocation loop')
  console.log('✓ 1 default insert: queued round notice steered into next-step, no recursion')
}

// --- 2. noticePolicy 'queue': native next-turn delivery restored --------------
{
  const host = fakeHost({})
  apply(host.ctx, { allGoalsMode: true, noticePolicy: 'queue' })
  const relay = relayOf(host)
  const session = host.makeSession('s13-queue')
  const { agent, calls } = mkAgent(session, { queued: [notice] })
  relay.fn({ agent, message: notice })
  assert.equal(calls.removed.length, 0, "noticePolicy 'queue': inbox untouched")
  assert.equal(calls.steered.length, 0, "noticePolicy 'queue': nothing steered")

  // Same relay still relocates USER input under inputPolicy 'insert' (the
  // two policies are independent knobs).
  const userInput = { id: 'u-1', source: { kind: 'user' } }
  enableMode(host, session)
  agent.inbox.nextTurn = [userInput]
  relay.fn({ agent, message: userInput })
  assert.deepEqual(calls.removed, ['u-1'], "inputPolicy still 'insert': user input relocated")
  assert.equal(calls.steered.length, 1, 'outer-loop relocation unaffected by noticePolicy')
  console.log("✓ 2 noticePolicy 'queue': notice queued, user-input relay independent")
}

// --- 3. non-interference guards hold for notices ------------------------------
{
  const host = fakeHost({ allGoalsMode: true })
  const relay = relayOf(host)

  // Idle agent: followup already wakes it, relocation is a no-op.
  const idleSess = host.makeSession('s13-idle')
  const { agent: idle, calls: idleCalls } = mkAgent(idleSess, { status: 'idle', queued: [notice] })
  relay.fn({ agent: idle, message: notice })
  assert.equal(idleCalls.removed.length, 0, 'idle agent: untouched')

  // Override off: untouched.
  const offSess = host.makeSession('s13-off')
  offSess.append(MODE_EVENT_TYPE, { enabled: false })
  const { agent: off, calls: offCalls } = mkAgent(offSess, { queued: [notice] })
  relay.fn({ agent: off, message: notice })
  assert.equal(offCalls.removed.length, 0, 'override off: inbox untouched')

  // Delegated child session: untouched.
  const childSess = host.makeSession('s13-child', 's13-on')
  const { agent: child, calls: childCalls } = mkAgent(childSess, { queued: [notice] })
  relay.fn({ agent: child, message: notice })
  assert.equal(childCalls.steered.length, 0, 'delegated child: untouched')

  // Notice that never reached next-turn (already admitted elsewhere).
  const onSess = host.makeSession('s13-on2')
  const { agent: elsewhere, calls: elseCalls } = mkAgent(onSess, { queued: [] })
  relay.fn({ agent: elsewhere, message: notice })
  assert.equal(elseCalls.removed.length, 0, 'not in next-turn: untouched (race-safe)')
  console.log('✓ 3 guards: idle / override-off / child / race-safe all untouched')
}

// --- 4. /cybernetics status reports the notice policy -------------------------
{
  const host = fakeHost({})
  let handler
  host.injections
    .find((i) => i.names.includes('commands'))
    .cb({ ...host.ctx, commands: { register: (d) => { handler = d.handler; return () => {} } } })
  const session = host.makeSession('s13-status')
  const status = handler({ agent: { session }, rawInput: '' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /noticePolicy：insert/, 'status reports noticePolicy (default insert)')
  console.log('✓ 4 /cybernetics status: noticePolicy surfaced')
}

console.log('\nALL v0.13.0 NOTICE-AUTO-INSERT CHECKS PASSED')
