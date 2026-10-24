// Serial request queue with priorities, de-duplication, cancellation and retries.
// Pacing comes from an optional async `acquire()` gate (the cross-tab limiter in the
// background worker) plus a local minimum interval used as a safety floor.
(function (root) {
  'use strict';
  const V = (root.Vinter = root.Vinter || {});

  class RetryLater extends Error {
    constructor(message) {
      super(message);
      this.name = 'RetryLater';
    }
  }

  class Cancelled extends Error {
    constructor() {
      super('cancelled');
      this.name = 'Cancelled';
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class RequestQueue {
    constructor({ minInterval = 700, maxAttempts = 4, acquire = null, onChange } = {}) {
      this.minInterval = minInterval;
      this.maxAttempts = maxAttempts;
      this.acquire = acquire;
      this.onChange = onChange || (() => {});
      this.jobs = new Map(); // key -> job
      this.running = false;
      this.suspended = false;
      this.lastStart = 0;
    }

    get size() {
      return this.jobs.size;
    }

    // Lower priority value runs first. Re-adding a key only raises its priority.
    // `meta` is free-form data used by retain() predicates.
    add(key, task, priority = 1, meta = null) {
      const existing = this.jobs.get(key);
      if (existing) {
        existing.priority = Math.min(existing.priority, priority);
        return existing.promise;
      }
      const job = { key, task, priority, meta, attempts: 0, seq: RequestQueue.seq++ };
      job.promise = new Promise((resolve, reject) => {
        job.resolve = resolve;
        job.reject = reject;
      });
      this.jobs.set(key, job);
      this.onChange();
      this.pump();
      return job.promise;
    }

    has(key) {
      return this.jobs.has(key);
    }

    setPriority(key, priority) {
      const job = this.jobs.get(key);
      if (job) job.priority = priority;
    }

    // Drop every waiting job for which keep(job) is false. Running jobs finish.
    retain(keep) {
      let dropped = 0;
      for (const job of [...this.jobs.values()]) {
        if (job.active || keep(job)) continue;
        this.jobs.delete(job.key);
        job.reject(new Cancelled());
        dropped++;
      }
      if (dropped) this.onChange();
      return dropped;
    }

    // Stop starting new jobs (e.g. while the tab is hidden). Jobs stay queued.
    suspend() {
      this.suspended = true;
    }

    resume() {
      if (!this.suspended) return;
      this.suspended = false;
      this.pump();
    }

    next() {
      let best = null;
      for (const job of this.jobs.values()) {
        if (!job.active && (!best || job.priority < best.priority || (job.priority === best.priority && job.seq < best.seq))) {
          best = job;
        }
      }
      return best;
    }

    async pump() {
      if (this.running) return;
      this.running = true;
      try {
        while (!this.suspended && this.next()) {
          const wait = this.lastStart + this.minInterval - Date.now();
          if (wait > 0) {
            await sleep(wait);
            continue;
          }
          if (this.acquire) {
            try {
              await this.acquire(this.next());
            } catch {
              await sleep(this.minInterval); // limiter unavailable: fall back to the local floor
            }
          }
          // Priorities, cancellations or visibility may have changed while waiting.
          const job = this.suspended ? null : this.next();
          if (!job) continue;
          this.lastStart = Date.now();
          job.active = true;
          job.attempts++;
          try {
            const value = await job.task();
            this.finish(job);
            job.resolve(value);
          } catch (err) {
            job.active = false;
            if (err instanceof RetryLater && job.attempts < this.maxAttempts && this.jobs.has(job.key)) {
              this.onChange(); // stays queued; the limiter decides when to retry
            } else {
              this.finish(job);
              job.reject(err);
            }
          }
        }
      } finally {
        this.running = false;
      }
    }

    finish(job) {
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      this.onChange();
    }
  }
  RequestQueue.seq = 0;

  V.queue = { RequestQueue, RetryLater, Cancelled };
  if (typeof module === 'object' && module.exports) module.exports = V.queue;
})(globalThis);
