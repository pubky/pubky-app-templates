import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath, URL } from 'node:url'
import { createServer } from 'vite'

let server
let encryption
let recovery
let data
let html
const owner = 'expected-account'
const name = 'original-file.bin.pubkyenc'
const path = `/priv/template/attachments/${name}`
const recordId = 'expected-account:exact-grant'

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
  recovery = await server.ssrLoadModule('/src/encryption-recovery.ts')
  data = await server.ssrLoadModule('/src/storage-tools-data.ts')
  html = await server.ssrLoadModule('/src/html.ts')
})

after(async () => {
  await server?.close()
})

async function fixture() {
  const key = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  const keys = {
    scopes: ['/priv/template/attachments/'],
    deriveCryptoKeyForPath: async () => key,
    free() {},
  }
  const session = {
    info: { publicKey: { z32: () => owner } },
    get grant() {
      return { encryptionKeys: keys, free() {} }
    },
  }
  const plaintext = new Uint8Array([0, 1, 128, 255, 10])
  const encrypted = await encryption.encryptUpload(session, path, plaintext)
  const calls = { restored: [], derived: [], freed: 0 }
  const recoveredKeys = {
    scopes: ['/priv/template/attachments/'],
    async deriveCryptoKeyForPath(value) {
      calls.derived.push(value)
      return key
    },
    free() {
      calls.freed++
    },
  }
  const store = {
    async restoreEncryptionKeys(id) {
      calls.restored.push(id)
      return recoveredKeys
    },
  }
  return {
    plaintext,
    encrypted,
    file: new globalThis.File([encrypted], name),
    store,
    recoveredKeys,
    calls,
    key,
  }
}

test('saved browser keys recover binary contents locally without a session or network', async (t) => {
  const { file, store, calls, plaintext } = await fixture()
  const network = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Offline recovery must not use the network')
  })
  const recovered = await recovery.recoverEncryptedUpload(store, recordId, owner, file)
  assert.deepEqual(recovered.bytes, plaintext)
  assert.equal(recovered.filename, 'original-file.bin')
  assert.deepEqual(calls.restored, [recordId], 'recover only the exact selected saved record')
  assert.deepEqual(calls.derived, [path], 'derive only the original private file path')
  assert.equal(calls.freed, 1)
  assert.equal(network.mock.callCount(), 0)
})

test('recovery authenticates the original filename, account, and ciphertext', async () => {
  const { file, store, encrypted, calls } = await fixture()
  await assert.rejects(
    recovery.recoverEncryptedUpload(store, recordId, 'another-account', file),
    /Could not decrypt/,
  )
  await assert.rejects(
    recovery.recoverEncryptedUpload(
      store,
      recordId,
      owner,
      new globalThis.File([encrypted], 'renamed.pubkyenc'),
    ),
    /Could not decrypt/,
  )
  const changed = new Uint8Array(encrypted)
  changed[changed.length - 1] ^= 1
  await assert.rejects(
    recovery.recoverEncryptedUpload(store, recordId, owner, new globalThis.File([changed], name)),
    /Could not decrypt/,
  )
  assert.equal(calls.freed, 3, 'failed authentication releases each recovered bundle')
})

test('unsupported envelopes free recovered keys and invalid filenames never recover keys', async () => {
  const { store, calls } = await fixture()
  for (const bytes of [new Uint8Array(), new Uint8Array(100)]) {
    await assert.rejects(
      recovery.recoverEncryptedUpload(store, recordId, owner, new globalThis.File([bytes], name)),
      /not a supported encrypted upload/,
    )
  }
  assert.equal(calls.freed, 2)
  for (const invalidName of ['plain.txt', '../private.pubkyenc', 'nested/file.pubkyenc']) {
    await assert.rejects(
      recovery.recoverEncryptedUpload(
        store,
        recordId,
        owner,
        new globalThis.File(['invalid'], invalidName),
      ),
      /original .pubkyenc filename|Invalid uploaded filename/,
    )
  }
  assert.equal(calls.restored.length, 2)
})

test('size limits reject local files before reading or recovering their keys', async () => {
  const { store, calls } = await fixture()
  let reads = 0
  const file = {
    name,
    size: data.MAX_FILE_BYTES + 1,
    async arrayBuffer() {
      reads++
      throw new Error('An oversized file must not be read')
    },
  }
  await assert.rejects(recovery.recoverEncryptedUpload(store, recordId, owner, file), /up to 5 MiB/)
  assert.equal(reads, 0)
  assert.deepEqual(calls.restored, [])
})

test('missing, declined, and unavailable saved keys remain explicit recovery failures', async () => {
  const { file, store, calls, recoveredKeys } = await fixture()
  store.restoreEncryptionKeys = async () => undefined
  await assert.rejects(
    recovery.recoverEncryptedUpload(store, recordId, owner, file),
    /no encryption keys/,
  )
  store.restoreEncryptionKeys = async () => ({
    ...recoveredKeys,
    scopes: [],
    async deriveCryptoKeyForPath() {
      throw new Error('No approved key scope covers this file')
    },
  })
  await assert.rejects(
    recovery.recoverEncryptedUpload(store, recordId, owner, file),
    /No approved key scope/,
  )
  assert.equal(calls.freed, 1)
  store.restoreEncryptionKeys = async () => {
    throw new Error('Saved record is unavailable')
  }
  await assert.rejects(
    recovery.recoverEncryptedUpload(store, recordId, owner, file),
    /Saved record is unavailable/,
  )
})

test('session changes before and during key recovery prevent decryption and free returned keys', async () => {
  const { file, store, calls, recoveredKeys } = await fixture()
  await assert.rejects(
    recovery.recoverEncryptedUpload(store, recordId, owner, file, () => false),
    /active session changed/,
  )
  assert.deepEqual(calls.restored, [])
  let current = true
  store.restoreEncryptionKeys = async () => {
    current = false
    return recoveredKeys
  }
  await assert.rejects(
    recovery.recoverEncryptedUpload(store, recordId, owner, file, () => current),
    /active session changed/,
  )
  assert.equal(calls.freed, 1)
  assert.deepEqual(calls.derived, [])
})

test('stale asynchronous decryption clears plaintext and releases the recovered bundle', async (t) => {
  const { file, store, calls } = await fixture()
  let current = true
  let plaintext
  const decrypt = globalThis.crypto.subtle.decrypt.bind(globalThis.crypto.subtle)
  t.mock.method(globalThis.crypto.subtle, 'decrypt', async (...args) => {
    plaintext = await decrypt(...args)
    current = false
    return plaintext
  })
  await assert.rejects(
    recovery.recoverEncryptedUpload(store, recordId, owner, file, () => current),
    /active storage view changed/,
  )
  assert.deepEqual(new Uint8Array(plaintext), new Uint8Array(5))
  assert.equal(calls.freed, 1)
})

test('credential refresh failures remain distinct from requested-operation failures', () => {
  const error = Object.assign(new Error('Refresh denied'), { name: 'CredentialRefreshError' })
  assert.match(html.formatError(error), /Session credentials could not be refreshed/)
  assert.match(html.formatError(error), /Refresh denied/)
  assert.match(
    html.formatError(error),
    /Sign out and authorize again if access was revoked or expired/,
  )
})

test('transport errors describe uncertain write outcomes without automatically retrying', () => {
  for (const reason of ['Timeout', 'Connection', 'Body']) {
    const error = Object.assign(new Error('Request interrupted'), {
      name: 'RequestError',
      data: { reason },
    })
    const message = html.formatError(error)
    assert.match(message, /Request interrupted/)
    assert.match(message, /result may be unknown; check the file before repeating a write/)
  }
  for (const [reason, suffix] of [
    ['Decode', /server response could not be decoded/],
    ['InvalidRequest', /Check the request parameters/],
  ]) {
    assert.match(
      html.formatError(
        Object.assign(new Error('Request failed'), { name: 'RequestError', data: { reason } }),
      ),
      suffix,
    )
  }
  assert.equal(
    html.formatError(
      Object.assign(new Error('Quota exceeded'), {
        name: 'RequestError',
        data: { reason: 'Http', statusCode: 507 },
      }),
    ),
    'Quota exceeded',
  )
})
