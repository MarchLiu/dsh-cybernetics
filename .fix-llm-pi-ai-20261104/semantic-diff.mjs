import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const PROFILE = '/Users/mars/.dsh/profiles/web';
const require = createRequire(PROFILE + '/package.json');
const jsyaml = require('js-yaml');
const load = (p) => jsyaml.load(readFileSync(p, 'utf8'));

function diff(a, b, path, out) {
  if (a === b) return;
  const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
  const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b;
  if (ta !== tb) { out.push(`${path}: ${ta}(${JSON.stringify(a)}) -> ${tb}(${JSON.stringify(b)})`); return; }
  if (ta === 'array') {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!Object.hasOwn(a, k)) { out.push(`${path}.${k}: <absent> -> ${JSON.stringify(b[k])}`); continue; }
      if (!Object.hasOwn(b, k)) { out.push(`${path}.${k}: ${JSON.stringify(a[k])} -> <absent>`); continue; }
      diff(a[k], b[k], `${path}.${k}`, out);
    }
    return;
  }
  out.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
}

const [left, right] = process.argv.slice(2);
const a = load(left), b = load(right);
const out = [];
diff(a, b, '$', out);
console.log(`semantic diffs ${left} -> ${right}: ${out.length}`);
for (const line of out) console.log('  ' + line);
const ids = (d) => d.map((e) => e.id).join(',');
console.log('entry ids equal:', ids(a) === ids(b), `(${a.length} entries)`);
