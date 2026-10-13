/**
 * 上游相关的启动工作与版本信息调度接线.
 */
import { startCliVersionRefresh } from './version-refresh/index.ts'
import { reportCliLaunch } from '../../../src/upstream/telemetry/cli-telemetry.ts'
import { logger } from '../../../src/util/log.ts'

/**
 * 启动可实时切换的 CLI 版本信息刷新与可选启动遥测.
 * @param {any} settingsStore 控制台设置
 * @param {any} config 出口配置
 * @returns {() => void} 停止刷新
 */
function warmCliVersion(settingsStore: any, config: any): () => void {
  let launchPending = settingsStore?.get?.()?.cliVersionAutoRefresh === true
  return startCliVersionRefresh(settingsStore, config, {
    onRefresh: () => {
      if (!launchPending) return
      launchPending = false
      if (settingsStore?.get?.()?.cliTelemetryEnabled === true) {
        void reportCliLaunch({ fingerprintSuccess: true, config })
          .then((n) => {
            if (n > 0) logger.debug('cli telemetry reported', { records: n })
          })
          .catch(() => {})
      }
    },
  })
}

/**
 * 会话句柄扫尾:把上次进程遗留的句柄 DELETE 掉(进程退出后 instanceId 就没了,
 * 不扫就是"无法寻址的计费孤儿",一直占着上游槽位;见
 * docs/design/account-scheduling-and-refund.md §3).
 * @param {any} ctx 应用上下文
 * @returns {void} 只登记异步任务, 不等待
 */
function sweepOrphanSessions(ctx: any): void {
  void ctx.runtimes
    .cleanupOrphanSessions({ budgetMs: 15_000 })
    .then((sweep: any) => {
      if (sweep.cleaned || sweep.failed || sweep.skipped || sweep.deferred) {
        logger.info('leftover session sweep on startup', sweep)
      }
    })
    .catch((err: any) => {
      logger.warn('leftover session sweep failed (continuing)', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
}

/**
 * 退款追问:待结算的挂起退款必须持续追,不能只等下次重启.
 *
 * 上游要求用同一个 instanceId 重放 DELETE 才给终态回执,且结算窗口可能跨
 * 分钟级;只扫一次 = 进程活着就永远问不到那笔钱(见 docs/design/account-scheduling-and-refund.md §3).
 * 低频(5 分钟),有界(30s 预算),unref(不挡进程退出).
 * @param {any} ctx 应用上下文
 * @returns {void} 只登记定时器, 不等待
 */
function armRefundSweeper(ctx: any): void {
  const refundSweeper = setInterval(() => {
    void ctx.runtimes
      .sweepPendingRefunds({ budgetMs: 30_000 })
      .catch((err: any) => {
        logger.warn('pending refund sweep failed (continuing)', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }, 5 * 60_000)
  if (refundSweeper.unref) refundSweeper.unref()
}

/**
 * 账号就绪日志(启动路径不发任何上游请求).
 *
 * @param {any} ctx 应用上下文
 * @returns {void} 只写日志, 无返回值
 */
function logUpstreamAuthReady(ctx: any): void {
  if (ctx.authEmail) {
    logger.info('upstream auth ready (no upstream request on startup)', {
      account: ctx.authEmail,
      accounts: ctx.runtimes.list().map((a: any) => a.email),
    })
  } else {
    logger.info('no Freebuff accounts yet — add one from the web console', {
      credentialsDir: ctx.runtimes.dir,
    })
  }
}

/**
 * 上游相关的启动工作(一律不 await).
 *
 *
 * @param {any} ctx 应用上下文(含 runtimes)
 * @param {any} settingsStore 控制台设置(cliVersionAutoRefresh / cliTelemetryEnabled)
 * @returns {void} 只登记异步任务,不等待
 */
export function startUpstreamWarmup({ ctx, settingsStore }: any) {
  ctx.stopCliVersionRefresh = warmCliVersion(settingsStore, ctx?.config)
  sweepOrphanSessions(ctx)
  armRefundSweeper(ctx)
  logUpstreamAuthReady(ctx)
}
