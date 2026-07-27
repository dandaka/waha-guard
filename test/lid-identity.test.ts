import { afterEach, describe, expect, test } from 'bun:test'
import type { DeepPartial, SessionPolicy } from '../src/policy/schema.ts'
import { isLidChatId, normalizeChatId, phoneChatIdFromJid } from '../src/waha/identity.ts'
import { type Harness, json, sendRequest, startHarness, webhookRequest } from './helpers.ts'

/**
 * WhatsApp's GOWS engine delivers inbound senders under an anonymous LID, while sends are
 * addressed to the phone. The guard used to key its ledger on whichever string it was handed,
 * so a reply arriving as `@lid` never cleared the handshake counter on the `@c.us` row and
 * every conversation went mute after one message.
 *
 * The numbers here are the ones from the live incident (2026-07-27).
 */

let harness: Harness

afterEach(async () => {
  await harness?.stop()
})

const PHONE = '351920266018@c.us'
const LID = '60851197333718@lid'
const ALT_JID = '351920266018@s.whatsapp.net'

async function handshakeHarness(policy: DeepPartial<SessionPolicy> = {}): Promise<Harness> {
  return startHarness({
    preset: 'conservative',
    policy: {
      quietHours: { enabled: false },
      typing: { enabled: false },
      presence: 'caller',
      contacts: { requireHumanTouch: true, handshakeMaxMessages: 1 },
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

const sendText = (chatId: string, text = 'hello') =>
  harness.guard.fetch(sendRequest('/api/sendText', { session: 'default', chatId, text }))

const touch = (chatId: string) =>
  harness.guard.fetch(
    sendRequest('/_guard/contact/human-touch', { session: 'default', chatId }, { method: 'POST' }),
  )

/** An inbound `message.any` the way the gows engine actually delivers it. */
function inboundFromLid(options: { withAlt: boolean; id: string }): Request {
  return webhookRequest([
    {
      event: 'message.any',
      session: 'default',
      payload: {
        id: options.id,
        from: LID,
        fromMe: false,
        body: 'ok',
        ...(options.withAlt ? { _data: { Info: { SenderAlt: ALT_JID } } } : {}),
      },
    },
  ])
}

describe('LID identity', () => {
  test('a reply arriving as @lid clears the handshake on the @c.us chat', async () => {
    harness = await handshakeHarness()
    await touch(PHONE)

    // The one message the handshake allows.
    expect((await sendText(PHONE, 'the job terms')).status).toBe(200)

    // He replies — but the engine reports him by LID, not by phone.
    await harness.guard.fetch(inboundFromLid({ withAlt: true, id: 'REPLY1' }))

    // ...so we must be able to answer him.
    const answer = await sendText(PHONE, 'qual é o seu nome completo?')
    expect(answer.status).toBe(200)
  })

  test('the reply lands on one contact row, not two', async () => {
    harness = await handshakeHarness()
    await touch(PHONE)
    await sendText(PHONE)
    await harness.guard.fetch(inboundFromLid({ withAlt: true, id: 'REPLY1' }))

    const contact = harness.store.getContact('default', PHONE)!
    expect(contact.in_count).toBe(1)
    expect(contact.out_count).toBe(1)
    expect(contact.state).toBe('known')
    // Looking the person up by either form finds the same row.
    expect(harness.store.getContact('default', LID)?.chat_id).toBe(PHONE)
  })

  test('a send addressed to the @lid is the same contact as one addressed to the phone', async () => {
    harness = await handshakeHarness()
    await touch(PHONE)
    await harness.guard.fetch(inboundFromLid({ withAlt: true, id: 'REPLY1' }))

    await sendText(LID, 'answering the lid form')

    const contact = harness.store.getContact('default', PHONE)!
    expect(contact.out_count).toBe(1)
    expect(harness.store.getContact('default', LID)?.chat_id).toBe(PHONE)
  })

  test('an unresolvable @lid is still recorded, and merges once the phone is learned', async () => {
    harness = await handshakeHarness()
    await touch(PHONE)
    await sendText(PHONE)

    // No SenderAlt and no /lids answer: the guard keeps the @lid rather than dropping the reply.
    await harness.guard.fetch(inboundFromLid({ withAlt: false, id: 'REPLY1' }))
    expect(harness.store.getContact('default', LID)?.in_count).toBe(1)

    // A later message carries the alt JID; the two rows become one and the reply counts.
    await harness.guard.fetch(inboundFromLid({ withAlt: true, id: 'REPLY2' }))

    const contact = harness.store.getContact('default', PHONE)!
    expect(contact.in_count).toBe(2)
    expect((await sendText(PHONE)).status).toBe(200)
  })

  test('a lid with no alt JID is resolved by asking WAHA', async () => {
    harness = await handshakeHarness()
    harness.waha.reply(`/api/default/lids/${LID}`, () => Response.json({ lid: LID, pn: PHONE }))
    await touch(PHONE)
    await sendText(PHONE)

    await harness.guard.fetch(inboundFromLid({ withAlt: false, id: 'REPLY1' }))
    // The lookup is fired off the webhook path rather than blocking it.
    await Bun.sleep(50)

    expect(harness.waha.requests.some((r) => r.path === `/api/default/lids/${LID}`)).toBe(true)
    const contact = harness.store.getContact('default', PHONE)!
    expect(contact.in_count).toBe(1)
    expect((await sendText(PHONE)).status).toBe(200)
  })

  test('a thread the contact opened is answerable', async () => {
    harness = await handshakeHarness()

    // They message us first, under a LID, with no prior contact of any kind.
    await harness.guard.fetch(inboundFromLid({ withAlt: true, id: 'THEIRS' }))

    // An inbound message is a human touch and a reply, so answering is allowed.
    expect((await sendText(PHONE, 'olá')).status).toBe(200)
  })

  test('the handshake still stops cold outreach to a stranger', async () => {
    harness = await handshakeHarness()
    await touch(PHONE)

    expect((await sendText(PHONE)).status).toBe(200)
    // Nobody replied, so the second message is exactly what the guard exists to refuse.
    const denied = await sendText(PHONE)
    expect(denied.status).toBe(403)
    expect((await json(denied)).error).toBe('guard.handshake_exhausted')
  })

  test('an opt-out under either name silences both', async () => {
    harness = await handshakeHarness()
    await harness.guard.fetch(inboundFromLid({ withAlt: true, id: 'THEIRS' }))

    harness.store.markOptOut('default', LID, harness.clock.now())

    expect(harness.store.getContact('default', PHONE)!.state).toBe('opted_out')
    const denied = await sendText(PHONE)
    expect(denied.status).toBe(403)
    expect((await json(denied)).error).toBe('guard.opted_out')
  })

  test('POST /_guard/contact/link frees a thread that was already stuck', async () => {
    harness = await handshakeHarness()
    await touch(PHONE)
    await sendText(PHONE, 'the job terms')

    // The state a guard upgraded mid-conversation inherits: his replies booked against the
    // LID, our send counted against the phone, and no new message coming to merge them.
    harness.store.recordInbound('default', LID, 'REPLY1', harness.clock.now())
    harness.store.recordInbound('default', LID, 'REPLY2', harness.clock.now())
    const stuck = await sendText(PHONE)
    expect(stuck.status).toBe(403)
    expect((await json(stuck)).error).toBe('guard.handshake_exhausted')

    const res = await harness.guard.fetch(
      sendRequest(
        '/_guard/contact/link',
        { session: 'default', alias: LID, chatId: PHONE },
        { method: 'POST' },
      ),
    )
    const body = await json(res)
    expect(body.linked).toBe(true)
    expect(body.contact.in_count).toBe(2)

    expect((await sendText(PHONE, 'answering his question at last')).status).toBe(200)
  })

  test('/_guard/contact reports both names, looked up by either', async () => {
    harness = await handshakeHarness()
    await harness.guard.fetch(inboundFromLid({ withAlt: true, id: 'THEIRS' }))

    for (const lookup of [PHONE, LID]) {
      const res = await harness.guard.fetch(
        new Request(`http://guard/_guard/contact?session=default&chatId=${lookup}`),
      )
      const body = await json(res)
      expect(body.chat_id).toBe(PHONE)
      expect(body.aliases).toEqual([PHONE, LID])
    }
  })
})

describe('chat id normalization', () => {
  test('folds the spellings of one phone together', () => {
    expect(normalizeChatId('351920266018@c.us')).toBe(PHONE)
    expect(normalizeChatId('351920266018@s.whatsapp.net')).toBe(PHONE)
    // GOWS attaches the device that sent the message; it is not a different person.
    expect(normalizeChatId('351920266018:12@s.whatsapp.net')).toBe(PHONE)
    expect(normalizeChatId(' 351920266018@C.US ')).toBe(PHONE)
  })

  test('leaves ids it cannot read alone', () => {
    expect(normalizeChatId(LID)).toBe(LID)
    expect(normalizeChatId('120363000000000000@g.us')).toBe('120363000000000000@g.us')
    expect(phoneChatIdFromJid(LID)).toBeNull()
    expect(phoneChatIdFromJid(undefined)).toBeNull()
  })

  test('knows a lid when it sees one', () => {
    expect(isLidChatId(LID)).toBe(true)
    expect(isLidChatId(PHONE)).toBe(false)
    expect(isLidChatId(null)).toBe(false)
  })
})
