import { afterEach, describe, expect, test } from 'bun:test'
import type { DeepPartial, SessionPolicy } from '../src/policy/schema.ts'
import { isGroupChatId } from '../src/waha/message.ts'
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

const GROUP = '120363000000000000@g.us'
const PERSON = '351900000000@c.us'

/**
 * The conservative preset paces, types and sleeps, and the test clock starts at 22:13 UTC —
 * inside its quiet window. All three are tested elsewhere; switch them off here so a failure
 * means the group rules are wrong, and turn them back on in the tests that are about them.
 */
async function groupHarness(policy: DeepPartial<SessionPolicy> = {}): Promise<Harness> {
  return startHarness({
    preset: 'conservative',
    policy: {
      quietHours: { enabled: false },
      typing: { enabled: false },
      presence: 'caller',
      rates: {
        minSpacingMs: 0,
        jitterStddevMs: 0,
        perMinute: Number.POSITIVE_INFINITY,
        perHour: Number.POSITIVE_INFINITY,
        perDay: Number.POSITIVE_INFINITY,
      },
      ...policy,
    },
  })
}

const sendText = (chatId: string, text = 'hello', session = 'default') =>
  harness.guard.fetch(sendRequest('/api/sendText', { session, chatId, text }))

const sends = () => harness.waha.requests.filter((r) => r.path === '/api/sendText')

describe('isGroupChatId', () => {
  test('recognises groups and channels, not individuals', () => {
    expect(isGroupChatId(GROUP)).toBe(true)
    expect(isGroupChatId('123@newsletter')).toBe(true)
    expect(isGroupChatId(PERSON)).toBe(false)
    expect(isGroupChatId(null)).toBe(false)
    expect(isGroupChatId('')).toBe(false)
  })
})

describe('groups: exempt (default)', () => {
  test('a group send goes through without a human touch, where a person is refused', async () => {
    harness = await groupHarness()

    const refused = await sendText(PERSON)
    expect(refused.status).toBe(403)
    expect((await json(refused)).error).toBe('guard.no_human_touch')

    const allowed = await sendText(GROUP)
    expect(allowed.status).toBe(200)
    expect(sends()).toHaveLength(1)
  })

  test('the handshake cap does not mute a group nobody replies to', async () => {
    harness = await groupHarness({ contacts: { requireHumanTouch: false } })
    for (let i = 0; i < 3; i++) expect((await sendText(GROUP, `m${i}`)).status).toBe(200)
    expect(sends()).toHaveLength(3)

    // The same treatment for a person stops after the first unanswered message.
    expect((await sendText(PERSON, 'first')).status).toBe(200)
    const second = await sendText(PERSON, 'second')
    expect(second.status).toBe(403)
    expect((await json(second)).error).toBe('guard.handshake_exhausted')
  })

  test('groups do not consume the new-stranger budget', async () => {
    harness = await groupHarness({
      contacts: { requireHumanTouch: false, maxNewStrangersPerDay: 1 },
      warmup: { enabled: false },
    })
    for (let i = 0; i < 3; i++) {
      expect((await sendText(`12036300000000000${i}@g.us`)).status).toBe(200)
    }
    expect(sends()).toHaveLength(3)
  })

  test('groups still consume the rate windows — they use the same real quota', async () => {
    harness = await groupHarness({
      contacts: { requireHumanTouch: false },
      warmup: { enabled: false },
      rates: { minSpacingMs: 0, jitterStddevMs: 0, perMinute: 2 },
      backpressure: { maxWaitMs: 1_000 },
    })
    expect((await sendText(GROUP, 'a')).status).toBe(200)
    expect((await sendText(GROUP, 'b')).status).toBe(200)
    const third = await withClock(harness.clock, sendText(GROUP, 'c'), 2_000)
    expect(third.status).toBe(429)
    expect(third.headers.get('x-guard-reason')).toBe('guard.rate_minute')
  })

  test('quiet hours still apply to groups', async () => {
    harness = await groupHarness({
      contacts: { requireHumanTouch: false },
      quietHours: { enabled: true, timezone: 'UTC', start: '21:00', end: '09:00' },
      backpressure: { maxWaitMs: 1_000 },
    })
    const res = await withClock(harness.clock, sendText(GROUP), 2_000)
    expect(res.status).toBe(429)
    expect(res.headers.get('x-guard-reason')).toBe('guard.quiet_hours')
  })

  test('one member saying "stop" does not opt the whole group out', async () => {
    harness = await groupHarness({ contacts: { requireHumanTouch: false } })
    await harness.guard.fetch(
      webhookRequest({
        event: 'message',
        session: 'default',
        payload: { from: GROUP, fromMe: false, body: 'stop', id: 'IN1' },
      }),
    )
    expect(harness.store.getContact('default', GROUP)?.state).not.toBe('opted_out')
    expect((await sendText(GROUP)).status).toBe(200)
  })

  test('the same "stop" from an individual still opts them out', async () => {
    harness = await groupHarness({ contacts: { requireHumanTouch: false } })
    await harness.guard.fetch(
      webhookRequest({
        event: 'message',
        session: 'default',
        payload: { from: PERSON, fromMe: false, body: 'stop', id: 'IN2' },
      }),
    )
    const res = await sendText(PERSON)
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('guard.opted_out')
  })

  test('a hand-set opt-out is still honoured for a group', async () => {
    harness = await groupHarness({ contacts: { requireHumanTouch: false } })
    harness.store.markOptOut('default', GROUP, harness.clock.now())
    const res = await sendText(GROUP)
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('guard.opted_out')
  })
})

describe('groups: other modes', () => {
  test('block refuses group sends outright and leaves individuals alone', async () => {
    harness = await groupHarness({
      groups: { mode: 'block' },
      contacts: { requireHumanTouch: false },
    })
    const res = await sendText(GROUP)
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('guard.group_blocked')
    expect((await sendText(PERSON)).status).toBe(200)
  })

  test('contact treats a group like anyone else', async () => {
    harness = await groupHarness({ groups: { mode: 'contact' } })
    const res = await sendText(GROUP)
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('guard.no_human_touch')
  })
})
