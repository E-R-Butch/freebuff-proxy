import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { SettingsStore } from '../../../src/web/store/config/settings-store.ts'
import { startCliVersionRefresh } from '../../../bin/serve/boot/version-refresh/index.ts'
import { getCliVersion, refreshCliVersion, setCliVersion } from '../../../src/upstream/fingerprint/cli-version.ts'
import { fakeClock } from './clock.ts'

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * 构造响应头已返回但 JSON 字节未完成的真实响应体.
 * @param {any} state 活跃响应体计数
 * @param {() => any} onCancel 取消回执
 * @returns {any} 响应及手动完成入口
 */
function stalledBody(state: any, onCancel: () => any): any {
  let controller: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      state.active++
      state.maxActive = Math.max(state.maxActive, state.active)
      controller.enqueue(encoder.encode('{"version":"'))
    },
    cancel() { state.active--; state.cancelled++; return onCancel() },
  })
  return {
    response: new Response(stream),
    finish(version: string) {
      controller.enqueue(encoder.encode(`${version}"}`))
      controller.close()
      state.active--
    },
  }
}

/**
 * 构造带真实响应流的离线版本刷新调度夹具.
 * @param {string} file 临时设置文件
 * @param {() => any} onCancel 取消回执
 * @returns {any} 调度器依赖及状态
 */
function bodyHarness(file: string, onCancel: () => any): any {
  const store = new SettingsStore(file)
  store.save({ cliVersionAutoRefresh: true })
  const clock = fakeClock()
  const state = { active: 0, maxActive: 0, cancelled: 0, completed: 0 }
  const bodies: any[] = []
  const signals: AbortSignal[] = []
  const refresh = async (opts: any) => {
    try {
      return await refreshCliVersion({ ...opts, ...clock, fetchImpl: async (_url: string, init: any) => {
        signals.push(init.signal)
        const body = stalledBody(state, onCancel)
        bodies.push(body)
        return body.response
      } })
    } finally { state.completed++ }
  }
  return { store, clock, state, bodies, signals, deps: { ...clock, refresh } }
}

/**
 * 检查响应头之后的超时, 关闭和停机取消及下一次启用.
 * @param {string} file 临时设置文件
 * @param {'timeout' | 'disable' | 'shutdown'} mode 取消方式
 * @returns {Promise<void>} 断言完成
 */
export async function checkBodyCancellation(file: string, mode: 'timeout' | 'disable' | 'shutdown'): Promise<void> {
  setCliVersion('8.7.6')
  const cancel = () => mode === 'timeout' ? new Promise<void>(() => {}) : Promise.reject(new Error('secret cancel'))
  const { store, clock, state, bodies, signals, deps } = bodyHarness(file, cancel)
  let stop = startCliVersionRefresh(store, {}, deps)
  try {
    await settle()
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].response.body.locked, true, 'stalled JSON must own an active reader')
    assert.equal(getEventListeners(signals[0], 'abort').length, 1, 'body consumption must retain abort listener')
    clock.tick()
    clock.tick()
    assert.equal(bodies.length, 1, 'periodic ticks must not overlap a stalled body')
    const timer: any = [...clock.timeouts][0]
    assert.equal(timer.ms, 8_000, 'deadline must include body consumption')
    assert.equal(timer.unrefed, true)
    if (mode === 'timeout') timer.fn()
    else if (mode === 'disable') store.save({ cliVersionAutoRefresh: false })
    else stop()
    await settle()
    assert.equal(signals[0].aborted, true)
    assert.equal(state.completed, 1, `${mode} must promptly release the refresh even if cancel stalls or rejects`)
    assert.equal(state.cancelled, 1, `${mode} must cancel the body through its owning reader`)
    assert.equal(state.active, 0, 'no detached body reader may remain active')
    assert.equal(bodies[0].response.body.locked, false, 'cancelled reader must release its lock')
    assert.equal(getEventListeners(signals[0], 'abort').length, 0, 'cancelled listener must be removed')
    assert.equal(clock.timeouts.size, 0)
    assert.throws(() => bodies[0].finish('99.0.0'), TypeError, 'cancelled stream must reject late bytes')
    assert.equal(getCliVersion(), '8.7.6', 'cancellation must preserve cache')
    store.save({ cliVersionAutoRefresh: false })
    store.save({ cliVersionAutoRefresh: true })
    if (mode === 'shutdown') {
      assert.equal(bodies.length, 1, 'stopped scheduler must stay unsubscribed')
      stop = startCliVersionRefresh(store, {}, deps)
    }
    await settle()
    clock.tick()
    assert.equal(bodies.length, 2, 're-enable must perform exactly one fresh request')
    assert.equal(state.maxActive, 1, 'old and fresh response bodies must never overlap')
    assert.equal(getCliVersion(), '8.7.6', 'unfinished fresh body must not change cache')
    bodies[1].finish('9.8.6')
    await settle()
    assert.equal(getCliVersion(), '9.8.6', 'only the completed fresh request may update cache')
    assert.equal(state.completed, 2)
    assert.equal(state.active, 0)
    assert.equal(bodies[1].response.body.locked, false)
    assert.equal(getEventListeners(signals[1], 'abort').length, 0, 'success must remove its listener')
    assert.equal(clock.timeouts.size, 0)
    assert.equal(clock.intervals.size, 1)
  } finally { stop() }
  assert.equal(clock.intervals.size, 0)
}

/**
 * 检查取消尚未结算时的重复启用只启动一个新响应体.
 * @param {string} file 临时设置文件
 * @returns {Promise<void>} 断言完成
 */
export async function checkRapidReenable(file: string): Promise<void> {
  setCliVersion('8.7.6')
  const { store, state, bodies, deps } = bodyHarness(file, () => Promise.resolve())
  const stop = startCliVersionRefresh(store, {}, deps)
  try {
    await settle()
    store.save({ cliVersionAutoRefresh: false })
    store.save({ cliVersionAutoRefresh: true })
    store.save({ cliVersionAutoRefresh: false })
    store.save({ cliVersionAutoRefresh: true })
    assert.equal(bodies.length, 1, 'cancelling refresh must settle before a new request')
    await settle()
    assert.equal(bodies.length, 2, 'repeated enable during cancellation must schedule one fresh request')
    assert.equal(state.completed, 1)
    assert.equal(state.cancelled, 1)
    assert.equal(state.maxActive, 1)
    assert.equal(bodies[0].response.body.locked, false)
    assert.equal(getCliVersion(), '8.7.6')
    bodies[1].finish('9.8.6')
    await settle()
    assert.equal(getCliVersion(), '9.8.6')
  } finally { stop() }
}

/**
 * 检查迟到响应头和仅提供 json 方法的注入实现.
 * @returns {Promise<void>} 断言完成
 */
export async function checkLateResults(): Promise<void> {
  for (const phase of ['headers', 'json', 'json-reject']) {
    setCliVersion('8.7.6')
    const clock = fakeClock()
    const ac = new AbortController()
    let resolve: (value: any) => void = () => {}
    let reject: (error: any) => void = () => {}
    const late = new Promise((yes, no) => { resolve = yes; reject = no })
    let completed = false
    const run = refreshCliVersion({ ...clock, signal: ac.signal,
      fetchImpl: async () => phase === 'headers' ? late : { ok: true, json: () => late },
    }).then((value) => { completed = true; return value })
    await settle()
    ac.abort()
    await settle()
    assert.equal(completed, true, `${phase} cancellation must not wait for an ignored signal`)
    assert.equal(await run, '8.7.6')
    const state = { active: 0, maxActive: 0, cancelled: 0 }
    if (phase === 'headers') resolve(stalledBody(state, () => Promise.reject(new Error('secret late'))).response)
    else if (phase === 'json') resolve({ version: '99.0.0' })
    else reject(new Error('secret late JSON'))
    await settle()
    assert.equal(state.active, 0, 'late headers must not leave an active response body')
    assert.equal(state.cancelled, phase === 'headers' ? 1 : 0)
    assert.equal(getCliVersion(), '8.7.6', 'late responses must not replace cache')
    assert.equal(clock.timeouts.size, 0)
  }
}
