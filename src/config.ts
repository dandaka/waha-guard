import type { LogLevel } from './observability/log.ts'
import { loadPolicyFile } from './policy/load.ts'
import { type Policy, presetPolicy } from './policy/schema.ts'

export interface GuardConfig {
  port: number
  hostname: string
  upstream: string
  webhookTarget: string | null
  /**
   * Per-session webhook targets, for a WAHA container holding more than one session.
   * A session named here forwards there; anything else falls back to `webhookTarget`.
   *
   * Without this, every session in a multi-session container forwards to one URL — and
   * since the app tells accounts apart by the `?account=` on that URL, all the lines
   * would arrive labelled as whichever one the URL names.
   */
  webhookTargets: Record<string, string>
  webhookPath: string
  statePath: string
  policyPath: string | null
  upstreamTimeoutMs: number
  webhookTimeoutMs: number
  logLevel: LogLevel
  /** When set, /_guard endpoints (except /_guard/health) require this key in x-api-key. */
  apiKey: string | null
  /**
   * WAHA's own API key, for the few calls the guard makes on its own behalf rather than on
   * a caller's (resolving a LID to a phone). Proxied traffic carries the caller's key and
   * does not need this. Unset is fine — LID resolution simply falls back to the alt JID that
   * inbound payloads already carry.
   */
  upstreamApiKey: string | null
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

/**
 * `GUARD_WEBHOOK_TARGETS` — JSON object mapping session name to webhook URL, e.g.
 * `{"pedro":"https://api.example.com/hook?account=pedro","alex":"…?account=alex"}`.
 *
 * Every value is URL-checked at boot for the same reason `GUARD_UPSTREAM` is: a typo here
 * is otherwise invisible until a real inbound message is dropped, and inbound is the half
 * nobody is watching when they deploy.
 */
function readWebhookTargets(env: Record<string, string | undefined>): Record<string, string> {
  const raw = env.GUARD_WEBHOOK_TARGETS
  if (!raw || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ConfigError(`GUARD_WEBHOOK_TARGETS is not valid JSON: ${raw}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('GUARD_WEBHOOK_TARGETS must be a JSON object of session -> URL')
  }
  const targets: Record<string, string> = {}
  for (const [session, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new ConfigError(`GUARD_WEBHOOK_TARGETS["${session}"] must be a string URL`)
    }
    requireHttpUrl(`GUARD_WEBHOOK_TARGETS["${session}"]`, value)
    targets[session] = value
  }
  return targets
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

  const logLevel = env.GUARD_LOG_LEVEL ?? 'info'
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new ConfigError(
      `GUARD_LOG_LEVEL must be debug|info|warn|error, got ${JSON.stringify(logLevel)}`,
    )
  }

  return {
    port: num('GUARD_PORT', 3000, env),
    hostname: env.GUARD_HOST ?? '0.0.0.0',
    upstream: upstream.replace(/\/+$/, ''),
    webhookTarget: target,
    webhookTargets: readWebhookTargets(env),
    webhookPath: env.GUARD_WEBHOOK_PATH ?? '/_guard/webhook',
    statePath: env.GUARD_STATE ?? '/var/lib/guard/guard.sqlite',
    policyPath: env.GUARD_POLICY ?? null,
    upstreamTimeoutMs: num('GUARD_UPSTREAM_TIMEOUT_MS', 60_000, env),
    webhookTimeoutMs: num('GUARD_WEBHOOK_TIMEOUT_MS', 15_000, env),
    logLevel: logLevel as LogLevel,
    apiKey: env.GUARD_API_KEY || null,
    upstreamApiKey: env.GUARD_UPSTREAM_API_KEY || null,
  }
}

export async function loadPolicy(config: GuardConfig): Promise<Policy> {
  if (!config.policyPath) return presetPolicy('conservative')
  return loadPolicyFile(config.policyPath)
}
