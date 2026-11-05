#!/usr/bin/env node
// One-shot migration: repair session.v4.jsonl.zstd logs that contain UNMARKED
// `cybernetics/mode` events (written by dsh-cybernetics v0.9.0–v0.13.0 through
// the plain `Session.append` path). Such events fail-close every harness build
// that does not know the type:
//   packages/session/session-persistence/src/storage-contract.ts:75
//   `... unknown to this harness and not marked ignorable; refusing to interpret the log ...`
//
// The envelope contract (packages/core/session/src/types.ts:519,
// session-log-deepseek/src/types.ts:36) accepts an optional top-level
// `ignorable: true` field; unknown ignorable records are retained and skipped
// (surface.ts:306). This script stamps `ignorable: true` onto exactly those
// events, re-serializes each line with JSON.stringify (same encoder the
// harness writes with), and re-compresses with the zstd CLI.
//
// SAFETY:
// - default is DRY-RUN: prints the affected sessions and would-be edits;
// - `--apply` first copies the original to `<file>.bak` (never overwritten),
//   then atomically replaces the log (temp file + rename);
// - only events with type 'cybernetics/mode' (and ignorable !== true) are
//   touched; every other line is byte-preserved;
// - if any line fails to parse or re-serialize, the file is aborted untouched.
//
// Usage:
//   node scripts/fix-cybernetics-mode-events.mjs [sessionsRoot]
//   node scripts/fix-cybernetics-mode-events.mjs --apply [sessionsRoot]
// Default sessionsRoot: /Users/mars/.dsh/sessions

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, renameSync, copyFileSync, statSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const LEGACY_TYPE = 'cybernetics/mode'
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const root = args.find((a) => !a.startsWith('--')) ?? '/Users/mars/.dsh/sessions'

function die(msg) {
  console.error(`fix-cybernetics-mode-events: ${msg}`)
  process.exit(1)
}

function zstdAvailable() {
  const probe = spawnSync('zstd', ['--version'], { encoding: 'utf8' })
  return probe.status === 0
}
if (!zstdAvailable()) die('zstd CLI not found on PATH')

function decompress(path) {
  // Session dirs are named `--<path>--`, so prefix ./ to keep the zstd CLI
  // from parsing the leading dashes as options.
  const rel = path.startsWith('-') ? `./${path}` : path
  const r = spawnSync('zstd', ['-dc', rel], { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' })
  if (r.status !== 0) throw new Error(`zstd -dc failed (${r.status}): ${r.stderr.toString().slice(0, 200)}`)
  return r.stdout
}

function compress(content, outPath) {
  const rel = outPath.startsWith('-') ? `./${outPath}` : outPath
  const tmp = `${outPath}.tmp-fix-${process.pid}`
  const r = spawnSync('zstd', ['-q', '-o', tmp, '-'], { input: content, maxBuffer: 1024 * 1024, encoding: 'buffer' })
  if (r.status !== 0) {
    try { if (existsSync(tmp)) renameSync(tmp, `${tmp}.discarded`) } catch { /* best effort */ }
    throw new Error(`zstd compress failed (${r.status}): ${r.stderr.toString().slice(0, 200)}`)
  }
  return tmp
}

function* walkJsonlZstd(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkJsonlZstd(p)
    else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') yield p
  }
}

let scanned = 0
let fixable = 0
let fixed = 0
const plan = []

for (const path of walkJsonlZstd(root)) {
  if (existsSync(`${path}.bak`)) continue // already repaired once — never double-apply
  if (extname(path) === '.tmp-fix' || path.includes('.tmp-fix-')) continue
  scanned += 1
  let raw
  try { raw = decompress(path) } catch (e) { console.error(`SKIP (decompress): ${path}: ${e.message}`); continue }
  const text = raw.toString('utf8')
  if (!text.includes(`"type":"${LEGACY_TYPE}"`)) continue

  const lines = text.split('\n')
  const edits = []
  const out = lines.map((line, i) => {
    if (!line.includes(`"type":"${LEGACY_TYPE}"`)) return line
    let ev
    try { ev = JSON.parse(line) } catch { return line } // substring in a message body; leave untouched
    if (ev?.type !== LEGACY_TYPE || ev.ignorable === true) return line
    // Envelope key order matches the harness writer (type,seq,time,data) with
    // `ignorable` last, exactly like appendPluginRecord's record shape.
    edits.push({ line: i + 1, seq: ev.seq, enabled: ev.data?.enabled })
    return JSON.stringify({ type: ev.type, seq: ev.seq, time: ev.time, data: ev.data, ignorable: true })
  })
  if (edits.length === 0) continue
  fixable += 1
  plan.push({ path, edits })
  const editList = edits.map((e) => `    line ${e.line} seq ${e.seq} enabled=${e.enabled}`).join('\n')
  console.log(`WOULD FIX ${path}\n${editList}`)
  if (!apply) continue

  try {
    copyFileSync(path, `${path}.bak`) // fails via exception if it exists — belt & braces
    const fixedText = out.join('\n')
    const tmp = compress(Buffer.from(fixedText, 'utf8'), path)
    // Round-trip sanity before replacing: the fixed log must decompress back to
    // the fixed text exactly.
    const check = decompress(tmp).toString('utf8')
    if (check !== fixedText) throw new Error('round-trip mismatch; original left untouched')
    renameSync(tmp, path)
    fixed += 1
    console.log(`FIXED ${path} (backup: ${path}.bak)`)
  } catch (e) {
    console.error(`ABORT ${path}: ${e.message} — original left untouched`)
  }
}

console.log(`\nscanned=${scanned} fixable=${fixable} fixed=${fixed} mode=${apply ? 'APPLY' : 'DRY-RUN (pass --apply to write)'}`)
if (!apply && fixable > 0) process.exitCode = 2 // nonzero = "there is work to do"
