// Pulls item -> seller pairs out of the data Vinted already sends to the page:
// - the Next.js flight payload embedded in the initial HTML (self.__next_f.push(...))
// - JSON / flight responses captured by hook.js during client-side navigation
(function (root) {
  'use strict';
  const V = (root.Vinter = root.Vinter || {});

  const MAX_DEPTH = 40;
  const PUSH_RE = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;

  const isId = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

  // Generic walk: any object that looks like a listing (has a title or price) and
  // names its seller (user.id or user_id). Promoted closets group items under a user.
  function collectPairs(value, out = new Map(), depth = 0) {
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return out;
    if (Array.isArray(value)) {
      for (const v of value) collectPairs(v, out, depth + 1);
      return out;
    }
    if (isId(value.id) && ('title' in value || 'price' in value)) {
      const seller = value.user && isId(value.user.id) ? value.user.id : isId(value.user_id) ? value.user_id : null;
      if (seller) out.set(value.id, seller);
    }
    if (Array.isArray(value.items) && value.user && isId(value.user.id)) {
      for (const it of value.items) {
        if (it && isId(it.id) && !out.has(it.id)) out.set(it.id, value.user.id);
      }
    }
    for (const k in value) {
      const v = value[k];
      if (v && typeof v === 'object') collectPairs(v, out, depth + 1);
    }
    return out;
  }

  // Flight format: newline separated rows of `<id>:<payload>`; only JSON rows matter.
  function pairsFromFlightText(text, out = new Map()) {
    for (const line of String(text).split('\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const c = line.charCodeAt(i + 1);
      if (c !== 123 /* { */ && c !== 91 /* [ */) continue;
      try { collectPairs(JSON.parse(line.slice(i + 1)), out); } catch { /* partial or non-JSON row */ }
    }
    return out;
  }

  // Inline <script> texts from the server-rendered page.
  function pairsFromScripts(scriptTexts, out = new Map()) {
    let flight = '';
    for (const text of scriptTexts) {
      if (!text || text.indexOf('__next_f') < 0) continue;
      PUSH_RE.lastIndex = 0;
      let m;
      while ((m = PUSH_RE.exec(text))) {
        try { flight += JSON.parse(m[1]); } catch { /* ignore malformed chunk */ }
      }
    }
    return flight ? pairsFromFlightText(flight, out) : out;
  }

  V.extract = { collectPairs, pairsFromFlightText, pairsFromScripts };
  if (typeof module === 'object' && module.exports) module.exports = V.extract;
})(globalThis);
