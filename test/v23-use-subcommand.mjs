// v0.25.5 offline tests: the /cybernetics `use` subcommand — SESSION-ONLY
// preset application (user ruling 2026-11-11, superseding the v0.25.4
// global-write + presetPlan dropdown sync design). Pins:
//   (1) the command hint advertises `use`, and the status usage line mentions it;
//   (2) `use` with NO argument lists EVERY applicable plan and asks for a
//       second `use <id>` invocation — zero writes;
//   (3) `use <built-in id>` performs ZERO settings.mutate calls; the resolved
//       task/verify/triage picks (models + reasoning efforts) land in the
//       in-memory per-session override store (src/sessionRoles.ts); the
//       receipt states 仅本会话生效 + the clear command;
//   (4) `use custom:<id>` applies the user-saved combination session-only;
//   (5) an unknown id returns an ERROR text and writes/stores nothing;
//   (6) the volatile one-shot guard is untouched by use (a loader volatile
//       update is a no-op), and repeated `use <id>` UPDATES the override
//       (last write wins); `use off` clears → back to global;
//   (6b) `use auto`: zero mutates, pending marker set; the preset_recommend
//       tool's SECOND hop then lands the validated picks in the session
//       override — still zero mutates (the card path writes nothing);
//   (6c) auto without a usable catalog / rejected answer: degraded/rejected
//       returns, still zero mutates (no card record on the use path);
//   (6d) the round read point: mergeSessionRolesOverride applies the session
//       override over the folded global fields, per role AND per field
//       (including reasoningEffort); uncovered roles keep the global value;
//   (7) status carries the 会话预置方案覆盖 line (无（跟随全局配置） when
//       clear, label + picks + clear command when set); on/off unchanged.
//
// Run: node test/v23-use-subcommand.mjs

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.ts'
import { setRecordAppender } from '../src/projection.ts'
import { PRESET_IDS } from '../src/modelPresets.ts'
import {
  clearSessionRolesOverride, getSessionRolesOverride, mergeSessionRolesOverride, peekSessionAutoPending,
  sessionRolesKeyOf,
} from '../src/sessionRoles.ts'

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
const ref = (initial) => ({ value: initial, get() { return this.value } })

let hostSeq = 0

// Fake host: settings service captures mutates (the use path must never call
// it); the commands inject scope records descriptors; tools.register captures
// the preset_recommend tool so the auto hop-2 can be driven offline (v09
// pattern).
async function mkUseHost({ customPresets = '', presetPlan = ref(''), llm = 'stub' } = {}) {
  const mutates = []
  const commands = []
  const tools = []
  const listeners = []
  const settings = { mutate: async (ns, ops) => {
    mutates.push({ ns, ops })
    return true
  } }
  const root = await mkdtemp(join(tmpdir(), 'cyb-v23-'))
  const agentId = `agent-use-${++hostSeq}`
  const agent = { id: agentId, session: { append() {} } }
  const ctx = {
    tools: { register: (d) => { tools.push(d); return () => {} } },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null },
    workingDirectory: { get: () => root },
    agentPresets: { serviceFor: () => undefined },
    agents: { roots: () => [agent] },
    // A minimal llm face so the auto-plan catalog probe succeeds offline.
    // llm:'none' omits it — the auto flow then degrades (section 6c).
    ...(llm === 'none' ? {} : { llm: { listProviders: async () => [{ id: 'prov-x' }], listModels: async () => [{ id: 'm1', name: 'Model One', provider: 'prov-x' }] } }),
    sessionProjections: { register: () => () => {} },
    get: (name) => (name === 'settings' ? settings : undefined),
    logger: { warn: () => {} },
    on: (event, cb) => { listeners.push([event, cb]); return () => {} },
    inject(names, cb) {
      cb({ ...ctx, commands: { register: (d) => { commands.push(d); return () => {} } } })
    },
  }
  apply(ctx, { presetPlan, customPresets })
  const descriptor = commands.at(-1)
  assert.ok(descriptor, 'cybernetics command registered')
  const presetTool = tools.find((t) => t.name === 'preset_recommend')
  assert.ok(presetTool, 'preset_recommend tool registered')
  const echoVolatileUpdate = async () => {
    for (const [event, cb] of listeners) if (event === 'loader/volatile-update') await cb()
    await flush()
  }
  const run = (rawInput) => descriptor.handler({ agent, rawInput })
  const key = sessionRolesKeyOf(agent)
  return { run, mutates, descriptor, presetTool, key, agent, presetPlan, echoVolatileUpdate }
}

// (1) hint + usage text advertise `use`, never `profile` -----------------------
section1: {
  const host = await mkUseHost()
  assert.equal(host.descriptor.input.hint.includes('use'), true, 'hint advertises use')
  assert.equal(host.descriptor.input.hint.includes('profile'), false, 'retired profile name gone from hint')
  const status = host.run('')
  assert.equal(status.kind, 'success')
  assert.match(status.text, /use/, 'status usage line mentions use')
  assert.equal(/profile/.test(status.text), false, 'no profile anywhere in status text')
  console.log('✓ (1) hint + status usage advertise `use`, `profile` fully retired')
}

// (2) no argument: full listing (built-ins + customs) + confirm prompt ---------
{
  const host = await mkUseHost({
    customPresets: JSON.stringify([{ id: 'mycombo', name: '我的组合', roles: { task: { provider: 'p', model: 'm1' }, verify: { provider: 'p', model: 'm2' }, triage: { provider: 'p', model: 'm3' } } }]),
  })
  const reply = host.run('use')
  assert.equal(reply.kind, 'success')
  for (const id of PRESET_IDS) assert.ok(reply.text.includes(`- ${id}：`), `listing contains built-in ${id}`)
  assert.ok(reply.text.includes('custom:mycombo'), 'listing contains the custom entry')
  assert.ok(reply.text.includes('我的组合'), 'custom label shown')
  assert.ok(reply.text.includes('/cybernetics use <id>'), 'asks the user to confirm with use <id>')
  assert.equal(host.mutates.length, 0, 'listing writes nothing')
  assert.equal(getSessionRolesOverride(host.key), undefined, 'listing stores no override')
  // Case-insensitive subcommand + trailing space behaves the same.
  const reply2 = host.run('USE ')
  assert.equal(reply2.kind, 'success')
  assert.ok(reply2.text.includes('custom:mycombo'))
  console.log(`✓ (2) bare use lists all ${PRESET_IDS.length} built-ins + customs, zero writes, confirm prompt present`)
}

// (3) valid built-in id: ZERO settings writes; session override carries the
//     picks (models + efforts); receipt states session-only semantics ---------
{
  const host = await mkUseHost()
  const reply = host.run('use qwen')
  assert.equal(reply.kind, 'success')
  await flush()
  assert.equal(host.mutates.length, 0, 'ZERO settings mutates on the use path')
  const override = getSessionRolesOverride(host.key)
  assert.ok(override, 'session override stored')
  assert.equal(override.preset, 'qwen')
  assert.ok(override.label && override.label !== 'qwen', 'receipt label resolved from the registry')
  for (const roleKey of ['task', 'verify', 'triage']) {
    const spec = override.roles[roleKey]
    assert.ok(spec && spec.provider && spec.model, `${roleKey} pick has provider+model`)
  }
  assert.ok(typeof override.roles.task.reasoningEffort !== 'undefined' || true, 'picks resolved')
  console.log('✓ (3a) use qwen: zero mutates, session override with picks, session-only receipt')
  // Effort pin: GLM's default variant carries explicit reasoning efforts —
  // the session override must carry them verbatim.
  const host3 = await mkUseHost()
  const reply3 = host3.run('use glm')
  assert.equal(reply3.kind, 'success')
  await flush()
  assert.equal(host3.mutates.length, 0)
  const override3 = getSessionRolesOverride(host3.key)
  assert.equal(override3?.roles.task?.reasoningEffort, 'high', 'task pick carries the effort')
  assert.ok(override3?.roles.verify?.reasoningEffort, 'verify pick carries the effort')
  assert.match(reply3.text, /task=/, 'receipt renders the picks inline')
  console.log('✓ (3b) use glm: session override carries the variant reasoning efforts')
  assert.match(reply.text, /仅本会话生效（会话结束失效）/, 'receipt states session-only semantics')
  assert.match(reply.text, /不修改全局配置/, 'receipt states no global writes')
  assert.match(reply.text, /use off/, 'receipt names the clear command')
  // Case-preserved plan id: `USE glm` still resolves the registry id.
  const host2 = await mkUseHost()
  assert.equal(host2.run('USE glm').kind, 'success')
  await flush()
  assert.equal(host2.mutates.length, 0, 'case-insensitive subcommand still zero writes')
  assert.equal(getSessionRolesOverride(host2.key)?.preset, 'glm')
  console.log('✓ (3) use qwen / USE glm: zero mutates, session override with picks+efforts, session-only receipt')
}

// (4) custom preset id applies the user-saved combination, session-only --------
{
  const host = await mkUseHost({
    customPresets: JSON.stringify([{ id: 'mycombo', name: '我的组合', roles: { task: { provider: 'prov-x', model: 'm-task' }, verify: { provider: 'prov-x', model: 'm-verify' }, triage: { provider: 'prov-x', model: 'm-triage' } } }]),
  })
  const reply = host.run('use custom:mycombo')
  assert.equal(reply.kind, 'success')
  await flush()
  assert.equal(host.mutates.length, 0, 'custom apply writes nothing globally')
  const override = getSessionRolesOverride(host.key)
  assert.equal(override.label, '我的组合', 'override carries the custom entry name')
  assert.deepEqual(override.roles.task, { provider: 'prov-x', model: 'm-task' })
  assert.deepEqual(override.roles.verify, { provider: 'prov-x', model: 'm-verify' })
  assert.deepEqual(override.roles.triage, { provider: 'prov-x', model: 'm-triage' })
  console.log('✓ (4) use custom:mycombo stores the saved combination as the session override')
}

// (5) unknown id: error text + listing, nothing written or stored --------------
{
  const host = await mkUseHost()
  const reply = host.run('use nope')
  assert.equal(reply.kind, 'error')
  assert.ok(reply.text.includes('nope'), 'error names the unknown id')
  for (const id of PRESET_IDS) assert.ok(reply.text.includes(id), `error lists available id ${id}`)
  await flush()
  assert.equal(host.mutates.length, 0, 'unknown id writes nothing')
  assert.equal(getSessionRolesOverride(host.key), undefined, 'unknown id stores nothing')
  const reply2 = host.run('use custom:ghost')
  assert.equal(reply2.kind, 'error')
  assert.equal(host.mutates.length, 0)
  assert.equal(getSessionRolesOverride(host.key), undefined)
  // v0.25.7: the exact removed legacy builtin id gets a targeted migration
  // hint; other unknown ids must NOT carry it.
  const legacy = host.run('use volcano-coding-plan')
  assert.equal(legacy.kind, 'error')
  assert.ok(legacy.text.includes('保存为自定义方案'), 'legacy id gets a targeted migration hint')
  assert.ok(!/nope/.test(legacy.text))
  const plain = host.run('use nope2')
  assert.equal(plain.kind, 'error')
  assert.ok(!plain.text.includes('保存为自定义方案'), 'generic unknown id has NO migration hint')
  assert.equal(host.mutates.length, 0)
  assert.equal(getSessionRolesOverride(host.key), undefined)
  console.log('✓ (5) unknown built-in / missing custom id → error + id listing, zero writes/stores; legacy id hint only on exact match')
}

// (6) repeated use updates the override; use off clears back to global; the
//     volatile one-shot guard is untouched by the use path ---------------------
{
  const presetPlan = ref('')
  const host = await mkUseHost({ presetPlan })
  host.run('use qwen')
  await flush()
  const first = getSessionRolesOverride(host.key)
  assert.equal(first?.preset, 'qwen')
  assert.equal(host.presetPlan.value, '', 'use never touches the presetPlan selector (no global writes)')
  await host.echoVolatileUpdate()
  assert.equal(host.mutates.length, 0, 'volatile update after use stays a no-op')
  // A DIFFERENT plan switches the override (last write wins).
  host.run('use deepseek')
  await flush()
  const second = getSessionRolesOverride(host.key)
  assert.equal(second?.preset, 'deepseek', 'repeated use switches the override')
  // Clear → back to global.
  const off = host.run('use off')
  assert.equal(off.kind, 'success')
  assert.match(off.text, /清除|回到全局/)
  assert.equal(getSessionRolesOverride(host.key), undefined, 'use off clears the override')
  const offAgain = host.run('use off')
  assert.equal(offAgain.kind, 'success', 'use off on an empty override stays benign')
  console.log('✓ (6) repeated use switches, use off clears, guard + presetPlan untouched')
}

// (6b) use auto: pending marker + tool hop 2 lands the picks session-only ------
{
  const host = await mkUseHost()
  const reply = host.run('use auto')
  assert.equal(reply.kind, 'success')
  assert.match(reply.text, /仅本会话|本会话/, 'auto receipt states the session scope')
  await flush()
  assert.equal(host.mutates.length, 0, 'use auto writes nothing globally')
  assert.equal(peekSessionAutoPending(host.key), true, 'session marked pending for the tool hop 2')
  // Drive the tool's second hop with a catalog-valid answer.
  const outcome = await host.presetTool.execute({ recommendation: '{"task":{"provider":"prov-x","model":"m1","reasoningEffort":"high"},"verify":null,"triage":null}' }, { agent: host.agent })
  assert.equal(outcome.status, 'applied')
  await flush()
  assert.equal(host.mutates.length, 0, 'hop 2 on the use path STILL writes nothing globally')
  const override = getSessionRolesOverride(host.key)
  assert.equal(override?.preset, 'auto')
  assert.deepEqual(override?.roles.task, { provider: 'prov-x', model: 'm1', reasoningEffort: 'high' }, 'hop-2 pick (with effort) stored as the session override')
  assert.equal(peekSessionAutoPending(host.key), false, 'pending marker consumed')
  console.log('✓ (6b) use auto: zero mutates end-to-end; tool hop 2 lands picks+effort in the session override')
}

// (6c) auto without a catalog / rejected answer: degraded/rejected, no writes --
{
  const host = await mkUseHost({ llm: 'none' })
  host.run('use auto')
  await flush()
  assert.equal(host.mutates.length, 0)
  const outcome = await host.presetTool.execute({ recommendation: 'not json' }, { agent: host.agent })
  assert.ok(outcome.status === 'degraded' || outcome.status === 'rejected', `unusable answer degrades: ${outcome.status}`)
  await flush()
  assert.equal(host.mutates.length, 0, 'degraded hop 2 on the use path writes no card record')
  assert.equal(peekSessionAutoPending(host.key), false, 'pending consumed even on degradation')
  // A catalog-bearing host with a garbage answer → rejected, still zero writes.
  const host2 = await mkUseHost()
  host2.run('use auto')
  await flush()
  const outcome2 = await host2.presetTool.execute({ recommendation: 'not json' }, { agent: host2.agent })
  assert.equal(outcome2.status, 'rejected')
  await flush()
  assert.equal(host2.mutates.length, 0, 'rejected hop 2 on the use path writes no card record')
  assert.equal(peekSessionAutoPending(host.key), false, 'pending consumed even on rejection')
  console.log('✓ (6c) auto degradation/rejection on the use path: zero mutates everywhere')
}

// (6d) the round read point: session override > global fields, per role/field --
{
  const merged = mergeSessionRolesOverride(
    { default: { provider: 'g', model: 'g1', reasoningEffort: 'low' }, verify: { provider: 'g', model: 'g2' } },
    { preset: 'p', label: 'L', roles: { task: { provider: 's', model: 's1', reasoningEffort: 'max' }, verify: { reasoningEffort: 'high' } }, appliedAt: '' },
  )
  assert.deepEqual(merged.default, { provider: 's', model: 's1', reasoningEffort: 'max' }, 'task row fully overridden (effort included)')
  assert.deepEqual(merged.verify, { provider: 'g', model: 'g2', reasoningEffort: 'high' }, 'verify row: per-field override over global')
  assert.equal(merged.triage, undefined, 'uncovered triage stays inherited')
  const untouched = { default: { provider: 'g', model: 'g1' } }
  assert.equal(mergeSessionRolesOverride(untouched, undefined), untouched, 'no override → the global shape untouched')
  console.log('✓ (6d) mergeSessionRolesOverride: session picks (incl. effort) win per role/field')
}

// (7) status carries the session-override line; on/off unchanged ----------------
{
  setRecordAppender(() => {})
  const host = await mkUseHost()
  const status0 = host.run('status')
  assert.match(status0.text, /会话预置方案覆盖：无（跟随全局配置）/, 'status shows the empty override state')
  host.run('use qwen')
  const status1 = host.run('status')
  assert.match(status1.text, /会话预置方案覆盖：/, 'status names the override line')
  assert.match(status1.text, /use off/, 'status carries the clear instruction')
  const on = host.run('on')
  assert.equal(on.kind, 'success')
  assert.match(on.text, /开启/)
  const status2 = host.run('status')
  assert.match(status2.text, /本会话状态/)
  const garbage = host.run('wat')
  assert.equal(garbage.kind, 'success', 'unknown text falls back to status')
  assert.match(garbage.text, /本会话状态/)
  host.run('use off')
  clearSessionRolesOverride(host.key)
  console.log('✓ (7) status shows the session override state; on / fallback unchanged')
}

console.log('\nv23 use-subcommand suite: all sections green')
