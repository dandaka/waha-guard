import type { Logger } from '../observability/log.ts'
import type { Metrics } from '../observability/metrics.ts'
import { forSession } from '../policy/load.ts'
import type { Policy, SessionPolicy } from '../policy/schema.ts'
import { type Upstream, UpstreamError } from '../proxy/upstream.ts'
import type { Store } from '../state/store.ts'
import type { Clock } from '../util/clock.ts'
import { KeyedMutex } from '../util/mutex.ts'
import { defaultRng, gaussian, type Rng } from '../util/random.ts'
import { primaryMessageId } from '../waha/message.ts'
import { evaluate } from './gates.ts'
import { planTyping } from './typing.ts'

export interface SendJob {
  session: string
  chatId: string
  /** Canonical route name, e.g. 'sendText'. */
  route: string
  textLength: number
  method: string
  /** Path + query on the upstream, e.g. '/api/sendText'. */
  path: string
  headers: Headers
  body: Uint8Array
  arrivedAt: number
  signal?: AbortSignal
  /**
   * An operator-approved override for this one send (`x-guard-force`). Skips the forceable
   * gates only, and exists for exactly as long as this request does.
   */
  force?: boolean
  /** Free text from `x-guard-force-reason`, carried into the audit line. */
  forceReason?: string | null
}

export type SendResult =
  | { status: 'sent'; response: Response; msgId: string | null }
  /** Never going to happen under current policy. */
  | { status: 'denied'; httpStatus: number; code: string; reason: string }
  /** Fine, but not within maxWaitMs. The caller decides what to do. */
  | { status: 'deferred'; retryAfterMs: number; code: string; reason: string }
  /** WAHA answered, but not with success. Response is passed through untouched. */
  | { status: 'rejected'; response: Response }
  | { status: 'unreachable'; error: unknown }

export interface SenderDeps {
  policy: () => Policy
  store: Store
  upstream: Upstream
  clock: Clock
  metrics: Metrics
  log: Logger
  rng?: Rng
}

/** Safety valve: a gate that keeps saying "wait" without the clock moving must not spin. */
const MAX_GATE_ROUNDS = 64

export class Sender {
  private readonly mutex = new KeyedMutex()
  private readonly rng: Rng

  constructor(private readonly deps: SenderDeps) {
    this.rng = deps.rng ?? defaultRng
  }

  queueDepth(session: string): number {
    return this.mutex.waiting(session)
  }

  policyFor(session: string): SessionPolicy {
    return forSession(this.deps.policy(), session)
  }

  /**
   * Run one send through the full pipeline. Serialized per session: pacing that is not
   * serialized is not pacing.
   */
  async send(job: SendJob): Promise<SendResult> {
    return this.mutex.run(job.session, () => this.sendLocked(job))
  }

  private async sendLocked(job: SendJob): Promise<SendResult> {
    const { store, clock, metrics, log } = this.deps
    const policy = this.policyFor(job.session)
    const deadline = job.arrivedAt + policy.backpressure.maxWaitMs
    const jitterMs = Math.max(0, gaussian(0, policy.rates.jitterStddevMs, this.rng))

    // Logged on request, not on effect: a forced send that then fails upstream still has to
    // appear in the record, and these logs are the only trace of a send that bypasses the
    // mailbox. `awaitGates` adds a line per limit actually overridden.
    if (job.force) {
      log.warn('force requested', {
        session: job.session,
        chatId: job.chatId,
        route: job.route,
        forceReason: job.forceReason ?? null,
      })
    }

    const gateOutcome = await this.awaitGates(job, policy, deadline, jitterMs)
    if (gateOutcome.status !== 'ok') return gateOutcome.result

    if (policy.presence === 'guard' && policy.typing.enabled && job.textLength > 0) {
      await this.runTypingPlan(job, policy, deadline)
    }

    // Reserve the slot before forwarding. It consumes the window budget even if the
    // response is slow, and it is the marker that lets webhook observation tell our own
    // echo apart from a message typed on the phone when the echo beats the response back.
    const sendId = store.recordGuardOutbound(
      job.session,
      job.chatId,
      job.route,
      null,
      clock.now(),
      job.headers.get('x-guard-mailbox-message-id'),
    )

    let response: Response
    try {
      response = await this.deps.upstream.pass(
        new Request(`http://upstream${job.path}`, {
          method: job.method,
          headers: (() => {
            const headers = new Headers(job.headers)
            headers.delete('x-guard-mailbox-message-id')
            return headers
          })(),
        }),
        job.body,
      )
    } catch (error) {
      store.voidSend(sendId)
      metrics.inc('sends_upstream_errors_total', { session: job.session })
      log.error('upstream unreachable', {
        session: job.session,
        route: job.route,
        error: String(error),
      })
      return { status: 'unreachable', error: error instanceof UpstreamError ? error.cause_ : error }
    }

    if (!response.ok) {
      store.voidSend(sendId)
      metrics.inc('sends_rejected_total', { session: job.session, status: String(response.status) })
      const passthrough = await this.inspectFailure(job, policy, response)
      return { status: 'rejected', response: passthrough }
    }

    const { response: replayed, msgId } = await this.captureMessageId(response)
    if (msgId) store.attachMessageId(sendId, msgId)
    metrics.inc('sends_total', { session: job.session, route: job.route })
    log.info('sent', {
      session: job.session,
      chatId: job.chatId,
      route: job.route,
      msgId,
      forced: job.force === true,
    })
    return { status: 'sent', response: replayed, msgId }
  }

  /** Loop the gates, waiting when policy says "later" and the deadline allows it. */
  private async awaitGates(
    job: SendJob,
    policy: SessionPolicy,
    deadline: number,
    jitterMs: number,
  ): Promise<{ status: 'ok' } | { status: 'stop'; result: SendResult }> {
    const { store, clock, metrics, log } = this.deps
    // The gates are re-run every round; an override must be reported once, not once per loop.
    const announced = new Set<string>()
    for (let round = 0; round < MAX_GATE_ROUNDS; round++) {
      const now = clock.now()
      const contact = store.ensureContact(job.session, job.chatId, now)
      const session = store.ensureSession(job.session, now)
      const { result, forced } = evaluate({
        policy,
        store,
        contact,
        session,
        ctx: {
          session: job.session,
          chatId: job.chatId,
          textLength: job.textLength,
          route: job.route,
          now,
          jitterMs,
          force: job.force === true,
          mailboxMessageId: job.headers.get('x-guard-mailbox-message-id'),
        },
      })

      for (const code of forced) {
        if (announced.has(code)) continue
        announced.add(code)
        metrics.inc('gate_forced_total', { session: job.session, code })
        log.warn('forced past a guard limit', {
          session: job.session,
          chatId: job.chatId,
          route: job.route,
          code,
          forceReason: job.forceReason ?? null,
        })
      }

      if (result.kind === 'allow') return { status: 'ok' }

      if (policy.mode === 'observe') {
        metrics.inc('gate_observed_total', { session: job.session, code: result.code })
        log.info('gate would have fired (observe mode)', {
          session: job.session,
          chatId: job.chatId,
          code: result.code,
          reason: result.reason,
        })
        return { status: 'ok' }
      }

      if (result.kind === 'deny') {
        metrics.inc('gate_denied_total', { session: job.session, code: result.code })
        log.info('denied', { session: job.session, chatId: job.chatId, code: result.code })
        return {
          status: 'stop',
          result: {
            status: 'denied',
            httpStatus: result.status,
            code: result.code,
            reason: result.reason,
          },
        }
      }

      const waitMs = result.until - now
      if (waitMs <= 0) continue
      if (result.until > deadline) {
        metrics.inc('gate_deferred_total', { session: job.session, code: result.code })
        return {
          status: 'stop',
          result: {
            status: 'deferred',
            retryAfterMs: waitMs,
            code: result.code,
            reason: result.reason,
          },
        }
      }

      metrics.inc('gate_waited_total', { session: job.session, code: result.code })
      try {
        await clock.sleep(waitMs, job.signal)
      } catch {
        return {
          status: 'stop',
          result: {
            status: 'deferred',
            retryAfterMs: waitMs,
            code: 'guard.client_gone',
            reason: 'caller disconnected while waiting',
          },
        }
      }
    }
    return {
      status: 'stop',
      result: {
        status: 'deferred',
        retryAfterMs: 60_000,
        code: 'guard.gate_loop',
        reason: 'policy gates did not converge; refusing to spin',
      },
    }
  }

  private async runTypingPlan(
    job: SendJob,
    policy: SessionPolicy,
    deadline: number,
  ): Promise<void> {
    const { clock, upstream, log, metrics } = this.deps
    const budget = deadline - clock.now()
    if (budget <= 0) return
    const capped = { ...policy.typing, maxPlanMs: Math.min(policy.typing.maxPlanMs, budget) }
    const plan = planTyping(job.textLength, capped, this.rng)
    if (plan.steps.length === 0) return

    metrics.observe('typing_plan_ms', plan.totalMs, { session: job.session })
    const presenceHeaders = new Headers(job.headers)
    presenceHeaders.delete('x-guard-mailbox-message-id')
    try {
      for (const step of plan.steps) {
        const path = step.kind === 'composing' ? '/api/startTyping' : '/api/stopTyping'
        await upstream.postJson(path, { session: job.session, chatId: job.chatId }, presenceHeaders)
        await clock.sleep(step.durationMs, job.signal)
      }
      await upstream.postJson(
        '/api/stopTyping',
        { session: job.session, chatId: job.chatId },
        presenceHeaders,
      )
    } catch (error) {
      // A missing typing indicator is cosmetic; failing the send over it is not. But say so.
      log.warn('typing plan interrupted', { session: job.session, error: String(error) })
    }
  }

  /**
   * Read the message id out of a send response without changing what the caller sees:
   * the body is replayed byte-for-byte.
   */
  private async captureMessageId(
    response: Response,
  ): Promise<{ response: Response; msgId: string | null }> {
    const buffer = await response.arrayBuffer()
    let msgId: string | null = null
    try {
      msgId = primaryMessageId(JSON.parse(new TextDecoder().decode(buffer)))
    } catch {
      msgId = null
    }
    return {
      response: new Response(buffer, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      msgId,
    }
  }

  /** Look for a timelock / rate-limit signal in a failed send, then pass the body on. */
  private async inspectFailure(
    job: SendJob,
    policy: SessionPolicy,
    response: Response,
  ): Promise<Response> {
    const buffer = await response.arrayBuffer()
    if (policy.timelock.enabled) {
      const text = new TextDecoder().decode(buffer).toLowerCase()
      const matched =
        policy.timelock.detectStatuses.includes(response.status) ||
        policy.timelock.detectBodyPatterns.some((p) => text.includes(p.toLowerCase()))
      if (matched) {
        const now = this.deps.clock.now()
        this.deps.store.setTimelock(
          job.session,
          now + policy.timelock.degradeMinutes * 60_000,
          policy.timelock.degradedMultiplier,
          now,
        )
        this.deps.metrics.inc('timelock_detected_total', { session: job.session })
        this.deps.log.warn('upstream rate limit detected — entering degraded mode', {
          session: job.session,
          status: response.status,
          degradeMinutes: policy.timelock.degradeMinutes,
        })
      }
    }
    return new Response(buffer, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
