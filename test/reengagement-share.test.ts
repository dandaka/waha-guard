import { afterEach, describe, expect, test } from 'bun:test'
import { fromDocument, PolicyError } from '../src/policy/load.ts'
import { type DeepPartial, presetPolicy, type SessionPolicy } from '../src/policy/schema.ts'
import { type Harness, json, sendRequest, startHarness } from './helpers.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
let harness: Harness
afterEach(async () => {
  await harness?.stop()
})

const base: DeepPartial<SessionPolicy> = {
  quietHours: { enabled: false, timezone: 'UTC' },
  contacts: { dormantAfterDays: 7, handshakeMaxMessages: 1 },
}
const withContacts = (contacts: DeepPartial<SessionPolicy['contacts']>) => ({
  ...base,
  contacts: { ...base.contacts, ...contacts },
})
const send = (chatId: string, headers?: Record<string, string>) =>
  harness.guard.fetch(
    sendRequest('/api/sendText', { session: 'default', chatId, text: 'hello' }, { headers }),
  )
let seq = 0
const inbound = (chatId: string, agoMs: number) =>
  harness.store.recordInbound('default', chatId, `in-${seq++}`, harness.clock.now() - agoMs)
const status = async () =>
  (await json(await harness.guard.fetch(new Request('http://guard/_guard/status'))))
    .sessions[0] as Record<string, any>

describe('re-engagement hourly cap', () => {
  test('defaults leave the new knobs disabled in every preset', () => {
    for (const name of ['conservative', 'balanced', 'off'] as const) {
      const c = presetPolicy(name).contacts
      expect(c.maxReengagementsPerHour).toBe(Number.POSITIVE_INFINITY)
      expect(c.maxReengagementShare).toBe(1)
      expect(c.reengagementShareFloor).toBe(5)
    }
  })

  test('the next dormant contact waits until the oldest one in the hour ages out', async () => {
    harness = await startHarness({ policy: withContacts({ maxReengagementsPerHour: 2 }) })
    for (const c of ['a', 'b', 'c']) inbound(`${c}@c.us`, 30 * DAY)
    expect((await send('a@c.us')).status).toBe(200)
    await harness.clock.advance(10 * MINUTE)
    expect((await send('b@c.us')).status).toBe(200)
    await harness.clock.advance(5 * MINUTE)
    const refused = await send('c@c.us')
    expect(refused.status).toBe(429)
    expect(refused.headers.get('x-guard-reason')).toBe('guard.reengagement_hour')
    // `a` went out 15 minutes ago, so its slot frees in 45.
    expect(Number(refused.headers.get('retry-after'))).toBe(45 * 60)
    expect((await status()).reengagement).toMatchObject({
      spentLastHour: 2,
      maxReengagementsPerHour: 2,
    })
    await harness.clock.advance(45 * MINUTE)
    expect((await send('c@c.us')).status).toBe(200)
  })

  test('a contact already re-engaged today is not charged again, replies are free', async () => {
    harness = await startHarness({
      policy: withContacts({ maxReengagementsPerHour: 1, handshakeMaxMessages: 2 }),
    })
    inbound('a@c.us', 30 * DAY)
    inbound('b@c.us', 30 * DAY)
    inbound('fresh@c.us', MINUTE)
    expect((await send('a@c.us')).status).toBe(200)
    expect((await send('a@c.us')).status).toBe(200)
    expect((await send('fresh@c.us')).status).toBe(200)
    expect((await send('b@c.us')).headers.get('x-guard-reason')).toBe('guard.reengagement_hour')
  })

  test('force skips it and names it in the audit trail', async () => {
    harness = await startHarness({ policy: withContacts({ maxReengagementsPerHour: 0 }) })
    inbound('a@c.us', 30 * DAY)
    expect((await send('a@c.us')).headers.get('x-guard-reason')).toBe('guard.reengagement_hour')
    expect(
      (await send('a@c.us', { 'x-guard-force': '1', 'x-guard-force-reason': 'ok' })).status,
    ).toBe(200)
  })

  test('dormantAfterDays: 1 makes a contact silent for over a day dormant', async () => {
    expect(fromDocument({ contacts: { dormantAfterDays: 1 } }).contacts.dormantAfterDays).toBe(1)
    harness = await startHarness({
      policy: withContacts({ dormantAfterDays: 1, maxReengagementsPerHour: 0 }),
    })
    inbound('yesterday@c.us', 12 * HOUR)
    inbound('twodays@c.us', 2 * DAY)
    expect((await send('yesterday@c.us')).status).toBe(200)
    expect((await send('twodays@c.us')).headers.get('x-guard-reason')).toBe(
      'guard.reengagement_hour',
    )
  })
})

describe('re-engagement share cap', () => {
  test('dormant contacts are held to a share of the day, with a floor', async () => {
    harness = await startHarness({
      policy: withContacts({ maxReengagementShare: 0.25, reengagementShareFloor: 2 }),
    })
    for (let i = 0; i < 4; i++) inbound(`d${i}@c.us`, 30 * DAY)
    // The floor lets a quiet day re-engage a couple of people.
    expect((await send('d0@c.us')).status).toBe(200)
    expect((await send('d1@c.us')).status).toBe(200)
    const refused = await send('d2@c.us')
    expect(refused.status).toBe(403)
    expect(refused.headers.get('x-guard-reason')).toBe('guard.reengagement_share')
    expect(harness.store.queuedDepth()).toBe(0)

    // Conversational traffic raises the allowance: nine replies make N = 11 contacts today,
    // and the third dormant contact needs 3 <= 0.25 * 12.
    for (let i = 0; i < 8; i++) {
      inbound(`r${i}@c.us`, MINUTE)
      expect((await send(`r${i}@c.us`)).status).toBe(200)
    }
    expect((await send('d2@c.us')).headers.get('x-guard-reason')).toBe('guard.reengagement_share')
    inbound('r8@c.us', MINUTE)
    expect((await send('r8@c.us')).status).toBe(200)
    expect((await send('d2@c.us')).status).toBe(200)

    expect((await status()).reengagement).toMatchObject({
      spentToday: 3,
      contactsMessagedToday: 12,
      maxReengagementShare: 0.25,
      reengagementShareFloor: 2,
    })
  })

  test('the share resets with the day', async () => {
    harness = await startHarness({
      policy: withContacts({ maxReengagementShare: 0.1, reengagementShareFloor: 1 }),
    })
    inbound('a@c.us', 30 * DAY)
    inbound('b@c.us', 30 * DAY)
    expect((await send('a@c.us')).status).toBe(200)
    expect((await send('b@c.us')).headers.get('x-guard-reason')).toBe('guard.reengagement_share')
    await harness.clock.advance(DAY)
    expect((await send('b@c.us')).status).toBe(200)
  })

  test('groups do not count as conversational traffic when exempt', async () => {
    harness = await startHarness({
      policy: {
        ...withContacts({ maxReengagementShare: 0.5, reengagementShareFloor: 1 }),
        groups: { mode: 'exempt' },
      },
    })
    inbound('a@c.us', 30 * DAY)
    inbound('b@c.us', 30 * DAY)
    expect((await send('a@c.us')).status).toBe(200)
    expect((await send('g1@g.us')).status).toBe(200)
    expect((await send('g2@g.us')).status).toBe(200)
    // N stays 1 (only `a`), so b needs 2 <= max(1, 0.5 * 2) and is refused.
    expect((await send('b@c.us')).headers.get('x-guard-reason')).toBe('guard.reengagement_share')
  })
})

describe('validation of the new knobs', () => {
  const bad = (contacts: Record<string, unknown>) => () => fromDocument({ contacts })
  test('rejects out-of-range values', () => {
    expect(bad({ maxReengagementsPerHour: -1 })).toThrow(PolicyError)
    expect(bad({ maxReengagementShare: 0 })).toThrow(PolicyError)
    expect(bad({ maxReengagementShare: 1.5 })).toThrow(PolicyError)
    expect(bad({ reengagementShareFloor: -1 })).toThrow(PolicyError)
  })
  test('accepts the documented values, null meaning no hourly limit', () => {
    const p = fromDocument({
      contacts: {
        maxReengagementsPerHour: null,
        maxReengagementShare: 0.25,
        reengagementShareFloor: 0,
      },
    })
    expect(p.contacts.maxReengagementsPerHour).toBe(Number.POSITIVE_INFINITY)
    expect(p.contacts.maxReengagementShare).toBe(0.25)
  })
})
