import { afterEach, describe, expect, test } from 'bun:test'
import { type Harness, json, startHarness } from './helpers.ts'

let harness: Harness

afterEach(async () => {
  await harness?.stop()
})

const get = (path: string, init: RequestInit = {}) =>
  harness.guard.fetch(new Request(`http://guard.local${path}`, init))

describe('transparent proxy', () => {
  test('an unintercepted GET reaches WAHA unchanged and comes back unchanged', async () => {
    harness = await startHarness()
    const res = await get('/api/sessions', { headers: { 'x-api-key': 'secret' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ name: 'default', status: 'WORKING' }])
    expect(res.headers.get('x-waha-version')).toBe('test')

    const seen = harness.waha.requests.at(-1)!
    expect(seen.method).toBe('GET')
    expect(seen.path).toBe('/api/sessions')
    expect(seen.headers['x-api-key']).toBe('secret')
  })

  test('the query string survives', async () => {
    harness = await startHarness()
    await get('/api/contacts?limit=10&offset=5')
    expect(harness.waha.requests.at(-1)!.path).toBe('/api/contacts?limit=10&offset=5')
  })

  test('methods other than GET and POST pass through with their bodies', async () => {
    harness = await startHarness()
    await get('/api/contacts/settings', { method: 'PUT', body: '{"muted":true}' })
    const seen = harness.waha.requests.at(-1)!
    expect(seen.method).toBe('PUT')
    expect(seen.body).toBe('{"muted":true}')
  })

  test('an upstream error status is passed through, not translated', async () => {
    harness = await startHarness()
    harness.waha.reply(
      '/api/broken',
      () => new Response('nope', { status: 418, statusText: 'Teapot' }),
    )
    const res = await get('/api/broken')
    expect(res.status).toBe(418)
    expect(await res.text()).toBe('nope')
  })

  test('a 404 from WAHA stays a 404 from the guard', async () => {
    harness = await startHarness()
    const res = await get('/definitely-not-a-route')
    expect(res.status).toBe(404)
  })

  test('the guard reports 502 when WAHA is unreachable, and never a silent success', async () => {
    harness = await startHarness()
    await harness.waha.stop()
    const res = await get('/api/sessions')
    expect(res.status).toBe(502)
    expect(res.headers.get('x-guard-reason')).toBe('guard.upstream_unreachable')
  })

  test('guard endpoints are namespaced so they cannot shadow a WAHA route', async () => {
    harness = await startHarness()
    const health = await get('/_guard/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok' })
    // Nothing under /_guard/ was proxied.
    expect(harness.waha.requests).toHaveLength(0)
  })
})

describe('unknown send routes', () => {
  test('are refused with an actionable message when the policy says block', async () => {
    harness = await startHarness({ policy: { routes: { unknownSends: 'block' } } })
    const res = await get('/api/sendSticker', { method: 'POST', body: '{"chatId":"a@c.us"}' })
    expect(res.status).toBe(403)
    expect(res.headers.get('x-guard-reason')).toBe('guard.unknown_send_route')
    expect((await json(res)).message).toContain('routes.waived')
    expect(harness.waha.requests).toHaveLength(0)
  })

  test('are let through when the policy waives them consciously', async () => {
    harness = await startHarness({
      policy: { routes: { unknownSends: 'block', waived: ['/api/sendSticker'] } },
    })
    const res = await get('/api/sendSticker', { method: 'POST', body: '{"chatId":"a@c.us"}' })
    expect(res.status).toBe(200)
    expect(harness.waha.requests).toHaveLength(1)
  })
})
