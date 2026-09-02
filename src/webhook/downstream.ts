import type { Logger } from '../observability/log.ts'
import type { Metrics } from '../observability/metrics.ts'

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host'])

export interface DownstreamOptions {
  /** Fallback for any session not named in `targets`. */
  target: string | null
  /** Per-session overrides, for a WAHA container holding more than one session. */
  targets?: Record<string, string>
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
    return this.options.target !== null || Object.keys(this.options.targets ?? {}).length > 0
  }

  /**
   * Where a given session's events go. `null` means observe-only.
   *
   * A session absent from `targets` falls back to the single `target` — which keeps the
   * single-session deployment working unchanged, and is the right default when one app
   * endpoint serves every line.
   */
  targetFor(session: string | null): string | null {
    const { target, targets } = this.options
    if (session && targets && Object.hasOwn(targets, session)) return targets[session]!
    return target
  }

  async forward(req: Request, body: Uint8Array, session: string | null = null): Promise<Response> {
    const { timeoutMs, log, metrics } = this.options
    const target = this.targetFor(session)
    if (!target) {
      if (this.configured) {
        // Targets exist but none covers this session. Saying 200 here would silently drop
        // one account's entire inbound while the other lines look healthy — the failure is
        // invisible precisely because the container is shared. 502 makes WAHA retry and
        // puts it in the log.
        metrics.inc('webhook_forward_errors_total')
        log.error('no webhook target for session — refusing so WAHA retries', { session })
        return Response.json(
          { ok: false, error: `no webhook target configured for session ${session}` },
          { status: 502 },
        )
      }
      // Nothing configured at all: the guard still observed the event, and saying 200 is
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
    const { timeoutMs, log, metrics } = this.options
    const target = this.targetFor(session)
    if (!target) {
      // Unlike `forward`, there is no upstream to retry a guard event — so an unroutable
      // one is logged and dropped rather than silently discarded.
      if (this.configured) log.error('no webhook target for guard event', { event, session })
      return
    }
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
