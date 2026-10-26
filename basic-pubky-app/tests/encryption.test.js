import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath, URL } from 'node:url'
import { Keypair } from '@synonymdev/pubky'
import { createServer } from 'vite'

let server
let encryption
let data
let ui
const owner = Keypair.random().publicKey
const otherOwner = Keypair.random().publicKey
const path = '/priv/template/attachments/example.pubkyenc'

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    envFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    logLevel: 'error',
  })
  encryption = await server.ssrLoadModule('/src/encryption.ts')
  data = await server.ssrLoadModule('/src/storage-tools-data.ts')
  ui = await server.ssrLoadModule('/src/files-ui.ts')
})

after(async () => {
  await server?.close()
})

async function sessionFor() {
  const key = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  const calls = { keysFreed: 0, grantsFreed: 0, derivations: [], puts: [], blobs: [] }
  const files = new Map()
  const keys = () => ({
    scopes: ['/priv/template/attachments/'],
    deriveCryptoKeyForPath: async (value) => {
      calls.derivations.push(value)
      return key
    },
    free: () => calls.keysFreed++,
  })
  const session = {
    info: { publicKey: owner, capabilities: ['/pub/template/:rw', '/priv/template/:rwe'] },
    get grant() {
      return { encryptionKeys: keys(), free: () => calls.grantsFreed++ }
    },
    storage: {
      async putBytes(value, bytes) {
        calls.puts.push(value)
        files.set(value, new Uint8Array(bytes))
      },
      async putBlob(value, blob) {
        calls.blobs.push({ path: value, blob })
        files.set(value, new Uint8Array(await blob.arrayBuffer()))
      },
      async stats(value) {
        const bytes = files.get(value)
        return bytes ? { contentLength: bytes.byteLength } : undefined
      },
      async get(value) {
        return new globalThis.Response(files.get(value))
      },
    },
  }
  return { session, calls, files, keys, key }
}

test('encryption uses fresh IVs and roundtrips empty and binary files with real AES-GCM', async () => {
  const { session, calls, key } = await sessionFor()
  assert.equal(key.extractable, false)
  for (const input of [new Uint8Array(), new Uint8Array([0, 128, 255, 10])]) {
    const first = await encryption.encryptUpload(session, path, input)
    const second = await encryption.encryptUpload(session, path, input)
    assert.equal(first.length, input.length + encryption.ENCRYPTION_OVERHEAD_BYTES)
    assert.notDeepEqual(first.slice(8, 20), second.slice(8, 20))
    assert.deepEqual(await encryption.decryptUpload(session, path, first), input)
  }
  assert.equal(calls.keysFreed, 6)
  assert.equal(calls.grantsFreed, 6)
})

test('ciphertext authentication rejects changed contents, IV, owner, and path', async () => {
  const { session, keys } = await sessionFor()
  const encrypted = await encryption.encryptUpload(session, path, new Uint8Array([1, 2, 3]))
  for (const offset of [8, 20, encrypted.length - 1]) {
    const tampered = new Uint8Array(encrypted)
    tampered[offset] ^= 1
    await assert.rejects(encryption.decryptUpload(session, path, tampered), /Could not decrypt/)
  }
  await assert.rejects(
    encryption.decryptWithKeys(keys(), path, encrypted, otherOwner.z32()),
    /Could not decrypt/,
  )
  await assert.rejects(
    encryption.decryptUpload(session, '/priv/template/attachments/renamed.pubkyenc', encrypted),
    /Could not decrypt/,
  )
  const recovered = keys()
  try {
    assert.deepEqual(
      await encryption.decryptWithKeys(recovered, path, encrypted, owner.z32()),
      new Uint8Array([1, 2, 3]),
    )
  } finally {
    recovered.free()
  }
})

test('malformed envelopes and paths outside the private upload folder are rejected', async () => {
  const { session, calls } = await sessionFor()
  for (const bytes of [new Uint8Array(), new Uint8Array(100)]) {
    await assert.rejects(encryption.decryptUpload(session, path, bytes), /not a supported/)
  }
  for (const value of [
    '/pub/template/attachments/file',
    '/priv/other/attachments/file',
    '/priv/template/attachments/',
    '/priv/template/attachments/../secret',
    '/priv/template/attachments/nested/file',
    '/priv/template/attachments/%2e%2e',
  ]) {
    await assert.rejects(
      encryption.encryptUpload(session, value, new Uint8Array()),
      /private upload folder/,
    )
  }
  assert.equal(calls.derivations.length, 0)
})

test('missing or declined encryption keys fail explicitly without plaintext fallback', async () => {
  for (const keys of [undefined, { scopes: [], free() {} }]) {
    const { session, calls } = await sessionFor()
    Object.defineProperty(session, 'grant', {
      value: { encryptionKeys: keys, free: () => calls.grantsFreed++ },
    })
    await assert.rejects(
      data.uploadFileBytes(
        session,
        'private',
        new globalThis.File(['secret'], 'file.txt'),
        () => true,
        true,
      ),
      /No encryption keys were approved/,
    )
    assert.deepEqual(calls.puts, [])
    assert.deepEqual(calls.blobs, [])
    assert.equal(calls.grantsFreed, 1)
  }
})

test('failed derivation frees the owned bundle and view changes block encryption writes', async () => {
  const { session, calls } = await sessionFor()
  let current = true
  Object.defineProperty(session, 'grant', {
    configurable: true,
    get() {
      return {
        encryptionKeys: {
          scopes: ['/priv/template/attachments/'],
          async deriveCryptoKeyForPath() {
            throw new Error('Signer granted keys for another scope')
          },
          free: () => calls.keysFreed++,
        },
        free: () => calls.grantsFreed++,
      }
    },
  })
  await assert.rejects(encryption.encryptUpload(session, path, new Uint8Array()), /another scope/)
  assert.equal(calls.keysFreed, 1)
  assert.equal(calls.grantsFreed, 1)
  const key = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  Object.defineProperty(session, 'grant', {
    value: {
      encryptionKeys: {
        scopes: ['/priv/template/attachments/'],
        async deriveCryptoKeyForPath() {
          current = false
          return key
        },
        free: () => calls.keysFreed++,
      },
      free: () => calls.grantsFreed++,
    },
  })
  await assert.rejects(
    data.uploadFileBytes(
      session,
      'private',
      new globalThis.File(['secret'], 'file.txt'),
      () => current,
      true,
    ),
    /view changed/,
  )
  assert.deepEqual(calls.puts, [])
  assert.deepEqual(calls.blobs, [])
  assert.equal(calls.keysFreed, 2)
  assert.equal(calls.grantsFreed, 2)
})

test('view changes during decryption discard its plaintext result', async (t) => {
  const { session } = await sessionFor()
  let current = true
  const encrypted = await encryption.encryptUpload(session, path, new Uint8Array([1, 2, 3]))
  const decrypt = globalThis.crypto.subtle.decrypt.bind(globalThis.crypto.subtle)
  t.mock.method(globalThis.crypto.subtle, 'decrypt', async (...args) => {
    const result = await decrypt(...args)
    current = false
    return result
  })
  await assert.rejects(
    encryption.decryptUpload(session, path, encrypted, () => current),
    /view changed/,
  )
})

test('existing upload/download interaction stores ciphertext and supports a raw backup', async () => {
  const { session, calls, files } = await sessionFor()
  const bytes = new Uint8Array([0, 128, 255])
  const name = await data.uploadFileBytes(
    session,
    'private',
    new globalThis.File([bytes], 'photo.bin'),
    () => true,
    true,
  )
  assert.ok(name.endsWith('.pubkyenc'))
  const stored = files.get(data.uploadedFilePath('private', name))
  assert.notDeepEqual(stored, bytes)
  assert.deepEqual(await data.readUploadedFile(session, 'private', name), bytes)
  assert.deepEqual(await data.readUploadedFile(session, 'private', name, () => true, false), stored)
  assert.equal(encryption.downloadedUploadName('private', name), name.slice(0, -'.pubkyenc'.length))
  assert.equal(calls.blobs.length, 0)
})

test('encrypted upload size includes its envelope and public encryption is rejected', async () => {
  const { session, calls } = await sessionFor()
  const limit = data.MAX_FILE_BYTES - encryption.ENCRYPTION_OVERHEAD_BYTES
  for (const space of ['private', 'public']) {
    const file = new globalThis.File([new Uint8Array(limit + 1)], 'large.bin')
    await assert.rejects(
      data.uploadFileBytes(session, space, file, () => true, true),
      space === 'private' ? /5 MiB/ : /Choose private storage/,
    )
  }
  assert.equal(calls.derivations.length, 0)
  const name = await data.uploadFileBytes(
    session,
    'private',
    new globalThis.File([new Uint8Array(limit)], 'at-limit.bin'),
    () => true,
    true,
  )
  assert.equal((await data.readUploadedFile(session, 'private', name)).byteLength, limit)
})

test('plain uploads use native putBlob and cannot collide with the encrypted suffix', async () => {
  const { session, calls } = await sessionFor()
  const file = new globalThis.File([new Uint8Array([1, 2])], 'ordinary.pubkyenc')
  const name = await data.uploadFileBytes(session, 'private', file)
  assert.ok(name.endsWith('.pubkyenc.raw'))
  assert.equal(calls.blobs[0].blob, file)
  assert.equal(calls.puts.length, 0)
  assert.equal(calls.derivations.length, 0)
  assert.deepEqual(await data.readUploadedFile(session, 'private', name), new Uint8Array([1, 2]))
})

test('upload UI exposes encryption only in private storage and labels encrypted downloads', () => {
  assert.ok(ui.editorPanelHtml([], undefined, 'private').includes('name="encrypt-file"'))
  assert.ok(!ui.editorPanelHtml([], undefined, 'public').includes('name="encrypt-file"'))
  const html = ui.filesPanelHtml([], 'private', undefined, [{ name: 'file.pubkyenc' }])
  assert.ok(html.includes('Encrypted file'))
  assert.ok(html.includes('Decrypt &amp; download'))
  assert.ok(html.includes('data-upload-action="download-encrypted"'))
})
