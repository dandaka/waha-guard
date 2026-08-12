import { afterEach, describe, expect, test } from 'bun:test'
import { normalizeForOptOut, parseEvents } from '../src/webhook/observer.ts'
import {
  type Harness,
  sendRequest,
  startHarness,
  startWebhookSink,
  type WebhookSink,
  webhookRequest,
} from './helpers.ts'

let harness: Harness

afterEach(async () => {
  await harness?.stop()
})

const post = (events: unknown) => harness.guard.fetch(webhookRequest(events))

const inbound = (chatId: string, body = 'hi', id = `in-${Math.random()}`) => ({
  event: 'message',
  session: 'default',
  payload: { id, from: chatId, to: 'me@c.us', fromMe: false, body },
})

describe('event parsing', () => {
  test('accepts a single event or a batch, and defaults the session', () => {
    expect(parseEvents({ event: 'message', payload: {} })).toEqual([
      { event: 'message', session: 'default', payload: {} },
    ])
    expect(
      parseEvents([
        { event: 'a', session: 's' },
        { event: 'b', session: 's' },
      ]),
    ).toHaveLength(2)
    expect(parseEvents({ nope: true })).toEqual([])
  })
})

describe('forwarding', () => {
  test('the body and headers reach the app untouched', async () => {
    harness = await startHarness({ withSink: true })
    const event = inbound('a@c.us')
    const res = await post(event)
    expect(res.status).toBe(200)

    const received = harness.sink!.received.at(-1)!
    expect(JSON.parse(received.body)).toEqual(event)
    // WAHA's signature header must survive, or downstream verification breaks.
    expect(received.headers['x-webhook-hmac']).toBe('sig123')
  })

  test('a body the guard cannot read is still delivered', async () => {
    harness = await startHarness({ withSink: true })
    const res = await harness.guard.fetch(
      new Request('http://guard.local/_guard/webhook', { method: 'POST', body: 'not json' }),
    )
    expect(res.status).toBe(200)
    expect(harness.sink!.received.at(-1)!.body).toBe('not json')
  })

  test('an unreachable app is reported so WAHA retries instead of losing the event', async () => {
    harness = await startHarness({ withSink: true })
    await harness.sink!.stop()
    const res = await post(inbound('a@c.us'))
    expect(res.status).toBe(502)
  })

  test('with no app configured the guard still observes and acknowledges', async () => {
    harness = await startHarness()
    const res = await post(inbound('a@c.us'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ forwarded: false })
    expect(harness.store.getContact('default', 'a@c.us')!.state).toBe('known')
  })
})

describe('contact graph', () => {
  test('an inbound message makes the contact known and counts as a human touch', async () => {
    harness = await startHarness()
    await post(inbound('a@c.us'))
    const contact = harness.store.getContact('default', 'a@c.us')!
    expect(contact.state).toBe('known')
    expect(contact.in_count).toBe(1)
    expect(contact.human_touch_at).not.toBeNull()
  })

  test('a redelivered webhook does not inflate the reply ratio', async () => {
    harness = await startHarness()
    const event = inbound('a@c.us', 'hi', 'stable-id')
    await post(event)
    await post(event)
    expect(harness.store.getContact('default', 'a@c.us')!.in_count).toBe(1)
  })

  test('message and message.any for the same inbound are counted once', async () => {
    harness = await startHarness()
    const payload = { id: 'dup1', from: 'a@c.us', fromMe: false, body: 'hi' }
    await post({ event: 'message', session: 'default', payload })
    await post({ event: 'message.any', session: 'default', payload })
    expect(harness.store.getContact('default', 'a@c.us')!.in_count).toBe(1)
  })

  test("the guard's own echo is not mistaken for someone typing on the phone", async () => {
    harness = await startHarness()
    await harness.guard.fetch(
      sendRequest('/api/sendText', { session: 'default', chatId: 'a@c.us', text: 'hi' }),
    )
    await post({
      event: 'message.any',
      session: 'default',
      payload: {
        id: { _serialized: 'true_123@c.us_MSG1', id: 'MSG1', fromMe: true },
        to: 'a@c.us',
        fromMe: true,
        body: 'hi',
      },
    })
    expect(harness.store.getContact('default', 'a@c.us')!.human_touch_at).toBeNull()
  })

  test('a message typed on the phone is what unlocks a contact', async () => {
    harness = await startHarness({ policy: { contacts: { requireHumanTouch: true } } })
    const before = await harness.guard.fetch(
      sendRequest('/api/sendText', { session: 'default', chatId: 'b@c.us', text: 'hi' }),
    )
    expect(before.status).toBe(403)

    await post({
      event: 'message.any',
      session: 'default',
      payload: { id: 'typed-by-hand', to: 'b@c.us', fromMe: true, body: 'hey, saw your post' },
    })
    const contact = harness.store.getContact('default', 'b@c.us')!
    expect(contact.human_touch_at).not.toBeNull()
    expect(contact.state).toBe('known')

    const after = await harness.guard.fetch(
      sendRequest('/api/sendText', { session: 'default', chatId: 'b@c.us', text: 'hi' }),
    )
    expect(after.status).toBe(200)
  })

  test('an echo that arrives before the send response is not counted as a human touch', async () => {
    // The race the confirm delay exists for: WAHA can deliver message.any before our own
    // POST has returned, so the id is not on file yet.
    harness = await startHarness({ echoConfirmMs: 5_000 })
    harness.waha.reply('/api/sendText', () => Response.json({ id: 'slow-1' }))
    const inFlight = harness.guard.fetch(
      sendRequest('/api/sendText', { session: 'default', chatId: 'c@c.us', text: 'hi' }),
    )
    await post({
      event: 'message.any',
      session: 'default',
      payload: { id: 'slow-1', to: 'c@c.us', fromMe: true, body: 'hi' },
    })
    await inFlight
    expect(harness.store.getContact('default', 'c@c.us')!.human_touch_at).toBeNull()
  })
})

describe('opt-out', () => {
  test('a bare STOP opts the contact out', async () => {
    harness = await startHarness({ policy: { optOut: { enabled: true } } })
    await post(inbound('a@c.us', 'STOP'))
    expect(harness.store.getContact('default', 'a@c.us')!.state).toBe('opted_out')
  })

  test('punctuation and casing do not hide an opt-out', async () => {
    harness = await startHarness({ policy: { optOut: { enabled: true } } })
    await post(inbound('a@c.us', '  Unsubscribe!  '))
    expect(harness.store.getContact('default', 'a@c.us')!.state).toBe('opted_out')
  })

  test('a keyword inside a sentence is not an opt-out', async () => {
    harness = await startHarness({ policy: { optOut: { enabled: true } } })
    await post(inbound('a@c.us', 'can you stop by tomorrow?'))
    expect(harness.store.getContact('default', 'a@c.us')!.state).toBe('known')
  })

  test('a human replying by hand overrides the opt-out', async () => {
    harness = await startHarness({ policy: { optOut: { enabled: true } } })
    await post(inbound('a@c.us', 'stop'))
    await post({
      event: 'message.any',
      session: 'default',
      payload: {
        id: 'by-hand',
        to: 'a@c.us',
        fromMe: true,
        body: 'sorry about that — removing you now',
      },
    })
    expect(harness.store.getContact('default', 'a@c.us')!.state).toBe('known')
  })

  test('normalization is what makes the match forgiving', () => {
    expect(normalizeForOptOut('  STOP!! ')).toBe('stop')
    expect(normalizeForOptOut('Opt   Out.')).toBe('opt out')
  })
})

describe('acks', () => {
  test('an ack is correlated back to the send that produced it', async () => {
    harness = await startHarness()
    await harness.guard.fetch(
      sendRequest('/api/sendText', { session: 'default', chatId: 'a@c.us', text: 'hi' }),
    )
    await post({
      event: 'message.ack',
      session: 'default',
      payload: { id: 'true_123@c.us_MSG1', ack: 2, ackName: 'DEVICE' },
    })
    const row = harness.store.db
      .query('SELECT ack FROM sends WHERE msg_id = ?')
      .get('true_123@c.us_MSG1') as { ack: number }
    expect(row.ack).toBe(2)
  })

  test('an ack for a message the guard never sent is ignored quietly', async () => {
    harness = await startHarness()
    const res = await post({
      event: 'message.ack',
      session: 'default',
      payload: { id: 'someone-elses', ack: 3 },
    })
    expect(res.status).toBe(200)
  })
})

/**
 * One WAHA container, several sessions, one guard. The app tells accounts apart by the
 * `?account=` on the webhook URL, so a session routed to the wrong target does not error —
 * it silently files one line's conversations under another's. These tests exist for that
 * failure, which no status code would reveal.
 */
describe('multi-session webhook routing', () => {
  const sinks: WebhookSink[] = []

  afterEach(async () => {
    await Promise.all(sinks.splice(0).map((s) => s.stop()))
  })

  const twoSinks = () => {
    const pedro = startWebhookSink()
    const alex = startWebhookSink()
    sinks.push(pedro, alex)
    return { pedro, alex }
  }

  const message = (session: string) => ({
    event: 'message',
    session,
    payload: { id: `id-${session}`, from: 'x@c.us', to: 'me@c.us', fromMe: false, body: 'hi' },
  })

  test('each session forwards to its own target', async () => {
    const { pedro, alex } = twoSinks()
    harness = await startHarness({
      config: { webhookTargets: { pedro: pedro.url, alex: alex.url } },
    })

    expect((await post(message('pedro'))).status).toBe(200)
    expect((await post(message('alex'))).status).toBe(200)

    expect(pedro.received).toHaveLength(1)
    expect(alex.received).toHaveLength(1)
    expect(JSON.parse(pedro.received[0]!.body).session).toBe('pedro')
    expect(JSON.parse(alex.received[0]!.body).session).toBe('alex')
  })

  test('a session outside the map falls back to the single target', async () => {
    const { pedro, alex } = twoSinks()
    harness = await startHarness({
      config: { webhookTarget: alex.url, webhookTargets: { pedro: pedro.url } },
    })

    expect((await post(message('vanessa'))).status).toBe(200)
    expect(alex.received).toHaveLength(1)
    expect(pedro.received).toHaveLength(0)
  })

  test('an unmapped session with no fallback is refused, so WAHA retries', async () => {
    const { pedro } = twoSinks()
    harness = await startHarness({
      config: { webhookTarget: null, webhookTargets: { pedro: pedro.url } },
    })

    // 502, not 200: acknowledging this would drop one account's entire inbound while the
    // other lines kept working, and nothing would look wrong.
    const res = await post(message('vanessa'))
    expect(res.status).toBe(502)
    expect(pedro.received).toHaveLength(0)
  })

  test('observe-only is still a quiet 200 when nothing is configured at all', async () => {
    harness = await startHarness({ config: { webhookTarget: null, webhookTargets: {} } })
    const res = await post(message('pedro'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, forwarded: false })
  })
})
