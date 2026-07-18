import type { Event as PubkyEvent, Session } from '@synonymdev/pubky'
import { APP_PATH } from './config'
import { pubky } from './pubky'

export interface AppStreamEvent {
  type: string
  path: string
  cursor: string
}

export async function startAppEventStream(
  session: Session,
  onEvent: (event: AppStreamEvent) => void,
  onError: (error: unknown) => void,
) {
  const stream = await pubky
    .eventStreamForUser(session.info.publicKey, null)
    .path(APP_PATH)
    .live()
    .subscribe()

  const reader = stream.getReader()
  let stopped = false

  async function read() {
    while (!stopped) {
      const { done, value } = await reader.read()
      if (done) return

      onEvent(toAppStreamEvent(value as PubkyEvent))
    }
  }

  void read().catch((error: unknown) => {
    if (!stopped) onError(error)
  })

  return async () => {
    stopped = true
    await reader.cancel()
  }
}

function toAppStreamEvent(event: PubkyEvent): AppStreamEvent {
  return {
    type: event.eventType,
    path: event.resource.path,
    cursor: event.cursor,
  }
}
