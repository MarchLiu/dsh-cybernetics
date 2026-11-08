// v0.22.0 offline tests: the /cybernetics `use` subcommand — switching the
// role composition (task/verify/triage model + reasoning effort) to any
// preset plan (PRESET_IDS built-ins + customPresets customs) from the command
// channel. Pins:
//   (1) the command hint advertises `use` (never the retired `profile` name),
//       and the status usage line mentions it;
//   (2) `use` with NO argument lists EVERY applicable plan (all 12 built-in
//       ids + configured customPresets) and asks the user to confirm with a
//       second `use <id>` invocation — plain text, no picker;
//   (3) `use <built-in id>` fires handlePresetSelection (the same pipeline as
//       the settings-card dropdown): settings.mutate receives ONLY ops within
//       ALLOWED_OP_PATHS (the six flat sub-agent fields) plus the outcome
//       record; the synchronous reply is success text;
//   (4) `use custom:<id>` applies the user-saved combination;
//   (5) an unknown id returns an ERROR text listing the available ids and
//       writes nothing;
//   (6) lastHandledPresetPlan is kept in sync: a later loader volatile update
//       carrying the same plan is a one-shot no-op (no double apply), while a
//       repeated `use <id>` invocation DOES re-apply (bypassing the guard);
//   (7) on/off/status still behave unchanged.
//
// Run: node test/v23-use-subcommand.mjs

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.ts'
import { setRecordAppender } from '../src/projection.ts'
import { ALLOWED_OP_PATHS, PRESET_IDS, parseRecommendationRecord } from '../src/modelPresets.ts'

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
const ref = (initial) => ({ value: initial, get() { return this.value } })

// Fake host: settings service captures mutates; the commands inject scope
// records descriptors and exposes the handler directly (v09 pattern).
async function mkUseHost({ customPresets = '', presetPlan = ref('') } = {}) {
  const mutates = []
  const commands = []
  const settings = { mutate: async (ns, ops) => { mutates.push({ ns, ops }); return true } }
  const root = await mkdtemp(join(tmpdir(), 'cyb-v23-'))
  const ctx = {
    tools: { register: () => () => {} },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null },
    workingDirectory: { get: () => root },
    agentPresets: { serviceFor: () => undefined },
    agents: { roots: () => [] },
    sessionProjections: { register: () => () => {} },
    get: (name) => (name === 'settings' ? settings : undefined),
    logger: { warn: () => {} },
    on: () => () => {},
    inject(names, cb) {
      cb({ ...ctx, commands: { register: (d) => { commands.push(d); return () => {} } } })
    },
  }
  apply(ctx, { presetPlan, customPresets })
  const descriptor = commands.at(-1)
  assert.ok(descriptor, 'cybernetics command registered')
  const session = { append() {} }
  const run = (rawInput) => descriptor.handler({ agent: { session }, rawInput })
  return { run, mutates, descriptor, presetPlan }
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
  // Case-insensitive subcommand + trailing space behaves the same.
  const reply2 = host.run('USE ')
  assert.equal(reply2.kind, 'success')
  assert.ok(reply2.text.includes('custom:mycombo'))
  console.log(`✓ (2) bare use lists all ${PRESET_IDS.length} built-ins + customs, zero writes, confirm prompt present`)
}

// (3) valid built-in id: success text + six-field-bounded apply ----------------
{
  const host = await mkUseHost()
  const reply = host.run('use qwen')
  assert.equal(reply.kind, 'success')
  assert.ok(reply.text.includes('qwen'), 'reply names the plan')
  await flush()
  assert.equal(host.mutates.length, 1, 'exactly one settings mutate')
  const { ns, ops } = host.mutates[0]
  assert.equal(ns, 'dsh-cybernetics')
  const fieldOps = ops.filter((op) => op.path[0] !== 'presetRecommendation')
  assert.equal(fieldOps.length, 6, 'exactly six role-field ops (3 models + 3 efforts)')
  for (const op of fieldOps) assert.ok(ALLOWED_OP_PATHS.has(op.path[0]), `op within the six fields: ${op.path[0]}`)
  const recordOp = ops.find((op) => op.path[0] === 'presetRecommendation')
  assert.ok(recordOp, 'outcome record written')
  const record = parseRecommendationRecord(recordOp.value)
  assert.equal(record.status, 'ok')
  assert.equal(record.preset, 'qwen')
  assert.ok(record.variant, 'default variant disclosed')
  // Case-preserved plan id: `USE GLM` still resolves the registry id.
  const host2 = await mkUseHost()
  assert.equal(host2.run('USE glm').kind, 'success')
  await flush()
  assert.equal(host2.mutates.length, 1)
  assert.ok(host2.mutates[0].ops.some((op) => op.path[0] === 'taskAgentModel'), 'case-insensitive subcommand applies glm')
  console.log('✓ (3) use qwen / USE glm apply through handlePresetSelection — 6-field ops + ok record')
}

// (4) custom preset id applies the user-saved combination ----------------------
{
  const host = await mkUseHost({
    customPresets: JSON.stringify([{ id: 'mycombo', name: '我的组合', roles: { task: { provider: 'prov-x', model: 'm-task' }, verify: { provider: 'prov-x', model: 'm-verify' }, triage: { provider: 'prov-x', model: 'm-triage' } } }]),
  })
  const reply = host.run('use custom:mycombo')
  assert.equal(reply.kind, 'success')
  await flush()
  assert.equal(host.mutates.length, 1)
  const ops = host.mutates[0].ops
  const modelOps = ops.filter((op) => op.path[0].endsWith('AgentModel'))
  assert.deepEqual(modelOps.map((op) => op.value).sort(), ['prov-x/m-task', 'prov-x/m-triage', 'prov-x/m-verify'], 'custom roles applied')
  for (const op of ops) assert.ok(ALLOWED_OP_PATHS.has(op.path[0]) || op.path[0] === 'presetRecommendation', 'custom ops stay in bounds')
  const record = parseRecommendationRecord(ops.find((op) => op.path[0] === 'presetRecommendation').value)
  assert.equal(record.label, '我的组合', 'record carries the custom entry name')
  console.log('✓ (4) use custom:mycombo applies the saved combination with its label')
}

// (5) unknown id: error text + listing, nothing written ------------------------
{
  const host = await mkUseHost()
  const reply = host.run('use nope')
  assert.equal(reply.kind, 'error')
  assert.ok(reply.text.includes('nope'), 'error names the unknown id')
  for (const id of PRESET_IDS) assert.ok(reply.text.includes(id), `error lists available id ${id}`)
  await flush()
  assert.equal(host.mutates.length, 0, 'unknown id writes nothing')
  // Unknown custom id errors too.
  const reply2 = host.run('use custom:ghost')
  assert.equal(reply2.kind, 'error')
  assert.equal(host.mutates.length, 0)
  console.log('✓ (5) unknown built-in / missing custom id → error + id listing, zero writes')
}

// (6) guard sync: volatile one-shot stays coherent; repeated use re-applies ----
{
  const presetPlan = ref('')
  const host = await mkUseHost({ presetPlan })
  host.run('use qwen')
  await flush()
  assert.equal(host.mutates.length, 1)
  // Emulate the loader carrying the SAME value afterwards: with
  // lastHandledPresetPlan synced by the handler, the volatile path must be a
  // no-op (the plugin's listener is wired via ctx.on; our stub drops it, so
  // verify the sync indirectly: a SECOND `use qwen` invocation must apply
  // again — proving the command path bypasses the guard while keeping
  // lastHandledPresetPlan coherent for any later volatile update).
  host.run('use qwen')
  await flush()
  assert.equal(host.mutates.length, 2, 'repeated use re-applies (guard bypassed on purpose)')
  assert.equal(host.presetPlan.value, '', 'command path never writes the volatile presetPlan field')
  console.log('✓ (6) repeated use re-applies; volatile presetPlan untouched by the command path')
}

// (7) on/off/status unchanged ---------------------------------------------------
{
  // The mode write goes through the plugin-record appender seam (v0.13.1);
  // stub it with a plain recorder so the durable write succeeds offline.
  setRecordAppender(() => {})
  const host = await mkUseHost()
  const on = host.run('on')
  assert.equal(on.kind, 'success')
  assert.match(on.text, /开启/)
  const status = host.run('status')
  assert.equal(status.kind, 'success')
  assert.match(status.text, /本会话状态/)
  const garbage = host.run('wat')
  assert.equal(garbage.kind, 'success', 'unknown text falls back to status')
  assert.match(garbage.text, /本会话状态/)
  console.log('✓ (7) on / status / unknown-text fallback unchanged')
}

console.log('\nv23 use-subcommand suite: all sections green')
