import { handle } from '../../../src/web/routes/control/settings.ts'
import type { SettingsStore } from '../../../src/web/store/config/settings-store.ts'

/**
 * 通过实际 handle 和 readSettings 读写临时设置.
 * @param {SettingsStore} store 临时设置存储
 * @param {string} method GET 或 POST
 * @param {any} value 待保存的开关值
 * @returns {Promise<any>} HTTP 状态与回执
 */
export async function settingsRequest(store: SettingsStore, method: string, value?: any): Promise<any> {
  let status = 0
  let body: any = null
  const res: any = {
    writeHead(code: number) { status = code },
    end(text: string) { body = JSON.parse(text) },
  }
  const handled = await handle(method, '/api/settings', {} as any, res, { role: 'admin' }, {
    config: { session: {}, limits: {} }, settingsStore: store,
    readJson: async () => ({ cliVersionAutoRefresh: value }),
  })
  return { handled, status, body }
}
