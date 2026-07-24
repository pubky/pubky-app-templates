import { PubkyResource } from '@synonymdev/pubky'
import type { Path, Session } from '@synonymdev/pubky'
import { APP_PATH } from './config'

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

const FILES_DIR = `${APP_PATH}files/` as Path

export async function listFiles(session: Session) {
  const urls = await listFileUrls(session)
  const files = await Promise.all(
    urls
      .filter((url) => url.endsWith('.json'))
      .map((url) => readFile(session, PubkyResource.parse(url).path as Path)),
  )

  return files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

async function listFileUrls(session: Session) {
  try {
    return await session.storage.list(FILES_DIR, null, true, 50, true)
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

export async function saveFile(session: Session, input: FileInput) {
  const id = input.id || crypto.randomUUID()
  const file: AppFile = {
    id,
    title: input.title.trim() || 'Untitled',
    body: input.body,
    updatedAt: new Date().toISOString(),
  }

  await session.storage.putJson(filePath(id), file)
  return file
}

export async function deleteFile(session: Session, id: string) {
  await session.storage.delete(filePath(id))
}

export function filePath(id: string) {
  return `${FILES_DIR}${id}.json` as Path
}

async function readFile(session: Session, path: Path) {
  const data = await session.storage.getJson(path)
  return toAppFile(data, idFromPath(path))
}

function toAppFile(data: unknown, fallbackId: string): AppFile {
  const value = isRecord(data) ? data : {}

  return {
    id: String(value.id || fallbackId),
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
