import { t } from '../../../locale/index.ts'
import { el } from '../../../lib/dom.ts'
import { api } from '../../../lib/api.ts'
import { toast } from '../../../lib/ui.ts'

/**
 * 保存 CLI 版本信息自动检查开关并回读状态.
 * @param {any} event 复选框 change 事件
 * @returns {Promise<void>} 保存完成
 */
async function saveCliVersionSetting(event: any): Promise<void> {
  const input = event.currentTarget
  const enabled = input.checked
  input.disabled = true
  try {
    const saved = await api('/api/settings', {
      method: 'POST', body: JSON.stringify({ cliVersionAutoRefresh: enabled }),
    })
    input.checked = saved.cliVersionAutoRefresh === true
    try {
      input.checked = (await api('/api/settings')).cliVersionAutoRefresh === true
    } catch { /* 使用保存回执 */ }
    toast(t('toast.saved'))
  } catch (err) {
    input.checked = !enabled
    toast(err.message, true)
  } finally {
    input.disabled = false
    const label = input.closest('.switch')?.querySelector('.switch-status')
    if (label) label.textContent = input.checked ? t('common.on') : t('common.off')
  }
}

/**
 * CLI 版本信息自动检查卡片.
 * @param {boolean} enabled 当前开关
 * @param {boolean} disabled 是否只读
 * @returns {any} 卡片元素
 */
export function buildCliVersionCard(enabled: boolean, disabled: boolean) {
  const attrs: Record<string, any> = {
    id: 'cli-version-auto-refresh', type: 'checkbox', class: 'switch-input', onchange: saveCliVersionSetting,
  }
  if (enabled) attrs.checked = ''
  if (disabled) attrs.disabled = ''
  return el('div', { class: 'card settings-band', style: 'margin-top:12px' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('settings.cliVersionRefresh')),
      el('span', { class: 'muted' }, t('settings.cliVersionRefreshHint')),
    ]),
    el('label', { class: 'switch', for: attrs.id }, [
      el('input', attrs),
      el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
      el('span', { class: 'switch-status' }, enabled ? t('common.on') : t('common.off')),
    ]),
  ])
}
