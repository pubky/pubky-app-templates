import type { EncryptionKeys, Path, Session } from '@synonymdev/pubky'
import { APP_PATHS, type StorageSpace } from './config'

export const ENCRYPTED_FILE_SUFFIX = '.pubkyenc'
// Template envelope v1: magic/version, 96-bit IV, AES-GCM ciphertext and 128-bit tag.
const MAGIC = new Uint8Array([80, 85, 66, 75, 89, 69, 78, 1])
const IV_BYTES = 12
export const ENCRYPTION_OVERHEAD_BYTES = MAGIC.length + IV_BYTES + 16

export function isEncryptedUpload(space: StorageSpace, name: string) {
  return (space === 'public' || space === 'private') && name.endsWith(ENCRYPTED_FILE_SUFFIX)
}

export function downloadedUploadName(space: StorageSpace, name: string) {
  return isEncryptedUpload(space, name) ? name.slice(0, -ENCRYPTED_FILE_SUFFIX.length) : name
}

export async function encryptUpload(
  session: Session,
  path: Path,
  bytes: Uint8Array,
  isCurrent: () => boolean = () => true,
) {
  requireCurrent(isCurrent)
  const key = await deriveUploadKey(session, path)
  requireCurrent(isCurrent)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const plaintext = new Uint8Array(bytes)
  let encrypted: ArrayBuffer
  try {
    encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: context(session, path), tagLength: 128 },
      key,
      plaintext,
    )
  } finally {
    plaintext.fill(0)
  }
  requireCurrent(isCurrent)
  const envelope = new Uint8Array(MAGIC.length + iv.length + encrypted.byteLength)
  envelope.set(MAGIC)
  envelope.set(iv, MAGIC.length)
  envelope.set(new Uint8Array(encrypted), MAGIC.length + iv.length)
  return envelope
}

export async function decryptUpload(
  session: Session,
  path: Path,
  envelope: Uint8Array,
  isCurrent: () => boolean = () => true,
) {
  requireCurrent(isCurrent)
  validateEnvelope(envelope)
  const key = await deriveUploadKey(session, path)
  requireCurrent(isCurrent)
  return decryptWithKey(key, path, envelope, session.info.publicKey.z32(), isCurrent)
}

/** The caller owns the recovered bundle and must free it after this operation. */
export async function decryptWithKeys(
  keys: EncryptionKeys,
  path: Path,
  envelope: Uint8Array,
  expectedOwner: string,
  isCurrent: () => boolean = () => true,
) {
  requireCurrent(isCurrent)
  validateEnvelope(envelope)
  validateUploadPath(path)
  const key = await keys.deriveCryptoKeyForPath(path)
  requireCurrent(isCurrent)
  return decryptWithKey(key, path, envelope, expectedOwner, isCurrent)
}

function validateEnvelope(envelope: Uint8Array) {
  if (
    envelope.byteLength < ENCRYPTION_OVERHEAD_BYTES ||
    !MAGIC.every((byte, index) => envelope[index] === byte)
  ) {
    throw new Error('This file is not a supported encrypted upload.')
  }
}

async function decryptWithKey(
  key: CryptoKey,
  path: Path,
  envelope: Uint8Array,
  expectedOwner: string,
  isCurrent: () => boolean,
) {
  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(envelope.slice(MAGIC.length, MAGIC.length + IV_BYTES)),
        additionalData: contextForOwner(expectedOwner, path),
        tagLength: 128,
      },
      key,
      new Uint8Array(envelope.slice(MAGIC.length + IV_BYTES)),
    )
  } catch {
    throw new Error('Could not decrypt this file. Its contents, account, path, or key differ.')
  }
  const bytes = new Uint8Array(plaintext)
  if (!isCurrent()) {
    bytes.fill(0)
    throw new Error('The active storage view changed.')
  }
  return bytes
}

async function deriveUploadKey(session: Session, path: Path) {
  validateUploadPath(path)
  const grant = session.grant
  let keys: EncryptionKeys | undefined
  try {
    keys = grant?.encryptionKeys
    if (!keys?.scopes.length) {
      throw new Error(
        'No encryption keys were approved. Sign out and authorize encryption in Pubky Ring again.',
      )
    }
    return await keys.deriveCryptoKeyForPath(path)
  } finally {
    keys?.free()
    grant?.free()
  }
}

function validateUploadPath(path: Path) {
  const directory = Object.values(APP_PATHS)
    .map((prefix) => `${prefix}attachments/`)
    .find((prefix) => path.startsWith(prefix))
  if (!directory || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(path.slice(directory.length))) {
    throw new Error('Encryption is available only for files in this app’s upload folders.')
  }
}

function context(session: Session, path: Path) {
  return contextForOwner(session.info.publicKey.z32(), path)
}

function contextForOwner(owner: string, path: Path) {
  // Bind ciphertext to its owner, canonical path, and envelope version.
  return new TextEncoder().encode(JSON.stringify(['pubky-template-upload-v1', owner, path]))
}

function requireCurrent(isCurrent: () => boolean) {
  if (!isCurrent()) throw new Error('The active storage view changed.')
}
