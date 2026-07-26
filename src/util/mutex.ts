/**
 * One lock per session.
 *
 * Pacing is only meaningful if sends to a session are serialized: two concurrent requests
 * that each check "was the last send 20s ago?" would both see yes and both fire.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>()
  private depth = new Map<string, number>()

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    this.depth.set(key, (this.depth.get(key) ?? 0) + 1)
    const result = previous.then(fn, fn)
    // Swallow rejection on the chain itself so one failure does not poison the queue.
    this.tails.set(
      key,
      result.catch(() => undefined),
    )
    try {
      return await result
    } finally {
      const left = (this.depth.get(key) ?? 1) - 1
      if (left <= 0) {
        this.depth.delete(key)
        this.tails.delete(key)
      } else {
        this.depth.set(key, left)
      }
    }
  }

  waiting(key: string): number {
    return this.depth.get(key) ?? 0
  }
}
