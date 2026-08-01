import type { Logger } from '../observability/log.ts'
import type { Metrics } from '../observability/metrics.ts'
import { forSession } from '../policy/load.ts'
import type { Policy } from '../policy/schema.ts'
import type { Store } from '../state/store.ts'
import type { Clock } from '../util/clock.ts'
import { isLidChatId, phoneChatIdFromJid } from '../waha/identity.ts'
import {
  ackLevel,
  INTERACTION_EVENTS,
  isGroupChatId,
  type ObservedMessage,
  observeInteraction,
  observeMessage,
} from '../waha/message.ts'
import { applySessionStatus } from '../waha/session-health.ts'

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
  /**
   * Ask WAHA which phone is behind a LID. Optional and best-effort: the payload's own alt
   * JID resolves the common case with no round trip, and an unresolved LID is recorded
   * under its own name rather than dropped.
   */
  resolveLid?: (session: string, lid: string) => Promise<string | null>
}

const DEFAULT_ECHO_CONFIRM_MS = 5_000
/** How far back to look for a reserved-but-unidentified send when matching an echo. */
const ECHO_LOOKBACK_MS = 120_000
/** Don't re-ask WAHA about a LID it has already failed to resolve more often than this. */
const LID_RETRY_MS = 300_000

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
  /** LIDs currently being looked up, and when each was last attempted. */
  private readonly lidLookups = new Map<string, number>()

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
        if (INTERACTION_EVENTS.has(event.event)) this.onInteraction(event)
        break
    }
  }

  /**
   * A call, a reaction, a poll vote, a deletion — something they did that is not a message.
   *
   * Recorded through `recordInbound`, the same path a message takes, because the three
   * things it writes are all true of an interaction: `human_touch_at` (they have engaged
   * with us, so a reply is not cold outreach), `state = known`, and `in_count`.
   *
   * `in_count` is the one worth pausing on, because two gates read it and this widens what
   * it counts. `opensAStranger` uses it to decide whether a first send is us cold-opening
   * someone — and a person who just rang us is not a stranger we chose off a list.
   * `handshake` uses it to lift the unanswered-messages-per-day cap — and a 👍 on "consegue
   * quinta às 8?" is an answer. Both readings stay true. Both also read it only as `> 0`
   * versus `=== 0`, so an interaction that inflates the count (an edit of a message already
   * counted, say) changes no decision.
   */
  private onInteraction(event: WahaEvent): void {
    const { store, clock, log } = this.deps
    const interaction = observeInteraction(event.event, event.payload)
    // Ours: reacting to our own message says nothing about them.
    if (!interaction || interaction.fromMe) return
    const now = clock.now()
    const chatId = this.identify(event.session, interaction, now)
    if (!store.recordInbound(event.session, chatId, interaction.ids[0] ?? null, now)) return
    this.deps.metrics.inc('inbound_total', { session: event.session })
    this.deps.metrics.inc('interactions_total', { session: event.session, event: event.event })
    log.info('interaction observed', { session: event.session, chatId, event: event.event })
  }

  /**
   * Which contact this message belongs to.
   *
   * The engine names the far end inconsistently — a reply comes in under an anonymous LID
   * while our sends go to the phone — so the raw id is settled into one identity here,
   * before any of it is written down. Everything downstream then agrees on who this is.
   */
  private identify(session: string, message: ObservedMessage, now: number): string {
    const { store, log } = this.deps
    const raw = message.chatId!
    if (!isLidChatId(raw)) return store.resolveChatId(session, raw)

    const phone = phoneChatIdFromJid(message.altJid)
    if (phone) {
      if (store.linkIdentity(session, raw, phone, now)) {
        this.deps.metrics.inc('lid_resolved_total', { session, via: 'payload' })
        log.info('lid resolved to phone', { session, lid: raw, chatId: phone, via: 'payload' })
      }
      return store.resolveChatId(session, raw)
    }

    const known = store.resolveChatId(session, raw)
    // Still a bare LID: record against it so the message is not lost, and go ask WAHA. The
    // answer folds these rows into the phone's when it arrives.
    if (isLidChatId(known)) this.lookupLid(session, raw)
    return known
  }

  private lookupLid(session: string, lid: string): void {
    const { store, clock, log, resolveLid } = this.deps
    if (!resolveLid) return
    const key = `${session}:${lid}`
    const lastAttempt = this.lidLookups.get(key)
    if (lastAttempt !== undefined && clock.now() - lastAttempt < LID_RETRY_MS) return
    this.lidLookups.set(key, clock.now())

    void resolveLid(session, lid)
      .then((phone) => {
        if (!phone) {
          log.warn('could not resolve lid to a phone — keeping the lid', { session, lid })
          return
        }
        if (store.linkIdentity(session, lid, phone, clock.now())) {
          this.deps.metrics.inc('lid_resolved_total', { session, via: 'lids' })
          log.info('lid resolved to phone', { session, lid, chatId: phone, via: 'lids' })
        }
        this.lidLookups.delete(key)
      })
      .catch((error) => log.warn('lid lookup failed', { session, lid, error: String(error) }))
  }

  private onMessage(event: WahaEvent): void {
    const { store, clock, log } = this.deps
    const message = observeMessage(event.payload)
    if (!message?.chatId) return
    const now = clock.now()
    const chatId = this.identify(event.session, message, now)

    if (!message.fromMe) {
      const fresh = store.recordInbound(event.session, chatId, message.ids[0] ?? null, now)
      if (!fresh) return
      this.deps.metrics.inc('inbound_total', { session: event.session })
      this.checkOptOut(event.session, chatId, message.body, now)
      return
    }

    // Outbound. Ours, or typed on the phone?
    if (message.ids.some((id) => store.isGuardSend(id))) return
    if (store.hasUnidentifiedSend(event.session, chatId, now - ECHO_LOOKBACK_MS)) return

    const delay = this.deps.echoConfirmMs ?? DEFAULT_ECHO_CONFIRM_MS
    const commit = () => {
      if (message.ids.some((id) => store.isGuardSend(id))) return
      const recorded = store.recordHumanOutbound(
        event.session,
        chatId,
        message.ids[0] ?? null,
        clock.now(),
      )
      if (!recorded) return
      this.deps.metrics.inc('human_outbound_total', { session: event.session })
      log.info('human touch observed', { session: event.session, chatId })
      // A human replying to someone who opted out is an explicit override.
      const contact = store.getContact(event.session, chatId)
      if (contact?.state === 'opted_out') store.clearOptOut(event.session, chatId)
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

  /**
   * The fast path for session status. The slow path is `SessionMonitor`, which re-reads the
   * same thing on an interval — because this one arrives over a webhook, and a webhook that
   * fails to arrive used to leave the session latched off indefinitely. Both fold through
   * `applySessionStatus` so they cannot disagree.
   */
  private onSessionStatus(event: WahaEvent): void {
    const payload = event.payload as { status?: unknown } | null
    const status = typeof payload?.status === 'string' ? payload.status : null
    if (!status) return
    applySessionStatus(this.deps, event.session, status, 'webhook')
  }
}
