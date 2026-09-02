/**
 * Session health: is this WhatsApp session able to send right now?
 *
 * The guard used to answer that from webhooks alone — `STOPPED` latched outbound off,
 * `WORKING` unlatched it. That makes availability depend on a delivery channel that fails
 * at exactly the wrong moment: WAHA's webhook sender was retrying against 503s during the
 * 2026-07-29 flaps, and one dropped `WORKING` left the line refusing every send while WAHA
 * itself reported the session healthy.
 *
 * So status is *re-read* here on an interval, and the webhook becomes the fast path rather
 * than the only path. Both routes fold through `applySessionStatus`, so the two views
 * cannot disagree about what a status means.
 */

import type { Logger } from '../observability/log.ts'
import type { Metrics } from '../observability/metrics.ts'
import { forSession } from '../policy/load.ts'
import type { Policy } from '../policy/schema.ts'
import { type Upstream, UpstreamError } from '../proxy/upstream.ts'
import type { Store } from '../state/store.ts'
import type { Clock } from '../util/clock.ts'

/** Statuses that mean "cannot send". Everything else is treated as healthy. */
export const HALTING_STATUSES = new Set(['FAILED', 'STOPPED', 'SCAN_QR_CODE'])

export type StatusSource = 'webhook' | 'poll'

export interface SessionHealthDeps {
  store: Store
  metrics: Metrics
  log: Logger
  clock: Clock
}

/**
 * Fold one observed status into stored session state.
 *
 * Logs only on a transition. The poller sees the same status every interval, and an error
 * line per interval would bury the one that matters — while a stop that is *entered* must
 * always be visible, however it was learned.
 */
export function applySessionStatus(
  deps: SessionHealthDeps,
  session: string,
  rawStatus: string,
  source: StatusSource,
): void {
  const status = rawStatus.toUpperCase()
  const now = deps.clock.now()
  const before = deps.store.getSession(session)

  if (HALTING_STATUSES.has(status)) {
    const changed = before?.stopped_reason === null || before?.stopped_status !== status
    deps.store.setStopped(session, `session status ${status}`, now, status)
    if (!changed) return
    deps.metrics.inc('session_halts_total', { session, status })
    deps.log.error('session is not able to send — outbound stopped', { session, status, source })
    return
  }

  if (status !== 'WORKING') return
  if (!before?.stopped_reason) return
  deps.store.setStopped(session, null, now)
  deps.metrics.inc('session_recoveries_total', { session, source })
  deps.log.info('session recovered — outbound resumed', { session, source })
}

export interface SessionMonitorDeps extends SessionHealthDeps {
  upstream: Upstream
  policy: () => Policy
  /**
   * WAHA's own API key. The poll is a call the guard makes on its own behalf — there is no
   * caller whose key it could borrow — so without this WAHA answers 401 and the guard is
   * back to trusting webhooks alone. That is a degradation worth saying out loud, not a
   * silent one, so `start()` warns when it is missing.
   */
  apiKey: string | null
}

interface SessionListEntry {
  name?: unknown
  status?: unknown
}

/**
 * Polls WAHA for session status and, when a session stays stopped, asks it to start again.
 *
 * The restart is narrow on purpose: only `STOPPED`, only after the session has been down
 * continuously past `autoRestart.afterMs`, and at most once per `cooldownMs`. A `FAILED` or
 * `SCAN_QR_CODE` session is never poked — that is an account action, and retrying it in a
 * loop is how you turn a problem that needs a human into a problem nobody is told about.
 */
export class SessionMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  /** Last restart attempt per session, for the cooldown. In memory: a container restart is itself a reset. */
  private readonly lastRestartAt = new Map<string, number>()
  /** Sessions already reported as a sustained outage, so it is said once per stop. */
  private readonly outageAnnounced = new Set<string>()
  private pollFailures = 0

  constructor(private readonly deps: SessionMonitorDeps) {}

  start(): void {
    const policy = this.deps.policy()
    if (!policy.sessionHealth.poll.enabled) return
    if (this.timer !== null) return
    if (!this.deps.apiKey) {
      this.deps.log.warn(
        'session polling is on but GUARD_UPSTREAM_API_KEY is unset — WAHA will answer 401 ' +
          'and the guard will be back to trusting webhooks alone for session status',
      )
    }
    // Poll once immediately: a guard that just restarted has no idea what the session is
    // doing, and waiting a full interval to find out is a window where it guesses.
    void this.pollOnce()
    this.timer = setInterval(() => void this.pollOnce(), policy.sessionHealth.poll.intervalMs)
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      ;(this.timer as { unref: () => void }).unref()
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** One reconcile pass. Never throws: a failed poll must not take the guard down. */
  async pollOnce(): Promise<void> {
    // Polls are not worth queueing. If one is slow, skipping the next is the right answer.
    if (this.polling) return
    this.polling = true
    try {
      const sessions = await this.listSessions()
      if (sessions === null) return
      const now = this.deps.clock.now()
      for (const entry of sessions) {
        const name = typeof entry.name === 'string' ? entry.name : null
        const status = typeof entry.status === 'string' ? entry.status : null
        if (!name || !status) continue
        applySessionStatus(this.deps, name, status, 'poll')
        // Awaited, not fired and forgotten: the cooldown is stamped before the call, so a
        // poll that returned early would let the next one race against a restart in flight.
        await this.reviewStoppedSession(name, now)
      }
    } catch (error) {
      this.deps.log.warn('session poll failed', { error: String(error) })
    } finally {
      this.polling = false
    }
  }

  /**
   * `all=true` matters: without it WAHA lists only running sessions, so the one case this
   * exists for — a session that is stopped — would come back as an empty list and read as
   * "nothing to report".
   */
  private async listSessions(): Promise<SessionListEntry[] | null> {
    const headers = new Headers()
    if (this.deps.apiKey) headers.set('x-api-key', this.deps.apiKey)
    let body: unknown
    try {
      body = await this.deps.upstream.getJson<unknown>('/api/sessions?all=true', headers)
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error
      body = null
    }
    if (!Array.isArray(body)) {
      this.pollFailures++
      this.deps.metrics.inc('session_poll_errors_total')
      // Loud on the first failure, then quiet: an unreachable WAHA is already a 502 on every
      // send, and this must not become the thing that fills the log.
      if (this.pollFailures === 1 || this.pollFailures % 40 === 0) {
        this.deps.log.warn('could not read session status from WAHA', {
          consecutiveFailures: this.pollFailures,
        })
      }
      return null
    }
    this.pollFailures = 0
    return body as SessionListEntry[]
  }

  /** Escalate a stop that is lasting: announce it once, then try a restart if allowed. */
  private async reviewStoppedSession(session: string, now: number): Promise<void> {
    const row = this.deps.store.getSession(session)
    if (!row?.stopped_reason || row.stopped_since === null) {
      this.outageAnnounced.delete(session)
      return
    }
    const policy = forSession(this.deps.policy(), session)
    const stoppedFor = now - row.stopped_since

    // Past the grace window this stopped being a flap and started being an outage: sends
    // are now failing rather than waiting, and somebody needs to know that.
    if (stoppedFor >= policy.sessionHealth.transientGraceMs && !this.outageAnnounced.has(session)) {
      this.outageAnnounced.add(session)
      this.deps.metrics.inc('session_outages_total', { session, status: row.stopped_status ?? '' })
      this.deps.log.error('session has been stopped past the grace window — sends are failing', {
        session,
        status: row.stopped_status,
        stoppedForMs: stoppedFor,
      })
    }

    const restart = policy.sessionHealth.autoRestart
    if (!restart.enabled) return
    // Only a plain STOPPED. See the class comment.
    if (row.stopped_status !== 'STOPPED') return
    if (stoppedFor < restart.afterMs) return
    const last = this.lastRestartAt.get(session)
    if (last !== undefined && now - last < restart.cooldownMs) return
    this.lastRestartAt.set(session, now)
    await this.requestStart(session, stoppedFor)
  }

  private async requestStart(session: string, stoppedFor: number): Promise<void> {
    this.deps.metrics.inc('session_restarts_total', { session })
    this.deps.log.warn('asking WAHA to start a session that has stayed stopped', {
      session,
      stoppedForMs: stoppedFor,
    })
    const headers = new Headers()
    if (this.deps.apiKey) headers.set('x-api-key', this.deps.apiKey)
    try {
      // Two spellings across WAHA versions, and the guard is pinned to a WAHA it does not
      // control. Try the current per-session route, fall back to the older collection one
      // on a 404 rather than reporting a recovery that never ran.
      let res = await this.deps.upstream.postJson(`/api/sessions/${session}/start`, {}, headers)
      if (res.status === 404) {
        res = await this.deps.upstream.postJson('/api/sessions/start', { name: session }, headers)
      }
      if (!res.ok) {
        this.deps.metrics.inc('session_restart_errors_total', { session })
        this.deps.log.error('could not start the session', { session, status: res.status })
      }
    } catch (error) {
      this.deps.metrics.inc('session_restart_errors_total', { session })
      this.deps.log.error('could not start the session', { session, error: String(error) })
    }
  }
}
