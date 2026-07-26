import { afterEach, describe, expect, test } from 'bun:test'
import type { DeepPartial, SessionPolicy } from '../src/policy/schema.ts'
import { type Harness, json, sendRequest, startHarness } from './helpers.ts'

let harness: Harness

afterEach(async () => {
  await harness?.stop()
})

const PERSON = '351900000000@c.us'
const OTHER = '351900000001@c.us'

async function touchHarness(policy: DeepPartial<SessionPolicy> = {}): Promise<Harness> {
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

const touch = (body: unknown) =>
  harness.guard.fetch(
    new Request('http://guard/_guard/contact/human-touch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const sendText = (chatId: string, text = 'hello') =>
  harness.guard.fetch(sendRequest('/api/sendText', { session: 'default', chatId, text }))

describe('POST /_guard/contact/human-touch', () => {
  test('unblocks a contact the guard never observed', async () => {
    harness = await touchHarness()

    const before = await sendText(PERSON)
    expect(before.status).toBe(403)
    expect((await json(before)).error).toBe('guard.no_human_touch')

    const res = await touch({ chatId: PERSON })
    expect(res.status).toBe(200)
    expect((await json(res)).marked).toEqual([PERSON])

    expect((await sendText(PERSON)).status).toBe(200)
  })

  test('marks a batch and reports which were already known', async () => {
    harness = await touchHarness()
    await touch({ chatId: PERSON })

    const res = await touch({ chatIds: [PERSON, OTHER] })
    const body = await json(res)
    expect(body.marked).toEqual([OTHER])
    expect(body.already).toEqual([PERSON])
  })

  test('does not consume the rate window — a touch is about the past', async () => {
    harness = await touchHarness()
    await touch({ chatIds: [PERSON, OTHER, '351900000002@c.us'] })
    // Three contacts adopted, but nothing was sent, so today's quota is untouched.
    expect(harness.store.countSendsSince('default', 0)).toBe(0)
  })

  test('the contact reads as known, not stranger', async () => {
    harness = await touchHarness()
    await touch({ chatId: PERSON })
    const contact = harness.store.getContact('default', PERSON)!
    expect(contact.state).toBe('known')
    expect(contact.human_touch_at).not.toBeNull()
    expect(contact.out_count).toBe(0)
  })

  test('re-running is a no-op and keeps the original touch time', async () => {
    harness = await touchHarness()
    await touch({ chatId: PERSON, touchedAt: 1_000 })
    const first = harness.store.getContact('default', PERSON)!.human_touch_at

    const res = await touch({ chatId: PERSON, touchedAt: 9_999 })
    expect((await json(res)).marked).toEqual([])
    expect(harness.store.getContact('default', PERSON)!.human_touch_at).toBe(first)
  })

  test('does not resurrect an opted-out contact', async () => {
    harness = await touchHarness()
    harness.store.markOptOut('default', PERSON, harness.clock.now())

    await touch({ chatId: PERSON })

    expect(harness.store.getContact('default', PERSON)!.state).toBe('opted_out')
    const res = await sendText(PERSON)
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('guard.opted_out')
  })

  test('requires a chatId', async () => {
    harness = await touchHarness()
    const res = await touch({ session: 'default' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('guard.bad_request')
  })

  test('is protected by the guard API key when one is set', async () => {
    harness = await startHarness({ config: { apiKey: 'secret' } })
    const res = await touch({ chatId: PERSON })
    expect(res.status).toBe(401)
  })
})
