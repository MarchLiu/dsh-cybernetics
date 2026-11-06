// v0.17 offline tests: preset plans (预置方案) — the settings-card dropdown
// (auto-recommend + 8 vendor registries), the AI recommendation request/
// parse/apply pipeline, and the SESSION-SCOPE ruling (user, 2026-11-06):
// the session agent is OUT of scope — vendor session suggestions are
// reference data only, preset selection and auto-recommend write ONLY the
// task/verify/triage flat volatile fields (models + reasoning efforts).
//
// History: the first v0.17 cut shipped the registry as placeholders (the
// eight vendors' combinations had not been collected yet); this suite now
// pins the FILLED registry (collected 2026-11-06) and supersedes the
// placeholder-era assertions.
//
// Layers pinned here, all offline:
//   (1) registry completeness: 9 ids, 8 READY vendors, ≥1 variant each,
//       task/verify/triage filled, session entries ONLY under variant.session,
//       note/sessionNote/rationale data present;
//   (2) the recommendation REQUEST: catalog + principles + current config +
//       vendor reference (variants/session labeled non-selectable), the
//       session-exclusion rule and the reasoningEffort contract in the prompt;
//   (3) response parsing: fenced/raw JSON, efforts carried, off-catalog
//       dropped to `invalid`, a `session` key IGNORED (ignoredSession, never
//       a pick), shape-invalid efforts dropped, unusable replies → ok:false;
//   (4) soft effort validation (resolveModelInfo seam): unsupported effort
//       dropped (model kept), supported kept, absent/throwing face kept;
//   (5) apply ops: model set + effort set/unset per role; every op path ∈
//       ALLOWED_OP_PATHS (the six flat sub-agent fields — the session agent's
//       config is structurally unreachable); filterAllowedOps as the last
//       line of defense;
//   (6) vendor preset application across the WHOLE registry: default variant,
//       explicit variantId, unknown variantId → default, placeholder stance,
//       efforts incl. unset, and per-vendor session data never producing ops;
//   (7) recommendModels end-to-end on a fake ctx.llm: ok (with notes: session
//       ignore + effort drop), degraded (call failure, empty catalog) with
//       the request always attached;
//   (8) the plugin handler (apply()): a presetPlan change triggers exactly
//       one resolve; a READY vendor writes the default-variant ops + the
//       outcome record through the settings service; the record carries
//       variant/efforts/notes (session scope) and NEVER a session op; the
//       auto path degrades gracefully without ctx.llm; re-firing the same
//       value is a no-op; unknown id ignored; boot seeding and clearing;
//   (9) the settings card (lib/client.js): the select renders (none) + the 9
//       registry ids in order, ids mirror the server registry, the session
//       callout renders, an applied record renders picks+effort+variant+
//       notes, selecting writes the volatile presetPlan field, zh/en locale
//       keys complete.
//   (10) v0.17.2 HMR-transaction escape: the handler's settings.mutate runs
//       with the enclosing transaction's AsyncLocalStorage store cleared via
//       hmr.executing.exit (the live host refuses nested transactions —
//       "HMR transactions cannot be nested"); plain-path fallbacks intact.
//   (11) v0.17.2 root-llm fallback: probeCatalogOptions/callLlmOneShot read
//       `ctx.llm` as a context property; when the entry ctx is bare but the
//       root carries the service, the recommend call wraps `{ llm }` and
//       still resolves ok (the live host's first auto firing degraded).
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { apply } from '../src/index.ts'
import {
  ALLOWED_OP_PATHS, CROSS_VENDOR_PRINCIPLES, PRESET_AUTO_ID, PRESET_IDS, PRESET_SESSION_NOTE,
  buildRecommendationPrompt, callLlmOneShot, extractJsonBlock, filterAllowedOps, formatRecommendationRecord,
  parseRecommendation, parseRecommendationRecord, pickRecommendRoute, recommendationApplyOps, recommendModels,
  validatePickEfforts, vendorPresetApplyOps, presetById, presetChoiceLabel, presetVariant, allVendorPresets,
} from '../src/modelPresets.ts'

const section = (label) => console.log(`\n— ${label}`)

// (1) registry completeness ------------------------------------------------------
section('(1) registry: 9 options, 8 READY vendors, full data, session reference-only')
{
  assert.equal(PRESET_IDS.length, 9, 'dropdown ids: auto + 8 vendors')
  assert.equal(PRESET_IDS[0], PRESET_AUTO_ID, 'auto first')
  const ids = PRESET_IDS.slice(1)
  assert.deepEqual([...new Set(ids)].sort(), [...ids].sort(), 'vendor ids unique')
  const vendors = allVendorPresets()
  assert.equal(vendors.length, 8, '8 vendor entries')
  assert.deepEqual(vendors.map((v) => v.id), ids, 'registry order mirrors the dropdown ids')
  assert.equal(presetById('auto'), undefined, 'auto is not a vendor entry')
  const ROLE_KEYS = new Set(['task', 'verify', 'triage'])
  for (const vendor of vendors) {
    assert.equal(vendor.status, 'ready', `${vendor.id}: the collected combination is filled (status ready)`)
    assert.ok(vendor.label.length > 0, `${vendor.id}: label`)
    assert.ok(vendor.description?.length > 0, `${vendor.id}: description (scope note)`)
    assert.ok(Array.isArray(vendor.variants) && vendor.variants.length >= 1, `${vendor.id}: at least one variant`)
    // Multi-variant vendors from the brief: Claude 常规/高要求, DeepSeek 仅本家/verify外置,
    // Kimi 长期/最高验收, Qwen A/B/C, 火山 A/B.
    const expectedVariants = { openai: 1, claude: 2, gemini: 1, deepseek: 2, kimi: 2, qwen: 3, 'volcano-coding-plan': 2, minimax: 1 }
    assert.equal(vendor.variants.length, expectedVariants[vendor.id], `${vendor.id}: variant count matches the brief`)
    // roles mirrors the DEFAULT variant (first) for old readers.
    assert.equal(vendor.roles, vendor.variants[0].roles, `${vendor.id}: roles === default variant roles (mirror invariant)`)
    for (const variant of vendor.variants) {
      assert.ok(variant.id && variant.label, `${vendor.id}/${variant.id}: variant identity`)
      for (const roleKey of ['task', 'verify', 'triage']) {
        const spec = variant.roles[roleKey]
        assert.ok(spec, `${vendor.id}/${variant.id}/${roleKey}: entry present`)
        assert.ok(spec.model, `${vendor.id}/${variant.id}/${roleKey}: model filled`)
        // Heterogeneous effort data allowed; empty strings forbidden (undefined = default).
        if (spec.reasoningEffort !== undefined) assert.ok(spec.reasoningEffort.length > 0, `${vendor.id}/${variant.id}/${roleKey}: effort token non-empty when present`)
      }
      // SESSION SCOPE: only the three sub-agent keys inside roles; the session
      // suggestion lives exclusively under variant.session (reference data).
      for (const key of Object.keys(variant.roles)) {
        assert.ok(ROLE_KEYS.has(key), `${vendor.id}/${variant.id}: roles carry only sub-agent keys (got ${key})`)
      }
      if (variant.session !== undefined) {
        assert.ok(variant.session.model, `${vendor.id}/${variant.id}: session reference carries a model (display-only)`)
      }
    }
    assert.equal(vendor.sessionNote, PRESET_SESSION_NOTE, `${vendor.id}: session-scope note present`)
    assert.ok(vendor.note?.length > 0, `${vendor.id}: vendor note (caveats) present`)
    // Rationale data somewhere (per-role or per-variant).
    const hasRationale = vendor.variants.some((v) =>
      v.rationale?.length > 0 || Object.values(v.roles).some((spec) => spec?.rationale?.length > 0))
    assert.ok(hasRationale, `${vendor.id}: rationale data present`)
  }
  // Spot-check brief-critical data points.
  assert.equal(presetById('qwen').variants.length, 3, 'Qwen A/B/C')
  assert.match(presetById('qwen').note, /Turbo/, 'Qwen note carries the Turbo warning')
  assert.match(presetById('kimi').note, /退役/, 'Kimi note carries the K2 retirement warning')
  assert.match(presetById('deepseek').note, /成本不应成为降级 verify/, 'DeepSeek note carries the verify-cost principle')
  assert.equal(presetById('minimax').roles.task.reasoningEffort, 'high', 'Minimax task effort high')
  assert.equal(presetById('minimax').roles.triage.reasoningEffort, 'low', 'Minimax triage effort low')
  assert.equal(presetById('openai').roles.verify.model, 'gpt-6.1-sol', 'OpenAI verify model')
  assert.equal(presetById('claude').variants[1].roles.verify.model, 'Fable-5.1', 'Claude demanding variant verify')
  assert.match(presetById('gemini').roles.verify.model, /latest/, 'Gemini resolves family+latest (no pinned old version)')
  assert.ok(presetVariant(presetById('qwen')), 'presetVariant resolves the default')
  assert.equal(presetChoiceLabel(PRESET_AUTO_ID), '根据现有配置自动推荐', 'auto label')
  assert.equal(presetChoiceLabel('volcano-coding-plan'), '火山 Coding Plan', 'vendor label')
  console.log('✓ v17 (1) registry complete: 8 READY vendors, variants/efforts/notes/rationale filled, session reference-only')
}

// (2) recommendation request -----------------------------------------------------
section('(2) request: session exclusion + principles + effort contract injected')
{
  const options = [
    { provider: 'p-a', model: 'big-72b', name: 'Big', description: 'flagship' },
    { provider: 'p-b', model: 'small-8b', name: 'Small', description: 'light' },
  ]
  const { system, user } = buildRecommendationPrompt({
    options,
    currentOverrides: { default: { provider: 'p-a', model: 'big-72b' }, verify: { provider: 'p-b', model: 'small-8b', reasoningEffort: 'high' } },
  })
  // Session exclusion (highest-priority ruling) in the system prompt…
  assert.match(system, /session/, 'system mentions the session agent')
  assert.match(system, /禁止输出 session 键|只允许 task\/verify\/triage/, 'system forbids a session key')
  // …and in the user prompt (vendor session entries labeled non-selectable).
  assert.match(user, /禁止作为输出/, 'user labels vendor session entries non-selectable')
  // Cross-vendor principles present (sub-agents only).
  for (const principle of CROSS_VENDOR_PRINCIPLES) assert.ok(user.includes(principle), `principle injected: ${principle.slice(0, 18)}…`)
  assert.match(system, /verify 的模型档位不得低于 task/, 'system carries the verify≥task rule')
  // Effort contract.
  assert.match(system, /reasoningEffort/, 'system explains the optional effort field')
  assert.match(system, /"reasoningEffort":"<可选>"/, 'output contract carries effort')
  // Catalog lines verbatim (the only selectable source).
  assert.ok(user.includes('- p-a/big-72b (Big — flagship)'), 'catalog line rendered')
  assert.ok(user.includes('- p-b/small-8b (Small — light)'), 'catalog line rendered')
  assert.match(user, /唯一可选来源/, 'catalog marked as the only selectable source')
  // Current config rows (task configured, verify with effort, triage inherit).
  assert.ok(user.includes('- task: p-a/big-72b'), 'current task row rendered')
  assert.ok(user.includes('- verify: p-b/small-8b（思考强度 high）'), 'current verify row renders the effort')
  assert.ok(user.includes('- triage: （未配置，继承 session agent）'), 'current triage inherit row rendered')
  // Vendor reference blocks: variants + session markers; every vendor named.
  const withPresets = buildRecommendationPrompt({ options, currentOverrides: {} })
  for (const vendor of allVendorPresets()) assert.ok(withPresets.user.includes(`### ${vendor.label}`), `vendor block includes ${vendor.label}`)
  assert.ok(withPresets.user.includes('变体「高要求」'), 'variant labeled in the vendor block')
  assert.ok(withPresets.user.includes('session 参考（不在推荐范围，勿输出）'), 'vendor session suggestion labeled out of scope')
  assert.ok(withPresets.user.includes('非可选来源'), 'vendor presets framed as reference, not selectable')
  // Bounded catalog (cap 200).
  const huge = Array.from({ length: 500 }, (_, i) => ({ provider: 'p', model: `m${i}` }))
  const bounded = buildRecommendationPrompt({ options: huge, currentOverrides: {} })
  assert.equal((bounded.user.match(/^- p\/m\d+$/gm) ?? []).length, 200, 'catalog capped at 200 lines')
  console.log('✓ v17 (2) request built: session exclusion, principles, effort contract, catalog, vendor reference')
}

// (3) response parsing -----------------------------------------------------------
section('(3) parsing: picks + efforts; session key ignored; off-catalog dropped')
{
  const options = [
    { provider: 'p-a', model: 'big-72b' },
    { provider: 'p-b', model: 'small-8b' },
    { provider: 'p-c', model: 'mid-30b' },
  ]
  assert.equal(extractJsonBlock('前置说明\n```json\n{"task":{"provider":"a","model":"b"}}\n```\n后记'), '{"task":{"provider":"a","model":"b"}}', 'fenced JSON with prose extracted')
  assert.equal(extractJsonBlock('{"a":{"b":1}} 尾部'), '{"a":{"b":1}}', 'nested braces balanced')
  assert.equal(extractJsonBlock('{"a":"包含 } 引号的字符串"}'), '{"a":"包含 } 引号的字符串"}', 'braces inside strings survive')
  assert.equal(extractJsonBlock('没有 JSON'), undefined, 'no JSON → undefined')

  // Fenced JSON with efforts.
  const fenced = parseRecommendation('前置说明\n```json\n{"task":{"provider":"p-a","model":"big-72b","reasoningEffort":"high"},"verify":{"provider":"p-c","model":"mid-30b","reasoningEffort":"xhigh"},"triage":{"provider":"p-b","model":"small-8b"}}\n```\n后缀', options)
  assert.equal(fenced.ok, true, 'fenced JSON parses')
  assert.equal(fenced.picks.task.provider, 'p-a', 'exact provider/model match')
  assert.equal(fenced.picks.task.reasoningEffort, 'high', 'task effort carried')
  assert.equal(fenced.picks.verify.reasoningEffort, 'xhigh', 'verify effort carried')
  assert.equal(fenced.picks.triage.reasoningEffort, undefined, 'triage without effort stays effort-less')
  assert.deepEqual(fenced.invalid, [], 'no invalid entries')
  assert.equal(fenced.ignoredSession, false, 'no session key')

  // Bare-model matching across providers; null = keep current.
  const bare = parseRecommendation('{"task":{"model":"small-8b"},"verify":null,"triage":null}', options)
  assert.equal(bare.picks.task.provider, 'p-b', 'bare model matches any provider')
  assert.equal(bare.picks.verify, undefined, 'null = keep current')

  // A session key is IGNORED (user-managed scope) — never a pick, always noted.
  const withSession = parseRecommendation('{"task":null,"verify":null,"triage":null,"session":{"provider":"p-a","model":"big-72b"}}', options)
  assert.equal(withSession.ok, true, 'reply with a session key still parses')
  assert.equal(withSession.ignoredSession, true, 'session key flagged as ignored')
  assert.equal(withSession.picks.session, undefined, 'session never becomes a pick')
  assert.ok(!('session' in withSession.picks), 'no session property on picks at all')

  // Off-catalog suggestions land in invalid (reported, not applied).
  const offCatalog = parseRecommendation('{"task":{"provider":"nope","model":"ghost"},"verify":{"model":"small-8b"},"triage":null}', options)
  assert.equal(offCatalog.ok, true, 'partially off-catalog reply parses')
  assert.deepEqual(offCatalog.invalid, ['task: nope/ghost'], 'off-catalog entry reported')
  assert.equal(offCatalog.picks.task, undefined, 'off-catalog pick dropped')
  assert.equal(offCatalog.picks.verify.provider, 'p-b', 'bare-model match resolves provider')

  // Shape-violating roles are dropped (no pick, reported), the reply still parses.
  const shape = parseRecommendation('{"task": 42}', options)
  assert.equal(shape.ok, true, 'shape-violating role does not fail the parse')
  assert.equal(shape.picks.task, undefined, 'shape-violating role produces no pick')
  assert.equal(shape.invalid.length, 1, 'shape-violating role is reported')

  // Malformed effort tokens are dropped with a note, the pick survives.
  const badEffort = parseRecommendation('{"task":{"provider":"p-a","model":"big-72b","reasoningEffort":"  "},"verify":{"provider":"p-b","model":"small-8b","reasoningEffort":"' + 'x'.repeat(80) + '"}}', options)
  assert.equal(badEffort.picks.task.reasoningEffort, undefined, 'blank effort → undefined')
  assert.equal(badEffort.droppedEfforts.length, 1, 'oversized effort noted')
  assert.match(badEffort.droppedEfforts[0], /verify/, 'dropped effort names the role')

  // Unusable replies.
  assert.equal(parseRecommendation('我推荐你们用 GPT-9，非常好', options).ok, false, 'prose-only reply fails with a reason')
  assert.equal(parseRecommendation('{"task":', options).ok, false, 'truncated JSON → ok:false')
  assert.equal(parseRecommendation('"just a string"', options).ok, false, 'non-object JSON → ok:false')
  const allNull = parseRecommendation('{"task":null,"verify":null,"triage":null}', options)
  assert.deepEqual(allNull.picks, {}, 'all-null reply parses to zero picks')
  console.log('✓ v17 (3) parsing strict: catalog-matched picks + efforts, session key ignored, off-catalog reported')
}

// (4) soft effort validation -------------------------------------------------------
section('(4) effort validation via resolveModelInfo (soft seam)')
{
  const picks = {
    task: { provider: 'p-a', model: 'big-72b', reasoningEffort: 'xhigh' },
    verify: { provider: 'p-b', model: 'small-8b', reasoningEffort: 'low' },
    triage: { provider: 'p-a', model: 'big-72b' },
  }
  // Face offers efforts: unsupported dropped (model kept), supported kept.
  const ctxWithFace = {
    llm: { resolveModelInfo: async (provider) => ({
      reasoning: { efforts: provider === 'p-a' ? [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] : [{ id: 'low' }] },
    }) },
  }
  const validated = await validatePickEfforts(ctxWithFace, picks)
  assert.equal(validated.picks.task.model, 'big-72b', 'unsupported effort: MODEL KEPT')
  assert.equal(validated.picks.task.reasoningEffort, undefined, 'unsupported effort: token dropped')
  assert.match(validated.notes[0], /task.*xhigh.*已改为模型默认/, 'note names role + token')
  assert.equal(validated.picks.verify.reasoningEffort, 'low', 'supported effort kept')
  assert.equal(validated.picks.triage.reasoningEffort, undefined, 'effort-less pick untouched')
  // No face → picks unchanged, no notes.
  const noFace = await validatePickEfforts({}, picks)
  assert.deepEqual(noFace.picks, picks, 'no resolveModelInfo → picks unchanged')
  assert.deepEqual(noFace.notes, [], 'no notes without a face')
  // Throwing face → isolated failure, pick kept unvalidated.
  const throwing = await validatePickEfforts({ llm: { resolveModelInfo: async () => { throw new Error('boom') } } }, picks)
  assert.equal(throwing.picks.task.reasoningEffort, 'xhigh', 'throwing face keeps the pick unvalidated')
  console.log('✓ v17 (4) effort validation drops unsupported tokens, never the model')
}

// (5) apply ops ---------------------------------------------------------------------
section('(5) apply ops: models + efforts; ALLOWED_OP_PATHS is the structural session fence')
{
  const ops = recommendationApplyOps({
    task: { provider: 'p-a', model: 'big-72b', reasoningEffort: 'high' },
    verify: { provider: 'p-b', model: 'small-8b' },
    triage: { provider: 'p-c', model: 'mid-30b', reasoningEffort: 'low' },
  })
  assert.deepEqual(ops, [
    { op: 'set', path: ['taskAgentModel'], value: 'p-a/big-72b' },
    { op: 'set', path: ['taskAgentReasoningEffort'], value: 'high' },
    { op: 'set', path: ['verifyAgentModel'], value: 'p-b/small-8b' },
    { op: 'unset', path: ['verifyAgentReasoningEffort'] },
    { op: 'set', path: ['triageAgentModel'], value: 'p-c/mid-30b' },
    { op: 'set', path: ['triageAgentReasoningEffort'], value: 'low' },
  ], 'model set + effort set (carried) / unset (absent), per role, in order')
  for (const op of ops) assert.ok(ALLOWED_OP_PATHS.has(op.path[0]), `op path allowed: ${op.path[0]}`)
  // The allowed set is EXACTLY the six flat sub-agent fields — the session
  // agent's configuration is not addressable through this feature at all.
  assert.deepEqual([...ALLOWED_OP_PATHS].sort(), [
    'taskAgentModel', 'taskAgentReasoningEffort',
    'triageAgentModel', 'triageAgentReasoningEffort',
    'verifyAgentModel', 'verifyAgentReasoningEffort',
  ].sort(), 'ALLOWED_OP_PATHS = the six flat sub-agent fields only')
  // Last line of defense: foreign ops are filtered out.
  const filtered = filterAllowedOps([
    { op: 'set', path: ['taskAgentModel'], value: 'p-a/big-72b' },
    { op: 'set', path: ['allGoalsMode'], value: 'true' },
    { op: 'set', path: ['provider'], value: 'evil' },
    { op: 'unset', path: ['sessionModel'] },
  ])
  assert.deepEqual(filtered, [{ op: 'set', path: ['taskAgentModel'], value: 'p-a/big-72b' }], 'filterAllowedOps drops everything outside the six fields')
  console.log('✓ v17 (5) apply ops bounded to the six sub-agent fields; foreign paths filtered')
}

// (6) vendor preset application over the whole registry ------------------------------
section('(6) vendorPresetApplyOps: default/explicit/unknown variant, efforts, session never')
{
  for (const vendor of allVendorPresets()) {
    const applied = vendorPresetApplyOps(vendor)
    assert.equal(applied.ready, true, `${vendor.id}: ready`)
    const variant = applied.variant
    assert.ok(variant, `${vendor.id}: default variant resolved`)
    assert.equal(variant.id, vendor.variants[0].id, `${vendor.id}: default = first variant`)
    const expectedRoles = ['task', 'verify', 'triage'].filter((r) => {
      const spec = variant.roles[r]
      return spec && (spec.provider || spec.model)
    })
    assert.equal(applied.ops.length, expectedRoles.length * 2, `${vendor.id}: model op + effort op per filled role`)
    for (const op of applied.ops) {
      assert.ok(ALLOWED_OP_PATHS.has(op.path[0]), `${vendor.id}: op path ${op.path[0]} within the six fields`)
      if (op.path[0].endsWith('ReasoningEffort')) {
        const roleKey = op.path[0] === 'taskAgentReasoningEffort' ? 'task' : op.path[0] === 'verifyAgentReasoningEffort' ? 'verify' : 'triage'
        const spec = variant.roles[roleKey]
        const expected = spec.reasoningEffort !== undefined && spec.reasoningEffort !== '' ? 'set' : 'unset'
        assert.equal(op.op, expected, `${vendor.id}/${roleKey}: effort op is ${expected}`)
        if (expected === 'set') assert.equal(op.value, spec.reasoningEffort, `${vendor.id}/${roleKey}: effort value`)
      }
    }
    // The session suggestion NEVER yields an op. When the session model id is
    // unique within the variant (not shared with a sub-agent role), it cannot
    // appear anywhere in the ops payload.
    if (variant.session?.model) {
      const roleModels = Object.values(variant.roles).map((spec) => spec?.model).filter(Boolean)
      if (!roleModels.includes(variant.session.model)) {
        const sessionText = JSON.stringify(applied.ops)
        assert.ok(!sessionText.includes(variant.session.model), `${vendor.id}: session model never appears in ops`)
      }
    }
  }
  const findOp = (ops, path) => ops.find((op) => op.path[0] === path)
  // Explicit variantId: Qwen 'c' (task turbo, verify plus, triage turbo).
  const qwenC = vendorPresetApplyOps(presetById('qwen'), 'c')
  assert.equal(qwenC.variant.label, 'C（轻量）', 'qwen variant c resolved')
  assert.equal(findOp(qwenC.ops, 'taskAgentModel').value, 'qwen/qwen-turbo', 'qwen-c task turbo')
  assert.equal(findOp(qwenC.ops, 'verifyAgentModel').value, 'qwen/qwen-plus', 'qwen-c verify plus (never turbo)')
  assert.equal(findOp(qwenC.ops, 'triageAgentModel').value, 'qwen/qwen-turbo', 'qwen-c triage turbo')
  // Unknown variantId falls back to the default variant.
  const qwenFallback = vendorPresetApplyOps(presetById('qwen'), 'no-such-variant')
  assert.equal(qwenFallback.variant.id, presetById('qwen').variants[0].id, 'unknown variant id → default variant')
  // Claude demanding variant: task Opus-5.5, verify Fable-5.1.
  const claudeD = vendorPresetApplyOps(presetById('claude'), 'demanding')
  assert.equal(findOp(claudeD.ops, 'taskAgentModel').value, 'anthropic/Opus-5.5', 'claude demanding task Opus-5.5')
  assert.equal(findOp(claudeD.ops, 'verifyAgentModel').value, 'anthropic/Fable-5.1', 'claude demanding verify Fable-5.1')
  // DeepSeek in-house: verify carries the thinking effort token.
  const deepseekIn = vendorPresetApplyOps(presetById('deepseek'), 'in-house')
  const verifyEffortOp = findOp(deepseekIn.ops, 'verifyAgentReasoningEffort')
  assert.equal(verifyEffortOp.op, 'set', 'deepseek verify effort pinned')
  assert.equal(verifyEffortOp.value, 'thinking', 'deepseek verify effort = thinking')
  // Placeholder stance retained by the type (no placeholder entries remain, but the shape is pinned).
  assert.deepEqual(vendorPresetApplyOps({ ...presetById('kimi'), status: 'placeholder' }), { ready: false, ops: [] }, 'placeholder → nothing applied')
  console.log('✓ v17 (6) every vendor applies its default variant within the six fields; session data never reaches ops')
}

// (7) recommendModels end-to-end on a fake ctx.llm ------------------------------------
section('(7) recommendModels: ok with notes / degraded with the request attached')
{
  const options = [
    { provider: 'p-a', model: 'big-72b', name: 'Big' },
    { provider: 'p-b', model: 'small-8b', name: 'Small' },
  ]
  const reply = '推荐如下：\n```json\n{"task":{"provider":"p-a","model":"big-72b","reasoningEffort":"high"},"verify":{"provider":"p-b","model":"small-8b","reasoningEffort":"xhigh"},"triage":{"provider":"p-b","model":"small-8b"},"session":{"provider":"p-a","model":"big-72b"}}\n```\n说明文字'
  const llm = {
    prepareCall: async () => ({
      config: { provider: 'p-a', model: 'big-72b' },
      stream: async function* () { yield { type: 'text-delta', index: 0, text: reply } },
    }),
    resolveModelInfo: async (_p, model) => ({ reasoning: { efforts: model === 'big-72b' ? [{ id: 'high' }, { id: 'xhigh' }] : [{ id: 'low' }] } }),
  }
  const ok = await recommendModels({ llm }, { options, currentOverrides: {} })
  assert.equal(ok.status, 'ok', 'ai recommendation succeeds')
  assert.equal(ok.ignoredSession, true, 'session key in the reply noted')
  assert.ok(ok.notes.some((n) => /session/.test(n)), 'session-ignore note present')
  assert.ok(ok.notes.some((n) => /verify.*xhigh.*已改为模型默认/.test(n)), 'effort-drop note present (small-8b lacks xhigh)')
  const ops = ok.ops
  assert.ok(ops.some((op) => op.path[0] === 'taskAgentModel' && op.value === 'p-a/big-72b'), 'task model op')
  const verifyEffort = ops.find((op) => op.path[0] === 'verifyAgentReasoningEffort')
  assert.equal(verifyEffort.op, 'unset', 'dropped verify effort becomes an unset (model default)')
  for (const op of ops) assert.ok(ALLOWED_OP_PATHS.has(op.path[0]), 'every op within the six fields')
  // Call failure degrades with the reason AND the request attached.
  const failing = await recommendModels({ llm: { prepareCall: async () => { throw new Error('provider down') } } }, { options })
  assert.equal(failing.status, 'degraded')
  assert.match(failing.reason, /调用失败|provider down/)
  assert.ok(failing.request.system.length > 0 && failing.request.user.length > 0, 'the built request is attached even on degradation')
  // Missing face → degraded.
  const noFace = await recommendModels({}, { options })
  assert.equal(noFace.status, 'degraded')
  assert.match(noFace.reason, /LLM 调用面/)
  // Empty catalog → degraded before any call.
  const empty = await recommendModels({ llm }, { options: [] })
  assert.equal(empty.status, 'degraded')
  assert.match(empty.reason, /目录不可用或为空/)
  // Unparseable reply → degraded.
  const garbage = await recommendModels({ llm: { prepareCall: async () => ({ config: {}, stream: async function* () { yield { type: 'text-delta', index: 0, text: '不会输出JSON' } } }) } }, { options })
  assert.equal(garbage.status, 'degraded')
  assert.match(garbage.reason, /推荐回复不可用|没有找到 JSON/)
  // One-shot call seam: empty reply and throwing stream degrade softly.
  assert.deepEqual(await callLlmOneShot({}, { provider: 'p', model: 'm' }, 's', 'u'), { ok: false, reason: '宿主未暴露 LLM 调用面（ctx.llm.prepareCall 不可用）' }, 'missing face refused')
  const emptyReply = await callLlmOneShot({ llm: { prepareCall: async () => ({ config: {}, stream: async function* () { /* nothing */ } }) } }, { provider: 'p', model: 'm' }, 's', 'u')
  assert.equal(emptyReply.ok, false, 'empty stream refused')
  const throwingStream = await callLlmOneShot({ llm: { prepareCall: async () => ({ config: {}, stream: async function* () { throw new Error('mid-stream') } }) } }, { provider: 'p', model: 'm' }, 's', 'u')
  assert.equal(throwingStream.ok, false, 'throwing stream refused')
  assert.match(throwingStream.reason, /mid-stream/, 'stream error surfaced in the reason')
  // Route pick: explicit matched / bare / off-catalog verbatim / high-tier default.
  assert.deepEqual(pickRecommendRoute('p-b/small-8b', options), { provider: 'p-b', model: 'small-8b' }, 'explicit route matched')
  assert.deepEqual(pickRecommendRoute('big-72b', options), { provider: 'p-a', model: 'big-72b' }, 'bare model matched')
  assert.deepEqual(pickRecommendRoute('ghost/ghost-9000', options), { provider: 'ghost', model: 'ghost-9000' }, 'off-catalog explicit honored verbatim')
  assert.deepEqual(pickRecommendRoute('', options), { provider: 'p-a', model: 'big-72b' }, 'default = first high-tier entry')
  assert.equal(pickRecommendRoute('', []), undefined, 'empty catalog → undefined')
  console.log('✓ v17 (7) end-to-end ok (notes carry session-ignore + effort-drop); all degradations explained; route pick pinned')
}

// (8) plugin handler (apply) -----------------------------------------------------------
section('(8) apply(): one-shot presetPlan resolve, record enrichment, session scope')
{
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
  // Fake host: settings service captures mutate ops; ctx.on captures listeners.
  const mkCtx = async ({ llm, config }) => {
    const mutates = []
    const listeners = {}
    const warns = []
    const settings = { mutate: async (ns, ops) => { mutates.push({ ns, ops }); return true } }
    const root = await mkdtemp(join(tmpdir(), 'cyb-v17-'))
    const ctx = {
      tools: { register: () => () => {} },
      systemPrompt: { section() {}, getSectionOrder: () => 0 },
      goals: { get: () => null },
      workingDirectory: { get: () => root },
      agentPresets: { serviceFor: () => undefined },
      sessionProjections: { register: () => () => {} },
      get: (name) => (name === 'settings' ? settings : undefined),
      logger: { warn: (m) => warns.push(m) },
      on: (event, fn) => { (listeners[event] ??= []).push(fn); return () => {} },
      ...(llm !== undefined ? { llm } : {}),
    }
    apply(ctx, config)
    return {
      fire: async () => {
        for (const fn of listeners['loader/volatile-update'] ?? []) fn()
        await flush()
        return mutates
      },
      mutates, warns,
    }
  }
  // Live-ref config the way the loader hands volatile fields over.
  const ref = (initial) => ({ value: initial, get() { return this.value } })
  const catalogLlm = {
    listProviders: () => [{ id: 'p-a' }, { id: 'p-b' }],
    listModels: async (pid) => [pid === 'p-a' ? { provider: pid, id: 'big-72b', name: 'Big' } : { provider: pid, id: 'small-8b', name: 'Small' }],
    prepareCall: async () => ({ config: {}, stream: async function* () {
      yield { type: 'text-delta', index: 0, text: '{"task":{"provider":"p-a","model":"big-72b","reasoningEffort":"high"},"verify":{"provider":"p-a","model":"big-72b"},"triage":{"provider":"p-b","model":"small-8b"}}' }
    } }),
  }
  {
    // Vendor preset: default variant ops + enriched record via the settings service.
    const planRef = ref('')
    const host = await mkCtx({ llm: catalogLlm, config: { presetPlan: planRef } })
    planRef.value = 'qwen'
    await host.fire()
    assert.equal(host.mutates.length, 1, 'one settings mutate per selection')
    const { ns, ops } = host.mutates[0]
    assert.equal(ns, 'dsh-cybernetics', 'settings namespace = the loader row id')
    const modelOps = ops.filter((op) => op.path[0].endsWith('AgentModel'))
    const effortOps = ops.filter((op) => op.path[0].endsWith('ReasoningEffort'))
    const recordOp = ops.find((op) => op.path[0] === 'presetRecommendation')
    assert.ok(recordOp, 'outcome record written to the card')
    assert.deepEqual(modelOps.map((op) => op.value).sort(), ['qwen/qwen-max', 'qwen/qwen-plus', 'qwen/qwen-turbo'], 'qwen default variant A applied (max/plus/turbo)')
    assert.equal(effortOps.every((op) => op.op === 'unset'), true, 'qwen roles carry no effort tokens → unset ops clear stale efforts')
    for (const op of ops) {
      if (op.path[0] !== 'presetRecommendation') assert.ok(ALLOWED_OP_PATHS.has(op.path[0]), `handler op within the six fields: ${op.path[0]}`)
    }
    const record = parseRecommendationRecord(recordOp.value)
    assert.equal(record.status, 'ok', 'record ok')
    assert.equal(record.preset, 'qwen', 'record names the preset')
    assert.ok(record.variant, 'record discloses the applied variant')
    assert.deepEqual(record.picks, { task: 'qwen/qwen-plus', verify: 'qwen/qwen-max', triage: 'qwen/qwen-turbo' }, 'record picks = default variant routes')
    assert.ok(record.notes.some((n) => /session 由用户自行管理/.test(n)), 'record carries the session-scope note')
    assert.ok(record.notes.some((n) => /session 参考（未应用）/.test(n)), 'record shows the vendor session suggestion as NOT applied')
    assert.ok(record.otherVariants.includes('B（高要求）'), 'record lists remaining variants')
    // Re-firing the SAME value is a no-op (one-shot guard).
    await host.fire()
    assert.equal(host.mutates.length, 1, 'same value → no re-apply')
  }
  {
    // Explicit vendor: volcano default variant A (task lite, effort-less roles → unset).
    const planRef2 = ref('')
    const host2 = await mkCtx({ llm: catalogLlm, config: { presetPlan: planRef2 } })
    planRef2.value = 'volcano-coding-plan'
    await host2.fire()
    const ops2 = host2.mutates.at(-1).ops
    const taskOp = ops2.find((op) => op.path[0] === 'taskAgentModel')
    assert.equal(taskOp.value, 'volcano/Seed-2.1-lite', 'volcano default variant A: task lite')
    const record2 = parseRecommendationRecord(ops2.find((op) => op.path[0] === 'presetRecommendation').value)
    assert.equal(record2.variant, 'A（均衡）', 'record names variant A')
  }
  {
    // Auto path: happy (efforts in the record) …
    const planRef3 = ref('')
    const host3 = await mkCtx({ llm: catalogLlm, config: { presetPlan: planRef3 } })
    planRef3.value = 'auto'
    await host3.fire()
    const ops3 = host3.mutates.at(-1).ops
    const record3 = parseRecommendationRecord(ops3.find((op) => op.path[0] === 'presetRecommendation').value)
    assert.equal(record3.status, 'ok', 'auto ok')
    assert.deepEqual(record3.picks, { task: 'p-a/big-72b', verify: 'p-a/big-72b', triage: 'p-b/small-8b' }, 'auto picks applied')
    assert.deepEqual(record3.efforts, { task: 'high', verify: '', triage: '' }, 'auto efforts recorded (empty = model default)')
    assert.ok(record3.notes.some((n) => /session 由用户自行管理/.test(n)), 'auto record carries the session-scope note')
    const modelOps3 = ops3.filter((op) => op.path[0].endsWith('AgentModel'))
    assert.equal(modelOps3.length, 3, 'three model ops (task/verify/triage ONLY — session structurally unreachable)')
  }
  {
    // Auto path degraded (no llm at all): the card still gets the record, no model field touched.
    const planRef4 = ref('')
    const host4 = await mkCtx({ llm: undefined, config: { presetPlan: planRef4 } })
    planRef4.value = 'auto'
    await host4.fire()
    const ops4 = host4.mutates.at(-1).ops
    assert.equal(ops4.length, 1, 'degraded auto writes ONLY the record')
    const record4 = parseRecommendationRecord(ops4[0].value)
    assert.equal(record4.status, 'degraded', 'degraded record')
    assert.ok(record4.reason.length > 0, 'degradation reason present')
  }
  {
    // Unknown id ignored without a write.
    const planRef5 = ref('')
    const host5 = await mkCtx({ llm: catalogLlm, config: { presetPlan: planRef5 } })
    planRef5.value = 'not-a-preset'
    await host5.fire()
    assert.equal(host5.mutates.length, 0, 'unknown preset id ignored')
    assert.ok(host5.warns.some((w) => /not-a-preset/.test(w)), 'the unknown id is logged')
  }
  {
    // Seeded value (persisted across restart) is NOT re-applied at apply() time.
    const planRef6 = ref('claude')
    const host6 = await mkCtx({ llm: catalogLlm, config: { presetPlan: planRef6 } })
    await host6.fire()
    assert.equal(host6.mutates.length, 0, 'the seeded presetPlan is not re-applied at boot')
  }
  {
    // Clearing ('') writes nothing; the applied values persist in the flat fields.
    const planRef7 = ref('qwen')
    const host7 = await mkCtx({ llm: catalogLlm, config: { presetPlan: planRef7 } })
    await host7.fire() // seed read: 'qwen' is lastHandled, no write
    assert.equal(host7.mutates.length, 0, 'seeded vendor id not re-applied')
    planRef7.value = ''
    await host7.fire()
    assert.equal(host7.mutates.length, 0, 'clearing writes nothing')
    planRef7.value = 'minimax'
    await host7.fire()
    assert.equal(host7.mutates.length, 1, 'a NEW selection after clearing fires once')
    const record7 = parseRecommendationRecord(host7.mutates[0].ops.find((op) => op.path[0] === 'presetRecommendation').value)
    assert.equal(record7.preset, 'minimax', 'the new selection resolved')
  }
  console.log('✓ v17 (8) handler: one-shot resolve, enriched record, degraded path, unknown/seeded/cleared guards')
}

// (10) v0.17.2 HMR-transaction escape -------------------------------------------------
section('(10) hmr escape: mutate runs outside the enclosing HMR transaction (v0.17.2)')
{
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const flush10 = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
  const ref10 = (initial) => ({ value: initial, get() { return this.value } })
  // A REAL AsyncLocalStorage wired exactly like dsh-hmr's `executing` field:
  // the live runExclusive refuses nested callers whenever getStore() is truthy,
  // and the store leaks into every async continuation scheduled during the
  // transaction (verified on the live host 2026-11-06: write-refused "HMR
  // transactions cannot be nested").
  const als = new AsyncLocalStorage()
  const mkCtxWithHmr = async ({ config, hmr }) => {
    const mutates = []
    const listeners = {}
    const mutateContexts = []
    const settings = { mutate: async (ns, ops) => { mutateContexts.push(als.getStore()); mutates.push({ ns, ops }); return true } }
    const root = await mkdtemp(join(tmpdir(), 'cyb-v17-'))
    const ctx = {
      tools: { register: () => () => {} },
      systemPrompt: { section() {}, getSectionOrder: () => 0 },
      goals: { get: () => null },
      workingDirectory: { get: () => root },
      agentPresets: { serviceFor: () => undefined },
      sessionProjections: { register: () => () => {} },
      // The host resolves both services through the context chain; 'settings'
      // entry-scoped, 'hmr' host-provided (configEditor does ownerContext.get("hmr")).
      get: (name) => (name === 'settings' ? settings : name === 'hmr' ? hmr : undefined),
      logger: { warn: () => {} },
      on: (event, fn) => { (listeners[event] ??= []).push(fn); return () => {} },
    }
    apply(ctx, config)
    return {
      fireInTransaction: async () => {
        // The live loader emits volatile-update INSIDE the committing
        // transaction; every async continuation of the handler inherits the
        // store — exactly the refusal scenario.
        await als.run(true, async () => { for (const fn of listeners['loader/volatile-update'] ?? []) fn() })
        await flush10()
        return mutates
      },
      mutateContexts, mutates,
    }
  }
  {
    // The fix: with an hmr service exposing executing.exit, the write lands
    // even though the handler runs inside an active transaction.
    const planRef = ref10('')
    const host = await mkCtxWithHmr({ config: { presetPlan: planRef }, hmr: { executing: als } })
    planRef.value = 'qwen'
    const mutates = await host.fireInTransaction()
    assert.equal(mutates.length, 1, 'escape path: the write landed despite the active transaction store')
    assert.equal(host.mutateContexts.length, 1, 'exactly one mutate through the settings service')
    assert.equal(host.mutateContexts[0], undefined, 'the mutate ran with the transaction store CLEARED (als.exit escape)')
    const ops = mutates[0].ops
    assert.ok(ops.find((op) => op.path[0] === 'presetRecommendation'), 'outcome record written through the escaped mutate')
    assert.ok(ops.some((op) => op.path[0] === 'verifyAgentModel' && op.value === 'qwen/qwen-max'), 'vendor model ops applied via the escape path')
  }
  {
    // A throwing exit falls back to the plain call — the write is still attempted.
    const planRef = ref10('')
    const hostThrow = await mkCtxWithHmr({ config: { presetPlan: planRef }, hmr: { executing: { exit: () => { throw new Error('exit exploded') } } } })
    planRef.value = 'kimi'
    const mutates = await hostThrow.fireInTransaction()
    assert.equal(mutates.length, 1, 'exit throw → plain-call fallback still writes')
  }
  {
    // hmr present WITHOUT a usable executing.exit (composition drift) → plain path.
    const planRef = ref10('')
    const hostBare = await mkCtxWithHmr({ config: { presetPlan: planRef }, hmr: { executing: {} } })
    planRef.value = 'gemini'
    const mutates = await hostBare.fireInTransaction()
    assert.equal(mutates.length, 1, 'no exit face → v0.17.1 plain mutate preserved')
  }
  console.log('✓ v17 (10) hmr escape: store cleared under transaction, fallbacks intact')
}

// (11) v0.17.2 root-llm fallback ------------------------------------------------------
section('(11) llm face fallback: auto recommend works when only ctx.root carries the llm service')
{
  const flush11 = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
  const ref11 = (initial) => ({ value: initial, get() { return this.value } })
  const catalogLlm11 = {
    listProviders: () => [{ id: 'p-a' }, { id: 'p-b' }],
    listModels: async (pid) => [pid === 'p-a' ? { provider: pid, id: 'big-72b', name: 'Big' } : { provider: pid, id: 'small-8b', name: 'Small' }],
    prepareCall: async () => ({ config: {}, stream: async function* () {
      yield { type: 'text-delta', index: 0, text: '{"task":{"provider":"p-a","model":"big-72b"},"verify":{"provider":"p-a","model":"big-72b"},"triage":{"provider":"p-b","model":"small-8b"}}' }
    } }),
  }
  const mutates = []
  const listeners = {}
  const settings = { mutate: async (ns, ops) => { mutates.push({ ns, ops }); return true } }
  const rootDir = await mkdtemp(join(tmpdir(), 'cyb-v17-'))
  // Entry ctx WITHOUT an llm face (the suspected live-host shape); the root
  // carries it — the fallback must find it and the recommend must succeed.
  const ctx11 = {
    tools: { register: () => () => {} },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    goals: { get: () => null },
    workingDirectory: { get: () => rootDir },
    agentPresets: { serviceFor: () => undefined },
    sessionProjections: { register: () => () => {} },
    get: (name) => (name === 'settings' ? settings : undefined),
    logger: { warn: () => {} },
    on: (event, fn) => { (listeners[event] ??= []).push(fn); return () => {} },
    root: { get: () => undefined, llm: catalogLlm11 },
  }
  const planRef = ref11('')
  apply(ctx11, { presetPlan: planRef })
  planRef.value = 'auto'
  for (const fn of listeners['loader/volatile-update'] ?? []) fn()
  await flush11()
  assert.equal(mutates.length, 1, 'root-llm fallback: the auto recommend resolved through ctx.root.llm')
  const record = parseRecommendationRecord(mutates[0].ops.find((op) => op.path[0] === 'presetRecommendation').value)
  assert.equal(record.status, 'ok', 'recommendation succeeded via the root face (catalog probed, picks returned)')
  assert.deepEqual(record.picks, { task: 'p-a/big-72b', verify: 'p-a/big-72b', triage: 'p-b/small-8b' }, 'picks came from the root-provided catalog')
  console.log('✓ v17 (11) root-llm fallback: bare entry ctx + root face → recommend ok')
}

// (9) settings card -------------------------------------------------------------------
section('(9) settings card: 9-option select, session callout, record rendering, write path')
{
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded
  globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m } } }
  new Function('window', client)(globalThis.window)
  const jsx = { jsx: (type, props, key) => ({ type, props: props ?? {}, key }), jsxs: (type, props, key) => ({ type, props: props ?? {}, key }) }
  const registered = []
  const dicts = {}
  const react = {
    useSyncExternalStore: (_s, getSnapshot) => getSnapshot(),
    useState: (initial) => { const slot = { value: initial }; return [slot.value, (nv) => { slot.value = typeof nv === 'function' ? nv(slot.value) : nv }] },
  }
  const mod = loaded.factory((req) => (req === 'react' ? react : jsx))
  mod.apply({
    effect: (fn) => fn(),
    locale: {
      register: (_ns, d) => { Object.assign(dicts, d) },
      bind: () => (key, params) => {
        let text = dicts.zh?.[key] ?? key
        if (params) for (const name of Object.keys(params)) text = text.replaceAll('{' + name + '}', String(params[name]))
        return text
      },
    },
    slots: { inject: (_n, cb) => cb(), register: (spec, view) => { registered.push({ spec, view }) } },
    sessions: {}, remote: { $on: () => {} },
    configForms: { get: () => undefined, whileServed: (_ns, r) => { r(new Set()); return () => {} } },
  })
  // Locale completeness (zh is the key-set source of truth; en must mirror).
  for (const key of [
    'settings.presetPlan', 'settings.presetPlanHint', 'settings.presetNone',
    'settings.preset.optAuto', 'settings.preset.optOpenai', 'settings.preset.optClaude', 'settings.preset.optGemini',
    'settings.preset.optDeepseek', 'settings.preset.optKimi', 'settings.preset.optQwen', 'settings.preset.optVolcanoCodingPlan',
    'settings.preset.optMinimax', 'settings.presetRecommendModel', 'settings.presetRecommendModelHint',
    'settings.preset.sessionScope', 'settings.preset.applied', 'settings.preset.effortSuffix', 'settings.preset.effortDefaultSuffix',
    'settings.preset.variant', 'settings.preset.otherVariants', 'settings.preset.notes',
    'settings.preset.appliedInvalid', 'settings.preset.placeholder', 'settings.preset.degraded', 'settings.preset.recordRaw',
  ]) {
    assert.equal(typeof dicts.zh[key], 'string', `zh locale has ${key}`)
    assert.equal(typeof dicts.en[key], 'string', `en locale has ${key}`)
  }
  assert.match(dicts.zh['settings.presetPlanHint'], /session/, 'zh hint explains the session scope')
  assert.match(dicts.en['settings.presetPlanHint'], /session/, 'en hint explains the session scope')
  // The 9 dropdown ids mirror the server registry, in order.
  const choices = client.match(/PRESET_CHOICES = \[([\s\S]*?)\];/)?.[1] ?? ''
  const choiceIds = [...choices.matchAll(/id: '([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(choiceIds, [...PRESET_IDS], 'client PRESET_CHOICES ids mirror the server registry order')
  // Render the card seat.
  const seat = registered.find((e) => e.spec.name === 'plugins.item')
  const t = (key, params) => {
    let text = dicts.zh?.[key] ?? key
    if (params) for (const name of Object.keys(params)) text = text.replaceAll('{' + name + '}', String(params[name]))
    return text
  }
  const flatten = (node, out = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return out
    if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
    out.push(node)
    if (node.props && node.props.children !== undefined) flatten(node.props.children, out)
    return out
  }
  const appliedRecord = formatRecommendationRecord({
    status: 'ok', preset: 'qwen', label: 'Qwen', at: '2026-11-06T00:00:00.000Z',
    picks: { task: 'qwen/qwen-plus', verify: 'qwen/qwen-max', triage: 'qwen/qwen-turbo' },
    efforts: { task: '', verify: '', triage: '' },
    variant: 'A（均衡）', otherVariants: ['B（高要求）', 'C（轻量）'],
    notes: [PRESET_SESSION_NOTE, 'session 参考（未应用）：qwen/qwen-max'],
  })
  const snap = { status: 'ready', writable: true, value: { allGoalsMode: false, hardGate: false, smartAgentModelSelection: false, presetPlan: '', presetRecommendation: appliedRecord, roundsPerSubgoal: 3, maxConcurrentRounds: 0 } }
  const writes = []
  const form = {
    getSnapshot: () => snap, subscribe: () => () => {},
    set: async (field, value) => { writes.push([field, value]); return true },
    unset: async (field) => { writes.push([field, 'UNSET']); return true }, mutate: async () => true,
  }
  const rendered = flatten(seat.view({ view: 'page', t, form }))
  const presetSelect = rendered.find((n) => n.type === 'select' && n.props['aria-label'] === t('settings.presetPlan'))
  assert.ok(presetSelect, 'preset select rendered')
  const options = flatten(presetSelect.props.children).filter((n) => n.type === 'option')
  assert.equal(options.length, 10, '(none) + 9 scheme options')
  assert.equal(options[0].props.value, '', 'leading (none) option')
  assert.deepEqual(options.slice(1).map((o) => o.props.value), [...PRESET_IDS], 'the 9 scheme options in registry order')
  assert.equal(options[1].props.children, t('settings.preset.optAuto'), 'first scheme option = auto-recommend')
  // The session-scope callout renders on the card.
  const callout = rendered.find((n) => typeof n.props?.children === 'string' && n.props.children.includes('由用户自行管理'))
  assert.ok(callout, 'session-scope callout rendered')
  // The applied record renders picks + effort suffixes + variant + remaining variants + notes.
  const appliedText = rendered.map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).find((s) => s.includes('已应用'))
  assert.ok(appliedText.includes('task=qwen/qwen-plus（effort 模型默认）'), 'pick with effort-default suffix')
  assert.ok(appliedText.includes('verify=qwen/qwen-max（effort 模型默认）'), 'verify pick rendered')
  assert.ok(appliedText.includes('应用变体「A（均衡）」'), 'variant disclosed')
  assert.ok(appliedText.includes('其余变体：B（高要求）、C（轻量）'), 'remaining variants disclosed')
  const notesText = rendered.map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).find((s) => s.startsWith('备注：'))
  assert.ok(notesText.includes('session 参考（未应用）'), 'record notes rendered (session reference labeled not-applied)')
  // An effort token renders its suffix.
  const withEffortRecord = formatRecommendationRecord({
    status: 'ok', preset: 'openai', label: 'OpenAI', at: '2026-11-06T00:00:00.000Z',
    picks: { task: 'openai/gpt-6.1-sol' }, efforts: { task: 'high' },
  })
  const rendered2 = flatten(seat.view({ view: 'page', t, form: { ...form, getSnapshot: () => ({ ...snap, value: { ...snap.value, presetRecommendation: withEffortRecord } }) } }))
  const appliedText2 = rendered2.map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).find((s) => s.includes('已应用'))
  assert.ok(appliedText2.includes('task=openai/gpt-6.1-sol（effort high）'), 'effort token rendered in the pick')
  // Selecting a vendor writes the volatile presetPlan field (server resolves).
  await presetSelect.props.onChange({ target: { value: 'deepseek' } })
  assert.deepEqual(writes, [['presetPlan', 'deepseek']], 'selection writes the volatile presetPlan field')
  await presetSelect.props.onChange({ target: { value: '' } })
  assert.deepEqual(writes.at(-1), ['presetPlan', 'UNSET'], 'blanking writes the unset op')
  console.log('✓ v17 (9) card: 9 options + (none), session callout, enriched record, volatile write path')
}

console.log('\nALL v17 CHECKS PASSED')
