import type { Event as PubkyEvent, Session } from '@synonymdev/pubky'
import { APP_PATHS, MAX_EVENT_BYTES, type StorageSpace } from './config'
import { pubky } from './pubky'

export interface AppEvent {
  type: string
  path: string
  cursor: string
  contentHash?: string
}

export interface AppEventStream {
  done: Promise<void>
  stop: () => Promise<void>
}

export async function startAppEventStream(
  session: Session,
  space: StorageSpace,
  onEvent: (event: AppEvent) => void,
): Promise<AppEventStream> {
  const builder = pubky
    .eventStreamForUser(session.info.publicKey, null)
    .path(APP_PATHS[space])
    .maxEventBytes(MAX_EVENT_BYTES) // optional; SSE payload sizes are uncapped by default.
    .live()

  // Public events work without a session. Private events require owner authorization.
  const authorizedBuilder = space === 'private' ? builder.session(session) : builder
  const eventStream = await authorizedBuilder.subscribe()

  const reader = eventStream.getReader()
  let stopped = false

  async function read() {
    try {
      while (!stopped) {
        const { done, value } = await reader.read()
        if (done) return

        onEvent(toAppEvent(value as PubkyEvent))
      }
    } finally {
      reader.releaseLock()
    }
  }

  return {
    done: read(),
    stop: async () => {
      if (stopped) return
      stopped = true
      await reader.cancel()
    },
  }
}

function toAppEvent(event: PubkyEvent): AppEvent {
  return {
    type: event.eventType,
    path: event.resource.path,
    cursor: event.cursor,
    contentHash: event.contentHash,
  }
}
