import type { Session } from '@synonymdev/pubky'
import { APP_PATHS, type StorageSpace } from './config'

export function hasStorageAccess(session: Session, space: StorageSpace) {
  return ['r', 'w'].every((action) =>
    session.info.capabilities.some((capability) => {
      const separator = capability.lastIndexOf(':')
      const scope = capability.slice(0, separator)
      const actions = capability.slice(separator + 1)
      const path = APP_PATHS[space]
      return (
        separator > 0 &&
        actions.includes(action) &&
        (scope.endsWith('/') ? path.startsWith(scope) : path === scope)
      )
    }),
  )
}

export function requireStorageAccess(session: Session, space: StorageSpace) {
  if (!hasStorageAccess(session, space)) {
    throw new Error(
      `This session does not have read and write access to ${APP_PATHS[space]}. ` +
        'Sign out and authorize the app again to grant access to both folders.',
    )
  }
}
