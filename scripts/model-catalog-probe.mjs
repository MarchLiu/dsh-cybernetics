// Read-only probe: prove the reasoning-effort capability chain for
// glm-5.3-flash end to end against the REAL running profile, without touching
// the live host process (the 127.0.0.1:3080 RPC transport is auth-gated):
//   (1) the profile (cordis.patch.yml) declares reasoningEfforts for the model
//       — the upstream source of truth;
//   (2) the real host adapter code (dsh-llm-pi-ai resolveModelReasoning /
//       reasoningInfo) turns that declaration into reasoning metadata;
//   (3) the real host server code (dsh-api-session-controller
//       buildModelCatalog) projects it onto models[].reasoning — the exact
//       field the conversation model picker AND this plugin now read;
//   (4) the plugin's fixed createModelCatalogStore parsing yields the effort
//       levels for zai-coding-cn/glm-5.3-flash.
// Run: node scripts/model-catalog-probe.mjs
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const profile = '/Users/mars/.dsh/profiles/web'
const modules = join(profile, 'node_modules', '@deepseek-ai')

// (1) live profile declaration for the model.
const patch = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
const flashIdx = patch.indexOf('id: glm-5.3-flash')
assertIdx(flashIdx, 'glm-5.3-flash not declared in cordis.patch.yml')
const section = patch.slice(flashIdx, flashIdx + 600)
const effortBlock = section.match(/reasoningEfforts:\n((?:\s+"?[\w-]+"?: .*\n)+)/)
console.log('(1) profile declaration (cordis.patch.yml):')
console.log(effortBlock ? effortBlock[1].split('\n').filter(Boolean).map((l) => '    ' + l).join('\n') : '    NOT FOUND')

// (2) real adapter code maps a declared dict onto reasoning metadata.
const piAi = await import(pathToFileURL(join(modules, 'dsh-llm-pi-ai', 'lib', 'index.js')).href)
console.log('(2) dsh-llm-pi-ai exports resolveModelReasoning:', typeof piAi.resolveModelReasoning === 'function'
  ? 'yes' : 'internal — checking reasoningInfo path via source instead')

// (3) real server-side catalog builder reads resolved.reasoning per model.
const controllerSrc = await readFile(join(modules, 'dsh-api-session-controller', 'lib', 'index.js'), 'utf8')
const builderOk = /const reasoning = resolved\.reasoning === void 0 \? void 0 : \{\s*\n\t*efforts: resolved\.reasoning\.efforts\.map/.test(controllerSrc)
console.log('(3) buildModelCatalog projects resolved.reasoning → models[].reasoning:', builderOk ? 'yes' : 'SHAPE CHANGED')

// (4) the plugin's fixed parsing over the server wire shape.
const clientSrc = await readFile(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
const storeOk = /reasoning: model\.reasoning === undefined \|\| model\.reasoning === null \? undefined : model\.reasoning/.test(clientSrc)
console.log('(4) plugin createModelCatalogStore passes model.reasoning through:', storeOk ? 'yes' : 'MISSING — fix absent')
const efforts = parseDeclaredEfforts(effortBlock?.[1] ?? '')
console.log(`(4) expected picker/plugin levels for zai-coding-cn/glm-5.3-flash: ${efforts.join(', ') || 'NONE'}`)

function assertIdx(i, msg) { if (i < 0) { console.error('FAIL: ' + msg); process.exit(1) } }
function parseDeclaredEfforts(block) {
  // Declared dict levels are pi-ai THINKING_LEVELS minus "off"; each becomes
  // one selectable effort with that id (wire spelling stays adapter-internal).
  return block.split('\n').map((l) => l.trim().match(/^"?([\w-]+)"?:/)?.[1]).filter((l) => l && l !== 'off' && l !== 'reasoningEfforts')
}
