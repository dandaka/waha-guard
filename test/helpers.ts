import type { GuardConfig } from '../src/config.ts'
import { Guard } from '../src/guard.ts'
import { type Logger, silentLogger } from '../src/observability/log.ts'
import { deepMerge } from '../src/policy/load.ts'
import type { DeepPartial, Policy, SessionPolicy } from '../src/policy/schema.ts'
import { presetPolicy } from '../src/policy/schema.ts'
import { Store } from '../src/state/store.ts'
import { TestClock } from '../src/util/clock.ts'

type BunServer = ReturnType<typeof Bun.serve>

export interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

export interface FakeUpstream {
  server: BunServer
  url: string
  requests: RecordedRequest[]
  /** Override the reply for the next matching path. */
  reply: (path: string, response: () => Response) => void
  stop: () => Promise<void>
}

/** A stand-in for WAHA that records what it was asked to do. */
export function startFakeWaha(): FakeUpstream {
  const requests: RecordedRequest[] = []
  const overrides = new Map<string, () => Response>()
  let counter = 0

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = await req.text()
      requests.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(req.headers),
        body,
      })
      const override = overrides.get(url.pathname)
      if (override) return override()
      if (url.pathname === '/api/sessions') {
        return Response.json([{ name: 'default', status: 'WORKING' }], {
          headers: { 'x-waha-version': 'test' },
        })
      }
      if (url.pathname.startsWith('/api/')) {
        counter += 1
        return Response.json(
          {
            id: {
              fromMe: true,
              remote: '123@c.us',
              id: `MSG${counter}`,
              _serialized: `true_123@c.us_MSG${counter}`,
            },
          },
          { headers: { 'x-waha-version': 'test' } },
        )
      }
      return new Response('not found', { status: 404 })
    },
  })

  return {
    server,
    url: `http://127.0.0.1:${server.port}`,
    requests,
    reply: (path, response) => overrides.set(path, response),
    stop: async () => {
      await server.stop(true)
    },
  }
}

export interface WebhookSink {
  server: BunServer
  url: string
  received: { headers: Record<string, string>; body: string }[]
  stop: () => Promise<void>
}

export function startWebhookSink(status = 200): WebhookSink {
  const received: { headers: Record<string, string>; body: string }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push({ headers: Object.fromEntries(req.headers), body: await req.text() })
      return new Response(JSON.stringify({ ok: true }), { status })
    },
  })
  return {
    server,
    url: `http://127.0.0.1:${server.port}/hook`,
    received,
    stop: async () => {
      await server.stop(true)
    },
  }
}

export function testConfig(overrides: Partial<GuardConfig> = {}): GuardConfig {
  return {
    port: 0,
    hostname: '127.0.0.1',
    upstream: 'http://127.0.0.1:1',
    webhookTarget: null,
    webhookPath: '/_guard/webhook',
    statePath: ':memory:',
    policyPath: null,
    upstreamTimeoutMs: 5_000,
    webhookTimeoutMs: 5_000,
    logLevel: 'error',
    apiKey: null,
    upstreamApiKey: null,
    ...overrides,
  }
}

export function testPolicy(
  overrides: DeepPartial<SessionPolicy> = {},
  preset: 'conservative' | 'balanced' | 'off' = 'off',
): Policy {
  return deepMerge(presetPolicy(preset), overrides) as Policy
}

export interface Harness {
  guard: Guard
  clock: TestClock
  store: Store
  waha: FakeUpstream
  sink: WebhookSink | null
  stop: () => Promise<void>
}

export interface HarnessOptions {
  policy?: DeepPartial<SessionPolicy>
  preset?: 'conservative' | 'balanced' | 'off'
  withSink?: boolean
  store?: Store
  /** Deterministic jitter/WPM draws. */
  rng?: () => number
  /** For the tests that assert on what the guard *said*, not just on what it did. */
  log?: Logger
  echoConfirmMs?: number
  config?: Partial<GuardConfig>
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const waha = startFakeWaha()
  const sink = options.withSink ? startWebhookSink() : null
  const clock = new TestClock()
  const store = options.store ?? new Store(':memory:')
  const guard = new Guard({
    config: testConfig({ upstream: waha.url, webhookTarget: sink?.url ?? null, ...options.config }),
    policy: testPolicy(options.policy, options.preset ?? 'off'),
    store,
    clock,
    log: options.log ?? silentLogger,
    rng: options.rng ?? (() => 0.5),
    echoConfirmMs: options.echoConfirmMs ?? 0,
    startWorker: false,
  })
  return {
    guard,
    clock,
    store,
    waha,
    sink,
    stop: async () => {
      await guard.close()
      await waha.stop()
      await sink?.stop()
    },
  }
}

/** Run a request that will park on the clock, advancing time until it settles. */
export async function withClock<T>(
  clock: TestClock,
  promise: Promise<T>,
  advanceMs: number,
): Promise<T> {
  const settled = promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  )
  let remaining = advanceMs
  const step = Math.max(1, Math.ceil(advanceMs / 200))
  for (let i = 0; i < 400 && remaining > 0; i++) {
    const done = await Promise.race([settled, Promise.resolve(null)])
    if (done) break
    await clock.advance(Math.min(step, remaining))
    remaining -= step
  }
  const result = await settled
  if (result.ok) return result.value
  throw result.error
}

export function sendRequest(
  path: string,
  body: Record<string, unknown>,
  init: RequestInit = {},
): Request {
  return new Request(`http://guard.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    body: JSON.stringify(body),
    ...init,
  })
}

/** `res.json()` loosely typed, so a test can reach into a response body without ceremony. */
export async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>
}

export function webhookRequest(events: unknown, path = '/_guard/webhook'): Request {
  return new Request(`http://guard.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-hmac': 'sig123' },
    body: JSON.stringify(events),
  })
}
