export interface Clock {
  now(): number
  /** Resolves early (and rejects with an AbortError) if the signal fires. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    if (ms <= 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  },
}

function drain(rounds = 3): Promise<void> {
  let chain = Promise.resolve()
  for (let i = 0; i < rounds; i++) {
    chain = chain.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
  return chain
}

export function abortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

/**
 * A clock that only advances when told to. Every test that involves pacing uses this;
 * without it the suite would spend real minutes asleep and still be flaky.
 */
export class TestClock implements Clock {
  private current: number
  private waiters: { at: number; resolve: () => void; reject: (e: Error) => void }[] = []

  constructor(start = 1_700_000_000_000) {
    this.current = start
  }

  now(): number {
    return this.current
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      const waiter = { at: this.current + ms, resolve, reject }
      this.waiters.push(waiter)
      signal?.addEventListener(
        'abort',
        () => {
          this.waiters = this.waiters.filter((w) => w !== waiter)
          reject(abortError())
        },
        { once: true },
      )
    })
  }

  /** Advance time, releasing sleepers in order and letting each woken task run. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms
    for (;;) {
      const next = this.waiters.filter((w) => w.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      this.current = Math.max(this.current, next.at)
      this.waiters = this.waiters.filter((w) => w !== next)
      next.resolve()
      // A woken task may do real I/O before registering its next sleep, so drain the
      // macrotask queue rather than just the microtask queue.
      await drain()
    }
    this.current = target
    await drain()
  }

  get pending(): number {
    return this.waiters.length
  }
}
