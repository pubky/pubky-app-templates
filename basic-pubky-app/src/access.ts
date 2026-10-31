import type { Session } from '@synonymdev/pubky'
import { APP_PATHS, type StorageSpace } from './config'

export function hasStorageAccess(session: Session, space: StorageSpace, actions = 'rw') {
  const path = APP_PATHS[space]
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

export function requireStorageAccess(session: Session, space: StorageSpace, actions = 'rw') {
  if (!hasStorageAccess(session, space, actions)) {
    throw new Error(
      `This session does not have ${actions === 'r' ? 'read' : 'read and write'} access to ${APP_PATHS[space]}. ` +
        'Choose an approved folder, or sign out and authorize the app again to grant access.',
    )
  }
}
