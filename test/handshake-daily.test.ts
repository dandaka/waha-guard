/**
 * The handshake cap is per day, not per lifetime.
 *
 * It used to read `contacts.out_count`, a lifetime counter, so a contact who had not replied
 * was muted forever. On 2026-07-27 a Monday follow-up to an employer was refused because the
 * message before it went out on the Sunday — "one unanswered message, ever" was never the
 * rule anyone wanted.
 *
 * The clock starts at 2023-11-14T22:13:20Z, which is late evening in UTC and already the
 * next morning in Tokyo — the two zones therefore disagree about which day it is, which is
 * what makes the timezone assertions below meaningful rather than incidental.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import type { DeepPartial, SessionPolicy } from '../src/policy/schema.ts'
import { type Harness, json, sendRequest, startHarness } from './helpers.ts'

let harness: Harness

afterEach(async () => {
  await harness?.stop()
})

const HOUR = 3_600_000

function daily(timezone: string): DeepPartial<SessionPolicy> {
  return {
    contacts: { requireHumanTouch: false, handshakeMaxMessages: 1 },
    // The gate reads the session's timezone off quietHours rather than inventing a second
    // notion of "day". Quiet hours themselves stay off so they cannot mask the result.
    quietHours: { enabled: false, timezone },
  }
}

const sendText = (chatId: string) =>
  harness.guard.fetch(sendRequest('/api/sendText', { session: 'default', chatId, text: 'hello' }))

const sends = () => harness.waha.requests.filter((r) => r.path === '/api/sendText')

describe('handshake cap, per day', () => {
  test('a second unanswered message on the same day is still refused', async () => {
    harness = await startHarness({ policy: daily('UTC') })
    expect((await sendText('a@c.us')).status).toBe(200)

    const second = await sendText('a@c.us')
    expect(second.status).toBe(403)
    expect(second.headers.get('x-guard-reason')).toBe('guard.handshake_exhausted')
    expect(sends()).toHaveLength(1)
  })

  test('the cap lifts at midnight, not 24 hours after the last send', async () => {
    harness = await startHarness({ policy: daily('UTC') })
    await sendText('a@c.us')
    expect((await sendText('a@c.us')).status).toBe(403)

    // 23:13 UTC — an hour later, same calendar day, still refused.
    await harness.clock.advance(HOUR)
    expect((await sendText('a@c.us')).status).toBe(403)

    // 00:13 UTC — a new day, and only ~2h after the send that spent the budget. A rolling
    // 24h window would still be refusing here; that is the difference being asserted.
    await harness.clock.advance(HOUR)
    expect((await sendText('a@c.us')).status).toBe(200)
    expect(sends()).toHaveLength(2)
  })

  test('the day boundary is the policy timezone, not UTC', async () => {
    // 22:13 UTC is already 07:13 the next morning in Tokyo, so two hours of advancing does
    // not cross a Tokyo midnight even though it crosses the UTC one.
    harness = await startHarness({ policy: daily('Asia/Tokyo') })
    await sendText('a@c.us')
    await harness.clock.advance(2 * HOUR)

    const res = await sendText('a@c.us')
    expect(res.status).toBe(403)
    expect(res.headers.get('x-guard-reason')).toBe('guard.handshake_exhausted')
  })

  test('the refusal says when it lifts and what the lifetime total is', async () => {
    harness = await startHarness({ policy: daily('UTC') })
    await sendText('a@c.us')
    const body = await json(await sendText('a@c.us'))
    expect(body.message).toContain('1 message(s) sent today with no reply')
    expect(body.message).toContain('per day')
    expect(body.message).toContain('2023-11-15T00:00:00.000Z')
  })

  test('a reply still clears the cap outright, on any day', async () => {
    harness = await startHarness({ policy: daily('UTC') })
    await sendText('a@c.us')
    harness.store.recordInbound('default', 'a@c.us', 'in1', harness.clock.now())

    expect((await sendText('a@c.us')).status).toBe(200)
    expect((await sendText('a@c.us')).status).toBe(200)
  })

  test('out_count stays a lifetime total for the gates and endpoints that want one', async () => {
    harness = await startHarness({ policy: daily('UTC') })
    await sendText('a@c.us')
    await harness.clock.advance(2 * HOUR)
    await sendText('a@c.us')

    expect(harness.store.getContact('default', 'a@c.us')!.out_count).toBe(2)
  })

  test('a send that never reached WhatsApp does not spend the day', async () => {
    harness = await startHarness({ policy: daily('UTC') })
    harness.waha.reply('/api/sendText', () => new Response('nope', { status: 500 }))
    expect((await sendText('a@c.us')).status).toBe(500)

    // voidSend deletes the row, and the cap counts rows — so the budget was never spent.
    harness.waha.reply('/api/sendText', () => Response.json({ id: { id: 'MSG9' } }))
    expect((await sendText('a@c.us')).status).toBe(200)
  })

  test('a human message typed on the phone spends the day too', async () => {
    harness = await startHarness({ policy: daily('UTC') })
    harness.store.recordHumanOutbound('default', 'a@c.us', 'phone1', harness.clock.now())

    // recordHumanOutbound promotes to `known`, but the cap keys on whether they have
    // *replied* — nothing has come back, so today's one message is spent.
    const res = await sendText('a@c.us')
    expect(res.status).toBe(403)
    expect(res.headers.get('x-guard-reason')).toBe('guard.handshake_exhausted')
  })
})
