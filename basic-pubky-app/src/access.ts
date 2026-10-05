import { resolvePubky } from '@synonymdev/pubky'
import type { Session } from '@synonymdev/pubky'
import { APP_PATHS, type StorageSpace } from './config'
import { pubky } from './pubky'
import { filePath } from './storage'

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

/** Test the server's access rules without a bearer token or ambient cookies. */
export async function testPublicAccess(session: Session, space: StorageSpace, id: string) {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(new Error('Public access test timed out. No access result was confirmed.'))
    }, 12_000)
  })

  try {
    return await Promise.race([
      (async () => {
        const url = resolvePubky(`${session.info.publicKey.toString()}${filePath(space, id)}`)
        const response = await pubky.client.fetch(url, {
          method: 'GET',
          credentials: 'omit',
          cache: 'no-store',
          signal: controller.signal,
        })
        // Only the HTTP status is needed; do not load or display file contents.
        await response.body?.cancel()
        return response.status
      })(),
      deadline,
    ])
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}
