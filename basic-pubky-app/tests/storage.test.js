import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath, URL } from 'node:url'
import { Keypair } from '@synonymdev/pubky'
import { createServer } from 'vite'

let server
let storage
let access
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
})

after(async () => {
  await server?.close()
})

function address(path, publicKey = owner) {
  return `pubky://${publicKey.z32()}${path}`
}

function fakeSession(urls, record = {}) {
  const calls = { reads: [], writes: [], deletes: [] }
  const session = {
    info: { publicKey: owner },
    storage: {
      list: async () => urls,
      getJson: async (path) => {
        calls.reads.push(path)
        return record
      },
      putJson: async (path, data) => {
        calls.writes.push({ path, data })
      },
      delete: async (path) => {
        calls.deletes.push(path)
      },
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

    await storage.saveFile(session, space, { ...file, title: 'Updated' })
    await storage.deleteFile(session, space, file.id)

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
