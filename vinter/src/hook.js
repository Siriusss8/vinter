// Runs in the page's own JS world (no extension APIs). Three jobs:
// 1. Forward bodies of Vinted API / flight responses the site already requests, so
//    the content script learns which seller owns each listing without extra requests.
// 2. Tell the content script when React has hydrated the page. Changing the DOM
//    earlier makes React throw a hydration error (#418) and re-render from scratch.
// 3. Fallback: read item -> seller pairs straight from React's props on the cards.
(() => {
  'use strict';
  const FLAG = Symbol.for('vinter.hook');
  if (window[FLAG]) return;
  Object.defineProperty(window, FLAG, { value: true });

  const MAX_BODY = 4 * 1024 * 1024;
  const TYPE_RE = /json|x-component/i;
  const HOST_RE = /(^|\.)vinted\.[a-z.]+$/i;
  const post = (msg) => window.postMessage({ __vinter: 1, ...msg }, location.origin);

  // ------------------------------------------------------- response capture

  const relevantUrl = (url) => {
    try {
      return HOST_RE.test(new URL(url, location.href).hostname);
    } catch {
      return false;
    }
  };

  const forward = (body) => {
    if (typeof body !== 'string' || body.length > MAX_BODY || body.indexOf('"user') < 0) return;
    post({ type: 'body', body });
  };

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      const promise = nativeFetch.apply(this, args);
      promise
        .then((res) => {
          if (!res || !res.ok || !relevantUrl(res.url) || !TYPE_RE.test(res.headers.get('content-type') || '')) return;
          res.clone().text().then(forward, () => {});
        })
        .catch(() => {});
      return promise;
    };
  }

  const proto = XMLHttpRequest.prototype;
  const nativeOpen = proto.open;
  const nativeSend = proto.send;
  const URL_KEY = Symbol('vinter.url');
  proto.open = function (method, url, ...rest) {
    this[URL_KEY] = String(url);
    return nativeOpen.call(this, method, url, ...rest);
  };
  proto.send = function (...args) {
    if (relevantUrl(this[URL_KEY])) {
      this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          if (!TYPE_RE.test(this.getResponseHeader('content-type') || '')) return;
          if (this.responseType === '' || this.responseType === 'text') forward(this.responseText);
          else if (this.responseType === 'json' && this.response) forward(JSON.stringify(this.response));
        } catch { /* never break the page */ }
      });
    }
    return nativeSend.apply(this, args);
  };

  // ------------------------------------------------------------ React fibers

  const fiberOf = (node) => {
    if (!node) return null;
    for (const k of Object.keys(node)) if (k.startsWith('__reactFiber$')) return node[k];
    return null;
  };

  // React attaches a fiber to every DOM node it has hydrated (or rendered).
  function hydrated() {
    if (document.readyState !== 'complete') return false;
    const cards = document.querySelectorAll('[data-testid="grid-item"]');
    const probes = [
      document.querySelector('button[data-testid$="-filter--trigger"]'),
      cards[0],
      cards[cards.length - 1],
    ];
    return probes.every((n) => !n || fiberOf(n));
  }

  let readyPromise = null;
  function whenHydrated() {
    if (!readyPromise) {
      readyPromise = new Promise((resolve) => {
        const started = Date.now();
        const check = () => {
          if (hydrated() || Date.now() - started > 20000) resolve();
          else setTimeout(check, 100);
        };
        check();
      });
    }
    return readyPromise;
  }

  const isId = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

  function sellerFromProps(props, itemId) {
    if (!props || typeof props !== 'object') return null;
    for (const key of Object.keys(props)) {
      const v = props[key];
      if (!v || typeof v !== 'object' || v.id !== itemId) continue;
      if (v.user && isId(v.user.id)) return v.user.id;
      if (isId(v.user_id)) return v.user_id;
    }
    return null;
  }

  function pairsFromFibers(ids) {
    const pairs = [];
    for (const itemId of ids) {
      if (!isId(itemId)) continue;
      const el = document.querySelector(`[data-testid="product-item-id-${itemId}"]`);
      let fiber = fiberOf(el);
      for (let depth = 0; fiber && depth < 12; depth++, fiber = fiber.return) {
        const seller = sellerFromProps(fiber.memoizedProps, itemId);
        if (seller) {
          pairs.push([itemId, seller]);
          break;
        }
      }
    }
    return pairs;
  }

  // ------------------------------------------------- content script commands

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data.__vinterCmd !== 'string') return;
    const cmd = e.data.__vinterCmd;
    if (cmd === 'ready') {
      whenHydrated().then(() => post({ type: 'ready' }));
    } else if (cmd === 'pairs' && Array.isArray(e.data.ids)) {
      const ids = e.data.ids.slice(0, 500).map(Number);
      whenHydrated().then(() => {
        const pairs = pairsFromFibers(ids);
        if (pairs.length) post({ type: 'pairs', pairs });
      });
    }
  });
})();
