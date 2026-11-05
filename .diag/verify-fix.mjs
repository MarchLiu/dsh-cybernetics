import yaml from '/Users/mars/.dsh/profiles/web/node_modules/js-yaml/index.js';
import fs from 'node:fs';
import * as pi from '/Users/mars/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js';
const entries = yaml.load(fs.readFileSync('fixed-sample.yml', 'utf8'));
const e = entries.find((x) => x && x.id === 'llm-pi-ai');
console.log('hardGate present:', yaml.load(fs.readFileSync('fixed-sample.yml','utf8')).find(x=>x.id==='dsh-cybernetics')?.config);
for (const [pk, prof] of Object.entries(e.config.providers)) {
  console.log(` route ${pk}: models=${(prof.models||[]).map(m=>m.id).join(',')}`);
}
try { pi.Config(structuredClone(e.config)); console.log('Config() => OK (valid)'); }
catch (err) { console.log('Config() => THREW:', String(err.message).slice(0,300)); }
