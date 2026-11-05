// Offline harness test for dsh-cybernetics v0.11.0: plan mode × cybernetics
// precedence (docs/plan-precedence.md, design finalized v0.10.0, user ruling
// 2026-11-05). Covers the §5 matrix: planWanted predicate tri-state, guidance
// replacement, both hard-gate layers (assembly filter + tools/pre-execute),
// the exit_plan_mode C1 fallback, and automatic restoration after plan exit.
// Run: node test/plan-precedence.test.ts
//
// The plan projection is NOT registered by this plugin — dsh-plan-mode owns
// it — so the fake host writes plan states directly under the 'plan' key,
// duck-typed exactly like ProjectionsLike in src/sessionMode.ts.

import assert from 'node:assert/strict'
import { apply } from '../src/index.ts'
import { PLAN_PROJECTION_KEY, planWanted } from '../src/sessionMode.ts'

type PlanState = { active?: boolean; wanted?: boolean | null; running?: { wanted?: boolean } | null }

// --- fake host ctx (same shape as test/v09-session-mode.mjs) -----------------
function fakeHost({ allGoalsMode = false, hardGate = false, gateMode }: {
  allGoalsMode?: boolean; hardGate?: boolean; gateMode?: 'allowlist' | 'denylist'
} = {}) {
  const projections = new Map<string, any>()
  const states = new Map<string, Map<object, unknown>>()
  const listeners: Array<{ event: string; fn: (...a: any[]) => unknown }> = []
  const sections: Array<any> = []
  const injections: Array<{ names: string[]; cb: (ctx: any) => void }> = []
  const ctx: any = {
    tools: { register: () => () => {} },
    systemPrompt: {
      section: (s: any) => { sections.push(s); return () => {} },
      getSectionOrder: () => 0,
    },
    goals: { get: () => null },
    workingDirectory: { get: () => '/tmp' },
    agentPresets: { serviceFor: () => undefined },
    agents: { roots: () => [] },
    sessionProjections: {
      register(definition: any) {
        projections.set(definition.key, definition)
        states.set(definition.key, new Map())
        return () => { projections.delete(definition.key) }
      },
      stateOf(session: unknown, key: string) {
        return states.get(key)?.get(session as object)
      },
    },
    on(event: string, fn: (...a: any[]) => unknown) { listeners.push({ event, fn }); return () => {} },
    inject(names: string[], cb: (ctx: any) => void) {
      injections.push({ names, cb })
      cb({ ...ctx, commands: { register: () => () => {} } })
    },
  }
  const cfg: Record<string, unknown> = { allGoalsMode, hardGate }
  if (gateMode !== undefined) cfg.gateMode = gateMode
  apply(ctx, cfg)
  const makeSession = (id: string, parent?: string) => ({
    id,
    header: parent === undefined ? {} : { parentSession: parent },
  })
  return { ctx, projections, states, listeners, sections, injections, makeSession }
}

/** Write a plan projection state for a session (mimics dsh-plan-mode's fold). */
function setPlanState(host: ReturnType<typeof fakeHost>, session: object, state: PlanState): void {
  let perSession = host.states.get(PLAN_PROJECTION_KEY)
  if (perSession === undefined) { perSession = new Map(); host.states.set(PLAN_PROJECTION_KEY, perSession) }
  perSession.set(session, state)
}

const PLAN_ACTIVE: PlanState = { active: true, wanted: true, running: null }
const PLAN_PENDING_RUNNING: PlanState = { active: false, wanted: null, running: { commandId: 'c1', wanted: true } }
const PLAN_PENDING_WANTED: PlanState = { active: false, wanted: true, running: null }
const PLAN_EXITED: PlanState = { active: false, wanted: false, running: null }
const NO_PLAN: PlanState = { active: false, wanted: null, running: null }

const GUIDANCE_NAME = 'tool:cybernetics'
const mkAssembly = () => ({ tools: [{ name: 'bash' }, { name: 'edit' }, { name: 'read' }, { name: 'exit_plan_mode' }, { name: 'cybernetics' }] })

// --- 1. planWanted predicate: tri-state + fail-safe ---------------------------
{
  const host = fakeHost({})
  const s = host.makeSession('s1')
  assert.equal(planWanted(host.ctx, s), false, 'no plan state → false')
  setPlanState(host, s, PLAN_ACTIVE)
  assert.equal(planWanted(host.ctx, s), true, 'active → true')
  setPlanState(host, s, PLAN_PENDING_RUNNING)
  assert.equal(planWanted(host.ctx, s), true, '/plan running → true')
  setPlanState(host, s, PLAN_PENDING_WANTED)
  assert.equal(planWanted(host.ctx, s), true, 'wanted (chosen, pending) → true')
  setPlanState(host, s, PLAN_EXITED)
  assert.equal(planWanted(host.ctx, s), false, 'wanted=false (exit pending) → false')
  setPlanState(host, s, NO_PLAN)
  assert.equal(planWanted(host.ctx, s), false, 'folded no-plan state → false')
  assert.equal(planWanted(host.ctx, undefined), false, 'no session → false')
  assert.equal(planWanted(host.ctx, null), false, 'null session → false')
  assert.equal(planWanted({}, s), false, 'no registry → false')
  const throwing = { sessionProjections: { stateOf: () => { throw new Error('boom') } } }
  assert.equal(planWanted(throwing, s), false, 'stateOf throw → false (fail-safe)')
  const garbage = { sessionProjections: { stateOf: () => 'not-an-object' } }
  assert.equal(planWanted(garbage, s), false, 'malformed state → false')
  assert.equal(PLAN_PROJECTION_KEY, 'plan', 'registry key pinned')
  console.log('✓ 1 planWanted: active/running/wanted tri-state, exit-pending false, fail-safe')
}

// --- 2. §5: plan on × cyb override on × allowlist → guidance replaced ---------
{
  const host = fakeHost({ allGoalsMode: false, hardGate: true })
  const section = host.sections.find((s) => s.name === GUIDANCE_NAME)
  const s = host.makeSession('s2')
  setPlanState(host, s, PLAN_ACTIVE)
  const t = section.text({ agent: { session: s } })
  assert.match(t, /PLAN MODE ACTIVE \(plan precedence over cybernetics\)/)
  assert.match(t, /The hard gate is EXEMPTED for this session/, 'v0.10.0 wording: gate exemption stated')
  assert.ok(!t.includes('ALL-GOALS MODE ACTIVE'), 'ALL-GOALS protocol suspended')
  assert.ok(!t.includes('HARD GATE ACTIVE'), 'hard-gate wording replaced (conflict C3)')
  assert.match(t, /exit_plan_mode/, 'plan approval tool named in guidance')
  assert.match(t, /Do NOT create goals/, 'no-goal rule present')
  console.log('✓ 2 plan on × cyb override on × allowlist: PLAN_PRECEDENCE replaces the whole segment')
}

// --- 3. §5: plan on × inherit global on × allowlist → same precedence ---------
{
  const host = fakeHost({ allGoalsMode: true, hardGate: true })
  const section = host.sections.find((s) => s.name === GUIDANCE_NAME)
  const gate = host.listeners.find((l) => l.event === 'system-prompt/assemble')
  const pre = host.listeners.find((l) => l.event === 'tools/pre-execute')
  const s = host.makeSession('s3') // no /cybernetics override → inherits global on
  setPlanState(host, s, PLAN_ACTIVE)
  const t = section.text({ agent: { session: s } })
  assert.match(t, /PLAN MODE ACTIVE/, 'inherit-global-on session also gets plan precedence')
  assert.ok(!t.includes('ALL-GOALS MODE ACTIVE'))
  // v0.10.0 core: gate passed through — write tools KEPT, exit_plan_mode reachable
  const a = mkAssembly()
  gate.fn(a, { scope: { session: s } }, () => a)
  assert.deepEqual(a.tools.map((x) => x.name), ['bash', 'edit', 'read', 'exit_plan_mode', 'cybernetics'],
    'plan session: assembly filter strips NOTHING (allowlist waived)')
  const d1 = await pre.fn({ agent: { session: s }, name: 'bash' }, async () => ({ kind: 'allow' }))
  assert.equal(d1.kind, 'allow', 'plan session: pre-execute does not deny write tools')
  const d2 = await pre.fn({ agent: { session: s }, name: 'exit_plan_mode' }, async () => ({ kind: 'allow' }))
  assert.equal(d2.kind, 'allow', 'plan session: exit_plan_mode reachable')
  console.log('✓ 3 plan on × inherit global on × allowlist: gate passthrough + exit_plan_mode')
}

// --- 4. §5: plan on × cybernetics on × denylist → writes not denied ------------
{
  const host = fakeHost({ allGoalsMode: true, hardGate: true, gateMode: 'denylist' })
  const gate = host.listeners.find((l) => l.event === 'system-prompt/assemble')
  const pre = host.listeners.find((l) => l.event === 'tools/pre-execute')
  const s = host.makeSession('s4')
  setPlanState(host, s, PLAN_ACTIVE)
  const a = mkAssembly()
  gate.fn(a, { scope: { session: s } }, () => a)
  assert.equal(a.tools.length, 5, 'denylist + plan: planWanted branch runs before filtering')
  const d = await pre.fn({ agent: { session: s }, name: 'edit' }, async () => ({ kind: 'allow' }))
  assert.equal(d.kind, 'allow', 'denylist + plan: edit not denied (v0.10.0 exemption)')
  console.log('✓ 4 plan on × denylist: planWanted exemption before the deny decision, both layers')
}

// --- 5. §5: plan pending (running + wanted) → early switch, no vacuum step -----
{
  const host = fakeHost({ hardGate: true, allGoalsMode: true })
  const section = host.sections.find((s) => s.name === GUIDANCE_NAME)
  const gate = host.listeners.find((l) => l.event === 'system-prompt/assemble')
  const pre = host.listeners.find((l) => l.event === 'tools/pre-execute')
  for (const [name, state] of [['running', PLAN_PENDING_RUNNING], ['wanted', PLAN_PENDING_WANTED]] as const) {
    const s = host.makeSession(`s5-${name}`)
    setPlanState(host, s, state)
    assert.match(section.text({ agent: { session: s } }), /PLAN MODE ACTIVE/, `pending(${name}): guidance already plan`)
    const a = mkAssembly()
    gate.fn(a, { scope: { session: s } }, () => a)
    assert.equal(a.tools.length, 5, `pending(${name}): assembly passthrough`)
    const d = await pre.fn({ agent: { session: s }, name: 'bash' }, async () => ({ kind: 'allow' }))
    assert.equal(d.kind, 'allow', `pending(${name}): pre-execute passthrough`)
  }
  console.log('✓ 5 plan pending (running/wanted): exemption active before the boundary flip')
}

// --- 6. §5: plan exit → same session's next request fully gated again ----------
{
  const host = fakeHost({ hardGate: true, allGoalsMode: true })
  const section = host.sections.find((s) => s.name === GUIDANCE_NAME)
  const gate = host.listeners.find((l) => l.event === 'system-prompt/assemble')
  const pre = host.listeners.find((l) => l.event === 'tools/pre-execute')
  const s = host.makeSession('s6')
  setPlanState(host, s, PLAN_ACTIVE)
  const tBefore = section.text({ agent: { session: s } })
  assert.match(tBefore, /PLAN MODE ACTIVE/)
  // exit_plan_mode approved (or /plan off): projection flips on the boundary
  setPlanState(host, s, PLAN_EXITED)
  const tAfter = section.text({ agent: { session: s } })
  assert.match(tAfter, /never execute task work/i, 'guidance: IMPLICIT restored')
  assert.match(tAfter, /ALL-GOALS MODE ACTIVE/, 'guidance: ALL-GOALS restored (inherit global on)')
  assert.match(tAfter, /HARD GATE ACTIVE/, 'guidance: hard-gate segment restored')
  assert.ok(!tAfter.includes('PLAN MODE ACTIVE'))
  const a = mkAssembly()
  gate.fn(a, { scope: { session: s } }, () => a)
  assert.deepEqual(a.tools.map((x) => x.name), ['read', 'exit_plan_mode', 'cybernetics'],
    'allowlist filters write tools again after plan exit (exit_plan_mode stays whitelisted: C1 fallback)')
  const d = await pre.fn({ agent: { session: s }, name: 'bash' }, async () => ({ kind: 'allow' }))
  assert.equal(d.kind, 'deny', 'pre-execute denies bash again after plan exit')
  // /plan off mid-flight: wanted=false, not yet active=false → same restore
  setPlanState(host, s, PLAN_EXITED)
  assert.equal(planWanted(host.ctx, s), false, 'wanted=false is already restore state')
  console.log('✓ 6 plan exit (approval //plan off): next request re-gated, zero recovery logic')
}

// --- 7. §5/C4: plan on × cyb override OFF → pure plan (no cybernetics segment) -
{
  const host = fakeHost({ hardGate: true, allGoalsMode: true })
  const section = host.sections.find((s) => s.name === GUIDANCE_NAME)
  const pre = host.listeners.find((l) => l.event === 'tools/pre-execute')
  const s = host.makeSession('s7')
  host.states.get('cyberneticsMode')!.set(s, { override: false })
  setPlanState(host, s, PLAN_ACTIVE)
  const t = section.text({ agent: { session: s } })
  assert.equal(t, '', 'override off still wins: empty cybernetics guidance (pure plan behavior, C4)')
  const d = await pre.fn({ agent: { session: s }, name: 'bash' }, async () => ({ kind: 'allow' }))
  assert.equal(d.kind, 'allow', 'override off → gate passthrough (pre-existing v0.9.0 behavior)')
  console.log('✓ 7 /cybernetics off × plan: pure plan behavior preserved (regression C4)')
}

// --- 8. §5: plan off × cyb override on → full cybernetics (no-plan regression) -
{
  const host = fakeHost({ hardGate: true, allGoalsMode: false })
  const section = host.sections.find((s) => s.name === GUIDANCE_NAME)
  const s = host.makeSession('s8')
  host.states.get('cyberneticsMode')!.set(s, { override: true })
  setPlanState(host, s, NO_PLAN)
  const t = section.text({ agent: { session: s } })
  assert.match(t, /ALL-GOALS MODE ACTIVE/, 'override on without plan: full orchestration guidance')
  assert.ok(!t.includes('PLAN MODE ACTIVE'))
  // inherit global off
  const host2 = fakeHost({ hardGate: true, allGoalsMode: false })
  const section2 = host2.sections.find((x) => x.name === GUIDANCE_NAME)
  const s2 = host2.makeSession('s8b')
  setPlanState(host2, s2, NO_PLAN)
  const t2 = section2.text({ agent: { session: s2 } })
  assert.ok(!t2.includes('ALL-GOALS MODE ACTIVE'), 'global off, no plan: no ALL-GOALS (pre-existing)')
  console.log('✓ 8 plan off × cyb on / global off: cybernetics semantics restored (regression)')
}

// --- 9. planWanted detection failure → C1 fallback keeps approval alive --------
{
  // allowlist deployment, session WITHOUT any plan projection state (plan-mode
  // unmounted / key renamed / read error): write tools must be gated as usual,
  // but exit_plan_mode must still pass BOTH layers (allowlist entry + explicit
  // dispatch next()).
  const host = fakeHost({ hardGate: true, allGoalsMode: true })
  const section = host.sections.find((s) => s.name === GUIDANCE_NAME)
  const gate = host.listeners.find((l) => l.event === 'system-prompt/assemble')
  const pre = host.listeners.find((l) => l.event === 'tools/pre-execute')
  const s = host.makeSession('s9')
  const t = section.text({ agent: { session: s } })
  assert.match(t, /HARD GATE ACTIVE/, 'no plan state: normal hard-gate guidance')
  const a = mkAssembly()
  gate.fn(a, { scope: { session: s } }, () => a)
  assert.deepEqual(a.tools.map((x) => x.name), ['read', 'exit_plan_mode', 'cybernetics'],
    'no plan state: write tools stripped, but exit_plan_mode survives via the allowlist entry')
  const d1 = await pre.fn({ agent: { session: s }, name: 'exit_plan_mode' }, async () => ({ kind: 'allow' }))
  assert.equal(d1.kind, 'allow', 'no plan state: dispatch explicitly passes exit_plan_mode (C1 fallback)')
  const d2 = await pre.fn({ agent: { session: s }, name: 'bash' }, async () => ({ kind: 'allow' }))
  assert.equal(d2.kind, 'deny', 'no plan state: bash still denied (fallback is scoped, not a hole)')
  console.log('✓ 9 planWanted failure: exit_plan_mode never double-killed, gate otherwise intact')
}

// --- 10. exit_plan_mode approval → next step: goal-loop semantics resume -------
{
  // Simulates the §2 relay: projection active=false lands on the boundary; the
  // very next request must see cybernetics guidance + gate (acceptance §6.2).
  const host = fakeHost({ hardGate: true, allGoalsMode: true })
  const section = host.sections.find((s) => s.name === GUIDANCE_NAME)
  const gate = host.listeners.find((l) => l.event === 'system-prompt/assemble')
  const s = host.makeSession('s10')
  setPlanState(host, s, PLAN_ACTIVE)
  assert.match(section.text({ agent: { session: s } }), /PLAN MODE ACTIVE/)
  setPlanState(host, s, { active: false, wanted: false, running: null }) // onBoundary flip
  const a = mkAssembly()
  gate.fn(a, { scope: { session: s } }, () => a)
  assert.deepEqual(a.tools.map((x) => x.name), ['read', 'exit_plan_mode', 'cybernetics'],
    'post-approval: gate per its configured state again (exit_plan_mode whitelisted by design)')
  assert.match(section.text({ agent: { session: s } }), /ALL-GOALS MODE ACTIVE/,
    'post-approval: implementation requests route through the goal loop again')
  console.log('✓ 10 approval → boundary flip → automatic cybernetics restoration, no extra wiring')
}

// --- 11. "keep planning" (rejection) → exemption persists ----------------------
{
  const host = fakeHost({ hardGate: true, allGoalsMode: true })
  const section = host.sections.find((s) => s.name === GUIDANCE_NAME)
  const pre = host.listeners.find((l) => l.event === 'tools/pre-execute')
  const s = host.makeSession('s11')
  setPlanState(host, s, PLAN_ACTIVE)
  // keep planning: pendingIntents not cleared, projection NOT flipped
  assert.match(section.text({ agent: { session: s } }), /PLAN MODE ACTIVE/, 'still plan guidance')
  const d = await pre.fn({ agent: { session: s }, name: 'bash' }, async () => ({ kind: 'allow' }))
  assert.equal(d.kind, 'allow', 'still exempted')
  console.log('✓ 11 keep planning: exemption + plan guidance persist until a real exit')
}

// --- 12. hardGate=false deployment: zero behavior change ------------------------
{
  const host = fakeHost({ hardGate: false, allGoalsMode: true })
  const gate = host.listeners.find((l) => l.event === 'system-prompt/assemble')
  const pre = host.listeners.find((l) => l.event === 'tools/pre-execute')
  assert.equal(gate, undefined, 'hardGate=false: no assembly listener installed')
  assert.equal(pre, undefined, 'hardGate=false: no pre-execute listener installed')
  const section = host.sections.find((s) => s.name === GUIDANCE_NAME)
  const sPlan = host.makeSession('s12a')
  setPlanState(host, sPlan, PLAN_ACTIVE)
  assert.ok(!section.text({ agent: { session: sPlan } }).includes('PLAN MODE ACTIVE') === false,
    'plan precedence guidance is gate-independent (still shown)')
  const sNoPlan = host.makeSession('s12b')
  setPlanState(host, sNoPlan, PLAN_ACTIVE)
  const t = section.text({ agent: { session: sNoPlan } })
  assert.match(t, /PLAN MODE ACTIVE/)
  assert.ok(!t.includes('HARD GATE ACTIVE'), 'gate off: no hard-gate wording, plan section only')
  console.log('✓ 12 hardGate=false: plan precedence guidance works, no gate listeners exist')
}

console.log('\nALL v0.11.0 PLAN-PRECEDENCE CHECKS PASSED')
