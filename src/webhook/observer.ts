import type { Logger } from '../observability/log.ts'
import type { Metrics } from '../observability/metrics.ts'
import { forSession } from '../policy/load.ts'
import type { Policy } from '../policy/schema.ts'
import type { Store } from '../state/store.ts'
import type { Clock } from '../util/clock.ts'
import { ackLevel, isGroupChatId, observeMessage } from '../waha/message.ts'

export interface WahaEvent {
  event: string
  session: string
  payload: unknown
}

export interface ObserverDeps {
  store: Store
  policy: () => Policy
  clock: Clock
  log: Logger
  metrics: Metrics
  /**
   * WAHA can deliver `message.any` for our own send before the send's HTTP response has
   * come back to us, so an unmatched outbound echo is re-checked once after this delay
   * before it is treated as a human touch. Without it, the guard credits itself with the
   * human first contact it is supposed to be requiring.
   */
  echoConfirmMs?: number
}

const DEFAULT_ECHO_CONFIRM_MS = 5_000
/** How far back to look for a reserved-but-unidentified send when matching an echo. */
const ECHO_LOOKBACK_MS = 120_000

export function parseEvents(body: unknown): WahaEvent[] {
  const items = Array.isArray(body) ? body : [body]
  const out: WahaEvent[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const event = record.event
    const session = record.session
    if (typeof event !== 'string') continue
    out.push({
      event,
      session: typeof session === 'string' && session ? session : 'default',
      payload: record.payload,
    })
  }
  return out
}

export function normalizeForOptOut(body: string): string {
  return body
    .toLowerCase()
    .replace(/[.!?,;:'"()[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export class Observer {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: ObserverDeps) {}

  close(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  handle(event: WahaEvent): void {
    this.deps.metrics.inc('webhook_events_total', { event: event.event })
    switch (event.event) {
      case 'message':
      case 'message.any':
        this.onMessage(event)
        break
      case 'message.ack':
        this.onAck(event)
        break
      case 'session.status':
        this.onSessionStatus(event)
        break
      default:
        break
    }
  }

  private onMessage(event: WahaEvent): void {
    const { store, clock, log } = this.deps
    const message = observeMessage(event.payload)
    if (!message?.chatId) return
    const now = clock.now()

    if (!message.fromMe) {
      const fresh = store.recordInbound(event.session, message.chatId, message.ids[0] ?? null, now)
      if (!fresh) return
      this.deps.metrics.inc('inbound_total', { session: event.session })
      this.checkOptOut(event.session, message.chatId, message.body, now)
      return
    }

    // Outbound. Ours, or typed on the phone?
    if (message.ids.some((id) => store.isGuardSend(id))) return
    if (store.hasUnidentifiedSend(event.session, message.chatId, now - ECHO_LOOKBACK_MS)) return

    const delay = this.deps.echoConfirmMs ?? DEFAULT_ECHO_CONFIRM_MS
    const commit = () => {
      if (message.ids.some((id) => store.isGuardSend(id))) return
      const recorded = store.recordHumanOutbound(
        event.session,
        message.chatId!,
        message.ids[0] ?? null,
        clock.now(),
      )
      if (!recorded) return
      this.deps.metrics.inc('human_outbound_total', { session: event.session })
      log.info('human touch observed', { session: event.session, chatId: message.chatId })
      // A human replying to someone who opted out is an explicit override.
      const contact = store.getContact(event.session, message.chatId!)
      if (contact?.state === 'opted_out') store.clearOptOut(event.session, message.chatId!)
    }

    if (delay <= 0) {
      commit()
      return
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      commit()
    }, delay)
    // Bookkeeping must not keep the process alive on shutdown.
    if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref()
    this.timers.add(timer)
  }

  private checkOptOut(session: string, chatId: string, body: string, now: number): void {
    const policy = forSession(this.deps.policy(), session)
    if (!policy.optOut.enabled || !body) return
    // One member typing "stop" is not the group asking to be muted, and treating it that way
    // would let any participant silence a channel for everyone. Groups opt out by hand.
    if (isGroupChatId(chatId)) return
    const normalized = normalizeForOptOut(body)
    if (!policy.optOut.keywords.some((k) => normalized === normalizeForOptOut(k))) return
    this.deps.store.markOptOut(session, chatId, now)
    this.deps.metrics.inc('opt_outs_total', { session })
    this.deps.log.info('opt-out recorded', { session, chatId })
  }

  private onAck(event: WahaEvent): void {
    const message = observeMessage(event.payload)
    const ack = ackLevel(event.payload)
    if (!message || ack === null) return
    for (const id of message.ids) {
      if (this.deps.store.recordAck(id, ack, this.deps.clock.now())) {
        this.deps.metrics.inc('acks_total', { session: event.session, ack: String(ack) })
        break
      }
    }
  }

  private onSessionStatus(event: WahaEvent): void {
    const payload = event.payload as { status?: unknown } | null
    const status = typeof payload?.status === 'string' ? payload.status.toUpperCase() : null
    if (!status) return
    const now = this.deps.clock.now()
    // A session that is not WORKING cannot send; a session that FAILED or logged out is
    // the shape of an account action, and the right move is to stop, loudly.
    const halting = ['FAILED', 'STOPPED', 'SCAN_QR_CODE'].includes(status)
    if (halting) {
      this.deps.store.setStopped(event.session, `session status ${status}`, now)
      this.deps.metrics.inc('session_halts_total', { session: event.session, status })
      this.deps.log.error('session is not able to send — outbound stopped', {
        session: event.session,
        status,
      })
    } else if (status === 'WORKING') {
      const existing = this.deps.store.getSession(event.session)
      if (existing?.stopped_reason) {
        this.deps.store.setStopped(event.session, null, now)
        this.deps.log.info('session recovered — outbound resumed', { session: event.session })
      }
    }
  }
}
