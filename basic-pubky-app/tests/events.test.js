import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath, URL } from 'node:url'
import { createServer } from 'vite'

let server
let events
let pubky
const owner = 'test-owner'
const session = { info: { publicKey: { z32: () => owner } } }

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    envFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    logLevel: 'error',
  })
  events = await server.ssrLoadModule('/src/events.ts')
  ;({ pubky } = await server.ssrLoadModule('/src/pubky.ts'))
})

after(async () => {
  await server?.close()
})

function event(cursor, path = '/pub/template/files/note.json', resourceOwner = owner) {
  return {
    cursor,
    eventType: 'PUT',
    contentHash: 'hash',
    resource: { path, owner: { z32: () => resourceOwner, free() {} }, free() {} },
    free() {},
  }
}

function finiteStream(values) {
  return new globalThis.ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value)
      controller.close()
    },
  })
}

function mockSubscriptions(t, streams) {
  const subscriptions = []
  t.mock.method(pubky, 'eventStreamForUser', (publicKey, cursor) => {
    const record = { publicKey, cursor, options: {} }
    const builder = {}
    for (const option of ['path', 'maxEventBytes', 'session', 'reverse', 'limit', 'live']) {
      builder[option] = (value = true) => {
        record.options[option] = value
        return builder
      }
    }
    builder.subscribe = async () => {
      subscriptions.push(record)
      assert.ok(streams.length, 'Unexpected extra subscription')
      return streams.shift()
    }
    return builder
  })
  return subscriptions
}

for (const space of ['public', 'private']) {
  test(`${space}: recent history is bounded, newest first, and scoped`, async (t) => {
    const path = `/${space === 'public' ? 'pub' : 'priv'}/template/files/note.json`
    const stream = finiteStream([event('22', path), event('21', path)])
    const subscriptions = mockSubscriptions(t, [stream])
    const received = []
    const history = await events.startAppEventHistory(session, space, (value) =>
      received.push(value),
    )
    await history.done
    await history.stop() // Safe even after the reader has released its lock.

    assert.deepEqual(
      received.map((value) => value.cursor),
      ['22', '21'],
    )
    assert.equal(subscriptions[0].options.reverse, true)
    assert.equal(subscriptions[0].options.live, undefined)
    assert.equal(subscriptions[0].options.limit, events.EVENT_HISTORY_LIMIT)
    assert.equal(subscriptions[0].options.path, `/${space === 'public' ? 'pub' : 'priv'}/template/`)
    assert.equal(subscriptions[0].options.maxEventBytes, 8 * 1024)
    assert.equal(subscriptions[0].options.session, space === 'private' ? session : undefined)
    assert.equal(stream.locked, false)
  })
}

test('a new live stream seeds only the latest event and follows its cursor', async (t) => {
  const subscriptions = mockSubscriptions(t, [
    finiteStream([event('20')]),
    finiteStream([event('21')]),
  ])
  const received = []
  const stream = await events.startAppEventStream(session, 'public', (value) =>
    received.push(value),
  )
  await stream.done

  assert.deepEqual(
    received.map((value) => value.cursor),
    ['20', '21'],
  )
  assert.equal(subscriptions.length, 2)
  assert.equal(subscriptions[0].options.limit, 1)
  assert.equal(subscriptions[0].options.reverse, true)
  assert.equal(subscriptions[1].cursor, '20')
  assert.equal(subscriptions[1].options.live, true)
  assert.equal(subscriptions[1].options.reverse, undefined)
})

test('a resumed live stream uses the supplied cursor without resetting history', async (t) => {
  const subscriptions = mockSubscriptions(t, [finiteStream([event('21')])])
  const received = []
  const stream = await events.startAppEventStream(
    session,
    'public',
    (value) => received.push(value),
    '20',
  )
  await stream.done

  assert.equal(subscriptions.length, 1)
  assert.equal(subscriptions[0].cursor, '20')
  assert.deepEqual(
    received.map((value) => value.cursor),
    ['21'],
  )
})

test('empty history still permits a live subscription', async (t) => {
  const subscriptions = mockSubscriptions(t, [finiteStream([]), finiteStream([])])
  const stream = await events.startAppEventStream(session, 'public', () =>
    assert.fail('No events expected'),
  )
  await stream.done
  assert.equal(subscriptions.length, 2)
  assert.equal(subscriptions[1].cursor, null)
})

test('stopping cancels a pending read, releases the reader, and is idempotent', async (t) => {
  const cancel = t.mock.fn()
  const source = new globalThis.ReadableStream({ cancel })
  mockSubscriptions(t, [source])
  const stream = await events.startAppEventStream(
    session,
    'public',
    () => assert.fail('Stopped'),
    '20',
  )
  await stream.stop()
  await stream.stop()
  await stream.done
  assert.equal(cancel.mock.callCount(), 1)
  assert.equal(source.locked, false)
})

test('out-of-scope events are rejected and their network stream is cancelled', async (t) => {
  for (const value of [
    event('21', '/priv/template/files/note.json'),
    event('21', undefined, 'other-owner'),
  ]) {
    const cancel = t.mock.fn()
    const source = new globalThis.ReadableStream({
      start(controller) {
        controller.enqueue(value)
      },
      cancel,
    })
    mockSubscriptions(t, [source])
    const stream = await events.startAppEventStream(
      session,
      'public',
      () => assert.fail('Untrusted event'),
      '20',
    )
    await assert.rejects(stream.done, /outside the selected folder/)
    assert.equal(cancel.mock.callCount(), 1)
    assert.equal(source.locked, false)
  }
})

test('transport failures propagate without leaking a stream reader', async (t) => {
  const source = new globalThis.ReadableStream({
    start(controller) {
      controller.error(new Error('Connection lost'))
    },
  })
  mockSubscriptions(t, [source])
  const stream = await events.startAppEventStream(session, 'public', () => {}, '20')
  await assert.rejects(stream.done, /Connection lost/)
  assert.equal(source.locked, false)
})
