import { PubkyResource } from '@synonymdev/pubky'
import type { Address, Path, PublicStorage, ResourceStats, Session } from '@synonymdev/pubky'
import { requireStorageAccess } from './access'
import { APP_PATHS, type StorageSpace } from './config'

export const MAX_FILE_BYTES = 5 * 1024 * 1024
const PAGE_SIZE = 50

export interface UploadedFile {
  name: string
  metadata?: ResourceStats
}

// This template keeps uploads in its existing attachments/ folder; Pubky treats it as a normal path.
export function uploadedFilePath(space: StorageSpace, name: string): Path {
  if (!isUploadedFileName(name)) {
    throw new Error('Invalid uploaded filename.')
  }
  return `${APP_PATHS[space]}attachments/${name}`
}

export async function listUploadedFiles(
  session: Session,
  space: StorageSpace,
  isCurrent: () => boolean = () => true,
) {
  requireStorageAccess(session, space)
  const directory = `${APP_PATHS[space]}attachments/` as Path
  const names: string[] = []
  let cursor: string | null = null
  try {
    while (true) {
      requireCurrent(isCurrent)
      const urls = await session.storage.list(directory, cursor, false, PAGE_SIZE, true)
      for (const url of urls) {
        const resource = PubkyResource.parse(url)
        const name = resource.path.slice(directory.length)
        if (
          resource.owner.z32() !== session.info.publicKey.z32() ||
          !resource.path.startsWith(directory) ||
          name.includes('/')
        ) {
          throw new Error('The homeserver returned a file outside the selected folder.')
        }
        if (isUploadedFileName(name)) names.push(name)
      }
      const next = urls.at(-1)
      if (!next || next === cursor || urls.length < PAGE_SIZE) break
      cursor = next
    }
  } catch (error) {
    if (statusCode(error) !== 404) throw error
  }
  requireCurrent(isCurrent)
  return Promise.all(
    [...new Set(names)].map(async (name): Promise<UploadedFile> => ({
      name,
      metadata: await session.storage.stats(uploadedFilePath(space, name)),
    })),
  )
}

export async function uploadFileBytes(
  session: Session,
  space: StorageSpace,
  file: File,
  isCurrent: () => boolean = () => true,
) {
  requireStorageAccess(session, space)
  checkByteLength(file.size)
  const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'file'
  const name = `${crypto.randomUUID()}-${filename}`
  const bytes = new Uint8Array(await file.arrayBuffer())
  checkByteLength(bytes.byteLength)
  requireCurrent(isCurrent)
  await session.storage.putBytes(uploadedFilePath(space, name), bytes)
  return name
}

export async function readUploadedFile(
  session: Session,
  space: StorageSpace,
  name: string,
  isCurrent: () => boolean = () => true,
) {
  requireStorageAccess(session, space)
  const path = uploadedFilePath(space, name)
  const metadata = await session.storage.stats(path)
  if (!metadata) throw new Error('This file no longer exists.')
  if (metadata.contentLength !== undefined) checkByteLength(metadata.contentLength)
  requireCurrent(isCurrent)
  const bytes = await session.storage.getBytes(path)
  checkByteLength(bytes.byteLength)
  return bytes
}

export async function deleteUploadedFile(session: Session, space: StorageSpace, name: string) {
  requireStorageAccess(session, space)
  await session.storage.delete(uploadedFilePath(space, name))
}

export function publicUploadedFileAddress(session: Session, name: string) {
  return `pubky://${session.info.publicKey.z32()}${uploadedFilePath('public', name)}`
}

/** Only canonical Pubky public resources are accepted, never arbitrary HTTP URLs. */
export function parsePublicAddress(input: string): { address: Address; filename: string } {
  const value = input.trim()
  if (
    !value.startsWith('pubky') ||
    /[?#\s]/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new Error('Enter a public Pubky file address, such as pubky://<key>/pub/app/file.json.')
  }
  const resource = PubkyResource.parse(value)
  const path = resource.path
  if (
    !path.startsWith('/pub/') ||
    path.endsWith('/') ||
    path
      .split('/')
      .slice(1)
      .some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('The public reader accepts files under /pub/ only.')
  }
  return {
    address: `pubky://${resource.owner.z32()}${path}` as Address,
    filename: path.split('/').at(-1) || 'download',
  }
}

export async function readPublicFile(
  storage: PublicStorage,
  input: string,
  isCurrent: () => boolean = () => true,
) {
  const { address, filename } = parsePublicAddress(input)
  const metadata = await storage.stats(address)
  if (!metadata) throw new Error('No public file exists at that address.')
  if (metadata.contentLength !== undefined) checkByteLength(metadata.contentLength)
  requireCurrent(isCurrent)
  // Bound the stream even if Content-Length is missing or incorrect.
  const response = await storage.get(address)
  const bytes = await readLimitedResponse(response, isCurrent)
  return { address, filename, metadata, bytes }
}

export async function readLimitedResponse(
  response: Response,
  isCurrent: () => boolean = () => true,
) {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      requireCurrent(isCurrent)
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      checkByteLength(length)
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function isUploadedFileName(name: string) {
  return /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,179}$/.test(name)
}

function requireCurrent(isCurrent: () => boolean) {
  if (!isCurrent()) throw new Error('The active storage view changed.')
}

function checkByteLength(length: number) {
  if (!Number.isFinite(length) || length < 0 || length > MAX_FILE_BYTES) {
    throw new Error('This template handles files up to 5 MiB.')
  }
}

function statusCode(error: unknown) {
  if (typeof error !== 'object' || error === null || !('data' in error)) return undefined
  const data = error.data
  return typeof data === 'object' && data !== null && 'statusCode' in data
    ? data.statusCode
    : undefined
}
