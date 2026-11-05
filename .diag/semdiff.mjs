import yaml from '/Users/mars/.dsh/profiles/web/node_modules/js-yaml/index.js';
import fs from 'node:fs';
const D = '/Users/mars/.dsh/profiles/web/';
const A = yaml.load(fs.readFileSync(D + 'cordis.patch.yml.bak-pre-hardgate-20261104-172829', 'utf8'));
const B = yaml.load(fs.readFileSync(D + 'cordis.patch.yml', 'utf8'));
function index(entries) { const m = new Map(); for (const e of entries ?? []) m.set(e.id ?? JSON.stringify(e), e); return m; }
const ia = index(A), ib = index(B);
const onlyA = [...ia.keys()].filter(k => !ib.has(k));
const onlyB = [...ib.keys()].filter(k => !ia.has(k));
console.log('entries only in BACKUP:', onlyA);
console.log('entries only in CURRENT:', onlyB);
function walk(a, b, path, out) {
  if (a === b) return;
  const ta = Array.isArray(a) ? 'array' : typeof a, tb = Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb || ta !== 'object' || a === null || b === null) {
    if (ta === 'array' && tb === 'array' && a.length === b.length) {
      for (let i = 0; i < a.length; i++) walk(a[i], b[i], `${path}[${i}]`, out);
      return;
    }
    out.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) { out.push(`${path}.${k}: <absent> -> ${JSON.stringify(b[k])}`); continue; }
    if (!(k in b)) { out.push(`${path}.${k}: ${JSON.stringify(a[k])} -> <absent>`); continue; }
    walk(a[k], b[k], `${path}.${k}`, out);
  }
}
const out = [];
for (const k of new Set([...ia.keys(), ...ib.keys()])) walk(ia.get(k), ib.get(k), k, out);
console.log(`\nsemantic differences (${out.length}):`);
for (const line of out) console.log(' -', line.length > 300 ? line.slice(0, 300) + '…' : line);
