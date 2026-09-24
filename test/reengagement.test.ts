import { afterEach, describe, expect, test } from 'bun:test'
import type { DeepPartial, SessionPolicy } from '../src/policy/schema.ts'
import { type Harness, sendRequest, startHarness } from './helpers.ts'

const DAY = 86_400_000
let harness: Harness
afterEach(async () => {
  await harness?.stop()
})

const policy: DeepPartial<SessionPolicy> = {
  quietHours: { enabled: false, timezone: 'UTC' },
  contacts: {
    requireHumanTouch: true,
    dormantAfterDays: 7,
    maxReengagementsPerDay: 5,
    handshakeMaxMessages: 1,
  },
}
const send = (chatId: string, session = 'default', headers?: Record<string, string>) =>
  harness.guard.fetch(sendRequest('/api/sendText', { session, chatId, text: 'hello' }, { headers }))
const inbound = (chatId: string, daysAgo: number, session = 'default') =>
  harness.store.recordInbound(
    session,
    chatId,
    `${session}-${chatId}-${daysAgo}`,
    harness.clock.now() - daysAgo * DAY,
  )

describe('dormant re-engagement', () => {
  test('five silent contacts go out, the sixth gets a deny and no queue', async () => {
    harness = await startHarness({ policy })
    for (let i = 0; i < 6; i++) inbound(`${i}@c.us`, 30)
    for (let i = 0; i < 5; i++) expect((await send(`${i}@c.us`)).status).toBe(200)
    const refused = await send('5@c.us')
    expect(refused.status).toBe(403)
    expect(refused.headers.get('x-guard-reason')).toBe('guard.reengagement_budget')
    expect(harness.store.queuedDepth()).toBe(0)
    expect(harness.waha.requests.filter((r) => r.path === '/api/sendText')).toHaveLength(5)
    const status = (await (
      await harness.guard.fetch(new Request('http://guard/_guard/status'))
    ).json()) as any
    expect(status.sessions[0].reengagement).toMatchObject({
      spentToday: 5,
      maxReengagementsPerDay: 5,
      dormantContactsMessagedLast7Days: 5,
    })
  })

  test('one unanswered message per dormant contact per day; a new day resets both limits', async () => {
    harness = await startHarness({ policy })
    inbound('a@c.us', 10)
    expect((await send('a@c.us')).status).toBe(200)
    expect((await send('a@c.us')).headers.get('x-guard-reason')).toBe('guard.handshake_exhausted')
    await harness.clock.advance(DAY)
    expect((await send('a@c.us')).status).toBe(200)
  })

  test('recent inbound replies are free, including after an earlier stale send', async () => {
    harness = await startHarness({ policy })
    inbound('a@c.us', 10)
    expect((await send('a@c.us')).status).toBe(200)
    await harness.clock.advance(1)
    inbound('a@c.us', 0)
    expect((await send('a@c.us')).status).toBe(200)
    inbound('b@c.us', 2)
    expect((await send('b@c.us')).status).toBe(200)
    const status = (await (
      await harness.guard.fetch(new Request('http://guard/_guard/status'))
    ).json()) as any
    expect(status.sessions[0].reengagement.spentToday).toBe(1)
  })

  test('a reply from us nine days ago does not refresh the inbound clock', async () => {
    harness = await startHarness({
      policy: { ...policy, contacts: { ...policy.contacts, maxReengagementsPerDay: 0 } },
    })
    inbound('a@c.us', 10)
    harness.store.recordHumanOutbound('default', 'a@c.us', 'phone1', harness.clock.now() - 9 * DAY)
    expect((await send('a@c.us')).headers.get('x-guard-reason')).toBe('guard.reengagement_budget')
  })

  test('the cap is per session and force logs the reason', async () => {
    const lines: { msg: string; fields: Record<string, unknown> }[] = []
    harness = await startHarness({
      policy: { ...policy, contacts: { ...policy.contacts, maxReengagementsPerDay: 1 } },
      log: {
        info: (msg, fields) => lines.push({ msg, fields: fields ?? {} }),
        warn: (msg, fields) => lines.push({ msg, fields: fields ?? {} }),
        error: () => {},
        debug: () => {},
      },
    })
    for (const session of ['pedro', 'assistente']) {
      inbound('a@c.us', 30, session)
      inbound('b@c.us', 30, session)
      expect((await send('a@c.us', session)).status).toBe(200)
    }
    expect((await send('b@c.us', 'pedro')).status).toBe(403)
    expect(
      (
        await send('b@c.us', 'pedro', {
          'x-guard-force': '1',
          'x-guard-force-reason': 'founder approved this contact',
        })
      ).status,
    ).toBe(200)
    expect(
      lines.find(
        (l) =>
          l.msg === 'forced past a guard limit' && l.fields.code === 'guard.reengagement_budget',
      )?.fields.forceReason,
    ).toBe('founder approved this contact')
    expect((await send('b@c.us', 'assistente')).status).toBe(403)
  })

  test('groups and contacts with no inbound do not spend the re-engagement budget', async () => {
    harness = await startHarness({
      policy: {
        ...policy,
        contacts: { ...policy.contacts, maxReengagementsPerDay: 0 },
        groups: { mode: 'exempt' },
      },
    })
    inbound('group@g.us', 30)
    expect((await send('group@g.us')).status).toBe(200)
    harness.store.markHumanTouch('default', 'stranger@c.us', harness.clock.now())
    expect((await send('stranger@c.us')).status).toBe(200)
  })
})
