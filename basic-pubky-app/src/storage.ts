import { PubkyResource } from '@synonymdev/pubky'
import type { Path, ResourceStats, Session, StorageLock } from '@synonymdev/pubky'
import { APP_PATHS, type StorageSpace } from './config'
import { downloadBytes } from './storage-download'

export interface AppFile {
  id: string
  title: string
  body: string
  updatedAt: string
  metadata?: ResourceStats
}

/** Safe editor state. The SDK lock token stays inside this module. */
export interface FileLock {
  readonly id: string
  readonly space: StorageSpace
  readonly expiresAt: number
}

interface LockState {
  session: Session
  sdkLock: StorageLock
  expiresAt: number
  active: boolean
  pending: Set<Promise<unknown>>
  release?: Promise<void>
}

const locks = new WeakMap<FileLock, LockState>()
const LOCK_SECONDS = 60

interface FileInput {
  id?: string
  title: string
  body: string
}

export async function listFiles(session: Session, space: StorageSpace) {
  const urls = await listFileUrls(session, space)
  const directory = `${APP_PATHS[space]}files/`
  const ids = urls
    .filter((url) => url.endsWith('.json'))
    .flatMap((url) => {
      const resource = PubkyResource.parse(url)
      const id = idFromPath(resource.path)
      if (
        resource.owner.z32() !== session.info.publicKey.z32() ||
        resource.path !== `${directory}${id}.json`
      ) {
        throw new Error('The homeserver returned a file outside the selected folder.')
      }
      // Other apps or manual uploads may use filenames this template does not support.
      return isFileId(id) ? [id] : []
    })
  const files = await Promise.all(ids.map((id) => readFile(session, filePath(space, id), id)))

  return files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

const LIST_PAGE_SIZE = 50

async function listFileUrls(session: Session, space: StorageSpace) {
  try {
    const urls: string[] = []
    let cursor: string | null = null

    // The last listed URL is the next cursor; session.storage.list does not return a separate cursor field.
    while (true) {
      const batch = await session.storage.list(
        `${APP_PATHS[space]}files/` as Path,
        cursor,
        true,
        LIST_PAGE_SIZE,
        true,
      )
      if (batch.length === 0) break

      const nextCursor = batch[batch.length - 1]
      if (!nextCursor || nextCursor === cursor) break

      urls.push(...batch)
      if (batch.length < LIST_PAGE_SIZE) break
      cursor = nextCursor
    }

    return urls
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

export async function saveFile(
  session: Session,
  space: StorageSpace,
  input: FileInput,
  lock?: FileLock,
) {
  const id = input.id || crypto.randomUUID()
  const path = filePath(space, id)
  const file: AppFile = {
    id,
    title: input.title.trim() || 'Untitled',
    body: input.body,
    updatedAt: new Date().toISOString(),
  }

  if (input.id || lock) {
    if (!lock) throw new Error('Lock and reopen this file before saving changes.')
    await withLock(session, space, id, lock, (sdkLock) =>
      // The SDK has no putJsonLocked; JSON remains readable with getJson.
      session.storage.putTextLocked(sdkLock, JSON.stringify(file)),
    )
  } else {
    await session.storage.putJson(path, file)
  }
  return file
}

export async function deleteFile(
  session: Session,
  space: StorageSpace,
  id: string,
  heldLock?: FileLock,
) {
  filePath(space, id)
  const lock = heldLock || (await acquireFileLock(session, space, id)).lock
  try {
    await withLock(session, space, id, lock, (sdkLock) => session.storage.deleteLocked(sdkLock))
  } finally {
    if (!heldLock) await releaseFileLock(lock)
  }
}

export async function acquireFileLock(session: Session, space: StorageSpace, id: string) {
  const path = filePath(space, id)
  let sdkLock: StorageLock
  try {
    sdkLock = await session.storage.lock(path, LOCK_SECONDS)
  } catch (error) {
    throw lockError(error)
  }
  const state: LockState = {
    session,
    sdkLock,
    expiresAt: Date.now() + sdkLock.timeoutSeconds * 1000,
    active: true,
    pending: new Set(),
  }
  const lock: FileLock = Object.freeze({
    id,
    space,
    get expiresAt() {
      return state.expiresAt
    },
  })
  locks.set(lock, state)
  try {
    // Read after acquiring: a previously displayed note may already be stale.
    const file = await withLock(session, space, id, lock, () => readFile(session, path, id))
    return { file, lock }
  } catch (error) {
    await releaseFileLock(lock).catch(() => undefined)
    throw error
  }
}

export async function renewFileLock(
  session: Session,
  space: StorageSpace,
  id: string,
  lock: FileLock,
) {
  await withLock(session, space, id, lock, async (sdkLock) => {
    await session.storage.refreshLock(sdkLock, LOCK_SECONDS)
    locks.get(lock)!.expiresAt = Date.now() + sdkLock.timeoutSeconds * 1000
  })
}

export function releaseFileLock(lock: FileLock): Promise<void> {
  const state = locks.get(lock)
  if (!state) return Promise.reject(new Error('Unknown file lock.'))
  if (state.release) return state.release
  state.active = false
  state.release = (async () => {
    // Cleanup may run while a write is pending after a session or view change.
    await Promise.allSettled([...state.pending])
    try {
      await state.session.storage.unlock(state.sdkLock)
    } catch (error) {
      // Expired locks are already released server-side.
      if (![409, 412].includes(statusCode(error) ?? 0)) throw lockError(error)
    } finally {
      state.sdkLock.free()
    }
  })()
  return state.release
}

async function withLock<T>(
  session: Session,
  space: StorageSpace,
  id: string,
  lock: FileLock,
  operation: (sdkLock: StorageLock) => Promise<T>,
) {
  const state = locks.get(lock)
  if (
    !state ||
    state.session !== session ||
    lock.space !== space ||
    lock.id !== id ||
    state.sdkLock.path !== filePath(space, id)
  )
    throw new Error('The lock does not belong to this session and file.')
  if (!state.active || Date.now() >= state.expiresAt) {
    throw new Error(
      'The file lock expired or was released. Lock and reopen the file before continuing.',
    )
  }
  const pending = Promise.resolve().then(() => operation(state.sdkLock))
  state.pending.add(pending)
  try {
    return await pending
  } catch (error) {
    if (statusCode(error) === 412) state.active = false
    throw lockError(error)
  } finally {
    state.pending.delete(pending)
  }
}

function lockError(error: unknown) {
  switch (statusCode(error)) {
    case 423:
      return new Error('Another editor holds this file lock. Try again after it is released.')
    case 405:
      return new Error('This homeserver does not support file locks. Upgrade it to edit safely.')
    case 412:
      return new Error(
        'The file lock was lost. Lock and reopen the file to read its latest contents.',
      )
    default:
      return error
  }
}

export function publicFileAddress(session: Session, id: string) {
  return `pubky://${session.info.publicKey.z32()}${filePath('public', id)}`
}

export async function downloadFile(
  session: Session,
  space: StorageSpace,
  id: string,
  isCurrent: () => boolean = () => true,
) {
  const bytes = await session.storage.getBytes(filePath(space, id))
  if (!isCurrent()) return
  downloadBytes(bytes, `${id}.json`)
}

export function filePath(space: StorageSpace, id: string) {
  if (!isFileId(id)) throw new Error('Invalid file ID.')
  return `${APP_PATHS[space]}files/${id}.json` as Path
}

function isFileId(id: string) {
  return /^[a-zA-Z0-9_-]+$/.test(id)
}

async function readFile(session: Session, path: Path, id: string) {
  const [data, metadata] = await Promise.all([
    session.storage.getJson(path),
    session.storage.stats(path),
  ])
  return { ...toAppFile(data, id), metadata }
}

function toAppFile(data: unknown, id: string): AppFile {
  const value = isRecord(data) ? data : {}

  return {
    // The filename is authoritative; JSON content must never choose a write/delete path.
    id,
    title: String(value.title || 'Untitled'),
    body: String(value.body || ''),
    updatedAt: String(value.updatedAt || ''),
  }
}

function idFromPath(path: string) {
  return (path.split('/').pop() || '').replace(/\.json$/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNotFound(error: unknown) {
  return statusCode(error) === 404
}

function statusCode(error: unknown) {
  return isRecord(error) && isRecord(error.data) && typeof error.data.statusCode === 'number'
    ? error.data.statusCode
    : undefined
}
