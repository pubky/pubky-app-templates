import type { EncryptionKeys, Session } from '@synonymdev/pubky'
import { APP_PATHS, type StorageSpace } from './config'

export function hasStorageAccess(session: Session, space: StorageSpace, actions = 'rw') {
  return hasCapability(session, APP_PATHS[space], actions)
}

/** Test an approved capability without widening a file scope into a directory. */
export function hasCapability(session: Session, path: string, actions: string) {
  const capabilities = session.info.capabilities
  return [...actions].every((action) =>
    capabilities.some((capability) => {
      const separator = capability.lastIndexOf(':')
      const scope = capability.slice(0, separator)
      const actions = capability.slice(separator + 1)
      return (
        separator > 0 &&
        actions.includes(action) &&
        (scope.endsWith('/') ? path.startsWith(scope) : path === scope)
      )
    }),
  )
}

export function hasAccountAccess(session: Session) {
  return hasCapability(session, '/', 'r')
}

/** A storage capability alone does not deliver encryption keys. */
export function encryptionScopes(session: Session) {
  const grant = session.grant
  let keys: EncryptionKeys | undefined
  try {
    keys = grant?.encryptionKeys
    return keys ? [...keys.scopes] : []
  } finally {
    keys?.free()
    grant?.free()
  }
}

export function hasEncryptionAccess(session: Session, space: StorageSpace) {
  const path = `${APP_PATHS[space]}attachments/`
  return encryptionScopes(session).some((scope) => scope.endsWith('/') && path.startsWith(scope))
}

export function requireStorageAccess(session: Session, space: StorageSpace, actions = 'rw') {
  if (!hasStorageAccess(session, space, actions)) {
    throw new Error(
      `This session does not have ${actions === 'r' ? 'read' : 'read and write'} access to ${APP_PATHS[space]}. ` +
        'Choose an approved folder, or authorize the app again to grant access.',
    )
  }
}
