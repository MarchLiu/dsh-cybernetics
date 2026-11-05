import yaml from '/Users/mars/.dsh/profiles/web/node_modules/js-yaml/index.js';
import fs from 'node:fs';
import * as pi from '/Users/mars/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js';

const files = [
  ['CURRENT ', '/Users/mars/.dsh/profiles/web/cordis.patch.yml'],
  ['BACKUP  ', '/Users/mars/.dsh/profiles/web/cordis.patch.yml.bak-pre-hardgate-20261104-172829'],
];
for (const [label, p] of files) {
  const entries = yaml.load(fs.readFileSync(p, 'utf8'));
  const e = entries.find((x) => x && x.id === 'llm-pi-ai');
  console.log('=====', label, p.split('/').pop(), '=====');
  const provs = Object.keys(e.config.providers ?? {});
  console.log('provider routes:', provs);
  for (const [pk, prof] of Object.entries(e.config.providers ?? {})) {
    for (const m of prof.models ?? []) {
      if (m.reasoningEfforts && typeof m.reasoningEfforts === 'object') {
        console.log(`  ${pk}/${m.id} reasoningEfforts keys:`, Object.keys(m.reasoningEfforts), 'values:', Object.values(m.reasoningEfforts));
      }
    }
  }
  try {
    const resolved = pi.Config(structuredClone(e.config));
    console.log('  Config() => OK, routes:', Object.keys(resolved.providers ?? {}));
  } catch (err) {
    console.log('  Config() => THREW:', String(err && err.message).slice(0, 500));
  }
}
