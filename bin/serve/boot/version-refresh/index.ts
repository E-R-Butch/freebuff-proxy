import { getCliVersion, refreshCliVersion } from '../../../../src/upstream/fingerprint/cli-version.ts'
import { logger } from '../../../../src/util/log.ts'

/** 版本信息刷新调度器的可注入依赖. */
interface RefreshDeps {
  refresh?: typeof refreshCliVersion
  setIntervalImpl?: typeof setInterval
  clearIntervalImpl?: typeof clearInterval
  onRefresh?: () => void
}

/**
 * 按实时设置启动或停止 npm 版本信息刷新.
 * docs/design/cli-version-refresh.md
 * @param {any} settingsStore 可订阅的运行设置
 * @param {any} config 出口配置
 * @param {RefreshDeps} deps 刷新函数, 定时器与完成回调
 * @returns {() => void} 停止刷新并取消订阅
 */
export function startCliVersionRefresh(settingsStore: any, config: any, deps: RefreshDeps = {}): () => void {
  const refresh = deps.refresh ?? refreshCliVersion
  const schedule = deps.setIntervalImpl ?? setInterval
  const cancel = deps.clearIntervalImpl ?? clearInterval
  let timer: ReturnType<typeof setInterval> | null = null
  let active: AbortController | null = null
  let enabled = false
  let stopped = false

  const run = async () => {
    if (!enabled || stopped || active) return
    const controller = new AbortController()
    active = controller
    try {
      const before = getCliVersion()
      const next = await refresh({ config, signal: controller.signal })
      if (!controller.signal.aborted && enabled && !stopped) {
        if (next !== before) logger.info('CLI version metadata refreshed', { from: before, to: next })
        deps.onRefresh?.()
      }
    } catch { /* 保留版本信息缓存 */ }
    finally {
      active = null
      if (controller.signal.aborted && enabled && !stopped) void run()
    }
  }
  const sync = () => {
    const next = settingsStore?.get?.()?.cliVersionAutoRefresh === true
    if (stopped || next === enabled) return
    enabled = next
    if (timer !== null) cancel(timer)
    timer = null
    if (!enabled) {
      active?.abort()
      return
    }
    void run()
    timer = schedule(() => { void run() }, 6 * 60 * 60 * 1000)
    timer.unref?.()
  }
  const unsubscribe = settingsStore?.subscribe?.(sync)
  sync()
  return () => {
    stopped = true
    unsubscribe?.()
    if (timer !== null) cancel(timer)
    timer = null
    active?.abort()
  }
}
