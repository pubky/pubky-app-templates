import { PubkyResource } from '@synonymdev/pubky'
import type { Path, Session } from '@synonymdev/pubky'
import { APP_PATHS, type StorageSpace } from './config'

export interface AppFile {
  id: string
  title: string
  body: string
  updatedAt: string
}

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

export async function saveFile(session: Session, space: StorageSpace, input: FileInput) {
  const id = input.id || crypto.randomUUID()
  const file: AppFile = {
    id,
    title: input.title.trim() || 'Untitled',
    body: input.body,
    updatedAt: new Date().toISOString(),
  }

  await session.storage.putJson(filePath(space, id), file)
  return file
}

export async function deleteFile(session: Session, space: StorageSpace, id: string) {
  await session.storage.delete(filePath(space, id))
}

export function filePath(space: StorageSpace, id: string) {
  if (!isFileId(id)) throw new Error('Invalid file ID.')
  return `${APP_PATHS[space]}files/${id}.json` as Path
}

function isFileId(id: string) {
  return /^[a-zA-Z0-9_-]+$/.test(id)
}

async function readFile(session: Session, path: Path, id: string) {
  const data = await session.storage.getJson(path)
  return toAppFile(data, id)
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
  return isRecord(error) && isRecord(error.data) && error.data.statusCode === 404
}
