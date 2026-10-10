import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath, URL } from 'node:url'
import { Keypair } from '@synonymdev/pubky'
import { createServer } from 'vite'

let server
let storage
let access
let filesUi
const owner = Keypair.random().publicKey
const otherOwner = Keypair.random().publicKey
const directories = {
  public: '/pub/template/files/',
  private: '/priv/template/files/',
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
  storage = await server.ssrLoadModule('/src/storage.ts')
  access = await server.ssrLoadModule('/src/access.ts')
  filesUi = await server.ssrLoadModule('/src/files-ui.ts')
})

after(async () => {
  await server?.close()
})

test('the shared file list keeps uploaded JSON out of the note editor', () => {
  const note = { id: 'note', title: 'A note', body: '', updatedAt: '' }
  const upload = { name: 'uploaded.json', metadata: { contentLength: 3 } }
  const publicHtml = filesUi.filesPanelHtml([note], 'public', undefined, [upload])
  assert.equal((publicHtml.match(/<ul /g) || []).length, 1)
  assert.ok(publicHtml.includes('data-edit-id="note"'))
  assert.ok(publicHtml.includes('data-upload-name="uploaded.json"'))
  assert.ok(!publicHtml.includes('data-edit-id="uploaded.json"'))
  assert.ok(!publicHtml.includes('data-delete-id="uploaded.json"'))
  assert.ok(publicHtml.includes('data-upload-action="copy"'))

  const privateHtml = filesUi.filesPanelHtml([], 'private', undefined, [upload])
  assert.ok(!privateHtml.includes('data-upload-action="copy"'))
  assert.ok(!privateHtml.includes('class="empty"'))
  assert.ok(privateHtml.includes('data-upload-action="download"'))
  assert.ok(privateHtml.includes('data-upload-action="delete"'))
})

function address(path, publicKey = owner) {
  return `pubky://${publicKey.z32()}${path}`
}

function fakeSession(urls, record = {}) {
  const calls = { reads: [], writes: [], deletes: [], locks: [], unlocks: [], freed: [] }
  const session = {
    info: { publicKey: owner },
    storage: {
      list: async () => urls,
      getJson: async (path) => {
        calls.reads.push(path)
        return record
      },
      stats: async () => ({ contentLength: 42, contentType: 'application/json' }),
      putJson: async (path, data) => {
        calls.writes.push({ path, data })
      },
      delete: async (path) => {
        calls.deletes.push(path)
      },
      lock: async (path) => {
        calls.locks.push(path)
        return { path, timeoutSeconds: 60, free: () => calls.freed.push(path) }
      },
      putTextLocked: async (lock, body) => {
        calls.writes.push({ path: lock.path, data: JSON.parse(body) })
      },
      deleteLocked: async (lock) => calls.deletes.push(lock.path),
      refreshLock: async () => undefined,
      unlock: async (lock) => calls.unlocks.push(lock.path),
    },
  }
  return { session, calls }
}

for (const [space, directory] of Object.entries(directories)) {
  test(`${space}: unrelated JSON filenames do not hide supported files`, async () => {
    const filenames = ['valid-note.json', 'settings.backup.json', 'two%20words.json', '.json']
    const { session, calls } = fakeSession(
      filenames.map((name) => address(`${directory}${name}`)),
      { title: 'My note', body: 'Keep this visible' },
    )

    const files = await storage.listFiles(session, space)

    assert.deepEqual(
      files.map((file) => file.id),
      ['valid-note'],
    )
    assert.equal(files[0].body, 'Keep this visible')
    assert.deepEqual(calls.reads, [`${directory}valid-note.json`])
  })

  test(`${space}: JSON IDs cannot redirect edits or deletes`, async () => {
    const path = `${directory}real-note.json`
    const { session, calls } = fakeSession([address(path)], {
      id: '../../other-app/target',
      title: 'My note',
      body: 'Content',
    })
    const [file] = await storage.listFiles(session, space)

    const { lock } = await storage.acquireFileLock(session, space, file.id)
    await storage.saveFile(session, space, { ...file, title: 'Updated' }, lock)
    await storage.deleteFile(session, space, file.id, lock)
    await storage.releaseFileLock(lock)

    assert.equal(file.id, 'real-note')
    assert.equal(calls.writes[0].path, path)
    assert.equal(calls.writes[0].data.id, 'real-note')
    assert.deepEqual(calls.deletes, [path])
  })

  test(`${space}: the entire listing is validated before any files are read`, async () => {
    const otherSpace = space === 'public' ? 'private' : 'public'
    const invalidUrls = [
      address(`${directory}note.json`, otherOwner),
      address(`${directories[otherSpace]}note.json`),
      address(`${directory}nested/note.json`),
      address(`${directory}nested/settings.backup.json`),
      address('/pub/other-app/files/note.json'),
    ]

    for (const url of invalidUrls) {
      const { session, calls } = fakeSession([address(`${directory}valid-note.json`), url])
      await assert.rejects(storage.listFiles(session, space), /outside the selected folder/)
      assert.deepEqual(calls.reads, [])
    }
  })

  test(`${space}: unsafe IDs cannot reach save or delete requests`, async () => {
    const { session, calls } = fakeSession([])

    for (const id of ['../escape', 'nested/file', '%2e%2e', 'file?query', 'file#fragment']) {
      await assert.rejects(
        storage.saveFile(session, space, { id, title: 'Title', body: 'Body' }),
        /Invalid file ID/,
      )
      await assert.rejects(storage.deleteFile(session, space, id), /Invalid file ID/)
    }

    assert.deepEqual(calls.writes, [])
    assert.deepEqual(calls.deletes, [])
  })

  test(`${space}: listing and reading errors are not treated as unsupported files`, async () => {
    for (const operation of ['list', 'getJson']) {
      for (const statusCode of [401, 403, 500]) {
        const { session } = fakeSession([address(`${directory}note.json`)])
        const error = Object.assign(new Error('Request failed'), { data: { statusCode } })
        session.storage[operation] = async () => {
          throw error
        }

        await assert.rejects(storage.listFiles(session, space), (actual) => actual === error)
      }
    }
  })
}

test('storage access respects root, separate actions, and directory boundaries', () => {
  const cases = [
    { capabilities: ['/:rw'], public: true, private: true },
    { capabilities: ['/pub/template/:rw'], public: true, private: false },
    {
      capabilities: ['/priv/template/:r', '/priv/template/:w'],
      public: false,
      private: true,
    },
    { capabilities: ['/priv/template/:r'], public: false, private: false },
    { capabilities: ['/priv/template/:w'], public: false, private: false },
    { capabilities: ['/priv/template-neighbor/:rw'], public: false, private: false },
    { capabilities: ['/priv/template:rw'], public: false, private: false },
    { capabilities: ['/priv/template/files/note.json:rw'], public: false, private: false },
  ]

  for (const entry of cases) {
    const session = { info: { capabilities: entry.capabilities } }
    for (const space of ['public', 'private']) {
      assert.equal(
        access.hasStorageAccess(session, space),
        entry[space],
        entry.capabilities.join(','),
      )
    }
  }
})

test('lock acquisition rereads current contents and keeps the token out of editor state', async () => {
  const { session, calls } = fakeSession([], { title: 'Current revision', body: 'Fresh text' })
  const { file, lock } = await storage.acquireFileLock(session, 'public', 'note')
  assert.equal(file.title, 'Current revision')
  assert.deepEqual(Object.keys(lock), ['id', 'space', 'expiresAt'])
  assert.equal(file.metadata.contentLength, 42)
  assert.deepEqual(calls.locks, ['/pub/template/files/note.json'])
  await storage.releaseFileLock(lock)
})

test('editing requires a matching session, folder, filename and live lock', async () => {
  const { session, calls } = fakeSession([], {})
  const { lock } = await storage.acquireFileLock(session, 'public', 'note')
  const input = { id: 'note', title: 'Title', body: 'Body' }
  await assert.rejects(storage.saveFile(session, 'public', input), /Lock and reopen/)
  await assert.rejects(storage.saveFile({ ...session }, 'public', input, lock), /does not belong/)
  await assert.rejects(storage.saveFile(session, 'private', input, lock), /does not belong/)
  await assert.rejects(
    storage.saveFile(session, 'public', { ...input, id: 'other' }, lock),
    /does not belong/,
  )
  await storage.releaseFileLock(lock)
  await assert.rejects(storage.saveFile(session, 'public', input, lock), /expired or was released/)
  assert.deepEqual(calls.writes, [])
})

test('a lost lock never falls back to an unlocked write', async () => {
  const { session, calls } = fakeSession([], {})
  const { lock } = await storage.acquireFileLock(session, 'public', 'note')
  let attempts = 0
  session.storage.putTextLocked = async () => {
    attempts += 1
    throw Object.assign(new Error('Stale lock'), { data: { statusCode: 412 } })
  }
  const input = { id: 'note', title: 'Title', body: 'Body' }
  await assert.rejects(storage.saveFile(session, 'public', input, lock), /read its latest contents/)
  await assert.rejects(storage.saveFile(session, 'public', input, lock), /expired or was released/)
  assert.equal(attempts, 1)
  assert.deepEqual(calls.writes, [])
  await storage.releaseFileLock(lock)
})

test('renew uses the granted lifetime and expired locks must be reacquired', async () => {
  const { session, calls } = fakeSession([], {})
  const actualNow = Date.now
  let now = 100000
  Date.now = () => now
  try {
    const { lock } = await storage.acquireFileLock(session, 'private', 'note')
    assert.equal(lock.expiresAt, 160000)
    session.storage.refreshLock = async (sdkLock) => {
      sdkLock.timeoutSeconds = 20
    }
    now += 10000
    await storage.renewFileLock(session, 'private', 'note', lock)
    assert.equal(lock.expiresAt, 130000)
    now = 130001
    await assert.rejects(
      storage.renewFileLock(session, 'private', 'note', lock),
      /expired or was released/,
    )
    assert.deepEqual(calls.writes, [])
    await storage.releaseFileLock(lock)
  } finally {
    Date.now = actualNow
  }
})

test('contention and unavailable lock support do not use unlocked operations', async () => {
  for (const [statusCode, message] of [
    [423, /Another editor/],
    [405, /does not support file locks/],
  ]) {
    const { session, calls } = fakeSession([], {})
    session.storage.lock = async () => {
      throw Object.assign(new Error('Server refused lock'), { data: { statusCode } })
    }
    await assert.rejects(storage.acquireFileLock(session, 'public', 'note'), message)
    await assert.rejects(storage.deleteFile(session, 'public', 'note'), message)
    assert.deepEqual(calls.reads, [])
    assert.deepEqual(calls.writes, [])
    assert.deepEqual(calls.deletes, [])
  }
})

test('lock cleanup waits for an in-flight write and rejects further writes', async () => {
  const { session, calls } = fakeSession([], {})
  const { lock } = await storage.acquireFileLock(session, 'public', 'note')
  let finish
  session.storage.putTextLocked = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const input = { id: 'note', title: 'Title', body: 'Body' }
  const saving = storage.saveFile(session, 'public', input, lock)
  await Promise.resolve()
  const releasing = storage.releaseFileLock(lock)
  assert.deepEqual(calls.unlocks, [])
  assert.deepEqual(calls.freed, [])
  await assert.rejects(storage.saveFile(session, 'public', input, lock), /expired or was released/)
  finish()
  await Promise.all([saving, releasing])
  assert.equal(calls.unlocks.length, 1)
  assert.equal(calls.freed.length, 1)
  await storage.releaseFileLock(lock)
  assert.equal(calls.unlocks.length, 1)
})

test('read failure releases the acquired lock and automatic delete uses a lock', async () => {
  const failed = fakeSession([], {})
  failed.session.storage.getJson = async () => {
    throw new Error('Cannot read')
  }
  await assert.rejects(storage.acquireFileLock(failed.session, 'public', 'note'), /Cannot read/)
  assert.equal(failed.calls.unlocks.length, 1)
  assert.equal(failed.calls.freed.length, 1)
  const valid = fakeSession([], {})
  await storage.deleteFile(valid.session, 'private', 'note')
  assert.deepEqual(valid.calls.locks, ['/priv/template/files/note.json'])
  assert.deepEqual(valid.calls.deletes, ['/priv/template/files/note.json'])
  assert.equal(valid.calls.unlocks.length, 1)
})
