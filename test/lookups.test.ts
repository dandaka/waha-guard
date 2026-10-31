import { afterEach, describe, expect, test } from 'bun:test'
import { classifyPath } from '../src/proxy/routes.ts'
import { type Harness, startHarness } from './helpers.ts'

// On 2026-10-31 a retry loop made about 41,000 number lookups in one night on eight
// numbers, and WhatsApp banned the line. Each lookup is a contact query on WhatsApp.

let harness: Harness
afterEach(async () => {
  await harness?.stop()
})

const HOUR = 60 * 60 * 1000
const lookups = {
  enabled: true,
  positiveTtlMs: 24 * HOUR,
  negativeTtlMs: HOUR,
  maxPerNumberPerHour: 2,
  maxPerHour: 5,
  maxPerDay: 8,
}

async function start(overrides: Partial<typeof lookups> = {}) {
  harness = await startHarness({ policy: { lookups: { ...lookups, ...overrides } } })
  harness.waha.reply('/api/checkNumberStatus', () => {
    const phone = new URL(harness.waha.requests.at(-1)!.path, 'http://x').searchParams.get('phone')!
    return Response.json({ numberExists: !phone.startsWith('000'), chatId: phone })
  })
}

const check = (phone: string, session = 'pedro') =>
  harness.guard.fetch(
    new Request(`http://guard.local/api/checkNumberStatus?phone=${phone}@c.us&session=${session}`),
  )
const upstreamLookups = () =>
  harness.waha.requests.filter((r) => r.path.startsWith('/api/checkNumberStatus')).length

describe('number lookup routes', () => {
  test('lookups are their own route kind; other GETs still pass through', () => {
    const opts = { waived: new Set<string>() }
    expect(classifyPath('/api/checkNumberStatus', 'GET', opts).kind).toBe('lookup')
    expect(classifyPath('/api/contacts/check-exists', 'GET', opts).kind).toBe('lookup')
    const scoped = classifyPath('/api/pedro/contacts/check-exists', 'GET', opts)
    expect(scoped).toMatchObject({ kind: 'lookup', sessionFromPath: 'pedro' })
    expect(classifyPath('/api/contacts', 'GET', opts).kind).toBe('passthrough')
  })
})

describe('number lookups', () => {
  test('a positive answer is served from the record, not asked again', async () => {
    await start()
    for (let i = 0; i < 50; i++) {
      const res = await check('351912345678')
      expect(res.status).toBe(200)
      expect(((await res.json()) as { numberExists: boolean }).numberExists).toBe(true)
    }
    expect(upstreamLookups()).toBe(1)
  })

  test('the record expires: positive after its TTL, negative sooner', async () => {
    await start()
    await check('351912345678')
    await check('000111222333')
    await harness.clock.advance(HOUR + 1)
    await check('351912345678')
    await check('000111222333')
    expect(upstreamLookups()).toBe(3)
    await harness.clock.advance(24 * HOUR)
    await check('351912345678')
    expect(upstreamLookups()).toBe(4)
  })

  test('a session over its hourly cap gets a 429 with a retry time for new numbers', async () => {
    await start()
    for (let i = 0; i < 5; i++) expect((await check(`35191000000${i}`)).status).toBe(200)
    const refused = await check('351910000009')
    expect(refused.status).toBe(429)
    const body = (await refused.json()) as { error: string; retryAfterMs: number }
    expect(body.error).toBe('guard.lookup_budget')
    expect(body.retryAfterMs).toBeGreaterThan(0)
    expect(body.retryAfterMs).toBeLessThanOrEqual(HOUR)
    expect(upstreamLookups()).toBe(5)
    // An answer already on record is still given while the cap is full.
    expect((await check('351910000001')).status).toBe(200)
    // Caps are per session.
    expect((await check('351910000009', 'assistente')).status).toBe(200)
  })

  test('the daily cap holds across hours', async () => {
    await start()
    for (let i = 0; i < 8; i++) {
      await check(`35192000000${i}`)
      await harness.clock.advance(HOUR / 2)
    }
    const res = await check('351929999999')
    expect(res.status).toBe(429)
    expect(((await res.json()) as { message: string }).message).toContain('8 per day')
  })

  test('one number cannot be looked up over and over even when its answer keeps expiring', async () => {
    await start({ negativeTtlMs: 0 })
    await check('000111222333')
    await check('000111222333')
    const third = await check('000111222333')
    // The last answer on record is returned instead of asking WhatsApp a third time.
    expect(third.status).toBe(200)
    expect(third.headers.get('x-guard-lookup')).toBe('stale')
    expect(upstreamLookups()).toBe(2)
  })

  test('an upstream error is passed through and not recorded as an answer', async () => {
    await start()
    harness.waha.reply('/api/checkNumberStatus', () =>
      Response.json({ error: 'Session status is not as expected' }, { status: 422 }),
    )
    expect((await check('351912345678')).status).toBe(422)
    expect(harness.store.getNumberCheck('pedro', '351912345678')).toBeNull()
  })

  test('the status endpoint reports lookups against the caps', async () => {
    await start()
    harness.store.ensureSession('pedro', harness.clock.now())
    await check('351912345678')
    await check('351912345679')
    const res = await harness.guard.fetch(new Request('http://guard.local/_guard/status'))
    const status = (await res.json()) as { sessions: { session: string; lookups: unknown }[] }
    const pedro = status.sessions.find((s) => s.session === 'pedro')
    expect(pedro?.lookups).toMatchObject({ lastHour: 2, lastDay: 2, maxPerHour: 5 })
  })

  test('the off preset leaves lookups untouched', async () => {
    harness = await startHarness()
    harness.waha.reply('/api/checkNumberStatus', () => Response.json({ numberExists: true }))
    for (let i = 0; i < 3; i++) await check('351912345678')
    expect(upstreamLookups()).toBe(3)
  })
})
