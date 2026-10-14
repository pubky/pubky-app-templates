import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath, URL } from 'node:url'
import { BrowserSessionStore } from '@synonymdev/pubky'
import { createServer } from 'vite'

function memoryStorage() {
  const values = new Map()
  return {
    get length() {
      return values.size
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  }
}

class TestButton {
  constructor(id) {
    this.id = id
    this.dataset = {}
  }

  closest(selector) {
    return selector === 'button' ? this : null
  }
}

// Model the editor fields, event panel, and mount boundaries; exercise the real app handlers.
function editorRoot() {
  const title = { value: '' }
  const body = { value: '' }
  const status = { innerHTML: '' }
  const eventList = { innerHTML: '' }
  const eventToggle = { textContent: 'Start live' }
  const form = {
    querySelector: (selector) => (selector.includes('title') ? title : body),
  }
  let html = ''
  const handlers = new Map()
  return {
    title,
    body,
    status,
    eventList,
    eventToggle,
    mounts: 0,
    get innerHTML() {
      return html
    },
    set innerHTML(value) {
      html = value
      this.mounts += 1
      title.value = value.match(/<input name="title" value="([^"]*)"/)?.[1] ?? ''
      body.value = value.match(/<textarea name="body" rows="8">([^<]*)<\/textarea>/)?.[1] ?? ''
    },
    addEventListener: (type, handler) => handlers.set(type, handler),
    click: (id) => handlers.get('click')({ target: new TestButton(id) }),
    submit: (id) => handlers.get('submit')({ target: new TestButton(id), preventDefault() {} }),
    querySelector(selector) {
      if (selector === '#status') return status
      if (selector === '#file-form') return html.includes('id="file-form"') ? form : null
      if (selector === '#event-list') return html.includes('id="event-list"') ? eventList : null
      if (selector === '#toggle-event-stream')
        return html.includes('id="toggle-event-stream"') ? eventToggle : null
      return null
    },
    querySelectorAll: () => [],
  }
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await setImmediate()
  }
  assert.ok(predicate(), 'App did not finish the expected lifecycle transition')
}

async function setup(t, { restoreError, cleanupError, selected = true } = {}) {
  const local = memoryStorage()
  const events = new globalThis.EventTarget()
  Object.assign(globalThis, {
    localStorage: local,
    sessionStorage: memoryStorage(),
    window: events,
    document: { querySelector: () => null },
    Element: TestButton,
    HTMLFormElement: TestButton,
  })
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: { request: (_name, task) => task() },
  })
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    envFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    logLevel: 'error',
  })
  t.after(() => server.close())
  const auth = await server.ssrLoadModule('/src/pubky.ts')
  const app = await server.ssrLoadModule('/src/app.ts')
  const session = (id) => ({
    id,
    free() {},
    info: { publicKey: id, capabilities: ['/pub/template/:rw', '/priv/template/:rw'] },
    storage: { list: async () => [] },
  })
  const original = session('original:grant')
  const other = session('other:grant')
  const record = (session) => ({
    id: session.id,
    publicKey: session.info.publicKey,
    clientId: 'template',
    free() {},
  })
  t.mock.method(BrowserSessionStore.prototype, 'save', async (session) => record(session))
  const available = t.mock.method(BrowserSessionStore.prototype, 'isAvailable', async () => false)
  t.mock.method(BrowserSessionStore.prototype, 'remove', async () => {})
  let starting = true
  let restore = async (id) => {
    if (id === 'abandoned:grant' && cleanupError) throw cleanupError
    if (restoreError && !starting) throw restoreError
    return id === original.id ? original : other
  }
  t.mock.method(BrowserSessionStore.prototype, 'restore', (id) => restore(id))
  await auth.saveSession(original)
  starting = false
  if (cleanupError) local.setItem('template:session:pending-revocation:abandoned:grant', '1')
  if (!selected) local.removeItem('template:session')
  const root = editorRoot()
  globalThis.document.querySelector = (selector) => root.querySelector(selector)
  app.start(root)
  await until(() =>
    restoreError || cleanupError
      ? Boolean(root.status.innerHTML)
      : root.innerHTML.includes('id="file-form"'),
  )
  await setImmediate()
  root.title.value = 'Unsaved title'
  root.body.value = 'Unsaved body'
  const emit = (type, details = {}) => {
    const event = new globalThis.Event(type)
    Object.assign(event, details)
    events.dispatchEvent(event)
  }
  return {
    auth,
    available,
    root,
    original,
    other,
    emit,
    setRestore: (next) => (restore = next),
    hide: () => emit('pagehide', { persisted: true }),
    show: () => emit('pageshow', { persisted: true }),
  }
}

for (const selected of [false, true]) {
  test(`abandoned-grant cleanup can be retried ${selected ? 'without replacing the selected session' : 'without starting a replacement sign-in'}`, async (t) => {
    const { auth, root, original, available, setRestore } = await setup(t, {
      cleanupError: new Error('Abandoned sign-in revocation is offline'),
      selected,
    })
    assert.equal(available.mock.callCount(), 0)
    assert.ok(root.innerHTML.includes('id="retry-saved-session"'))
    assert.ok(!root.innerHTML.includes('id="file-form"'))
    assert.ok(!root.innerHTML.includes('id="refresh-ring-signin"'))
    assert.ok(root.status.innerHTML.includes('Abandoned sign-in revocation is offline'))

    const formData = t.mock.method(globalThis, 'FormData', function () {
      return { get: () => '' }
    })
    root.click('refresh-ring-signin')
    root.submit('development-signup-form')
    await setImmediate()
    assert.equal(available.mock.callCount(), 0)
    assert.equal(formData.mock.callCount(), 0)

    setRestore(async (id) => {
      if (id === original.id) return original
      throw Object.assign(new Error('Browser session was signed out.'), {
        name: 'ClientStateError',
      })
    })
    root.click('retry-saved-session')
    await until(() =>
      selected
        ? root.innerHTML.includes('id="file-form"')
        : root.status.innerHTML.includes('secure browser context'),
    )
    assert.equal(auth.getSavedSessionId(), selected ? original.id : null)
    assert.ok(!root.innerHTML.includes('id="retry-saved-session"'))
    assert.equal(available.mock.callCount(), selected ? 0 : 1)
  })
}

for (const historyFails of [false, true]) {
  test(`${historyFails ? 'failed' : 'empty'} event history clears live rows and restores the start control`, async (t) => {
    const { auth, root, original } = await setup(t)
    const owner = 'event-owner'
    original.info.publicKey = { z32: () => owner, toString: () => owner }
    let liveController
    let liveCanceled = false
    let finishHistory
    const subscriptions = []
    t.mock.method(auth.pubky, 'eventStreamForUser', () => {
      const options = {}
      const builder = {}
      for (const option of ['path', 'maxEventBytes', 'session', 'reverse', 'limit', 'live']) {
        builder[option] = (value = true) => {
          options[option] = value
          return builder
        }
      }
      builder.subscribe = async () => {
        subscriptions.push(options)
        if (options.live) {
          return new globalThis.ReadableStream({
            start(controller) {
              liveController = controller
            },
            cancel() {
              liveCanceled = true
            },
          })
        }
        if (subscriptions.length > 1) {
          await new Promise((resolve, reject) => {
            finishHistory = () =>
              historyFails ? reject(new Error('History unavailable')) : resolve()
          })
        }
        return new globalThis.ReadableStream({ start: (controller) => controller.close() })
      }
      return builder
    })

    root.click('toggle-event-stream')
    await until(() => liveController && root.eventToggle.textContent === 'Stop live')
    liveController.enqueue({
      cursor: '1',
      eventType: 'PUT',
      resource: {
        path: '/pub/template/files/live.json',
        owner: { z32: () => owner, free() {} },
        free() {},
      },
      free() {},
    })
    await until(() => root.eventList.innerHTML.includes('live.json'))

    root.click('load-event-history')
    await until(() => finishHistory)
    assert.equal(liveCanceled, true)
    assert.equal(root.eventToggle.textContent, 'Start live')
    assert.ok(root.eventList.innerHTML.includes('No events yet.'))
    assert.ok(!root.eventList.innerHTML.includes('live.json'))
    finishHistory()
    await until(() =>
      root.status.innerHTML.includes(
        historyFails ? 'History unavailable' : 'Loaded 0 recent events',
      ),
    )
    assert.equal(root.eventToggle.textContent, 'Start live')
    assert.ok(root.eventList.innerHTML.includes('No events yet.'))
  })
}

test('a failed saved-session restore offers retry without starting replacement authentication', async (t) => {
  const { auth, available, root, original, setRestore } = await setup(t, {
    restoreError: new Error('Pending revocation could not reach the homeserver'),
  })
  assert.equal(available.mock.callCount(), 0, 'Ring must not start while a saved pointer remains')
  assert.equal(auth.getSavedSessionId(), original.id)
  assert.ok(root.innerHTML.includes('id="retry-saved-session"'))
  assert.ok(!root.innerHTML.includes('id="refresh-ring-signin"'))
  assert.ok(!root.innerHTML.includes('id="development-signup-form"'))
  assert.ok(root.status.innerHTML.includes('Pending revocation could not reach the homeserver'))

  root.click('retry-saved-session')
  await until(() =>
    root.status.innerHTML.includes('Pending revocation could not reach the homeserver'),
  )
  await setImmediate()
  assert.equal(auth.getSavedSessionId(), original.id, 'Another failed retry retains the pointer')
  assert.equal(available.mock.callCount(), 0)

  setRestore(async () => original)
  root.click('retry-saved-session')
  await until(() => root.innerHTML.includes('id="file-form"'))
  assert.equal(auth.getSavedSessionId(), original.id)
  assert.equal(available.mock.callCount(), 0, 'Successful restoration needs no new approval')
})

test('saved-session recovery permits new sign-in only after the SDK confirms revocation', async (t) => {
  const { auth, available, root, original, setRestore } = await setup(t, {
    restoreError: new Error('Sign-out is waiting for connectivity'),
  })
  assert.equal(auth.getSavedSessionId(), original.id)
  assert.equal(available.mock.callCount(), 0)
  setRestore(async () => {
    throw Object.assign(new Error('Browser session was signed out.'), { name: 'ClientStateError' })
  })

  root.click('retry-saved-session')
  await until(() => root.status.innerHTML.includes('secure browser context'))
  assert.equal(auth.getSavedSessionId(), null)
  assert.ok(!root.innerHTML.includes('id="retry-saved-session"'))
  assert.ok(root.innerHTML.includes('id="refresh-ring-signin"'))
  assert.equal(available.mock.callCount(), 1)
})

test('stale Ring and development-signup controls cannot replace a saved session awaiting recovery', async (t) => {
  const { auth, available, root, original } = await setup(t, {
    restoreError: new Error('Saved session temporarily unavailable'),
  })
  const formData = t.mock.method(globalThis, 'FormData', function () {
    return { get: () => '' }
  })
  const signer = t.mock.method(auth.pubky, 'signer', () => {
    throw new Error('Must not create another identity')
  })

  root.click('refresh-ring-signin')
  root.submit('development-signup-form')
  await setImmediate()

  assert.equal(available.mock.callCount(), 0)
  assert.equal(formData.mock.callCount(), 0)
  assert.equal(signer.mock.callCount(), 0)
  assert.equal(auth.getSavedSessionId(), original.id)
  assert.ok(root.innerHTML.includes('id="retry-saved-session"'))
})

test('Back keeps restoration retry available when the saved session is temporarily unavailable', async (t) => {
  const { auth, available, root, original, setRestore, hide, show } = await setup(t)
  hide()
  setRestore(async () => {
    throw new Error('Homeserver temporarily unavailable')
  })
  show()
  await until(() => root.status.innerHTML.includes('Homeserver temporarily unavailable'))
  await setImmediate()
  assert.equal(auth.getSavedSessionId(), original.id)
  assert.equal(available.mock.callCount(), 0)
  assert.ok(root.innerHTML.includes('id="retry-saved-session"'))
  assert.ok(!root.innerHTML.includes('id="file-form"'))
  assert.equal(root.body.value, '', 'A failed restore must not reveal the cached editor')
})

test('Back restores live unsaved note fields only after the same saved session is validated', async (t) => {
  const { root, original, setRestore, hide, show } = await setup(t)
  hide()
  let resolve
  setRestore(() => new Promise((done) => (resolve = done)))
  const mounts = root.mounts
  show()
  await until(() => resolve)
  assert.equal(root.body.value, '', 'Cached editor is hidden while session validation is pending')
  resolve(original)
  await until(() => root.mounts >= mounts + 2)
  assert.equal(root.title.value, 'Unsaved title')
  assert.equal(root.body.value, 'Unsaved body')
})

test('Back discards cached text when a new session was saved while away', async (t) => {
  const { auth, root, other, hide, show } = await setup(t)
  hide()
  await auth.saveSession(other)
  const mounts = root.mounts
  show()
  await until(() => root.mounts >= mounts + 2)
  assert.ok(root.innerHTML.includes(other.id))
  assert.equal(root.title.value, '')
  assert.equal(root.body.value, '')
})

test('Back discards cached text when the saved session was revoked', async (t) => {
  const { auth, root, setRestore, hide, show } = await setup(t)
  hide()
  setRestore(async () => {
    throw Object.assign(new Error('Browser session is no longer valid.'), {
      name: 'ClientStateError',
    })
  })
  show()
  await until(() => root.status.innerHTML.includes('secure browser context'))
  assert.equal(auth.getSavedSessionId(), null)
  assert.ok(!root.innerHTML.includes('id="file-form"'))
  assert.equal(root.body.value, '')
})

test('a session invalidation arriving during Back restoration prevents stale drafts from returning', async (t) => {
  const { auth, root, original, emit, setRestore, hide, show } = await setup(t)
  hide()
  let resolve
  setRestore(() => new Promise((done) => (resolve = done)))
  show()
  await until(() => resolve)
  emit('pubky-session-changed', { detail: { action: 'removed', id: original.id } })
  resolve(original)
  await until(() => root.status.innerHTML.includes('secure browser context'))
  assert.equal(auth.getSavedSessionId(), null)
  assert.ok(!root.innerHTML.includes('id="file-form"'))
  assert.equal(root.body.value, '')
})
