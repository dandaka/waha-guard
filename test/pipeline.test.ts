import { afterEach, describe, expect, test } from 'bun:test'
import {
  type Harness,
  json,
  sendRequest,
  startHarness,
  webhookRequest,
  withClock,
} from './helpers.ts'

let harness: Harness

afterEach(async () => {
  await harness?.stop()
})

const sendText = (chatId: string, text = 'hello', session = 'default') =>
  harness.guard.fetch(sendRequest('/api/sendText', { session, chatId, text }))

const sends = () => harness.waha.requests.filter((r) => r.path === '/api/sendText')

describe('send pipeline', () => {
  test('an allowed send reaches WAHA and the caller sees WAHAs own response', async () => {
    harness = await startHarness()
    const res = await sendText('a@c.us')
    expect(res.status).toBe(200)
    expect((await json(res)).id.id).toBe('MSG1')
    expect(sends()).toHaveLength(1)
    expect(JSON.parse(sends()[0]!.body)).toEqual({
      session: 'default',
      chatId: 'a@c.us',
      text: 'hello',
    })
  })

  test('the send is recorded against the contact and the window', async () => {
    harness = await startHarness()
    await sendText('a@c.us')
    const contact = harness.store.getContact('default', 'a@c.us')!
    expect(contact.out_count).toBe(1)
    expect(contact.state).toBe('handshake_sent')
    expect(harness.store.countSendsSince('default', 0)).toBe(1)
  })

  test('a request with no chatId is refused rather than passed through blind', async () => {
    harness = await startHarness()
    const res = await harness.guard.fetch(
      sendRequest('/api/sendText', { session: 'default', text: 'hi' }),
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('x-guard-reason')).toBe('guard.unidentified_recipient')
    expect(sends()).toHaveLength(0)
  })
})

describe('pacing', () => {
  test('a second send waits out the spacing instead of firing immediately', async () => {
    harness = await startHarness({ policy: { rates: { minSpacingMs: 20_000, jitterStddevMs: 0 } } })
    await sendText('a@c.us')
    const pending = sendText('b@c.us')

    await harness.clock.advance(19_000)
    expect(sends()).toHaveLength(1)

    const res = await withClock(harness.clock, pending, 5_000)
    expect(res.status).toBe(200)
    expect(sends()).toHaveLength(2)
  })

  test('jitter varies the gap without ever making it shorter than the floor', async () => {
    // rng is fixed at 0.5 in the harness; gaussian() with that draw returns the mean (0),
    // so the floor is exactly minSpacingMs and the wait is deterministic.
    harness = await startHarness({
      policy: { rates: { minSpacingMs: 10_000, jitterStddevMs: 5_000 } },
    })
    await sendText('a@c.us')
    const pending = sendText('b@c.us')
    await harness.clock.advance(9_999)
    expect(sends()).toHaveLength(1)
    await withClock(harness.clock, pending, 2_000)
    expect(sends()).toHaveLength(2)
  })

  test('waiting past maxWaitMs becomes a 429 with a machine-readable reason', async () => {
    harness = await startHarness({
      policy: {
        rates: { minSpacingMs: 600_000, jitterStddevMs: 0 },
        backpressure: { maxWaitMs: 5_000 },
      },
    })
    await sendText('a@c.us')
    const res = await sendText('b@c.us')
    expect(res.status).toBe(429)
    expect(res.headers.get('x-guard-reason')).toBe('guard.spacing')
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await json(res)).retryAfterMs).toBeGreaterThan(0)
    expect(sends()).toHaveLength(1)
  })

  test('a per-minute window holds the third send back', async () => {
    harness = await startHarness({
      policy: {
        rates: { perMinute: 2, minSpacingMs: 0, jitterStddevMs: 0 },
        backpressure: { maxWaitMs: 1_000 },
      },
    })
    await sendText('a@c.us')
    await sendText('b@c.us')
    const res = await sendText('c@c.us')
    expect(res.status).toBe(429)
    expect(res.headers.get('x-guard-reason')).toBe('guard.rate_minute')
  })

  test('a window that has aged out lets traffic resume', async () => {
    harness = await startHarness({
      policy: {
        rates: { perMinute: 1, minSpacingMs: 0, jitterStddevMs: 0 },
        backpressure: { maxWaitMs: 90_000 },
      },
    })
    await sendText('a@c.us')
    const pending = sendText('b@c.us')
    const res = await withClock(harness.clock, pending, 61_000)
    expect(res.status).toBe(200)
    expect(sends()).toHaveLength(2)
  })

  test('one session’s budget does not spend another session’s', async () => {
    harness = await startHarness({
      policy: {
        rates: { perMinute: 1, minSpacingMs: 0, jitterStddevMs: 0 },
        backpressure: { maxWaitMs: 1_000 },
      },
    })
    await sendText('a@c.us', 'hi', 'sales')
    const res = await sendText('b@c.us', 'hi', 'support')
    expect(res.status).toBe(200)
  })
})

describe('quiet hours', () => {
  test('a send inside the quiet window is deferred until it closes', async () => {
    // The test clock sits at 2023-11-14T22:13:20Z.
    harness = await startHarness({
      policy: {
        quietHours: { enabled: true, timezone: 'UTC', start: '21:00', end: '09:00' },
        backpressure: { maxWaitMs: 5_000 },
      },
    })
    const res = await sendText('a@c.us')
    expect(res.status).toBe(429)
    expect(res.headers.get('x-guard-reason')).toBe('guard.quiet_hours')
    expect((await json(res)).retryAfterMs).toBeGreaterThan(9 * 3600_000)
    expect(sends()).toHaveLength(0)
  })

  test('outside the window nothing is held back', async () => {
    harness = await startHarness({
      policy: { quietHours: { enabled: true, timezone: 'UTC', start: '01:00', end: '06:00' } },
    })
    expect((await sendText('a@c.us')).status).toBe(200)
  })
})

describe('relationship gates', () => {
  test('an opted-out contact is refused outright, with no retry advice', async () => {
    harness = await startHarness({ policy: { optOut: { enabled: true } } })
    harness.store.markOptOut('default', 'a@c.us', harness.clock.now())
    const res = await sendText('a@c.us')
    expect(res.status).toBe(403)
    expect(res.headers.get('x-guard-reason')).toBe('guard.opted_out')
    expect(res.headers.get('retry-after')).toBeNull()
    expect(sends()).toHaveLength(0)
  })

  test('requireHumanTouch refuses a contact no human has ever messaged', async () => {
    harness = await startHarness({ policy: { contacts: { requireHumanTouch: true } } })
    const res = await sendText('a@c.us')
    expect(res.status).toBe(403)
    expect(res.headers.get('x-guard-reason')).toBe('guard.no_human_touch')
  })

  test('an inbound message unlocks the contact for automation', async () => {
    harness = await startHarness({ policy: { contacts: { requireHumanTouch: true } } })
    await harness.guard.fetch(
      webhookRequest({
        event: 'message',
        session: 'default',
        payload: { id: 'in1', from: 'a@c.us', fromMe: false, body: 'hello there' },
      }),
    )
    expect((await sendText('a@c.us')).status).toBe(200)
  })

  test('the handshake cap stops a second unanswered message', async () => {
    harness = await startHarness({
      policy: { contacts: { requireHumanTouch: false, handshakeMaxMessages: 1 } },
    })
    expect((await sendText('a@c.us')).status).toBe(200)
    const res = await sendText('a@c.us')
    expect(res.status).toBe(403)
    expect(res.headers.get('x-guard-reason')).toBe('guard.handshake_exhausted')
  })

  test('the new-contact budget limits how many strangers a day starts with', async () => {
    harness = await startHarness({
      policy: {
        contacts: { requireHumanTouch: false, maxNewStrangersPerDay: 2, handshakeMaxMessages: 10 },
        backpressure: { maxWaitMs: 1_000 },
      },
    })
    expect((await sendText('a@c.us')).status).toBe(200)
    expect((await sendText('b@c.us')).status).toBe(200)
    const res = await sendText('c@c.us')
    expect(res.status).toBe(429)
    expect(res.headers.get('x-guard-reason')).toBe('guard.new_contact_budget')
    // ...but an existing conversation still flows.
    expect((await sendText('a@c.us')).status).toBe(200)
  })

  test('reply ratio blocks strangers while replies keep flowing', async () => {
    harness = await startHarness({
      policy: {
        contacts: { requireHumanTouch: false, handshakeMaxMessages: 100 },
        replyRatio: {
          enabled: true,
          maxOutPerIn: 2,
          minSamples: 3,
          windowHours: 24,
          action: 'block-strangers',
        },
      },
    })
    await harness.guard.fetch(
      webhookRequest({
        event: 'message',
        session: 'default',
        payload: { id: 'in1', from: 'known@c.us', fromMe: false, body: 'hi' },
      }),
    )
    for (const chat of ['a@c.us', 'b@c.us', 'c@c.us']) await sendText(chat)

    const stranger = await sendText('d@c.us')
    expect(stranger.status).toBe(429)
    expect(stranger.headers.get('x-guard-reason')).toBe('guard.reply_ratio')
    expect((await sendText('known@c.us')).status).toBe(200)
  })
})

describe('warmup', () => {
  test('a day-0 session runs out of budget where a mature one would not', async () => {
    harness = await startHarness({
      policy: {
        contacts: {
          requireHumanTouch: false,
          handshakeMaxMessages: 10,
          maxNewStrangersPerDay: 100,
        },
        warmup: {
          enabled: true,
          schedule: [
            { fromDay: 0, maxPerDay: 2, maxNewContactsPerDay: 100 },
            { fromDay: 3, maxPerDay: 50, maxNewContactsPerDay: 100 },
          ],
        },
        backpressure: { maxWaitMs: 1_000 },
      },
    })
    await sendText('a@c.us')
    await sendText('a@c.us')
    const blocked = await sendText('a@c.us')
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('x-guard-reason')).toBe('guard.warmup_budget')

    // Same session, four days older: the day-3 step applies.
    harness.store.setWarmupStart('default', harness.clock.now() - 4 * 86_400_000)
    expect((await sendText('a@c.us')).status).toBe(200)
  })
})

describe('session health', () => {
  test('a FAILED session stops outbound entirely', async () => {
    harness = await startHarness()
    await harness.guard.fetch(
      webhookRequest({
        event: 'session.status',
        session: 'default',
        payload: { status: 'FAILED' },
      }),
    )
    const res = await sendText('a@c.us')
    expect(res.status).toBe(503)
    expect(res.headers.get('x-guard-reason')).toBe('guard.session_stopped')

    await harness.guard.fetch(
      webhookRequest({
        event: 'session.status',
        session: 'default',
        payload: { status: 'WORKING' },
      }),
    )
    expect((await sendText('a@c.us')).status).toBe(200)
  })
})

describe('timelock', () => {
  test('an upstream rate-limit puts the session into degraded mode', async () => {
    harness = await startHarness({
      policy: {
        timelock: { enabled: true, degradeMinutes: 60, strangersBlockedWhileDegraded: true },
        contacts: { requireHumanTouch: false, handshakeMaxMessages: 10 },
        backpressure: { maxWaitMs: 1_000 },
      },
    })
    harness.waha.reply(
      '/api/sendText',
      () => new Response(JSON.stringify({ message: 'rate-overlimit' }), { status: 429 }),
    )
    const rejected = await sendText('a@c.us')
    // WAHA's own answer is passed through untouched...
    expect(rejected.status).toBe(429)
    expect(await rejected.json()).toEqual({ message: 'rate-overlimit' })
    // ...and the failed send did not consume budget.
    expect(harness.store.countSendsSince('default', 0)).toBe(0)

    const state = harness.store.getSession('default')!
    expect(state.timelock_until).toBeGreaterThan(harness.clock.now())
    expect(state.rate_multiplier).toBeGreaterThan(1)
  })

  test('degraded mode blocks strangers and keeps replies to known contacts flowing', async () => {
    harness = await startHarness({
      policy: {
        timelock: { enabled: true, strangersBlockedWhileDegraded: true },
        contacts: { requireHumanTouch: false, handshakeMaxMessages: 10 },
        backpressure: { maxWaitMs: 1_000 },
      },
    })
    harness.store.setTimelock('default', harness.clock.now() + 3600_000, 5, harness.clock.now())
    await harness.guard.fetch(
      webhookRequest({
        event: 'message',
        session: 'default',
        payload: { id: 'in1', from: 'known@c.us', fromMe: false, body: 'hi' },
      }),
    )

    const stranger = await sendText('stranger@c.us')
    expect(stranger.status).toBe(429)
    expect(stranger.headers.get('x-guard-reason')).toBe('guard.degraded')
    expect((await sendText('known@c.us')).status).toBe(200)
  })
})

describe('observe mode', () => {
  test('gates are evaluated and reported but nothing is blocked', async () => {
    harness = await startHarness({
      policy: {
        mode: 'observe',
        contacts: { requireHumanTouch: true },
        rates: { minSpacingMs: 600_000 },
      },
    })
    expect((await sendText('a@c.us')).status).toBe(200)
    expect((await sendText('b@c.us')).status).toBe(200)
    expect(harness.guard.metrics.render()).toContain('gate_observed_total')
  })
})

describe('presence ownership', () => {
  test('when the guard owns presence it types before sending', async () => {
    harness = await startHarness({
      policy: {
        presence: 'guard',
        typing: { enabled: true, maxPlanMs: 20_000 },
        rates: { minSpacingMs: 0, jitterStddevMs: 0 },
      },
    })
    const pending = sendText('a@c.us', 'a message long enough to take a moment to type out')
    const res = await withClock(harness.clock, pending, 30_000)
    expect(res.status).toBe(200)

    const paths = harness.waha.requests.map((r) => r.path)
    expect(paths.filter((p) => p === '/api/startTyping').length).toBeGreaterThan(0)
    // The indicator is always cleared before the message lands.
    expect(paths.lastIndexOf('/api/stopTyping')).toBeLessThan(paths.lastIndexOf('/api/sendText'))
  })

  test('a caller doing its own typing is suppressed so the two do not interleave', async () => {
    harness = await startHarness({ policy: { presence: 'guard' } })
    const res = await harness.guard.fetch(
      sendRequest('/api/startTyping', { session: 'default', chatId: 'a@c.us' }),
    )
    expect(res.status).toBe(200)
    expect((await json(res)).suppressed).toBe(true)
    expect(harness.waha.requests).toHaveLength(0)
  })

  test('when the caller owns presence its typing calls pass through', async () => {
    harness = await startHarness({ policy: { presence: 'caller' } })
    await harness.guard.fetch(
      sendRequest('/api/startTyping', { session: 'default', chatId: 'a@c.us' }),
    )
    expect(harness.waha.requests.map((r) => r.path)).toEqual(['/api/startTyping'])
  })
})
