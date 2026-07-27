import { afterEach, describe, expect, test } from 'bun:test'
import type { DeepPartial, SessionPolicy } from '../src/policy/schema.ts'
import { type Harness, json, sendRequest, startHarness, webhookRequest } from './helpers.ts'

/**
 * The new-contact budgets ration *cold outreach*. They used to charge for any first outbound
 * to a chat, so answering someone who had just written to us cost the same as cold-messaging
 * a stranger off a scraped list — two opposite risk profiles on one counter.
 *
 * On 2026-07-27 a Facebook ad produced six inbound candidates in two hours and the sixth
 * could not be answered for nine hours, while genuine cold outreach stayed allowed. These
 * are that incident and the cases that must not regress with it.
 */

let harness: Harness

afterEach(async () => {
  await harness?.stop()
})

const PHONE = '351920266018@c.us'
const LID = '60851197333718@lid'
const ALT_JID = '351920266018@s.whatsapp.net'

/** The conservative preset's real caps: 5 new strangers a day, day-0 warmup ramp. */
async function budgetHarness(policy: DeepPartial<SessionPolicy> = {}): Promise<Harness> {
  return startHarness({
    preset: 'conservative',
    policy: {
      quietHours: { enabled: false },
      typing: { enabled: false },
      presence: 'caller',
      contacts: { requireHumanTouch: true, maxNewStrangersPerDay: 5, handshakeMaxMessages: 1 },
      replyRatio: { enabled: false },
      rates: {
        minSpacingMs: 0,
        jitterStddevMs: 0,
        perMinute: Number.POSITIVE_INFINITY,
        perHour: Number.POSITIVE_INFINITY,
        perDay: Number.POSITIVE_INFINITY,
      },
      // Do not sit on the request for two minutes when a budget gate fires.
      backpressure: { maxWaitMs: 1_000 },
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

/** Someone writes in. `alt` is the GOWS alt JID that resolves the LID to a phone. */
function inbound(from: string, id: string, alt?: string): Request {
  return webhookRequest([
    {
      event: 'message.any',
      session: 'default',
      payload: {
        id,
        from,
        fromMe: false,
        body: 'vi o anúncio',
        ...(alt ? { _data: { Info: { SenderAlt: alt } } } : {}),
      },
    },
  ])
}

const spentToday = () => harness.store.countNewStrangersSince('default', 0)

describe('inbound does not consume the cold-outreach budget', () => {
  test('a day of ad replies passes with the budget untouched', async () => {
    harness = await budgetHarness()

    // Six candidates write in — one more than the 5/day cap — and each is answered.
    for (let i = 0; i < 6; i++) {
      const chatId = `35190000000${i}@c.us`
      await harness.guard.fetch(inbound(chatId, `AD${i}`))
      const reply = await sendText(chatId, 'olá, obrigado pelo contacto')
      expect(reply.status).toBe(200)
    }
    expect(spentToday()).toBe(0)
  })

  test('cold outreach still spends the budget and still blocks at the cap', async () => {
    harness = await budgetHarness()

    for (let i = 0; i < 5; i++) {
      const chatId = `35191111111${i}@c.us`
      await touch(chatId)
      expect((await sendText(chatId)).status).toBe(200)
    }
    expect(spentToday()).toBe(5)

    await touch('351911111119@c.us')
    const blocked = await sendText('351911111119@c.us')
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('x-guard-reason')).toBe('guard.new_contact_budget')
  })

  test('a stranger blocked by the cap does not block a reply to someone who wrote in', async () => {
    harness = await budgetHarness()
    for (let i = 0; i < 5; i++) {
      const chatId = `35191111111${i}@c.us`
      await touch(chatId)
      await sendText(chatId)
    }
    expect((await sendText('351911111119@c.us')).status).not.toBe(200)

    await harness.guard.fetch(inbound(PHONE, 'CANDIDATE'))
    expect((await sendText(PHONE, 'olá')).status).toBe(200)
  })

  test('the warmup ramp is the other counter, and it exempts inbound too', async () => {
    // The gate that actually fired in the incident: not in policy.yml, supplied by the preset.
    harness = await budgetHarness({
      contacts: { requireHumanTouch: true, maxNewStrangersPerDay: 50, handshakeMaxMessages: 1 },
      warmup: {
        enabled: true,
        schedule: [{ fromDay: 0, maxPerDay: 200, maxNewContactsPerDay: 2 }],
      },
    })

    for (const chatId of ['351933333331@c.us', '351933333332@c.us']) {
      await touch(chatId)
      expect((await sendText(chatId)).status).toBe(200)
    }

    await touch('351933333333@c.us')
    const blocked = await sendText('351933333333@c.us')
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('x-guard-reason')).toBe('guard.warmup_new_contacts')
    // ...and the 429 names the knob, so the operator is not left diffing the preset.
    const body = await json(blocked)
    expect(body.message).toContain('warmup.schedule[fromDay: 0].maxNewContactsPerDay')
    expect(body.message).toContain('contacts.maxNewStrangersPerDay')

    // The same ramp lets an answer through, because the candidate wrote first.
    await harness.guard.fetch(inbound(PHONE, 'CANDIDATE'))
    expect((await sendText(PHONE, 'olá')).status).toBe(200)
  })

  test('an inbound arriving as @lid exempts the reply addressed to @c.us', async () => {
    harness = await budgetHarness({
      contacts: { requireHumanTouch: true, maxNewStrangersPerDay: 0, handshakeMaxMessages: 1 },
    })

    await harness.guard.fetch(inbound(LID, 'THEIRS', ALT_JID))
    // Budget of zero: only the identity fold can make this send legal.
    expect((await sendText(PHONE, 'olá')).status).toBe(200)
    expect(spentToday()).toBe(0)
  })

  test('a human touch unlocks a stranger but does not buy a free cold send', async () => {
    // `markHumanTouch` is how requireHumanTouch is satisfied for a cold target, so if it
    // also waived the budget, a batch of adopted numbers would sail past the cap — the
    // exact shape of the send that got the device unlinked on 2026-07-25.
    harness = await budgetHarness({
      contacts: { requireHumanTouch: true, maxNewStrangersPerDay: 1, handshakeMaxMessages: 1 },
    })
    await touch(PHONE)
    expect((await sendText(PHONE)).status).toBe(200)
    expect(spentToday()).toBe(1)

    await touch('351999999999@c.us')
    expect((await sendText('351999999999@c.us')).status).toBe(429)
  })

  test('a day of group job posts leaves the budget for people', async () => {
    // Groups are exempt from the contact gates, so a group send is never *refused* by this
    // budget — but every one of them used to spend a slot a real person then could not have.
    harness = await budgetHarness()
    // Twice the 5/day cap, and none of it is cold outreach to a person.
    for (let i = 0; i < 10; i++) {
      expect((await sendText(`12036340974053052${i}@g.us`, 'vaga')).status).toBe(200)
    }
    expect(spentToday()).toBe(0)

    await touch(PHONE)
    expect((await sendText(PHONE)).status).toBe(200)
    // They do still consume the shared per-day send quota, which is a different budget.
    expect(harness.store.countSendsSince('default', 0)).toBe(11)
  })

  test('GET /_guard/status shows both caps and what is spent', async () => {
    harness = await budgetHarness()
    await touch(PHONE)
    await sendText(PHONE)

    const res = await harness.guard.fetch(new Request('http://guard/_guard/status'))
    const caps = (await json(res)).sessions[0].newContactCaps
    expect(caps.spentToday).toBe(1)
    expect(caps.maxNewStrangersPerDay).toBe(5)
    expect(caps.warmupMaxNewContactsPerDay).toBe(5)
    expect(caps.warmupFromDay).toBe(0)
  })
})
