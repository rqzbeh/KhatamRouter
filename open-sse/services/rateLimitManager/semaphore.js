/**
 * In-Process Concurrency Semaphore.
 *
 * Enforces in-flight concurrency limits keyed by `provider:account` (and optionally per-model).
 * Provides immediate tryAcquire and queue-backed acquire with maxWaitMs timeouts.
 */

export class InProcessSemaphore {
  constructor() {
    this.inFlight = new Map();
    this.waiters = new Map();
  }

  /**
   * Get current in-flight count for a key.
   */
  getInFlight(key) {
    return this.inFlight.get(key) || 0;
  }

  /**
   * Non-blocking attempt to acquire a concurrency slot.
   */
  tryAcquire(key, maxConcurrent) {
    if (!maxConcurrent || maxConcurrent <= 0) {
      return { acquired: true, current: 0, limit: 0 };
    }

    const current = this.inFlight.get(key) || 0;
    if (current < maxConcurrent) {
      this.inFlight.set(key, current + 1);
      return { acquired: true, current: current + 1, limit: maxConcurrent };
    }

    return { acquired: false, current, limit: maxConcurrent };
  }

  /**
   * Acquire a slot, waiting up to maxWaitMs if busy.
   */
  async acquire(key, maxConcurrent, options = {}) {
    const { maxWaitMs = 0, signal } = options;

    const initial = this.tryAcquire(key, maxConcurrent);
    if (initial.acquired) {
      return { acquired: true, current: initial.current, limit: maxConcurrent };
    }

    if (maxWaitMs <= 0 || (signal && signal.aborted)) {
      return {
        acquired: false,
        reason: "concurrency_limit_exceeded",
        current: initial.current,
        limit: maxConcurrent,
      };
    }

    return new Promise((resolve) => {
      let timer = null;
      let onAbort = null;

      const waiter = {
        resolve: () => {
          if (timer) clearTimeout(timer);
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          resolve({
            acquired: true,
            current: this.inFlight.get(key) || 1,
            limit: maxConcurrent,
          });
        },
      };

      if (!this.waiters.has(key)) {
        this.waiters.set(key, []);
      }
      this.waiters.get(key).push(waiter);

      const cleanupWaiter = () => {
        const queue = this.waiters.get(key);
        if (queue) {
          const idx = queue.indexOf(waiter);
          if (idx !== -1) queue.splice(idx, 1);
          if (queue.length === 0) this.waiters.delete(key);
        }
      };

      timer = setTimeout(() => {
        cleanupWaiter();
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        resolve({
          acquired: false,
          reason: "concurrency_timeout",
          current: this.inFlight.get(key) || 0,
          limit: maxConcurrent,
        });
      }, maxWaitMs);

      if (signal) {
        onAbort = () => {
          cleanupWaiter();
          if (timer) clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve({
            acquired: false,
            reason: "aborted",
            current: this.inFlight.get(key) || 0,
            limit: maxConcurrent,
          });
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /**
   * Release an acquired concurrency slot and wake the next queued waiter if any.
   */
  release(key) {
    const current = this.inFlight.get(key) || 0;
    if (current <= 1) {
      this.inFlight.delete(key);
    } else {
      this.inFlight.set(key, current - 1);
    }

    const queue = this.waiters.get(key);
    if (queue && queue.length > 0) {
      const nextWaiter = queue.shift();
      if (queue.length === 0) {
        this.waiters.delete(key);
      }
      // Re-increment for the waiter taking over the slot
      this.inFlight.set(key, (this.inFlight.get(key) || 0) + 1);
      nextWaiter.resolve();
    }
  }

  /**
   * Reset all state. Primarily for tests.
   */
  reset() {
    for (const [, queue] of this.waiters) {
      for (const waiter of queue) {
        waiter.resolve();
      }
    }
    this.inFlight.clear();
    this.waiters.clear();
  }
}

export const globalConnectionSemaphore = new InProcessSemaphore();
export const globalModelSemaphore = new InProcessSemaphore();
