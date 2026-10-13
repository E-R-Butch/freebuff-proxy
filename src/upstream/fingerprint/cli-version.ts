/** npm CLI 版本信息缓存与可选刷新. */
import { createEgress } from '../client/egress/index.ts'
import { logger } from '../../util/log.ts'
import { KNOWN_CLI_VERSION } from './ua.ts'
import { H_CLIENT_VERSION } from '../upstream-contract.ts'

/** 当前缓存的 CLI 版本参考值. */
let activeCliVersion = KNOWN_CLI_VERSION

/**
 - 当前缓存的 CLI 版本参考值(同步,无 IO).
 - @returns {string} 版本号(形如 0.0.178)
 */
export function getCliVersion() {
  return activeCliVersion
}

/**
 - 测试/运维用:显式设置版本号(非法值忽略).
 - @param {any} version 待设置的版本号(须形如 x.y.z)
 - @returns {string} 设置后生效的版本号(非法输入时原值不变)
 */
export function setCliVersion(version: any) {
  if (typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version.trim())) {
    activeCliVersion = version.trim()
  }
  return activeCliVersion
}

/** npm 元数据失败的安全分类与 HTTP 状态. */
class MetadataFailure extends Error {
  category: string
  status?: number

  constructor(category: string, status?: number) {
    super('CLI version metadata refresh failed')
    this.category = category
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) this.status = status
  }
}

/**
 * 取消元数据响应体或已持有的 reader, 消化取消错误.
 * @param {any} body 响应体或 reader
 * @returns {void} 取消已发起
 */
function cancelMetadataBody(body: any): void {
  try { void Promise.resolve(body?.cancel()).catch(() => {}) } catch { /* 取消已关闭的响应体 */ }
}

/**
 * 消费元数据字节流并解析 JSON.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader 已持有的响应体 reader
 * @param {AbortSignal} signal 刷新取消信号
 * @returns {Promise<any>} npm 元数据对象
 */
async function readMetadataBody(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<any> {
  const decoder = new TextDecoder()
  let text = ''
  while (true) {
    signal.throwIfAborted()
    const { done, value } = await reader.read()
    signal.throwIfAborted()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  try { return JSON.parse(text + decoder.decode()) } catch { throw new MetadataFailure('invalid_json') }
}

/**
 * 在 fetch 与响应体消费期间保持取消监听, 清理迟到响应.
 * @param {any} fetchImpl 元数据请求实现
 * @param {AbortSignal} signal 刷新取消信号
 * @returns {Promise<any>} npm 元数据对象
 */
async function readCliMetadata(fetchImpl: any, signal: AbortSignal): Promise<any> {
  let response: any
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let rejectAbort: (reason: unknown) => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  void aborted.catch(() => {})
  const onAbort = () => {
    cancelMetadataBody(reader ?? response?.body)
    rejectAbort(signal.reason)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    signal.throwIfAborted()
    const pending = Promise.resolve(fetchImpl('https://registry.npmjs.org/freebuff/latest', {
      signal, headers: { accept: 'application/json' },
    })).then((res) => {
      if (signal.aborted) {
        cancelMetadataBody(res.body)
        signal.throwIfAborted()
      }
      response = res
      return res
    })
    const res = await Promise.race([pending, aborted])
    signal.throwIfAborted()
    if (!res.ok) {
      cancelMetadataBody(res.body)
      throw new MetadataFailure('http', res.status)
    }
    const body: ReadableStream<Uint8Array> | null = res.body ?? null
    if (!body) {
      try { return await Promise.race([res.json(), aborted]) }
      catch { throw new MetadataFailure('invalid_json') }
    }
    reader = body.getReader()
    return await readMetadataBody(reader, signal)
  } finally {
    signal.removeEventListener('abort', onAbort)
    reader?.releaseLock()
  }
}

/**
 * 会话请求的调用方版本头, 取值是官方客户端版本(不是本代理的包版本).
 * 见 .agents/notes/implemented/bug-fix/2026-10-13-caller-version-header.md
 * @returns {Record<string, string>} 调用方版本头
 */
export function callerVersionHeaders(): Record<string, string> {
  return { [H_CLIENT_VERSION]: activeCliVersion }
}

/**
 * 从 npm registry 刷新 CLI 版本信息, 失败或取消时保留缓存.
 * .agents/notes/implemented/feature/2026-10-13-cli-version-refresh.md
 * (supersedes .agents/notes/implemented/feature/2026-10-02-cli-fingerprint-periodic-align.md)
 *
 * @param {any} opts 出口配置, fetchImpl, signal, timeoutMs 与可注入的计时器
 * @returns {Promise<string>} 缓存的版本参考值
 */
export async function refreshCliVersion(opts: any = {}) {
  if (opts.signal?.aborted) return activeCliVersion
  const fetchImpl = opts.fetchImpl || createEgress({ config: opts.config || {} }).fetch
  if (typeof fetchImpl !== 'function') return activeCliVersion
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8_000
  const ac = new AbortController()
  const signal = opts.signal ? AbortSignal.any([ac.signal, opts.signal]) : ac.signal
  const schedule = opts.setTimeoutImpl || setTimeout
  const cancel = opts.clearTimeoutImpl || clearTimeout
  let timedOut = false
  const timer = schedule(() => {
    if (signal.aborted) return
    timedOut = true
    ac.abort()
  }, timeoutMs)
  timer?.unref?.()
  try {
    const body = await readCliMetadata(fetchImpl, signal)
    signal.throwIfAborted()
    const version = body?.version
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version.trim())) {
      throw new MetadataFailure('invalid_version')
    }
    return setCliVersion(version)
  } catch (error) {
    if (timedOut || !signal.aborted) {
      const category = timedOut ? 'timeout' : error instanceof MetadataFailure ? error.category : 'network'
      const status = error instanceof MetadataFailure ? error.status : undefined
      logger.warn('CLI version metadata refresh failed', { category, ...(status === undefined ? {} : { status }) })
    }
    return activeCliVersion
  } finally {
    cancel(timer)
  }
}
