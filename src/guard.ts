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
    })
    this.worker = new QueueWorker({
      store: this.store,
      sender: this.sender,
      clock: this.clock,
      log: this.log,
      metrics: this.metrics,
      downstream: this.downstream,
    })
    this.registerGauges()
    if (options.startWorker !== false) this.worker.start()
  }

  setPolicy(policy: Policy): void {
    this.policy = policy
  }

  async close(): Promise<void> {
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

    const text = textFromSendBody(body, match.textField ?? null)
    const job = {
      session,
      chatId,
      route: match.name,
      textLength: text.length,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: req.headers,
      body: raw,
      arrivedAt: this.clock.now(),
      signal: req.signal,
    }

    if (policy.backpressure.mode === 'queue') return this.enqueue(job)

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
    try {
      const parsed = JSON.parse(new TextDecoder().decode(raw))
      for (const event of parseEvents(parsed)) this.observer.handle(event)
    } catch (error) {
      // Observation is best-effort; forwarding is not. A body we cannot read still belongs
      // to the app.
      this.log.warn('could not observe webhook body', { error: String(error) })
    }
    return this.downstream.forward(req, raw)
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
        queueDepth: this.store.queuedDepth(),
        sessions: this.store.listSessions().map((s) => {
          const policy = forSession(this.policy, s.session)
          const step = warmupStep(policy, s, now)
          const budget = countsNewStrangers(policy, this.store, s.session, now)
          return {
            session: s.session,
            stopped: s.stopped_reason,
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
      } | null
      const session = body?.session ?? 'default'
      const chatId = body?.chatId
      if (!chatId) return this.guardError(400, 'guard.bad_request', 'chatId is required')
      if (path === '/_guard/opt-out') this.store.markOptOut(session, chatId, this.clock.now())
      else this.store.clearOptOut(session, chatId)
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
