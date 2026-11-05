// Mock-host end-to-end test against the LIVE patched ptc file:
// extracts WORKFLOW_GUEST_SOURCE, materializes it as a real module, drives it
// with a fake host and asserts (1) reasoningEffort reaches startChild and
// (2) unknown options still fail with UNSUPPORTED_OPTION.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const LIVE = '/Users/mars/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-workflow-ptc/lib/index.js'
const src = await readFile(LIVE, 'utf8')
const m = src.match(/const WORKFLOW_GUEST_SOURCE = ("(?:[^"\\]|\\.)*");/)
assert.ok(m, 'WORKFLOW_GUEST_SOURCE string literal found')
const guestSource = new Function(`return ${m[1]}`)()
const dir = await mkdtemp(join(tmpdir(), 'ptc-e2e-'))
const guestPath = join(dir, 'guest.mjs')
await writeFile(guestPath, guestSource, 'utf8')
const { runWorkflowGuest } = await import(pathToFileURL(guestPath).href)

async function drive(body) {
  const childRequests = []
  const disposed = []
  const result = await runWorkflowGuest({
    async begin() {
      return {
        meta: { name: 'e2e' },
        body,
        args: {},
        limits: { maxConcurrentAgents: 4, maxTotalAgents: 8, maxItemsPerCall: 100, syncTimeoutMs: 5000 },
      }
    },
    async progress() {},
    async startChild(request) {
      childRequests.push(request)
      const callId = childRequests.length
      return { callId, childId: `child-${callId}` }
    },
    childResult({ callId }) {
      return Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: `ok-${callId}` }] })
    },
    async disposeChild({ callId }) { disposed.push(callId); return null },
  })
  return { result, childRequests, disposed }
}

// 1) reasoningEffort reaches startChild
{
  const { result, childRequests, disposed } = await drive(`return await agent("do it", { reasoningEffort: "high", model: "glm-5.3-flash" })`)
  assert.equal(result.stopReason, 'completed', 'script completed')
  assert.equal(result.value, 'ok-1')
  assert.equal(childRequests.length, 1)
  assert.equal(childRequests[0].reasoningEffort, 'high', 'reasoningEffort forwarded to startChild')
  assert.equal(childRequests[0].model, 'glm-5.3-flash')
  assert.deepEqual(disposed, [1], 'child disposed')
  console.log('PASS 1: startChild request =', JSON.stringify(childRequests[0]))
}

// 2) unknown option still UNSUPPORTED_OPTION (fatal, script-level error)
{
  const { result } = await drive(`return await agent("do it", { foo: 1 })`)
  assert.equal(result.stopReason, 'error')
  assert.match(result.error, /is not recognized \(supported: label, phase, schema, provider, model\)/, 'unknown option rejected loudly (WorkflowError code = UNSUPPORTED_OPTION, rendered message = not-recognized)')
  console.log('PASS 2:', result.error.split('\n')[0])
}

// 3) effort-only bag (no model override) also forwarded
{
  const { childRequests } = await drive(`return await agent("p2", { reasoningEffort: "low" })`)
  assert.equal(childRequests[0].reasoningEffort, 'low')
  assert.equal(childRequests[0].model, undefined)
  console.log('PASS 3: effort-only bag forwarded:', JSON.stringify(childRequests[0]))
}

await rm(dir, { recursive: true, force: true })
console.log('E2E OK: 3/3 scenarios passed against the live patched file')
