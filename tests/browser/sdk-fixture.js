// Keep real SDK parsing and types. Only replace the network/session-store boundary.
export * from 'pubky-test-real'
import { PublicKey } from 'pubky-test-real'

const publicKey = PublicKey.from(
  globalThis.__pubkySeed?.publicKey ?? 'pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo',
)
const accountId = 'browser-test:template'
const state = (globalThis.__pubkyTest = {
  capabilities: globalThis.__pubkySeed?.capabilities,
  files: globalThis.__pubkySeed?.files ?? {},
  directories: globalThis.__pubkySeed?.directories ?? [],
  failures: globalThis.__pubkySeed?.failures ?? {},
  persistentFailures: globalThis.__pubkySeed?.persistentFailures ?? {},
  calls: [],
  pendingLists: [],
  pendingSaves: [],
  events: [],
  subscriptions: [],
  streamCanceled: false,
  streamBytes: 0,
  publicFile: { body: 'A public file', metadata: { contentType: 'text/plain' } },
})

// Disposable non-extractable test key; production builds never import this fixture.
let contentKey
function encryptionKeys() {
  return {
    scopes: ['/priv/template/attachments/'],
    async deriveCryptoKeyForPath(path) {
      if (!path.startsWith('/priv/template/attachments/')) throw new Error('Outside test scope')
      if (state.holdDerivations) await new Promise((resolve) => (state.releaseDerivation = resolve))
      contentKey ??= globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ])
      return contentKey
    },
    free() {},
  }
}

function call(method, path) {
  state.calls.push({ method, path })
  const persisted = JSON.parse(globalThis.sessionStorage.getItem('test-failures') || '{}')
  const failure =
    state.failures[`${method}:${path}`] ||
    state.failures[method] ||
    persisted[method] ||
    state.persistentFailures[`${method}:${path}`] ||
    state.persistentFailures[method]
  delete state.failures[`${method}:${path}`]
  delete state.failures[method]
  delete persisted[method]
  globalThis.sessionStorage.setItem('test-failures', JSON.stringify(persisted))
  if (failure) {
    const error = new Error(failure.message ?? failure)
    if (failure.name) error.name = failure.name
    if (failure.statusCode) error.data = { statusCode: failure.statusCode }
    throw error
  }
}

function response(file) {
  if (!file.streamSize) return new globalThis.Response(file.body ?? new Uint8Array(file.bytes))
  state.streamCanceled = false
  state.streamBytes = 0
  return new globalThis.Response(
    new globalThis.ReadableStream({
      pull(controller) {
        if (state.streamBytes >= file.streamSize) return controller.close()
        const size = Math.min(256 * 1024, file.streamSize - state.streamBytes)
        state.streamBytes += size
        controller.enqueue(new Uint8Array(size))
      },
      cancel() {
        state.streamCanceled = true
      },
    }),
  )
}

const storage = {
  async list(directory, cursor, reverse, limit) {
    if (state.holdLists) await new Promise((resolve) => state.pendingLists.push(resolve))
    call('list', directory)
    let paths = [...Object.keys(state.files), ...state.directories].filter((path) =>
      path.startsWith(directory),
    )
    paths = [
      ...new Set(paths.map((path) => directory + path.slice(directory.length).split(/(?<=\/)/)[0])),
    ]
      .sort()
      .map((path) => `pubky://${publicKey.z32()}${path}`)
    if (reverse) paths.reverse()
    return paths.slice(
      cursor ? paths.indexOf(cursor) + 1 : 0,
      (cursor ? paths.indexOf(cursor) + 1 : 0) + limit,
    )
  },
  async stats(path) {
    call('stats', path)
    return state.files[path]?.metadata ?? (state.files[path] ? {} : undefined)
  },
  async getJson(path) {
    call('getJson', path)
    return state.files[path].json
  },
  async get(path) {
    call('get', path)
    return response(state.files[path])
  },
  async getBytes(path) {
    call('getBytes', path)
    return new Uint8Array(await response(state.files[path]).arrayBuffer())
  },
  async putJson(path, json) {
    call('putJson', path)
    state.files[path] = { json }
  },
  async putBytes(path, bytes) {
    call('putBytes', path)
    state.files[path] = { bytes: [...bytes], metadata: { contentLength: bytes.byteLength } }
  },
  async putBlob(path, blob) {
    call('putBlob', path)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    state.files[path] = { bytes: [...bytes], metadata: { contentLength: bytes.byteLength } }
  },
  async delete(path) {
    call('delete', path)
    delete state.files[path]
  },
  async lock(path) {
    call('lock', path)
    let freed = false
    return {
      get path() {
        if (freed) throw new Error('StorageLock used after free')
        return path
      },
      get timeoutSeconds() {
        if (freed) throw new Error('StorageLock used after free')
        return 60
      },
      free() {
        freed = true
      },
    }
  },
  async refreshLock(lock) {
    call('refreshLock', lock.path)
  },
  async unlock(lock) {
    call('unlock', lock.path)
  },
  async putTextLocked(lock, text) {
    call('putTextLocked', lock.path)
    state.files[lock.path] = { json: JSON.parse(text) }
  },
  async deleteLocked(lock) {
    call('deleteLocked', lock.path)
    delete state.files[lock.path]
  },
}

const savedIds = () => JSON.parse(globalThis.localStorage.getItem('test-sdk-records') || '[]')
const pendingLogoutKey = (id) => `test-sdk-pending-logout:${id}`
const recoveredLogoutKey = (id) => `test-sdk-recovered-logout:${id}`
function sessionStateError(message) {
  const error = new Error(message)
  error.name = 'ClientStateError'
  return error
}
function removeRecord(id) {
  if (!savedIds().includes(id)) return
  globalThis.localStorage.setItem(
    'test-sdk-records',
    JSON.stringify(savedIds().filter((item) => item !== id)),
  )
  globalThis.localStorage.removeItem(pendingLogoutKey(id))
  globalThis.localStorage.removeItem(recoveredLogoutKey(id))
  globalThis.dispatchEvent(
    new globalThis.CustomEvent('pubky-session-changed', { detail: { id, action: 'removed' } }),
  )
}
function sessionFor(id = accountId) {
  return {
    fixtureId: id,
    free() {},
    info: {
      publicKey,
      capabilities: state.capabilities ?? ['/pub/template/:rw', '/priv/template/:rw'],
    },
    get grant() {
      return {
        free() {},
        async createCustomPop(data) {
          call('grant.createCustomPop')
          // The test route signs with disposable Node-held keys. Real SDK verification
          // remains in the app; no signing secret is sent into the browser fixture.
          const response = await globalThis.fetch('/__test_custom_pop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          })
          if (!response.ok) throw new Error('Test proof signing failed')
          const credentials = await response.json()
          call('grant.customPopCompleted')
          return credentials
        },
        get encryptionKeys() {
          return state.declineEncryption ? undefined : encryptionKeys()
        },
      }
    },
    storage,
    async signout() {
      globalThis.localStorage.setItem(pendingLogoutKey(id), 'true')
      call('signout', id)
      removeRecord(id)
    },
  }
}
const record = (id = accountId) => ({
  id,
  publicKey: publicKey.toString(),
  clientId: 'template',
  free() {},
})
const authFlow = () => ({
  authorizationUrl: 'pubkyring://authorize?test=browser-fixture',
  saveDelegated: () => 'browser-test-flow',
  awaitApproval: () =>
    new Promise((resolve) => {
      state.approveSignIn = (id) => resolve(sessionFor(id))
    }),
  free() {},
})
const client = {
  browserSessionStore: {
    async restoreEncryptionKeys(id) {
      call('sessions.restoreEncryptionKeys', id)
      if (!savedIds().includes(id)) throw sessionStateError('Saved encryption record missing')
      return encryptionKeys()
    },
    async list() {
      call('sessions.list')
      return savedIds().map(record)
    },
    async restore(id) {
      call('sessions.restore', id)
      if (!savedIds().includes(id)) throw sessionStateError(`Stored Pubky session not found: ${id}`)
      if (globalThis.localStorage.getItem(pendingLogoutKey(id))) {
        const recovered = globalThis.localStorage.getItem(recoveredLogoutKey(id))
        if (recovered) removeRecord(id)
        throw sessionStateError(
          recovered ? 'Browser session was signed out.' : 'Browser session logout is pending.',
        )
      }
      return sessionFor(id)
    },
    async remove(id) {
      call('sessions.remove', id)
      removeRecord(id)
    },
    async save(session) {
      call('sessions.save', session.fixtureId)
      if (state.holdSaves) await new Promise((resolve) => state.pendingSaves.push(resolve))
      globalThis.localStorage.setItem(
        'test-sdk-records',
        JSON.stringify([...new Set([...savedIds(), session.fixtureId])]),
      )
      return record(session.fixtureId)
    },
    async isAvailable() {
      return true
    },
  },
  async startGrantAuthFlow() {
    call('startGrantAuthFlow')
    return authFlow()
  },
  async resumeDelegatedGrantAuthFlow() {
    return authFlow()
  },
  eventStreamForUser(key, cursor) {
    const subscription = { cursor, options: {}, canceled: false }
    const builder = {}
    for (const option of ['path', 'maxEventBytes', 'session', 'reverse', 'limit', 'live']) {
      builder[option] = (value = true) => {
        subscription.options[option] = option === 'session' ? true : value
        return builder
      }
    }
    builder.subscribe = async () => {
      call('events.subscribe', subscription.options.path)
      state.subscriptions.push(subscription)
      return new globalThis.ReadableStream({
        start(controller) {
          subscription.controller = controller
          if (subscription.options.live) return
          let events = state.events.filter((event) =>
            event.path.startsWith(subscription.options.path),
          )
          if (subscription.options.reverse) events = events.slice().reverse()
          for (const event of events.slice(0, subscription.options.limit))
            controller.enqueue(sdkEvent(event))
          controller.close()
        },
        cancel() {
          subscription.canceled = true
        },
      })
    }
    return builder
  },
  publicStorage: {
    async stats(address) {
      call('public.stats', address)
      return state.publicFile?.metadata
    },
    async get(address) {
      call('public.get', address)
      return response(state.publicFile)
    },
  },
}

function sdkEvent(event) {
  return {
    cursor: event.cursor,
    eventType: event.type ?? 'PUT',
    contentHash: event.contentHash,
    resource: { path: event.path, owner: { z32: () => publicKey.z32(), free() {} }, free() {} },
    free() {},
  }
}

state.emitEvent = (event) => {
  for (const subscription of state.subscriptions) {
    if (subscription.options.live && !subscription.canceled)
      subscription.controller.enqueue(sdkEvent(event))
  }
}

export class Pubky {
  constructor() {
    throw new Error('Browser tests must use testnet.')
  }

  static testnet() {
    return client
  }
}
