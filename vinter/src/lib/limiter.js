// Cross-tab request limiter, run by the background worker. Every Vinted API request
// from any tab needs a slot from here, so opening more tabs does not multiply traffic.
//
// Pacing is AIMD: the interval shrinks slowly while requests succeed and doubles on
// rate limiting, with a pause honoring Retry-After when Vinted sends one.
(function (root) {
  'use strict';
  const V = (root.Vinter = root.Vinter || {});

  const DEFAULTS = Object.freeze({
    // In testing, 600 ms got 429s within a minute and ~950 ms sustained across two
    // tabs got one after ~80 s, so never go faster than 1 req/s. After a 429 the
    // interval doubles, then creeps back down to this floor while requests succeed.
    startInterval: 1000,
    minInterval: 1000,
    maxInterval: 8000,
    stepDown: 100, // ms faster after each streak of successes
    streak: 10,
    // Off-screen and next-page work (priority >= backgroundFrom) runs at
    // interval * backgroundFactor: whole-page processing at 1 req/s got 429s after
    // about a minute, while on-screen cards still deserve the faster rate.
    backgroundFrom: 2,
    backgroundFactor: 2,
    baseBackoff: 10000,
    maxBackoff: 300000,
    challengePause: 120000, // Cloudflare challenge: the user has to browse normally to clear it
    errorPause: 5000,
  });

  class Limiter {
    constructor(options = {}, now = () => Date.now()) {
      this.o = { ...DEFAULTS, ...options };
      this.now = now;
      this.interval = this.o.startInterval;
      this.pausedUntil = 0;
      this.failures = 0;
      this.okStreak = 0;
      this.lastGrant = 0;
      this.waiters = []; // { tabId, priority, active, seq, resolve }
      this.seq = 0;
      this.timer = null;
    }

    // Resolves with { granted: true } when the caller may send one request,
    // or { withdrawn: true } if withdraw() removed it first.
    request(tabId, priority = 1, active = true) {
      return new Promise((resolve) => {
        // One outstanding slot per tab: a newer request replaces the older one.
        this.drop((w) => w.tabId === tabId, { withdrawn: true });
        this.waiters.push({ tabId, priority, active, seq: this.seq++, resolve });
        this.reschedule(); // a more urgent waiter may be allowed to go sooner
      });
    }

    reschedule() {
      clearTimeout(this.timer);
      this.timer = null;
      this.schedule();
    }

    gapFor(w) {
      const o = this.o;
      return w.priority >= o.backgroundFrom ? this.interval * o.backgroundFactor : this.interval;
    }

    withdraw(tabId) {
      this.drop((w) => w.tabId === tabId, { withdrawn: true });
    }

    drop(match, value) {
      const keep = [];
      for (const w of this.waiters) {
        if (match(w)) w.resolve(value);
        else keep.push(w);
      }
      this.waiters = keep;
    }

    // outcome: 'ok' | 'limited' | 'challenge' | 'error'
    report(outcome, retryAfterMs = null) {
      const o = this.o;
      const now = this.now();
      const retry = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, o.maxBackoff) : null;
      if (outcome === 'ok') {
        this.failures = 0;
        if (++this.okStreak >= o.streak) {
          this.okStreak = 0;
          this.interval = Math.max(o.minInterval, this.interval - o.stepDown);
        }
      } else if (outcome === 'limited' || outcome === 'challenge') {
        this.failures++;
        this.okStreak = 0;
        this.interval = Math.min(o.maxInterval, this.interval * 2);
        const backoff = Math.min(o.maxBackoff, o.baseBackoff * 2 ** (this.failures - 1));
        let pause = retry ?? backoff;
        if (outcome === 'challenge') pause = Math.max(pause, o.challengePause);
        this.pausedUntil = Math.max(this.pausedUntil, now + pause);
      } else if (outcome === 'error') {
        this.okStreak = 0;
        this.pausedUntil = Math.max(this.pausedUntil, now + o.errorPause);
      }
      this.schedule();
      return this.status();
    }

    status() {
      return { interval: this.interval, pausedUntil: this.pausedUntil };
    }

    // Lower priority first, then the tab the user is looking at, then oldest.
    static better(w, b) {
      if (w.priority !== b.priority) return w.priority < b.priority;
      if (w.active !== b.active) return w.active;
      return w.seq < b.seq;
    }

    pick() {
      let best = -1;
      for (let i = 0; i < this.waiters.length; i++) {
        if (best < 0 || Limiter.better(this.waiters[i], this.waiters[best])) best = i;
      }
      return best;
    }

    schedule() {
      if (this.timer || !this.waiters.length) return;
      const first = this.waiters[this.pick()];
      const wait = Math.max(0, this.lastGrant + this.gapFor(first) - this.now(), this.pausedUntil - this.now());
      this.timer = setTimeout(() => {
        this.timer = null;
        const i = this.pick();
        if (i < 0) return;
        const w = this.waiters[i];
        // Pause extended, or the best waiter changed to one that must wait longer.
        if (this.now() < this.pausedUntil || this.now() < this.lastGrant + this.gapFor(w)) return this.schedule();
        this.waiters.splice(i, 1);
        this.lastGrant = this.now();
        w.resolve({ granted: true, ...this.status() });
        this.schedule();
      }, wait);
    }

    snapshot() {
      return { interval: this.interval, pausedUntil: this.pausedUntil, failures: this.failures, lastGrant: this.lastGrant };
    }

    restore(s) {
      if (!s || typeof s !== 'object') return;
      const o = this.o;
      if (Number.isFinite(s.interval)) this.interval = Math.min(o.maxInterval, Math.max(o.minInterval, s.interval));
      if (Number.isFinite(s.pausedUntil)) this.pausedUntil = Math.min(s.pausedUntil, this.now() + o.maxBackoff);
      if (Number.isFinite(s.failures)) this.failures = Math.max(0, Math.min(20, s.failures));
      if (Number.isFinite(s.lastGrant)) this.lastGrant = Math.min(s.lastGrant, this.now());
    }
  }

  // Retry-After is either delta-seconds or an HTTP date.
  function parseRetryAfter(value, now = Date.now()) {
    if (!value) return null;
    const s = String(value).trim();
    if (/^\d+$/.test(s)) return Number(s) * 1000;
    const t = Date.parse(s);
    return Number.isFinite(t) ? Math.max(0, t - now) : null;
  }

  V.limiter = { Limiter, DEFAULTS, parseRetryAfter };
  if (typeof module === 'object' && module.exports) module.exports = V.limiter;
})(globalThis);
