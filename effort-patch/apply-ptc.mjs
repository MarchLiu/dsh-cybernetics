// v0.15 dsh-workflow-ptc seam installer — CONTENT-VERIFIED stage install.
//
// The @deepseek-ai/dsh-workflow-ptc package lives under the host profile
// (outside the session workspace), so it is installed by this script, which
// must run with write access to the profile. Safety: before any write, the CURRENT
// real file must contain the exact unpatched anchors AND the stage copy the
// exact patched counterparts (both unique). Any mismatch aborts with zero
// writes. A timestamped .bak is taken before install.
//
// NOTE on escaping: this build artifact embeds the workflow guest source as a
// single-line escaped JS string — inside it, `\n` and `\"` are LITERAL
// two-character sequences while indents are REAL tabs. Anchors below are
// written accordingly.
//
// Usage:
//   node apply-ptc.mjs check|dry-run|apply|verify [--ptc <lib/index.js>] [--stage <lib/index.js>]

import { readFileSync, copyFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mode = process.argv[2] ?? 'check'
const ptcArg = process.argv.includes('--ptc') ? process.argv[process.argv.indexOf('--ptc') + 1] : undefined
const stageArg = process.argv.includes('--stage') ? process.argv[process.argv.indexOf('--stage') + 1] : undefined
const ptcPath = resolve(ptcArg ?? '/Users/mars/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-workflow-ptc/lib/index.js')
const stagePath = resolve(stageArg ?? here + '/stage/dsh-workflow-ptc/lib/index.js')

// building blocks for the escaped-string region
const NL = '\\n'      // literal backslash + n
const Q = '\\"'       // literal backslash + quote
const T = '\t'        // real tab
const q = (s) => Q + s + Q

const PRE_ANCHORS = [
  ['guest-string: whitelist without effort',
    `const SUPPORTED_AGENT_OPTIONS = new Set([${NL}${T}${q('label')},${NL}${T}${q('phase')},${NL}${T}${q('schema')},${NL}${T}${q('provider')},${NL}${T}${q('model')}${NL}]);`],
  ['guest-string: string-check list without effort',
    `for (const key of [${NL}${T}${T}${T}${q('label')},${NL}${T}${T}${T}${q('phase')},${NL}${T}${T}${T}${q('provider')},${NL}${T}${T}${T}${q('model')}${NL}${T}${T}]) if (record[key] !== void 0 && typeof record[key] !== ${q('string')}`],
  ['guest-string: startAgent request without effort',
    `...opts.model !== void 0 ? { model: opts.model } : {}${NL}${T}${T}${T}${T}});`],
  ['guest-string: readAgentOptions return without effort',
    `...record.model !== void 0 ? { model: record.model } : {},${NL}${T}${T}${T}...schema !== void 0 ? { schema } : {}`],
  ['host: agentOptions gate without effort',
    '...request.provider === void 0 && request.model === void 0 ? {} : { agentOptions: {'],
]

const POST_ANCHORS = [
  ['guest-string: whitelist with effort',
    `${q('provider')},${NL}${T}${q('model')},${NL}${T}${q('reasoningEffort')}${NL}]);`],
  ['guest-string: startAgent effort passthrough',
    `...opts.reasoningEffort !== void 0 ? { reasoningEffort: opts.reasoningEffort } : {}`],
  ['guest-string: string-check list with effort',
    `${q('model')},${NL}${T}${T}${T}${q('reasoningEffort')}${NL}${T}${T}]) if (record[key]`],
  ['guest-string: readAgentOptions return with effort',
    `...record.reasoningEffort !== void 0 ? { reasoningEffort: record.reasoningEffort } : {}`],
  ['host: agentOptions gate with effort',
    'request.model === void 0 && request.reasoningEffort === void 0 ? {} : { agentOptions: {'],
  ['host: effort forwarded',
    '...request.reasoningEffort === void 0 ? {} : { reasoningEffort: request.reasoningEffort }'],
]

let real, stage
try { real = readFileSync(ptcPath, 'utf8') } catch (e) { console.error(`FAIL: cannot read ${ptcPath}: ${e.message}`); process.exit(1) }
try { stage = readFileSync(stagePath, 'utf8') } catch (e) { console.error(`FAIL: cannot read ${stagePath}: ${e.message}`); process.exit(1) }

let bad = 0
for (const [name, anchor] of PRE_ANCHORS) {
  const n = real.split(anchor).length - 1
  if (n !== 1) { console.error(`FAIL real ${ptcPath}: pre-anchor "${name}" matches ${n}× (need 1) — checkout content changed, DO NOT install blind`); bad++ }
  else console.log(`ok real pre-anchor: ${name}`)
}
for (const [name, anchor] of POST_ANCHORS) {
  const n = stage.split(anchor).length - 1
  if (n !== 1) { console.error(`FAIL stage ${stagePath}: post-anchor "${name}" matches ${n}× (need 1)`); bad++ }
  else console.log(`ok stage post-anchor: ${name}`)
}

if (mode === 'check' || mode === 'dry-run') {
  console.log(`\n${mode}: ${PRE_ANCHORS.length + POST_ANCHORS.length - bad}/${PRE_ANCHORS.length + POST_ANCHORS.length} anchor(s) verified; ${bad} failure(s)`)
  process.exit(bad === 0 ? 0 : 1)
}
if (mode === 'verify') {
  let miss = 0
  for (const [name, anchor] of POST_ANCHORS) {
    if (real.includes(anchor)) console.log(`ok installed: ${name}`)
    else { miss++; console.error(`MISSING in real: ${name}`) }
  }
  process.exit(miss === 0 ? 0 : 1)
}
// apply
if (bad !== 0) { console.error('apply: anchor verification failed — nothing written'); process.exit(1) }
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const bak = ptcPath + `.bak-v015effort-${stamp}`
copyFileSync(ptcPath, bak)
writeFileSync(ptcPath, stage)
console.log(`APPLIED ${ptcPath} (from verified stage copy); backup ${bak}`)
