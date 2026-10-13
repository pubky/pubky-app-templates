// Keep real SDK parsing and types. Only replace the network/session-store boundary.
export * from 'pubky-test-real'
import { PublicKey } from 'pubky-test-real'

const publicKey = PublicKey.from('pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo')
const accountId = 'browser-test:template'
const state = (globalThis.__pubkyTest = {
  files: globalThis.__pubkySeed?.files ?? {},
  directories: globalThis.__pubkySeed?.directories ?? [],
  failures: {},
  calls: [],
  pendingLists: [],
  streamCanceled: false,
  streamBytes: 0,
  publicFile: { body: 'A public file', metadata: { contentType: 'text/plain' } },
})

function call(method, path) {
  state.calls.push({ method, path })
  const failure = state.failures[`${method}:${path}`] || state.failures[method]
  delete state.failures[`${method}:${path}`]
  delete state.failures[method]
  if (failure) throw new Error(failure)
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
  async delete(path) {
    call('delete', path)
    delete state.files[path]
  },
  async lock(path) {
    call('lock', path)
    return { path, timeoutSeconds: 60, free() {} }
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

const session = {
  info: { publicKey, capabilities: ['/pub/template/:rw', '/priv/template/:rw'] },
  storage,
  async signout() {
    call('signout')
  },
}
const record = () => ({
  id: accountId,
  publicKey: publicKey.toString(),
  clientId: 'template',
  free() {},
})
const authFlow = () => ({
  authorizationUrl: 'pubkyring://authorize?test=browser-fixture',
  saveDelegated: () => 'browser-test-flow',
  awaitApproval: () =>
    new Promise((resolve) => {
      state.approveSignIn = () => resolve(session)
    }),
  free() {},
})
const client = {
  browserSessionStore: {
    async list() {
      call('sessions.list')
      return [record()]
    },
    async restore() {
      call('sessions.restore')
      return session
    },
    async save() {
      call('sessions.save')
      return record()
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

export class Pubky {
  constructor() {
    throw new Error('Browser tests must use testnet.')
  }

  static testnet() {
    return client
  }
}
