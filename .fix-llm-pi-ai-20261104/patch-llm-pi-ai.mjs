// Text-level patcher for the llm-pi-ai `off` reasoning-effort key.
// Deliberately NOT a YAML round-trip: it edits the affected lines only and
// keeps every other byte (comments, quoting, block scalar styles) untouched.
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';

const [mode, target, backupArg] = process.argv.slice(2);
if (!mode || !target) {
  console.error('usage: node patch-llm-pi-ai.mjs <minimal|from-backup> <target> [backup]');
  process.exit(2);
}
if (!existsSync(target)) { console.error(`target not found: ${target}`); process.exit(1); }
const mode600 = statSync(target).mode & 0o777;

function assertNoOtherAmbiguousKeys(text) {
  const bad = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s+(true|false|yes|no|on|off):/.test(line)) bad.push(`${i + 1}: ${line.trim()}`);
  });
  // The only acceptable mapping keys spelled like YAML 1.1 booleans are the two
  // quoted "off" keys we write ourselves.
  const unexpected = bad.filter((row) => !/^\d+: "off": null$/.test(row));
  if (unexpected.length) throw new Error(`unexpected YAML-1.1-looking mapping key(s):\n${unexpected.join('\n')}`);
}

function patchMinimal(text) {
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((line, i) => { if (/^ {14}false: null$/.test(line)) hits.push(i); });
  if (hits.length !== 2) throw new Error(`expected exactly 2 "false: null" key lines, found ${hits.length} (lines ${hits.map((i) => i + 1).join(', ')})`);
  for (const i of hits) {
    // context guard: the key must sit inside a model's reasoningEfforts block
    const window = lines.slice(Math.max(0, i - 14), i).join('\n');
    if (!/reasoningEfforts:\s*$/.test(window.split('\n').filter((l) => l.trim()).pop() ?? '')) {
      throw new Error(`line ${i + 1}: "false:" is not the first key under reasoningEfforts — refusing`);
    }
    if (!/^\s*-\s*id:\s*glm-5\.3(-flash)?\s*$/m.test(window)) {
      throw new Error(`line ${i + 1}: enclosing model is not glm-5.3 / glm-5.3-flash — refusing`);
    }
    lines[i] = '              "off": null';
  }
  return { text: lines.join('\n'), touched: hits.map((i) => i + 1) };
}

function patchFromBackup(text) {
  if ((text.match(/^ {14}off: null$/gm) ?? []).length !== 2) throw new Error('backup does not contain the two "off: null" keys');
  text = text.replace(/^( {14})off: null$/gm, '$1"off": null');
  const before = '    provider: zai-coding-cn\n    model: glm-5.3-flash\n';
  if (!text.includes(before)) throw new Error('agent-default-model block not found in backup');
  text = text.replace(before, '    provider: deepseek-account\n    model: deepseek-flash\n    reasoningEffort: high\n');
  const triage = '    triageAgentModel: zai-coding-cn/glm-5.3-flash\n';
  if (!text.trimEnd().endsWith(triage.trimEnd())) throw new Error('cybernetics tail not found in backup');
  if (!/^\s+hardGate: true$/m.test(text)) text = text.trimEnd() + '\n    hardGate: true\n';
  return { text, touched: ['off keys (2)', 'agent-default-model', 'cybernetics.hardGate'] };
}

let result;
if (mode === 'minimal') {
  result = patchMinimal(readFileSync(target, 'utf8'));
} else if (mode === 'from-backup') {
  if (!backupArg) { console.error('from-backup mode needs the backup path as 3rd argument'); process.exit(2); }
  result = patchFromBackup(readFileSync(backupArg, 'utf8'));
} else {
  console.error(`unknown mode: ${mode}`); process.exit(2);
}
assertNoOtherAmbiguousKeys(result.text);
writeFileSync(target, result.text, { mode: mode600 });
console.log(`patched (${mode}): ${target}`);
console.log(`  changed: ${result.touched.join(', ')}`);
