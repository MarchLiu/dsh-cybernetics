// Real-host probe for the dynamic /cybernetics input hint (v0.14.0).
//
// Runs the REAL deployed harness command registry (@deepseek-ai/dsh-commands
// CommandRuntime over the REAL cordis from the DSH web profile) plus the
// plugin's REAL apply() wiring, and asserts against the registry's own
// `commands.list(agent)` — the exact descriptor surface the Web composer menu
// renders — that:
//   1. the advertised input.hint is '[on|status|use]' while cybernetics is off,
//   2. /cybernetics on re-advertises '[off|status|use]' (via the registry's
//      commands/change invalidation path),
//   3. redundant on/off stay accepted with kind:'success' (the hint narrows
//      the display, never the grammar),
//   4. status works in both states.
//
// Requires the local DSH web profile; skips (exit 0) when absent so the
// offline suite stays portable. This does NOT verify the running GUI process
// (host restart required for that) — it verifies the real harness contract.
// Run: node test/commands-hint-probe.mjs

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const profile = process.env.DSH_PROFILE_DIR
  ?? (process.env.DSH_PROFILE?.startsWith('/') ? process.env.DSH_PROFILE : undefined)
  ?? '/Users/mars/.dsh/profiles/web'
const hostModules = join(profile, 'node_modules', '@deepseek-ai')
const cordisPath = join(hostModules, 'cordis', 'lib', 'index.js')
const commandsPath = join(hostModules, 'dsh-commands', 'lib', 'index.js')

if (!existsSync(cordisPath) || !existsSync(commandsPath)) {
  console.log(`SKIP commands-hint-probe: host packages not found under ${hostModules}`)
  process.exit(0)
}

const { Context } = await import(pathToFileURL(cordisPath).href)
const { CommandRuntime } = await import(pathToFileURL(commandsPath).href)
const { apply } = await import(pathToFileURL(fileURLToPath(new URL('../src/index.ts', import.meta.url))).href)
const { MODE_EVENT_TYPE, MODE_PROJECTION_KEY, cyberneticsModeProjection }
  = await import(pathToFileURL(fileURLToPath(new URL('../src/sessionMode.ts', import.meta.url))).href)
const { setRecordAppender: setAppender }
  = await import(pathToFileURL(fileURLToPath(new URL('../src/projection.ts', import.meta.url))).href)

// --- real ctx + real command registry ---------------------------------------
const ctx = new Context()
ctx.plugin(CommandRuntime)
// Class-plugin activation is async: wait until the 'commands' service is live.
for (let i = 0; ctx.commands === undefined && i < 100; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
if (ctx.commands === undefined) throw new Error('commands service did not start')

// Stubs for faces the real test ctx does not carry (apply() needs them to
// activate, but none are under test here).
const sections = []
const tools = []
ctx.tools = { register: (d) => { tools.push(d); return () => {} } }
ctx.systemPrompt = {
  section: (s) => { sections.push(s); return () => {} },
  getSectionOrder: () => 0,
}

// Fake projection registry: folds the per-session mode override exactly like
// the host registry (stateOf is synchronous after append). The real plugin
// reads overrides through this face — the same duck-typed seam sessionMode.ts
// documents.
const modeUnit = cyberneticsModeProjection()
const perSession = new Map()
ctx.sessionProjections = {
  register: () => () => {},
  stateOf(session, key) {
    if (key !== MODE_PROJECTION_KEY) return undefined
    return perSession.get(session)
  },
}

// Sessions fold mode records on append (any other type is ignored by the unit).
function fakeSession(id) {
  const events = []
  const session = {
    id,
    header: { id },
    append(type, data) {
      events.push({ type, data })
      if (type === MODE_EVENT_TYPE) {
        perSession.set(session, modeUnit.apply(perSession.get(session) ?? modeUnit.init(), { type, data }))
      }
      return events.length - 1
    },
    appendPluginRecord(type, data) { return session.append(type, data) },
    events,
  }
  return session
}

setAppender((target, type, data) => { target.append(type, data) })

apply(ctx, { allGoalsMode: false, hardGate: false })

// The command registration rides ctx.inject(['commands']); after apply() the
// service must carry exactly one live 'cybernetics' descriptor.
const commands = ctx.commands
const agent = { id: 'probe-agent' }
const session = fakeSession('probe-session')
agent.session = session

const hintOf = () => {
  const row = commands.list(agent).find((c) => c.name === 'cybernetics')
  assert.ok(row, '/cybernetics listed for the agent')
  return row.input?.hint
}
// Wait for the inject(['commands']) child to activate its registration.
for (let i = 0; !commands.list(agent).some((c) => c.name === 'cybernetics') && i < 200; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
const run = (rawInput) => commands.execute(agent, `/cybernetics ${rawInput}`.trim(), [], AbortSignal.timeout(5000))

// 1. global off, no override → hint offers `on`
assert.equal(hintOf(), '[on|status|use]', `initial hint (global off) — got ${JSON.stringify(hintOf())}`)
console.log('✓ 1 initial hint (global off): [on|status|use]')

// 2. on → success + re-advertised hint [off|status]
const on1 = await run('on')
assert.equal(on1.result.kind, 'success', 'on succeeds')
assert.equal(hintOf(), '[off|status|use]', 'control mode hint: [off|status|use]')
console.log('✓ 2 /cybernetics on → registry hint flips to [off|status|use]')

// 3. redundant on → idempotent success, hint stable
const on2 = await run('on')
assert.equal(on2.result.kind, 'success', 'redundant on is accepted without error')
assert.equal(hintOf(), '[off|status|use]', 'redundant on keeps the hint')
console.log('✓ 3 redundant on in control mode: success, hint unchanged')

// 4. status works in control mode
const st1 = await run('status')
assert.equal(st1.result.kind, 'success', 'status usable in control mode')
assert.match(st1.result.text, /override：on/, 'status reports the stored override')

// 5. off → hint returns to [on|status]
const off1 = await run('off')
assert.equal(off1.result.kind, 'success', 'off succeeds')
assert.equal(hintOf(), '[on|status|use]', 'control-off hint: [on|status|use]')

// 6. redundant off → idempotent success, hint stable
const off2 = await run('off')
assert.equal(off2.result.kind, 'success', 'redundant off is accepted without error')
assert.equal(hintOf(), '[on|status|use]', 'redundant off keeps the hint')

// 7. status works without control mode
const st2 = await run('STATUS')
assert.equal(st2.result.kind, 'success', 'status usable outside control mode')
assert.match(st2.result.text, /override：off/, 'status reports the stored override')

console.log('✓ 4 off → [on|status|use]; redundant off + status fine in both states')

setAppender(undefined)
console.log('ALL COMMANDS-HINT REAL-HOST CHECKS PASSED')
