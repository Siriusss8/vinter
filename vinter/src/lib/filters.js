// Settings model and the pure filter decision for a seller.
(function (root) {
  'use strict';
  const V = (root.Vinter = root.Vinter || {});

  const DAY = 86400000;

  const DEFAULTS = Object.freeze({
    minReviews: 0,
    minRating: 0,
    minAgeDays: 0,
    maxInactiveDays: 0,
    minRecentRating: 0,
    flagReusedPhotos: false,
    mode: 'hide', // 'hide' | 'dim'
  });

  const OPTIONS = Object.freeze({
    minReviews: [0, 1, 5, 10, 25, 50, 100],
    minRating: [0, 4, 4.5, 4.7, 4.8, 4.9],
    minAgeDays: [0, 30, 90, 180, 365, 730],
    maxInactiveDays: [0, 7, 30, 90, 180],
    minRecentRating: [0, 3.5, 4, 4.5],
    mode: ['hide', 'dim'],
  });

  // Fewer written reviews than this and the recent average is not meaningful.
  const RECENT_WINDOW = 10;
  const RECENT_MIN_SAMPLE = 3;

  function sanitize(raw) {
    const s = { ...DEFAULTS };
    if (!raw || typeof raw !== 'object') return s;
    for (const key of Object.keys(OPTIONS)) {
      if (OPTIONS[key].includes(raw[key])) s[key] = raw[key];
    }
    s.flagReusedPhotos = raw.flagReusedPhotos === true;
    return s;
  }

  const needsSeller = (s) =>
    s.minReviews > 0 || s.minRating > 0 || s.minAgeDays > 0 || s.maxInactiveDays > 0 || s.minRecentRating > 0;

  const isActive = (s) => needsSeller(s) || s.flagReusedPhotos;

  const activeCount = (s) =>
    ['minReviews', 'minRating', 'minAgeDays', 'maxInactiveDays', 'minRecentRating'].filter((k) => s[k] > 0).length +
    (s.flagReusedPhotos ? 1 : 0);

  // Reduce the raw /api/v2/users payload to what the filters need (keeps the cache small).
  function normalizeUser(user, evidenceMs, now = Date.now()) {
    const lastSeen = Date.parse(user.last_loged_on_ts);
    return {
      id: user.id,
      reviews: Number(user.feedback_count) || 0,
      // feedback_reputation is 0..1; Vinted displays it as 0..5 stars.
      rating: typeof user.feedback_reputation === 'number' ? Math.round(user.feedback_reputation * 50) / 10 : null,
      lastSeen: Number.isFinite(lastSeen) ? lastSeen : null,
      evidence: evidenceMs,
      fetchedAt: now,
    };
  }

  // Newest-first /api/v2/user_feedbacks entries -> average of recent written reviews.
  function recentFromFeedbacks(list) {
    const ratings = (Array.isArray(list) ? list : [])
      .filter((f) => f && !f.system_feedback && f.rating >= 1 && f.rating <= 5)
      .slice(0, RECENT_WINDOW)
      .map((f) => f.rating);
    if (ratings.length < RECENT_MIN_SAMPLE) return { avg: null, n: ratings.length };
    const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
    return { avg: Math.round(avg * 10) / 10, n: ratings.length };
  }

  // Returns { reasons: [{ key, vars }], needsRecent } for a normalized seller.
  // ageDays is supplied by the caller (see age.js).
  function evaluate(seller, s, { now = Date.now(), ageDays = null } = {}) {
    const reasons = [];
    if (!seller) return { reasons, needsRecent: false };

    if (s.minReviews > 0 && seller.reviews < s.minReviews) {
      reasons.push({ key: 'rReviews', vars: { n: seller.reviews } });
    }
    if (s.minRating > 0 && seller.reviews > 0 && seller.rating !== null && seller.rating < s.minRating) {
      reasons.push({ key: 'rRating', vars: { rating: seller.rating } });
    }
    if (s.minAgeDays > 0 && ageDays !== null && ageDays < s.minAgeDays) {
      reasons.push({ key: 'rAge', vars: { days: ageDays } });
    }
    if (s.maxInactiveDays > 0 && seller.lastSeen !== null) {
      const idle = (now - seller.lastSeen) / DAY;
      if (idle > s.maxInactiveDays) reasons.push({ key: 'rInactive', vars: { days: idle } });
    }
    let needsRecent = false;
    if (s.minRecentRating > 0 && reasons.length === 0 && seller.reviews > 0) {
      if (seller.reviews <= RECENT_WINDOW) {
        // Few reviews: the recent window would be nearly the whole history, so use
        // the lifetime rating and save a request.
        if (seller.rating !== null && seller.rating < s.minRecentRating) {
          reasons.push({ key: 'rRecent', vars: { rating: seller.rating } });
        }
      } else if (!seller.recent || seller.recent.reviews !== seller.reviews) {
        needsRecent = true; // never fetched, or new reviews since the last fetch
      } else if (seller.recent.avg !== null && seller.recent.avg < s.minRecentRating) {
        reasons.push({ key: 'rRecent', vars: { rating: seller.recent.avg } });
      }
    }
    return { reasons, needsRecent };
  }

  V.filters = {
    DEFAULTS,
    OPTIONS,
    RECENT_WINDOW,
    sanitize,
    needsSeller,
    isActive,
    activeCount,
    normalizeUser,
    recentFromFeedbacks,
    evaluate,
  };
  if (typeof module === 'object' && module.exports) module.exports = V.filters;
})(globalThis);
