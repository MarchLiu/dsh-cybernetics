// v0.15 reasoning-effort patch runner — ANCHOR-BASED.
//
// Usage:
//   node patch-v2.mjs check            # verify every `find` anchor occurs exactly once (no write)
//   node patch-v2.mjs dry-run          # check + report per-file anchor counts (no write)
//   node patch-v2.mjs apply [--root R] # .bak backup per file, then anchor edits
//
// The patch table lives in ./patches.mjs. Covers the four workspace files of
// the dsh-cybernetics checkout (workflows/round.js, src/controller.ts,
// src/index.ts, lib/client.js). The @deepseek-ai/dsh-workflow-ptc seam is
// handled separately by apply-ptc.mjs (outside the workspace; content-verified
// stage install).
//
// Idempotence: an already-applied anchor aborts ONLY in check/dry-run with a
// clear "already applied" signal (the find text no longer matches); apply
// skips patches whose REPLACEMENT is already present.

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PATCHES } from './patches.mjs'

const mode = process.argv[2] ?? 'check'
if (!['check', 'dry-run', 'apply'].includes(mode)) {
  console.error('usage: node patch-v2.mjs check|dry-run|apply [--root <checkout root>]')
  process.exit(2)
}
const rootArg = process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : undefined
// Default root: the checkout, which is this workspace (symlinked from the
// host profile as node_modules/@mars.liu/dsh-cybernetics).
const root = resolve(rootArg ?? new URL('..', import.meta.url).pathname)

const byFile = new Map()
for (const p of PATCHES) {
  if (!byFile.has(p.file)) byFile.set(p.file, [])
  byFile.get(p.file).push(p)
}

let failures = 0
let totalAnchors = 0
const backupStamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

for (const [file, patches] of byFile) {
  const abs = join(root, file)
  let text
  try {
    text = readFileSync(abs, 'utf8')
  } catch (e) {
    console.error(`FAIL ${file}: cannot read (${e.message})`)
    failures++
    continue
  }
  let fileAnchors = 0
  let fileOk = true
  for (const p of patches) {
    // Applied-state detection: insertion-style patches (replace = find + tail)
    // keep `find` matching after apply, so "already applied" must be detected
    // via the INSERTED tail; replacement-style patches use the whole
    // replacement text.
    const doneText = p.done ?? (p.replace.startsWith(p.find) ? p.replace.slice(p.find.length) : p.replace)
    const count = text.split(p.find).length - 1
    // A pure-deletion patch has an empty applied-state marker: "done" == the
    // anchor is gone.
    const doneCount = doneText === '' ? (count === 0 ? 1 : 0) : text.split(doneText).length - 1
    if (doneCount >= 1) {
      console.log(`SKIP ${file} :: ${p.id} (already applied)`)
    } else if (count === 1) {
      fileAnchors++
      if (mode === 'apply') text = text.replace(p.find, p.replace)
    } else {
      console.error(`FAIL ${file} :: ${p.id}: anchor matches ${count}× (need exactly 1; already-applied matches ${doneCount}×)`)
      fileOk = false
      failures++
    }
  }
  if (mode === 'apply' && fileOk) {
    const bak = abs + `.bak-v015effort-${backupStamp}`
    copyFileSync(abs, bak)
    writeFileSync(abs, text)
    console.log(`APPLIED ${file}: ${fileAnchors} anchor edit(s); backup ${bak}`)
  } else if (fileOk) {
    console.log(`OK ${file}: ${fileAnchors}/${patches.length} anchor(s) matched`)
  }
  totalAnchors += fileAnchors
}

if (mode === 'dry-run' || mode === 'check') {
  console.log(`\n${mode}: ${totalAnchors}/${PATCHES.length} anchor(s) ready, ${failures} failure(s)`)
  process.exit(failures === 0 ? 0 : 1)
}
console.log(`\napply: ${totalAnchors}/${PATCHES.length} anchor edit(s) written, ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
