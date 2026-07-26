import { describe, expect, test } from 'bun:test'
import { deepMerge, forSession, fromDocument, PolicyError } from '../src/policy/load.ts'
import { presetPolicy } from '../src/policy/schema.ts'

describe('policy presets', () => {
  test('conservative is the default when the document is empty', () => {
    expect(fromDocument(null).preset).toBe('conservative')
    expect(fromDocument({}).preset).toBe('conservative')
  })

  test('conservative requires a human touch, balanced does not', () => {
    expect(presetPolicy('conservative').contacts.requireHumanTouch).toBe(true)
    expect(presetPolicy('balanced').contacts.requireHumanTouch).toBe(false)
  })

  test('off disables every gate but keeps the guard in the path', () => {
    const off = presetPolicy('off')
    expect(off.quietHours.enabled).toBe(false)
    expect(off.warmup.enabled).toBe(false)
    expect(off.replyRatio.enabled).toBe(false)
    expect(off.typing.enabled).toBe(false)
    expect(off.rates.minSpacingMs).toBe(0)
    expect(off.routes.unknownSends).toBe('pass')
  })

  test('conservative is stricter than balanced on every rate', () => {
    const c = presetPolicy('conservative').rates
    const b = presetPolicy('balanced').rates
    expect(c.perMinute).toBeLessThan(b.perMinute)
    expect(c.perHour).toBeLessThan(b.perHour)
    expect(c.perDay).toBeLessThan(b.perDay)
    expect(c.minSpacingMs).toBeGreaterThan(b.minSpacingMs)
  })
})

describe('deepMerge', () => {
  test('merges nested objects and replaces arrays wholesale', () => {
    const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2, 3] }, { a: { c: 9 }, list: [7] })
    expect(merged).toEqual({ a: { b: 1, c: 9 }, list: [7] })
  })
})

describe('document loading', () => {
  test('overrides land on top of the named preset', () => {
    const policy = fromDocument({
      preset: 'balanced',
      rates: { perMinute: 2 },
      contacts: { requireHumanTouch: true },
    })
    expect(policy.rates.perMinute).toBe(2)
    // untouched fields still come from the preset
    expect(policy.rates.perHour).toBe(presetPolicy('balanced').rates.perHour)
    expect(policy.contacts.requireHumanTouch).toBe(true)
  })

  test('null means unlimited', () => {
    const policy = fromDocument({ rates: { perDay: null } })
    expect(policy.rates.perDay).toBe(Number.POSITIVE_INFINITY)
  })

  test('per-session overrides apply only to that session', () => {
    const policy = fromDocument({
      preset: 'conservative',
      sessions: { sales: { rates: { perMinute: 1 }, quietHours: { timezone: 'Europe/Lisbon' } } },
    })
    expect(forSession(policy, 'sales').rates.perMinute).toBe(1)
    expect(forSession(policy, 'sales').quietHours.timezone).toBe('Europe/Lisbon')
    expect(forSession(policy, 'support').rates.perMinute).toBe(
      presetPolicy('conservative').rates.perMinute,
    )
  })

  test('the resolved session policy carries no nested sessions map', () => {
    const policy = fromDocument({ sessions: { a: {} } })
    expect('sessions' in forSession(policy, 'a')).toBe(false)
  })

  test('unknown preset is rejected by name', () => {
    expect(() => fromDocument({ preset: 'yolo' })).toThrow(PolicyError)
  })

  test('a malformed quiet-hours window is rejected, not silently ignored', () => {
    expect(() => fromDocument({ quietHours: { enabled: true, start: '9am' } })).toThrow(
      /expected HH:MM/,
    )
  })

  test('an unknown timezone is rejected', () => {
    expect(() => fromDocument({ quietHours: { enabled: true, timezone: 'Mars/Olympus' } })).toThrow(
      /unknown IANA zone/,
    )
  })

  test('an invalid per-session override is rejected too', () => {
    expect(() =>
      fromDocument({ sessions: { sales: { quietHours: { enabled: true, end: '25:00' } } } }),
    ).toThrow(/sessions.sales/)
  })

  test('an unsorted warmup schedule is rejected', () => {
    expect(() =>
      fromDocument({
        warmup: {
          enabled: true,
          schedule: [
            { fromDay: 7, maxPerDay: 10, maxNewContactsPerDay: 2 },
            { fromDay: 0, maxPerDay: 5, maxNewContactsPerDay: 1 },
          ],
        },
      }),
    ).toThrow(/sorted by fromDay/)
  })
})
