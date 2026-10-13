import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath, URL } from 'node:url'
import { Keypair, PubkyResource } from '@synonymdev/pubky'
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
  const calls = { lists: [], metadata: [], puts: [], gets: [], deletes: [] }
  const session = {
    info: { publicKey: owner, capabilities: ['/pub/template/:rw', '/priv/template/:rw'] },
    storage: {
      list: async (...args) => {
        calls.lists.push(args)
        return urls
      },
      stats: async (path) => {
        calls.metadata.push(path)
        return { contentLength: 3 }
      },
      putBytes: async (path, bytes) => calls.puts.push({ path, bytes }),
      get: async (path) => {
        calls.gets.push(path)
        return new globalThis.Response(new Uint8Array([0, 128, 255]))
      },
      delete: async (path) => calls.deletes.push(path),
    },
  }
  return { session, calls }
}

test('public reader accepts both public Pubky address forms and rejects private or HTTP URLs', () => {
  const path = '/pub/example/readme.json'
  assert.equal(data.parsePublicAddress(address(path)).address, address(path))
  const identifier = `${owner.toString()}${path}`
  assert.equal(data.parsePublicAddress(identifier).address, identifier)
  for (const value of [
    'https://example.com/file',
    'http://localhost/admin',
    address('/priv/template/file'),
    address('/pub/template/'),
    address('/pub/template/file?secret=1'),
    address('/pub/template/file#fragment'),
    address('/pub/template/../secret'),
    address('/pub/template/./secret'),
    address('/pub//template/secret'),
    address('/pub/template/file\u0000'),
    address('/pub/template/file\u007f'),
    address('/pub/template/file name'),
    'pubky-invalid/pub/file',
  ])
    assert.throws(() => data.parsePublicAddress(value), undefined, value)
})

test('public reads preserve Unicode and literal percent filenames through the real SDK parser', async () => {
  for (const [filename, encodedFilename] of [
    ['café.json', 'caf%C3%A9.json'],
    ['100%.txt', '100%25.txt'],
    ['caf%C3%A9.json', 'caf%25C3%25A9.json'],
    ['%2e%2e.txt', '%252e%252e.txt'],
  ]) {
    for (const prefix of [`pubky://${owner.z32()}`, owner.toString()]) {
      const input = `${prefix}/pub/any-app/${filename}`
      const calls = []
      const readAddress = (target) => {
        const resource = PubkyResource.parse(target)
        try {
          calls.push({ target, path: resource.path })
        } finally {
          resource.free()
        }
      }
      const result = await data.readPublicFile(
        {
          stats: async (target) => {
            readAddress(target)
            return { contentLength: 2 }
          },
          get: async (target) => {
            readAddress(target)
            return new globalThis.Response('ok')
          },
        },
        `  ${input}\n`,
      )

      assert.equal(result.address, input)
      assert.deepEqual([...result.bytes], [111, 107])
      assert.deepEqual(calls, [
        { target: input, path: `/pub/any-app/${encodedFilename}` },
        { target: input, path: `/pub/any-app/${encodedFilename}` },
      ])
    }
  }
})

test('uploaded file listings validate owner and app folder before requesting metadata', async () => {
  const valid = address('/priv/template/attachments/file.bin')
  const invalid = [
    address('/priv/template/attachments/file.bin', anotherOwner),
    address('/priv/template/attachments/nested/', anotherOwner),
    address('/pub/template/attachments/file.bin'),
    address('/pub/template/attachments/nested/'),
    address('/priv/other-app/attachments/file.bin'),
    address('/priv/template/attachments-other/file.bin'),
    address('/priv/template/attachments/nested/file.bin'),
    address('/priv/template/attachments/nested/deeper/'),
  ]
  for (const url of invalid) {
    const { session, calls } = sessionFor([valid, url])
    await assert.rejects(data.listUploadedFiles(session, 'private'), /outside the selected folder/)
    assert.deepEqual(calls.metadata, [])
  }
  const { session } = sessionFor([valid, address('/priv/template/attachments/two%20words.bin')])
  assert.deepEqual(
    (await data.listUploadedFiles(session, 'private')).map((file) => file.name),
    ['file.bin'],
  )
})

test('shallow upload listings skip directories and preserve pagination and file deduplication', async () => {
  const directory = '/priv/template/attachments/'
  const firstPage = Array.from({ length: 50 }, (_, index) =>
    address(`${directory}folder-${index}/`),
  )
  const secondPage = [
    address(`${directory}one.bin`),
    address(`${directory}nested/`),
    address(`${directory}two.bin`),
    address(`${directory}one.bin`),
  ]
  const { session, calls } = sessionFor()
  session.storage.list = async (...args) => {
    calls.lists.push(args)
    if (calls.lists.length === 1) return firstPage
    assert.equal(calls.lists.length, 2)
    return secondPage
  }
  const files = await data.listUploadedFiles(session, 'private')
  assert.deepEqual(
    files.map((file) => file.name),
    ['one.bin', 'two.bin'],
  )
  assert.deepEqual(calls.lists, [
    [directory, null, false, 50, true],
    [directory, firstPage.at(-1), false, 50, true],
  ])
  assert.deepEqual(calls.metadata, [`${directory}one.bin`, `${directory}two.bin`])
})

test('upload listings stop when the server repeats a full page of directories', async () => {
  const urls = Array.from({ length: 50 }, (_, index) =>
    address(`/pub/template/attachments/${index}/`),
  )
  const { session, calls } = sessionFor(urls)
  assert.deepEqual(await data.listUploadedFiles(session, 'public'), [])
  assert.equal(calls.lists.length, 2)
  assert.deepEqual(calls.metadata, [])
})

test('only a missing upload directory is treated as an empty listing', async () => {
  const { session } = sessionFor()
  for (const statusCode of [404, 401, 403, 500, 503]) {
    const error = { data: { statusCode } }
    session.storage.list = async () => {
      throw error
    }
    if (statusCode === 404) {
      assert.deepEqual(await data.listUploadedFiles(session, 'public'), [])
    } else {
      await assert.rejects(data.listUploadedFiles(session, 'public'), (actual) => actual === error)
    }
  }
})

test('upload listing failures and stale views cannot return partial file metadata', async () => {
  const { session, calls } = sessionFor([address('/priv/template/attachments/one.bin')])
  let current = true
  session.storage.list = async () => {
    current = false
    return [address('/priv/template/attachments/one.bin')]
  }
  await assert.rejects(
    data.listUploadedFiles(session, 'private', () => current),
    /view changed/,
  )
  assert.deepEqual(calls.metadata, [])

  const failed = sessionFor([address('/priv/template/attachments/one.bin')])
  const error = new Error('metadata unavailable')
  failed.session.storage.stats = async () => {
    throw error
  }
  await assert.rejects(
    data.listUploadedFiles(failed.session, 'private'),
    (actual) => actual === error,
  )
})

test('uploaded filenames cannot redirect downloads or deletes', async () => {
  const { session, calls } = sessionFor()
  for (const name of ['../secret', 'nested/file', '%2e%2e', 'file?query', '.hidden', '..']) {
    await assert.rejects(
      data.readUploadedFile(session, 'private', name),
      /Invalid uploaded filename/,
    )
    await assert.rejects(
      data.deleteUploadedFile(session, 'private', name),
      /Invalid uploaded filename/,
    )
  }
  assert.deepEqual(calls.metadata, [])
  assert.deepEqual(calls.gets, [])
  assert.deepEqual(calls.deletes, [])
})

test('binary uploads use app-specific unique filenames and preserve byte values', async () => {
  const { session, calls } = sessionFor()
  const bytes = new Uint8Array([0, 128, 255])
  const name = await data.uploadFileBytes(session, 'private', {
    name: '../../<script>.bin',
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer,
  })
  assert.match(name, /^[a-f0-9-]+-[a-zA-Z0-9._-]+$/)
  assert.equal(calls.puts[0].path, `/priv/template/attachments/${name}`)
  assert.deepEqual([...calls.puts[0].bytes], [...bytes])
  const downloaded = await data.readUploadedFile(session, 'private', name)
  assert.deepEqual([...downloaded], [...bytes])
})

test('oversized uploads and view changes cannot initiate a write', async () => {
  const { session, calls } = sessionFor()
  let read = false
  await assert.rejects(
    data.uploadFileBytes(session, 'public', {
      name: 'large.bin',
      size: data.MAX_FILE_BYTES + 1,
      arrayBuffer: async () => {
        read = true
        return new ArrayBuffer(0)
      },
    }),
    /5 MiB/,
  )
  assert.equal(read, false)
  await assert.rejects(
    data.uploadFileBytes(
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
    data.listUploadedFiles(session, 'private'),
    /does not have read and write access/,
  )
  await assert.rejects(
    data.readUploadedFile(session, 'private', 'file.bin'),
    /does not have read and write access/,
  )
  await assert.rejects(
    data.deleteUploadedFile(session, 'private', 'file.bin'),
    /does not have read and write access/,
  )
  await assert.rejects(
    data.uploadFileBytes(session, 'private', {
      name: 'file.bin',
      size: 1,
      arrayBuffer: async () => {
        assert.fail('An unauthorized upload must not read the selected file.')
      },
    }),
    /does not have read and write access/,
  )
  assert.deepEqual(calls.metadata, [])
  assert.deepEqual(calls.deletes, [])
  assert.deepEqual(calls.puts, [])
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
        controller.enqueue(new Uint8Array(data.MAX_FILE_BYTES + 1))
      },
      cancel() {
        canceled = true
      },
    }),
  )
  await assert.rejects(data.readLimitedResponse(response), /5 MiB/)
  assert.equal(canceled, true)
})

test('authenticated downloads bound streamed bytes despite missing or stale size metadata', async () => {
  for (const contentLength of [undefined, 1, data.MAX_FILE_BYTES]) {
    const { session } = sessionFor()
    session.storage.stats = async () => ({ contentLength })
    let canceled = false
    const response = new globalThis.Response(
      new globalThis.ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(data.MAX_FILE_BYTES))
          controller.enqueue(new Uint8Array(1))
        },
        cancel() {
          canceled = true
        },
      }),
      { headers: contentLength === undefined ? {} : { 'Content-Length': String(contentLength) } },
    )
    session.storage.get = async () => response
    await assert.rejects(data.readUploadedFile(session, 'private', 'file.bin'), /5 MiB/)
    assert.equal(canceled, true)
    assert.equal(response.body.locked, false)
  }
})

test('authenticated downloads reject missing files and invalid advertised sizes before fetching', async () => {
  for (const metadata of [
    undefined,
    { contentLength: data.MAX_FILE_BYTES + 1 },
    { contentLength: -1 },
    { contentLength: Infinity },
    { contentLength: NaN },
  ]) {
    const { session, calls } = sessionFor()
    session.storage.stats = async () => metadata
    await assert.rejects(
      data.readUploadedFile(session, 'private', 'file.bin'),
      metadata ? /5 MiB/ : /no longer exists/,
    )
    assert.deepEqual(calls.gets, [])
  }
})

test('authenticated downloads preserve empty, binary and exact-limit content with optional metadata', async () => {
  for (const bytes of [
    new Uint8Array(),
    new Uint8Array([0, 128, 255, 13, 10]),
    new Uint8Array(data.MAX_FILE_BYTES).fill(255),
  ]) {
    const { session } = sessionFor()
    session.storage.stats = async () => ({})
    const response = new globalThis.Response(
      new globalThis.ReadableStream({
        start(controller) {
          const middle = Math.floor(bytes.length / 2)
          controller.enqueue(bytes.subarray(0, middle))
          controller.enqueue(bytes.subarray(middle))
          controller.close()
        },
      }),
    )
    session.storage.get = async () => response
    assert.deepEqual(await data.readUploadedFile(session, 'public', 'file.bin'), bytes)
    assert.equal(response.body.locked, false)
  }
  assert.deepEqual(await data.readLimitedResponse(new globalThis.Response(null)), new Uint8Array())
})

test('authenticated download failures preserve the original metadata or request error', async () => {
  for (const method of ['stats', 'get']) {
    const { session, calls } = sessionFor()
    const error = new Error(`${method} failed`)
    session.storage[method] = async () => {
      throw error
    }
    await assert.rejects(
      data.readUploadedFile(session, 'private', 'file.bin'),
      (actual) => actual === error,
    )
    if (method === 'stats') assert.deepEqual(calls.gets, [])
  }
})

test('authenticated downloads stop stale requests after metadata and cancel stale response bodies', async () => {
  const { session, calls } = sessionFor()
  let current = true
  session.storage.stats = async () => {
    current = false
    return {}
  }
  await assert.rejects(
    data.readUploadedFile(session, 'private', 'file.bin', () => current),
    /view changed/,
  )
  assert.deepEqual(calls.gets, [])

  current = true
  let canceled = false
  session.storage.stats = async () => ({})
  const response = new globalThis.Response(
    new globalThis.ReadableStream({
      cancel() {
        canceled = true
      },
    }),
  )
  session.storage.get = async () => {
    current = false
    return response
  }
  await assert.rejects(
    data.readUploadedFile(session, 'private', 'file.bin', () => current),
    /view changed/,
  )
  assert.equal(canceled, true)
  assert.equal(response.body.locked, false)
  await assert.rejects(
    data.readLimitedResponse(new globalThis.Response(null), () => false),
    /view changed/,
  )
})

test('stream failures release the reader lock and preserve the original read error', async () => {
  const error = new Error('connection interrupted')
  const response = new globalThis.Response(
    new globalThis.ReadableStream({
      pull(controller) {
        controller.error(error)
      },
    }),
  )
  await assert.rejects(data.readLimitedResponse(response), (actual) => actual === error)
  assert.equal(response.body.locked, false)
})

test('a failing stream cancellation does not hide the oversized-download error', async () => {
  const response = new globalThis.Response(
    new globalThis.ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(data.MAX_FILE_BYTES + 1))
      },
      cancel() {
        throw new Error('cancellation failed')
      },
    }),
  )
  await assert.rejects(data.readLimitedResponse(response), /5 MiB/)
  assert.equal(response.body.locked, false)
})

test('view changes while a read waits cancel the stream, including when the next read finishes it', async () => {
  for (const done of [false, true]) {
    let current = true
    let release
    let reading
    let canceled = false
    const started = new Promise((resolve) => {
      reading = resolve
    })
    const response = new globalThis.Response(
      new globalThis.ReadableStream(
        {
          async pull(controller) {
            reading()
            await new Promise((resolve) => {
              release = resolve
            })
            if (done) controller.close()
            else controller.enqueue(new Uint8Array([1]))
          },
          cancel() {
            canceled = true
          },
        },
        { highWaterMark: 0 },
      ),
    )
    const read = data.readLimitedResponse(response, () => current)
    await started
    current = false
    release()
    await assert.rejects(read, /view changed/)
    // A closed stream needs no cancellation, but must still reject its stale result.
    assert.equal(canceled, !done)
    assert.equal(response.body.locked, false)
  }
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
