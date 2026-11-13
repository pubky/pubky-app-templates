import type { BrowserSessionStore } from '@synonymdev/pubky'
import type { StorageSpace } from './config'
import { decryptWithKeys, downloadedUploadName, isEncryptedUpload } from './encryption'
import { MAX_FILE_BYTES, uploadedFilePath } from './storage-tools-data'

/** Recover file contents locally, without restoring a session or making a network request. */
export async function recoverEncryptedUpload(
  store: BrowserSessionStore,
  recordId: string,
  expectedOwner: string,
  file: File,
  isCurrent: () => boolean = () => true,
  space: StorageSpace = 'private',
  originalStoredFilename = file.name,
) {
  if (!isEncryptedUpload(space, originalStoredFilename)) {
    throw new Error('Enter the original .pubkyenc filename shown in the Files list.')
  }
  // The browser may rename a download; derive only from its original stored name.
  const path = uploadedFilePath(space, originalStoredFilename)
  if (file.size > MAX_FILE_BYTES) throw new Error('This template handles files up to 5 MiB.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!isCurrent()) throw new Error('The active session changed.')
  // The SDK authenticates the stored approval, identity and exact grant for this ID.
  const keys = await store.restoreEncryptionKeys(recordId)
  if (!keys)
    throw new Error('This saved session has no encryption keys. Authorize encryption first.')
  try {
    if (!isCurrent()) throw new Error('The active session changed.')
    return {
      bytes: await decryptWithKeys(keys, path, bytes, expectedOwner, isCurrent),
      filename: downloadedUploadName(space, originalStoredFilename),
    }
  } finally {
    keys.free()
  }
}
