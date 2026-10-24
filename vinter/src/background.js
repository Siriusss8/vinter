// Background worker:
// - hands out request slots to all Vinted tabs from one shared limiter (lib/limiter.js);
//   the requests themselves stay in the tabs so they carry the site's cookies.
// - computes perceptual hashes of listing photos. Vinted's image CDN sends no CORS
//   headers, so pages and content scripts cannot read pixels; the extension context
//   can, thanks to the *.vinted.net host permission.
'use strict';

if (typeof importScripts === 'function' && !globalThis.Vinter?.dhash) {
  // Chrome service worker; Firefox loads these via manifest "scripts".
  importScripts('lib/dhash.js', 'lib/limiter.js');
}

const { dhash, limiter: limiterLib } = globalThis.Vinter;
const IMAGE_HOST_RE = /^images\d*\.vinted\.net$/;
const SAMPLE = 8; // pixels averaged per hash cell along each axis
const OUTCOMES = new Set(['ok', 'limited', 'challenge', 'error']);

// ------------------------------------------------------------------ limiter

// The worker can be stopped at any time; keep pacing state in session storage so a
// restart does not forget an active pause. Tabs simply re-request their slot.
const limiter = new limiterLib.Limiter();
const sessionStore = chrome.storage && chrome.storage.session;
const restored = sessionStore
  ? sessionStore.get('limiter').then((d) => limiter.restore(d && d.limiter), () => {})
  : Promise.resolve();

function persistLimiter() {
  if (sessionStore) sessionStore.set({ limiter: limiter.snapshot() }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => limiter.withdraw(tabId));

// ------------------------------------------------------------------- photos

function isImageUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && IMAGE_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

async function hashImage(url) {
  const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const w = dhash.W * SAMPLE;
  const h = dhash.H * SAMPLE;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, w, h);

  // Box-average down to 9x8 to avoid aliasing from a single large downscale.
  const cells = new Float64Array(dhash.W * dhash.H * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = (Math.floor(y / SAMPLE) * dhash.W + Math.floor(x / SAMPLE)) * 4;
      cells[dst] += data[src];
      cells[dst + 1] += data[src + 1];
      cells[dst + 2] += data[src + 2];
    }
  }
  return dhash.fromRGBA(cells);
}

// ----------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  const tab = sender.tab;

  switch (msg.type) {
    case 'vinter:dhash':
      if (!isImageUrl(msg.url)) return false;
      hashImage(msg.url).then(
        (hash) => sendResponse({ hash }),
        (err) => sendResponse({ error: String(err && err.message ? err.message : err) })
      );
      return true;

    case 'vinter:slot': {
      if (!tab || typeof tab.id !== 'number') return false;
      const priority = Number.isFinite(msg.priority) ? msg.priority : 1;
      restored
        .then(() => limiter.request(tab.id, priority, tab.active !== false))
        .then((res) => {
          if (res.granted) persistLimiter();
          sendResponse(res);
        });
      return true;
    }

    case 'vinter:withdraw':
      if (tab && typeof tab.id === 'number') limiter.withdraw(tab.id);
      return false;

    case 'vinter:report': {
      if (!OUTCOMES.has(msg.outcome)) return false;
      restored.then(() => {
        const status = limiter.report(msg.outcome, Number(msg.retryAfter));
        persistLimiter();
        sendResponse(status);
      });
      return true;
    }

    default:
      return false;
  }
});
