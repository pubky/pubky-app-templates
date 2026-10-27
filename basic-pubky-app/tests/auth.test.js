import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { setImmediate } from 'node:timers'
import { fileURLToPath, URL } from 'node:url'
import { BrowserSessionStore, validateCapabilities } from '@synonymdev/pubky'
import { createServer } from 'vite'

let server
let auth
let config
let lifecycle
const memoryStorage = () => {
  const values = new Map()
  return {
    get length() {
      return values.size
    },
    key: (index) => [...values.keys()][index] ?? null,
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
const selectionLocks = new Map()
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    locks: {
      request(name, task) {
        const result = (selectionLocks.get(name) ?? Promise.resolve()).then(task)
        selectionLocks.set(
          name,
          result.catch(() => {}),
        )
        return result
      },
    },
  },
})

beforeEach((t) => {
  local.clear()
  pending.clear()
  selectionLocks.clear()
  t.mock.method(BrowserSessionStore.prototype, 'isAvailable', async () => true)
  t.mock.method(BrowserSessionStore.prototype, 'restore', async () => ({ free() {} }))
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

function record(id = 'account:grant') {
  return { id, free() {} }
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
  lifecycle = await server.ssrLoadModule('/src/ring-auth-lifecycle.ts')
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
    new Set([
      '/pub/template/:rw',
      '/priv/template/:rw',
      '/pub/template/attachments/:e',
      '/priv/template/attachments/:e',
    ]),
  )
  assert.equal(kind.intent, 'signin')
  assert.deepEqual(options, {
    clientId: 'template',
    relay: config.HTTP_RELAY,
    approvalFormat: 'signedApprovalV1',
  })
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

test('a superseded startup finishing last preserves the current pending link', async (t) => {
  const olderStart = deferred()
  const olderStarted = deferred()
  const older = fakeFlow(t, deferred().promise)
  older.saveDelegated = t.mock.fn(() => 'older-state')
  older.awaitApproval = t.mock.fn()
  const current = fakeFlow(t, deferred().promise)
  current.saveDelegated = () => 'current-state'
  let currentToken = 'older'
  let starts = 0
  t.mock.method(auth.pubky, 'startGrantAuthFlow', () => {
    if (++starts === 1) {
      olderStarted.resolve()
      return olderStart.promise
    }
    return Promise.resolve(current)
  })
  const olderResult = auth.startRingAuthFlow({}, () => currentToken === 'older')
  await olderStarted.promise
  currentToken = 'current'
  const currentFlow = await auth.startRingAuthFlow({}, () => currentToken === 'current')
  const saved = pending.entries()
  assert.equal(JSON.parse(saved[0][1]).state, 'current-state')

  const canceled = assert.rejects(olderResult, { name: 'RingAuthCanceled' })
  olderStart.resolve(older)
  await canceled
  assert.deepEqual(pending.entries(), saved)
  assert.equal(older.saveDelegated.mock.callCount(), 0)
  assert.equal(older.awaitApproval.mock.callCount(), 0)
  assert.equal(older.free.mock.callCount(), 1)
  assert.equal(current.free.mock.callCount(), 0)
  currentFlow.suspend()
})

for (const expired of [false, true]) {
  test(`a superseded resume ${expired ? 'failure' : 'success'} preserves the current waiter and saved link`, async (t) => {
    pending.setItem(
      'template:session:pending-auth',
      JSON.stringify({ mode: 'delegated', state: 'shared-state' }),
    )
    const olderResume = deferred()
    const olderResuming = deferred()
    const older = fakeFlow(t, deferred().promise)
    older.awaitApproval = t.mock.fn()
    const current = fakeFlow(t, deferred().promise)
    let currentToken = 'older'
    let resumes = 0
    const start = t.mock.method(auth.pubky, 'startGrantAuthFlow', async () => fakeFlow(t))
    t.mock.method(auth.pubky, 'resumeDelegatedGrantAuthFlow', () => {
      if (++resumes === 1) {
        olderResuming.resolve()
        return olderResume.promise
      }
      return Promise.resolve(current)
    })
    const olderResult = auth.startRingAuthFlow({}, () => currentToken === 'older')
    await olderResuming.promise
    currentToken = 'current'
    const currentFlow = await auth.startRingAuthFlow({}, () => currentToken === 'current')
    const saved = pending.entries()

    const canceled = assert.rejects(olderResult, { name: 'RingAuthCanceled' })
    if (expired) {
      olderResume.reject(
        sdkError('AuthenticationError', 'The provided auth request has expired or was cancelled.'),
      )
    } else {
      olderResume.resolve(older)
    }
    await canceled
    assert.deepEqual(pending.entries(), saved)
    assert.equal(older.awaitApproval.mock.callCount(), 0)
    assert.equal(older.free.mock.callCount(), expired ? 0 : 1)
    assert.equal(current.free.mock.callCount(), 0)
    assert.equal(start.mock.callCount(), 0)
    currentFlow.suspend()
  })
}

test('a superseded fresh startup cannot remove state after its availability check', async (t) => {
  const available = deferred()
  let current = true
  t.mock.method(BrowserSessionStore.prototype, 'isAvailable', () => available.promise)
  const start = t.mock.method(auth.pubky, 'startGrantAuthFlow', async () => fakeFlow(t))
  const resume = t.mock.method(auth.pubky, 'resumeDelegatedGrantAuthFlow', async () => fakeFlow(t))
  const result = auth.startRingAuthFlow({ fresh: true }, () => current)
  current = false
  pending.setItem(
    'template:session:pending-auth',
    JSON.stringify({ mode: 'delegated', state: 'current-state' }),
  )
  const saved = pending.entries()
  const canceled = assert.rejects(result, { name: 'RingAuthCanceled' })
  available.resolve(true)
  await canceled
  assert.deepEqual(pending.entries(), saved)
  assert.equal(start.mock.callCount(), 0)
  assert.equal(resume.mock.callCount(), 0)
})

for (const failed of [false, true]) {
  test(`cached-page approval ${failed ? 'failure' : 'success'} waits for visibility without restarting its waiter`, async (t) => {
    const approval = deferred()
    const sdkFlow = fakeFlow(t, approval.promise)
    sdkFlow.awaitApproval = t.mock.fn(() => approval.promise)
    const start = t.mock.method(auth.pubky, 'startGrantAuthFlow', async () => sdkFlow)
    const attempt = lifecycle.createRingAuthAttempt(auth.getSavedSessionId, () => true)
    const flow = await auth.startRingAuthFlow({}, attempt.isCurrent)
    let applied = false
    const apply = async () => {
      if (await attempt.waitUntilVisible()) applied = true
    }
    const handled = flow.awaitApproval.then(apply, apply)
    attempt.pause()
    if (failed) approval.reject(new Error('Relay unavailable'))
    else approval.resolve({})
    await flow.awaitApproval.catch(() => {})
    assert.equal(applied, false)
    assert.equal(attempt.isCurrent(), true)
    attempt.resume()
    await handled
    assert.equal(applied, true)
    assert.equal(start.mock.callCount(), 1)
    assert.equal(sdkFlow.awaitApproval.mock.callCount(), 1)
  })
}

test('a cached page retains in-flight startup and validates selection before approval', async (t) => {
  const started = deferred()
  const startup = deferred()
  const approval = deferred()
  const sdkFlow = fakeFlow(t, approval.promise)
  sdkFlow.awaitApproval = t.mock.fn(() => approval.promise)
  const start = t.mock.method(auth.pubky, 'startGrantAuthFlow', () => {
    started.resolve()
    return startup.promise
  })
  let active = true
  const attempt = lifecycle.createRingAuthAttempt(auth.getSavedSessionId, () => active)
  const result = auth.startRingAuthFlow({}, attempt.isCurrent)
  await started.promise
  attempt.pause()
  startup.resolve(sdkFlow)
  const flow = await result
  assert.equal(sdkFlow.free.mock.callCount(), 0)
  assert.equal(pending.entries().length, 1)
  let applied = false
  const handled = flow.awaitApproval.then(async () => {
    if (await attempt.waitUntilVisible()) applied = true
  })
  approval.resolve({})
  await flow.awaitApproval
  local.setItem('template:session', 'other:grant')
  assert.equal(attempt.isCurrent(), false)
  // The page invalidates its token before releasing the cached handler.
  active = false
  attempt.cancel()
  await handled
  assert.equal(applied, false)
  assert.equal(auth.getSavedSessionId(), 'other:grant')
  assert.equal(start.mock.callCount(), 1)
  assert.equal(sdkFlow.awaitApproval.mock.callCount(), 1)
})

for (const selectionChanged of [false, true]) {
  test(`persistence finishing in a cached page ${selectionChanged ? 'preserves a changed selection' : 'selects only after restore'}`, async (t) => {
    const stored = deferred()
    const savedRecord = record('approved:grant')
    savedRecord.free = t.mock.fn()
    const save = t.mock.method(BrowserSessionStore.prototype, 'save', () => stored.promise)
    let active = true
    const attempt = lifecycle.createRingAuthAttempt(auth.getSavedSessionId, () => active)
    const session = { signout: t.mock.fn(async () => {}) }
    const result = auth.saveSession(session, attempt.isCurrent, attempt.waitUntilVisible)
    attempt.pause()
    stored.resolve(savedRecord)
    await stored.promise
    assert.equal(auth.getSavedSessionId(), null)
    assert.equal(savedRecord.free.mock.callCount(), 0)
    if (selectionChanged) {
      local.setItem('template:session', 'other:grant')
      assert.equal(attempt.isCurrent(), false)
      active = false
      attempt.cancel()
    } else {
      assert.equal(attempt.isCurrent(), true)
      attempt.resume()
    }
    assert.equal(await result, !selectionChanged)
    assert.equal(auth.getSavedSessionId(), selectionChanged ? 'other:grant' : 'approved:grant')
    assert.equal(save.mock.callCount(), 1)
    assert.equal(savedRecord.free.mock.callCount(), 1)
    assert.equal(session.signout.mock.callCount(), selectionChanged ? 1 : 0)
  })
}

test('real unload cancels in-flight startup without abandoning saved resumable state', async (t) => {
  const available = deferred()
  t.mock.method(BrowserSessionStore.prototype, 'isAvailable', () => available.promise)
  const saved = JSON.stringify({ mode: 'delegated', state: 'saved-state' })
  pending.setItem('template:session:pending-auth', saved)
  const attempt = lifecycle.createRingAuthAttempt(auth.getSavedSessionId, () => true)
  const result = auth.startRingAuthFlow({}, attempt.isCurrent)
  attempt.cancel()
  const canceled = assert.rejects(result, { name: 'RingAuthCanceled' })
  available.resolve(true)
  await canceled
  assert.equal(pending.getItem('template:session:pending-auth'), saved)
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
  const revoke = t.mock.fn(async () => {})
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => record('late:grant'))
  approval.resolve({ signout: revoke })
  await new Promise(setImmediate)
  assert.equal(revoke.mock.callCount(), 1)
})

test('a paused completed save stays tracked if its page never becomes visible again', async (t) => {
  const stored = record('cached:grant')
  const visibility = deferred()
  const waiting = deferred()
  const session = { signout: t.mock.fn(async () => {}) }
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => stored)
  const save = auth.saveSession(
    session,
    () => false,
    () => {
      waiting.resolve()
      return visibility.promise
    },
  )
  await waiting.promise
  assert.equal(auth.hasPendingSessionCleanup(), true)
  const reloaded = await server.ssrLoadModule('/src/pubky.ts?cached-cleanup-reload')
  t.mock.method(BrowserSessionStore.prototype, 'restore', async () => session)
  assert.equal(await reloaded.restoreSavedSession(), undefined)
  assert.equal(session.signout.mock.callCount(), 1)
  assert.equal(auth.hasPendingSessionCleanup(), false)
  visibility.resolve()
  await save
})

test('a failed visibility callback also cleans up its persisted approval', async (t) => {
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => record('abandoned:grant'))
  const session = { signout: t.mock.fn(async () => {}) }
  await assert.rejects(
    auth.saveSession(
      session,
      () => true,
      async () => {
        throw new Error('Visibility wait failed')
      },
    ),
    /Visibility wait failed/,
  )
  assert.equal(session.signout.mock.callCount(), 1)
  assert.equal(auth.hasPendingSessionCleanup(), false)
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

test('a saved session restores through SDK coordination without scanning other records', async (t) => {
  local.setItem('template:session', 'old:grant')
  const list = t.mock.method(BrowserSessionStore.prototype, 'list', async () => {
    throw new Error('Must not scan other saved sessions')
  })
  const session = {}
  const restore = t.mock.method(BrowserSessionStore.prototype, 'restore', async () => session)
  assert.equal(await auth.restoreSavedSession(), session)
  assert.equal(restore.mock.calls[0].arguments[0], 'old:grant')
  assert.equal(auth.getSessionId(session), 'old:grant')
  assert.equal(auth.getSavedSessionId(), 'old:grant')
  assert.deepEqual(local.entries(), [['template:session', 'old:grant']])
  assert.equal(list.mock.callCount(), 0)
})

test('without a saved pointer, SDK sessions are not automatically selected', async (t) => {
  local.setItem('other:template:session', 'other:grant')
  const restore = t.mock.method(BrowserSessionStore.prototype, 'restore', async () => ({}))
  const list = t.mock.method(BrowserSessionStore.prototype, 'list', async () => [record()])
  assert.equal(await auth.restoreSavedSession(), undefined)
  assert.equal(auth.getSavedSessionId(), null)
  assert.equal(restore.mock.callCount(), 0)
  assert.equal(list.mock.callCount(), 0)
})

test('saving a session persists only its namespace pointer and retains the actual record ID', async (t) => {
  const session = {}
  const saved = record()
  saved.free = t.mock.fn()
  const save = t.mock.method(BrowserSessionStore.prototype, 'save', async () => saved)
  assert.equal(await auth.saveSession(session), true)
  assert.equal(save.mock.calls[0].arguments[0], session)
  assert.equal(auth.getSessionId(session), saved.id)
  assert.deepEqual(local.entries(), [['template:session', saved.id]])
  assert.equal(saved.free.mock.callCount(), 1)
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
    t.mock.method(BrowserSessionStore.prototype, 'restore', async () => {
      throw failure
    })
    const remove = t.mock.method(BrowserSessionStore.prototype, 'remove', async () => {})
    await assert.rejects(auth.restoreSavedSession(), (error) => error === failure)
    assert.equal(auth.getSavedSessionId(), 'saved:grant')
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

test('own SDK removal leaves successful signout completion to its caller', async (t) => {
  const signedOut = deferred()
  const session = {
    signout: () => {
      emitSdk({ id: 'account:grant', action: 'removed' })
      return signedOut.promise
    },
  }
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => record())
  await auth.saveSession(session)
  const changes = []
  t.after(auth.subscribeSavedSessionChanges((change) => changes.push(change.type)))

  const result = auth.signOut(session)
  assert.equal(auth.getSavedSessionId(), 'account:grant', 'Keep the pointer until signout resolves')
  assert.deepEqual(changes, [], 'The caller must not be reset by its own successful logout')
  signedOut.resolve()
  await result
  assert.equal(auth.getSavedSessionId(), null)
  assert.deepEqual(changes, [])
})

test('failed remote signout preserves pending logout credentials until retry succeeds', async (t) => {
  let fail = true
  const session = {
    signout: async () => {
      if (fail) throw new Error('Offline')
      emitSdk({ id: 'account:grant', action: 'removed' })
    },
  }
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => record())
  const remove = t.mock.method(BrowserSessionStore.prototype, 'remove', async () => {})
  await auth.saveSession(session)
  const changes = []
  t.after(auth.subscribeSavedSessionChanges((change) => changes.push(change.type)))
  await assert.rejects(auth.signOut(session), /Offline/)
  assert.equal(auth.getSavedSessionId(), 'account:grant')
  assert.equal(remove.mock.callCount(), 0)
  assert.deepEqual(changes, [])
  fail = false
  await auth.signOut(session)
  assert.equal(auth.getSavedSessionId(), null)
  assert.equal(remove.mock.callCount(), 0)
  assert.deepEqual(changes, [])
})

test('failed local signout does not suppress later external session removal', async (t) => {
  const session = {
    signout: async () => {
      throw new Error('Offline')
    },
  }
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => record())
  await auth.saveSession(session)
  const changes = []
  t.after(auth.subscribeSavedSessionChanges((change) => changes.push(change.type)))
  await assert.rejects(auth.signOut(session), /Offline/)

  emitSdk({ id: 'account:grant', action: 'removed' })
  assert.equal(auth.getSavedSessionId(), null)
  assert.deepEqual(changes, ['invalidated'])
})

for (const action of ['removed', 'cleared']) {
  test(`local signout still observes external ${action} of the current session`, async (t) => {
    const signedOut = deferred()
    const session = { signout: () => signedOut.promise }
    t.mock.method(BrowserSessionStore.prototype, 'save', async () => record())
    await auth.saveSession(session)
    const changes = []
    t.after(auth.subscribeSavedSessionChanges((change) => changes.push(change.type)))
    const result = auth.signOut(session)
    if (action === 'removed') local.setItem('template:session', 'newer:grant')

    emitSdk({ id: action === 'removed' ? 'newer:grant' : null, action })
    assert.equal(auth.getSavedSessionId(), null)
    assert.deepEqual(changes, ['invalidated'])
    signedOut.resolve()
    await result
    assert.deepEqual(changes, ['invalidated'])
  })
}

test('overlapping local signouts keep their own removal suppressed until both settle', async (t) => {
  const first = deferred()
  const second = deferred()
  let calls = 0
  const session = { signout: () => (++calls === 1 ? first.promise : second.promise) }
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => record())
  await auth.saveSession(session)
  const changes = []
  t.after(auth.subscribeSavedSessionChanges((change) => changes.push(change.type)))
  const firstResult = auth.signOut(session)
  const firstRejected = assert.rejects(firstResult, /Offline/)
  const secondResult = auth.signOut(session)
  first.reject(new Error('Offline'))
  await firstRejected

  emitSdk({ id: 'account:grant', action: 'removed' })
  assert.equal(auth.getSavedSessionId(), 'account:grant')
  assert.deepEqual(changes, [])
  second.resolve()
  await secondResult
  assert.equal(auth.getSavedSessionId(), null)
  assert.deepEqual(changes, [])
})

test('signout revokes its own session and preserves a newer saved pointer', async (t) => {
  const signedOut = deferred()
  const session = { signout: t.mock.fn(() => signedOut.promise) }
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => record('older:grant'))
  await auth.saveSession(session)
  const result = auth.signOut(session)
  local.setItem('template:session', 'newer:grant')
  signedOut.resolve()
  await result
  assert.equal(session.signout.mock.callCount(), 1)
  assert.equal(auth.getSavedSessionId(), 'newer:grant')
})

test('an invalid restore finishing late cannot remove a newer saved pointer', async (t) => {
  local.setItem('template:session', 'older:grant')
  const restored = deferred()
  t.mock.method(BrowserSessionStore.prototype, 'restore', () => restored.promise)
  const remove = t.mock.method(BrowserSessionStore.prototype, 'remove', async () => {})
  const result = auth.restoreSavedSession()
  local.setItem('template:session', 'newer:grant')
  restored.reject(sdkError('ClientStateError', 'Browser session is no longer valid.'))
  assert.equal(await result, undefined)
  assert.equal(auth.getSavedSessionId(), 'newer:grant')
  assert.deepEqual(remove.mock.calls[0].arguments, ['older:grant'])
})

test('SDK invalidation drops only the saved session; notifications detach cleanly', () => {
  local.setItem('template:session', 'active:grant')
  const changes = []
  const unsubscribe = auth.subscribeSavedSessionChanges((change) => changes.push(change.type))
  emitSdk(null)
  emitSdk({ id: null, action: 'removed' })
  emitSdk({ id: 'unrelated:grant', action: 'removed' })
  assert.deepEqual(changes, [])
  assert.equal(auth.getSavedSessionId(), 'active:grant')
  emitSdk({ id: 'active:grant', action: 'removed' })
  assert.equal(auth.getSavedSessionId(), null)
  assert.deepEqual(changes, ['invalidated'])
  unsubscribe()
  emitSdk({ id: null, action: 'cleared' })
  assert.deepEqual(changes, ['invalidated'])
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
  emitStorage(null)
  assert.deepEqual(changes, ['selected', 'invalidated', 'selected'])
  assert.equal(auth.getSavedSessionId(), null)
  emitSdk({ id: null, action: 'cleared' })
  assert.deepEqual(changes, ['selected', 'invalidated', 'selected'])
  unsubscribe()
})

test('a save completed after invalidation cannot replace the saved pointer', async (t) => {
  local.setItem('template:session', 'other:grant')
  const saved = record('late:grant')
  saved.free = t.mock.fn()
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => saved)
  const session = { signout: t.mock.fn(async () => {}) }
  assert.equal(await auth.saveSession(session, () => false), false)
  assert.equal(auth.getSavedSessionId(), 'other:grant')
  assert.equal(auth.getSessionId(session), 'late:grant')
  assert.equal(saved.free.mock.callCount(), 1)
  assert.equal(session.signout.mock.callCount(), 1)
})

test('a stale save must not revoke the same grant selected by another tab', async (t) => {
  local.setItem('template:session', 'shared:grant')
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => record('shared:grant'))
  const session = { signout: t.mock.fn(async () => {}) }
  assert.equal(await auth.saveSession(session, () => false), false)
  assert.equal(auth.getSavedSessionId(), 'shared:grant')
  assert.equal(session.signout.mock.callCount(), 0)
  assert.equal(auth.hasPendingSessionCleanup(), false)
})

test('an approval discarded before selection is persisted and revoked', async (t) => {
  const operations = []
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => {
    operations.push('save')
    return record('abandoned:grant')
  })
  const session = { signout: async () => operations.push('signout') }
  await auth.discardSession(session)
  assert.deepEqual(operations, ['save', 'signout'])
  assert.equal(auth.getSavedSessionId(), null)
  assert.equal(auth.hasPendingSessionCleanup(), false)
})

test('failed abandoned-grant revocation stays recoverable after reload without replacing selection', async (t) => {
  local.setItem('template:session', 'selected:grant')
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => record('abandoned:grant'))
  const session = {
    signout: async () => {
      throw new Error('Offline')
    },
  }
  await assert.rejects(
    auth.saveSession(session, () => false),
    /Offline/,
  )
  assert.equal(auth.getSavedSessionId(), 'selected:grant')
  assert.equal(auth.hasPendingSessionCleanup(), true)
  const reloaded = await server.ssrLoadModule('/src/pubky.ts?cleanup-reload')
  let recovered = false
  const selected = {}
  const restored = []
  t.mock.method(BrowserSessionStore.prototype, 'restore', async (id) => {
    restored.push(id)
    if (id === 'selected:grant') return selected
    if (!recovered) throw new Error('Still offline')
    throw sdkError('ClientStateError', 'Browser session was signed out.')
  })
  const remove = t.mock.method(BrowserSessionStore.prototype, 'remove', async () => {})
  await assert.rejects(reloaded.restoreSavedSession(), /Still offline/)
  assert.equal(reloaded.hasPendingSessionCleanup(), true)
  assert.equal(reloaded.getSavedSessionId(), 'selected:grant')
  recovered = true
  assert.equal(await reloaded.restoreSavedSession(), selected)
  assert.equal(reloaded.hasPendingSessionCleanup(), false)
  assert.deepEqual(restored, ['abandoned:grant', 'abandoned:grant', 'selected:grant'])
  assert.equal(
    remove.mock.callCount(),
    0,
    'Do not discard credentials needed for pending revocation',
  )
})

test('a same-grant save queued behind revocation cannot select the revoked record', async (t) => {
  const signingOut = deferred()
  const signedOut = deferred()
  const secondSaved = deferred()
  let revoked = false
  const abandoned = {
    signout: async () => {
      signingOut.resolve()
      await signedOut.promise
      revoked = true
    },
  }
  const late = { signout: t.mock.fn(async () => {}) }
  t.mock.method(BrowserSessionStore.prototype, 'save', async (session) => {
    if (session === late) secondSaved.resolve()
    return record('shared:grant')
  })
  t.mock.method(BrowserSessionStore.prototype, 'restore', async () => {
    if (revoked) throw sdkError('ClientStateError', 'Browser session is no longer valid.')
    return { free() {} }
  })
  const discarded = auth.discardSession(abandoned)
  await signingOut.promise
  const selected = auth.saveSession(late)
  const rejected = assert.rejects(selected, /no longer valid/)
  await secondSaved.promise
  signedOut.resolve()
  await discarded
  await rejected
  assert.equal(auth.getSavedSessionId(), null)
  assert.equal(auth.hasPendingSessionCleanup(), false)
})

test('cleanup retry preserves an exact grant that another tab has selected', async (t) => {
  local.setItem('template:session:pending-revocation:shared:grant', '1')
  local.setItem('template:session', 'shared:grant')
  const session = { signout: t.mock.fn(async () => {}) }
  const restored = t.mock.method(BrowserSessionStore.prototype, 'restore', async () => session)
  assert.equal(await auth.restoreSavedSession(), session)
  assert.equal(auth.hasPendingSessionCleanup(), false)
  assert.equal(auth.getSavedSessionId(), 'shared:grant')
  assert.equal(session.signout.mock.callCount(), 0)
  assert.equal(restored.mock.callCount(), 1, 'Only restore the currently selected grant')
})

test('invalidation during final SDK validation revokes the unselected grant', async (t) => {
  const validating = deferred()
  const validated = deferred()
  let current = true
  const session = { signout: t.mock.fn(async () => {}) }
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => record('abandoned:grant'))
  const restored = { free: t.mock.fn() }
  t.mock.method(BrowserSessionStore.prototype, 'restore', () => {
    validating.resolve()
    return validated.promise
  })
  const saving = auth.saveSession(session, () => current)
  await validating.promise
  current = false
  validated.resolve(restored)
  assert.equal(await saving, false)
  assert.equal(session.signout.mock.callCount(), 1)
  assert.equal(restored.free.mock.callCount(), 1)
  assert.equal(auth.getSavedSessionId(), null)
  assert.equal(auth.hasPendingSessionCleanup(), false)
})

test('failed final validation still retains a retry reference if revocation also fails', async (t) => {
  const session = {
    signout: async () => {
      throw new Error('Signout offline')
    },
  }
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => record('abandoned:grant'))
  t.mock.method(BrowserSessionStore.prototype, 'restore', async () => {
    throw new Error('Restore offline')
  })
  await assert.rejects(auth.saveSession(session), /Signout offline/)
  assert.equal(auth.getSavedSessionId(), null)
  assert.equal(auth.hasPendingSessionCleanup(), true)
  assert.equal(local.getItem('template:session:pending-revocation:abandoned:grant'), '1')
})

test('selection lock callbacks fulfill even when their caller must receive a cleanup error', async (t) => {
  t.mock.method(BrowserSessionStore.prototype, 'save', async () => record('abandoned:grant'))
  t.mock.method(globalThis.navigator.locks, 'request', async (_name, task) => {
    const result = task()
    await assert.doesNotReject(result, 'Firefox reports rejected lock callbacks as uncaught errors')
    return result
  })
  const offline = new Error('Offline')
  const session = {
    signout: async () => {
      throw offline
    },
  }
  await assert.rejects(auth.discardSession(session), (error) => error === offline)
  assert.equal(auth.hasPendingSessionCleanup(), true)
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
