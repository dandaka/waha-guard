import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deepMerge, forSession, fromDocument, PolicyError } from '../src/policy/load.ts'
import { applyRecovery, recoveryState } from '../src/policy/recovery.ts'
import { type DeepPartial, presetPolicy, type SessionPolicy } from '../src/policy/schema.ts'
import { type SessionStateRow, Store } from '../src/state/store.ts'
import { type Harness, json, sendRequest, startHarness, webhookRequest } from './helpers.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = 1_700_000_000_000

let harness: Harness | undefined
afterEach(async () => {
  await harness?.stop()
  harness = undefined
})

const recoveryOn: DeepPartial<SessionPolicy> = {
  quietHours: { enabled: false, timezone: 'UTC' },
  recovery: { enabled: true },
}

function row(overrides: Partial<SessionStateRow>): SessionStateRow {
  return {
    session: 'default',
    mode: 'normal',
    warmup_started_at: T0 - 100 * DAY,
    timelock_until: null,
    rate_multiplier: 1,
    multiplier_set_at: null,
    stopped_reason: null,
    stopped_status: null,
    stopped_since: null,
    last_outage_ms: null,
    resumed_at: null,
    ...overrides,
  }
}

describe('recovery policy defaults', () => {
  test('off by default, with the documented windows and overlay', () => {
    const r = presetPolicy('conservative').recovery
    expect(r.enabled).toBe(false)
    expect(r.afterOfflineMs).toBe(6 * HOUR)
    expect(r.durationMs).toBe(3 * DAY)
    expect(r.repliesOnlyForMs).toBe(HOUR)
    expect(r.replyWindowMs).toBe(DAY)
    expect(r.overlay).toEqual({
      rates: { perHour: 20, perDay: 120, minSpacingMs: 60_000 },
      contacts: { maxReengagementsPerDay: 5, maxNewStrangersPerDay: 2 },
    })
  })

  test('validation refuses negative windows and a nested recovery block', () => {
    expect(() => fromDocument({ recovery: { afterOfflineMs: -1 } })).toThrow(PolicyError)
    expect(() => fromDocument({ recovery: { durationMs: -1 } })).toThrow(PolicyError)
    expect(() =>
      fromDocument({ recovery: { enabled: true, overlay: { recovery: { enabled: false } } } }),
    ).toThrow(PolicyError)
    // The overlay is validated as the policy it produces.
    expect(() =>
      fromDocument({ recovery: { enabled: true, overlay: { rates: { minSpacingMs: -5 } } } }),
    ).toThrow(PolicyError)
  })

  test('can be switched on for one session only', () => {
    const p = fromDocument({ sessions: { assistente: { recovery: { enabled: true } } } })
    expect(forSession(p, 'assistente').recovery.enabled).toBe(true)
    expect(forSession(p, 'pedro').recovery.enabled).toBe(false)
  })
})

describe('recoveryState / applyRecovery (pure)', () => {
  const policy = deepMerge(presetPolicy('conservative'), {
    recovery: { enabled: true },
  }) as SessionPolicy
  const resumed = row({ last_outage_ms: 2.6 * DAY, resumed_at: T0 })

  test('active for durationMs after a qualifying outage', () => {
    expect(recoveryState(policy, resumed, T0 + 10 * MINUTE)).toEqual({
      active: true,
      repliesOnly: true,
      resumedAt: T0,
      outageMs: 2.6 * DAY,
      until: T0 + 3 * DAY,
      repliesOnlyUntil: T0 + HOUR,
    })
    expect(recoveryState(policy, resumed, T0 + 2 * HOUR).repliesOnly).toBe(false)
    expect(recoveryState(policy, resumed, T0 + 3 * DAY).active).toBe(false)
  })

  test('the overlay is merged on top while active, and only then', () => {
    const during = applyRecovery(policy, resumed, T0 + DAY)
    expect(during.rates.perHour).toBe(20)
    expect(during.rates.perDay).toBe(120)
    expect(during.rates.minSpacingMs).toBe(60_000)
    expect(during.rates.perMinute).toBe(policy.rates.perMinute)
    expect(during.contacts.maxNewStrangersPerDay).toBe(2)
    expect(applyRecovery(policy, resumed, T0 + 4 * DAY)).toBe(policy)
  })

  test('a short outage, no outage, or recovery disabled change nothing', () => {
    const short = row({ last_outage_ms: 5 * HOUR, resumed_at: T0 })
    expect(recoveryState(policy, short, T0).active).toBe(false)
    expect(recoveryState(policy, row({}), T0).active).toBe(false)
    const disabled = presetPolicy('conservative')
    expect(applyRecovery(disabled, resumed, T0)).toBe(disabled)
  })
})

describe('store: outage bookkeeping', () => {
  test('resume records the outage; a flap below the threshold does not overwrite it', () => {
    const store = new Store(':memory:')
    store.setStopped('s', 'session status FAILED', T0, 'FAILED')
    store.setStopped('s', 'session status FAILED', T0 + HOUR, 'FAILED')
    expect(store.setStopped('s', null, T0 + 7 * HOUR, null, 6 * HOUR)).toBe(7 * HOUR)
    expect(store.getSession('s')).toMatchObject({
      last_outage_ms: 7 * HOUR,
      resumed_at: T0 + 7 * HOUR,
    })
    store.setStopped('s', 'session status STOPPED', T0 + 8 * HOUR, 'STOPPED')
    expect(store.setStopped('s', null, T0 + 8 * HOUR + 3_000, null, 6 * HOUR)).toBe(3_000)
    expect(store.getSession('s')).toMatchObject({
      last_outage_ms: 7 * HOUR,
      resumed_at: T0 + 7 * HOUR,
    })
    store.close()
  })

  test('survives a guard restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'waha-guard-recovery-'))
    try {
      const path = join(dir, 'state.db')
      const first = new Store(path)
      first.setStopped('s', 'session status FAILED', T0, 'FAILED')
      first.setStopped('s', null, T0 + DAY)
      first.close()
      const second = new Store(path)
      expect(second.getSession('s')).toMatchObject({ last_outage_ms: DAY, resumed_at: T0 + DAY })
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('recovery after an outage, end to end', () => {
  const statusEvent = (status: string) =>
    webhookRequest({ event: 'session.status', session: 'default', payload: { status } })
  const send = (chatId: string, headers?: Record<string, string>) =>
    harness!.guard.fetch(
      sendRequest('/api/sendText', { session: 'default', chatId, text: 'hi' }, { headers }),
    )
  const policyView = async () =>
    json(await harness!.guard.fetch(new Request('http://guard/_guard/policy?session=default')))

  async function outage(ms: number) {
    await harness!.guard.fetch(statusEvent('FAILED'))
    await harness!.clock.advance(ms)
    await harness!.guard.fetch(statusEvent('WORKING'))
  }

  test('the first hour after a long outage is replies only, then the overlay applies', async () => {
    const lines: { msg: string; fields: Record<string, unknown> }[] = []
    const push = (msg: string, fields?: Record<string, unknown>) =>
      lines.push({ msg, fields: fields ?? {} })
    harness = await startHarness({
      policy: recoveryOn,
      log: { info: push, warn: push, error: () => {}, debug: () => {} },
    })
    await outage(2.6 * DAY)
    const resumedAt = harness.clock.now()
    const active = lines.find((l) => l.msg === 'recovery overlay active')
    expect(active?.fields).toMatchObject({
      session: 'default',
      outageMs: 2.6 * DAY,
      until: resumedAt + 3 * DAY,
    })

    harness.store.recordInbound('default', 'fresh@c.us', 'm1', resumedAt - HOUR)
    harness.store.recordInbound('default', 'old@c.us', 'm2', resumedAt - 2 * DAY)
    expect((await send('fresh@c.us')).status).toBe(200)

    const old = await send('old@c.us')
    expect(old.status).toBe(429)
    expect(old.headers.get('x-guard-reason')).toBe('guard.recovery_replies_only')
    expect(Number(old.headers.get('retry-after'))).toBeGreaterThan(55 * 60)
    expect(Number(old.headers.get('retry-after'))).toBeLessThanOrEqual(60 * 60)
    expect((await send('never@c.us')).headers.get('x-guard-reason')).toBe(
      'guard.recovery_replies_only',
    )
    expect((await send('group@g.us')).headers.get('x-guard-reason')).toBe(
      'guard.recovery_replies_only',
    )
    // Force skips the replies-only window; the overlay's 60s spacing still applies.
    await harness.clock.advance(MINUTE)
    expect((await send('old@c.us', { 'x-guard-force': '1' })).status).toBe(200)

    const view = await policyView()
    expect(view.rates.perHour).toBe(20)
    expect(view.recoveryState).toMatchObject({
      active: true,
      repliesOnly: true,
      resumedAt,
      outageMs: 2.6 * DAY,
      until: resumedAt + 3 * DAY,
    })
    const status = await json(await harness.guard.fetch(new Request('http://guard/_guard/status')))
    expect(status.sessions[0].recovery).toMatchObject({ active: true, resumedAt })

    await harness.clock.advance(HOUR)
    // Spacing from the overlay (60s) is now the binding limit; the cold send is allowed.
    expect((await send('never@c.us')).status).toBe(200)

    await harness.clock.advance(3 * DAY)
    const after = await policyView()
    expect(after.recoveryState.active).toBe(false)
    // The `off` preset has no hourly cap; Infinity serialises as null.
    expect(after.rates.perHour).toBeNull()
  })

  test('an outage shorter than afterOfflineMs does not trigger recovery', async () => {
    harness = await startHarness({ policy: recoveryOn })
    await outage(5 * HOUR)
    expect((await send('never@c.us')).status).toBe(200)
    expect((await policyView()).recoveryState.active).toBe(false)
  })

  test('nothing happens when recovery is disabled', async () => {
    harness = await startHarness({ policy: { quietHours: { enabled: false, timezone: 'UTC' } } })
    await outage(3 * DAY)
    expect((await send('never@c.us')).status).toBe(200)
  })

  test('a manual /_guard/resume after a long stop also starts recovery', async () => {
    harness = await startHarness({ policy: recoveryOn })
    harness.store.setStopped('default', 'device removed', harness.clock.now(), 'FAILED')
    await harness.clock.advance(DAY)
    await harness.guard.fetch(
      new Request('http://guard/_guard/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: 'default' }),
      }),
    )
    expect((await send('never@c.us')).headers.get('x-guard-reason')).toBe(
      'guard.recovery_replies_only',
    )
  })
})
