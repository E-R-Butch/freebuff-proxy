import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'rpc-body-'))
const runner = join(dir, 'fake-bun')
const captureFile = join(dir, 'calls.jsonl')
const fixturePath = fileURLToPath(new URL('../../../../fixtures/rpc/fake-bun.ts', import.meta.url))
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
writeFileSync(runner, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixturePath)} "$@"\n`, { mode: 0o700 })
const previousRunner = process.env.FREEBUFF_BUN_BIN
process.env.FREEBUFF_BUN_BIN = runner
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('unexpected network request') }

const { rpcReuse } = await import('../../../../../src/upstream/rpc/ports.ts')
const { runStreamingRpc } = await import('../../../../../src/proxy/transport/official/stream.ts')
const { normalizeUpstreamError } = await import('../../../../../src/proxy/transport/errors/normalize.ts')
const instanceId = '00000000-0000-4000-8000-000000000001'
const args = (fixture: any) => ({
  cfg: { fixture, captureFile }, instanceId, modelKey: 'fixture-model',
  messages: [{ role: 'user', content: 'fixture' }], timeoutMs: 5_000,
})
const fixtures = [
  { status: 410, text: JSON.stringify({ error: 'freebuff_update_required', message: '请更新客户端' }) },
  { status: 409, text: JSON.stringify({ error: 'fixture_conflict', message: 'conflict details' }) },
  { status: 409, text: 'plain conflict body\nsecond line' },
  { status: 410, statusLine: null, text: JSON.stringify({ error: 'freebuff_update_required' }) },
]
const sse = [
  'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
].map((line) => line + '\n\n').join('')

try {
  for (const fixture of fixtures) {
    const lines: string[] = []
    const statuses: number[] = []
    const rpc = await rpcReuse({
      ...args(fixture), onLine: (line: string) => lines.push(line),
      onStatus: (status: number) => statuses.push(status),
    })
    assert.equal(rpc.status, fixture.status, 'RPC must preserve the upstream HTTP status')
    assert.equal(rpc.text, fixture.text, 'RPC must preserve the complete non-200 summary body')
    assert.equal(rpc.ok, false)
    assert.deepEqual(lines, [], 'error summary must not become streamed data')
    assert.deepEqual(statuses, fixture.statusLine === null ? [] : [fixture.status])
    assert.equal(rpc.runId, 'fixture-run')

    const result = await runStreamingRpc(args(fixture), null, [], {})
    assert.ok(result, 'non-200 RPC must produce a response instead of a legacy fallback')
    assert.equal(result.upstreamRes.status, fixture.status)
    assert.equal(result.upstreamErrText, fixture.text)
    assert.equal(await result.upstreamRes.text(), fixture.text, 'downstream must receive the error body')
    const verdict = await normalizeUpstreamError({}, {
      ...result, status: result.upstreamRes.status, respHeaders: {},
    })
    assert.equal(verdict.recoverable, false, 'update/conflict errors must not re-admit a session')
    assert.equal(verdict.switchAccount, false, 'update/conflict errors must not retry another account')
  }

  const success = { status: 200, sse, text: 'summary copy must not be streamed again' }
  const lines: string[] = []
  const statuses: number[] = []
  const rpc = await rpcReuse({
    ...args(success), onLine: (line: string) => lines.push(line), onStatus: (s: number) => statuses.push(s),
  })
  assert.equal(rpc.ok, true)
  assert.equal(rpc.text, '', 'successful SSE content must have only one delivery path')
  assert.deepEqual(statuses, [200], 'status control frame must be delivered exactly once')
  assert.equal(lines.map((line) => line + '\n').join(''), sse, 'RPC must preserve SSE event delimiters')
  const result = await runStreamingRpc(args(success), null, [], {})
  assert.ok(result)
  assert.equal(result.upstreamRes.status, 200)
  assert.match(result.upstreamRes.headers.get('content-type'), /text\/event-stream/)
  assert.equal(await result.upstreamRes.text(), sse, 'downstream SSE content, stop and DONE must appear once')
  assert.equal(result.upstreamErrText, null)
  const calls = readFileSync(captureFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(calls.length, fixtures.length * 2 + 2, 'one Bun invocation per request, without retries')
  assert.ok(calls.every((call) => call.action === 'reuse' && call.instanceId === instanceId),
    'every RPC must reuse the same session without admission')
  console.log('PASS rpc-error-body')
} finally {
  globalThis.fetch = originalFetch
  if (previousRunner === undefined) delete process.env.FREEBUFF_BUN_BIN
  else process.env.FREEBUFF_BUN_BIN = previousRunner
  rmSync(dir, { recursive: true, force: true })
}
