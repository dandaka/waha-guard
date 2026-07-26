import type { Logger } from '../observability/log.ts'
import type { Metrics } from '../observability/metrics.ts'

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host'])

export interface DownstreamOptions {
  /** Where WAHA's webhooks (and the guard's own events) are forwarded. */
  target: string | null
  timeoutMs: number
  log: Logger
  metrics: Metrics
}

/**
 * Forwards webhooks to the app, verbatim.
 *
 * The guard is in the middle of a delivery path the app already depends on: the body, the
 * headers (including WAHA's HMAC signature) and the response status all pass through, so
 * WAHA's own retry behaviour keeps working end to end.
 */
export class Downstream {
  constructor(private readonly options: DownstreamOptions) {}

  get configured(): boolean {
    return this.options.target !== null
  }

  async forward(req: Request, body: Uint8Array): Promise<Response> {
    const { target, timeoutMs, log, metrics } = this.options
    if (!target) {
      // No downstream configured: the guard still observed the event, and saying 200 is
      // honest — we accepted it.
      return Response.json({ ok: true, forwarded: false })
    }
    const headers = new Headers()
    for (const [name, value] of req.headers) {
      if (HOP_BY_HOP.has(name.toLowerCase())) continue
      headers.append(name, value)
    }
    try {
      const res = await fetch(target, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      metrics.inc('webhook_forwarded_total', { status: String(res.status) })
      const buffer = await res.arrayBuffer()
      return new Response(buffer, { status: res.status, statusText: res.statusText })
    } catch (error) {
      metrics.inc('webhook_forward_errors_total')
      log.error('webhook forward failed', { target, error: String(error) })
      // Tell WAHA it failed so WAHA retries, rather than acknowledging a lost event.
      return Response.json({ ok: false, error: 'downstream webhook unreachable' }, { status: 502 })
    }
  }

  /** Guard-originated events: `guard.sent`, `guard.dropped`. */
  async emit(event: string, session: string, payload: Record<string, unknown>): Promise<void> {
    const { target, timeoutMs, log, metrics } = this.options
    if (!target) return
    try {
      await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event, session, payload, timestamp: Date.now() }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      metrics.inc('guard_events_total', { event })
    } catch (error) {
      log.error('guard event delivery failed', { event, session, error: String(error) })
    }
  }
}
