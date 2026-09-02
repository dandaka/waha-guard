import type { GuardConfig } from './config.ts'
import { createLogger, type Logger } from './observability/log.ts'
import { Metrics } from './observability/metrics.ts'
import { countsNewStrangers, warmupStep } from './pipeline/gates.ts'
import { Sender } from './pipeline/sender.ts'
import { forSession } from './policy/load.ts'
import type { Policy } from './policy/schema.ts'
import { classifyPath, isUnknownSend, KNOWN_SEND_ROUTES } from './proxy/routes.ts'
import { Upstream, UpstreamError } from './proxy/upstream.ts'
import { QueueWorker } from './queue/worker.ts'
import { Store } from './state/store.ts'
import { type Clock, systemClock } from './util/clock.ts'
import type { Rng } from './util/random.ts'
import { chatIdFromSendBody, sessionFromSendBody, textFromSendBody } from './waha/message.ts'
import { SessionMonitor } from './waha/session-health.ts'
import { Downstream } from './webhook/downstream.ts'
import { Observer, parseEvents } from './webhook/observer.ts'

export interface GuardOptions {
  config: GuardConfig
  policy: Policy
  store?: Store
  clock?: Clock
  log?: Logger
  rng?: Rng
  echoConfirmMs?: number
  /** Queue mode drains in-process; tests drive it by hand instead. */
  startWorker?: boolean
  /** Session polling talks to WAHA on a timer; tests call `monitor.pollOnce()` instead. */
  startMonitor?: boolean
}

interface GuardErrorBody {
  error: string
  message: string
  guard: true
  retryAfterMs?: number
}

export class Guard {
  readonly store: Store
  readonly metrics = new Metrics()
  readonly sender: Sender
  readonly observer: Observer
  readonly downstream: Downstream
  readonly worker: QueueWorker
  readonly monitor: SessionMonitor
  private readonly upstream: Upstream
  private readonly log: Logger
  private readonly clock: Clock
  private policy: Policy
  private sequence = 0

  constructor(private readonly options: GuardOptions) {
    this.policy = options.policy
    this.clock = options.clock ?? systemClock
    this.log = options.log ?? createLogger(options.config.logLevel)
    this.store = options.store ?? new Store(options.config.statePath)
    this.upstream = new Upstream({
      base: options.config.upstream,
      timeoutMs: options.config.upstreamTimeoutMs,
    })
    this.downstream = new Downstream({
      target: options.config.webhookTarget,
      targets: options.config.webhookTargets,
      timeoutMs: options.config.webhookTimeoutMs,
      log: this.log,
      metrics: this.metrics,
    })
    this.sender = new Sender({
      policy: () => this.policy,
      store: this.store,
      upstream: this.upstream,
      clock: this.clock,
      metrics: this.metrics,
      log: this.log,
      rng: options.rng,
    })
    this.observer = new Observer({
      store: this.store,
      policy: () => this.policy,
      clock: this.clock,
      log: this.log,
      metrics: this.metrics,
      echoConfirmMs: options.echoConfirmMs,
      resolveLid: (session, lid) => this.resolveLid(session, lid),
      reportOptOut: (event) => this.reportOptOut(event),
    })
    this.worker = new QueueWorker({
      store: this.store,
      sender: this.sender,
      clock: this.clock,
      log: this.log,
      metrics: this.metrics,
      downstream: this.downstream,
    })
    this.monitor = new SessionMonitor({
      store: this.store,
      upstream: this.upstream,
      policy: () => this.policy,
      clock: this.clock,
      log: this.log,
      metrics: this.metrics,
      apiKey: options.config.upstreamApiKey,
    })
    this.registerGauges()
    if (options.startWorker !== false) this.worker.start()
    if (options.startMonitor !== false) this.monitor.start()
  }

  setPolicy(policy: Policy): void {
    this.policy = policy
  }

  async close(): Promise<void> {
    this.monitor.stop()
    await this.worker.stop()
    this.observer.close()
    this.store.close()
  }

  /**
   * Ask WAHA which phone is behind a LID. Returns null on anything unhelpful — a failed
   * lookup leaves the contact recorded under its LID, which the next resolution folds in.
   */
  private async resolveLid(session: string, lid: string): Promise<string | null> {
    // Both parts land in a URL path and the lid arrives from a webhook payload, so only the
    // shape WhatsApp actually issues is allowed through — percent-encoding it instead would
    // change the path WAHA matches on.
    if (!/^\d+@lid$/i.test(lid) || !/^[\w.-]+$/.test(session)) return null
    const headers = new Headers()
    const key = this.options.config.upstreamApiKey
    if (key) headers.set('x-api-key', key)
    const result = await this.upstream
      .getJson<{ pn?: unknown }>(`/api/${session}/lids/${lid}`, headers)
      .catch(() => null)
    return typeof result?.pn === 'string' && result.pn.length > 0 ? result.pn : null
  }

  private registerGauges(): void {
    this.metrics.gauge('queue_depth', () => this.store.queuedDepth())
    this.metrics.gauge(
      'sessions_stopped',
      () => this.store.listSessions().filter((s) => s.stopped_reason !== null).length,
    )
    this.metrics.gauge('sessions_degraded', () => {
      const now = this.clock.now()
      return this.store.listSessions().filter((s) => (s.timelock_until ?? 0) > now).length
    })
  }

  // ---- HTTP ---------------------------------------------------------------

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    try {
      if (url.pathname === this.options.config.webhookPath) return await this.handleWebhook(req)
      if (url.pathname.startsWith('/_guard/')) return await this.handleGuardApi(req, url)

      const policy = this.policy
      const match = classifyPath(url.pathname, req.method, {
        waived: new Set(policy.routes.waived),
      })

      if (match.kind === 'send') return await this.handleSend(req, url, match)
      if (match.kind === 'presence') return await this.handlePresence(req, match)
      this.metrics.inc('proxy_passthrough_total')
      return await this.upstream.pass(req)
    } catch (error) {
      if (error instanceof UpstreamError) {
        this.log.error('upstream unreachable', { path: url.pathname, error: String(error.cause_) })
        return this.guardError(
          502,
          'guard.upstream_unreachable',
          'WAHA is not reachable from the guard',
        )
      }
      this.log.error('guard failure', { path: url.pathname, error: String(error) })
      return this.guardError(500, 'guard.internal_error', 'the guard failed to handle this request')
    }
  }

  private guardError(
    status: number,
    code: string,
    message: string,
    retryAfterMs?: number,
  ): Response {
    const body: GuardErrorBody = { error: code, message, guard: true }
    const headers: Record<string, string> = { 'x-guard-reason': code }
    if (retryAfterMs !== undefined) {
      body.retryAfterMs = Math.max(0, Math.round(retryAfterMs))
      headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)))
    }
    return Response.json(body, { status, headers })
  }

  private async handleSend(
    req: Request,
    url: URL,
    match: ReturnType<typeof classifyPath>,
  ): Promise<Response> {
    const raw = new Uint8Array(await req.arrayBuffer())
    let body: unknown = null
    try {
      body = raw.byteLength > 0 ? JSON.parse(new TextDecoder().decode(raw)) : null
    } catch {
      body = null
    }

    const session = match.sessionFromPath ?? sessionFromSendBody(body) ?? 'default'
    const policy = forSession(this.policy, session)

    if (isUnknownSend(match)) {
      this.metrics.inc('unknown_send_total', { path: url.pathname })
      // Observe mode is a shadow run: it must never change what real traffic does.
      if (policy.routes.unknownSends === 'block' && policy.mode !== 'observe') {
        this.log.warn('refused an unrecognised message-creating route', { path: url.pathname })
        return this.guardError(
          403,
          'guard.unknown_send_route',
          `${url.pathname} looks like it creates a message but the guard does not know it, ` +
            `so it would be an unguarded bypass. Add it to routes.waived to pass it through, ` +
            `or open an issue so it can be guarded properly. Known routes: ${KNOWN_SEND_ROUTES.join(', ')}`,
        )
      }
      this.log.warn('passing an unrecognised message-creating route unguarded', {
        path: url.pathname,
      })
      return this.upstream.pass(req, raw)
    }

    const chatId = chatIdFromSendBody(body)
    if (!chatId) {
      // Without a recipient there is no contact state, so every relationship gate is blind.
      // Passing it through would be a bypass; guessing would be worse.
      if (policy.mode === 'observe') return this.upstream.pass(req, raw)
      return this.guardError(
        400,
        'guard.unidentified_recipient',
        'the guard could not find a chatId in this request, so it cannot apply contact policy',
      )
    }

    const { force, forceReason } = parseForce(req.headers)
    const text = textFromSendBody(body, match.textField ?? null)
    const job = {
      session,
      chatId,
      route: match.name,
      textLength: text.length,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      // The guard's own headers are a statement to the guard, not to WhatsApp, and the
      // queue replays this set verbatim — neither may carry the override onward.
      headers: stripGuardHeaders(req.headers),
      body: raw,
      arrivedAt: this.clock.now(),
      signal: req.signal,
      force,
      forceReason,
    }

    if (policy.backpressure.mode === 'queue') {
      // A forced send goes now or fails now. Accepting it here would mean storing the
      // override on a row and draining it later, which is a place where forced messages
      // wait — the thing that was deleted after 48 died in a queue against 27 released.
      if (force) {
        return this.guardError(
          400,
          'guard.force_not_queueable',
          'x-guard-force is only honoured when backpressure.mode is `block`: a forced send ' +
            'must succeed or fail on this request, never be parked in a queue. Send it ' +
            'without the header, or switch the session to block mode.',
        )
      }
      return this.enqueue(job)
    }

    const result = await this.sender.send(job)
    switch (result.status) {
      case 'sent':
      case 'rejected':
        return result.response
      case 'denied':
        return this.guardError(result.httpStatus, result.code, result.reason)
      case 'deferred':
        return this.guardError(429, result.code, result.reason, result.retryAfterMs)
      case 'unreachable':
        return this.guardError(
          502,
          'guard.upstream_unreachable',
          'WAHA is not reachable from the guard',
        )
    }
  }

  private enqueue(job: {
    session: string
    chatId: string
    route: string
    textLength: number
    method: string
    path: string
    headers: Headers
    body: Uint8Array
  }): Response {
    const now = this.clock.now()
    const guardId = `g_${now.toString(36)}_${(this.sequence++).toString(36)}`
    this.store.enqueue({
      guard_id: guardId,
      session: job.session,
      chat_id: job.chatId,
      route: job.route,
      method: job.method,
      path: job.path,
      headers: JSON.stringify([...job.headers].filter(([name]) => !isPerRequestHeader(name))),
      body: job.body,
      text_length: job.textLength,
      enqueued_at: now,
      not_before: 0,
      attempts: 0,
      state: 'pending',
      last_error: null,
    })
    this.metrics.inc('queue_accepted_total', { session: job.session })
    return Response.json(
      {
        guard: true,
        accepted: true,
        guardId,
        session: job.session,
        chatId: job.chatId,
        statusUrl: `/_guard/queue/${guardId}`,
      },
      { status: 202, headers: { 'x-guard-id': guardId } },
    )
  }

  /**
   * Presence is owned by exactly one side. When the guard owns it, a caller's own typing
   * simulation is swallowed rather than interleaved — two sources of `composing` on one
   * chat is worse than either alone.
   */
  private async handlePresence(
    req: Request,
    match: ReturnType<typeof classifyPath>,
  ): Promise<Response> {
    const raw = new Uint8Array(await req.arrayBuffer())
    let body: unknown = null
    try {
      body = raw.byteLength > 0 ? JSON.parse(new TextDecoder().decode(raw)) : null
    } catch {
      body = null
    }
    const session = match.sessionFromPath ?? sessionFromSendBody(body) ?? 'default'
    const policy = forSession(this.policy, session)
    const typingRoute =
      match.name === 'startTyping' || match.name === 'stopTyping' || match.name === 'presence'
    if (policy.presence === 'guard' && typingRoute) {
      this.metrics.inc('presence_suppressed_total', { session })
      return Response.json({ guard: true, suppressed: true, reason: 'presence.owner=guard' })
    }
    return this.upstream.pass(req, raw)
  }

  private async handleWebhook(req: Request): Promise<Response> {
    if (req.method !== 'POST') return this.guardError(405, 'guard.method_not_allowed', 'POST only')
    const raw = new Uint8Array(await req.arrayBuffer())
    // The session decides which app endpoint this belongs to when one container holds
    // several, so it is read from the payload rather than from the request path — WAHA
    // posts every session's events to the same webhook URL.
    let session: string | null = null
    try {
      const parsed = JSON.parse(new TextDecoder().decode(raw))
      for (const event of parseEvents(parsed)) {
        session ??= event.session
        this.observer.handle(event)
      }
    } catch (error) {
      // Observation is best-effort; forwarding is not. A body we cannot read still belongs
      // to the app.
      this.log.warn('could not observe webhook body', { error: String(error) })
    }
    return this.downstream.forward(req, raw, session)
  }

  private async handleGuardApi(req: Request, url: URL): Promise<Response> {
    const path = url.pathname

    // Health stays open for container healthchecks; everything else can read contact
    // state or clear safety stops, so it honours GUARD_API_KEY when one is configured.
    if (path === '/_guard/health') {
      return Response.json({ status: 'ok', upstream: this.options.config.upstream })
    }

    const apiKey = this.options.config.apiKey
    if (apiKey !== null && req.headers.get('x-api-key') !== apiKey) {
      return this.guardError(401, 'guard.unauthorized', 'x-api-key header is missing or wrong')
    }

    if (path === '/_guard/metrics') {
      return new Response(this.metrics.render(), {
        headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
      })
    }

    if (path === '/_guard/status') {
      const now = this.clock.now()
      return Response.json({
        preset: this.policy.preset,
        webhookTarget: this.options.config.webhookTarget,
        webhookTargets: this.options.config.webhookTargets,
        queueDepth: this.store.queuedDepth(),
        sessions: this.store.listSessions().map((s) => {
          const policy = forSession(this.policy, s.session)
          const step = warmupStep(policy, s, now)
          const budget = countsNewStrangers(policy, this.store, s.session, now)
          return {
            session: s.session,
            stopped: s.stopped_reason,
            // A stop that is still inside the grace window is a reconnect in progress, not
            // an outage — the difference decides whether sends are waiting or failing, and
            // it is the first thing anyone opening this endpoint wants to know.
            stoppedStatus: s.stopped_status,
            stoppedSince: s.stopped_since,
            stoppedKind:
              s.stopped_reason === null
                ? null
                : s.stopped_since !== null &&
                    now - s.stopped_since < policy.sessionHealth.transientGraceMs &&
                    (s.stopped_status === 'STOPPED' || s.stopped_status === 'STARTING')
                  ? 'reconnecting'
                  : 'outage',
            degradedUntil: s.timelock_until && s.timelock_until > now ? s.timelock_until : null,
            rateMultiplier: s.rate_multiplier,
            warmupDay: Math.floor((now - s.warmup_started_at) / 86_400_000),
            // The warmup ramp comes from the preset unless policy.yml overrides it, so an
            // operator reading the mounted file cannot see which caps are actually in force
            // — and two independent new-contact caps means the lower one wins silently.
            newContactCaps: {
              spentToday: budget.spent,
              maxNewStrangersPerDay: policy.contacts.maxNewStrangersPerDay,
              warmupMaxNewContactsPerDay: step?.maxNewContactsPerDay ?? null,
              warmupMaxPerDay: step?.maxPerDay ?? null,
              warmupFromDay: step?.fromDay ?? null,
            },
            inFlight: this.sender.queueDepth(s.session),
            queued: this.store.queuedDepth(s.session),
          }
        }),
      })
    }

    if (path === '/_guard/policy') {
      const session = url.searchParams.get('session')
      return Response.json(session ? forSession(this.policy, session) : this.policy)
    }

    if (path === '/_guard/contact') {
      const session = url.searchParams.get('session') ?? 'default'
      const chatId = url.searchParams.get('chatId')
      if (!chatId)
        return this.guardError(400, 'guard.bad_request', 'chatId query parameter is required')
      const contact = this.store.getContact(session, chatId)
      // `aliases` answers the question this endpoint is usually opened to settle: which
      // ids the guard believes are this one person.
      return contact
        ? Response.json({ ...contact, aliases: this.store.aliasesOf(session, chatId) })
        : this.guardError(404, 'guard.unknown_contact', 'no state recorded for this contact')
    }

    // A bounded, authenticated snapshot for mailbox reconciliation. It is intentionally
    // read-only: the guard owns observation and the app owns its durable projection.
    if (req.method === 'GET' && path === '/_guard/opt-outs') {
      return Response.json({ optOuts: this.store.listOptOuts() })
    }

    if (path.startsWith('/_guard/queue/')) {
      const row = this.store.getQueued(path.slice('/_guard/queue/'.length))
      if (!row) return this.guardError(404, 'guard.unknown_queue_id', 'no such queued send')
      const { body: _body, headers: _headers, ...rest } = row
      return Response.json(rest)
    }

    if (req.method === 'POST' && (path === '/_guard/opt-out' || path === '/_guard/opt-in')) {
      const body = (await req.json().catch(() => null)) as {
        session?: string
        chatId?: string
        eventId?: string
      } | null
      const session = body?.session ?? 'default'
      const chatId = body?.chatId
      if (!chatId) return this.guardError(400, 'guard.bad_request', 'chatId is required')
      if (path === '/_guard/opt-out') {
        const now = this.clock.now()
        this.store.markOptOut(session, chatId, now)
        void this.reportOptOut({
          eventId:
            body?.eventId && typeof body.eventId === 'string'
              ? body.eventId
              : `manual:${session}:${chatId}:${now}`,
          session,
          chatId,
          occurredAt: new Date(now).toISOString(),
        }).catch((error) =>
          this.log.error('opt-out callback failed', { session, chatId, error: String(error) }),
        )
      } else this.store.clearOptOut(session, chatId)
      return Response.json({
        guard: true,
        session,
        chatId,
        state: this.store.getContact(session, chatId)?.state,
      })
    }

    if (req.method === 'POST' && path === '/_guard/contact/human-touch') {
      const body = (await req.json().catch(() => null)) as {
        session?: string
        chatId?: string
        chatIds?: unknown
        touchedAt?: number
      } | null
      const session = body?.session ?? 'default'
      const ids = Array.isArray(body?.chatIds)
        ? body.chatIds.filter((v): v is string => typeof v === 'string' && v.length > 0)
        : body?.chatId
          ? [body.chatId]
          : []
      if (ids.length === 0)
        return this.guardError(400, 'guard.bad_request', 'chatId or chatIds is required')

      const now = this.clock.now()
      const marked: string[] = []
      const already: string[] = []
      for (const chatId of ids) {
        if (this.store.markHumanTouch(session, chatId, now, body?.touchedAt)) marked.push(chatId)
        else already.push(chatId)
      }
      this.log.info('human touch recorded', {
        session,
        marked: marked.length,
        already: already.length,
      })
      return Response.json({ guard: true, session, marked, already })
    }

    /**
     * Tell the guard that **they wrote to us**, at a time it was not there to see.
     *
     * Distinct from `/contact/human-touch`, and the distinction is the whole point. A touch
     * says only "this relationship is not cold" — it is how a *permitted cold send* gets
     * unlocked, so `opensAStranger` deliberately refuses to key on it (see the comment
     * there). Using a touch to represent an inbound therefore clears `requireHumanTouch`
     * and then walks the contact straight into `maxNewStrangersPerDay`, because as far as
     * every counter can tell we are still the ones opening the conversation.
     *
     * That is not hypothetical: on 2026-08-01 fifteen people answered a CTWA ad, WAHA never
     * delivered the webhooks, and the recovery marked them all as touched. The replies
     * cleared one gate and were then held by the stranger budget, five per day.
     *
     * This records the real thing instead. `recordInbound` bumps `in_count`, which is what
     * `opensAStranger` reads, and inserts an `inbound` row — which is what `coldOpens` reads,
     * and it compares that row's timestamp against the first send to the chat. So `at` must
     * be **when they actually wrote**, not now: a row dated after a send that already went
     * out still leaves that send counted as a cold open.
     */
    if (req.method === 'POST' && path === '/_guard/contact/inbound') {
      const body = (await req.json().catch(() => null)) as {
        session?: string
        chatId?: string
        msgId?: string
        at?: number
      } | null
      const session = body?.session ?? 'default'
      const chatId = body?.chatId
      if (!chatId) return this.guardError(400, 'guard.bad_request', 'chatId is required')
      const at = typeof body?.at === 'number' && body.at > 0 ? body.at : this.clock.now()

      const recorded = this.store.recordInbound(session, chatId, body?.msgId ?? null, at)
      if (recorded) this.log.info('inbound adopted', { session, chatId, at })
      return Response.json({
        guard: true,
        session,
        chatId,
        recorded,
        contact: this.store.getContact(session, chatId),
      })
    }

    /**
     * Tell the guard that two ids are one person.
     *
     * The observer learns this by itself from any message it sees, but only from a message it
     * sees. A thread that was already stuck when the guard learned to resolve LIDs has its
     * reply booked under a `@lid` and its sends counted under the phone, and nothing merges
     * them until the contact writes in again — which is precisely what the stuck handshake is
     * preventing us from asking them to do. This is the way out of that.
     */
    if (req.method === 'POST' && path === '/_guard/contact/link') {
      const body = (await req.json().catch(() => null)) as {
        session?: string
        alias?: string
        chatId?: string
      } | null
      const session = body?.session ?? 'default'
      const { alias, chatId } = body ?? {}
      if (!alias || !chatId) {
        return this.guardError(400, 'guard.bad_request', 'alias and chatId are both required')
      }
      const linked = this.store.linkIdentity(session, alias, chatId, this.clock.now())
      if (linked) this.log.info('identities linked by hand', { session, alias, chatId })
      return Response.json({
        guard: true,
        session,
        linked,
        contact: this.store.getContact(session, chatId),
        aliases: this.store.aliasesOf(session, chatId),
      })
    }

    if (req.method === 'POST' && path === '/_guard/resume') {
      const body = (await req.json().catch(() => null)) as { session?: string } | null
      const session = body?.session ?? 'default'
      this.store.setStopped(session, null, this.clock.now())
      this.log.info('session manually resumed', { session })
      return Response.json({ guard: true, session, stopped: null })
    }

    return this.guardError(404, 'guard.not_found', `no guard endpoint at ${path}`)
  }

  /**
   * The callback is deliberately best-effort: an outage must never clear or weaken the
   * guard's local stop. The mailbox reconciler repairs any callback delivery gap.
   */
  private async reportOptOut(event: {
    eventId: string
    session: string
    chatId: string
    occurredAt: string
  }): Promise<void> {
    const target = this.options.config.optOutCallbackUrl
    if (!target) return
    if (!this.options.config.apiKey) {
      this.log.error('opt-out callback is configured without GUARD_API_KEY', { target })
      return
    }
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.options.config.apiKey },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(this.options.config.webhookTimeoutMs),
    })
    if (!response.ok) throw new Error(`callback returned ${response.status}`)
  }
}

const FORCE_HEADER = 'x-guard-force'
const FORCE_REASON_HEADER = 'x-guard-force-reason'

/**
 * `x-guard-force: 1` — an operator-approved override for this one send.
 *
 * A header rather than a body field because the body is forwarded to WAHA byte-for-byte:
 * this is a statement to the guard, not to WhatsApp. And a header rather than a stored
 * permission or a durable flag on a message, because the approval being modelled is a human
 * saying "send it anyway" about one message. There is deliberately no way to grant force
 * ahead of time, and nothing anywhere records that a send *wants* forcing.
 *
 * It is not separately authenticated. Reaching this path already requires WAHA's API key,
 * and the approval is a human decision, not a credential — a second key would give the
 * override the look of an authorisation system without adding one. What makes it safe is
 * the short list of gates it may touch (see `forceable` in gates.ts) and the fact that
 * every use is logged.
 */
function parseForce(headers: Headers): { force: boolean; forceReason: string | null } {
  const raw = headers.get(FORCE_HEADER)?.trim().toLowerCase()
  const force = raw === '1' || raw === 'true' || raw === 'yes'
  if (!force) return { force: false, forceReason: null }
  const reason = headers.get(FORCE_REASON_HEADER)?.trim()
  return { force: true, forceReason: reason ? reason.slice(0, 200) : null }
}

function stripGuardHeaders(headers: Headers): Headers {
  const copy = new Headers(headers)
  copy.delete(FORCE_HEADER)
  copy.delete(FORCE_REASON_HEADER)
  return copy
}

/** Headers that belong to the original HTTP hop and must not be replayed from the queue. */
function isPerRequestHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower === 'content-length' ||
    lower === 'host' ||
    lower === 'connection' ||
    lower === 'transfer-encoding' ||
    lower === 'accept-encoding'
  )
}
