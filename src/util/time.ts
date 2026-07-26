export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

const FORMATTERS = new Map<string, Intl.DateTimeFormat>()

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(timezone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    FORMATTERS.set(timezone, f)
  }
  return f
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number
}

export function zonedParts(ts: number, timezone: string): ZonedParts {
  const parts = formatter(timezone).formatToParts(new Date(ts))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0'
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  }
}

/** Offset of `timezone` from UTC at instant `ts`, in ms (positive east of Greenwich). */
export function offsetMs(ts: number, timezone: string): number {
  const p = zonedParts(ts, timezone)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asIfUtc - Math.floor(ts / 1000) * 1000
}

/**
 * Epoch ms for a wall-clock time in `timezone`. Two passes because the offset depends on
 * the instant we are solving for — around a DST jump the first guess can be an hour off.
 */
export function fromZoned(
  timezone: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0)
  let ts = naive - offsetMs(naive, timezone)
  ts = naive - offsetMs(ts, timezone)
  return ts
}

export function parseHhMm(value: string): number {
  const [h, m] = value.split(':')
  return Number(h) * 60 + Number(m)
}

export interface QuietHoursConfig {
  enabled: boolean
  timezone: string
  start: string
  end: string
  days: number[]
  quietDays: number[]
}

export interface QuietState {
  quiet: boolean
  /** When the current quiet stretch ends. Only meaningful when `quiet` is true. */
  until: number
  reason: 'quiet-day' | 'quiet-hours' | null
}

/**
 * Whether `now` falls inside quiet hours, and when the stretch ends.
 *
 * A single call only looks one boundary ahead: if the window ends at 09:00 and the next
 * day is a quiet day, this returns 09:00 and the caller re-evaluates. That keeps the
 * date arithmetic honest instead of trying to solve the whole calendar in one pass.
 */
export function quietState(now: number, config: QuietHoursConfig): QuietState {
  if (!config.enabled) return { quiet: false, until: now, reason: null }
  const p = zonedParts(now, config.timezone)

  if (config.quietDays.includes(p.weekday)) {
    return {
      quiet: true,
      until: fromZoned(config.timezone, p.year, p.month, p.day + 1, 0, 0),
      reason: 'quiet-day',
    }
  }

  const start = parseHhMm(config.start)
  const end = parseHhMm(config.end)
  if (start === end) return { quiet: false, until: now, reason: null }

  const minutes = p.hour * 60 + p.minute
  const wraps = start > end
  const inWindow = wraps ? minutes >= start || minutes < end : minutes >= start && minutes < end

  if (!inWindow) return { quiet: false, until: now, reason: null }

  // `days` restricts which days the window *starts* on. For a wrapping window the tail
  // after midnight belongs to the previous day, so that is the day we test.
  if (config.days.length > 0) {
    const startDay = wraps && minutes < end ? (p.weekday + 6) % 7 : p.weekday
    if (!config.days.includes(startDay)) return { quiet: false, until: now, reason: null }
  }

  const endsTomorrow = wraps && minutes >= start
  const endHour = Math.floor(end / 60)
  const endMinute = end % 60
  return {
    quiet: true,
    until: fromZoned(
      config.timezone,
      p.year,
      p.month,
      p.day + (endsTomorrow ? 1 : 0),
      endHour,
      endMinute,
    ),
    reason: 'quiet-hours',
  }
}

/** Total wait until quiet hours are over, following consecutive quiet stretches. */
export function quietUntil(now: number, config: QuietHoursConfig, maxHops = 10): QuietState {
  const state = quietState(now, config)
  if (!state.quiet) return state
  const first = state
  let cursor = state.until
  for (let i = 0; i < maxHops; i++) {
    const next = quietState(cursor, config)
    if (!next.quiet) return { quiet: true, until: cursor, reason: first.reason }
    cursor = next.until
  }
  return { quiet: true, until: cursor, reason: first.reason }
}
