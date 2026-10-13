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

// Model only the editor fields and mount boundaries; exercise the real app handlers.
function editorRoot() {
  const title = { value: '' }
  const body = { value: '' }
  const status = { innerHTML: '' }
  const form = {
    querySelector: (selector) => (selector.includes('title') ? title : body),
  }
  let html = ''
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
    addEventListener() {},
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

async function setup(t) {
  const local = memoryStorage()
  const events = new globalThis.EventTarget()
  Object.assign(globalThis, {
    localStorage: local,
    sessionStorage: memoryStorage(),
    window: events,
    document: { querySelector: () => null },
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
  t.mock.method(BrowserSessionStore.prototype, 'list', async () => [
    record(original),
    record(other),
  ])
  t.mock.method(BrowserSessionStore.prototype, 'isAvailable', async () => false)
  t.mock.method(BrowserSessionStore.prototype, 'remove', async () => {})
  let restore = async (id) => (id === original.id ? original : other)
  t.mock.method(BrowserSessionStore.prototype, 'restore', (id) => restore(id))
  await auth.saveSession(original)
  const root = editorRoot()
  app.start(root)
  await until(() => root.innerHTML.includes('id="file-form"'))
  root.title.value = 'Unsaved title'
  root.body.value = 'Unsaved body'
  const emit = (type, details = {}) => {
    const event = new globalThis.Event(type)
    Object.assign(event, details)
    events.dispatchEvent(event)
  }
  return {
    auth,
    root,
    original,
    other,
    emit,
    setRestore: (next) => (restore = next),
    hide: () => emit('pagehide', { persisted: true }),
    show: () => emit('pageshow', { persisted: true }),
  }
}

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

test('Back discards cached text when another saved account was selected while away', async (t) => {
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

test('an account invalidation arriving during Back restoration prevents stale drafts from returning', async (t) => {
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
