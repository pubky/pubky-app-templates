import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath, URL } from 'node:url'
import { BrowserSessionStore } from '@synonymdev/pubky'
import { createServer } from 'vite'

function memoryStorage() {
  const values = new Map()
  return {
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

// Model only the editor fields and mount boundaries; exercise the real app handlers.
function editorRoot() {
  const title = { value: '' }
  const body = { value: '' }
  const status = { innerHTML: '' }
  const form = {
    querySelector: (selector) => (selector.includes('title') ? title : body),
  }
  let html = ''
  const handlers = new Map()
  return {
    title,
    body,
    status,
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

async function setup(t, { restoreError } = {}) {
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
  let restore = async (id) => {
    if (restoreError) throw restoreError
    return id === original.id ? original : other
  }
  t.mock.method(BrowserSessionStore.prototype, 'restore', (id) => restore(id))
  await auth.saveSession(original)
  const root = editorRoot()
  app.start(root)
  await until(() =>
    restoreError ? Boolean(root.status.innerHTML) : root.innerHTML.includes('id="file-form"'),
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
