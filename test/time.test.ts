import { describe, expect, test } from 'bun:test'
import {
  fromZoned,
  offsetMs,
  parseHhMm,
  quietState,
  quietUntil,
  zonedParts,
} from '../src/util/time.ts'

const base = {
  enabled: true,
  timezone: 'Europe/Lisbon',
  start: '21:00',
  end: '09:00',
  days: [] as number[],
  quietDays: [] as number[],
}

function at(iso: string): number {
  return new Date(iso).getTime()
}

describe('zoned time', () => {
  test('reads wall-clock parts in the target zone', () => {
    // 2026-01-15T12:00Z is 13:00 in Berlin (UTC+1 in January).
    const p = zonedParts(at('2026-01-15T12:00:00Z'), 'Europe/Berlin')
    expect(p.hour).toBe(13)
    expect(p.day).toBe(15)
    expect(p.weekday).toBe(4) // Thursday
  })

  test('offset follows daylight saving', () => {
    expect(offsetMs(at('2026-01-15T12:00:00Z'), 'Europe/Berlin')).toBe(3_600_000)
    expect(offsetMs(at('2026-07-15T12:00:00Z'), 'Europe/Berlin')).toBe(7_200_000)
  })

  test('round-trips a wall-clock time back to an instant', () => {
    const ts = fromZoned('Europe/Berlin', 2026, 7, 15, 9, 30)
    expect(new Date(ts).toISOString()).toBe('2026-07-15T07:30:00.000Z')
  })

  test('parses HH:MM into minutes', () => {
    expect(parseHhMm('00:00')).toBe(0)
    expect(parseHhMm('09:30')).toBe(570)
    expect(parseHhMm('23:59')).toBe(1439)
  })
})

describe('quiet hours', () => {
  test('a window that wraps midnight is quiet on both sides of it', () => {
    expect(quietState(at('2026-01-15T22:00:00Z'), base).quiet).toBe(true) // 22:00 local
    expect(quietState(at('2026-01-15T03:00:00Z'), base).quiet).toBe(true) // 03:00 local
    expect(quietState(at('2026-01-15T12:00:00Z'), base).quiet).toBe(false)
  })

  test('the boundary is inclusive at the start and exclusive at the end', () => {
    expect(quietState(at('2026-01-15T21:00:00Z'), base).quiet).toBe(true)
    expect(quietState(at('2026-01-15T09:00:00Z'), base).quiet).toBe(false)
    expect(quietState(at('2026-01-15T08:59:00Z'), base).quiet).toBe(true)
  })

  test('quiet ends at the next end-time, tomorrow when the window wrapped', () => {
    const state = quietState(at('2026-01-15T22:30:00Z'), base)
    expect(new Date(state.until).toISOString()).toBe('2026-01-16T09:00:00.000Z')
  })

  test('a non-wrapping window ends the same day', () => {
    const state = quietState(at('2026-01-15T13:00:00Z'), { ...base, start: '12:00', end: '14:00' })
    expect(new Date(state.until).toISOString()).toBe('2026-01-15T14:00:00.000Z')
  })

  test('disabled means never quiet', () => {
    expect(quietState(at('2026-01-15T23:00:00Z'), { ...base, enabled: false }).quiet).toBe(false)
  })

  test('a whole quiet day beats the hour window', () => {
    const sunday = at('2026-01-18T12:00:00Z')
    const state = quietState(sunday, { ...base, quietDays: [0] })
    expect(state.quiet).toBe(true)
    expect(state.reason).toBe('quiet-day')
    expect(new Date(state.until).toISOString()).toBe('2026-01-19T00:00:00.000Z')
  })

  test('days restricts which day the window starts on', () => {
    // Window only applies to Mondays; Thursday evening is not quiet.
    const thursdayEvening = at('2026-01-15T22:00:00Z')
    expect(quietState(thursdayEvening, { ...base, days: [1] }).quiet).toBe(false)
    const mondayEvening = at('2026-01-19T22:00:00Z')
    expect(quietState(mondayEvening, { ...base, days: [1] }).quiet).toBe(true)
    // The tail after midnight belongs to Monday's window, so Tuesday 03:00 is still quiet.
    const tuesdayNight = at('2026-01-20T03:00:00Z')
    expect(quietState(tuesdayNight, { ...base, days: [1] }).quiet).toBe(true)
  })

  test('quietUntil chains through a quiet day that follows the window', () => {
    // Saturday 22:00 local with Sunday configured as a quiet day. One boundary lookahead
    // stops at Sunday 09:00; the chained answer runs through all of Sunday and through
    // Monday's small hours, landing on Monday 09:00.
    const saturdayNight = at('2026-01-17T22:00:00Z')
    const config = { ...base, quietDays: [0] }
    expect(new Date(quietState(saturdayNight, config).until).toISOString()).toBe(
      '2026-01-18T09:00:00.000Z',
    )
    expect(new Date(quietUntil(saturdayNight, config).until).toISOString()).toBe(
      '2026-01-19T09:00:00.000Z',
    )
  })

  test('start equal to end means no quiet window at all', () => {
    expect(
      quietState(at('2026-01-15T21:00:00Z'), { ...base, start: '09:00', end: '09:00' }).quiet,
    ).toBe(false)
  })
})
