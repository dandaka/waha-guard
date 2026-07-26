export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/**
 * Structured JSON lines. Nothing here should ever carry message bodies — the guard sees
 * every message the app sends and has no business writing them to a log.
 */
export function createLogger(
  level: LogLevel = 'info',
  sink: (line: string) => void = console.log,
): Logger {
  const emit = (l: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[l] < ORDER[level]) return
    sink(JSON.stringify({ ts: new Date().toISOString(), level: l, msg: message, ...fields }))
  }
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  }
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
