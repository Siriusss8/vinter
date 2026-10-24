// Account age estimation.
//
// Vinted does not expose a creation date, but user IDs are allocated in increasing
// order. The table below maps sampled IDs to the earliest date each account provably
// existed (verification date, profile photo upload or last login of abandoned
// accounts), sampled in October 2026. Values are upper bounds on the creation date,
// so estimates err on the "younger" side.
//
// Note the jump: around the end of 2025 new IDs moved from ~3.1e8 to ~3.1e9.
//
// The estimator also learns from every seller it looks up: an account's evidence
// date is an upper bound on the creation date of every account with a lower ID.
(function (root) {
  'use strict';
  const V = (root.Vinter = root.Vinter || {});

  const DAY = 86400000;
  const MAX_LEARNED = 400;

  const SEED = [
    [1, '2008-10-01'],
    [31_000_000, '2019-11-07'],
    [51_000_000, '2021-02-09'],
    [91_000_000, '2021-08-28'],
    [111_000_000, '2022-09-27'],
    [121_000_000, '2022-11-28'],
    [131_000_000, '2023-02-04'],
    [151_000_000, '2023-06-30'],
    [180_000_000, '2024-01-21'],
    [215_000_000, '2024-08-14'],
    [231_000_000, '2024-09-23'],
    [241_000_000, '2024-11-09'],
    [251_000_000, '2025-01-14'],
    [261_000_000, '2025-03-25'],
    [271_000_000, '2025-06-03'],
    [281_000_000, '2025-07-23'],
    [291_000_000, '2025-09-15'],
    [314_000_000, '2025-11-25'],
    [3_160_000_000, '2026-06-02'],
    [3_180_000_000, '2026-08-27'],
    [3_195_000_000, '2026-10-06'],
    [3_200_180_000, '2026-10-17'],
  ].map(([id, d]) => [id, Date.parse(d + 'T00:00:00Z')]);

  function interpolate(table, id) {
    if (id <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
      const [id1, t1] = table[i];
      if (id <= id1) {
        const [id0, t0] = table[i - 1];
        return t0 + ((id - id0) / (id1 - id0)) * (t1 - t0);
      }
    }
    // Past the last anchor: extend the most recent growth rate.
    const [id0, t0] = table[table.length - 2];
    const [id1, t1] = table[table.length - 1];
    return t1 + ((id - id1) / (id1 - id0)) * (t1 - t0);
  }

  // Earliest timestamp in a raw /api/v2/users payload that proves the account existed.
  function evidenceFromUser(user) {
    if (!user) return null;
    const dates = [];
    const v = user.verification || {};
    for (const k of Object.keys(v)) if (v[k] && v[k].verified_at) dates.push(Date.parse(v[k].verified_at));
    if (user.last_loged_on_ts) dates.push(Date.parse(user.last_loged_on_ts));
    const ts = user.photo && user.photo.high_resolution && user.photo.high_resolution.timestamp;
    if (typeof ts === 'number' && ts > 0) dates.push(ts * 1000);
    const valid = dates.filter((d) => Number.isFinite(d) && d > 0);
    return valid.length ? Math.min(...valid) : null;
  }

  class AgeEstimator {
    constructor(learned = []) {
      // [id, upperBoundMs] pairs, sorted by id.
      this.learned = learned.filter((p) => Array.isArray(p) && p.length === 2).sort((a, b) => a[0] - b[0]);
    }

    // Returns true when the point added information worth persisting.
    learn(id, evidenceMs, now = Date.now()) {
      if (!id || !Number.isFinite(evidenceMs) || evidenceMs > now - 2 * DAY) return false;
      if (evidenceMs >= this.createdAt(id, now)) return false; // nothing new
      this.learned.push([id, evidenceMs]);
      this.learned.sort((a, b) => a[0] - b[0]);
      if (this.learned.length > MAX_LEARNED) this.learned.splice(0, this.learned.length - MAX_LEARNED);
      return true;
    }

    // Estimated creation timestamp (an upper bound, never in the future).
    createdAt(id, now = Date.now(), evidenceMs = null) {
      let t = interpolate(SEED, id);
      for (const [lid, lt] of this.learned) if (lid >= id && lt < t) t = lt;
      if (Number.isFinite(evidenceMs) && evidenceMs < t) t = evidenceMs;
      return Math.min(t, now);
    }

    ageDays(id, now = Date.now(), evidenceMs = null) {
      return (now - this.createdAt(id, now, evidenceMs)) / DAY;
    }

    toJSON() {
      return this.learned;
    }
  }

  V.age = { SEED, interpolate, evidenceFromUser, AgeEstimator, DAY };
  if (typeof module === 'object' && module.exports) module.exports = V.age;
})(globalThis);
