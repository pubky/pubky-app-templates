import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath, URL } from 'node:url'
import { createServer } from 'vite'

let server
let account
let ui

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    envFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    logLevel: 'error',
  })
  account = await server.ssrLoadModule('/src/account.ts')
  ui = await server.ssrLoadModule('/src/account-ui.ts')
})

after(async () => {
  await server?.close()
})

function fixture(capabilities = ['/:r']) {
  const calls = { load: 0, accountFree: 0, grantFree: 0 }
  const info = {
    usedBytes: 4096,
    createdAt: '2026-11-01T12:34:56.000000',
    disabled: true,
    quota: {
      effective: { storageQuotaMb: 'unlimited', rateRead: '100mb/m', allowedWritePaths: [] },
      overrides: { storageQuotaMb: 'unlimited' },
    },
    free() {
      calls.accountFree++
    },
  }
  const grant = {
    async account() {
      calls.load++
      return info
    },
    free() {
      calls.grantFree++
    },
  }
  return { session: { info: { capabilities }, grant }, info, grant, calls }
}

test('account snapshots preserve unlimited quotas and free the owned SDK objects', async () => {
  const { session, info, calls } = fixture()
  const result = await account.getAccountInfo(session)
  assert.deepEqual(result, {
    usedBytes: 4096,
    createdAt: info.createdAt,
    disabled: true,
    quota: info.quota,
  })
  info.quota.effective.allowedWritePaths.push('/changed/')
  assert.deepEqual(result.quota.effective.allowedWritePaths, [])
  assert.deepEqual(calls, { load: 1, accountFree: 1, grantFree: 1 })
})

for (const capabilities of [['/pub/template/:rw', '/priv/template/:rw'], ['/:w'], []]) {
  test(`account inspection rejects scoped or missing read permissions: ${capabilities}`, async () => {
    const { session, calls } = fixture(capabilities)
    await assert.rejects(account.getAccountInfo(session), /requires read access to \//)
    assert.deepEqual(calls, { load: 0, accountFree: 0, grantFree: 0 })
    const html = ui.accountPanelHtml(session)
    assert.match(html, /id="authorize-account-permissions"/)
    assert.doesNotMatch(html, /id="load-account"/)
    assert.match(html, /every public and private folder/)
  })
}

test('root read/write grants can inspect accounts, while signer-only sessions cannot', async () => {
  const { session } = fixture(['/:rw'])
  await account.getAccountInfo(session)
  assert.match(ui.accountPanelHtml(session), /id="load-account"/)
  await assert.rejects(
    account.getAccountInfo({ info: { capabilities: ['/:rw'] } }),
    /requires a grant session/,
  )
})

test('account request failures preserve the SDK error and free the grant', async () => {
  const { session, grant, calls } = fixture()
  const error = Object.assign(new Error('Root read refused'), {
    name: 'RequestError',
    data: { reason: 'Http', statusCode: 403 },
  })
  grant.account = async () => {
    throw error
  }
  await assert.rejects(account.getAccountInfo(session), (received) => received === error)
  assert.deepEqual(calls, { load: 0, accountFree: 0, grantFree: 1 })
})

function panel() {
  const button = new globalThis.EventTarget()
  button.disabled = false
  const status = { textContent: '', classList: { toggle() {} } }
  const result = { textContent: '' }
  const elements = { '#load-account': button, '#account-status': status, '#account-result': result }
  return {
    button,
    status,
    result,
    root: { isConnected: true, querySelector: (selector) => elements[selector] ?? null },
  }
}

const flush = () => new Promise((resolve) => globalThis.setTimeout(resolve, 0))

test('account panel loads only on demand, uses text, and clears results on disposal', async () => {
  const { session, info, calls } = fixture()
  info.createdAt = '<script>untrusted</script>'
  const { root, button, status, result } = panel()
  const tools = ui.createAccountTools(root, session)
  assert.equal(calls.load, 0)
  button.dispatchEvent(new globalThis.Event('click'))
  assert.equal(button.disabled, true)
  await flush()
  assert.equal(calls.load, 1)
  assert.match(result.textContent, /Storage used: 4,096 bytes/)
  assert.match(result.textContent, /<script>untrusted<\/script>/)
  assert.match(result.textContent, /"storageQuotaMb": "unlimited"/)
  assert.equal(status.textContent, 'Account information loaded.')
  assert.equal(button.disabled, false)
  tools.dispose()
  assert.equal(result.textContent, '')
  assert.equal(status.textContent, '')
  button.dispatchEvent(new globalThis.Event('click'))
  await flush()
  assert.equal(calls.load, 1)
})

test('late account results are freed without updating a replaced panel', async () => {
  const { session, grant, info, calls } = fixture()
  let resolve
  grant.account = () => new Promise((done) => (resolve = done))
  const { root, button, status, result } = panel()
  const tools = ui.createAccountTools(root, session)
  button.dispatchEvent(new globalThis.Event('click'))
  button.dispatchEvent(new globalThis.Event('click'))
  tools.dispose()
  resolve(info)
  await flush()
  assert.equal(result.textContent, '')
  assert.equal(status.textContent, '')
  assert.equal(calls.accountFree, 1)
  assert.equal(calls.grantFree, 1)
})
