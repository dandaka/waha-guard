import type { Logger } from '../observability/log.ts'
import type { Metrics } from '../observability/metrics.ts'
import type { Sender } from '../pipeline/sender.ts'
import type { QueuedRow, Store } from '../state/store.ts'
import type { Clock } from '../util/clock.ts'
import type { Downstream } from '../webhook/downstream.ts'

export interface WorkerOptions {
  store: Store
  sender: Sender
  clock: Clock
  log: Logger
  metrics: Metrics
  downstream: Downstream
  /** How long to sleep when there is nothing to do. */
  idleMs?: number
  maxAttempts?: number
}

/**
 * Drains `queue` mode sends.
 *
 * The queue is a table, not an array: a 202 the guard hands out is a promise to deliver,
 * and a promise that evaporates on restart is the silent drop this design forbids.
 */
export class QueueWorker {
  private running = false
  private loop: Promise<void> | null = null

  constructor(private readonly options: WorkerOptions) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.loop = this.run()
  }

  async stop(): Promise<void> {
    this.running = false
    await this.loop?.catch(() => undefined)
    this.loop = null
  }

  private async run(): Promise<void> {
    const idle = this.options.idleMs ?? 1_000
    while (this.running) {
      // Sessions drain concurrently: in block-gate waits one session can legitimately
      // sleep for minutes, and that must not stall every other session's queue. Within a
      // session the sender's mutex still serializes, so pacing is unaffected.
      const results = await Promise.all(
        this.options.store.queuedSessions().map((session) =>
          this.drainOne(session).catch((error) => {
            this.options.log.error('queue worker failed on a job', {
              session,
              error: String(error),
            })
            return false
          }),
        ),
      )
      if (!this.running) break
      if (!results.some(Boolean)) await this.options.clock.sleep(idle)
    }
  }

  /** Exposed for tests: process at most one job for a session. */
  async drainOne(session: string): Promise<boolean> {
    const { store, clock } = this.options
    const row = store.nextQueued(session, clock.now())
    if (!row) return false
    await this.process(row)
    return true
  }

  private async process(row: QueuedRow): Promise<void> {
    const { store, sender, clock, log, metrics, downstream } = this.options
    const maxAttempts = this.options.maxAttempts ?? 5
    const headers = new Headers(JSON.parse(row.headers) as [string, string][])

    const result = await sender.send({
      session: row.session,
      chatId: row.chat_id,
      route: row.route,
      textLength: row.text_length,
      method: row.method,
      path: row.path,
      headers,
      body: new Uint8Array(row.body),
      arrivedAt: clock.now(),
    })

    switch (result.status) {
      case 'sent': {
        store.settleQueued(row.guard_id, 'sent', null)
        metrics.inc('queue_sent_total', { session: row.session })
        await downstream.emit('guard.sent', row.session, {
          guardId: row.guard_id,
          chatId: row.chat_id,
          route: row.route,
          messageId: result.msgId,
        })
        break
      }
      case 'denied': {
        store.settleQueued(row.guard_id, 'dropped', `${result.code}: ${result.reason}`)
        metrics.inc('queue_dropped_total', { session: row.session, code: result.code })
        await downstream.emit('guard.dropped', row.session, {
          guardId: row.guard_id,
          chatId: row.chat_id,
          route: row.route,
          code: result.code,
          reason: result.reason,
        })
        break
      }
      case 'rejected': {
        const reason = `upstream responded ${result.response.status}`
        store.settleQueued(row.guard_id, 'dropped', reason)
        metrics.inc('queue_dropped_total', { session: row.session, code: 'upstream' })
        await downstream.emit('guard.dropped', row.session, {
          guardId: row.guard_id,
          chatId: row.chat_id,
          route: row.route,
          code: 'guard.upstream_rejected',
          reason,
          status: result.response.status,
        })
        break
      }
      case 'deferred':
      case 'unreachable': {
        // A deferral is policy pacing, not a failure: it must not consume the attempts
        // that decide abandonment, or a job that patiently waited out rate limits gets
        // dropped on its first network blip.
        const failed = result.status === 'unreachable'
        const attempts = row.attempts + (failed ? 1 : 0)
        const reason =
          result.status === 'deferred'
            ? `${result.code}: ${result.reason}`
            : `upstream unreachable: ${String(result.error)}`
        if (failed && attempts >= maxAttempts) {
          store.settleQueued(row.guard_id, 'dropped', reason)
          await downstream.emit('guard.dropped', row.session, {
            guardId: row.guard_id,
            chatId: row.chat_id,
            route: row.route,
            code: 'guard.upstream_unreachable',
            reason,
          })
          log.error('queued send abandoned', { guardId: row.guard_id, attempts, reason })
          break
        }
        // Deferred is not a failure — the policy simply is not ready yet, so back off
        // gently and keep the job. Unreachable backs off exponentially.
        const delay =
          result.status === 'deferred'
            ? Math.min(result.retryAfterMs, 60_000)
            : Math.min(1_000 * 2 ** attempts, 60_000)
        store.retryQueued(row.guard_id, clock.now() + delay, reason, failed)
        metrics.inc('queue_retries_total', { session: row.session })
        break
      }
    }
  }
}
