import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath, URL } from 'node:url'
import { Keypair } from '@synonymdev/pubky'
import { createServer } from 'vite'

let server
let data
let filesUi
const owner = Keypair.random().publicKey
const anotherOwner = Keypair.random().publicKey
const address = (path, key = owner) => `pubky://${key.z32()}${path}`

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    envFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    logLevel: 'error',
  })
  data = await server.ssrLoadModule('/src/storage-tools-data.ts')
  filesUi = await server.ssrLoadModule('/src/files-ui.ts')
})

after(async () => {
  await server?.close()
})

function sessionFor(urls = []) {
  const calls = { metadata: [], puts: [], gets: [], deletes: [] }
  const session = {
    info: { publicKey: owner, capabilities: ['/pub/template/:rw', '/priv/template/:rw'] },
    storage: {
      list: async () => urls,
      stats: async (path) => {
        calls.metadata.push(path)
        return { contentLength: 3 }
      },
      putBytes: async (path, bytes) => calls.puts.push({ path, bytes }),
      getBytes: async (path) => {
        calls.gets.push(path)
        return new Uint8Array([0, 128, 255])
      },
      delete: async (path) => calls.deletes.push(path),
    },
  }
  return { session, calls }
}

test('public reader canonicalizes public Pubky addresses and rejects private or HTTP URLs', () => {
  const path = '/pub/example/readme.json'
  assert.equal(data.parsePublicAddress(address(path)).address, address(path))
  assert.equal(data.parsePublicAddress(`${owner.toString()}${path}`).address, address(path))
  for (const value of [
    'https://example.com/file',
    'http://localhost/admin',
    address('/priv/template/file'),
    address('/pub/template/'),
    address('/pub/template/file?secret=1'),
    address('/pub/template/file#fragment'),
    address('/pub/template/../secret'),
    'pubky-invalid/pub/file',
  ])
    assert.throws(() => data.parsePublicAddress(value), undefined, value)
})

test('attachment listings validate owner and app folder before requesting metadata', async () => {
  const valid = address('/priv/template/attachments/file.bin')
  const invalid = [
    address('/priv/template/attachments/file.bin', anotherOwner),
    address('/pub/template/attachments/file.bin'),
    address('/priv/other-app/attachments/file.bin'),
    address('/priv/template/attachments/nested/file.bin'),
  ]
  for (const url of invalid) {
    const { session, calls } = sessionFor([valid, url])
    await assert.rejects(data.listAttachments(session, 'private'), /outside the selected folder/)
    assert.deepEqual(calls.metadata, [])
  }
  const { session } = sessionFor([valid, address('/priv/template/attachments/two%20words.bin')])
  assert.deepEqual(
    (await data.listAttachments(session, 'private')).map((file) => file.name),
    ['file.bin'],
  )
})

test('attachment filenames cannot redirect downloads or deletes', async () => {
  const { session, calls } = sessionFor()
  for (const name of ['../secret', 'nested/file', '%2e%2e', 'file?query', '.hidden', '..']) {
    await assert.rejects(data.readAttachment(session, 'private', name), /Invalid attachment/)
    await assert.rejects(data.removeAttachment(session, 'private', name), /Invalid attachment/)
  }
  assert.deepEqual(calls.metadata, [])
  assert.deepEqual(calls.gets, [])
  assert.deepEqual(calls.deletes, [])
})

test('binary uploads use app-specific unique filenames and preserve byte values', async () => {
  const { session, calls } = sessionFor()
  const bytes = new Uint8Array([0, 128, 255])
  const name = await data.uploadAttachment(session, 'private', {
    name: '../../<script>.bin',
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer,
  })
  assert.match(name, /^[a-f0-9-]+-[a-zA-Z0-9._-]+$/)
  assert.equal(calls.puts[0].path, `/priv/template/attachments/${name}`)
  assert.deepEqual([...calls.puts[0].bytes], [...bytes])
  const downloaded = await data.readAttachment(session, 'private', name)
  assert.deepEqual([...downloaded], [...bytes])
})

test('oversized uploads and view changes cannot initiate a write', async () => {
  const { session, calls } = sessionFor()
  let read = false
  await assert.rejects(
    data.uploadAttachment(session, 'public', {
      name: 'large.bin',
      size: data.MAX_ATTACHMENT_BYTES + 1,
      arrayBuffer: async () => {
        read = true
        return new ArrayBuffer(0)
      },
    }),
    /5 MiB/,
  )
  assert.equal(read, false)
  await assert.rejects(
    data.uploadAttachment(
      session,
      'private',
      {
        name: 'file.bin',
        size: 1,
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      },
      () => false,
    ),
    /view changed/,
  )
  assert.deepEqual(calls.puts, [])
})

test('binary operations respect session capabilities', async () => {
  const { session, calls } = sessionFor()
  session.info.capabilities = ['/pub/template/:rw']
  await assert.rejects(
    data.listAttachments(session, 'private'),
    /does not have read and write access/,
  )
  await assert.rejects(
    data.readAttachment(session, 'private', 'file.bin'),
    /does not have read and write access/,
  )
  await assert.rejects(
    data.removeAttachment(session, 'private', 'file.bin'),
    /does not have read and write access/,
  )
  assert.deepEqual(calls.metadata, [])
  assert.deepEqual(calls.deletes, [])
})

test('anonymous public reads never request a session and preserve binary content', async () => {
  const calls = []
  const publicStorage = {
    stats: async (target) => {
      calls.push(target)
      return { contentType: 'application/octet-stream' }
    },
    get: async (target) => {
      calls.push(target)
      return new globalThis.Response(new Uint8Array([0, 128, 255]))
    },
  }
  const result = await data.readPublicFile(publicStorage, address('/pub/any-app/file.bin'))
  assert.deepEqual([...result.bytes], [0, 128, 255])
  assert.deepEqual(calls, [address('/pub/any-app/file.bin'), address('/pub/any-app/file.bin')])
})

test('public streaming reads cancel oversized bodies even without a Content-Length', async () => {
  let canceled = false
  const response = new globalThis.Response(
    new globalThis.ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(data.MAX_ATTACHMENT_BYTES + 1))
      },
      cancel() {
        canceled = true
      },
    }),
  )
  await assert.rejects(data.readLimitedResponse(response), /5 MiB/)
  assert.equal(canceled, true)
})

test('file UI escapes metadata and handles invalid server dates without crashing', () => {
  const html = filesUi.filesPanelHtml(
    [
      {
        id: 'note',
        title: '<script>bad()</script>',
        body: '',
        updatedAt: 'not a date',
        metadata: { etag: '<img src=x onerror=alert(1)>', contentLength: 12 },
      },
    ],
    'public',
  )
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('&lt;img'))
  assert.ok(!html.includes('<script>'))
  assert.ok(!html.includes('<img'))
})
