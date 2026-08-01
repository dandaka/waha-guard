import { afterEach, describe, expect, test } from 'bun:test'
import { observeInteraction } from '../src/waha/message.ts'
import { type Harness, json, sendRequest, startHarness, webhookRequest } from './helpers.ts'

/**
 * `requireHumanTouch` used to recognise exactly one kind of engagement: a typed message.
 * Someone who rang the line, reacted to an offer or voted in a poll stayed a stranger, and
 * the reply to them was refused — including, for a caller, the one reply worth sending.
 */

let harness: Harness

afterEach(async () => {
  await harness?.stop()
})

const CALLER = '351900000010@c.us'

async function touchHarness(): Promise<Harness> {
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
    },
  })
}

const post = (events: unknown) => harness.guard.fetch(webhookRequest(events))
const sendText = (chatId: string) =>
  harness.guard.fetch(sendRequest('/api/sendText', { session: 'default', chatId, text: 'hi' }))

describe('observeInteraction', () => {
  test('reads the chat id out of whichever field the event type uses', () => {
    expect(observeInteraction('call.received', { id: 'c1', from: CALLER })?.chatId).toBe(CALLER)
    expect(observeInteraction('poll.vote', { vote: { id: 'v1', from: CALLER } })?.chatId).toBe(
      CALLER,
    )
    expect(observeInteraction('message.reaction', { id: 'r1', chatId: CALLER })?.chatId).toBe(
      CALLER,
    )
  })

  test('a revoke describes the deleted message under `after`, not at the top level', () => {
    // The envelope carries neither the chat nor fromMe. Reading the top level would drop
    // the event entirely, or worse, treat their deletion as ours.
    const seen = observeInteraction('message.revoked', {
      revokedMessageId: 'm1',
      after: { id: 'm1', from: CALLER, fromMe: false },
    })
    expect(seen?.chatId).toBe(CALLER)
    expect(seen?.fromMe).toBe(false)

    const ours = observeInteraction('message.revoked', {
      revokedMessageId: 'm2',
      after: { id: 'm2', to: CALLER, fromMe: true },
    })
    expect(ours?.fromMe).toBe(true)
  })

  test('ids are namespaced by event, so two events on one id stay distinct', () => {
    const a = observeInteraction('call.received', { id: 'call-1', from: CALLER })
    const b = observeInteraction('message.reaction', { id: 'call-1', from: CALLER })
    expect(a?.ids[0]).not.toBe(b?.ids[0])
  })

  test('an event with no chat anywhere is not guessed at', () => {
    expect(observeInteraction('call.received', { id: 'c1' })).toBeNull()
  })
})

describe('interactions as human touch', () => {
  test('a missed call lets us answer someone who never typed', async () => {
    harness = await touchHarness()
    expect((await sendText(CALLER)).status).toBe(403)
    expect(await json(await sendText(CALLER))).toMatchObject({ error: 'guard.no_human_touch' })

    await post({
      event: 'call.received',
      session: 'default',
      payload: { id: 'call-1', from: CALLER },
    })

    expect((await sendText(CALLER)).status).toBe(200)
  })

  test('a reaction and a poll vote count too', async () => {
    for (const [chatId, event, payload] of [
      ['351900000011@c.us', 'message.reaction', { id: 'r1', from: '351900000011@c.us' }],
      ['351900000012@c.us', 'poll.vote', { vote: { id: 'v1', from: '351900000012@c.us' } }],
    ] as const) {
      harness = await touchHarness()
      expect((await sendText(chatId)).status).toBe(403)
      await post({ event, session: 'default', payload })
      expect((await sendText(chatId)).status).toBe(200)
      await harness.stop()
    }
  })

  test('our own reaction is not their engagement', async () => {
    harness = await touchHarness()
    await post({
      event: 'message.reaction',
      session: 'default',
      payload: { id: 'r1', to: CALLER, fromMe: true },
    })
    expect((await sendText(CALLER)).status).toBe(403)
  })

  /**
   * The line the whole feature turns on. A read receipt arrives from their side and is not
   * engagement — it is our own message being opened. Counting it would let every cold send
   * unlock itself, which is precisely what `requireHumanTouch` exists to prevent.
   */
  test('a read receipt does NOT unlock a contact', async () => {
    harness = await touchHarness()
    await post({
      event: 'message.ack',
      session: 'default',
      payload: { id: 'm1', from: CALLER, ack: 3, ackName: 'READ' },
    })
    expect((await sendText(CALLER)).status).toBe(403)
  })

  test('a redelivered call is not a second interaction', async () => {
    harness = await touchHarness()
    const call = {
      event: 'call.received',
      session: 'default',
      payload: { id: 'call-dup', from: CALLER },
    }
    await post(call)
    await post(call)
    const contact = harness.store.getContact('default', CALLER)
    expect(contact?.in_count).toBe(1)
  })
})
