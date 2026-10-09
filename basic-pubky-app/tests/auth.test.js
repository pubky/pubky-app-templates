import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { fileURLToPath, URL } from 'node:url'
import { BrowserSessionStore, validateCapabilities } from '@synonymdev/pubky'
import { createServer } from 'vite'

let server
let auth
let config
const memoryStorage = () => {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    entries: () => [...values.entries()],
  }
}
const local = memoryStorage()
const pending = memoryStorage()
const events = new globalThis.EventTarget()
Object.assign(globalThis, { localStorage: local, sessionStorage: pending, window: events })

beforeEach((t) => {
  local.clear()
  pending.clear()
  t.mock.method(BrowserSessionStore.prototype, 'isAvailable', async () => true)
})

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeFlow(t, approval = Promise.resolve({})) {
  return {
    authorizationUrl: 'pubkyauth://signin_grant?test=capabilities',
    saveDelegated: () => 'opaque-test-state',
    awaitApproval: () => approval,
    free: t.mock.fn(),
  }
}

function sdkError(name, message = name) {
  return Object.assign(new Error(message), { name })
}

function record(id = 'account:grant', overrides = {}) {
  return {
    id,
    clientId: 'template',
    publicKey: 'test-public-key',
    homeserver: 'test-homeserver',
    storageMode: 'delegated',
    grantExpiresAt: 12345,
    free() {},
    ...overrides,
  }
}

function emitSdk(detail) {
  const event = new globalThis.Event('pubky-session-changed')
  Object.assign(event, { detail })
  events.dispatchEvent(event)
}

function emitStorage(key, storageArea = local) {
  const event = new globalThis.Event('storage')
  Object.assign(event, { key, storageArea })
  events.dispatchEvent(event)
}

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
    saveDelegated: () => 'opaque-test-state',
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

test('pending delegated sign-in survives reload, resumes, and is removed after approval', async (t) => {
  const firstApproval = deferred()
  const first = fakeFlow(t, firstApproval.promise)
  const start = t.mock.method(auth.pubky, 'startGrantAuthFlow', async () => first)
  const flow = await auth.startRingAuthFlow()
  assert.equal(pending.entries().length, 1)
  assert.equal(local.entries().length, 0)
  flow.suspend()
  await assert.rejects(flow.awaitApproval, { name: 'RingAuthCanceled' })
  assert.equal(pending.entries().length, 1)
  const approvedSession = {}
  const resume = t.mock.method(auth.pubky, 'resumeDelegatedGrantAuthFlow', async (saved) => {
    assert.equal(saved, 'opaque-test-state')
    return fakeFlow(t, Promise.resolve(approvedSession))
  })
  const resumed = await auth.startRingAuthFlow()
  assert.equal(await resumed.awaitApproval, approvedSession)
  assert.equal(resume.mock.callCount(), 1)
  assert.equal(start.mock.callCount(), 1)
  assert.equal(pending.entries().length, 0)
  firstApproval.resolve({})
})

test('explicit cancellation rejects immediately and abandons the pending link', async (t) => {
  const approval = deferred()
  const sdkFlow = fakeFlow(t, approval.promise)
  t.mock.method(auth.pubky, 'startGrantAuthFlow', async () => sdkFlow)
  const flow = await auth.startRingAuthFlow()
  flow.cancel()
  flow.cancel()
  await assert.rejects(flow.awaitApproval, { name: 'RingAuthCanceled' })
  assert.equal(sdkFlow.free.mock.callCount(), 1)
  assert.equal(pending.entries().length, 0)
  approval.resolve({})
})

test('failed approval keeps resumable state; an expired flow removes it', async (t) => {
  const approval = deferred()
  t.mock.method(auth.pubky, 'startGrantAuthFlow', async () => fakeFlow(t, approval.promise))
  const flow = await auth.startRingAuthFlow()
  approval.reject(new Error('Temporary relay failure'))
  await assert.rejects(flow.awaitApproval, /Temporary relay failure/)
  assert.equal(pending.entries().length, 1)
  const expired = deferred()
  t.mock.method(auth.pubky, 'resumeDelegatedGrantAuthFlow', async () =>
    fakeFlow(t, expired.promise),
  )
  const resumed = await auth.startRingAuthFlow()
  expired.reject(
    sdkError('AuthenticationError', 'The provided auth request has expired or was cancelled.'),
  )
  await assert.rejects(resumed.awaitApproval, { name: 'RingAuthExpired' })
  assert.equal(pending.entries().length, 0)
})

test('a relay gateway timeout retains pending state for approval retry and resume', async (t) => {
  const approval = deferred()
  t.mock.method(auth.pubky, 'startGrantAuthFlow', async () => fakeFlow(t, approval.promise))
  const first = await auth.startRingAuthFlow()
  const saved = pending.entries()
  const timeout = Object.assign(sdkError('RequestError', 'Gateway Timeout'), {
    data: { statusCode: 504 },
  })
  approval.reject(timeout)
  await assert.rejects(first.awaitApproval, (error) => error === timeout)
  assert.deepEqual(pending.entries(), saved)

  t.mock.method(auth.pubky, 'resumeDelegatedGrantAuthFlow', async () => {
    throw timeout
  })
  await assert.rejects(auth.startRingAuthFlow(), (error) => error === timeout)
  assert.deepEqual(pending.entries(), saved)

  const approvedSession = {}
  t.mock.method(auth.pubky, 'resumeDelegatedGrantAuthFlow', async () =>
    fakeFlow(t, Promise.resolve(approvedSession)),
  )
  assert.equal(await (await auth.startRingAuthFlow()).awaitApproval, approvedSession)
  assert.equal(pending.entries().length, 0)
})

test('local fallback uses tab-scoped saveLocal and resumeGrantAuthFlow', async (t) => {
  const sdkFlow = fakeFlow(t, deferred().promise)
  sdkFlow.saveDelegated = () => {
    throw sdkError('ClientStateError', 'This grant auth flow is not delegated.')
  }
  sdkFlow.saveLocal = () => 'opaque-local-test-state'
  t.mock.method(auth.pubky, 'startGrantAuthFlow', async () => sdkFlow)
  const first = await auth.startRingAuthFlow()
  first.suspend()
  await assert.rejects(first.awaitApproval)
  t.mock.method(auth.pubky, 'resumeGrantAuthFlow', (saved) => {
    assert.equal(saved, 'opaque-local-test-state')
    return fakeFlow(t)
  })
  assert.ok(await (await auth.startRingAuthFlow()).awaitApproval)
  assert.equal(pending.entries().length, 0)
})

test('unsupported persistence prevents starting auth and retains existing saved state', async (t) => {
  const start = t.mock.method(auth.pubky, 'startGrantAuthFlow', async () => fakeFlow(t))
  t.mock.method(BrowserSessionStore.prototype, 'isAvailable', async () => false)
  await assert.rejects(auth.startRingAuthFlow(), /secure browser context/)
  assert.equal(start.mock.callCount(), 0)
})

test('old browser sessions restore through SDK coordination and are remembered as app accounts', async (t) => {
  local.setItem('template:session', 'old:grant')
  const session = {}
  const restore = t.mock.method(BrowserSessionStore.prototype, 'restore', async () => session)
  assert.equal(await auth.restoreSavedSession(), session)
  assert.equal(restore.mock.calls[0].arguments[0], 'old:grant')
  assert.equal(auth.getSavedSessionId(), 'old:grant')
  assert.deepEqual(JSON.parse(local.getItem('template:session:accounts')), ['old:grant'])
})

for (const failure of [
  sdkError('ClientStateError', 'Browser sessions require Web Locks in a secure context.'),
  sdkError('ClientStateError', 'Reading Pubky session failed.'),
  sdkError('ClientStateError', 'Unsupported stored session version.'),
  sdkError(
    'AuthenticationError',
    'General authentication error: Browser sessions require Web Locks in a secure context.',
  ),
  sdkError('AuthenticationError', 'General authentication error: Reading Pubky session failed.'),
  sdkError('AuthenticationError', 'Unknown authentication failure'),
  sdkError('NetworkError', 'Offline'),
]) {
  test(`restore preserves saved credentials after transient/unsupported error: ${failure.message}`, async (t) => {
    local.setItem('template:session', 'saved:grant')
    const accounts = JSON.stringify(['saved:grant', 'other:grant'])
    local.setItem('template:session:accounts', accounts)
    t.mock.method(BrowserSessionStore.prototype, 'restore', async () => {
      throw failure
    })
    const remove = t.mock.method(BrowserSessionStore.prototype, 'remove', async () => {})
    await assert.rejects(auth.restoreSavedSession(), (error) => error === failure)
    assert.equal(auth.getSavedSessionId(), 'saved:grant')
    assert.equal(local.getItem('template:session:accounts'), accounts)
    assert.equal(remove.mock.callCount(), 0)
  })
}

for (const failure of [
  sdkError('ClientStateError', 'Browser session is no longer valid.'),
  sdkError('ClientStateError', 'Stored Pubky session not found: saved:grant'),
  sdkError('ClientStateError', 'Browser session was signed out.'),
]) {
  test(`restore forgets conclusively invalid sessions: ${failure.message}`, async (t) => {
    local.setItem('template:session', 'saved:grant')
    t.mock.method(BrowserSessionStore.prototype, 'restore', async () => {
      throw failure
    })
    const remove = t.mock.method(BrowserSessionStore.prototype, 'remove', async () => {})
    assert.equal(await auth.restoreSavedSession(), undefined)
    assert.equal(auth.getSavedSessionId(), null)
    assert.equal(remove.mock.callCount(), 1)
  })
}

test('failed remote signout preserves pending logout credentials until retry succeeds', async (t) => {
  let fail = true
  const session = {
    signout: async () => {
      if (fail) throw new Error('Offline')
    },
  }
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => record())
  const remove = t.mock.method(BrowserSessionStore.prototype, 'remove', async () => {})
  await auth.saveSession(session)
  await assert.rejects(auth.signOut(session), /Offline/)
  assert.equal(auth.getSavedSessionId(), 'account:grant')
  assert.equal(remove.mock.callCount(), 0)
  fail = false
  await auth.signOut(session)
  assert.equal(auth.getSavedSessionId(), null)
  assert.equal(remove.mock.callCount(), 0)
})

test('account listing and selection exclude records belonging to other namespace or client', async (t) => {
  local.setItem('template:session', 'own:grant')
  local.setItem('other:template:session', 'other:grant')
  local.setItem('template:session:accounts', JSON.stringify(['own:grant', 'alien-client:grant']))
  t.mock.method(BrowserSessionStore.prototype, 'list', async () => [
    record('own:grant'),
    record('other:grant'),
    record('alien-client:grant', { clientId: 'different-app' }),
  ])
  assert.deepEqual(
    (await auth.listSavedAccounts()).map((account) => account.id),
    ['own:grant'],
  )
  await assert.rejects(auth.selectSavedAccount('other:grant'), /not saved by this app/)
  const session = {}
  t.mock.method(BrowserSessionStore.prototype, 'restore', async () => session)
  assert.equal(await auth.selectSavedAccount('own:grant'), session)
})

test('SDK invalidation drops only the removed active account; notifications detach cleanly', () => {
  local.setItem('template:session', 'active:grant')
  local.setItem('template:session:accounts', JSON.stringify(['active:grant', 'other:grant']))
  const changes = []
  const unsubscribe = auth.subscribeSavedSessionChanges((change) => changes.push(change.type))
  emitSdk({ id: 'unrelated:grant', action: 'removed' })
  assert.deepEqual(changes, [])
  emitSdk({ id: 'other:grant', action: 'removed' })
  assert.equal(auth.getSavedSessionId(), 'active:grant')
  emitSdk({ id: 'active:grant', action: 'removed' })
  assert.equal(auth.getSavedSessionId(), null)
  assert.deepEqual(changes, ['accounts', 'invalidated'])
  unsubscribe()
  emitSdk({ id: null, action: 'cleared' })
  assert.deepEqual(changes, ['accounts', 'invalidated'])
})

test('origin-wide clear invalidates the active handle; namespace pointer changes synchronize UI', () => {
  local.setItem('template:session', 'active:grant')
  const changes = []
  const unsubscribe = auth.subscribeSavedSessionChanges((change) => changes.push(change.type))
  emitStorage('unrelated:session')
  emitStorage('template:session', pending)
  assert.deepEqual(changes, [])
  emitStorage('template:session')
  emitSdk({ id: null, action: 'cleared' })
  assert.deepEqual(changes, ['selected', 'invalidated'])
  assert.equal(auth.getSavedSessionId(), null)
  unsubscribe()
})

test('an account operation completed after invalidation cannot replace the active pointer', async (t) => {
  local.setItem('template:session', 'other:grant')
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => record('late:grant'))
  await auth.saveSession({}, () => false)
  assert.equal(auth.getSavedSessionId(), 'other:grant')
  t.mock.method(BrowserSessionStore.prototype, 'list', async () => [record('late:grant')])
  t.mock.method(BrowserSessionStore.prototype, 'restore', async () => ({}))
  assert.ok(await auth.selectSavedAccount('late:grant', () => false))
  assert.equal(auth.getSavedSessionId(), 'other:grant')
})

test('development identity creation is rejected before any SDK call when disabled', async (t) => {
  const disabledServer = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    envFile: false,
    define: { 'import.meta.env.VITE_SHOW_DEVELOPMENT_SIGNUP': JSON.stringify('false') },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    logLevel: 'error',
  })
  try {
    const disabledAuth = await disabledServer.ssrLoadModule('/src/pubky.ts')
    const signer = t.mock.method(disabledAuth.pubky, 'signer', () => {
      throw new Error('Must not call SDK')
    })
    await assert.rejects(
      disabledAuth.signupDevelopmentUser('not-a-real-key'),
      /only in development on testnet/,
    )
    assert.equal(signer.mock.callCount(), 0)
  } finally {
    await disabledServer.close()
  }
})
