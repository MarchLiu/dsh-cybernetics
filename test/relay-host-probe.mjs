// Host-chain probe for the v0.8.5 gateApprovalRelay last hop.
//
// Runs the REAL host pieces this plugin has to cooperate with — the cordis
// waterfall (outermost-first dispatch) and dsh-user-approval's ApprovalService
// (policy fold, open-turn precondition, approval/asked+approval/decided audit
// pair) — plus the plugin's REAL apply() wiring, and a simulated api-remotes
// forwarder that behaves like the browser: it answers a request for the
// TOP-LEVEL session (the panel the user watches) and hangs forever on one for
// a delegated child (the hidden per-session panel that claims the request and
// never delegates).
//
// It requires the local DSH web profile; when absent it skips (exit 0) so the
// offline suite stays portable. DSH_PROFILE_DIR is the absolute host profile
// path (DSH_PROFILE is only a profile *name*, e.g. "web").
// Run: node test/relay-host-probe.mjs

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const profile = process.env.DSH_PROFILE_DIR
  ?? (process.env.DSH_PROFILE?.startsWith('/') ? process.env.DSH_PROFILE : undefined)
  ?? '/Users/mars/.dsh/profiles/web'
const hostModules = join(profile, 'node_modules', '@deepseek-ai')
const approvalPath = join(hostModules, 'dsh-user-approval', 'lib', 'index.js')
const cordisPath = join(hostModules, 'cordis', 'lib', 'index.js')

if (!existsSync(approvalPath) || !existsSync(cordisPath)) {
  console.log(`SKIP relay-host-probe: host packages not found under ${hostModules}`)
  process.exit(0)
}

const { Context } = await import(pathToFileURL(cordisPath).href)
const { ApprovalService } = await import(pathToFileURL(approvalPath).href)
const { apply } = await import(pathToFileURL(fileURLToPath(new URL('../src/index.ts', import.meta.url))).href)

/** Minimal Session: append/eventAt/seq semantics the ApprovalService folds. */
function fakeSession(id, { openTurn = true, parentSession, origin, delegationDepth } = {}) {
  const events = []
  const session = {
    header: {
      id,
      ...(parentSession === undefined ? {} : { parentSession }),
      ...(origin === undefined ? {} : { origin }),
      ...(delegationDepth === undefined ? {} : { delegationDepth }),
    },
    get seq() { return events.length },
    append(type, data) { events.push({ type, data }); return events.length - 1 },
    eventAt(seq) { return events[Number(seq)] },
    events,
  }
  if (openTurn) session.append('turn/start', { turn: 1 })
  else session.append('turn/end', { turn: 1, reason: 'completed' })
  return session
}

const agentOf = (id, session) => ({ id, session, ctx: undefined })

const service = new ApprovalService(new Context(), { policy: 'ask' })
const rootCtx = service.ctx

// Registration order is what the real host has: api-remotes registers its
// approval/request forwarder at boot, BEFORE every user plugin.
const clientSeen = []
const rootOutcomes = new Map([['session-root', 'allowed-once']]) // the user's click per session
rootCtx.on('approval/request', (req) => {
  clientSeen.push({ agentId: req.agent?.id, toolName: req.toolName, callId: req.callId })
  const outcome = rootOutcomes.get(req.agent?.id)
  if (outcome !== undefined) return outcome // the watched conversation's panel answers
  return new Promise(() => {}) // invisible child panel claims + never delegates
})

// The plugin, wired exactly as in production (its relay is prepend:true).
const rootAgent = agentOf('session-root', fakeSession('session-root'))
const midAgent = agentOf('session-mid', fakeSession('session-mid', { parentSession: 'session-root', origin: 'subagent', delegationDepth: 1 }))
const childAgent = agentOf('session-child', fakeSession('session-child', { parentSession: 'session-mid', origin: 'subagent', delegationDepth: 2 }))
const live = new Map([['session-root', rootAgent], ['session-mid', midAgent], ['session-child', childAgent]])
let asked = null
const stubCtx = {
  tools: { register: () => () => {} },
  systemPrompt: { section() {}, getSectionOrder: () => 0 },
  goals: { get: () => null },
  workingDirectory: { get: () => process.cwd() },
  agentPresets: { serviceFor: () => undefined },
  agents: { get: (id) => live.get(id), roots: () => [rootAgent] },
  get: (name) => name === 'approval' ? service : undefined,
  userQuestions: { ask: async (request) => { asked = request; return { answers: [{ id: request.questions[0].id, selected: ['允许一次（Allow once）'] }] } } },
  on: (event, fn, options) => rootCtx.on(event, fn, options),
}
apply(stubCtx, { hardGate: true })

// 1) Delegated-child escalation: the child's ApprovalService ask resolves
//    through the relay onto the TOP-LEVEL session's native approval channel.
const childSignal = new AbortController().signal
const outcome = await service.request({
  agent: childAgent,
  toolName: 'write',
  reason: 'write ~/.dsh/profiles/web/cordis.patch.yml',
  signal: childSignal,
})
assert.equal(outcome, 'allowed-once', 'child escalation is granted only after the top-level user approves')
assert.equal(clientSeen.length, 1, 'exactly one request reached the browser: the top-level one')
assert.equal(clientSeen[0].agentId, 'session-root', 'the browser saw the request on the watched session, not the child')
assert.equal(clientSeen[0].callId, undefined, 'no child callId crossed into the parent session')
assert.ok(childAgent.session.events.some((e) => e.type === 'approval/asked' && e.data.toolName === 'write'))
assert.ok(childAgent.session.events.some((e) => e.type === 'approval/decided' && e.data.outcome === 'allowed-once'))
const rootAsked = rootAgent.session.events.find((e) => e.type === 'approval/asked')
assert.ok(rootAsked, 'the top-level session logs approval/asked (durable audit of the relayed request)')
assert.match(rootAsked.data.reason, /sub-agent session-child/)
assert.ok(rootAgent.session.events.some((e) => e.type === 'approval/decided' && e.data.outcome === 'allowed-once'))

// 2) Parent turn closed → ApprovalService.request refuses (open-turn
//    precondition); relay falls back to the question channel on the same agent.
asked = null
const idleRoot = agentOf('session-root-idle', fakeSession('session-root-idle', { openTurn: false }))
live.set('session-root-idle', idleRoot)
const idleChild = agentOf('session-child-2', fakeSession('session-child-2', { parentSession: 'session-root-idle', origin: 'subagent', delegationDepth: 1 }))
live.set('session-child-2', idleChild)
const idleOutcome = await service.request({ agent: idleChild, toolName: 'bash', reason: 'outside workspace' })
assert.equal(idleOutcome, 'allowed-once', 'question-channel fallback still reaches the user')
assert.equal(asked?.agent, idleRoot, 'fallback asks the same top-level agent')

// 3) Top-level user rejects → the child receives an explicit rejection.
clientSeen.length = 0
const rejectRoot = agentOf('session-root-reject', fakeSession('session-root-reject'))
live.set('session-root-reject', rejectRoot)
rootOutcomes.set('session-root-reject', 'rejected')
const rejectChild = agentOf('session-child-3', fakeSession('session-child-3', { parentSession: 'session-root-reject', origin: 'subagent', delegationDepth: 1 }))
live.set('session-child-3', rejectChild)
const rejectOutcome = await service.request({ agent: rejectChild, toolName: 'bash', reason: 'outside workspace' })
assert.equal(rejectOutcome, 'rejected', 'a top-level rejection reaches the child as an explicit rejected outcome')
assert.equal(clientSeen.length, 1, 'only the top-level rejection reached the browser')
assert.equal(clientSeen[0].agentId, 'session-root-reject')

// 4) v0.8.8 design-gap fix: the native panel answering 'unavailable' (no
//    answering client claimed the frame — the live failure was asked →
//    decided unavailable in 9 ms) is NOT terminal; the relay falls through to
//    the visible question card, and a debug log line names the path, outcome,
//    resolved root and elapsed time.
asked = null
const relayLogs = []
const origDebug = console.debug
console.debug = (...args) => { relayLogs.push(args.map(String).join(' ')) }
try {
  const uaRoot = agentOf('session-root-ua', fakeSession('session-root-ua'))
  live.set('session-root-ua', uaRoot)
  rootOutcomes.set('session-root-ua', 'unavailable') // no answering client
  const uaChild = agentOf('session-child-ua', fakeSession('session-child-ua', { parentSession: 'session-root-ua', origin: 'subagent', delegationDepth: 1 }))
  live.set('session-child-ua', uaChild)
  const uaOutcome = await service.request({ agent: uaChild, toolName: 'write', reason: 'outside workspace' })
  assert.equal(uaOutcome, 'allowed-once', 'native unavailable still reaches the user through the question card')
  assert.equal(asked?.agent, uaRoot, 'the question card targets the top-level agent')
  const qa = uaChild.session.events.find((e) => e.type === 'approval/decided')
  assert.equal(qa?.data?.outcome, 'allowed-once', 'the child audit records the granted outcome, not a bare unavailable')
  assert.ok(
    relayLogs.some((l) => l.includes('approval-relay') && l.includes('path=question-card') && l.includes('outcome=allowed-once') && l.includes('root=session-root-ua') && l.includes('elapsed=')),
    'debug log records path/outcome/resolved-root/elapsed for the question-card hop')
} finally {
  console.debug = origDebug
}

// 5) v0.8.9 ROOT-CAUSE FIX: on the REAL host the plugin context is a cordis
//    proxy whose plain property access for a non-injected service THROWS
//    ("cannot get property ... without inject", cordis/lib/index.js:88-96) —
//    the live v0.8.8 failure. The relay must resolve the service through
//    ctx.get('userQuestions') (the inject-free reflective read dsh-plan-mode
//    uses), and persist every decision to <workspace>/.cybernetics/
//    relay-log.jsonl so acceptance can read the path/outcome without host
//    stdout or browser console access.
{
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const ws = mkdtempSync(join(tmpdir(), 'relay-log-'))
  let asked5 = null
  const uq5 = { ask: async (request) => { asked5 = request; return { answers: [{ id: request.questions[0].id, selected: ['允许一次（Allow once）'] }] } } }
  // cordis-faithful stub: property READ of 'userQuestions' throws like the
  // real proxy; only get(name) serves the service store.
  const throwCtx = {
    tools: { register: () => () => {} },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null },
    workingDirectory: { get: () => ws },
    agentPresets: { serviceFor: () => undefined },
    agents: { get: (id) => live.get(id), roots: () => [rootAgent] },
    get: (name) => name === 'approval' ? service : name === 'userQuestions' ? uq5 : undefined,
    on: (event, fn, options) => rootCtx.on(event, fn, options),
  }
  Object.defineProperty(throwCtx, 'userQuestions', {
    get() { throw new Error('cannot get property "userQuestions" without inject') },
  })
  apply(throwCtx, { hardGate: true })
  rootOutcomes.set('session-root-noinj', 'unavailable') // native panel: no answering client
  const noinjRoot = agentOf('session-root-noinj', fakeSession('session-root-noinj'))
  live.set('session-root-noinj', noinjRoot)
  const noinjChild = agentOf('session-child-noinj', fakeSession('session-child-noinj', { parentSession: 'session-root-noinj', origin: 'subagent', delegationDepth: 1 }))
  live.set('session-child-noinj', noinjChild)
  const noinjOutcome = await service.request({ agent: noinjChild, toolName: 'write', reason: 'outside workspace' })
  assert.equal(noinjOutcome, 'allowed-once', 'property-throw ctx still reaches the question card via ctx.get')
  assert.equal(asked5?.agent, noinjRoot, 'ctx.get-resolved service asked the top-level agent')
  // await the fire-and-forget append: poll the persisted log
  let logLines = []
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 20))
    try {
      logLines = readFileSync(join(ws, '.cybernetics', 'relay-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    } catch { /* not yet */ }
    if (logLines.length > 0) break
  }
  assert.ok(logLines.length > 0, 'relay-log.jsonl persisted under <workspace>/.cybernetics/')
  const last = JSON.parse(logLines[logLines.length - 1])
  assert.equal(last.root, 'session-root-noinj')
  assert.equal(last.path, 'question-card')
  assert.equal(last.outcome, 'allowed-once')
  assert.ok(typeof last.elapsedMs === 'number' && typeof last.ts === 'string', 'entry carries ts/outcome/path/elapsedMs')
}

console.log('✓ relay-host-probe: real cordis waterfall + real ApprovalService + real plugin apply() — child escalation surfaces on the top-level session panel (child panel never claims), open-turn fallback asks the same agent, top-level rejection reaches the child explicitly, native unavailable falls through to the visible question card with debug logging, cordis property-throw ctx still reaches the card via ctx.get, and every decision persists to .cybernetics/relay-log.jsonl')
