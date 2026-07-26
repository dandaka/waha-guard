import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { Store } from '../src/state/store.ts'
import { type Harness, json, sendRequest, startHarness } from './helpers.ts'

let harness: Harness
const files: string[] = []

afterEach(async () => {
  await harness?.stop()
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${f}${suffix}`, { force: true })
  }
})

const queued = { backpressure: { mode: 'queue' as const } }

const send = (chatId: string, text = 'hello') =>
  harness.guard.fetch(sendRequest('/api/sendText', { session: 'default', chatId, text }))

async function drain(): Promise<void> {
  while (await harness.guard.worker.drainOne('default')) {
    // keep going until the queue is empty
  }
}

describe('queue mode', () => {
  test('the caller gets 202 and an id it can follow up on', async () => {
    harness = await startHarness({ policy: queued })
    const res = await send('a@c.us')
    expect(res.status).toBe(202)
    const body = await json(res)
    expect(body.accepted).toBe(true)
    expect(body.guardId).toBe(res.headers.get('x-guard-id'))

    // Nothing has gone out yet — that is the contract difference from block mode.
    expect(harness.waha.requests).toHaveLength(0)

    const status = await harness.guard.fetch(new Request(`http://guard.local${body.statusUrl}`))
    expect(await json(status)).toMatchObject({ state: 'pending', chat_id: 'a@c.us' })
  })

  test('the worker delivers it and tells the app it went out', async () => {
    harness = await startHarness({ policy: queued, withSink: true })
    const res = await send('a@c.us')
    const { guardId } = await json(res)

    await drain()
    expect(harness.waha.requests.filter((r) => r.path === '/api/sendText')).toHaveLength(1)
    expect(harness.store.getQueued(guardId)!.state).toBe('sent')

    const event = JSON.parse(harness.sink!.received.at(-1)!.body)
    expect(event.event).toBe('guard.sent')
    expect(event.payload).toMatchObject({ guardId, chatId: 'a@c.us' })
    expect(event.payload.messageId).toBe('true_123@c.us_MSG1')
  })

  test('a send the policy refuses becomes a guard.dropped event, not silence', async () => {
    harness = await startHarness({
      policy: { ...queued, contacts: { requireHumanTouch: true } },
      withSink: true,
    })
    const { guardId } = await json(await send('a@c.us'))
    await drain()

    expect(harness.store.getQueued(guardId)!.state).toBe('dropped')
    expect(harness.waha.requests).toHaveLength(0)
    const event = JSON.parse(harness.sink!.received.at(-1)!.body)
    expect(event.event).toBe('guard.dropped')
    expect(event.payload.code).toBe('guard.no_human_touch')
  })

  test('a send WAHA rejects is reported rather than retried forever', async () => {
    harness = await startHarness({ policy: queued, withSink: true })
    harness.waha.reply('/api/sendText', () => new Response('bad request', { status: 400 }))
    const { guardId } = await json(await send('a@c.us'))
    await drain()

    expect(harness.store.getQueued(guardId)!.state).toBe('dropped')
    const event = JSON.parse(harness.sink!.received.at(-1)!.body)
    expect(event.payload).toMatchObject({ code: 'guard.upstream_rejected', status: 400 })
  })

  test('a job the policy is not ready for stays queued instead of being dropped', async () => {
    harness = await startHarness({
      policy: {
        rates: { minSpacingMs: 600_000 },
        backpressure: { mode: 'queue', maxWaitMs: 1_000 },
      },
    })
    await send('a@c.us')
    await send('b@c.us')
    await harness.guard.worker.drainOne('default')
    await harness.guard.worker.drainOne('default')

    expect(harness.waha.requests.filter((r) => r.path === '/api/sendText')).toHaveLength(1)
    expect(harness.store.queuedDepth('default')).toBe(1)
  })

  test('a queued send outlives a restart', async () => {
    const path = `/tmp/waha-guard-queue-${Math.random().toString(36).slice(2)}.sqlite`
    files.push(path)

    harness = await startHarness({ policy: queued, store: new Store(path) })
    const { guardId } = await json(await send('a@c.us'))
    await harness.stop()

    const reopened = new Store(path)
    expect(reopened.queuedDepth()).toBe(1)
    expect(reopened.getQueued(guardId)!.state).toBe('pending')

    // A fresh guard picks up where the old one left off.
    harness = await startHarness({ policy: queued, store: reopened })
    await drain()
    expect(harness.waha.requests.filter((r) => r.path === '/api/sendText')).toHaveLength(1)
  })

  test('the queued request is replayed byte-for-byte', async () => {
    harness = await startHarness({ policy: queued })
    await harness.guard.fetch(
      sendRequest(
        '/api/sendImage',
        { session: 'default', chatId: 'a@c.us', caption: 'look', file: { url: 'http://x/y.png' } },
        { headers: { 'x-api-key': 'secret' } },
      ),
    )
    await drain()
    const seen = harness.waha.requests.at(-1)!
    expect(seen.path).toBe('/api/sendImage')
    expect(JSON.parse(seen.body)).toEqual({
      session: 'default',
      chatId: 'a@c.us',
      caption: 'look',
      file: { url: 'http://x/y.png' },
    })
    expect(seen.headers['x-api-key']).toBe('secret')
  })
})
