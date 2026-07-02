import { PubkyResource } from '@synonymdev/pubky'
import type { Path, Session } from '@synonymdev/pubky'
import { APP_PATH } from './pubky'

export interface AppRecord {
  id: string
  title: string
  body: string
  updatedAt: string
}

interface RecordInput {
  id?: string
  title: string
  body: string
}

const RECORDS_DIR = `${APP_PATH}records/` as Path

export async function listRecords(session: Session) {
  const urls = await listRecordUrls(session)
  const records = await Promise.all(
    urls
      .filter((url) => url.endsWith('.json'))
      .map(async (url) => readRecord(session, PubkyResource.parse(url).path as Path)),
  )

  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

async function listRecordUrls(session: Session) {
  try {
    return await session.storage.list(RECORDS_DIR, null, true, 50, true)
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

export async function saveRecord(session: Session, input: RecordInput) {
  const id = input.id || crypto.randomUUID()
  const record: AppRecord = {
    id,
    title: input.title.trim() || 'Untitled',
    body: input.body,
    updatedAt: new Date().toISOString(),
  }

  await session.storage.putJson(recordPath(id), record)
  return record
}

export async function deleteRecord(session: Session, id: string) {
  await session.storage.delete(recordPath(id))
}

function recordPath(id: string) {
  return `${RECORDS_DIR}${id}.json` as Path
}

async function readRecord(session: Session, path: Path) {
  const data = await session.storage.getJson(path)
  return toAppRecord(data, idFromPath(path))
}

function toAppRecord(data: unknown, fallbackId: string): AppRecord {
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
  return (
    isRecord(error) &&
    isRecord(error.data) &&
    error.data.statusCode === 404
  )
}
