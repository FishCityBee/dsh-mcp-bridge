/** Abortable FIFO semaphore. Adopted live work counts even above a new lower limit. */
export class Semaphore {
  private active = 0
  private waiters: { enter: () => void; signal?: AbortSignal; abort: () => void }[] = []
  constructor(private readonly limit: () => number) {}
  private drain() {
    while (this.active < Math.max(1, this.limit()) && this.waiters.length) this.waiters.shift()!.enter()
  }
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal, adopted = false): Promise<T> {
    signal?.throwIfAborted()
    if (adopted) this.active++
    else await new Promise<void>((resolve, reject) => {
      const waiter = { signal, enter: () => {
        signal?.removeEventListener('abort', waiter.abort)
        this.active++
        resolve()
      }, abort: () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(signal?.reason)
      } }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', waiter.abort, { once: true })
      this.drain()
    })
    try { signal?.throwIfAborted(); return await fn() } finally { this.active--; this.drain() }
  }
}
