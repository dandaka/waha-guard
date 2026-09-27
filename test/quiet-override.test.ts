/**
 * `x-guard-quiet-override` — one send inside quiet hours, for a message that is only worth
 * anything then (a 06:40 check before a 07:20 pickup). It skips `guard.quiet_hours` and no
 * other gate, it needs a reason, and it is as loud in the log as force.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { silentLogger } from '../src/observability/log.ts'
import type { DeepPartial, SessionPolicy } from '../src/policy/schema.ts'
import { type Harness, sendRequest, startHarness } from './helpers.ts'

let harness: Harness

afterEach(async () => {
  await harness?.stop()
})

const overridden = (chatId: string, headers: Record<string, string> = {}) =>
  harness.guard.fetch(
    sendRequest(
      '/api/sendText',
      { session: 'default', chatId, text: 'Já está a caminho?' },
      {
        headers: {
          'x-guard-quiet-override': '1',
          'x-guard-quiet-override-reason': 'start-day check',
          ...headers,
        },
      },
    ),
  )

const plain = (chatId: string) =>
  harness.guard.fetch(sendRequest('/api/sendText', { session: 'default', chatId, text: 'hello' }))

const sends = () => harness.waha.requests.filter((r) => r.path === '/api/sendText')

/** Quiet all day, so every send lands inside the window whatever the clock says. */
const alwaysQuiet: DeepPartial<SessionPolicy> = {
  contacts: { requireHumanTouch: false, handshakeMaxMessages: 1 },
  quietHours: { enabled: true, timezone: 'UTC', start: '00:00', end: '23:59' },
  backpressure: { maxWaitMs: 0 },
}

describe('the override gets one send past quiet hours', () => {
  test('it sends inside quiet hours', async () => {
    harness = await startHarness({ policy: alwaysQuiet })
    const res = await overridden('a@c.us')
    expect(res.status).toBe(200)
    expect(sends()).toHaveLength(1)
  })

  test('without it the same send is held', async () => {
    harness = await startHarness({ policy: alwaysQuiet })
    const res = await plain('a@c.us')
    expect(res.status).toBe(429)
    expect(res.headers.get('x-guard-reason')).toBe('guard.quiet_hours')
    expect(sends()).toHaveLength(0)
  })

  test('a header with no reason is refused, not ignored', async () => {
    harness = await startHarness({ policy: alwaysQuiet })
    const res = await harness.guard.fetch(
      sendRequest(
        '/api/sendText',
        { session: 'default', chatId: 'a@c.us', text: 'hello' },
        { headers: { 'x-guard-quiet-override': '1' } },
      ),
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('x-guard-reason')).toBe('guard.quiet_override_reason_required')
    expect(sends()).toHaveLength(0)
  })

  test('the next send is not overridden just because the last one was', async () => {
    harness = await startHarness({
      policy: { ...alwaysQuiet, contacts: { requireHumanTouch: false, handshakeMaxMessages: 10 } },
    })
    await overridden('a@c.us')
    expect((await plain('a@c.us')).status).toBe(429)
  })
})

describe('the override touches quiet hours and nothing else', () => {
  test('an opted-out contact is still refused', async () => {
    harness = await startHarness({ policy: { ...alwaysQuiet, optOut: { enabled: true } } })
    harness.store.markOptOut('default', 'a@c.us', harness.clock.now())
    const res = await overridden('a@c.us')
    expect(res.status).toBe(403)
    expect(res.headers.get('x-guard-reason')).toBe('guard.opted_out')
  })

  test('a contact no human has ever spoken to is still refused', async () => {
    harness = await startHarness({
      policy: { ...alwaysQuiet, contacts: { requireHumanTouch: true } },
    })
    const res = await overridden('a@c.us')
    expect(res.status).toBe(403)
    expect(res.headers.get('x-guard-reason')).toBe('guard.no_human_touch')
  })

  test('a stopped session is still refused', async () => {
    harness = await startHarness({ policy: alwaysQuiet })
    harness.store.setStopped('default', 'device removed', harness.clock.now())
    const res = await overridden('a@c.us')
    expect(res.status).toBe(503)
    expect(res.headers.get('x-guard-reason')).toBe('guard.session_stopped')
  })

  test('an exhausted handshake cap still holds — this is not force', async () => {
    harness = await startHarness({ policy: alwaysQuiet })
    await overridden('a@c.us')
    const res = await overridden('a@c.us')
    expect(res.status).toBe(403)
    expect(res.headers.get('x-guard-reason')).toBe('guard.handshake_exhausted')
    expect(sends()).toHaveLength(1)
  })

  test('a spent daily window still holds', async () => {
    harness = await startHarness({
      policy: {
        ...alwaysQuiet,
        contacts: { requireHumanTouch: false, handshakeMaxMessages: 10 },
        rates: { perDay: 1 },
      },
    })
    await overridden('a@c.us')
    const res = await overridden('b@c.us')
    expect(res.status).toBe(429)
    expect(res.headers.get('x-guard-reason')).toBe('guard.rate_day')
  })

  test('the headers are not forwarded to WAHA', async () => {
    harness = await startHarness({ policy: alwaysQuiet })
    await overridden('a@c.us')
    const headers = sends()[0]!.headers
    expect(headers['x-guard-quiet-override']).toBeUndefined()
    expect(headers['x-guard-quiet-override-reason']).toBeUndefined()
  })

  test('a queue-mode session refuses it rather than parking it', async () => {
    harness = await startHarness({
      policy: { ...alwaysQuiet, backpressure: { mode: 'queue' } },
    })
    const res = await overridden('a@c.us')
    expect(res.status).toBe(400)
    expect(res.headers.get('x-guard-reason')).toBe('guard.quiet_override_not_queueable')
    expect(harness.store.queuedDepth()).toBe(0)
  })
})

describe('the override is loud', () => {
  async function withLoggedHarness(policy: DeepPartial<SessionPolicy>) {
    const lines: { msg: string; fields: Record<string, unknown> }[] = []
    const record = (msg: string, fields?: Record<string, unknown>) =>
      lines.push({ msg, fields: fields ?? {} })
    harness = await startHarness({ policy, log: { ...silentLogger, info: record, warn: record } })
    return lines
  }

  test('the request and the skipped window are both logged with the reason', async () => {
    const lines = await withLoggedHarness(alwaysQuiet)
    await overridden('a@c.us')

    const requested = lines.find((l) => l.msg === 'quiet override requested')
    expect(requested!.fields.quietOverrideReason).toBe('start-day check')
    const skipped = lines.find((l) => l.msg === 'sent inside quiet hours')
    expect(skipped!.fields.chatId).toBe('a@c.us')
    expect(skipped!.fields.quietOverrideReason).toBe('start-day check')
    expect(lines.find((l) => l.msg === 'sent')!.fields.quietOverride).toBe(true)
  })

  test('outside quiet hours the request is logged but nothing claims a skip', async () => {
    const lines = await withLoggedHarness({
      ...alwaysQuiet,
      quietHours: { enabled: false, timezone: 'UTC' },
    })
    await overridden('a@c.us')
    expect(lines.some((l) => l.msg === 'quiet override requested')).toBe(true)
    expect(lines.some((l) => l.msg === 'sent inside quiet hours')).toBe(false)
  })
})
