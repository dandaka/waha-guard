/**
 * `x-guard-force` — an operator-approved override for one send.
 *
 * The shape matters as much as the behaviour. There is no stored permission, no flag on a
 * message row, and no state in which a forced send waits: it goes on this request or it
 * fails on this request. What it may override is a short allowlist of *our own* pacing and
 * volume budgets; consent, safety stops and the platform's own rate limiting are not on it.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { silentLogger } from '../src/observability/log.ts'
import type { DeepPartial, SessionPolicy } from '../src/policy/schema.ts'
import { type Harness, sendRequest, startHarness } from './helpers.ts'

let harness: Harness

afterEach(async () => {
  await harness?.stop()
})

const forced = (chatId: string, reason = 'founder asked for the Monday re-ping') =>
  harness.guard.fetch(
    sendRequest(
      '/api/sendText',
      { session: 'default', chatId, text: 'hello' },
      { headers: { 'x-guard-force': '1', 'x-guard-force-reason': reason } },
    ),
  )

const plain = (chatId: string) =>
  harness.guard.fetch(sendRequest('/api/sendText', { session: 'default', chatId, text: 'hello' }))

const sends = () => harness.waha.requests.filter((r) => r.path === '/api/sendText')

const noHumanTouch: DeepPartial<SessionPolicy> = {
  contacts: { requireHumanTouch: false, handshakeMaxMessages: 1 },
  quietHours: { enabled: false, timezone: 'UTC' },
}

describe('force overrides our own budgets', () => {
  test('it gets past an exhausted handshake cap', async () => {
    harness = await startHarness({ policy: noHumanTouch })
    await plain('a@c.us')
    expect((await plain('a@c.us')).status).toBe(403)

    expect((await forced('a@c.us')).status).toBe(200)
    expect(sends()).toHaveLength(2)
  })

  test('it gets past a spent daily rate window', async () => {
    harness = await startHarness({
      policy: { ...noHumanTouch, rates: { perDay: 1 }, backpressure: { maxWaitMs: 0 } },
    })
    await plain('a@c.us')
    expect((await plain('b@c.us')).status).toBe(429)

    expect((await forced('b@c.us')).status).toBe(200)
  })

  test('it gets past a spent new-contact budget', async () => {
    harness = await startHarness({
      policy: {
        ...noHumanTouch,
        contacts: { requireHumanTouch: false, handshakeMaxMessages: 10, maxNewStrangersPerDay: 1 },
        backpressure: { maxWaitMs: 0 },
      },
    })
    await plain('a@c.us')
    expect((await plain('b@c.us')).status).toBe(429)

    expect((await forced('b@c.us')).status).toBe(200)
  })

  test('a send with nothing in its way is unaffected by the header', async () => {
    harness = await startHarness({ policy: noHumanTouch })
    expect((await forced('a@c.us')).status).toBe(200)
    expect(sends()).toHaveLength(1)
  })
})

describe('force never overrides consent or a safety stop', () => {
  test('an opted-out contact is still refused', async () => {
    harness = await startHarness({
      policy: { ...noHumanTouch, optOut: { enabled: true } },
    })
    harness.store.markOptOut('default', 'a@c.us', harness.clock.now())

    const res = await forced('a@c.us')
    expect(res.status).toBe(403)
    expect(res.headers.get('x-guard-reason')).toBe('guard.opted_out')
    expect(sends()).toHaveLength(0)
  })

  test('a contact no human has ever spoken to is still refused', async () => {
    harness = await startHarness({
      policy: { contacts: { requireHumanTouch: true }, quietHours: { enabled: false } },
    })
    const res = await forced('a@c.us')
    expect(res.status).toBe(403)
    expect(res.headers.get('x-guard-reason')).toBe('guard.no_human_touch')
  })

  test('a stopped session is still refused', async () => {
    harness = await startHarness({ policy: noHumanTouch })
    harness.store.setStopped('default', 'device removed', harness.clock.now())

    const res = await forced('a@c.us')
    expect(res.status).toBe(503)
    expect(res.headers.get('x-guard-reason')).toBe('guard.session_stopped')
  })

  test('quiet hours are still observed', async () => {
    harness = await startHarness({
      policy: {
        ...noHumanTouch,
        quietHours: { enabled: true, timezone: 'UTC', start: '00:00', end: '23:59' },
        backpressure: { maxWaitMs: 0 },
      },
    })
    const res = await forced('a@c.us')
    expect(res.status).toBe(429)
    expect(res.headers.get('x-guard-reason')).toBe('guard.quiet_hours')
    expect(sends()).toHaveLength(0)
  })

  test('a session WhatsApp is actively rate-limiting is still held back', async () => {
    harness = await startHarness({
      policy: {
        ...noHumanTouch,
        timelock: { enabled: true, strangersBlockedWhileDegraded: true },
        backpressure: { maxWaitMs: 0 },
      },
    })
    const now = harness.clock.now()
    harness.store.setTimelock('default', now + 3_600_000, 5, now)

    const res = await forced('a@c.us')
    expect(res.status).toBe(429)
    expect(res.headers.get('x-guard-reason')).toBe('guard.degraded')
  })
})

describe('force is per-request and nothing else', () => {
  test('the guard headers are not forwarded to WAHA', async () => {
    harness = await startHarness({ policy: noHumanTouch })
    await forced('a@c.us')

    const headers = sends()[0]!.headers
    expect(headers['x-guard-force']).toBeUndefined()
    expect(headers['x-guard-force-reason']).toBeUndefined()
  })

  test('the next send is not forced just because the last one was', async () => {
    harness = await startHarness({ policy: noHumanTouch })
    await plain('a@c.us')
    await forced('a@c.us')

    const res = await plain('a@c.us')
    expect(res.status).toBe(403)
    expect(res.headers.get('x-guard-reason')).toBe('guard.handshake_exhausted')
  })

  test('a queue-mode session refuses it rather than parking it', async () => {
    harness = await startHarness({
      policy: { ...noHumanTouch, backpressure: { mode: 'queue' } },
    })
    const res = await forced('a@c.us')
    expect(res.status).toBe(400)
    expect(res.headers.get('x-guard-reason')).toBe('guard.force_not_queueable')
    expect(harness.store.queuedDepth()).toBe(0)
  })

  test('a header that is not an explicit yes does not force anything', async () => {
    harness = await startHarness({ policy: noHumanTouch })
    await plain('a@c.us')

    const res = await harness.guard.fetch(
      sendRequest(
        '/api/sendText',
        { session: 'default', chatId: 'a@c.us', text: 'hello' },
        { headers: { 'x-guard-force': '0' } },
      ),
    )
    expect(res.status).toBe(403)
  })
})

describe('force is loud', () => {
  /** The guard log is the only record of a send that bypasses the mailbox. */
  async function withLoggedHarness(policy: DeepPartial<SessionPolicy>) {
    const lines: { msg: string; fields: Record<string, unknown> }[] = []
    const record = (msg: string, fields?: Record<string, unknown>) =>
      lines.push({ msg, fields: fields ?? {} })
    harness = await startHarness({ policy, log: { ...silentLogger, info: record, warn: record } })
    return lines
  }

  test('every overridden gate is named in the log, with the operators reason', async () => {
    const lines = await withLoggedHarness(noHumanTouch)
    await plain('a@c.us')
    await forced('a@c.us', 'founder approved in session')

    const override = lines.find((l) => l.msg === 'forced past a guard limit')
    expect(override).toBeDefined()
    expect(override!.fields.code).toBe('guard.handshake_exhausted')
    expect(override!.fields.chatId).toBe('a@c.us')
    expect(override!.fields.forceReason).toBe('founder approved in session')
  })

  test('the request is logged even when it overrode nothing', async () => {
    const lines = await withLoggedHarness(noHumanTouch)
    await forced('a@c.us')

    expect(lines.some((l) => l.msg === 'force requested')).toBe(true)
    expect(lines.some((l) => l.msg === 'forced past a guard limit')).toBe(false)
    expect(lines.find((l) => l.msg === 'sent')!.fields.forced).toBe(true)
  })
})
