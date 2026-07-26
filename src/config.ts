import type { LogLevel } from './observability/log.ts'
import { loadPolicyFile } from './policy/load.ts'
import { type Policy, presetPolicy } from './policy/schema.ts'

export interface GuardConfig {
  port: number
  hostname: string
  upstream: string
  webhookTarget: string | null
  webhookPath: string
  statePath: string
  policyPath: string | null
  upstreamTimeoutMs: number
  webhookTimeoutMs: number
  logLevel: LogLevel
}

export class ConfigError extends Error {}

/**
 * `new URL()` alone is not enough: `waha:3000` parses fine as a URL with scheme `waha:`,
 * and the mistake would only surface as an opaque fetch failure on the first send.
 */
function requireHttpUrl(name: string, value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`${name} is not a URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${name} must be an http(s) URL, got ${value}`)
  }
}

function num(name: string, fallback: number, env: Record<string, string | undefined>): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value))
    throw new ConfigError(`${name} must be a number, got ${JSON.stringify(raw)}`)
  return value
}

export function readConfig(env: Record<string, string | undefined> = process.env): GuardConfig {
  const upstream = env.GUARD_UPSTREAM
  if (!upstream) {
    throw new ConfigError('GUARD_UPSTREAM is required, e.g. GUARD_UPSTREAM=http://waha:3000')
  }
  requireHttpUrl('GUARD_UPSTREAM', upstream)
  const target = env.GUARD_WEBHOOK_TARGET ?? null
  if (target) requireHttpUrl('GUARD_WEBHOOK_TARGET', target)

  return {
    port: num('GUARD_PORT', 3000, env),
    hostname: env.GUARD_HOST ?? '0.0.0.0',
    upstream: upstream.replace(/\/+$/, ''),
    webhookTarget: target,
    webhookPath: env.GUARD_WEBHOOK_PATH ?? '/_guard/webhook',
    statePath: env.GUARD_STATE ?? '/var/lib/guard/guard.sqlite',
    policyPath: env.GUARD_POLICY ?? null,
    upstreamTimeoutMs: num('GUARD_UPSTREAM_TIMEOUT_MS', 60_000, env),
    webhookTimeoutMs: num('GUARD_WEBHOOK_TIMEOUT_MS', 15_000, env),
    logLevel: (env.GUARD_LOG_LEVEL as LogLevel) ?? 'info',
  }
}

export async function loadPolicy(config: GuardConfig): Promise<Policy> {
  if (!config.policyPath) return presetPolicy('conservative')
  return loadPolicyFile(config.policyPath)
}
