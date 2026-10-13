import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installDomStub } from '../../../../helpers/dom-stub.ts'
import { settingsRequest } from '../../../../helpers/version/settings.ts'
import { SettingsStore } from '../../../../../src/web/store/config/settings-store.ts'

installDomStub()
const { buildCliVersionCard } = await import('../../../../../dashboard/views/proxy/switches/cli-version.ts')
const { t, setLocale } = await import('../../../../../dashboard/locale/index.ts')
const originalFetch = globalThis.fetch
const dir = mkdtempSync(join(tmpdir(), 'dashboard-version-'))
const store = new SettingsStore(join(dir, 'settings.json'))
let rejectSave = false
let readback: boolean | null = null
const calls: any[] = []
globalThis.fetch = async (url: any, opts: any = {}) => {
  assert.equal(url, '/api/settings', 'the switch must only call the existing local settings API')
  calls.push({ url, ...opts })
  let value: boolean | undefined
  if (opts.method === 'POST') {
    if (rejectSave) return new Response(JSON.stringify({ error: 'fixture failure' }), { status: 400 })
    const patch = JSON.parse(opts.body)
    assert.deepEqual(Object.keys(patch), ['cliVersionAutoRefresh'])
    value = patch.cliVersionAutoRefresh
  }
  const result = await settingsRequest(store, opts.method || 'GET', value)
  assert.equal(result.handled, true, 'the real settings handler must serve the dashboard request')
  if (opts.method !== 'POST' && readback !== null) result.body.cliVersionAutoRefresh = readback
  return new Response(JSON.stringify(result.body), { status: result.status })
}

try {
  const card = buildCliVersionCard(false, false)
  const input = card.querySelector('#cli-version-auto-refresh')
  assert.ok(input)
  assert.equal(input.attrs.checked, undefined, 'refresh must render off by default')
  assert.equal(buildCliVersionCard(true, false).querySelector('input').attrs.checked, '')
  assert.equal(buildCliVersionCard(false, true).querySelector('input').attrs.disabled, '',
    'non-admins must see a read-only setting')
  assert.equal(calls.length, 0, 'rendering the setting must not perform a request')

  input.checked = true
  await input.dispatch('change')
  assert.equal(store.get().cliVersionAutoRefresh, true, 'enabling must persist true')
  assert.equal(input.checked, true)
  assert.equal(input.disabled, false)
  assert.equal(card.querySelector('.switch-status').textContent, t('common.on'))
  assert.deepEqual(calls.map((call) => call.method || 'GET'), ['POST', 'GET'], 'save must be followed by readback')
  input.checked = false
  await input.dispatch('change')
  assert.equal(store.get().cliVersionAutoRefresh, false, 'disabling must persist false')
  assert.equal(card.querySelector('.switch-status').textContent, t('common.off'))

  rejectSave = true
  input.checked = true
  await input.dispatch('change')
  assert.equal(input.checked, false, 'failed save must restore the previous state')
  assert.equal(input.disabled, false, 'failed save must leave the control usable')
  rejectSave = false
  readback = false
  input.checked = true
  await input.dispatch('change')
  assert.equal(input.checked, false, 'readback must override the optimistic checkbox value')

  for (const locale of ['zh-CN', 'en']) {
    setLocale(locale)
    assert.notEqual(t('settings.cliVersionRefresh'), 'settings.cliVersionRefresh')
    assert.notEqual(t('settings.cliVersionRefreshHint'), 'settings.cliVersionRefreshHint')
  }
  console.log('PASS dashboard-version')
} finally {
  globalThis.fetch = originalFetch
  rmSync(dir, { recursive: true, force: true })
}
