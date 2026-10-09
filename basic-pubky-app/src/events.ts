import type { Event as PubkyEvent, EventStreamBuilder, Session } from '@synonymdev/pubky'
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

export const EVENT_HISTORY_LIMIT = 12

export function startAppEventStream(
  session: Session,
  space: StorageSpace,
  onEvent: (event: AppEvent) => void,
  cursor: string | null = null,
): AppEventStream {
  let stopped = false
  let active: AppEventStream | undefined

  async function read() {
    // A new live view starts at the latest event. Subsequent subscriptions resume
    // after the last delivered cursor, including changes made while disconnected.
    if (!cursor) {
      active = subscribe(
        eventBuilder(session, space, null).reverse().limit(1),
        (event) => {
          cursor = event.cursor
          onEvent(event)
        },
        session,
        space,
      )
      await active.done
    }

    if (stopped) return
    active = subscribe(eventBuilder(session, space, cursor).live(), onEvent, session, space)
    await active.done
  }

  // Return cancellation before either subscription or the latest-event seed finishes.
  return {
    done: read(),
    stop: async () => {
      stopped = true
      await active?.stop()
    },
  }
}

export function startAppEventHistory(
  session: Session,
  space: StorageSpace,
  onEvent: (event: AppEvent) => void,
  cursor: string | null = null,
): AppEventStream {
  return subscribe(
    eventBuilder(session, space, cursor).reverse().limit(EVENT_HISTORY_LIMIT),
    onEvent,
    session,
    space,
  )
}

function eventBuilder(session: Session, space: StorageSpace, cursor: string | null) {
  const builder = pubky
    .eventStreamForUser(session.info.publicKey, cursor)
    .path(APP_PATHS[space])
    .maxEventBytes(MAX_EVENT_BYTES) // optional; SSE payload sizes are uncapped by default.

  // Public events work without a session. Private events require owner authorization.
  return space === 'private' ? builder.session(session) : builder
}

function subscribe(
  builder: EventStreamBuilder,
  onEvent: (event: AppEvent) => void,
  session: Session,
  space: StorageSpace,
): AppEventStream {
  let reader: ReadableStreamDefaultReader<PubkyEvent> | undefined
  let stopped = false
  let finished = false

  async function read() {
    // The SDK cannot abort subscribe() itself. If stopped while it is pending,
    // cancel the resulting stream as soon as it arrives, without reading events.
    const eventStream = await builder.subscribe()
    reader = eventStream.getReader()
    try {
      while (!stopped) {
        const { done, value } = await reader.read()
        if (done) return
        if (stopped) {
          value.free()
          return
        }

        onEvent(toAppEvent(value as PubkyEvent, session, space))
      }
    } finally {
      finished = true
      // Also close the network stream if event validation or its consumer fails.
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  return {
    done: read(),
    stop: async () => {
      if (stopped || finished) return
      stopped = true
      await reader?.cancel()
    },
  }
}

function toAppEvent(event: PubkyEvent, session: Session, space: StorageSpace): AppEvent {
  const resource = event.resource
  const owner = resource.owner
  try {
    if (
      owner.z32() !== session.info.publicKey.z32() ||
      !resource.path.startsWith(APP_PATHS[space])
    ) {
      throw new Error('The homeserver returned an event outside the selected folder.')
    }
    return {
      type: event.eventType,
      path: resource.path,
      cursor: event.cursor,
      contentHash: event.contentHash,
    }
  } finally {
    owner.free()
    resource.free()
    event.free()
  }
}
