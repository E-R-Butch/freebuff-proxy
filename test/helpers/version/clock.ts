/**
 * 可手动触发的定时器集合.
 * @returns {any} interval/timeout 注入点和待执行句柄
 */
export function fakeClock() {
  const intervals = new Set<any>()
  const timeouts = new Set<any>()
  const add = (set: Set<any>, fn: () => void, ms: number) => {
    const timer = { fn, ms, unrefed: false, unref() { this.unrefed = true } }
    set.add(timer)
    return timer
  }
  return {
    intervals, timeouts,
    setIntervalImpl: (fn: () => void, ms: number) => add(intervals, fn, ms),
    clearIntervalImpl: (timer: any) => { intervals.delete(timer) },
    setTimeoutImpl: (fn: () => void, ms: number) => add(timeouts, fn, ms),
    clearTimeoutImpl: (timer: any) => { timeouts.delete(timer) },
    tick: () => { for (const timer of [...intervals]) timer.fn() },
  }
}
