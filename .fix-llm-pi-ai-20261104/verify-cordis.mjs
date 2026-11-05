import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const PROFILE = '/Users/mars/.dsh/profiles/web';
const require = createRequire(PROFILE + '/package.json');
const jsyaml = require('js-yaml');
const yamlPkg = require('yaml');
const { Config } = await import(PROFILE + '/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js');

const path = process.argv[2];
const text = readFileSync(path, 'utf8');
const out = { file: path, sha256_note: 'see shasum', jsYamlVersion: require('js-yaml/package.json').version, yamlPkgVersion: require('yaml/package.json').version };

// 1) js-yaml (YAML 1.2 core) parse
let doc;
try {
  doc = jsyaml.load(text);
  out.jsYaml = { ok: true, entries: doc.length };
} catch (e) {
  out.jsYaml = { ok: false, error: String(e.message) };
  console.log(JSON.stringify(out, null, 2));
  process.exit(2);
}

// 2) `yaml` package (YAML 1.2) parse, the parser the config editor uses
try {
  const d2 = yamlPkg.parse(text);
  out.yamlPkg = { ok: true, entries: d2.length };
} catch (e) {
  out.yamlPkg = { ok: false, error: String(e.message) };
}

// 3) scan every mapping key for YAML-1.1-ambiguous spellings
const ambiguous = [];
const walk = (node, p) => {
  if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${p}[${i}]`));
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (/^(true|false|yes|no|on|off)$/i.test(k)) ambiguous.push(`${p}.${k} (typeof key="${typeof k}", value=${JSON.stringify(v)})`);
      walk(v, `${p}.${k}`);
    }
  }
};
walk(doc, '$');
out.ambiguousYaml11Keys = ambiguous;

// 4) llm-pi-ai schema validation of the `llm-pi-ai` entry config
const entry = doc.find((e) => e && e.id === 'llm-pi-ai');
if (!entry) { out.llmPiAi = { ok: false, error: 'no llm-pi-ai entry' }; }
else {
  const effortKeys = entry.config.providers['zai-coding-cn'].models
    .filter((m) => m.reasoningEfforts)
    .map((m) => ({ id: m.id, keys: Object.keys(m.reasoningEfforts).map((k) => `${typeof k}:${k}`) }));
  try {
    const parsed = Config(entry.config);
    const providers = parsed.providers?.get ? parsed.providers.get() : parsed.providers;
    out.llmPiAi = { ok: true, providers: Object.keys(providers), modelsPerProvider: Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, (v.models || []).map((m) => m.id)])), reasoningEffortKeys: effortKeys };
  } catch (e) {
    out.llmPiAi = { ok: false, error: String(e.message).split('\n').slice(0, 8), reasoningEffortKeys: effortKeys };
  }
}

// 5) cybernetics block + comment integrity
const cyber = doc.find((e) => e && e.id === 'dsh-cybernetics');
out.cybernetics = cyber ? cyber.config : null;
const commentLines = text.split('\n').filter((l) => l.trimStart().startsWith('#')).length;
out.commentLines = commentLines;
out.hardGatePresentInText = /^\s+hardGate: true$/m.test(text);
out.allGoalsModePresentInText = /^\s+allGoalsMode: true$/m.test(text);
out.agentDefaultModel = doc.find((e) => e && e.id === 'agent-default-model')?.config ?? null;

console.log(JSON.stringify(out, null, 2));
