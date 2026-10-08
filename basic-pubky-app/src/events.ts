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

export async function startAppEventStream(
  session: Session,
  space: StorageSpace,
  onEvent: (event: AppEvent) => void,
  cursor: string | null = null,
): Promise<AppEventStream> {
  // A new live view starts at the latest event. Subsequent subscriptions resume
  // after the last delivered cursor, including changes made while disconnected.
  if (!cursor) {
    const recent = await subscribe(
      eventBuilder(session, space, null).reverse().limit(1),
      (event) => {
        cursor = event.cursor
        onEvent(event)
      },
      session,
      space,
    )
    await recent.done
  }

  return subscribe(eventBuilder(session, space, cursor).live(), onEvent, session, space)
}

export function startAppEventHistory(
  session: Session,
  space: StorageSpace,
  onEvent: (event: AppEvent) => void,
  cursor: string | null = null,
): Promise<AppEventStream> {
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

async function subscribe(
  builder: EventStreamBuilder,
  onEvent: (event: AppEvent) => void,
  session: Session,
  space: StorageSpace,
): Promise<AppEventStream> {
  const eventStream = await builder.subscribe()

  const reader = eventStream.getReader()
  let stopped = false
  let finished = false

  async function read() {
    try {
      while (!stopped) {
        const { done, value } = await reader.read()
        if (done) return
        if (stopped) return

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
      await reader.cancel()
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
