import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath, URL } from 'node:url'
import { validateCapabilities } from '@synonymdev/pubky'
import { createServer } from 'vite'

let server
let auth
let config

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    envFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    logLevel: 'error',
  })
  auth = await server.ssrLoadModule('/src/pubky.ts')
  config = await server.ssrLoadModule('/src/config.ts')
})

after(async () => {
  await server?.close()
})

test('Ring sign-in requests only the public and private template capabilities', async (t) => {
  const approvedSession = {}
  const sdkFlow = {
    authorizationUrl: 'pubkyauth://signin_grant?test=capabilities',
    awaitApproval: async () => approvedSession,
    free: t.mock.fn(),
  }
  const startGrant = t.mock.method(auth.pubky, 'startGrantAuthFlow', async () => sdkFlow)

  const flow = await auth.startRingAuthFlow()

  assert.equal(startGrant.mock.callCount(), 1)
  const [capabilities, kind, options] = startGrant.mock.calls[0].arguments
  t.after(() => kind.free())
  assert.deepEqual(
    new Set(validateCapabilities(capabilities).split(',')),
    new Set(['/pub/template/:rw', '/priv/template/:rw']),
  )
  assert.equal(kind.intent, 'signin')
  assert.deepEqual(options, { clientId: 'template', relay: config.HTTP_RELAY })
  assert.equal(flow.authorizationUrl, sdkFlow.authorizationUrl)
  assert.equal(await flow.awaitApproval, approvedSession)
})
