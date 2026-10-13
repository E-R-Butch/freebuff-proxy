import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { buildForwardBody } from '../../../../../src/proxy/transport/forward-body.ts'
import { forwardCompletions } from '../../../../../src/proxy/transport/forward.ts'
import { officialSessionHeaders } from '../../../../../src/upstream/fingerprint/official-fingerprint.ts'
import { HEADER_MULTI_SESSION } from '../../../../../src/upstream/fingerprint/instance-id.ts'
import {
  HEADER_WALLET_SPEND_LIMIT,
  KNOWN_CLI_VERSION,
} from '../../../../../src/upstream/fingerprint/official-fingerprint.ts'
import { H_CLIENT_VERSION } from '../../../../../src/upstream/upstream-contract.ts'

const uuid = '00000000-0000-4000-8000-000000000001'
const settings = { upstreamChannel: 'legacy', freeToolSignatureEnabled: false }
const ctx = {
  config: { upstream: { channel: 'legacy' }, limits: { requestJitterMs: 0 } },
  settingsStore: { get: () => settings },
  sessions: { admit: () => assert.fail('unexpected admission'), release: () => assert.fail('unexpected release') },
}

/**
 * 构造带下游残留 metadata 的 fallback 请求体.
 * @param {any} instanceId 当前会话标识
 * @returns {any} 转发请求体
 */
function makeBody(instanceId: any) {
  return buildForwardBody(ctx, {
    messages: [{ role: 'user', content: 'fixture' }], stream: true,
    codebuff_metadata: { freebuff_multi_session: '0', surface: 'cli', fixture: 'keep' },
  }, 'fixture-model', instanceId, 'fixture-run', 'fixture-agent', 'fixture-client', null,
  'fixture-model', null).body
}

/**
 * 在内存里执行完整 fallback 转发与错误判定.
 * @param {any} instanceId 当前会话标识
 * @param {number} status 合成回执状态
 * @returns {Promise<void>} 断言完成
 */
async function checkForward(instanceId: any, status: number): Promise<void> {
  let calls = 0
  let output = ''
  let outputStatus = 0
  const req = { headers: {}, socket: new EventEmitter() }
  const res = {
    setHeader() {},
    writeHead(code: number) { outputStatus = code },
    write(chunk: any) { output += chunk.toString(); return true },
    end() {},
  }
  const body = makeBody(instanceId)
  const text = status === 200 ? 'data: [DONE]\n\n' : JSON.stringify({ error: 'fixture_conflict' })
  const upstream = {
    token: 'fixture',
    raw: async (path: string, opts: any) => {
      calls++
      assert.equal(path, '/api/v1/chat/completions', 'only the requested chat may be sent')
      const sent = JSON.parse(opts.body)
      assert.equal(sent.codebuff_metadata.freebuff_instance_id, instanceId)
      assert.equal(sent.codebuff_metadata.freebuff_multi_session, '1', 'chat must use the admitted session protocol')
      return new Response(text, {
        status, headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' },
      })
    },
  }
  const result = await forwardCompletions(ctx, {
    req, res, forwardBody: body, stream: true, upstream, instanceId,
    schedulingDeadline: Date.now() + 30_000, upstreamModel: 'fixture-model',
  })
  assert.equal(calls, 1, 'fallback must not issue an additional chat or admission')
  if (status === 200) {
    assert.equal(result.ok, true)
    assert.equal(outputStatus, 200)
    assert.equal(output, text, 'normal fallback SSE framing must remain intact')
  } else {
    assert.equal(result.status, status)
    assert.equal(result.recoverable, false, 'ordinary conflict must not cause re-admission')
    assert.equal(result.switchAccount, false, 'ordinary conflict must not cause account retry')
  }
}

const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('unexpected network request') }
try {
  for (const instanceId of [uuid, `cli:${uuid}`]) {
    const meta = makeBody(instanceId).codebuff_metadata
    assert.equal(meta.freebuff_multi_session, '1')
    assert.equal(meta.surface, instanceId.startsWith('cli:') ? 'cli' : undefined)
    assert.equal(meta.fixture, 'keep', 'unrelated metadata must survive')
    for (const method of ['GET', 'POST', 'DELETE']) {
      assert.equal(officialSessionHeaders(method, 'fixture', { instanceId })[HEADER_MULTI_SESSION], '1')
    }
    assert.equal(
      officialSessionHeaders('GET', 'fixture', { instanceId })[H_CLIENT_VERSION],
      KNOWN_CLI_VERSION,
      'the caller version must be the official client version, not the proxy package version',
    )
    assert.equal(
      officialSessionHeaders('POST', 'fixture', { instanceId })[HEADER_WALLET_SPEND_LIMIT],
      'session',
      'admission must send the current official spend-limit value',
    )
    assert.equal(
      officialSessionHeaders('GET', 'fixture', { instanceId })[HEADER_WALLET_SPEND_LIMIT],
      undefined,
      'the spend-limit header belongs to admission only',
    )
    await checkForward(instanceId, 200)
    await checkForward(instanceId, 409)
  }
  for (const instanceId of ['', '   ', null, undefined]) {
    const meta = makeBody(instanceId).codebuff_metadata
    assert.equal(meta.freebuff_multi_session, undefined, 'empty identity must not inherit a protocol marker')
    assert.equal(meta.surface, undefined, 'empty identity must not inherit the CLI surface')
  }
  console.log('PASS multi-session')
} finally {
  globalThis.fetch = originalFetch
}
