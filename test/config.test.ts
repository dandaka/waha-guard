import { describe, expect, test } from 'bun:test'
import { ConfigError, readConfig } from '../src/config.ts'
import { Metrics } from '../src/observability/metrics.ts'
import { loadPolicyFile } from '../src/policy/load.ts'

describe('config', () => {
  test('refuses to start without an upstream, and says what to set', () => {
    expect(() => readConfig({})).toThrow(/GUARD_UPSTREAM is required/)
  })

  test('rejects a non-URL upstream rather than failing on the first send', () => {
    expect(() => readConfig({ GUARD_UPSTREAM: 'waha:3000' })).toThrow(ConfigError)
    expect(() =>
      readConfig({ GUARD_UPSTREAM: 'http://waha:3000', GUARD_WEBHOOK_TARGET: 'nope' }),
    ).toThrow(/GUARD_WEBHOOK_TARGET/)
  })

  test('a trailing slash on the upstream does not double up in proxied paths', () => {
    expect(readConfig({ GUARD_UPSTREAM: 'http://waha:3000/' }).upstream).toBe('http://waha:3000')
  })

  test('rejects a non-numeric port instead of listening somewhere surprising', () => {
    expect(() => readConfig({ GUARD_UPSTREAM: 'http://waha:3000', GUARD_PORT: 'eighty' })).toThrow(
      /GUARD_PORT must be a number/,
    )
  })

  test('defaults are the documented ones', () => {
    const config = readConfig({ GUARD_UPSTREAM: 'http://waha:3000' })
    expect(config.port).toBe(3000)
    expect(config.webhookPath).toBe('/_guard/webhook')
    expect(config.statePath).toBe('/var/lib/guard/guard.sqlite')
    expect(config.webhookTarget).toBeNull()
    expect(config.webhookTargets).toEqual({})
    expect(config.optOutCallbackUrl).toBeNull()
  })

  test('rejects an invalid opt-out callback before any consent event is lost', () => {
    expect(() =>
      readConfig({ GUARD_UPSTREAM: 'http://waha:3000', GUARD_OPT_OUT_CALLBACK_URL: 'nope' }),
    ).toThrow(/GUARD_OPT_OUT_CALLBACK_URL/)
  })
})

describe('per-session webhook targets', () => {
  const base = { GUARD_UPSTREAM: 'http://waha:3000' }

  test('parses a session -> URL map', () => {
    const config = readConfig({
      ...base,
      GUARD_WEBHOOK_TARGETS: '{"pedro":"https://app/hook?account=pedro","alex":"https://app/h2"}',
    })
    expect(config.webhookTargets).toEqual({
      pedro: 'https://app/hook?account=pedro',
      alex: 'https://app/h2',
    })
  })

  test('a malformed map fails at boot, not on the first inbound message', () => {
    expect(() => readConfig({ ...base, GUARD_WEBHOOK_TARGETS: '{oops' })).toThrow(/not valid JSON/)
    expect(() => readConfig({ ...base, GUARD_WEBHOOK_TARGETS: '["a"]' })).toThrow(
      /must be a JSON object/,
    )
    expect(() => readConfig({ ...base, GUARD_WEBHOOK_TARGETS: '{"pedro":5}' })).toThrow(
      /must be a string URL/,
    )
  })

  test('a typo in one session URL is caught by name', () => {
    expect(() => readConfig({ ...base, GUARD_WEBHOOK_TARGETS: '{"pedro":"waha:3000"}' })).toThrow(
      /GUARD_WEBHOOK_TARGETS\["pedro"\]/,
    )
  })
})

describe('the shipped example policy', () => {
  test('parses and validates', async () => {
    const policy = await loadPolicyFile(`${import.meta.dir}/../policy.example.yml`)
    expect(policy.preset).toBe('conservative')
    expect(policy.contacts.requireHumanTouch).toBe(true)
    expect(Object.keys(policy.sessions)).toContain('support')
  })
})

describe('metrics', () => {
  test('renders Prometheus text with sorted, escaped labels', () => {
    const metrics = new Metrics()
    metrics.inc('sends_total', { session: 'sales', route: 'sendText' })
    metrics.inc('sends_total', { session: 'sales', route: 'sendText' })
    metrics.observe('typing_plan_ms', 1200, { session: 'sales' })
    metrics.gauge('queue_depth', () => 7)

    const output = metrics.render()
    expect(output).toContain('waha_guard_sends_total{route="sendText",session="sales"} 2')
    expect(output).toContain('waha_guard_typing_plan_ms_count{session="sales"} 1')
    expect(output).toContain('waha_guard_typing_plan_ms_sum{session="sales"} 1200')
    expect(output).toContain('waha_guard_queue_depth 7')
    expect(output).toContain('# TYPE waha_guard_sends_total counter')
  })

  test('gauges are read at render time, not at registration time', () => {
    const metrics = new Metrics()
    let value = 1
    metrics.gauge('depth', () => value)
    expect(metrics.render()).toContain('waha_guard_depth 1')
    value = 5
    expect(metrics.render()).toContain('waha_guard_depth 5')
  })
})
