import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore, DEFAULT_SETTINGS } from '../../../../../src/web/store/config/settings-store.ts'
import { applyStoredSettings } from '../../../../../src/web/store/config/settings-fields.ts'
import { startCliVersionRefresh } from '../../../../../bin/serve/boot/version-refresh/index.ts'
import { getCliVersion, refreshCliVersion, setCliVersion } from '../../../../../src/upstream/fingerprint/cli-version.ts'
import { fakeClock } from '../../../../helpers/version/clock.ts'
import { settingsRequest } from '../../../../helpers/version/settings.ts'
import { checkBodyCancellation, checkRapidReenable, checkLateResults } from '../../../../helpers/version/body.ts'
import { logger } from '../../../../../src/util/log.ts'

const dir = mkdtempSync(join(tmpdir(), 'version-refresh-'))
const file = join(dir, 'settings.json')
const originalVersion = getCliVersion()
const originalFetch = globalThis.fetch
const originalWarn = logger.warn
const warnings: any[] = []
logger.warn = (message, fields) => { warnings.push({ message, fields }) }
globalThis.fetch = async () => { throw new Error('unexpected real fetch') }
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
const response = (version: any) => ({ ok: true, json: async () => ({ version }) })

/**
 * 检查实际 POST 保存后的 GET 快照与重载读回.
 * @returns {Promise<void>} 断言完成
 */
async function checkReadback(): Promise<void> {
  const store = new SettingsStore(join(dir, 'readback.json'))
  assert.equal((await settingsRequest(store, 'GET')).body.cliVersionAutoRefresh, false)
  for (const value of [true, false]) {
    const saved = await settingsRequest(store, 'POST', value)
    assert.equal(saved.status, 200)
    assert.equal(saved.body.cliVersionAutoRefresh, value)
    for (const current of [store, new SettingsStore(store.file)]) {
      const readback = await settingsRequest(current, 'GET')
      assert.equal(readback.status, 200)
      assert.equal(readback.body.cliVersionAutoRefresh, value, `GET must explicitly return ${value}`)
    }
  }
}

/**
 * 检查实时切换, 持久化和在途取消.
 * @returns {Promise<void>} 断言完成
 */
async function checkLifecycle(): Promise<void> {
  const store = new SettingsStore(file)
  const clock = fakeClock()
  const calls: any[] = []
  let pending: ((value: any) => void) | null = null
  let hold = false
  const refresh = (opts: any) => refreshCliVersion({
    ...opts, ...clock,
    fetchImpl: async (url: string, init: any) => {
      assert.equal(url, 'https://registry.npmjs.org/freebuff/latest', 'only npm metadata may be requested')
      calls.push(init)
      return hold ? new Promise((resolve) => { pending = resolve }) : response('9.8.7')
    },
  })
  const stop = startCliVersionRefresh(store, {}, { ...clock, refresh })
  try {
    assert.equal(store.get().cliVersionAutoRefresh, false)
    assert.equal(clock.intervals.size, 0, 'disabled startup must not arm a registry timer')
    assert.equal(calls.length, 0, 'disabled startup must not fetch')
    assert.equal((await settingsRequest(store, 'POST', 'true')).status, 400, 'API must reject non-booleans')
    assert.equal((await settingsRequest(store, 'POST', true)).body.cliVersionAutoRefresh, true)
    await settle()
    assert.equal(calls.length, 1, 'false to true must fetch without a service restart')
    assert.equal(new SettingsStore(file).get().cliVersionAutoRefresh, true, 'true must survive reload')
    assert.equal(clock.intervals.size, 1)
    const timer = [...clock.intervals][0]
    assert.equal(timer.ms, 6 * 60 * 60 * 1000)
    assert.equal(timer.unrefed, true)
    store.save({ accountMaxConcurrency: 3, cliVersionAutoRefresh: true })
    assert.equal(calls.length, 1, 'saving unchanged or unrelated settings must not refresh')
    clock.tick()
    await settle()
    assert.equal(calls.length, 2, 'one periodic tick must issue one metadata request')
    hold = true
    clock.tick()
    clock.tick()
    assert.equal(calls.length, 3, 'in-flight registry refreshes must not overlap')
    store.save({ cliVersionAutoRefresh: false })
    assert.equal(clock.intervals.size, 0)
    assert.equal(calls[2].signal.aborted, true, 'disabling must abort the in-flight metadata request')
    pending!(response('99.0.0'))
    await settle()
    assert.equal(getCliVersion(), '9.8.7', 'a cancelled response must not replace the cached version')
    clock.tick()
    assert.equal(calls.length, 3, 'disabled state must not perform background fetches')
    assert.equal(new SettingsStore(file).get().cliVersionAutoRefresh, false, 'false must survive reload')
    store.save({ cliVersionAutoRefresh: true })
    assert.equal(calls.length, 4)
    store.save({ cliVersionAutoRefresh: false })
    store.save({ cliVersionAutoRefresh: true })
    assert.equal(calls.length, 4, 're-enabling must wait for the cancelled request to settle')
    hold = false
    pending!(response('99.0.0'))
    await settle()
    assert.equal(calls.length, 5, 're-enabling during cancellation must schedule exactly one fresh check')
    assert.equal(clock.intervals.size, 1, 'repeated toggles must leave only one timer')
    assert.equal(clock.timeouts.size, 0, 'completed fetches must clear timeout handles')
  } finally { stop() }
  store.save({ cliVersionAutoRefresh: false })
  store.save({ cliVersionAutoRefresh: true })
  clock.tick()
  assert.equal(calls.length, 5, 'stopped lifecycle must unsubscribe from settings and clear timers')
}

/**
 * 检查启用状态重启及响应头到达前的停机取消.
 * @returns {Promise<void>} 断言完成
 */
async function checkRestart(): Promise<void> {
  const clock = fakeClock()
  const calls: any[] = []
  let pending: (value: any) => void = () => {}
  const refresh = (opts: any) => refreshCliVersion({ ...opts, ...clock,
    fetchImpl: async (_url: string, init: any) => {
      calls.push(init)
      return calls.length === 1 ? response('9.8.7') : new Promise((resolve) => { pending = resolve })
    },
  })
  const stopRestart = startCliVersionRefresh(new SettingsStore(file), {}, { ...clock, refresh })
  await settle()
  assert.equal(calls.length, 1, 'enabled startup must perform one metadata check')
  clock.tick()
  assert.equal(calls.length, 2)
  stopRestart()
  assert.equal(calls[1].signal.aborted, true, 'shutdown must abort the in-flight metadata request')
  pending(response('99.0.0'))
  await settle()
  assert.equal(getCliVersion(), '9.8.7', 'shutdown must discard a late metadata response')
  assert.equal(clock.intervals.size, 0)
  assert.equal(clock.timeouts.size, 0)
}

/**
 * 检查失败, 非法响应和超时的缓存保留行为.
 * @returns {Promise<void>} 断言完成
 */
async function checkFailures(): Promise<void> {
  setCliVersion('8.7.6')
  const clock = fakeClock()
  for (const [fetchImpl, fields] of [
    [async () => new Response('', { status: 503 }), { category: 'http', status: 503 }],
    [async () => response('invalid'), { category: 'invalid_version' }],
    [async () => response(null), { category: 'invalid_version' }],
    [async () => { throw new Error('https://fixture.invalid/?secret=hidden') }, { category: 'network' }],
    [async () => ({ ok: true, json: async () => { throw new Error('secret JSON') } }), { category: 'invalid_json' }],
    [async () => new Response('{secret malformed'), { category: 'invalid_json' }],
    [async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('secret body failure')) },
    })), { category: 'network' }],
  ]) {
    warnings.length = 0
    assert.equal(await refreshCliVersion({ ...clock, fetchImpl }), '8.7.6')
    assert.equal(clock.timeouts.size, 0, 'failed requests must clear their timeout')
    assert.deepEqual(warnings, [{ message: 'CLI version metadata refresh failed', fields }])
  }
  let finish: (value: any) => void = () => {}
  let signal: AbortSignal | null = null
  const pending = refreshCliVersion({ ...clock, fetchImpl: async (_url: any, opts: any) => {
    signal = opts.signal
    return new Promise((resolve) => { finish = resolve })
  } })
  const timer = [...clock.timeouts][0]
  assert.equal(timer.ms, 8_000)
  timer.fn()
  assert.equal(signal!.aborted, true)
  finish(response('99.0.0'))
  assert.equal(await pending, '8.7.6', 'late timeout response must not update metadata')
  const ac = new AbortController()
  ac.abort()
  warnings.length = 0
  await refreshCliVersion({ signal: ac.signal, fetchImpl: () => assert.fail('pre-aborted fetch must not run') })
  assert.equal(warnings.length, 0, 'voluntary cancellation must be silent')
}

try {
  assert.equal(DEFAULT_SETTINGS.cliVersionAutoRefresh, false)
  for (const raw of [{}, { cliVersionAutoRefresh: 'true' }, { cliVersionAutoRefresh: 1 }]) {
    assert.equal(applyStoredSettings(DEFAULT_SETTINGS, raw).cliVersionAutoRefresh, false)
  }
  await checkReadback()
  await checkLifecycle()
  await checkRestart()
  assert.equal(warnings.length, 0, 'successful refresh, disable and shutdown must not warn')
  await checkFailures()
  for (const mode of ['timeout', 'disable', 'shutdown'] as const) {
    warnings.length = 0
    await checkBodyCancellation(join(dir, `${mode}.json`), mode)
    const expected = mode === 'timeout'
      ? [{ message: 'CLI version metadata refresh failed', fields: { category: 'timeout' } }] : []
    assert.deepEqual(warnings, expected, `${mode} must only log safe involuntary failure categories`)
  }
  warnings.length = 0
  await checkRapidReenable(join(dir, 'rapid.json'))
  await checkLateResults()
  assert.equal(warnings.length, 0, 'disable and shutdown must stay silent after late completions')
  console.log('PASS cli-version-refresh')
} finally {
  globalThis.fetch = originalFetch
  logger.warn = originalWarn
  setCliVersion(originalVersion)
  rmSync(dir, { recursive: true, force: true })
}
